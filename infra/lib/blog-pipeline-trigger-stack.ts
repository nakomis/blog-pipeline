import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { BLOG_CONTENT_REPO, EnvConfig } from './config';

export interface BlogPipelineTriggerStackProps extends cdk.StackProps {
  config: EnvConfig;
  /** Posts table — written by the trigger, owned by `BlogPipelineStack`. */
  postsTable: dynamodb.ITable;
  /** Review state machine — started by the trigger, owned by the review stack. */
  stateMachine: sfn.IStateMachine;
}

/**
 * The trigger role (PIPE-2).
 *
 * A GitHub Actions workflow in `nakomis/blog-content` assumes this role via
 * OIDC and pushes a changed `blog/*.md` post into the review pipeline by
 * doing three AWS API calls directly:
 *
 *   1. `s3:PutObject` to `{drafts-bucket}/{slug}/iteration-1/draft.md`
 *   2. `dynamodb:PutItem` on the posts table with `status: queued`
 *   3. `states:StartExecution` on the review state machine
 *
 * Nothing else lives in this stack: no public endpoint, no webhook Lambda,
 * no shared secret. The trigger's only auth is the OIDC trust on the role,
 * scoped tightly to one repo and one ref.
 */
export class BlogPipelineTriggerStack extends cdk.Stack {
  /** The IAM role the workflow assumes. */
  public readonly triggerRole: iam.IRole;

  constructor(
    scope: Construct,
    id: string,
    props: BlogPipelineTriggerStackProps,
  ) {
    super(scope, id, props);
    const { config, postsTable, stateMachine } = props;
    const { deployEnv, ssmPrefix, accountId, region } = config;

    // The OIDC provider for GitHub already exists in both accounts (it is
    // imported by `GithubCiStack` for the CI deploy role) — import the same
    // one rather than create a duplicate, which CloudFormation would reject.
    const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GithubOidcProvider',
      `arn:aws:iam::${accountId}:oidc-provider/token.actions.githubusercontent.com`,
    );

    // The drafts bucket is created by `BlogPipelineReviewStack`. Its physical
    // name is fixed by config so the ARN can be derived here without taking
    // a cross-stack dependency on the bucket construct itself — that would
    // pull the trigger stack into the review stack's deploy ordering, which
    // is unwanted (the trigger writes objects, it doesn't manage the bucket).
    const draftsBucketName = `blog-pipeline-drafts-${deployEnv}`;
    const draftsBucketArn = `arn:aws:s3:::${draftsBucketName}`;

    const triggerRole = new iam.Role(this, 'TriggerRole', {
      roleName: `blog-pipeline-trigger-${deployEnv}`,
      description:
        `OIDC role assumed by ${BLOG_CONTENT_REPO} GitHub Actions to ` +
        `start the review pipeline (${deployEnv})`,
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.OpenIdConnectPrincipal(provider, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          // Pin to the main branch only — feature-branch pushes cannot
          // assume the role even if the workflow somehow runs against them.
          'token.actions.githubusercontent.com:sub':
            `repo:${BLOG_CONTENT_REPO}:ref:refs/heads/main`,
        },
      }),
    });

    triggerRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PutDraftMarkdown',
        actions: ['s3:PutObject'],
        resources: [`${draftsBucketArn}/*`],
      }),
    );

    triggerRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'QueuePostItem',
        actions: ['dynamodb:PutItem'],
        resources: [postsTable.tableArn],
      }),
    );

    triggerRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'StartReviewExecution',
        actions: ['states:StartExecution'],
        resources: [stateMachine.stateMachineArn],
      }),
    );

    this.triggerRole = triggerRole;

    // ── Discovery ────────────────────────────────────────────────────────
    // The workflow file in blog-content hardcodes these values for clarity
    // (they are stable and not sensitive), but mirroring them to SSM keeps
    // a single source of truth in-account for anyone looking the trigger up.
    new ssm.StringParameter(this, 'TriggerRoleArnParam', {
      parameterName: `${ssmPrefix}/trigger/role-arn`,
      stringValue: triggerRole.roleArn,
      description: `Trigger role ARN for blog-content workflow (${deployEnv})`,
    });
    new ssm.StringParameter(this, 'TriggerDraftsBucketParam', {
      parameterName: `${ssmPrefix}/trigger/drafts-bucket`,
      stringValue: draftsBucketName,
      description: `Drafts bucket name written by the trigger (${deployEnv})`,
    });
    new ssm.StringParameter(this, 'TriggerPostsTableParam', {
      parameterName: `${ssmPrefix}/trigger/posts-table`,
      stringValue: postsTable.tableName,
      description: `Posts table name written by the trigger (${deployEnv})`,
    });
    new ssm.StringParameter(this, 'TriggerStateMachineArnParam', {
      parameterName: `${ssmPrefix}/trigger/state-machine-arn`,
      stringValue: stateMachine.stateMachineArn,
      description: `Review state machine ARN started by the trigger (${deployEnv})`,
    });

    new cdk.CfnOutput(this, 'TriggerRoleArn', {
      value: triggerRole.roleArn,
      description:
        'IAM role ARN assumed via OIDC by the blog-content trigger workflow',
    });

    // Surface the resolved ARN region for callers that prefer constructing
    // the ARN from parts (the workflow does this) — keeps the deploy
    // self-describing without forcing a CLI lookup.
    new cdk.CfnOutput(this, 'TriggerRegion', {
      value: region,
      description: 'AWS region the trigger writes to',
    });
  }
}
