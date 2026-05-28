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

import { handler } from '../../../lambda/api/handler';
import { listPosts } from '../../../lambda/api/list-posts';
import { imageCallback } from '../../../lambda/api/image-callback';
import { postDetail } from '../../../lambda/api/post-detail';
import { postEdit, postDecision } from '../../../lambda/api/post-actions';

const mockList = listPosts as jest.Mock;
const mockCallback = imageCallback as jest.Mock;
const mockDetail = postDetail as jest.Mock;
const mockEdit = postEdit as jest.Mock;
const mockDecision = postDecision as jest.Mock;

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

test('returns 404 for an unknown route', async () => {
  const res = await handler(event('DELETE', '/posts'));
  expect(res.statusCode).toBe(404);
  expect(mockList).not.toHaveBeenCalled();
  expect(mockCallback).not.toHaveBeenCalled();
});
