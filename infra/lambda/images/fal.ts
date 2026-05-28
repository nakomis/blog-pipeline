import { IMAGE } from '../../lib/config';

/**
 * fal.ai queue submission (PIPE-6).
 *
 * The queue endpoint returns instantly with a `request_id` and holds nothing
 * open — fal generates the image server-side and POSTs the result to the
 * `fal_webhook` URL when it is ready. That keeps the review loop unblocked and
 * means the API key never leaves the submit Lambda.
 *
 * Mirrors the proven `falai_batch.py` POC: model/dimensions come from
 * `IMAGE` in config; the negative prompt is deliberately *not* sent —
 * flux-2-pro's reference API does not accept one (it is parsed and stored on the
 * job row for a possible future regenerate path).
 */

interface FalQueueResponse {
  request_id?: string;
}

export interface SubmitImageInput {
  prompt: string;
  /** The webhook fal calls back when the image is ready. */
  callbackUrl: string;
  /** fal API key — read from SSM by the caller. */
  falKey: string;
}

/** Submit one generation job; resolves to fal's `request_id`. */
export async function submitImage(input: SubmitImageInput): Promise<string> {
  const url = `https://queue.fal.run/${IMAGE.model}?fal_webhook=${encodeURIComponent(input.callbackUrl)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Key ${input.falKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      prompt: input.prompt,
      image_size: { width: IMAGE.width, height: IMAGE.height },
      output_format: 'png',
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`fal submit failed (${res.status}): ${detail}`);
  }

  const body = (await res.json()) as FalQueueResponse;
  if (!body.request_id) {
    throw new Error('fal submit response carried no request_id');
  }
  return body.request_id;
}
