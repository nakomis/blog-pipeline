import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
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

  describe('link and repo suggestions (PIPE-38)', () => {
    const summary = { iteration: 2, status: 'ok', links: 1, repos: 1, undecided: 0, generatedAt: 'x' };
    const file = (decision: string) =>
      JSON.stringify({
        version: 1, slug: 'p', iteration: 2, generatedAt: 'x', status: 'ok',
        models: { chat: 'c', embed: 'e' }, dropped: [],
        links: [{
          id: 'l1', kind: 'link', anchorText: 'the Cabal', context: '', targetSlug: 's', targetTitle: 't',
          targetUrl: 'https://blog.nakomis.com/2026-07-29-cabal', targetDate: 'd',
          occurrence: { paragraph: 0, offset: 0 }, reason: 'r', decision,
        }],
        repos: [{
          id: 'r1', kind: 'repo', fullName: 'nakomis/mcps', name: 'mcps', url: 'https://github.com/nakomis/mcps',
          description: null, evidence: 'e', reason: 'r', source: 'llm', decision,
        }],
      });

    function serve(decision: string): void {
      s3Mock.on(HeadObjectCommand).resolves({});
      s3Mock.on(GetObjectCommand, { Key: 'p/iteration-2/suggestions.json' }).resolves({
        Body: { transformToString: async () => file(decision) } as never,
      });
      s3Mock.on(GetObjectCommand, { Key: 'p/iteration-2/draft.md' }).resolves({
        Body: { transformToString: async () => 'I asked the Cabal.' } as never,
        ETag: '"e"',
      });
      ddbMock.on(GetCommand).resolves({
        Item: { slug: 'p', status: 'staged', reviewIteration: 2, suggestionsSummary: summary },
      });
      ddbMock.on(UpdateCommand).resolves({});
    }

    test('approve writes accepted links into the draft and accepted repos onto the row', async () => {
      serve('accepted');
      const res = await postDecision(event('p', { decision: 'approve' }));
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({ status: 'approved', applied: { links: 1, repos: 1 }, skipped: [] });
      const put = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input;
      expect(put.Body).toBe('I asked [the Cabal](https://blog.nakomis.com/2026-07-29-cabal).');
      const upd = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
      expect(upd.UpdateExpression).toContain('approvedRepos = :repos');
      expect(upd.ExpressionAttributeValues).toMatchObject({
        ':repos': [{ name: 'mcps', url: 'https://github.com/nakomis/mcps' }],
      });
    });

    test('approve applies nothing that is still pending and is not blocked by it', async () => {
      serve('pending');
      const res = await postDecision(event('p', { decision: 'approve' }));
      expect(res.statusCode).toBe(200);
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
      const upd = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
      expect(upd.UpdateExpression).not.toContain('approvedRepos');
    });

    test('reject never touches suggestions', async () => {
      serve('accepted');
      const res = await postDecision(event('p', { decision: 'reject' }));
      expect(JSON.parse(res.body)).not.toHaveProperty('applied');
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    });

    test('a failure applying links leaves the post staged', async () => {
      serve('accepted');
      s3Mock.on(PutObjectCommand).rejects(new Error('S3 down'));
      await expect(postDecision(event('p', { decision: 'approve' }))).rejects.toThrow('S3 down');
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });
  });

  describe('affiliate links (PIPE-41)', () => {
    const AMZ = 'https://www.amazon.co.uk/dp/B0F4D8ZY6L?tag=nakomis-bconn66-21';
    const summary = { iteration: 2, status: 'ok', links: 0, repos: 0, undecided: 0, generatedAt: 'x', affiliatesStatus: 'ok' };
    const file = (decision: string, trackingId?: string) =>
      JSON.stringify({
        version: 1, slug: 'p', iteration: 2, generatedAt: 'x', status: 'ok',
        models: { chat: 'c', embed: 'e' }, dropped: [], links: [], repos: [],
        affiliatesStatus: 'ok',
        ...(trackingId ? { trackingId } : {}),
        affiliates: [{
          id: 'a1', kind: 'affiliate', anchorText: 'Mars 5 Ultra', productName: 'Mars', quote: 'q',
          before: 'on the ', after: ' today.', occurrence: { paragraph: 0, offset: 0 }, reason: 'r',
          decision, ...(decision === 'linked' ? { url: AMZ } : {}),
        }],
      });
    function serve(decision: string, source = 'title: x', trackingId?: string): void {
      s3Mock.on(HeadObjectCommand).resolves({});
      s3Mock.on(GetObjectCommand, { Key: 'p/iteration-2/suggestions.json' }).resolves({
        Body: { transformToString: async () => file(decision, trackingId) } as never,
      });
      s3Mock.on(GetObjectCommand, { Key: 'p/iteration-2/draft.md' }).resolves({
        Body: { transformToString: async () => 'I printed on the Mars 5 Ultra today.' } as never,
        ETag: '"e"',
      });
      s3Mock.on(GetObjectCommand, { Key: 'p/iteration-1/draft.md' }).resolves({
        Body: { transformToString: async () => `---\n${source}\n---\n\nx` } as never,
      });
      ddbMock.on(GetCommand).resolves({
        Item: { slug: 'p', status: 'staged', reviewIteration: 2, suggestionsSummary: summary },
      });
      ddbMock.on(UpdateCommand).resolves({});
    }

    test('approve writes the pasted link and records it on the row for promotion', async () => {
      serve('linked', 'amazon_tracking_id: "nakomis-bconn66-21"');
      const res = await postDecision(event('p', { decision: 'approve' }));
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({ status: 'approved', applied: { affiliates: 1 } });
      expect(body.warnings).toBeUndefined();
      expect(s3Mock.commandCalls(PutObjectCommand)[0].args[0].input.Body).toBe(
        `I printed on the [Mars 5 Ultra](${AMZ}) today.`,
      );
      const upd = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
      expect(upd.UpdateExpression).toContain('approvedAffiliateUrls = :aff');
      expect(upd.UpdateExpression).not.toContain('approvedTrackingId');
      expect(upd.ExpressionAttributeValues).toMatchObject({ ':aff': [AMZ] });
    });

    test('a typed tracking id goes on the row only when the source has none', async () => {
      serve('linked', 'title: x', 'nakomis-bconn66-21');
      await postDecision(event('p', { decision: 'approve' }));
      const upd = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
      expect(upd.UpdateExpression).toContain('approvedTrackingId = :tid');
      expect(upd.ExpressionAttributeValues).toMatchObject({ ':tid': 'nakomis-bconn66-21' });
    });

    test('undecided mentions and a missing tracking id are warnings, never a block', async () => {
      serve('pending');
      const res = await postDecision(event('p', { decision: 'approve' }));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).warnings.join(' ')).toMatch(/no affiliate link decision/);
      const upd = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
      expect(upd.UpdateExpression).not.toContain('approvedAffiliateUrls');
      serve('linked');
      const res2 = await postDecision(event('p', { decision: 'approve' }));
      expect(JSON.parse(res2.body).warnings.join(' ')).toMatch(/no amazon_tracking_id/);
    });
  });
});
