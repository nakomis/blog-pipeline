import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from 'aws-lambda';
import { imageCallback } from './image-callback';
import { listPosts } from './list-posts';

/**
 * The dashboard API Lambda — a small router fronting two routes:
 *  - `GET  /posts`          — list posts for the dashboard (Cognito + API key);
 *  - `POST /image-callback` — fal.ai's image webhook (public, signature-verified).
 *
 * One Lambda serves both so the function stays warm and there is no second cold
 * start; the routes share nothing but this dispatch.
 */
export async function handler(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const method = event.httpMethod;
  const resource = event.resource ?? event.path;

  if (method === 'GET' && resource === '/posts') {
    return listPosts(event);
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
