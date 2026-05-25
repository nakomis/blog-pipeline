import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import { EnvConfig, REVIEW } from './config';

export interface BlogPipelineReviewStackProps extends cdk.StackProps {
  config: EnvConfig;
  /** The posts table — owned by `BlogPipelineStack`, read and written here. */
  postsTable: dynamodb.ITable;
}

/**
 * The cloud review loop (PIPE-3).
 *
 * A Step Functions state machine fans a draft out to four LLM reviewers, applies
 * a deterministic gate, redrafts with Claude Sonnet and loops up to four times,
 * then routes the post to `staged` (a clean pass) or `failed` (capped, quorum
 * not met, or an unexpected exception).
 *
 * Markdown drafts and per-iteration critiques live in a dedicated S3 bucket; the
 * four external reviewer keys (azure, gemini, anthropic, grok) live in SSM
 * Parameter Store as plain `String` parameters (cheaper than Secrets Manager —
 * each `String` parameter is free), created with a placeholder value and
 * populated by hand. The state-machine ARN is published to SSM for PIPE-2.
 */
export class BlogPipelineReviewStack extends cdk.Stack {
  /** The review-loop state machine — triggered per post by PIPE-2. */
  public readonly stateMachine: sfn.StateMachine;

  constructor(
    scope: Construct,
    id: string,
    props: BlogPipelineReviewStackProps,
  ) {
    super(scope, id, props);
    const { config, postsTable } = props;
    const { deployEnv, ssmPrefix } = config;
    const isProd = deployEnv === 'prod';

    // ── Drafts bucket ────────────────────────────────────────────────────
    const draftsBucket = new s3.Bucket(this, 'DraftsBucket', {
      bucketName: `blog-pipeline-drafts-${deployEnv}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: isProd
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
    });

    // ── Reviewer parameters ──────────────────────────────────────────────
    // Plain `String` SSM parameters (not Secrets Manager — far cheaper at this
    // scale) created with a placeholder. An unpopulated parameter fails to
    // parse as JSON, the reviewer surfaces it as `unavailable`, and the loop
    // carries on as long as the three-of-four quorum is met. Populate by hand
    // with the documented JSON shape using `aws ssm put-parameter --overwrite`;
    // CFN leaves the value alone on subsequent deploys (no drift remediation),
    // so the manual edit survives.
    const placeholder = 'REPLACE WITH JSON — see README → Review loop';
    const reviewerParamName = (provider: string): string =>
      `${ssmPrefix}/reviewer/${provider}`;

    const azureParam = new ssm.StringParameter(this, 'AzureReviewerParam', {
      parameterName: reviewerParamName('azure'),
      stringValue: placeholder,
      description:
        'Azure OpenAI reviewer — JSON {apiKey,resourceName,deployment,apiVersion}',
    });
    const geminiParam = new ssm.StringParameter(this, 'GeminiReviewerParam', {
      parameterName: reviewerParamName('gemini'),
      stringValue: placeholder,
      description: 'Google Gemini reviewer — JSON {apiKey}',
    });
    const anthropicParam = new ssm.StringParameter(
      this,
      'AnthropicReviewerParam',
      {
        parameterName: reviewerParamName('anthropic'),
        stringValue: placeholder,
        description: 'Anthropic reviewer — JSON {apiKey}',
      },
    );
    const grokParam = new ssm.StringParameter(this, 'GrokReviewerParam', {
      parameterName: reviewerParamName('grok'),
      stringValue: placeholder,
      description:
        'Grok on Azure AI Foundry — JSON {apiKey,endpoint,deployment,apiVersion}',
    });

    // ── Lambdas ──────────────────────────────────────────────────────────
    const makeFn = (
      id: string,
      file: string,
      opts: {
        timeout?: cdk.Duration;
        memorySize?: number;
        environment?: Record<string, string>;
      },
    ): nodejs.NodejsFunction =>
      new nodejs.NodejsFunction(this, id, {
        functionName: `blog-pipeline-review-${file}-${deployEnv}`,
        entry: path.join(__dirname, `../lambda/review/${file}.ts`),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        timeout: opts.timeout ?? cdk.Duration.seconds(30),
        memorySize: opts.memorySize ?? 256,
        environment: opts.environment,
      });

    // Permission to invoke the Bedrock foundation models and the EU
    // cross-region inference profiles the review loop uses.
    const bedrockInvoke = new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        'arn:aws:bedrock:*::foundation-model/*',
        `arn:aws:bedrock:*:${config.accountId}:inference-profile/*`,
      ],
    });

    const loadDraftFn = makeFn('LoadDraftFn', 'load-draft', {
      environment: {
        POSTS_TABLE_NAME: postsTable.tableName,
        DRAFTS_BUCKET: draftsBucket.bucketName,
      },
    });
    postsTable.grantReadWriteData(loadDraftFn);
    draftsBucket.grantRead(loadDraftFn);

    const reviewerFn = makeFn('ReviewerFn', 'reviewer', {
      timeout: cdk.Duration.seconds(120),
      memorySize: 512,
      environment: {
        DRAFTS_BUCKET: draftsBucket.bucketName,
        AZURE_PARAM_NAME: azureParam.parameterName,
        GEMINI_PARAM_NAME: geminiParam.parameterName,
        ANTHROPIC_PARAM_NAME: anthropicParam.parameterName,
        GROK_PARAM_NAME: grokParam.parameterName,
      },
    });
    draftsBucket.grantRead(reviewerFn);
    azureParam.grantRead(reviewerFn);
    geminiParam.grantRead(reviewerFn);
    anthropicParam.grantRead(reviewerFn);
    grokParam.grantRead(reviewerFn);
    // Bedrock invoke is left on the reviewer role so the bedrock reviewer can
    // be re-enabled without an IAM change — see `providers/index.ts`.
    reviewerFn.addToRolePolicy(bedrockInvoke);

    const gateFn = makeFn('GateFn', 'gate', {
      timeout: cdk.Duration.seconds(10),
    });

    const persistIterationFn = makeFn('PersistIterationFn', 'persist-iteration', {
      environment: {
        POSTS_TABLE_NAME: postsTable.tableName,
        DRAFTS_BUCKET: draftsBucket.bucketName,
      },
    });
    postsTable.grantWriteData(persistIterationFn);
    draftsBucket.grantWrite(persistIterationFn);

    const redraftFn = makeFn('RedraftFn', 'redraft', {
      timeout: cdk.Duration.seconds(180),
      memorySize: 512,
      environment: { DRAFTS_BUCKET: draftsBucket.bucketName },
    });
    draftsBucket.grantReadWrite(redraftFn);
    redraftFn.addToRolePolicy(bedrockInvoke);

    const setOutcomeFn = makeFn('SetOutcomeFn', 'set-outcome', {
      environment: { POSTS_TABLE_NAME: postsTable.tableName },
    });
    postsTable.grantWriteData(setOutcomeFn);

    // ── State machine ────────────────────────────────────────────────────
    const reviewComplete = new sfn.Succeed(this, 'ReviewComplete');
    const reviewFailed = new sfn.Fail(this, 'ReviewFailed', {
      error: 'ReviewException',
      cause: 'An unhandled error ended the review loop.',
    });

    // The single terminal step. Every path through the loop records the post's
    // final status and why it ended there.
    const setOutcome = (
      id: string,
      status: 'staged' | 'failed',
      reviewOutcome: string,
    ): tasks.LambdaInvoke =>
      new tasks.LambdaInvoke(this, id, {
        lambdaFunction: setOutcomeFn,
        payload: sfn.TaskInput.fromObject({
          slug: sfn.JsonPath.stringAt('$.slug'),
          status,
          reviewOutcome,
        }),
        payloadResponseOnly: true,
      });

    const handleException = new tasks.LambdaInvoke(this, 'HandleException', {
      lambdaFunction: setOutcomeFn,
      payload: sfn.TaskInput.fromObject({
        slug: sfn.JsonPath.stringAt('$.slug'),
        status: 'failed',
        reviewOutcome: 'exception',
        error: sfn.JsonPath.stringAt('$.error.Cause'),
      }),
      payloadResponseOnly: true,
    }).next(reviewFailed);

    /** Catch any unhandled error and route it to the exception outcome. */
    const catchToException = (state: {
      addCatch: (
        handler: sfn.IChainable,
        props?: sfn.CatchProps,
      ) => unknown;
    }): void => {
      state.addCatch(handleException, { resultPath: '$.error' });
    };

    const loadDraft = new tasks.LambdaInvoke(this, 'LoadDraft', {
      lambdaFunction: loadDraftFn,
      payloadResponseOnly: true,
    });

    // One reviewer, run once per provider by the Map. A branch that fails is
    // caught and recorded as `unavailable` — it never fails the iteration.
    const invokeReviewer = new tasks.LambdaInvoke(this, 'InvokeReviewer', {
      lambdaFunction: reviewerFn,
      payloadResponseOnly: true,
      retryOnServiceExceptions: true,
    });
    const markUnavailable = new sfn.Pass(this, 'MarkReviewerUnavailable', {
      parameters: {
        provider: sfn.JsonPath.stringAt('$.provider'),
        status: 'unavailable',
        error: sfn.JsonPath.stringAt('$.error.Cause'),
      },
    });
    invokeReviewer.addCatch(markUnavailable, { resultPath: '$.error' });

    const reviewFanOut = new sfn.Map(this, 'ReviewFanOut', {
      itemsPath: '$.providers',
      maxConcurrency: REVIEW.providers.length,
      itemSelector: {
        slug: sfn.JsonPath.stringAt('$.slug'),
        iteration: sfn.JsonPath.numberAt('$.iteration'),
        draftKey: sfn.JsonPath.stringAt('$.draftKey'),
        provider: sfn.JsonPath.stringAt('$$.Map.Item.Value'),
      },
      resultPath: '$.reviews',
    });
    reviewFanOut.itemProcessor(invokeReviewer);

    const gate = new tasks.LambdaInvoke(this, 'Gate', {
      lambdaFunction: gateFn,
      payloadResponseOnly: true,
      resultPath: '$.gate',
    });

    const persistIteration = new tasks.LambdaInvoke(this, 'PersistIteration', {
      lambdaFunction: persistIterationFn,
      payloadResponseOnly: true,
      resultPath: sfn.JsonPath.DISCARD,
    });

    const redraft = new tasks.LambdaInvoke(this, 'Redraft', {
      lambdaFunction: redraftFn,
      payloadResponseOnly: true,
    });

    const setOutcomePass = setOutcome('SetOutcomePass', 'staged', 'passed');
    const setOutcomeCapped = setOutcome('SetOutcomeCapped', 'failed', 'capped');
    const setOutcomeQuorum = setOutcome('SetOutcomeQuorum', 'failed', 'quorum');

    const decideLoop = new sfn.Choice(this, 'DecideLoop')
      .when(
        sfn.Condition.stringEquals('$.gate.decision', 'pass'),
        setOutcomePass.next(reviewComplete),
      )
      .when(
        sfn.Condition.stringEquals('$.gate.decision', 'loop'),
        redraft,
      )
      .when(
        sfn.Condition.stringEquals('$.gate.decision', 'fail-capped'),
        setOutcomeCapped.next(reviewComplete),
      )
      .when(
        sfn.Condition.stringEquals('$.gate.decision', 'fail-quorum'),
        setOutcomeQuorum.next(reviewComplete),
      )
      .otherwise(
        new sfn.Fail(this, 'UnknownGateDecision', {
          error: 'UnknownGateDecision',
          cause: 'The gate returned an unrecognised decision.',
        }),
      );

    // Wire the loop: load → fan out → gate → persist → decide → (redraft → …).
    loadDraft.next(reviewFanOut);
    reviewFanOut.next(gate);
    gate.next(persistIteration);
    persistIteration.next(decideLoop);
    redraft.next(reviewFanOut);

    [loadDraft, reviewFanOut, gate, persistIteration, redraft].forEach(
      catchToException,
    );

    this.stateMachine = new sfn.StateMachine(this, 'ReviewLoop', {
      stateMachineName: `blog-pipeline-review-${deployEnv}`,
      definitionBody: sfn.DefinitionBody.fromChainable(loadDraft),
      timeout: cdk.Duration.minutes(30),
    });
    // Preserve the original logical id from the construct's previous name
    // (`ReviewStateMachine`) so the rename is purely a code-side tidy-up:
    // CFN sees the same resource and updates it in place rather than trying
    // to replace it (which would collide on the explicit `stateMachineName`).
    // The auto-generated IAM role under this construct is still allowed to
    // be replaced cleanly.
    (this.stateMachine.node.defaultChild as sfn.CfnStateMachine)
      .overrideLogicalId('ReviewStateMachineAD9C5398');

    // ── Discovery — published for PIPE-2's webhook ───────────────────────
    new ssm.StringParameter(this, 'StateMachineArnParam', {
      parameterName: `${ssmPrefix}/review/state-machine-arn`,
      stringValue: this.stateMachine.stateMachineArn,
      description: `Blog-pipeline review state machine ARN (${deployEnv})`,
    });

    new cdk.CfnOutput(this, 'ReviewStateMachineArn', {
      value: this.stateMachine.stateMachineArn,
      description: 'Blog-pipeline review-loop state machine ARN',
    });
    new cdk.CfnOutput(this, 'DraftsBucketName', {
      value: draftsBucket.bucketName,
      description: 'S3 bucket holding blog-post drafts and reviewer critiques',
    });
  }
}
