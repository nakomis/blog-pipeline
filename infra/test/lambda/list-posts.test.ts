import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { listPosts } from '../../lambda/api/list-posts';

const ddbMock = mockClient(DynamoDBDocumentClient);

/** Minimal REST API proxy event — only the fields the handler reads. */
function event(status?: string, origin?: string): APIGatewayProxyEvent {
  return {
    queryStringParameters: status === undefined ? null : { status },
    headers: origin === undefined ? {} : { Origin: origin },
  } as unknown as APIGatewayProxyEvent;
}

const samplePosts = [
  { slug: 'older', status: 'queued', title: 'Older', updatedAt: '2026-05-01T00:00:00Z' },
  { slug: 'newer', status: 'queued', title: 'Newer', updatedAt: '2026-05-20T00:00:00Z' },
];

describe('list-posts handler', () => {
  beforeEach(() => {
    ddbMock.reset();
    process.env.POSTS_TABLE_NAME = 'blog-pipeline-posts-test';
    delete process.env.ALLOWED_ORIGINS;
  });

  test('returns 500 when the table name is not configured', async () => {
    delete process.env.POSTS_TABLE_NAME;
    const result = await listPosts(event());
    expect(result).toMatchObject({ statusCode: 500 });
  });

  test('scans the table and returns posts newest first', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: samplePosts });

    const result = await listPosts(event());

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body);
    expect(body.posts.map((p: { slug: string }) => p.slug)).toEqual([
      'newer',
      'older',
    ]);
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(1);
  });

  test('returns an empty list when the table is empty', async () => {
    ddbMock.on(ScanCommand).resolves({});
    const result = await listPosts(event());
    const body = JSON.parse((result as { body: string }).body);
    expect(body.posts).toEqual([]);
  });

  test('queries the by-status GSI for a valid status', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [samplePosts[0]] });

    const result = await listPosts(event('reviewing'));

    expect(result).toMatchObject({ statusCode: 200 });
    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input).toMatchObject({
      IndexName: 'by-status',
      ExpressionAttributeValues: { ':status': 'reviewing' },
      ScanIndexForward: false,
    });
  });

  test('rejects an unknown status with 400', async () => {
    const result = await listPosts(event('not-a-stage'));
    expect(result).toMatchObject({ statusCode: 400 });
    const body = JSON.parse((result as { body: string }).body);
    expect(body.message).toMatch(/Unknown status/);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  test('echoes an allowlisted Origin in the CORS header, rejects others', async () => {
    process.env.ALLOWED_ORIGINS =
      'https://pipeline.blog.sandbox.nakomis.com,http://localhost:5173';
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    const allowed = (await listPosts(
      event(undefined, 'http://localhost:5173'),
    )) as { headers: Record<string, string> };
    expect(allowed.headers['access-control-allow-origin']).toBe(
      'http://localhost:5173',
    );

    const blocked = (await listPosts(
      event(undefined, 'https://evil.example.com'),
    )) as { headers: Record<string, string> };
    expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
  });
});
