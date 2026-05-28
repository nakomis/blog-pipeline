import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { requireEnv } from '../review/runtime';

/**
 * Maintains the per-image `status` on the post item's `images` list (PIPE-4).
 *
 * `image-submit` writes one `images` entry per `{{image}}` placeholder, in
 * placeholder order, every entry `pending`. The fal callback then flips an
 * entry to `ready` (image stored) or `failed`. The bag's detail view trusts
 * this field, so it must reflect reality.
 *
 * The list is built in placeholder order with one entry per placeholder, so the
 * entry for image `index` sits at list position `index - 1`. The update is
 * guarded by a condition that the entry at that position really does carry that
 * `index`, so it fails closed if that invariant ever stops holding rather than
 * mislabelling a different image.
 *
 * Best-effort: the S3 object and the job row are the source of truth, so a
 * failure here (missing post, unexpected list shape, throttle) is logged and
 * swallowed — it must never fail the callback.
 */

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export type ImageStatus = 'pending' | 'ready' | 'failed';

export async function setImageStatus(
  slug: string,
  index: number,
  status: ImageStatus,
): Promise<void> {
  const pos = index - 1;
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: requireEnv('POSTS_TABLE_NAME'),
        Key: { slug },
        UpdateExpression: `SET images[${pos}].#st = :st`,
        ConditionExpression: `images[${pos}].#ix = :ix`,
        ExpressionAttributeNames: { '#st': 'status', '#ix': 'index' },
        ExpressionAttributeValues: { ':st': status, ':ix': index },
      }),
    );
  } catch (err) {
    console.error(
      `setImageStatus(${slug}, ${index}, ${status}) failed; leaving it as-is`,
      err,
    );
  }
}
