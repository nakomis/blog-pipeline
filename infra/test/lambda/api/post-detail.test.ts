import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import type { APIGatewayProxyEvent } from 'aws-lambda';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(async (_client, command: { input: { Key: string } }) =>
    `https://signed.example/${command.input.Key}`,
  ),
}));

import { postDetail } from '../../../lambda/api/post-detail';

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

function event(slug: string | undefined): APIGatewayProxyEvent {
  return {
    pathParameters: slug === undefined ? null : { slug },
    headers: {},
  } as unknown as APIGatewayProxyEvent;
}

function draftBody(text: string) {
  return { Body: { transformToString: async () => text } as never };
}

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  process.env.POSTS_TABLE_NAME = 'posts';
  process.env.DRAFTS_BUCKET = 'drafts';
});

test('400 when slug is missing', async () => {
  const res = await postDetail(event(undefined));
  expect(res.statusCode).toBe(400);
});

test('404 when the post does not exist', async () => {
  ddbMock.on(GetCommand).resolves({});
  const res = await postDetail(event('missing'));
  expect(res.statusCode).toBe(404);
});

test('assembles drafts, iterations and presigned ready images', async () => {
  ddbMock.on(GetCommand).resolves({
    Item: {
      slug: 'p',
      title: 'Post',
      status: 'staged',
      latestIteration: 2,
      editedIterations: [2],
      images: [
        { index: 1, prompt: 'a cat', status: 'ready' },
        { index: 2, prompt: 'a dog', status: 'pending' },
      ],
    },
  });

  // reviews.json exists for both iterations; drafts read for iter 2 and iter 1.
  s3Mock.on(HeadObjectCommand).resolves({});
  s3Mock
    .on(GetObjectCommand, { Key: 'p/iteration-2/draft.md' })
    .resolves(draftBody('# final'))
    .on(GetObjectCommand, { Key: 'p/iteration-1/draft.md' })
    .resolves(draftBody('# original'))
    .on(GetObjectCommand, { Key: 'p/iteration-1/reviews.json' })
    .resolves(draftBody(JSON.stringify({ reviews: [{ provider: 'a' }], gate: { decision: 'loop' } })))
    .on(GetObjectCommand, { Key: 'p/iteration-2/reviews.json' })
    .resolves(draftBody(JSON.stringify({ reviews: [], gate: { decision: 'pass' } })));

  const res = await postDetail(event('p'));

  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body);
  expect(body.finalMarkdown).toBe('# final');
  expect(body.originalMarkdown).toBe('# original');
  expect(body.iterations).toHaveLength(2);
  expect(body.iterations[1]).toMatchObject({ iteration: 2, edited: true });
  expect(body.images[0]).toMatchObject({
    index: 1,
    status: 'ready',
    url: 'https://signed.example/p/images/p-1.png',
  });
  expect(body.images[1].url).toBeUndefined();
});

test('a reviewIteration of 0 reads iteration 1, not iteration 0', async () => {
  // A post just entering review can hold reviewIteration 0; drafts are
  // 1-indexed, so the bundle must not try to read iteration-0/draft.md.
  ddbMock.on(GetCommand).resolves({
    Item: { slug: 'p', title: 'P', status: 'reviewing', reviewIteration: 0 },
  });
  s3Mock.on(HeadObjectCommand).rejects(
    Object.assign(new Error('nf'), { name: 'NotFound' }),
  );
  const getMock = s3Mock.on(GetObjectCommand).resolves(draftBody('# first'));

  const res = await postDetail(event('p'));

  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body).finalMarkdown).toBe('# first');
  for (const call of getMock.calls()) {
    const { Key } = (call.args[0] as GetObjectCommand).input;
    expect(Key).not.toContain('iteration-0');
  }
});

test('falls back to the latest iteration that has a draft', async () => {
  // reviewIteration points at 3, but only iterations 1 and 2 have drafts yet.
  ddbMock.on(GetCommand).resolves({
    Item: { slug: 'p', title: 'P', status: 'reviewing', reviewIteration: 3 },
  });
  const notFound = () => Object.assign(new Error('nf'), { name: 'NotFound' });
  s3Mock.on(HeadObjectCommand).rejects(notFound());
  s3Mock.on(HeadObjectCommand, { Key: 'p/iteration-2/draft.md' }).resolves({});
  s3Mock
    .on(GetObjectCommand, { Key: 'p/iteration-2/draft.md' })
    .resolves(draftBody('# second'))
    .on(GetObjectCommand, { Key: 'p/iteration-1/draft.md' })
    .resolves(draftBody('# first'));

  const res = await postDetail(event('p'));

  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body).finalMarkdown).toBe('# second');
});

test('original equals final on a single-iteration post', async () => {
  ddbMock.on(GetCommand).resolves({
    Item: { slug: 'p', title: 'P', status: 'staged', reviewIteration: 1 },
  });
  s3Mock.on(HeadObjectCommand).rejects(
    Object.assign(new Error('nf'), { name: 'NotFound' }),
  );
  s3Mock.on(GetObjectCommand).resolves(draftBody('# only'));

  const res = await postDetail(event('p'));
  const body = JSON.parse(res.body);
  expect(body.finalMarkdown).toBe('# only');
  expect(body.originalMarkdown).toBe('# only');
  expect(body.iterations).toEqual([]);
  expect(body.images).toEqual([]);
});
