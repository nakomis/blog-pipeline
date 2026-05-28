import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from 'aws-lambda';
import { imageKey } from '../images/placeholders';
import { draftExists, draftKey, getDraft, reviewsKey } from '../review/drafts';
import { requireEnv } from '../review/runtime';
import { corsHeaders, jsonResponse } from './http';

/**
 * `GET /posts/{slug}` — the detail bundle for the bag (PIPE-4).
 *
 * Assembles everything the approval UI needs in one call:
 *  - the post item;
 *  - the final article (the latest draft iteration) and the original (iter 1),
 *    for the diff;
 *  - each iteration's reviewer critiques + gate decision (from `reviews.json`);
 *  - the generated images, with a presigned GET URL for the ready ones (the
 *    drafts bucket is private, so the SPA can't read it directly).
 *
 * Image readiness comes from the post item's `images[].status`, kept current by
 * the fal callback (PIPE-6, fixed in this story).
 */

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

/** Presigned image URLs live just long enough for the page to load them. */
const PRESIGN_TTL_SECONDS = 900;

interface PostImageEntry {
  index: number;
  prompt: string;
  status?: 'pending' | 'ready' | 'failed';
}

async function presignImage(slug: string, index: number): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: requireEnv('DRAFTS_BUCKET'),
      Key: imageKey(slug, index),
    }),
    { expiresIn: PRESIGN_TTL_SECONDS },
  );
}

export async function postDetail(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const cors = corsHeaders(event);
  const slug = event.pathParameters?.slug;
  if (!slug) {
    return jsonResponse(400, { message: 'Missing slug' }, cors);
  }

  const tableName = requireEnv('POSTS_TABLE_NAME');
  const { Item } = await docClient.send(
    new GetCommand({ TableName: tableName, Key: { slug } }),
  );
  if (!Item) {
    return jsonResponse(404, { message: `No post '${slug}'` }, cors);
  }

  const latestIteration = Number(
    Item.latestIteration ?? Item.reviewIteration ?? 1,
  );

  const finalMarkdown = await getDraft(draftKey(slug, latestIteration));
  const originalMarkdown =
    latestIteration === 1
      ? finalMarkdown
      : await getDraft(draftKey(slug, 1));

  const editedIterations: number[] = Array.isArray(Item.editedIterations)
    ? (Item.editedIterations as number[])
    : [];

  const iterations: unknown[] = [];
  for (let n = 1; n <= latestIteration; n += 1) {
    const key = reviewsKey(slug, n);
    if (await draftExists(key)) {
      const parsed = JSON.parse(await getDraft(key)) as {
        reviews?: unknown[];
        gate?: unknown;
      };
      iterations.push({
        iteration: n,
        reviews: parsed.reviews ?? [],
        gate: parsed.gate ?? null,
        edited: editedIterations.includes(n),
      });
    }
  }

  const imageEntries = Array.isArray(Item.images)
    ? (Item.images as PostImageEntry[])
    : [];
  const images = await Promise.all(
    imageEntries.map(async (img) => ({
      index: img.index,
      prompt: img.prompt,
      status: img.status ?? 'pending',
      url:
        img.status === 'ready'
          ? await presignImage(slug, img.index)
          : undefined,
    })),
  );

  return jsonResponse(
    200,
    { post: Item, finalMarkdown, originalMarkdown, iterations, images },
    cors,
  );
}
