import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { BlogPipelineStack } from '../lib/blog-pipeline-stack';
import { EnvConfig } from '../lib/config';

const sandboxConfig: EnvConfig = {
  deployEnv: 'sandbox',
  accountId: '975050268859',
  region: 'eu-west-2',
  domainName: 'pipeline.blog.sandbox.nakomis.com',
  ssmPrefix: '/blog-pipeline/sandbox',
};

const prodConfig: EnvConfig = {
  deployEnv: 'prod',
  accountId: '637423226886',
  region: 'eu-west-2',
  domainName: 'pipeline.blog.nakomis.com',
  ssmPrefix: '/blog-pipeline/prod',
};

function synth(config: EnvConfig): Template {
  const app = new cdk.App();
  const stack = new BlogPipelineStack(app, 'TestStack', {
    env: { account: config.accountId, region: config.region },
    config,
  });
  return Template.fromStack(stack);
}

describe('BlogPipelineStack', () => {
  test('creates a pay-per-request posts table', () => {
    synth(sandboxConfig).hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'blog-pipeline-posts-sandbox',
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  test('posts table has a by-status GSI', () => {
    synth(sandboxConfig).hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: 'by-status' }),
      ]),
    });
  });

  test('exports the posts table name', () => {
    synth(sandboxConfig).hasOutput('PostsTableName', {});
  });

  test('sandbox table is destroyed on stack deletion', () => {
    synth(sandboxConfig).hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Delete',
    });
  });

  test('prod table is retained and has point-in-time recovery', () => {
    const template = synth(prodConfig);
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
    });
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'blog-pipeline-posts-prod',
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
  });
});
