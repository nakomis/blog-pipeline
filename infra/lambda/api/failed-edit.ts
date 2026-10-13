import { createHash } from 'crypto';
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
import { draftExists, draftKey, getDraft, putDraft } from '../review/drafts';
import { requireEnv } from '../review/runtime';
import { corsHeaders, jsonResponse } from './http';

/**
 * Edit and re-review a failed post in place (PIPE-36).
 *
 * - `GET  /posts/{slug}/markdown` — the Markdown to edit: the saved-but-not-yet
 *   reviewed edit if there is one, otherwise the latest draft.
 * - `POST /posts/{slug}/markdown` — save an edit. The first save writes the
 *   next draft iteration; later saves overwrite that same pending iteration, so
 *   repeated saves never burn through iterations.
 * - `POST /posts/{slug}/rereview` — (optionally save, then) send the post back
 *   into the review loop from the pending iteration. The failure reason is
 *   cleared from the post, but appended to `failureHistory` first so the bag
 *   can still show why it failed before.
 *
 * All three only work on a `failed` post — anything else is a `409`. The
 * re-trigger is idempotent: a retry of a re-review that has already started
 * answers `200` without starting a second execution, and the Step Functions
 * execution name is derived from the slug and iteration so a lost response
 * can safely be retried.
 */

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sfn = new SFNClient({});

/** A generous ceiling for one post — well under API Gateway's 10 MB limit. */
export const MAX_MARKDOWN_BYTES = 1024 * 1024;

/** One past failure, kept on the post item after a re-review clears it. */
export interface FailureHistoryEntry {
  /** `capped`, `quorum`, `exception`, or `rejected` for a human rejection. */
  reviewOutcome: string;
  reviewError?: string;
  /** The last iteration reviewed before the failure. */
  iteration?: number;
  failedAt?: string;
  /** When the re-review cleared this failure. */
  clearedAt: string;
  /** The iteration the re-review started from. */
  reReviewIteration: number;
}

interface PostItem {
  status?: string;
  latestIteration?: number;
  reviewIteration?: number;
  pendingEditIteration?: number;
  reReviewIteration?: number;
  reviewOutcome?: string;
  reviewError?: string;
  reviewedAt?: string;
  rejectedAt?: string;
  updatedAt?: string;
}

async function getPost(slug: string): Promise<PostItem | undefined> {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: requireEnv('POSTS_TABLE_NAME'), Key: { slug } }),
  );
  return Item as PostItem | undefined;
}

function isConditionalCheckFailure(err: unknown): boolean {
  return (
    err instanceof Error && err.name === 'ConditionalCheckFailedException'
  );
}

/**
 * The highest iteration that has a draft. The post item's counters can lag
 * (a redraft writes the next draft before its review is persisted), so probe
 * S3 upwards from them — a new edit must never overwrite an existing draft.
 */
async function currentIteration(slug: string, post: PostItem): Promise<number> {
  let n = Math.max(
    1,
    Number(post.latestIteration ?? 0) || 0,
    Number(post.reviewIteration ?? 0) || 0,
  );
  while (await draftExists(draftKey(slug, n + 1))) {
    n += 1;
  }
  return n;
}

/**
 * A deterministic Step Functions execution name, so retrying the same
 * re-review can't start a second run. Names allow 80 characters from
 * `[A-Za-z0-9_-]`; long or unusual slugs are trimmed and disambiguated with a
 * short hash.
 */
export function reReviewExecutionName(slug: string, iteration: number): string {
  const suffix = `-${iteration}`;
  const safe = slug.replace(/[^A-Za-z0-9_-]/g, '-');
  const prefix = 'rereview-';
  const room = 80 - prefix.length - suffix.length;
  if (safe === slug && safe.length <= room) {
    return `${prefix}${safe}${suffix}`;
  }
  const hash = createHash('sha256').update(slug).digest('hex').slice(0, 8);
  return `${prefix}${safe.slice(0, room - hash.length - 1)}-${hash}${suffix}`;
}

function slugOf(event: APIGatewayProxyEvent): string | undefined {
  return event.pathParameters?.slug;
}

function notFailed(
  post: PostItem,
  cors: Record<string, string>,
  verb: string,
): APIGatewayProxyResult {
  return jsonResponse(
    409,
    {
      message: `Only failed posts can be ${verb} here; '${post.status}' posts cannot`,
    },
    cors,
  );
}

