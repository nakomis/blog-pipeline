import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { EnvConfig, DEPLOYMENT_TRACKER_ACCOUNT_ID } from './config';

export interface GithubCiStackProps extends cdk.StackProps {
  config: EnvConfig;
  /** SPA bucket — grants the CI role permission to upload built assets. */
  webBucket?: s3.IBucket;
  /** CloudFront distribution — grants the CI role permission to invalidate it. */
  webDistribution?: cloudfront.IDistribution;
}

/** The GitHub repository GitHub Actions runs from. */
const GITHUB_REPO = 'nakomis/blog-pipeline';

/**
 * IAM role assumed by GitHub Actions (via OIDC) to deploy the CDK app.
 *
 * The OIDC provider for `token.actions.githubusercontent.com` already exists
 * in both the sandbox and production accounts, so it is imported rather than
 * created here.
 */
export class GithubCiStack extends cdk.Stack {
  public readonly ciRole: iam.IRole;

  constructor(scope: Construct, id: string, props: GithubCiStackProps) {
    super(scope, id, props);
    const { config, webBucket, webDistribution } = props;

    const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GithubOidcProvider',
      `arn:aws:iam::${config.accountId}:oidc-provider/token.actions.githubusercontent.com`,
    );

    const ciRole = new iam.Role(this, 'GithubCiRole', {
      roleName: `nakomis-blog-pipeline-github-ci-${config.deployEnv}`,
      description: `GitHub Actions deploy role for blog-pipeline (${config.deployEnv})`,
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.OpenIdConnectPrincipal(provider, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        StringLike: {
          'token.actions.githubusercontent.com:sub': `repo:${GITHUB_REPO}:*`,
        },
      }),
    });

    // `cdk deploy` works by assuming the CDK bootstrap roles; the CI role only
    // needs permission to do that.
    ciRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [`arn:aws:iam::${config.accountId}:role/cdk-hnb659fds-*`],
      }),
    );

    // Recording deployments to the shared deployment tracker (CLOUD-15) — a
    // REST API in the prod account, called cross-account over SigV4. The
    // tracker's resource policy must also allow this role; see CLOUD-15.
    ciRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['execute-api:Invoke'],
        resources: [
          `arn:aws:execute-api:${config.region}:${DEPLOYMENT_TRACKER_ACCOUNT_ID}:*/*/*/deployments/*`,
        ],
      }),
    );

    // Deploying the SPA: sync built assets to the bucket, invalidate the
    // CloudFront cache, and read the SSM parameters that drive the web build.
    if (webBucket && webDistribution) {
      ciRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['s3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
          resources: [webBucket.bucketArn, `${webBucket.bucketArn}/*`],
        }),
      );
      ciRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['cloudfront:CreateInvalidation'],
          resources: [
            `arn:aws:cloudfront::${config.accountId}:distribution/${webDistribution.distributionId}`,
          ],
        }),
      );
      ciRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['ssm:GetParameter'],
          resources: [
            `arn:aws:ssm:${config.region}:${config.accountId}:parameter${config.ssmPrefix}/*`,
          ],
        }),
      );
    }

    this.ciRole = ciRole;

    new cdk.CfnOutput(this, 'GithubCiRoleArn', {
      value: ciRole.roleArn,
      description: 'IAM role ARN assumed by GitHub Actions for deployment',
    });
  }
}
