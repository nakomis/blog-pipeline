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

  /**
   * The role the `promote-approved` workflow assumes (PIPE-5) to pull approved
   * posts back out of the pipeline. Read-only on the drafts bucket plus a
   * narrow read/mark on the posts table — it never starts an execution.
   */
  public readonly promoteRole: iam.IRole;

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

    // ── Promote role (PIPE-5) ────────────────────────────────────────────
    // The `promote-approved` workflow in blog-content assumes this role on a
    // schedule to publish approved posts back to the content repo. It:
    //
    //   1. `dynamodb:Query`s the posts table's `by-status` GSI for `approved`
    //      posts (and re-reads each item for its final iteration number);
    //   2. `s3:GetObject`s the refined draft + generated images from the
    //      drafts bucket;
    //   3. `dynamodb:UpdateItem`s each promoted post to `published`.
    //
    // It is deliberately read-only on the bucket and cannot start an execution
    // — promotion pulls finished work out, it never re-enters the review loop.
    const promoteRole = new iam.Role(this, 'PromoteRole', {
      roleName: `blog-pipeline-promote-${deployEnv}`,
      description:
        `OIDC role assumed by ${BLOG_CONTENT_REPO} GitHub Actions to ` +
        `publish approved posts back to the content repo (${deployEnv})`,
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.OpenIdConnectPrincipal(provider, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub':
            `repo:${BLOG_CONTENT_REPO}:ref:refs/heads/main`,
        },
      }),
    });

    promoteRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadDraftsAndImages',
        actions: ['s3:GetObject'],
        resources: [`${draftsBucketArn}/*`],
      }),
    );
    promoteRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ListDrafts',
        actions: ['s3:ListBucket'],
        resources: [draftsBucketArn],
      }),
    );
    promoteRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'FindAndMarkApproved',
        actions: ['dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:UpdateItem'],
        resources: [postsTable.tableArn, `${postsTable.tableArn}/index/*`],
      }),
    );

    this.promoteRole = promoteRole;

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
    new ssm.StringParameter(this, 'PromoteRoleArnParam', {
      parameterName: `${ssmPrefix}/promote/role-arn`,
      stringValue: promoteRole.roleArn,
      description: `Promote role ARN for the blog-content publish workflow (${deployEnv})`,
    });

    new cdk.CfnOutput(this, 'TriggerRoleArn', {
      value: triggerRole.roleArn,
      description:
        'IAM role ARN assumed via OIDC by the blog-content trigger workflow',
    });

    new cdk.CfnOutput(this, 'PromoteRoleArn', {
      value: promoteRole.roleArn,
      description:
        'IAM role ARN assumed via OIDC by the blog-content promote-approved workflow',
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
