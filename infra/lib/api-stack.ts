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
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';
import { EnvConfig } from './config';

export interface ApiStackProps extends cdk.StackProps {
  config: EnvConfig;
  /** The posts table — owned by `BlogPipelineStack`, read by the API Lambda. */
  postsTable: dynamodb.ITable;
  /**
   * The drafts + images bucket — owned by `BlogPipelineReviewStack`. The image
   * callback (PIPE-6) writes generated PNGs and rewrites draft placeholders.
   */
  draftsBucket: s3.IBucket;
  /** The image-jobs table (PIPE-6) — owned by `BlogPipelineStack`. */
  imageJobsTable: dynamodb.ITable;
  /**
   * The review loop's state machine — owned by `BlogPipelineReviewStack`. The
   * bag's edit action (PIPE-4) starts a fresh execution to re-review an edited
   * draft.
   */
  reviewStateMachine: sfn.IStateMachine;
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
    const {
      config,
      postsTable,
      draftsBucket,
      imageJobsTable,
      reviewStateMachine,
      certificate,
    } = props;
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

    // The shared pool's hosted-login domain runs Managed Login (branding
    // version 2), under which every app client must have a branding resource
    // before its login pages will render — without one the hosted UI returns
    // "Login pages unavailable". This applies the nakomis "One Dark" dark
    // theme so the sign-in page matches the dashboard, with a sage-green
    // accent (#98c379) for the primary button, links and focus — consistent
    // with the SPA. Colours are 8-digit RGBA hex (no leading '#').
    const branding = new cognito.CfnManagedLoginBranding(
      this,
      'DashboardLoginBranding',
      {
        userPoolId,
        clientId: userPoolClient.userPoolClientId,
        useCognitoProvidedValues: false,
        settings: {
          components: {
            pageBackground: {
              image: { enabled: false },
              darkMode: { color: '282c34ff' },
            },
            pageHeader: {
              backgroundImage: { enabled: false },
              logo: { location: 'START', enabled: false },
              darkMode: { background: { color: '21252bff' }, borderColor: '3e4451ff' },
            },
            pageFooter: {
              backgroundImage: { enabled: false },
              logo: { location: 'START', enabled: false },
              darkMode: { background: { color: '21252bff' }, borderColor: '3e4451ff' },
            },
            form: {
              borderRadius: 8,
              backgroundImage: { enabled: false },
              logo: { location: 'CENTER', position: 'TOP', enabled: false, formInclusion: 'IN' },
              darkMode: { backgroundColor: '2c313aff', borderColor: '3e4451ff' },
            },
            pageText: {
              darkMode: { bodyColor: 'abb2bfff', headingColor: 'ffffffff', descriptionColor: '5c6370ff' },
            },
            primaryButton: {
              darkMode: {
                defaults: { backgroundColor: '98c379ff', textColor: '21252bff' },
                hover: { backgroundColor: '82b366ff', textColor: '21252bff' },
                active: { backgroundColor: '6da050ff', textColor: '21252bff' },
                disabled: { backgroundColor: '2c313aff', borderColor: '3e4451ff' },
              },
            },
            secondaryButton: {
              darkMode: {
                defaults: { backgroundColor: '2c313aff', borderColor: '3e4451ff', textColor: 'abb2bfff' },
                hover: { backgroundColor: '353b45ff', borderColor: '98c379ff', textColor: 'ffffffff' },
                active: { backgroundColor: '21252bff', borderColor: '3e4451ff', textColor: 'ffffffff' },
              },
            },
            alert: {
              borderRadius: 4,
              darkMode: { error: { backgroundColor: '3a1515ff', borderColor: 'e06c75ff' } },
            },
            idpButton: {
              standard: {
                darkMode: {
                  defaults: { backgroundColor: '2c313aff', borderColor: '3e4451ff', textColor: 'abb2bfff' },
                  hover: { backgroundColor: '353b45ff', borderColor: '98c379ff', textColor: 'ffffffff' },
                  active: { backgroundColor: '21252bff', borderColor: '3e4451ff', textColor: 'ffffffff' },
                },
              },
              custom: {},
            },
            phoneNumberSelector: { displayType: 'TEXT' },
            favicon: { enabledTypes: ['ICO', 'SVG'] },
          },
          componentClasses: {
            input: {
              borderRadius: 6,
              darkMode: {
                defaults: { backgroundColor: '21252bff', borderColor: '3e4451ff' },
                placeholderColor: '5c6370ff',
              },
            },
            inputLabel: { darkMode: { textColor: 'abb2bfff' } },
            inputDescription: { darkMode: { textColor: '5c6370ff' } },
            link: {
              darkMode: { defaults: { textColor: '98c379ff' }, hover: { textColor: 'b5d8a0ff' } },
            },
            optionControls: {
              darkMode: {
                defaults: { backgroundColor: '21252bff', borderColor: '3e4451ff' },
                selected: { backgroundColor: '98c379ff', foregroundColor: '21252bff' },
              },
            },
            focusState: { darkMode: { borderColor: '98c379ff' } },
          },
          categories: {
            global: {
              colorSchemeMode: 'DARK',
              pageFooter: { enabled: false },
              pageHeader: { enabled: false },
              spacingDensity: 'REGULAR',
            },
          },
        },
      },
    );
    branding.node.addDependency(userPoolClient);

