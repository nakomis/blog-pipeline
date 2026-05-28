import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from 'aws-lambda';
import { imageCallback } from './image-callback';
import { listPosts } from './list-posts';
import { postDetail } from './post-detail';
import { postEdit, postDecision } from './post-actions';

/**
 * The dashboard API Lambda — a small router fronting the dashboard routes:
 *  - `GET  /posts`                  — list posts (Cognito + API key);
 *  - `GET  /posts/{slug}`           — the detail bundle for the bag (PIPE-4);
 *  - `POST /posts/{slug}/edit`      — edit a staged draft, optionally re-review;
 *  - `POST /posts/{slug}/decision`  — approve or reject a staged post;
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

  if (method === 'GET' && resource === '/posts') {
    return listPosts(event);
  }
  if (method === 'GET' && resource === '/posts/{slug}') {
    return postDetail(event);
  }
  if (method === 'POST' && resource === '/posts/{slug}/edit') {
    return postEdit(event);
  }
  if (method === 'POST' && resource === '/posts/{slug}/decision') {
    return postDecision(event);
  }
  if (method === 'POST' && resource === '/image-callback') {
    return imageCallback(event);
  }

  return {
    statusCode: 404,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: `No route for ${method} ${resource}` }),
  };
}
