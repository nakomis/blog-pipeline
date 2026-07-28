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
    {
      env,
      config,
      postsTable: data.postsTable,
      imageJobsTable: data.imageJobsTable,
    },
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

  test('publishes six SSM discovery parameters', () => {
    const template = synth(sandboxConfig);
    template.resourceCountIs('AWS::SSM::Parameter', 6);
    for (const name of [
      '/blog-pipeline/sandbox/trigger/role-arn',
      '/blog-pipeline/sandbox/trigger/drafts-bucket',
      '/blog-pipeline/sandbox/trigger/posts-table',
      '/blog-pipeline/sandbox/trigger/state-machine-arn',
      '/blog-pipeline/sandbox/promote/role-arn',
      '/blog-pipeline/sandbox/alerts/topic-arn',
    ]) {
      template.hasResourceProperties('AWS::SSM::Parameter', { Name: name });
    }
  });

  test('creates the alerts topic with an email subscription only in prod', () => {
    const sandbox = synth(sandboxConfig);
    sandbox.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'blog-pipeline-alerts-sandbox',
    });
    sandbox.resourceCountIs('AWS::SNS::Subscription', 0);

    const prod = synth(prodConfig);
    prod.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'martin@nakomis.com',
    });
  });

  test('creates the promote role pinned to blog-content main', () => {
    synth(sandboxConfig).hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'blog-pipeline-promote-sandbox',
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

  test('promote role reads the drafts bucket and marks posts, but cannot start an execution', () => {
    const template = synth(sandboxConfig);
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'ReadDraftsAndImages',
            Action: 's3:GetObject',
            Resource: 'arn:aws:s3:::blog-pipeline-drafts-sandbox/*',
          }),
          Match.objectLike({
            Sid: 'FindAndMarkApproved',
            Action: [
              'dynamodb:Query',
              'dynamodb:GetItem',
              'dynamodb:UpdateItem',
            ],
          }),
        ]),
      }),
    });
    // Promotion pulls finished work out; it must never re-enter the loop.
    const policies = template.findResources('AWS::IAM::Policy');
    const promotePolicy = Object.values(policies).find((p) =>
      JSON.stringify(p).includes('FindAndMarkApproved'),
    );
    expect(JSON.stringify(promotePolicy)).not.toContain('states:StartExecution');
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
