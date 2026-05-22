import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

/**
 * The pipeline stages a post can occupy — mirrors `PIPELINE_STAGES` in the web
 * app. The `by-status` GSI is partitioned on this value.
 */
const VALID_STATUSES = ['queued', 'reviewing', 'staged', 'published'] as const;
type PostStatus = (typeof VALID_STATUSES)[number];

/** Name of the GSI on the posts table — see `BlogPipelineStack`. */
const STATUS_INDEX = 'by-status';

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function isPostStatus(value: string): value is PostStatus {
  return (VALID_STATUSES as readonly string[]).includes(value);
}

function jsonResponse(
  statusCode: number,
  body: unknown,
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/**
 * Lists blog posts for the dashboard.
 *
 * - `GET /posts` — every post in the pipeline, newest first.
 * - `GET /posts?status=reviewing` — posts in one stage, served cheaply from the
 *   `by-status` GSI. An unrecognised status is a `400`.
 */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const tableName = process.env.POSTS_TABLE_NAME;
  if (!tableName) {
    return jsonResponse(500, { message: 'POSTS_TABLE_NAME is not configured' });
  }

  const status = event.queryStringParameters?.status;

  if (status !== undefined) {
    if (!isPostStatus(status)) {
      return jsonResponse(400, {
        message:
          `Unknown status '${status}'. ` +
          `Expected one of: ${VALID_STATUSES.join(', ')}`,
      });
    }

    const result = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: STATUS_INDEX,
        KeyConditionExpression: '#status = :status',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': status },
        // `updatedAt` is the GSI sort key — descending gives newest first.
        ScanIndexForward: false,
      }),
    );
    return jsonResponse(200, { posts: result.Items ?? [] });
  }

  const result = await docClient.send(
    new ScanCommand({ TableName: tableName }),
  );
  const posts = (result.Items ?? []).sort((a, b) =>
    String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')),
  );
  return jsonResponse(200, { posts });
}
