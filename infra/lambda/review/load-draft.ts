import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { REVIEW } from '../../lib/config';
import type { ReviewProvider } from '../../lib/config';
import { draftExists, draftKey } from './drafts';
import { requireEnv } from './runtime';

/**
 * The state machine's first step.
 *
 * Validates the input the webhook (PIPE-2) — or the seed script — set up: the
 * post item must exist and its iteration-1 draft must be in S3. It then marks
 * the post `reviewing` and hands the loop its starting state.
 *
 * A missing post or draft throws — the state machine's `Catch` routes that to
 * the `exception` outcome.
 */
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambdaClient = new LambdaClient({});

/**
 * Kick off image generation, concurrently with the review loop and without
 * blocking it. Fire-and-forget (`Event` invoke), and deliberately best-effort:
 * an image-submit problem must never fail the review, so any error here is
 * swallowed — the post can still be reviewed and published without its
 * illustrations.
 */
async function triggerImageSubmit(slug: string): Promise<void> {
  const functionName = process.env.IMAGE_SUBMIT_FUNCTION_NAME;
  if (!functionName) {
    return;
  }
  try {
    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify({ slug })),
      }),
    );
  } catch (err) {
    console.error(`image-submit invoke failed for '${slug}'`, err);
  }
}

export interface LoadDraftInput {
  slug: string;
  /**
   * Iteration to start reviewing from. Defaults to 1 (a fresh post). A human
   * edit in the bag (PIPE-4) writes a new iteration and can re-review it by
   * starting the loop here — the iteration cap is then measured relative to
   * this point (see `gate`).
   */
  startIteration?: number;
}

export interface LoadDraftOutput {
  slug: string;
  iteration: number;
  /** The iteration this run started from — anchors the relative cap in `gate`. */
  baseIteration: number;
  draftKey: string;
  providers: ReviewProvider[];
}

export async function handler(event: LoadDraftInput): Promise<LoadDraftOutput> {
  const { slug } = event;
  const startIteration = event.startIteration ?? 1;
  const tableName = requireEnv('POSTS_TABLE_NAME');

  const { Item } = await docClient.send(
    new GetCommand({ TableName: tableName, Key: { slug } }),
  );
  if (!Item) {
    throw new Error(`No post item for slug '${slug}'`);
  }

  const key = draftKey(slug, startIteration);
  if (!(await draftExists(key))) {
    throw new Error(`No draft object at ${key} for slug '${slug}'`);
  }

  const now = new Date().toISOString();
  await docClient.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { slug },
      UpdateExpression:
        'SET #status = :reviewing, reviewStartedAt = :now, updatedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':reviewing': 'reviewing', ':now': now },
    }),
  );

  // Only kick off image generation on a fresh entry. A re-review of an edited
  // draft (startIteration > 1) already has its images; image-submit is
  // idempotent anyway, but it reads the iteration-1 draft, so skip it here.
  if (startIteration === 1) {
    await triggerImageSubmit(slug);
  }

  return {
    slug,
    iteration: startIteration,
    baseIteration: startIteration,
    draftKey: key,
    providers: [...REVIEW.providers],
  };
}
