import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { postEdit, postDecision } from '../../../lambda/api/post-actions';

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);
const sfnMock = mockClient(SFNClient);

function event(
  slug: string | undefined,
  body: unknown,
): APIGatewayProxyEvent {
  return {
    pathParameters: slug === undefined ? null : { slug },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: {},
  } as unknown as APIGatewayProxyEvent;
}

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  sfnMock.reset();
  process.env.POSTS_TABLE_NAME = 'posts';
  process.env.DRAFTS_BUCKET = 'drafts';
  process.env.REVIEW_STATE_MACHINE_ARN = 'arn:aws:states:::sm/review';
  s3Mock.on(PutObjectCommand).resolves({});
});

describe('postEdit', () => {
  test('400 when slug is missing', async () => {
    const res = await postEdit(event(undefined, { markdown: 'x' }));
    expect(res.statusCode).toBe(400);
  });

  test('400 on malformed JSON', async () => {
    const res = await postEdit(event('p', '{not json'));
    expect(res.statusCode).toBe(400);
  });

  test('400 when markdown is missing', async () => {
    const res = await postEdit(event('p', { reReview: true }));
    expect(res.statusCode).toBe(400);
  });

  test('404 when the post does not exist', async () => {
    ddbMock.on(GetCommand).resolves({});
    const res = await postEdit(event('p', { markdown: 'hello' }));
    expect(res.statusCode).toBe(404);
  });

  test('409 when the post is not staged', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { slug: 'p', status: 'reviewing' } });
    const res = await postEdit(event('p', { markdown: 'hello' }));
    expect(res.statusCode).toBe(409);
  });

  test('writes the next iteration and stays staged without reReview', async () => {
    ddbMock
      .on(GetCommand)
      .resolves({ Item: { slug: 'p', status: 'staged', latestIteration: 2 } });
    ddbMock.on(UpdateCommand).resolves({});

    const res = await postEdit(event('p', { markdown: '# new' }));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ iteration: 3, reReview: false, status: 'staged' });

    const put = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input;
    expect(put.Key).toBe('p/iteration-3/draft.md');

    const upd = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(upd.UpdateExpression).toContain('latestIteration = :it');
    expect(upd.UpdateExpression).toContain('list_append');
    expect(upd.UpdateExpression).not.toContain('#st');
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  test('starts a re-review execution from the new iteration when reReview', async () => {
    ddbMock
      .on(GetCommand)
      .resolves({ Item: { slug: 'p', status: 'staged' } });
    ddbMock.on(UpdateCommand).resolves({});
    sfnMock.on(StartExecutionCommand).resolves({});

    const res = await postEdit(event('p', { markdown: '# new', reReview: true }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      iteration: 2,
      reReview: true,
      status: 'reviewing',
    });

    const upd = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(upd.UpdateExpression).toContain('#st = :reviewing');

    const start = sfnMock.commandCalls(StartExecutionCommand)[0].args[0].input;
    expect(JSON.parse(start.input as string)).toEqual({
      slug: 'p',
      startIteration: 2,
    });
  });
});

describe('postDecision', () => {
  test('400 on an unknown decision', async () => {
    const res = await postDecision(event('p', { decision: 'maybe' }));
    expect(res.statusCode).toBe(400);
  });

  test('404 when the post does not exist', async () => {
    ddbMock.on(GetCommand).resolves({});
    const res = await postDecision(event('p', { decision: 'approve' }));
    expect(res.statusCode).toBe(404);
  });

  test('409 when the post is not staged', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { slug: 'p', status: 'approved' } });
    const res = await postDecision(event('p', { decision: 'approve' }));
    expect(res.statusCode).toBe(409);
  });

  test('approve sets status approved and approvedAt', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { slug: 'p', status: 'staged' } });
    ddbMock.on(UpdateCommand).resolves({});

    const res = await postDecision(event('p', { decision: 'approve' }));

    expect(JSON.parse(res.body)).toMatchObject({ status: 'approved' });
    const upd = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(upd.UpdateExpression).toContain('approvedAt = :now');
    expect(upd.ExpressionAttributeValues).toMatchObject({
      ':status': 'approved',
      // Announcing is the default when the body doesn't say otherwise (PIPE-20).
      ':announce': 'announce',
    });
  });

  test("approve honours announceBluesky: 'skip' from the bag dropdown", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { slug: 'p', status: 'staged' } });
    ddbMock.on(UpdateCommand).resolves({});

    const res = await postDecision(
      event('p', { decision: 'approve', announceBluesky: 'skip' }),
    );

    expect(JSON.parse(res.body)).toMatchObject({ status: 'approved' });
    const upd = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(upd.UpdateExpression).toContain('announceBluesky = :announce');
    expect(upd.ExpressionAttributeValues).toMatchObject({ ':announce': 'skip' });
  });

  test("approve honours announceBluesky: 'force' (flood-guard bypass)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { slug: 'p', status: 'staged' } });
    ddbMock.on(UpdateCommand).resolves({});

    await postDecision(event('p', { decision: 'approve', announceBluesky: 'force' }));

    const upd = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(upd.ExpressionAttributeValues).toMatchObject({ ':announce': 'force' });
  });

  test('approve maps a legacy boolean false to skip (PIPE-20 clients)', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { slug: 'p', status: 'staged' } });
    ddbMock.on(UpdateCommand).resolves({});

    await postDecision(event('p', { decision: 'approve', announceBluesky: false }));

    const upd = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(upd.ExpressionAttributeValues).toMatchObject({ ':announce': 'skip' });
  });

  test('reject sets status failed and rejectedAt', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { slug: 'p', status: 'staged' } });
    ddbMock.on(UpdateCommand).resolves({});

    const res = await postDecision(event('p', { decision: 'reject' }));

    expect(JSON.parse(res.body)).toMatchObject({ status: 'failed' });
    const upd = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(upd.UpdateExpression).toContain('rejectedAt = :now');
  });
});
