import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { handler } from '../../lambda/api/list-posts-handler';

const ddbMock = mockClient(DynamoDBDocumentClient);

/** Minimal APIGW v2 event — only the fields the handler reads. */
function event(status?: string): APIGatewayProxyEventV2 {
  return {
    queryStringParameters: status === undefined ? undefined : { status },
  } as unknown as APIGatewayProxyEventV2;
}

const samplePosts = [
  { slug: 'older', status: 'queued', title: 'Older', updatedAt: '2026-05-01T00:00:00Z' },
  { slug: 'newer', status: 'queued', title: 'Newer', updatedAt: '2026-05-20T00:00:00Z' },
];

describe('list-posts handler', () => {
  beforeEach(() => {
    ddbMock.reset();
    process.env.POSTS_TABLE_NAME = 'blog-pipeline-posts-test';
  });

  test('returns 500 when the table name is not configured', async () => {
    delete process.env.POSTS_TABLE_NAME;
    const result = await handler(event());
    expect(result).toMatchObject({ statusCode: 500 });
  });

  test('scans the table and returns posts newest first', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: samplePosts });

    const result = await handler(event());

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
    const result = await handler(event());
    const body = JSON.parse((result as { body: string }).body);
    expect(body.posts).toEqual([]);
  });

  test('queries the by-status GSI for a valid status', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [samplePosts[0]] });

    const result = await handler(event('reviewing'));

    expect(result).toMatchObject({ statusCode: 200 });
    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input).toMatchObject({
      IndexName: 'by-status',
      ExpressionAttributeValues: { ':status': 'reviewing' },
      ScanIndexForward: false,
    });
  });

  test('rejects an unknown status with 400', async () => {
    const result = await handler(event('not-a-stage'));
    expect(result).toMatchObject({ statusCode: 400 });
    const body = JSON.parse((result as { body: string }).body);
    expect(body.message).toMatch(/Unknown status/);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });
});
