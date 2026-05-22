import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { GithubCiStack } from '../lib/github-ci-stack';
import { EnvConfig } from '../lib/config';

const sandboxConfig: EnvConfig = {
  deployEnv: 'sandbox',
  accountId: '975050268859',
  region: 'eu-west-2',
  domainName: 'pipeline.blog.sandbox.nakomis.com',
  hostedZoneName: 'sandbox.nakomis.com',
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

function synthWithWeb(config: EnvConfig): Template {
  const app = new cdk.App();
  const env = { account: config.accountId, region: config.region };
  const resources = new cdk.Stack(app, 'Resources', { env });
  const stack = new GithubCiStack(app, 'TestCi', {
    env,
    config,
    webBucket: s3.Bucket.fromBucketName(
      resources,
      'Bucket',
      'blog-pipeline-web-975050268859-sandbox',
    ),
    webDistribution: cloudfront.Distribution.fromDistributionAttributes(
      resources,
      'Distribution',
      { distributionId: 'E123EXAMPLE', domainName: 'd123.cloudfront.net' },
    ),
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

  test('grants no web-deploy permissions when no bucket is passed', () => {
    const policy = synth(sandboxConfig).toJSON();
    const json = JSON.stringify(policy);
    expect(json).not.toContain('cloudfront:CreateInvalidation');
  });

  test('grants S3, CloudFront and SSM permissions when web resources are passed', () => {
    const template = synthWithWeb(sandboxConfig);
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['s3:PutObject', 's3:DeleteObject']),
          }),
          Match.objectLike({ Action: 'cloudfront:CreateInvalidation' }),
          Match.objectLike({ Action: 'ssm:GetParameter' }),
        ]),
      }),
    });
  });
});
