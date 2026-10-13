import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import {
  MAX_MARKDOWN_BYTES,
  getFailedMarkdown,
  reReviewExecutionName,
  reReviewFailed,
  saveFailedMarkdown,
} from '../../../lambda/api/failed-edit';

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);
const sfnMock = mockClient(SFNClient);

function event(slug: string | undefined, body?: unknown): APIGatewayProxyEvent {
  return {
    pathParameters: slug === undefined ? null : { slug },
    body:
      body === undefined
        ? null
        : typeof body === 'string'
          ? body
          : JSON.stringify(body),
    headers: {},
  } as unknown as APIGatewayProxyEvent;
}

function draftBody(text: string) {
  return { Body: { transformToString: async () => text } as never };
}

function named(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

/** Drafts that exist in S3, by iteration. Anything else HEADs as NotFound. */
function withDrafts(slug: string, drafts: Record<number, string>) {
  s3Mock.on(HeadObjectCommand).rejects(named('NotFound'));
  s3Mock.on(GetObjectCommand).rejects(named('NoSuchKey'));
  for (const [n, text] of Object.entries(drafts)) {
    const Key = `${slug}/iteration-${n}/draft.md`;
    s3Mock.on(HeadObjectCommand, { Key }).resolves({});
    s3Mock.on(GetObjectCommand, { Key }).resolves(draftBody(text));
  }
}

const failedPost = {
  slug: 'p',
  status: 'failed',
  reviewIteration: 4,
  reviewOutcome: 'capped',
  reviewedAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
};

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  sfnMock.reset();
  process.env.POSTS_TABLE_NAME = 'posts';
  process.env.DRAFTS_BUCKET = 'drafts';
  process.env.REVIEW_STATE_MACHINE_ARN = 'arn:aws:states:::sm/review';
  s3Mock.on(PutObjectCommand).resolves({});
  ddbMock.on(UpdateCommand).resolves({});
  sfnMock.on(StartExecutionCommand).resolves({});
});

describe('reReviewExecutionName', () => {
  test('is deterministic for an ordinary slug', () => {
    expect(reReviewExecutionName('my-post', 5)).toBe('rereview-my-post-5');
  });

  test('stays within 80 valid characters for long or odd slugs', () => {
    const long = `${'a'.repeat(100)}.md`;
    const name = reReviewExecutionName(long, 12);
    expect(name.length).toBeLessThanOrEqual(80);
    expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(name).toBe(reReviewExecutionName(long, 12));
    expect(reReviewExecutionName('a b', 1)).not.toBe(
      reReviewExecutionName('a-b', 1),
    );
  });
});

describe('getFailedMarkdown', () => {
  test('400 when slug is missing', async () => {
    expect((await getFailedMarkdown(event(undefined))).statusCode).toBe(400);
  });

  test('404 when the post does not exist', async () => {
    ddbMock.on(GetCommand).resolves({});
    expect((await getFailedMarkdown(event('p'))).statusCode).toBe(404);
  });

  test.each(['staged', 'reviewing', 'approved', 'queued'])(
    '409 for a %s post',
    async (status) => {
      ddbMock.on(GetCommand).resolves({ Item: { ...failedPost, status } });
      expect((await getFailedMarkdown(event('p'))).statusCode).toBe(409);
    },
  );

  test('returns the latest draft, probing past a lagging counter', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...failedPost, reviewIteration: 3 } });
    withDrafts('p', { 1: 'one', 2: 'two', 3: 'three', 4: 'four' });

    const res = await getFailedMarkdown(event('p'));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      slug: 'p',
      iteration: 4,
      markdown: 'four',
      pendingEdit: false,
    });
  });

  test('flags a saved, unreviewed edit', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { ...failedPost, latestIteration: 5, pendingEditIteration: 5 },
    });
    withDrafts('p', { 4: 'four', 5: 'edited' });

    const body = JSON.parse((await getFailedMarkdown(event('p'))).body);
    expect(body).toMatchObject({ iteration: 5, markdown: 'edited', pendingEdit: true });
  });
});

