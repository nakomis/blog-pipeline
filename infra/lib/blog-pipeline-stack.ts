import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import { EnvConfig } from './config';

export interface BlogPipelineStackProps extends cdk.StackProps {
  config: EnvConfig;
}

/**
 * Core blog-pipeline stack.
 *
 * For now this holds only the foundational data store — one DynamoDB item per
 * blog post. The review loop, webhook, Step Functions state machine, API and
 * web hosting are added by their respective Taiga stories (PIPE-1 … PIPE-6).
 */
export class BlogPipelineStack extends cdk.Stack {
  /** One item per blog post, keyed by slug. */
  public readonly postsTable: dynamodb.Table;

  /** One row per fal.ai image job (PIPE-6), keyed by fal `requestId`. */
  public readonly imageJobsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: BlogPipelineStackProps) {
    super(scope, id, props);
    const { config } = props;
    const isProd = config.deployEnv === 'prod';

    this.postsTable = new dynamodb.Table(this, 'PostsTable', {
      tableName: `blog-pipeline-posts-${config.deployEnv}`,
      partitionKey: { name: 'slug', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: isProd
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: isProd,
      },
    });

    // The dashboard lists posts by pipeline stage; a GSI on `status` keeps
    // that query cheap without scanning the whole table.
    this.postsTable.addGlobalSecondaryIndex({
      indexName: 'by-status',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'updatedAt', type: dynamodb.AttributeType.STRING },
    });

    // Image jobs (PIPE-6). One row per fal.ai generation, keyed by the
    // `requestId` fal returns — the webhook callback carries only that id, so
    // this row maps it back to the post and placeholder. Rows are transient: a
    // TTL on `expiresAt` reaps them a week after creation.
    this.imageJobsTable = new dynamodb.Table(this, 'ImageJobsTable', {
      tableName: `blog-pipeline-image-jobs-${config.deployEnv}`,
      partitionKey: { name: 'requestId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: isProd
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    new cdk.CfnOutput(this, 'PostsTableName', {
      value: this.postsTable.tableName,
      description: 'DynamoDB table holding one item per blog post',
    });
    new cdk.CfnOutput(this, 'ImageJobsTableName', {
      value: this.imageJobsTable.tableName,
      description: 'DynamoDB table holding one row per fal.ai image job',
    });
  }
}
