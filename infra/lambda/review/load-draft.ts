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
}

export interface LoadDraftOutput {
  slug: string;
  iteration: number;
  draftKey: string;
  providers: ReviewProvider[];
}

export async function handler(event: LoadDraftInput): Promise<LoadDraftOutput> {
  const { slug } = event;
  const tableName = requireEnv('POSTS_TABLE_NAME');

  const { Item } = await docClient.send(
    new GetCommand({ TableName: tableName, Key: { slug } }),
  );
  if (!Item) {
    throw new Error(`No post item for slug '${slug}'`);
  }

  const key = draftKey(slug, 1);
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

  await triggerImageSubmit(slug);

  return {
    slug,
    iteration: 1,
    draftKey: key,
    providers: [...REVIEW.providers],
  };
}
