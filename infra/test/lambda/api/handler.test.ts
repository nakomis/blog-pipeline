import type { APIGatewayProxyEvent } from 'aws-lambda';

jest.mock('../../../lambda/api/list-posts', () => ({
  listPosts: jest.fn().mockResolvedValue({ statusCode: 200, body: 'posts' }),
}));
jest.mock('../../../lambda/api/image-callback', () => ({
  imageCallback: jest.fn().mockResolvedValue({ statusCode: 200, body: 'cb' }),
}));
jest.mock('../../../lambda/api/post-detail', () => ({
  postDetail: jest.fn().mockResolvedValue({ statusCode: 200, body: 'detail' }),
}));
jest.mock('../../../lambda/api/post-actions', () => ({
  postEdit: jest.fn().mockResolvedValue({ statusCode: 200, body: 'edit' }),
  postDecision: jest.fn().mockResolvedValue({ statusCode: 200, body: 'decision' }),
}));
jest.mock('../../../lambda/api/publish-now', () => ({
  publishNow: jest.fn().mockResolvedValue({ statusCode: 202, body: 'published' }),
}));

import { handler } from '../../../lambda/api/handler';
import { listPosts } from '../../../lambda/api/list-posts';
import { imageCallback } from '../../../lambda/api/image-callback';
import { postDetail } from '../../../lambda/api/post-detail';
import { postEdit, postDecision } from '../../../lambda/api/post-actions';
import { publishNow } from '../../../lambda/api/publish-now';

const mockList = listPosts as jest.Mock;
const mockCallback = imageCallback as jest.Mock;
const mockDetail = postDetail as jest.Mock;
const mockEdit = postEdit as jest.Mock;
const mockDecision = postDecision as jest.Mock;
const mockPublishNow = publishNow as jest.Mock;

function event(
  method: string,
  resource: string,
  headers: Record<string, string> = {},
): APIGatewayProxyEvent {
  return { httpMethod: method, resource, headers } as unknown as APIGatewayProxyEvent;
}

beforeEach(() => jest.clearAllMocks());

test('routes GET /posts to listPosts', async () => {
  const res = await handler(event('GET', '/posts'));
  expect(res.statusCode).toBe(200);
  expect(mockList).toHaveBeenCalled();
  expect(mockCallback).not.toHaveBeenCalled();
});

test('routes POST /image-callback to imageCallback', async () => {
  await handler(event('POST', '/image-callback'));
  expect(mockCallback).toHaveBeenCalled();
  expect(mockList).not.toHaveBeenCalled();
});

test('routes GET /posts/{slug} to postDetail', async () => {
  await handler(event('GET', '/posts/{slug}'));
  expect(mockDetail).toHaveBeenCalled();
  expect(mockList).not.toHaveBeenCalled();
});

test('routes POST /posts/{slug}/edit to postEdit', async () => {
  await handler(event('POST', '/posts/{slug}/edit'));
  expect(mockEdit).toHaveBeenCalled();
  expect(mockDecision).not.toHaveBeenCalled();
});

test('routes POST /posts/{slug}/decision to postDecision', async () => {
  await handler(event('POST', '/posts/{slug}/decision'));
  expect(mockDecision).toHaveBeenCalled();
  expect(mockEdit).not.toHaveBeenCalled();
});

test('routes POST /publish-now to publishNow', async () => {
  const res = await handler(event('POST', '/publish-now'));
  expect(res.statusCode).toBe(202);
  expect(mockPublishNow).toHaveBeenCalled();
  expect(mockDecision).not.toHaveBeenCalled();
});

test('returns 404 for an unknown route', async () => {
  const res = await handler(event('DELETE', '/posts'));
  expect(res.statusCode).toBe(404);
  expect(mockList).not.toHaveBeenCalled();
  expect(mockCallback).not.toHaveBeenCalled();
});

test('a thrown route error becomes a 500 carrying CORS headers', async () => {
  process.env.ALLOWED_ORIGINS = 'https://app.example';
  mockDetail.mockRejectedValueOnce(new Error('boom'));
  const res = await handler(
    event('GET', '/posts/{slug}', { Origin: 'https://app.example' }),
  );
  expect(res.statusCode).toBe(500);
  expect(res.headers?.['access-control-allow-origin']).toBe('https://app.example');
  expect(JSON.parse(res.body)).toEqual({ message: 'boom' });
  delete process.env.ALLOWED_ORIGINS;
});
