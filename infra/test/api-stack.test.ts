import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { ApiStack } from '../lib/api-stack';
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
  const env = { account: config.accountId, region: config.region };

  const dataStack = new cdk.Stack(app, 'DataStack', { env });
  const postsTable = new dynamodb.Table(dataStack, 'PostsTable', {
    partitionKey: { name: 'slug', type: dynamodb.AttributeType.STRING },
  });

  const apiStack = new ApiStack(app, 'ApiStack', { env, config, postsTable });
  return Template.fromStack(apiStack);
}

describe('ApiStack', () => {
  let template: Template;

  beforeAll(() => {
    template = synth(sandboxConfig);
  });

  test('creates the list-posts Lambda on Node 22 with the table name', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Environment: {
        Variables: Match.objectLike({ POSTS_TABLE_NAME: Match.anyValue() }),
      },
    });
  });

  test('creates an HTTP API with CORS for the app and localhost origins', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      Name: 'blog-pipeline-api-sandbox',
      CorsConfiguration: Match.objectLike({
        AllowOrigins: Match.arrayWith([
          'https://pipeline.blog.sandbox.nakomis.com',
          'http://localhost:5173',
        ]),
      }),
    });
  });

  test('creates a Cognito app client on the shared pool', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ClientName: 'blog-pipeline-sandbox',
      GenerateSecret: false,
    });
  });

  test('gates the API behind a JWT authorizer', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'JWT',
    });
  });

  test('the /posts route requires JWT authorization', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'GET /posts',
      AuthorizationType: 'JWT',
    });
  });

  test('publishes the API and Cognito SSM parameters for the web build', () => {
    const params = template.findResources('AWS::SSM::Parameter');
    const names = Object.values(params).map((p) => p.Properties.Name);
    expect(names).toEqual(
      expect.arrayContaining([
        '/blog-pipeline/sandbox/api/url',
        '/blog-pipeline/sandbox/cognito/client-id',
        '/blog-pipeline/sandbox/cognito/user-pool-id',
        '/blog-pipeline/sandbox/cognito/login-domain',
      ]),
    );
  });
});
