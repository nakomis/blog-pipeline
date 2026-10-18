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
    // 4 reviewer + 1 state-machine ARN + 1 fal image key (PIPE-6)
    // + fal admin key and credit state (PIPE-34).
    template.resourceCountIs('AWS::SSM::Parameter', 8);
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

  test('switches Grok structured outputs on for the reviewer (PIPE-30)', () => {
    synth(sandboxConfig).hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'blog-pipeline-review-reviewer-sandbox',
      Environment: {
        Variables: Match.objectLike({
          GROK_PARAM_NAME: Match.anyValue(),
          GROK_STRUCTURED_OUTPUTS: 'true',
        }),
      },
    });
  });

  test('wires the fal credit warning into image-submit (PIPE-34)', () => {
    const template = synth(sandboxConfig);
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/blog-pipeline/sandbox/image/fal-credit-state',
      Type: 'String',
      Value: '{}',
    });
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/blog-pipeline/sandbox/image/fal-admin',
      Type: 'String',
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'blog-pipeline-review-image-submit-sandbox',
      Environment: {
        Variables: Match.objectLike({
          FAL_CREDIT_STATE_PARAM_NAME: Match.anyValue(),
          FAL_ADMIN_PARAM_NAME: Match.anyValue(),
          ALERTS_TOPIC_ARN: Match.anyValue(),
          FAL_CREDIT_WARN_THRESHOLD_USD: '5',
          FAL_MONTHLY_BUDGET_USD: '25',
          FAL_COST_PER_IMAGE_USD: '0.06',
        }),
      },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'PublishFalCreditWarning',
            Action: 'sns:Publish',
          }),
        ]),
      }),
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

  test('creates the six review-loop Lambdas', () => {
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

  describe('link and repo suggestions (PIPE-38)', () => {
    function definition(template: Template): {
      States: Record<string, { Next?: string; Catch?: { Next: string }[]; TimeoutSeconds?: number; Choices?: { Next: string }[] }>;
    } {
      const machines = template.findResources('AWS::StepFunctions::StateMachine');
      const raw = Object.values(machines)[0].Properties.DefinitionString;
      const text = raw['Fn::Join']
        ? (raw['Fn::Join'][1] as unknown[]).map((p) => (typeof p === 'string' ? p : 'X')).join('')
        : raw;
      return JSON.parse(text);
    }

    test('creates the suggest-links Lambda wired to the derived private bucket', () => {
      synth(sandboxConfig).hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'blog-pipeline-review-suggest-links-sandbox',
        Timeout: 120,
        MemorySize: 1024,
        Environment: {
          Variables: Match.objectLike({
            PRIVATE_BUCKET: 'nakom.is-private-sandbox',
            EMBED_REGION: 'us-east-1',
            GITHUB_OWNERS: '["nakomis"]',
            POSTS_TABLE_NAME: Match.anyValue(),
            DRAFTS_BUCKET: Match.anyValue(),
          }),
        },
      });
    });

    test('derives the production private bucket without a suffix', () => {
      synth(prodConfig).hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'blog-pipeline-review-suggest-links-prod',
        Environment: {
          Variables: Match.objectLike({ PRIVATE_BUCKET: 'nakom.is-private' }),
        },
      });
    });

    test('grants read on the one embeddings object and Titan invoke in the embed region', () => {
      const template = synth(prodConfig);
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: 'ReadEmbeddingsIndex',
              Action: 's3:GetObject',
              Resource: 'arn:aws:s3:::nakom.is-private/blog-embeddings.json',
            }),
            Match.objectLike({
              Sid: 'EmbedWithTitan',
              Action: 'bedrock:InvokeModel',
              Resource:
                'arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0',
            }),
          ]),
        }),
      });
    });

    test('runs SuggestLinks between a gate pass and SetOutcomePass', () => {
      const states = definition(synth(sandboxConfig)).States;
      const pass = states.DecideLoop.Choices?.find((c) => c.Next === 'SuggestLinks');
      expect(pass).toBeDefined();
      expect(states.SuggestLinks.Next).toBe('SetOutcomePass');
      expect(states.SetOutcomePass.Next).toBe('ReviewComplete');
    });

    test('a failure or timeout still stages the post and never reaches HandleException', () => {
      const states = definition(synth(sandboxConfig)).States;
      expect(states.SuggestLinks.Catch).toEqual([
        expect.objectContaining({ Next: 'SetOutcomePass' }),
      ]);
      expect(states.SuggestLinks.TimeoutSeconds).toBe(150);
      expect(JSON.stringify(states.SuggestLinks.Catch)).not.toContain('HandleException');
    });
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
