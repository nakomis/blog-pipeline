import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { requireEnv } from '../review/runtime';

/**
 * The image-jobs table (PIPE-6).
 *
 * One row per fal.ai generation, keyed by the `requestId` fal returns at submit.
 * The webhook callback carries only that id, so this row is how we map it back
 * to the post (`slug`) and the placeholder (`index`) the image belongs to. Rows
 * are short-lived — a TTL on `expiresAt` reaps them a week after creation.
 */

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** Days a job row lingers before the table's TTL reaps it. */
const TTL_DAYS = 7;

export type ImageJobStatus = 'pending' | 'done' | 'failed';

export interface ImageJob {
  requestId: string;
  slug: string;
  index: number;
  prompt: string;
  /** Parsed but not sent to flux-2-pro — kept for a future regenerate path. */
  negative?: string;
  /** Model name from the tag (PIPE-27) — absent means the default was used. */
  model?: string;
  status: ImageJobStatus;
  createdAt: string;
  expiresAt: number;
}

function table(): string {
  return requireEnv('IMAGE_JOBS_TABLE_NAME');
}

/** Record a freshly submitted fal job as `pending`. */
export async function putJob(job: {
  requestId: string;
  slug: string;
  index: number;
  prompt: string;
  negative?: string;
  model?: string;
}): Promise<void> {
  const now = new Date();
  const item: ImageJob = {
    ...job,
    status: 'pending',
    createdAt: now.toISOString(),
    expiresAt: Math.floor(now.getTime() / 1000) + TTL_DAYS * 24 * 60 * 60,
  };
  await docClient.send(new PutCommand({ TableName: table(), Item: item }));
}

/** Look a job up by the fal request id — `undefined` if unknown (or reaped). */
export async function getJob(requestId: string): Promise<ImageJob | undefined> {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: table(), Key: { requestId } }),
  );
  return Item as ImageJob | undefined;
}

async function setStatus(
  requestId: string,
  status: ImageJobStatus,
): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: table(),
      Key: { requestId },
      UpdateExpression: 'SET #status = :status',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': status },
    }),
  );
}

export async function markJobDone(requestId: string): Promise<void> {
  await setStatus(requestId, 'done');
}

export async function markJobFailed(requestId: string): Promise<void> {
  await setStatus(requestId, 'failed');
}
