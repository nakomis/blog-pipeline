import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { GithubCiStack } from '../lib/github-ci-stack';
import { EnvConfig } from '../lib/config';

const sandboxConfig: EnvConfig = {
  deployEnv: 'sandbox',
  accountId: '975050268859',
  region: 'eu-west-2',
  domainName: 'pipeline.blog.sandbox.nakomis.com',
  ssmPrefix: '/blog-pipeline/sandbox',
};

function synth(config: EnvConfig): Template {
  const app = new cdk.App();
  const stack = new GithubCiStack(app, 'TestCi', {
    env: { account: config.accountId, region: config.region },
    config,
  });
  return Template.fromStack(stack);
}

describe('GithubCiStack', () => {
  test('creates a CI role with the expected name', () => {
    synth(sandboxConfig).hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'nakomis-blog-pipeline-github-ci-sandbox',
    });
  });

  test('CI role is assumable from the blog-pipeline repo via OIDC', () => {
    synth(sandboxConfig).hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Condition: Match.objectLike({
              StringLike: {
                'token.actions.githubusercontent.com:sub':
                  'repo:nakomis/blog-pipeline:*',
              },
            }),
          }),
        ]),
      }),
    });
  });

  test('CI role can assume the CDK bootstrap roles', () => {
    synth(sandboxConfig).hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'sts:AssumeRole' }),
        ]),
      }),
    });
  });

  test('exports the CI role ARN', () => {
    synth(sandboxConfig).hasOutput('GithubCiRoleArn', {});
  });
});
