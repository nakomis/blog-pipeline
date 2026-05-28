import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from 'aws-lambda';
import { getJob, markJobDone, markJobFailed } from '../images/jobs';
import { applyPlaceholders, defaultApplyDeps } from '../images/placeholders';
import { downloadImage, putImage } from '../images/store';
import {
  extractFalHeaders,
  fetchFalJwks,
  verifyFalSignature,
} from '../images/verify';

/**
 * fal.ai image webhook (PIPE-6) — `POST /image-callback`.
 *
 * A public, unauthenticated route (an API Gateway authorizer can't see the body,
 * so it can't verify fal's signature). Trust comes solely from the ED25519
 * signature, verified here on the raw bytes — a bad signature is a hard `401`.
 *
 * On a genuine `OK` callback: download the image, store it, mark the job done
 * and rewrite the post's `{{image}}` placeholder. `applyPlaceholders` is a no-op
 * while the post is still under review, so a fast image that beats the reviewers
 * is simply picked up later by the terminal step — and vice versa.
 */

interface FalCallbackBody {
  request_id?: string;
  status?: string;
  images?: { url?: string }[];
  payload?: { images?: { url?: string }[] };
}

function text(statusCode: number, message: string): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  };
}

function firstImageUrl(body: FalCallbackBody): string | undefined {
  return body.payload?.images?.[0]?.url ?? body.images?.[0]?.url;
}

export async function imageCallback(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const rawBody = Buffer.from(
    event.body ?? '',
    event.isBase64Encoded ? 'base64' : 'utf8',
  );

  const jwks = await fetchFalJwks();
  const verified = verifyFalSignature({
    headers: extractFalHeaders(event.headers ?? {}),
    rawBody,
    jwks,
  });
  if (!verified) {
    return text(401, 'Invalid fal webhook signature');
  }

  let body: FalCallbackBody;
  try {
    body = JSON.parse(rawBody.toString('utf8')) as FalCallbackBody;
  } catch {
    return text(400, 'Malformed JSON body');
  }

  const { request_id: requestId, status } = body;
  if (!requestId) {
    return text(400, 'Missing request_id');
  }

  const job = await getJob(requestId);
  if (!job) {
    // Unknown (or TTL-reaped) job — nothing to do, but a genuine fal callback,
    // so acknowledge it so fal does not retry.
    return text(200, 'No job for request_id; ignoring');
  }

  if (status && status !== 'OK') {
    // fal failed this image. Mark it; the post still reaches the bag with the
    // images that did succeed (graceful degradation).
    await markJobFailed(requestId);
    return text(200, 'Job marked failed');
  }

  const url = firstImageUrl(body);
  if (!url) {
    await markJobFailed(requestId);
    return text(200, 'Callback carried no image URL; job marked failed');
  }

  const bytes = await downloadImage(url);
  await putImage(job.slug, job.index, bytes);
  await markJobDone(requestId);
  await applyPlaceholders(job.slug, defaultApplyDeps());

  return text(200, 'Image stored');
}