    // ── API Lambda (router) ──────────────────────────────────────────────
    // One function fronts two routes: `GET /posts` (the dashboard read path)
    // and `POST /image-callback` (fal.ai's image webhook, PIPE-6). The callback
    // verifies fal's signature in-handler, downloads the image to the drafts
    // bucket, and rewrites the post's `{{image}}` placeholder.
    const apiHandler = new nodejs.NodejsFunction(this, 'ApiHandler', {
      functionName: `blog-pipeline-api-${deployEnv}`,
      entry: path.join(__dirname, '../lambda/api/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: {
        POSTS_TABLE_NAME: postsTable.tableName,
        DRAFTS_BUCKET: draftsBucket.bucketName,
        IMAGE_JOBS_TABLE_NAME: imageJobsTable.tableName,
        REVIEW_STATE_MACHINE_ARN: reviewStateMachine.stateMachineArn,
        // The API sits on a different subdomain from the SPA, so responses
        // need CORS headers — the handler echoes an allowlisted origin.
        ALLOWED_ORIGINS: allowedOrigins.join(','),
      },
    });
    // The bag (PIPE-4) writes post status, edit metadata and decision
    // timestamps, so the read path now needs write access too.
    postsTable.grantReadWriteData(apiHandler);
    draftsBucket.grantReadWrite(apiHandler);
    imageJobsTable.grantReadWriteData(apiHandler);
    reviewStateMachine.grantStartExecution(apiHandler);

    // `POST /publish-now` (PIPE-14) dispatches the `promote-approved` workflow on
    // blog-content on demand. The GitHub fine-grained PAT (Actions:write on
    // blog-content) is provisioned out-of-band — CDK creates the empty secret,
    // the value is set once by hand and never lands in this repo.
    const githubDispatchSecret = new secretsmanager.Secret(
      this,
      'GithubDispatchSecret',
      {
        secretName: `blog-pipeline-github-dispatch-${deployEnv}`,
        description:
          'GitHub fine-grained PAT (Actions:write on blog-content) used by ' +
          'POST /publish-now to dispatch the promote-approved workflow. ' +
          'Value provisioned out-of-band.',
      },
    );
    githubDispatchSecret.grantRead(apiHandler);
    apiHandler.addEnvironment(
      'GITHUB_DISPATCH_SECRET_ARN',
      githubDispatchSecret.secretArn,
    );

    // ── REST API ─────────────────────────────────────────────────────────
    const api = new apigateway.RestApi(this, 'RestApi', {
      restApiName: `blog-pipeline-api-${deployEnv}`,
      description: `Blog-pipeline dashboard API (${deployEnv})`,
      deployOptions: { stageName: 'api' },
      defaultCorsPreflightOptions: {
        allowOrigins: allowedOrigins,
        allowMethods: ['GET', 'POST', 'OPTIONS'],
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

    const apiIntegration = new apigateway.LambdaIntegration(apiHandler);

    // Every dashboard route carries the same protection: a Cognito token and
    // the CloudFront-injected API key.
    const securedMethod = {
      apiKeyRequired: true,
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };

    const posts = api.root.addResource('posts');
    posts.addMethod('GET', apiIntegration, securedMethod);

    // `/posts/{slug}` — the bag's detail bundle and write actions (PIPE-4).
    const post = posts.addResource('{slug}');
    post.addMethod('GET', apiIntegration, securedMethod);
    post.addResource('edit').addMethod('POST', apiIntegration, securedMethod);
    post
      .addResource('decision')
      .addMethod('POST', apiIntegration, securedMethod);

    // `/publish-now` — promote approved, due posts on demand (PIPE-14) rather
    // than waiting for the 04:00 UTC cron. Same protection as the other actions.
    api.root
      .addResource('publish-now')
      .addMethod('POST', apiIntegration, securedMethod);

    // fal.ai's image webhook (PIPE-6). Public and key-less: fal cannot present
    // a Cognito token or the CloudFront-injected API key, and an API Gateway
    // authorizer can't see the body to verify fal's signature — so the route is
    // open and the Lambda verifies the ED25519 signature itself before trusting
    // anything.
    api.root
      .addResource('image-callback')
      .addMethod('POST', apiIntegration, {
        apiKeyRequired: false,
        authorizationType: apigateway.AuthorizationType.NONE,
      });

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
        // HTTPS_ONLY, not REDIRECT_TO_HTTPS. A redirect would let a plaintext
        // HTTP request — carrying the Cognito bearer token — reach the edge
        // before the 301 is returned, leaking the credential; most clients
        // then follow the redirect silently, so the leak goes unnoticed. An
        // API must reject HTTP outright, not usher it towards HTTPS.
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        // ALLOW_ALL so the `POST /image-callback` webhook (PIPE-6) reaches the
        // origin — the GET read path is unaffected.
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
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
