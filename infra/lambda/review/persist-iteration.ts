import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { putReviews, reviewsKey } from './drafts';
import { requireEnv } from './runtime';
import type { GateOutput } from './gate';
import type { ReviewResult } from './schema';

/**
 * Persists one iteration's outcome.
 *
 * The full reviewer results (and the gate's decision) are written to S3 as
 * `reviews.json`; the post item gets the running index — iteration count and
 * the latest publishability score. The score is stored /100 to match the
 * dashboard, while the gate works in /10.
 */
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export interface PersistIterationInput {
  slug: string;
  iteration: number;
  reviews: ReviewResult[];
  gate: GateOutput;
}

export async function handler(
  event: PersistIterationInput,
): Promise<{ slug: string; iteration: number }> {
  const { slug, iteration, reviews, gate } = event;
  const tableName = requireEnv('POSTS_TABLE_NAME');

  await putReviews(reviewsKey(slug, iteration), {
    slug,
    iteration,
    reviews,
    gate,
  });

  const now = new Date().toISOString();
  if (gate.minScore !== null) {
    await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { slug },
        UpdateExpression:
          'SET reviewIteration = :it, publishabilityScore = :score, updatedAt = :now',
        ExpressionAttributeValues: {
          ':it': iteration,
          // gate score is /10; the dashboard shows /100.
          ':score': gate.minScore * 10,
          ':now': now,
        },
      }),
    );
  } else {
    // No usable verdict this iteration — record the iteration, leave the
    // last known score untouched.
    await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { slug },
        UpdateExpression: 'SET reviewIteration = :it, updatedAt = :now',
        ExpressionAttributeValues: { ':it': iteration, ':now': now },
      }),
    );
  }

  return { slug, iteration };
}