/** Validate an optional/required `markdown` body field. Returns an error message or null. */
function markdownError(markdown: unknown, required: boolean): string | null {
  if (markdown === undefined && !required) {
    return null;
  }
  if (typeof markdown !== 'string' || markdown.trim().length === 0) {
    return 'markdown must be a non-empty string';
  }
  if (Buffer.byteLength(markdown, 'utf8') > MAX_MARKDOWN_BYTES) {
    return `markdown exceeds ${MAX_MARKDOWN_BYTES} bytes`;
  }
  return null;
}

function parseBody(
  event: APIGatewayProxyEvent,
): { markdown?: unknown } | undefined {
  try {
    const parsed: unknown = JSON.parse(event.body ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** `GET /posts/{slug}/markdown` */
export async function getFailedMarkdown(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const cors = corsHeaders(event);
  const slug = slugOf(event);
  if (!slug) {
    return jsonResponse(400, { message: 'Missing slug' }, cors);
  }
  const post = await getPost(slug);
  if (!post) {
    return jsonResponse(404, { message: `No post '${slug}'` }, cors);
  }
  if (post.status !== 'failed') {
    return notFailed(post, cors, 'edited');
  }

  const iteration = await currentIteration(slug, post);
  const markdown = await getDraft(draftKey(slug, iteration));
  return jsonResponse(
    200,
    {
      slug,
      iteration,
      markdown,
      pendingEdit: post.pendingEditIteration === iteration,
    },
    cors,
  );
}

/** `POST /posts/{slug}/markdown` */
export async function saveFailedMarkdown(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const cors = corsHeaders(event);
  const slug = slugOf(event);
  if (!slug) {
    return jsonResponse(400, { message: 'Missing slug' }, cors);
  }
  const body = parseBody(event);
  if (!body) {
    return jsonResponse(400, { message: 'Malformed JSON body' }, cors);
  }
  const invalid = markdownError(body.markdown, true);
  if (invalid) {
    return jsonResponse(400, { message: invalid }, cors);
  }
  const markdown = body.markdown as string;

  const post = await getPost(slug);
  if (!post) {
    return jsonResponse(404, { message: `No post '${slug}'` }, cors);
  }
  if (post.status !== 'failed') {
    return notFailed(post, cors, 'edited');
  }

  const pending = post.pendingEditIteration;
  const iteration = pending ?? (await currentIteration(slug, post)) + 1;
  await putDraft(draftKey(slug, iteration), markdown);

  const now = new Date().toISOString();
  const sets = [
    'latestIteration = :it',
    'pendingEditIteration = :it',
    'lastEditedAt = :now',
    'updatedAt = :now',
  ];
  const values: Record<string, unknown> = {
    ':it': iteration,
    ':now': now,
    ':failed': 'failed',
  };
  if (pending === undefined) {
    sets.push(
      'editedIterations = list_append(if_not_exists(editedIterations, :empty), :ed)',
    );
    values[':empty'] = [];
    values[':ed'] = [iteration];
  }

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: requireEnv('POSTS_TABLE_NAME'),
        Key: { slug },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ConditionExpression: '#st = :failed',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: values,
      }),
    );
  } catch (err) {
    if (isConditionalCheckFailure(err)) {
      return jsonResponse(
        409,
        { message: 'The post left the failed state while saving' },
        cors,
      );
    }
    throw err;
  }

  return jsonResponse(
    200,
    { slug, iteration, status: 'failed', pendingEdit: true },
    cors,
  );
}

async function startReReview(slug: string, iteration: number): Promise<void> {
  try {
    await sfn.send(
      new StartExecutionCommand({
        stateMachineArn: requireEnv('REVIEW_STATE_MACHINE_ARN'),
        name: reReviewExecutionName(slug, iteration),
        input: JSON.stringify({ slug, startIteration: iteration }),
      }),
    );
  } catch (err) {
    // Already started (or already finished) under this name — a retry.
    if (err instanceof Error && err.name === 'ExecutionAlreadyExists') {
      return;
    }
    throw err;
  }
}

/**
 * A re-review of `post` is already under way from its latest iteration —
 * answer the retry without changing anything, provided it isn't trying to
 * submit different Markdown.
 */