describe('saveFailedMarkdown', () => {
  test('400 on malformed JSON', async () => {
    expect((await saveFailedMarkdown(event('p', '{nope'))).statusCode).toBe(400);
  });

  test('400 when markdown is missing or blank', async () => {
    expect((await saveFailedMarkdown(event('p', {}))).statusCode).toBe(400);
    expect(
      (await saveFailedMarkdown(event('p', { markdown: '  \n' }))).statusCode,
    ).toBe(400);
  });

  test('400 when markdown is too large', async () => {
    const markdown = 'x'.repeat(MAX_MARKDOWN_BYTES + 1);
    expect((await saveFailedMarkdown(event('p', { markdown }))).statusCode).toBe(400);
  });

  test('404 when the post does not exist', async () => {
    ddbMock.on(GetCommand).resolves({});
    expect(
      (await saveFailedMarkdown(event('p', { markdown: '# x' }))).statusCode,
    ).toBe(404);
  });

  test('409 when the post is not failed', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...failedPost, status: 'staged' } });
    const res = await saveFailedMarkdown(event('p', { markdown: '# x' }));
    expect(res.statusCode).toBe(409);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  test('first save writes the next iteration and marks it pending', async () => {
    ddbMock.on(GetCommand).resolves({ Item: failedPost });
    withDrafts('p', { 4: 'four' });

    const res = await saveFailedMarkdown(event('p', { markdown: '# fixed' }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      slug: 'p',
      iteration: 5,
      status: 'failed',
      pendingEdit: true,
    });
    const put = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input;
    expect(put).toMatchObject({ Key: 'p/iteration-5/draft.md', Body: '# fixed' });

    const upd = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(upd.ConditionExpression).toBe('#st = :failed');
    expect(upd.UpdateExpression).toContain('pendingEditIteration = :it');
    expect(upd.UpdateExpression).toContain('editedIterations');
    expect(upd.ExpressionAttributeValues).toMatchObject({ ':it': 5, ':ed': [5] });
    // Saving does not move the post out of failed.
    expect(upd.UpdateExpression).not.toContain('#st =');
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  test('later saves overwrite the same pending iteration', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { ...failedPost, latestIteration: 5, pendingEditIteration: 5 },
    });

    const res = await saveFailedMarkdown(event('p', { markdown: '# again' }));

    expect(JSON.parse(res.body).iteration).toBe(5);
    expect(s3Mock.commandCalls(PutObjectCommand)[0].args[0].input.Key).toBe(
      'p/iteration-5/draft.md',
    );
    const upd = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(upd.UpdateExpression).not.toContain('editedIterations');
  });

  test('409 if the post leaves failed mid-save', async () => {
    ddbMock.on(GetCommand).resolves({ Item: failedPost });
    ddbMock.on(UpdateCommand).rejects(named('ConditionalCheckFailedException'));
    withDrafts('p', { 4: 'four' });

    const res = await saveFailedMarkdown(event('p', { markdown: '# x' }));
    expect(res.statusCode).toBe(409);
  });

  test('rethrows other DynamoDB errors', async () => {
    ddbMock.on(GetCommand).resolves({ Item: failedPost });
    ddbMock.on(UpdateCommand).rejects(new Error('throttled'));
    withDrafts('p', { 4: 'four' });

    await expect(
      saveFailedMarkdown(event('p', { markdown: '# x' })),
    ).rejects.toThrow('throttled');
  });
});

