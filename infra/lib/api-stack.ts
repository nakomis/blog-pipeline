import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { EnvConfig } from './config';

export interface ApiStackProps extends cdk.StackProps {
  config: EnvConfig;
  /** The posts table — owned by `BlogPipelineStack`, read by the API Lambda. */
  postsTable: dynamodb.ITable;
}

/**
 * The dashboard read path: an HTTP API serving `GET /posts` from a Lambda that
 * reads the posts table, gated behind a Cognito JWT authorizer.
 *
 * Authentication uses the shared `NakomisUserPool` — its ID and hosted-login
 * domain are published per account at `/nakomis-infra/{env}/cognito/*`. This
 * stack imports the pool and creates its own app client against it, exactly as
 * the `nakostat` project does.
 */
export class ApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { config, postsTable } = props;
    const { deployEnv, region, domainName, ssmPrefix } = config;

    // Local dev runs the SPA on Vite's default port.
    const localOrigin = 'http://localhost:5173';
    const appOrigin = `https://${domainName}`;

    // ── Shared Cognito pool ──────────────────────────────────────────────
    const userPoolId = ssm.StringParameter.valueForStringParameter(
      this,
      `/nakomis-infra/${deployEnv}/cognito/user-pool-id`,
    );
    const loginDomain = ssm.StringParameter.valueForStringParameter(
      this,
      `/nakomis-infra/${deployEnv}/cognito/login-domain`,
    );
    const userPool = cognito.UserPool.fromUserPoolId(
      this,
      'SharedUserPool',
      userPoolId,
    );

    const userPoolClient = new cognito.UserPoolClient(this, 'DashboardClient', {
      userPoolClientName: `blog-pipeline-${deployEnv}`,
      userPool,
      generateSecret: false,
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: [
          `${appOrigin}/loggedin`,
          `${localOrigin}/loggedin`,
        ],
        logoutUrls: [`${appOrigin}/logout`, `${localOrigin}/logout`],
      },
    });

    // ── list-posts Lambda ────────────────────────────────────────────────
    const listPostsHandler = new nodejs.NodejsFunction(this, 'ListPostsHandler', {
      entry: path.join(__dirname, '../lambda/api/list-posts-handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: { POSTS_TABLE_NAME: postsTable.tableName },
    });
    postsTable.grantReadData(listPostsHandler);

    // ── HTTP API ─────────────────────────────────────────────────────────
    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `blog-pipeline-api-${deployEnv}`,
      corsPreflight: {
        allowOrigins: [appOrigin, localOrigin],
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.OPTIONS],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    // The dashboard sends a Cognito access token; only valid tokens issued for
    // our app client reach the Lambda.
    const authorizer = new HttpJwtAuthorizer(
      'CognitoAuthorizer',
      `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`,
      { jwtAudience: [userPoolClient.userPoolClientId] },
    );

    httpApi.addRoutes({
      path: '/posts',
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration(
        'ListPostsIntegration',
        listPostsHandler,
      ),
      authorizer,
    });

    // ── SSM parameters consumed by the web build (set-config.sh) ─────────
    new ssm.StringParameter(this, 'ApiUrlParam', {
      parameterName: `${ssmPrefix}/api/url`,
      stringValue: httpApi.apiEndpoint,
      description: `Blog-pipeline HTTP API endpoint (${deployEnv})`,
    });
    new ssm.StringParameter(this, 'ClientIdParam', {
      parameterName: `${ssmPrefix}/cognito/client-id`,
      stringValue: userPoolClient.userPoolClientId,
      description: `Blog-pipeline Cognito app client ID (${deployEnv})`,
    });
    new ssm.StringParameter(this, 'UserPoolIdParam', {
      parameterName: `${ssmPrefix}/cognito/user-pool-id`,
      stringValue: userPoolId,
      description: `Shared NakomisUserPool ID, mirrored for blog-pipeline (${deployEnv})`,
    });
    new ssm.StringParameter(this, 'LoginDomainParam', {
      parameterName: `${ssmPrefix}/cognito/login-domain`,
      stringValue: loginDomain,
      description: `Cognito hosted-login domain for blog-pipeline (${deployEnv})`,
    });

    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: httpApi.apiEndpoint,
      description: 'Blog-pipeline HTTP API endpoint',
    });
  }
}
