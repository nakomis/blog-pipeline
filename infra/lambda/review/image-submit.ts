import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { submitImage } from '../images/fal';
import { putJob } from '../images/jobs';
import { imageKey, parseImagePlaceholders } from '../images/placeholders';
import { imageExists } from '../images/store';
import { draftKey, getDraft } from './drafts';
import { readParameterString, requireEnv } from './runtime';

/**
 * Image submission (PIPE-6) — async-invoked by `load-draft` at loop entry.
 *
 * Fire-and-forget, concurrent with the review loop: parse the submitted draft's
 * `{{image}}` placeholders and queue a fal.ai job for each one, so illustrations
 * are generating while the reviewers run. fal calls the `/image-callback` route
 * back when each image is ready.
 *
 * Idempotent: an image whose PNG is already in S3 is skipped, so a re-invoke
 * (e.g. a PIPE-4 re-review) never regenerates or double-charges. The post's
 * `images` list is (re)written so the dashboard can show generation progress.
 */

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export interface ImageSubmitInput {
  slug: string;
}

export interface ImageSubmitOutput {
  slug: string;
  submitted: number;
  skipped: number;
}

interface ImageEntry {
  index: number;
  prompt: string;
  status: 'pending' | 'ready';
  key: string;
}

export async function handler(
  event: ImageSubmitInput,
): Promise<ImageSubmitOutput> {
  const { slug } = event;
  const callbackUrl = requireEnv('IMAGE_CALLBACK_URL');

  const md = await getDraft(draftKey(slug, 1));
  const placeholders = parseImagePlaceholders(md, slug);
  if (placeholders.length === 0) {
    return { slug, submitted: 0, skipped: 0 };
  }

  // Only read the fal key once we know there is something to generate.
  const falKey = await readParameterString(requireEnv('FAL_PARAM_NAME'));

  const images: ImageEntry[] = [];
  let submitted = 0;
  let skipped = 0;

  for (const placeholder of placeholders) {
    const key = imageKey(slug, placeholder.index);
    if (await imageExists(slug, placeholder.index)) {
      images.push({
        index: placeholder.index,
        prompt: placeholder.prompt,
        status: 'ready',
        key,
      });
      skipped += 1;
      continue;
    }

    const requestId = await submitImage({
      prompt: placeholder.prompt,
      callbackUrl,
      falKey,
    });
    await putJob({
      requestId,
      slug,
      index: placeholder.index,
      prompt: placeholder.prompt,
      negative: placeholder.negative,
    });
    images.push({
      index: placeholder.index,
      prompt: placeholder.prompt,
      status: 'pending',
      key,
    });
    submitted += 1;
  }

  await docClient.send(
    new UpdateCommand({
      TableName: requireEnv('POSTS_TABLE_NAME'),
      Key: { slug },
      UpdateExpression: 'SET images = :images, updatedAt = :now',
      ExpressionAttributeValues: {
        ':images': images,
        ':now': new Date().toISOString(),
      },
    }),
  );

  return { slug, submitted, skipped };
}
