import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from 'aws-lambda';
import { draftKey, putDraft } from '../review/drafts';
import { requireEnv } from '../review/runtime';
import { corsHeaders, jsonResponse } from './http';

/**
 * The bag's write actions (PIPE-4).
 *
 * - `POST /posts/{slug}/edit` — a human edits the staged article. The edit is
 *   written as the next draft iteration; optionally it re-enters the review loop
 *   (Step Functions) starting from that iteration.
 * - `POST /posts/{slug}/decision` — approve or reject the staged post.
 *
 * Both actions only make sense on a `staged` post, so a post in any other state
 * is a `409`.
 */

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sfn = new SFNClient({});

interface PostItem {
  status?: string;
  latestIteration?: number;
  reviewIteration?: number;
}

async function getPost(slug: string): Promise<PostItem | undefined> {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: requireEnv('POSTS_TABLE_NAME'), Key: { slug } }),
  );
  return Item as PostItem | undefined;
}

function latestIterationOf(post: PostItem): number {
  return Number(post.latestIteration ?? post.reviewIteration ?? 1);
}

function parseBody(event: APIGatewayProxyEvent): unknown {
  return JSON.parse(event.body ?? '{}');
}

export async function postEdit(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const cors = corsHeaders(event);
  const slug = event.pathParameters?.slug;
  if (!slug) {
    return jsonResponse(400, { message: 'Missing slug' }, cors);
  }

  let body: { markdown?: unknown; reReview?: unknown };
  try {
    body = parseBody(event) as typeof body;
  } catch {
    return jsonResponse(400, { message: 'Malformed JSON body' }, cors);
  }
  const { markdown, reReview } = body;
  if (typeof markdown !== 'string' || markdown.length === 0) {
    return jsonResponse(400, { message: 'markdown is required' }, cors);
  }

  const post = await getPost(slug);
  if (!post) {
    return jsonResponse(404, { message: `No post '${slug}'` }, cors);
  }
  if (post.status !== 'staged') {
    return jsonResponse(
      409,
      { message: `Cannot edit a post in status '${post.status}'` },
      cors,
    );
  }

  const nextIteration = latestIterationOf(post) + 1;
  await putDraft(draftKey(slug, nextIteration), markdown);

  const now = new Date().toISOString();
  const startReview = reReview === true;

  const names: Record<string, string> = { '#st': 'status' };
  const values: Record<string, unknown> = {
    ':it': nextIteration,
    ':now': now,
    ':empty': [] as number[],
    ':ed': [nextIteration],
  };
  const sets = [
    'latestIteration = :it',
    'lastEditedAt = :now',
    'updatedAt = :now',
    'editedIterations = list_append(if_not_exists(editedIterations, :empty), :ed)',
  ];
  if (startReview) {
    sets.push('#st = :reviewing');
    values[':reviewing'] = 'reviewing';
  }

  await docClient.send(
    new UpdateCommand({
      TableName: requireEnv('POSTS_TABLE_NAME'),
      Key: { slug },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: startReview ? names : undefined,
      ExpressionAttributeValues: values,
    }),
  );

  if (startReview) {
    await sfn.send(
      new StartExecutionCommand({
        stateMachineArn: requireEnv('REVIEW_STATE_MACHINE_ARN'),
        input: JSON.stringify({ slug, startIteration: nextIteration }),
      }),
    );
  }

  return jsonResponse(
    200,
    {
      slug,
      iteration: nextIteration,
      reReview: startReview,
      status: startReview ? 'reviewing' : 'staged',
    },
    cors,
  );
}

export async function postDecision(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const cors = corsHeaders(event);
  const slug = event.pathParameters?.slug;
  if (!slug) {
    return jsonResponse(400, { message: 'Missing slug' }, cors);
  }

  let body: { decision?: unknown };
  try {
    body = parseBody(event) as typeof body;
  } catch {
    return jsonResponse(400, { message: 'Malformed JSON body' }, cors);
  }
  const { decision } = body;
  if (decision !== 'approve' && decision !== 'reject') {
    return jsonResponse(
      400,
      { message: "decision must be 'approve' or 'reject'" },
      cors,
    );
  }

  const post = await getPost(slug);
  if (!post) {
    return jsonResponse(404, { message: `No post '${slug}'` }, cors);
  }
  if (post.status !== 'staged') {
    return jsonResponse(
      409,
      { message: `Cannot decide a post in status '${post.status}'` },
      cors,
    );
  }

  const now = new Date().toISOString();
  const approved = decision === 'approve';
  const nextStatus = approved ? 'approved' : 'failed';
  const timestampAttr = approved ? 'approvedAt' : 'rejectedAt';

  await docClient.send(
    new UpdateCommand({
      TableName: requireEnv('POSTS_TABLE_NAME'),
      Key: { slug },
      UpdateExpression: `SET #st = :status, updatedAt = :now, ${timestampAttr} = :now`,
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':status': nextStatus, ':now': now },
    }),
  );

  return jsonResponse(200, { slug, decision, status: nextStatus }, cors);
}
