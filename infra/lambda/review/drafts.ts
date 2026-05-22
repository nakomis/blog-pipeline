import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { requireEnv } from './runtime';

/**
 * The S3 drafts store.
 *
 * One object per draft and per iteration's reviews, under a per-post prefix:
 *   {slug}/iteration-{n}/draft.md
 *   {slug}/iteration-{n}/reviews.json
 *
 * Iteration 1 is the submitted draft (PIPE-2 writes it; the seed script stands
 * in until then); each redraft writes the next iteration.
 */

const s3 = new S3Client({});

/** S3 key for a draft at a given iteration. */
export function draftKey(slug: string, iteration: number): string {
  return `${slug}/iteration-${iteration}/draft.md`;
}

/** S3 key for an iteration's persisted reviewer results. */
export function reviewsKey(slug: string, iteration: number): string {
  return `${slug}/iteration-${iteration}/reviews.json`;
}

function bucket(): string {
  return requireEnv('DRAFTS_BUCKET');
}

/** Read a draft's Markdown body. */
export async function getDraft(key: string): Promise<string> {
  const res = await s3.send(
    new GetObjectCommand({ Bucket: bucket(), Key: key }),
  );
  if (!res.Body) {
    throw new Error(`Draft object ${key} has no body`);
  }
  return res.Body.transformToString();
}

/** Write a draft's Markdown body. */
export async function putDraft(key: string, markdown: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: markdown,
      ContentType: 'text/markdown',
    }),
  );
}

/** Persist an iteration's reviewer results as pretty-printed JSON. */
export async function putReviews(key: string, reviews: unknown): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: JSON.stringify(reviews, null, 2),
      ContentType: 'application/json',
    }),
  );
}

/** True if a draft object exists — used to validate the state machine's input. */
export async function draftExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return true;
  } catch (err) {
    if (err instanceof Error && err.name === 'NotFound') {
      return false;
    }
    throw err;
  }
}
