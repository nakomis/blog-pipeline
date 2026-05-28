import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { applyPlaceholders, defaultApplyDeps } from '../images/placeholders';
import { requireEnv } from './runtime';
import type { ReviewOutcome } from './schema';

/**
 * The state machine's single terminal step.
 *
 * Every path the loop can end on — a clean pass, a capped failure, a quorum
 * failure, or an unexpected exception — routes here to record the post's final
 * status and *why* it ended that way. After this the execution either Succeeds
 * (pass / capped / quorum — the orchestrator did its job) or, for an exception,
 * runs on to a `Fail` state.
 */
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export interface SetOutcomeInput {
  slug: string;
  /** `staged` for a clean pass; `failed` for any of the three failure states. */
  status: 'staged' | 'failed';
  reviewOutcome: ReviewOutcome;
  /** Human-readable detail — set on the exception and quorum paths. */
  error?: string;
}

export async function handler(
  event: SetOutcomeInput,
): Promise<{ slug: string; status: string; reviewOutcome: ReviewOutcome }> {
  const { slug, status, reviewOutcome, error } = event;
  const tableName = requireEnv('POSTS_TABLE_NAME');
  const now = new Date().toISOString();

  const values: Record<string, unknown> = {
    ':status': status,
    ':outcome': reviewOutcome,
    ':now': now,
  };
  let updateExpression =
    'SET #status = :status, reviewOutcome = :outcome, ' +
    'reviewedAt = :now, updatedAt = :now';
  if (error) {
    updateExpression += ', reviewError = :error';
    values[':error'] = error;
  }

  await docClient.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { slug },
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: values,
    }),
  );

  // The post has just left review, so it is now safe to rewrite any `{{image}}`
  // placeholders whose images have arrived. This is the natural "leaving review"
  // hook; the callback handles any images that land later. Best-effort — the
  // outcome is already recorded, so an image hiccup must not fail this step.
  try {
    await applyPlaceholders(slug, defaultApplyDeps());
  } catch (err) {
    console.error(`applyPlaceholders failed for '${slug}'`, err);
  }

  return { slug, status, reviewOutcome };
}
