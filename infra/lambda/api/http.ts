import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from 'aws-lambda';

/**
 * Shared HTTP helpers for the dashboard API router modules.
 *
 * The API sits on a different subdomain from the SPA, so browser requests are
 * cross-origin: the REST API answers the OPTIONS preflight itself, and each
 * response echoes the request `Origin` back when it is one of the configured
 * `ALLOWED_ORIGINS`.
 */
export function corsHeaders(
  event: APIGatewayProxyEvent,
): Record<string, string> {
  const allowed = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .filter(Boolean);
  const headers = event.headers ?? {};
  const origin = headers.Origin ?? headers.origin ?? '';
  return allowed.includes(origin)
    ? { 'access-control-allow-origin': origin, vary: 'Origin' }
    : {};
}

export function jsonResponse(
  statusCode: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  };
}
