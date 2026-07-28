import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from 'aws-lambda';
import { imageCallback } from './image-callback';
import { listPosts } from './list-posts';
import { postDetail } from './post-detail';
import { postEdit, postDecision } from './post-actions';
import { publishNow } from './publish-now';
import { corsHeaders, jsonResponse } from './http';

/**
 * The dashboard API Lambda — a small router fronting the dashboard routes:
 *  - `GET  /posts`                  — list posts (Cognito + API key);
 *  - `GET  /posts/{slug}`           — the detail bundle for the bag (PIPE-4);
 *  - `POST /posts/{slug}/edit`      — edit a staged draft, optionally re-review;
 *  - `POST /posts/{slug}/decision`  — approve or reject a staged post;
 *  - `POST /publish-now`            — publish approved, due posts on demand (PIPE-14);
 *  - `POST /image-callback`         — fal.ai's image webhook (public, signed).
 *
 * One Lambda serves them all so the function stays warm and there is no second
 * cold start; the routes share nothing but this dispatch.
 */
export async function handler(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const method = event.httpMethod;
  const resource = event.resource ?? event.path;
  const cors = corsHeaders(event);

  try {
    if (method === 'GET' && resource === '/posts') {
      return await listPosts(event);
    }
    if (method === 'GET' && resource === '/posts/{slug}') {
      return await postDetail(event);
    }
    if (method === 'POST' && resource === '/posts/{slug}/edit') {
      return await postEdit(event);
    }
    if (method === 'POST' && resource === '/posts/{slug}/decision') {
      return await postDecision(event);
    }
    if (method === 'POST' && resource === '/publish-now') {
      return await publishNow(event);
    }
    if (method === 'POST' && resource === '/image-callback') {
      return await imageCallback(event);
    }
    return jsonResponse(404, { message: `No route for ${method} ${resource}` }, cors);
  } catch (err) {
    // Without this, an unhandled throw yields a bare API Gateway 500 with no
    // CORS headers — the browser then reports an opaque "Failed to fetch"
    // rather than the real status, so always answer with CORS attached.
    console.error(`Unhandled error in ${method} ${resource}`, err);
    const message = err instanceof Error ? err.message : 'Internal error';
    return jsonResponse(500, { message }, cors);
  }
}
