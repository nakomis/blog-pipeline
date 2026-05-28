import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from 'aws-lambda';

/**
 * The pipeline stages a post can occupy — mirrors `PIPELINE_STAGES` in the web
 * app. The `by-status` GSI is partitioned on this value.
 */
const VALID_STATUSES = [
  'queued',
  'reviewing',
  'staged',
  'published',
  'failed',
] as const;
type PostStatus = (typeof VALID_STATUSES)[number];

/** Name of the GSI on the posts table — see `BlogPipelineStack`. */
const STATUS_INDEX = 'by-status';

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function isPostStatus(value: string): value is PostStatus {
  return (VALID_STATUSES as readonly string[]).includes(value);
}

/**
 * CORS headers for the response.
 *
 * The dashboard API sits on a different subdomain from the SPA, so browser
 * requests are cross-origin. The REST API answers the OPTIONS preflight itself;
 * the actual `GET` response needs the header too, so the request `Origin` is
 * echoed back when it is one of the `ALLOWED_ORIGINS` the stack configured.
 */
function corsHeaders(event: APIGatewayProxyEvent): Record<string, string> {
  const allowed = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .filter(Boolean);
  const headers = event.headers ?? {};
  const origin = headers.Origin ?? headers.origin ?? '';
  return allowed.includes(origin)
    ? { 'access-control-allow-origin': origin, vary: 'Origin' }
    : {};
}

function jsonResponse(
  statusCode: number,
  body: unknown,
  extraHeaders: Record<string, string>,
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', ...extraHeaders },
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
export async function listPosts(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const cors = corsHeaders(event);

  const tableName = process.env.POSTS_TABLE_NAME;
  if (!tableName) {
    return jsonResponse(
      500,
      { message: 'POSTS_TABLE_NAME is not configured' },
      cors,
    );
  }

  const status = event.queryStringParameters?.status;

  if (status !== undefined) {
    if (!isPostStatus(status)) {
      return jsonResponse(
        400,
        {
          message:
            `Unknown status '${status}'. ` +
            `Expected one of: ${VALID_STATUSES.join(', ')}`,
        },
        cors,
      );
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
    return jsonResponse(200, { posts: result.Items ?? [] }, cors);
  }

  const result = await docClient.send(
    new ScanCommand({ TableName: tableName }),
  );
  const posts = (result.Items ?? []).sort((a, b) =>
    String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')),
  );
  return jsonResponse(200, { posts }, cors);
}