async function replayReReview(
  slug: string,
  post: PostItem,
  markdown: string | undefined,
  cors: Record<string, string>,
): Promise<APIGatewayProxyResult> {
  const iteration = Number(post.reReviewIteration);
  if (markdown !== undefined) {
    const stored = await getDraft(draftKey(slug, iteration));
    if (stored !== markdown) {
      return jsonResponse(
        409,
        { message: 'A re-review is already running with different Markdown' },
        cors,
      );
    }
  }
  // Re-send the start under the same name: a no-op if it is running, and
  // recovers the case where the status flipped but the start never landed.
  await startReReview(slug, iteration);
  return jsonResponse(
    200,
    { slug, iteration, status: post.status, alreadyStarted: true },
    cors,
  );
}

function isInFlightReReview(post: PostItem): boolean {
  return (
    post.status === 'reviewing' &&
    post.reReviewIteration !== undefined &&
    Number(post.reReviewIteration) ===
      Number(post.latestIteration ?? post.reReviewIteration)
  );
}

/** `POST /posts/{slug}/rereview` */
export async function reReviewFailed(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const cors = corsHeaders(event);
  const slug = slugOf(event);
  if (!slug) {
    return jsonResponse(400, { message: 'Missing slug' }, cors);
  }
  const body = parseBody(event);
  if (!body) {
    return jsonResponse(400, { message: 'Malformed JSON body' }, cors);
  }
  const invalid = markdownError(body.markdown, false);
  if (invalid) {
    return jsonResponse(400, { message: invalid }, cors);
  }
  const markdown = body.markdown as string | undefined;

  const post = await getPost(slug);
  if (!post) {
    return jsonResponse(404, { message: `No post '${slug}'` }, cors);
  }
  if (isInFlightReReview(post)) {
    return replayReReview(slug, post, markdown, cors);
  }
  if (post.status !== 'failed') {
    return notFailed(post, cors, 're-reviewed');
  }

  const pending = post.pendingEditIteration;
  const reviewed = await currentIteration(slug, post);
  // A re-review always starts from a fresh, unreviewed iteration so the
  // previous iteration's reviews are never overwritten. Without an edit, the
  // latest draft is carried forward unchanged.
  const iteration = pending ?? reviewed + 1;
  if (markdown !== undefined) {
    await putDraft(draftKey(slug, iteration), markdown);
  } else if (pending === undefined) {
    await putDraft(
      draftKey(slug, iteration),
      await getDraft(draftKey(slug, reviewed)),
    );
  }
  const humanEdit = markdown !== undefined && pending === undefined;

  const now = new Date().toISOString();
  const entry: FailureHistoryEntry = {
    reviewOutcome: post.reviewOutcome ?? (post.rejectedAt ? 'rejected' : 'unknown'),
    clearedAt: now,
    reReviewIteration: iteration,
  };
  if (post.reviewError) {
    entry.reviewError = post.reviewError;
  }
  if (post.reviewIteration !== undefined) {
    entry.iteration = Number(post.reviewIteration);
  }
  const failedAt = post.rejectedAt ?? post.reviewedAt ?? post.updatedAt;
  if (failedAt) {
    entry.failedAt = failedAt;
  }

  const sets = [
    '#st = :reviewing',
    'latestIteration = :it',
    'reReviewIteration = :it',
    'reReviewRequestedAt = :now',
    'updatedAt = :now',
    'failureHistory = list_append(if_not_exists(failureHistory, :empty), :history)',
  ];
  const values: Record<string, unknown> = {
    ':reviewing': 'reviewing',
    ':failed': 'failed',
    ':it': iteration,
    ':now': now,
    ':empty': [],
    ':history': [entry],
  };
  if (humanEdit) {
    sets.push(
      'editedIterations = list_append(if_not_exists(editedIterations, :empty), :ed)',
      'lastEditedAt = :now',
    );
    values[':ed'] = [iteration];
  }

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: requireEnv('POSTS_TABLE_NAME'),
        Key: { slug },
        UpdateExpression:
          `SET ${sets.join(', ')} ` +
          'REMOVE reviewOutcome, reviewError, rejectedAt, pendingEditIteration',
        ConditionExpression: '#st = :failed',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: values,
      }),
    );
  } catch (err) {
    if (!isConditionalCheckFailure(err)) {
      throw err;
    }
    // Lost a race — most likely a double-click whose twin got there first.
    const latest = await getPost(slug);
    if (latest && isInFlightReReview(latest)) {
      return replayReReview(slug, latest, markdown, cors);
    }
    return jsonResponse(
      409,
      { message: 'The post left the failed state before the re-review began' },
      cors,
    );
  }

  await startReReview(slug, iteration);

  return jsonResponse(
    200,
    { slug, iteration, status: 'reviewing', alreadyStarted: false },
    cors,
  );
}
