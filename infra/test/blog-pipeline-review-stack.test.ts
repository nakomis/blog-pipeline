import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { BlogPipelineStack } from '../lib/blog-pipeline-stack';
import { BlogPipelineReviewStack } from '../lib/blog-pipeline-review-stack';
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
  const stack = new BlogPipelineReviewStack(
    app,
    `BlogPipeline-Review-${config.deployEnv}`,
    {
      env,
      config,
      postsTable: data.postsTable,
      imageJobsTable: data.imageJobsTable,
    },
  );
  return Template.fromStack(stack);
}

describe('BlogPipelineReviewStack', () => {
  test('creates the review state machine with a project-prefixed name', () => {
    const template = synth(sandboxConfig);
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      StateMachineName: 'blog-pipeline-review-sandbox',
    });
  });

  test('creates a private, SSL-only drafts bucket', () => {
    synth(sandboxConfig).hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'blog-pipeline-drafts-sandbox',
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('creates the four external reviewer SSM parameters', () => {
    const template = synth(sandboxConfig);
    // 4 reviewer + 1 state-machine ARN + 1 fal image key (PIPE-6).
    template.resourceCountIs('AWS::SSM::Parameter', 6);
    for (const provider of ['azure', 'gemini', 'anthropic', 'grok']) {
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: `/blog-pipeline/sandbox/reviewer/${provider}`,
        Type: 'String',
      });
    }
  });

  test('creates the fal image-key SSM parameter as a plain String (PIPE-6)', () => {
    synth(sandboxConfig).hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/blog-pipeline/sandbox/image/fal',
      Type: 'String',
    });
  });

  test('creates the image-submit Lambda with the callback URL wired (PIPE-6)', () => {
    synth(sandboxConfig).hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'blog-pipeline-review-image-submit-sandbox',
      Environment: {
        Variables: Match.objectLike({
          IMAGE_CALLBACK_URL:
            'https://api.pipeline.blog.sandbox.nakomis.com/image-callback',
          FAL_PARAM_NAME: Match.anyValue(),
          IMAGE_JOBS_TABLE_NAME: Match.anyValue(),
        }),
      },
    });
  });

  test('load-draft can invoke image-submit (PIPE-6)', () => {
    synth(sandboxConfig).hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'lambda:InvokeFunction' }),
        ]),
      }),
    });
  });

  test('uses the original logical id for the state machine', () => {
    // The construct was renamed `ReviewStateMachine` → `ReviewLoop`; the
    // logical id is pinned so the rename does not force a CFN replacement.
    const template = synth(sandboxConfig);
    expect(
      Object.keys(template.findResources('AWS::StepFunctions::StateMachine')),
    ).toContain('ReviewStateMachineAD9C5398');
  });

  test('creates the six review Lambdas', () => {
    const template = synth(sandboxConfig);
    for (const name of [
      'load-draft',
      'reviewer',
      'gate',
      'persist-iteration',
      'redraft',
      'set-outcome',
    ]) {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: `blog-pipeline-review-${name}-sandbox`,
      });
    }
  });

  test('publishes the state-machine ARN to SSM for PIPE-2', () => {
    synth(sandboxConfig).hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/blog-pipeline/sandbox/review/state-machine-arn',
    });
  });

  test('grants Bedrock model invocation', () => {
    synth(sandboxConfig).hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['bedrock:InvokeModel']),
          }),
        ]),
      }),
    });
  });

  test('sandbox drafts bucket is destroyed with the stack', () => {
    synth(sandboxConfig).hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Delete',
    });
  });

  test('prod drafts bucket is retained', () => {
    synth(prodConfig).hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
    });
  });
});
