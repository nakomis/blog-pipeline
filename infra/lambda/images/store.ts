import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { requireEnv } from '../review/runtime';
import { imageKey } from './placeholders';

/**
 * Generated-image storage (PIPE-6).
 *
 * Images live alongside their post's drafts in the same drafts bucket, under
 * `{slug}/images/{slug}-{n}.png`. The submit step checks existence (idempotency
 * — never regenerate an image that is already there); the callback downloads
 * fal's result and writes it.
 */

const s3 = new S3Client({});

function bucket(): string {
  return requireEnv('DRAFTS_BUCKET');
}

/** True once an image's PNG has been written. */
export async function imageExists(
  slug: string,
  index: number,
): Promise<boolean> {
  try {
    await s3.send(
      new HeadObjectCommand({ Bucket: bucket(), Key: imageKey(slug, index) }),
    );
    return true;
  } catch (err) {
    if (err instanceof Error && err.name === 'NotFound') {
      return false;
    }
    throw err;
  }
}

/** Store a generated PNG. */
export async function putImage(
  slug: string,
  index: number,
  body: Uint8Array,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: imageKey(slug, index),
      Body: body,
      ContentType: 'image/png',
    }),
  );
}

/** Download a generated image from the URL fal handed back. */
export async function downloadImage(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`image download failed (${res.status}) for ${url}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}
