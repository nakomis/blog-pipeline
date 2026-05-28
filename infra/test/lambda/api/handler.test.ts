import type { APIGatewayProxyEvent } from 'aws-lambda';

jest.mock('../../../lambda/api/list-posts', () => ({
  listPosts: jest.fn().mockResolvedValue({ statusCode: 200, body: 'posts' }),
}));
jest.mock('../../../lambda/api/image-callback', () => ({
  imageCallback: jest.fn().mockResolvedValue({ statusCode: 200, body: 'cb' }),
}));

import { handler } from '../../../lambda/api/handler';
import { listPosts } from '../../../lambda/api/list-posts';
import { imageCallback } from '../../../lambda/api/image-callback';

const mockList = listPosts as jest.Mock;
const mockCallback = imageCallback as jest.Mock;

function event(method: string, resource: string): APIGatewayProxyEvent {
  return { httpMethod: method, resource } as unknown as APIGatewayProxyEvent;
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

test('returns 404 for an unknown route', async () => {
  const res = await handler(event('DELETE', '/posts'));
  expect(res.statusCode).toBe(404);
  expect(mockList).not.toHaveBeenCalled();
  expect(mockCallback).not.toHaveBeenCalled();
});
