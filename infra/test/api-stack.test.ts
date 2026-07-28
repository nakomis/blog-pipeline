import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { ApiStack } from '../lib/api-stack';
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

function synth(config: EnvConfig): Template {
  const app = new cdk.App();
  const env = { account: config.accountId, region: config.region };

  const dataStack = new cdk.Stack(app, 'DataStack', { env });
  const postsTable = new dynamodb.Table(dataStack, 'PostsTable', {
    partitionKey: { name: 'slug', type: dynamodb.AttributeType.STRING },
  });
  const imageJobsTable = new dynamodb.Table(dataStack, 'ImageJobsTable', {
    partitionKey: { name: 'requestId', type: dynamodb.AttributeType.STRING },
  });
  const draftsBucket = new s3.Bucket(dataStack, 'DraftsBucket');
  const reviewStateMachine = new sfn.StateMachine(dataStack, 'ReviewLoop', {
    definitionBody: sfn.DefinitionBody.fromChainable(
      new sfn.Pass(dataStack, 'Noop'),
    ),
  });
  // The real certificate is a cross-region resource from WebCertStack; an
  // imported ARN is enough to synthesise ApiStack.
  const certificate = acm.Certificate.fromCertificateArn(
    dataStack,
    'Cert',
    `arn:aws:acm:us-east-1:${config.accountId}:certificate/00000000-0000-0000-0000-000000000000`,
  );

  const apiStack = new ApiStack(app, 'ApiStack', {
    env,
    config,
    postsTable,
    draftsBucket,
    imageJobsTable,
    reviewStateMachine,
    certificate,
  });
  return Template.fromStack(apiStack);
}

describe('ApiStack', () => {
  let template: Template;

  beforeAll(() => {
    template = synth(sandboxConfig);
  });

  test('creates the API router Lambda on Node 22 with an explicit name', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'blog-pipeline-api-sandbox',
      Runtime: 'nodejs22.x',
      Environment: {
        Variables: Match.objectLike({
          POSTS_TABLE_NAME: Match.anyValue(),
          DRAFTS_BUCKET: Match.anyValue(),
          IMAGE_JOBS_TABLE_NAME: Match.anyValue(),
        }),
      },
    });
  });

  test('creates a REST API', () => {
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      Name: 'blog-pipeline-api-sandbox',
    });
  });

  test('the /posts GET method requires both an API key and Cognito auth', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'GET',
      ApiKeyRequired: true,
      AuthorizationType: 'COGNITO_USER_POOLS',
    });
  });

  test('the bag routes (detail, edit, decision) are secured (PIPE-4)', () => {
    // /posts/{slug} GET plus the two POSTs all carry API key + Cognito.
    const secured = template.findResources('AWS::ApiGateway::Method', {
      Properties: {
        ApiKeyRequired: true,
        AuthorizationType: 'COGNITO_USER_POOLS',
      },
    });
    // GET /posts, GET /posts/{slug}, POST .../edit, POST .../decision.
    expect(Object.keys(secured).length).toBeGreaterThanOrEqual(4);
  });

  test('grants the Lambda permission to start the review state machine', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'states:StartExecution' }),
        ]),
      }),
    });
  });

  test('passes the review state machine ARN to the Lambda', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          REVIEW_STATE_MACHINE_ARN: Match.anyValue(),
        }),
      },
    });
  });

  test('the /image-callback POST route is public and key-less (PIPE-6)', () => {
    // fal can present neither a Cognito token nor the CloudFront API key, and
    // an authorizer can't see the body to verify the signature — so the route
    // is open and the Lambda verifies fal's ED25519 signature itself.
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      ApiKeyRequired: false,
      AuthorizationType: 'NONE',
    });
  });

  test('CloudFront allows all methods so the POST callback reaches the origin', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          AllowedMethods: Match.arrayWith(['POST']),
        }),
      }),
    });
  });

  test('gates the API behind a Cognito authorizer', () => {
    template.hasResourceProperties('AWS::ApiGateway::Authorizer', {
      Type: 'COGNITO_USER_POOLS',
    });
  });

  test('meters the API with a usage plan and an API key', () => {
    template.hasResourceProperties('AWS::ApiGateway::UsagePlan', {
      Throttle: Match.objectLike({ RateLimit: 20, BurstLimit: 40 }),
      Quota: Match.objectLike({ Limit: 10000, Period: 'DAY' }),
    });
    template.resourceCountIs('AWS::ApiGateway::ApiKey', 1);
  });

  test('generates the API key value without a Secrets Manager secret', () => {
    // The key value comes from a GetRandomPassword custom resource, not a
    // stored secret. The only AWS::SecretsManager::Secret in the stack is the
    // GitHub dispatch PAT (PIPE-14) — the API key itself is never persisted.
    template.resourceCountIs('Custom::AWS', 1);
    const secrets = template.findResources('AWS::SecretsManager::Secret');
    const secretNames = Object.values(secrets).map(
      (s) => s.Properties?.Name as string,
    );
    expect(secretNames).toEqual([
      expect.stringContaining('blog-pipeline-github-dispatch-'),
    ]);
  });

  test('creates the GitHub dispatch secret and passes its ARN to the Lambda (PIPE-14)', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: Match.stringLikeRegexp('blog-pipeline-github-dispatch-.*'),
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: Match.stringLikeRegexp('blog-pipeline-api-.*'),
      Environment: {
        Variables: Match.objectLike({
          GITHUB_DISPATCH_SECRET_ARN: Match.anyValue(),
        }),
      },
    });
  });

  test('fronts the API with CloudFront on the API domain, injecting x-api-key', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['api.pipeline.blog.sandbox.nakomis.com'],
        Origins: Match.arrayWith([
          Match.objectLike({
            OriginCustomHeaders: Match.arrayWith([
              Match.objectLike({ HeaderName: 'x-api-key' }),
            ]),
          }),
        ]),
      }),
    });
  });

  test('rejects plaintext HTTP outright rather than redirecting it', () => {
    // An API must not redirect HTTP→HTTPS: the bearer token would already
    // have travelled in cleartext. CloudFront returns a 403 for HTTP instead.
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'https-only',
        }),
      }),
    });
  });

  test('creates A and AAAA records for the API domain', () => {
    template.resourceCountIs('AWS::Route53::RecordSet', 2);
  });

  test('creates a Cognito app client on the shared pool', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ClientName: 'blog-pipeline-sandbox',
      GenerateSecret: false,
    });
  });

  test('applies dark managed-login branding tied to the app client', () => {
    template.hasResourceProperties('AWS::Cognito::ManagedLoginBranding', {
      UseCognitoProvidedValues: false,
      ClientId: { Ref: Match.anyValue() },
      Settings: Match.objectLike({
        categories: { global: Match.objectLike({ colorSchemeMode: 'DARK' }) },
      }),
    });
  });

  test('publishes the Cognito SSM parameters but not the API URL', () => {
    const params = template.findResources('AWS::SSM::Parameter');
    const names = Object.values(params).map((p) => p.Properties.Name);
    expect(names).toEqual(
      expect.arrayContaining([
        '/blog-pipeline/sandbox/cognito/client-id',
        '/blog-pipeline/sandbox/cognito/user-pool-id',
        '/blog-pipeline/sandbox/cognito/login-domain',
      ]),
    );
    expect(names).not.toContain('/blog-pipeline/sandbox/api/url');
  });
});
