import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { EnvConfig } from './config';

export interface ApiStackProps extends cdk.StackProps {
  config: EnvConfig;
  /** The posts table — owned by `BlogPipelineStack`, read by the API Lambda. */
  postsTable: dynamodb.ITable;
  /**
   * ACM certificate (us-east-1) covering the API domain — from `WebCertStack`,
   * consumed cross-region.
   */
  certificate: acm.ICertificate;
}

/**
 * The dashboard read path: a REST API serving `GET /posts` from a Lambda that
 * reads the posts table, behind a CloudFront distribution on a custom domain.
 *
 * Two independent gates protect the data:
 *  - a **Cognito authorizer** — the dashboard sends a user's access token;
 *  - an **API key** — required on every request, injected by CloudFront so the
 *    browser never sees it. A request that bypasses CloudFront and hits the API
 *    Gateway origin directly carries no key and is rejected. The key also backs
 *    a usage plan that throttles and meters the API.
 *
 * A REST API (not an HTTP API) is used because API keys and usage plans are a
 * REST-API-only feature.
 *
 * Authentication uses the shared `NakomisUserPool` — its ID and hosted-login
 * domain are published per account at `/nakomis-infra/{env}/cognito/*`. This
 * stack imports the pool and creates its own app client against it.
 */
export class ApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { config, postsTable, certificate } = props;
    const { deployEnv, domainName, apiDomainName, hostedZoneName, ssmPrefix } =
      config;

    // Local dev runs the SPA on Vite's default port.
    const localOrigin = 'http://localhost:5173';
    const appOrigin = `https://${domainName}`;
    const allowedOrigins = [appOrigin, localOrigin];

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
        callbackUrls: [`${appOrigin}/loggedin`, `${localOrigin}/loggedin`],
        logoutUrls: [`${appOrigin}/logout`, `${localOrigin}/logout`],
      },
    });

    // ── list-posts Lambda ────────────────────────────────────────────────
    const listPostsHandler = new nodejs.NodejsFunction(this, 'ListPostsHandler', {
      functionName: `blog-pipeline-list-posts-${deployEnv}`,
      entry: path.join(__dirname, '../lambda/api/list-posts-handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: {
        POSTS_TABLE_NAME: postsTable.tableName,
        // The API sits on a different subdomain from the SPA, so responses
        // need CORS headers — the handler echoes an allowlisted origin.
        ALLOWED_ORIGINS: allowedOrigins.join(','),
      },
    });
    postsTable.grantReadData(listPostsHandler);

    // ── REST API ─────────────────────────────────────────────────────────
    const api = new apigateway.RestApi(this, 'RestApi', {
      restApiName: `blog-pipeline-api-${deployEnv}`,
      description: `Blog-pipeline dashboard API (${deployEnv})`,
      deployOptions: { stageName: 'api' },
      defaultCorsPreflightOptions: {
        allowOrigins: allowedOrigins,
        allowMethods: ['GET', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    // Only valid tokens issued for the shared pool reach the Lambda.
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      'CognitoAuthorizer',
      {
        cognitoUserPools: [userPool],
        authorizerName: `blog-pipeline-${deployEnv}`,
      },
    );

    api.root.addResource('posts').addMethod(
      'GET',
      new apigateway.LambdaIntegration(listPostsHandler),
      {
        apiKeyRequired: true,
        authorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      },
    );

    // ── API key — generated at deploy time, never persisted ──────────────
    // `secretsmanager:GetRandomPassword` is a free API call that creates no
    // Secrets Manager secret. Its result is consumed as an Fn::GetAtt token: it
    // reaches API Gateway and the CloudFront origin header below, but never
    // lands in SSM, `cdk.context.json` or git.
    const keyGen = new cr.AwsCustomResource(this, 'OriginApiKeyGen', {
      onCreate: {
        service: 'SecretsManager',
        action: 'getRandomPassword',
        parameters: { PasswordLength: 40, ExcludePunctuation: true },
        physicalResourceId: cr.PhysicalResourceId.of(
          `blog-pipeline-origin-api-key-${deployEnv}`,
        ),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['secretsmanager:GetRandomPassword'],
          resources: ['*'],
        }),
      ]),
      installLatestAwsSdk: false,
    });
    const originApiKey = keyGen.getResponseField('RandomPassword');

    const apiKey = api.addApiKey('OriginApiKey', {
      apiKeyName: `blog-pipeline-${deployEnv}`,
      value: originApiKey,
    });
    const usagePlan = api.addUsagePlan('UsagePlan', {
      name: `blog-pipeline-${deployEnv}`,
      throttle: { rateLimit: 20, burstLimit: 40 },
      quota: { limit: 10_000, period: apigateway.Period.DAY },
    });
    usagePlan.addApiStage({ stage: api.deploymentStage });
    usagePlan.addApiKey(apiKey);

    // ── CloudFront in front of the API ───────────────────────────────────
    // CloudFront injects the API key as `x-api-key`; the browser only ever
    // sends the Cognito bearer token.
    const apiDistribution = new cloudfront.Distribution(this, 'ApiDistribution', {
      comment: `blog-pipeline API (${deployEnv})`,
      defaultBehavior: {
        origin: new origins.RestApiOrigin(api, {
          customHeaders: { 'x-api-key': originApiKey },
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        // Forward every viewer header (notably `Authorization`) except `Host`,
        // which API Gateway must set itself.
        originRequestPolicy:
          cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      },
      domainNames: [apiDomainName],
      certificate,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    const zone = route53.HostedZone.fromLookup(this, 'Zone', {
      domainName: hostedZoneName,
    });
    const apiAlias = route53.RecordTarget.fromAlias(
      new route53Targets.CloudFrontTarget(apiDistribution),
    );
    new route53.ARecord(this, 'ApiAliasA', {
      zone,
      recordName: apiDomainName,
      target: apiAlias,
    });
    new route53.AaaaRecord(this, 'ApiAliasAaaa', {
      zone,
      recordName: apiDomainName,
      target: apiAlias,
    });

    // ── SSM parameters consumed by the web build (set-config.sh) ─────────
    // The API URL is *not* published — with a stable custom domain the web
    // build derives it directly from the environment.
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

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: `https://${apiDomainName}`,
      description: 'Blog-pipeline dashboard API URL',
    });
  }
}
