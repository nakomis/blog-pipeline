import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { BlogPipelineStack } from '../lib/blog-pipeline-stack';
import { BlogPipelineReviewStack } from '../lib/blog-pipeline-review-stack';
import { BlogPipelineTriggerStack } from '../lib/blog-pipeline-trigger-stack';
import { EnvConfig } from '../lib/config';

const sandboxConfig: EnvConfig = {
  deployEnv: 'sandbox',
  accountId: '975050268859',
  region: 'eu-west-2',
  domainName: 'pipeline.blog.sandbox.nakomis.com',
  apiDomainName: 'api.pipeline.blog.sandbox.nakomis.com',
  hostedZoneName: 'sandbox.nakomis.com',
  ssmPrefix: '/blog-pipeline/sandbox',
};

const prodConfig: EnvConfig = {
  ...sandboxConfig,
  deployEnv: 'prod',
  accountId: '637423226886',
  ssmPrefix: '/blog-pipeline/prod',
};

function synth(config: EnvConfig): Template {
  const app = new cdk.App();
  const env = { account: config.accountId, region: config.region };
  const data = new BlogPipelineStack(app, 'Data', { env, config });
  const review = new BlogPipelineReviewStack(
    app,
    `BlogPipeline-Review-${config.deployEnv}`,
    { env, config, postsTable: data.postsTable },
  );
  const stack = new BlogPipelineTriggerStack(
    app,
    `BlogPipeline-Trigger-${config.deployEnv}`,
    {
      env,
      config,
      postsTable: data.postsTable,
      stateMachine: review.stateMachine,
    },
  );
  return Template.fromStack(stack);
}

describe('BlogPipelineTriggerStack', () => {
  test('creates the trigger role with the env-prefixed name', () => {
    synth(sandboxConfig).hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'blog-pipeline-trigger-sandbox',
    });
  });

  test('trust policy pins to blog-content main, audience sts.amazonaws.com', () => {
    synth(sandboxConfig).hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                'token.actions.githubusercontent.com:sub':
                  'repo:nakomis/blog-content:ref:refs/heads/main',
              },
            },
          }),
        ]),
      },
    });
  });

  test('grants PutObject on the drafts bucket prefix only', () => {
    synth(sandboxConfig).hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'PutDraftMarkdown',
            Action: 's3:PutObject',
            Resource: 'arn:aws:s3:::blog-pipeline-drafts-sandbox/*',
          }),
        ]),
      }),
    });
  });

  test('grants PutItem on the posts table and nothing wider', () => {
    synth(sandboxConfig).hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'QueuePostItem',
            Action: 'dynamodb:PutItem',
          }),
        ]),
      }),
    });
  });

  test('grants StartExecution on the review state machine', () => {
    synth(sandboxConfig).hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'StartReviewExecution',
            Action: 'states:StartExecution',
          }),
        ]),
      }),
    });
  });

  test('publishes four SSM discovery parameters', () => {
    const template = synth(sandboxConfig);
    template.resourceCountIs('AWS::SSM::Parameter', 4);
    for (const name of [
      '/blog-pipeline/sandbox/trigger/role-arn',
      '/blog-pipeline/sandbox/trigger/drafts-bucket',
      '/blog-pipeline/sandbox/trigger/posts-table',
      '/blog-pipeline/sandbox/trigger/state-machine-arn',
    ]) {
      template.hasResourceProperties('AWS::SSM::Parameter', { Name: name });
    }
  });

  test('prod synth produces the same shape with prod-prefixed names', () => {
    const template = synth(prodConfig);
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'blog-pipeline-trigger-prod',
    });
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/blog-pipeline/prod/trigger/role-arn',
    });
  });
});