describe('reReviewFailed', () => {
  test('400 when slug is missing', async () => {
    expect((await reReviewFailed(event(undefined, {}))).statusCode).toBe(400);
  });

  test('400 on malformed JSON or a non-object body', async () => {
    expect((await reReviewFailed(event('p', '{nope'))).statusCode).toBe(400);
    expect((await reReviewFailed(event('p', '"text"'))).statusCode).toBe(400);
  });

  test('400 when markdown is supplied but blank', async () => {
    expect(
      (await reReviewFailed(event('p', { markdown: '' }))).statusCode,
    ).toBe(400);
  });

  test('404 when the post does not exist', async () => {
    ddbMock.on(GetCommand).resolves({});
    expect((await reReviewFailed(event('p', {}))).statusCode).toBe(404);
  });

  test('409 when the post is staged', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...failedPost, status: 'staged' } });
    const res = await reReviewFailed(event('p', {}));
    expect(res.statusCode).toBe(409);
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  test('saves the submitted Markdown and restarts review from it', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { ...failedPost, reviewOutcome: 'exception', reviewError: 'boom' },
    });
    withDrafts('p', { 4: 'four' });

    const res = await reReviewFailed(event('p', { markdown: '# better' }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      slug: 'p',
      iteration: 5,
      status: 'reviewing',
      alreadyStarted: false,
    });

    const put = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input;
    expect(put).toMatchObject({ Key: 'p/iteration-5/draft.md', Body: '# better' });

    const upd = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(upd.ConditionExpression).toBe('#st = :failed');
    expect(upd.UpdateExpression).toContain('#st = :reviewing');
    expect(upd.UpdateExpression).toContain(
      'REMOVE reviewOutcome, reviewError, rejectedAt, pendingEditIteration',
    );
    expect(upd.UpdateExpression).toContain('editedIterations');
    const values = upd.ExpressionAttributeValues as Record<string, unknown>;
    expect(values[':history']).toEqual([
      {
        reviewOutcome: 'exception',
        reviewError: 'boom',
        iteration: 4,
        failedAt: '2026-10-01T00:00:00Z',
        clearedAt: expect.any(String),
        reReviewIteration: 5,
      },
    ]);

    const start = sfnMock.commandCalls(StartExecutionCommand)[0].args[0].input;
    expect(start.name).toBe('rereview-p-5');
    expect(JSON.parse(start.input as string)).toEqual({
      slug: 'p',
      startIteration: 5,
    });
  });

  test('re-reviews a saved edit without rewriting it', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { ...failedPost, latestIteration: 5, pendingEditIteration: 5 },
    });
    withDrafts('p', { 4: 'four', 5: 'saved edit' });

    const res = await reReviewFailed(event('p', {}));

    expect(JSON.parse(res.body).iteration).toBe(5);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    const upd = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    // Already recorded as edited by the save.
    expect(upd.UpdateExpression).not.toContain('editedIterations');
  });

  test('without an edit, carries the latest draft forward to a fresh iteration', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        slug: 'p',
        status: 'failed',
        reviewIteration: 2,
        rejectedAt: '2026-10-02T00:00:00Z',
      },
    });
    withDrafts('p', { 1: 'one', 2: 'two' });

    const res = await reReviewFailed(event('p', {}));

    expect(JSON.parse(res.body).iteration).toBe(3);
    const put = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input;
    expect(put).toMatchObject({ Key: 'p/iteration-3/draft.md', Body: 'two' });
    const upd = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(upd.UpdateExpression).not.toContain('editedIterations');
    const values = upd.ExpressionAttributeValues as Record<string, unknown>;
    expect(values[':history']).toEqual([
      expect.objectContaining({
        reviewOutcome: 'rejected',
        failedAt: '2026-10-02T00:00:00Z',
      }),
    ]);
    expect(
      (values[':history'] as Record<string, unknown>[])[0],
    ).not.toHaveProperty('reviewError');
  });

  test('a retry after the re-review started is a no-op 200', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        slug: 'p',
        status: 'reviewing',
        latestIteration: 5,
        reReviewIteration: 5,
      },
    });
    withDrafts('p', { 5: '# better' });
    sfnMock.on(StartExecutionCommand).rejects(named('ExecutionAlreadyExists'));

    const res = await reReviewFailed(event('p', { markdown: '# better' }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      iteration: 5,
      status: 'reviewing',
      alreadyStarted: true,
    });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    // Same name, so Step Functions de-duplicates it.
    expect(
      sfnMock.commandCalls(StartExecutionCommand)[0].args[0].input.name,
    ).toBe('rereview-p-5');
  });

  test('a retry with different Markdown is a 409', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { slug: 'p', status: 'reviewing', latestIteration: 5, reReviewIteration: 5 },
    });
    withDrafts('p', { 5: '# better' });

    const res = await reReviewFailed(event('p', { markdown: '# different' }));

    expect(res.statusCode).toBe(409);
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  test('a review started some other way is not mistaken for a retry', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { slug: 'p', status: 'reviewing', latestIteration: 7, reReviewIteration: 5 },
    });
    expect((await reReviewFailed(event('p', {}))).statusCode).toBe(409);
  });

  test('losing a double-click race replays the winner', async () => {
    ddbMock
      .on(GetCommand)
      .resolvesOnce({ Item: failedPost })
      .resolves({
        Item: { slug: 'p', status: 'reviewing', latestIteration: 5, reReviewIteration: 5 },
      });
    ddbMock.on(UpdateCommand).rejects(named('ConditionalCheckFailedException'));
    withDrafts('p', { 4: 'four' });

    const res = await reReviewFailed(event('p', {}));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).alreadyStarted).toBe(true);
  });

  test('409 when the post moved elsewhere during the race', async () => {
    ddbMock
      .on(GetCommand)
      .resolvesOnce({ Item: failedPost })
      .resolves({ Item: { slug: 'p', status: 'staged' } });
    ddbMock.on(UpdateCommand).rejects(named('ConditionalCheckFailedException'));
    withDrafts('p', { 4: 'four' });

    expect((await reReviewFailed(event('p', {}))).statusCode).toBe(409);
  });

  test('rethrows unexpected errors', async () => {
    ddbMock.on(GetCommand).resolves({ Item: failedPost });
    withDrafts('p', { 4: 'four' });
    sfnMock.on(StartExecutionCommand).rejects(new Error('sfn down'));
    await expect(reReviewFailed(event('p', {}))).rejects.toThrow('sfn down');

    ddbMock.on(UpdateCommand).rejects(new Error('ddb down'));
    await expect(reReviewFailed(event('p', {}))).rejects.toThrow('ddb down');
  });
});
