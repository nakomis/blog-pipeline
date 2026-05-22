import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { EnvConfig } from './config';

export interface GithubCiStackProps extends cdk.StackProps {
  config: EnvConfig;
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
    const { config } = props;

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

    this.ciRole = ciRole;

    new cdk.CfnOutput(this, 'GithubCiRoleArn', {
      value: ciRole.roleArn,
      description: 'IAM role ARN assumed by GitHub Actions for deployment',
    });
  }
}
