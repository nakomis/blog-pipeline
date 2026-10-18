import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { frontmatterTrackingId, postAffiliates } from '../../../lambda/api/affiliates';
import type { AffiliateMention, Suggestions, SuggestionsSummary } from '../../../lambda/suggest/schema';

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

const GOOD = 'https://www.amazon.co.uk/dp/B0F4D8ZY6L?tag=nakomis-bconn66-21';
const OTHER = 'https://www.amazon.co.uk/dp/B0CRK47HXM?tag=nakomis-bconn66-21';

const mention = (id: string, over: Partial<AffiliateMention> = {}): AffiliateMention => ({
  id,
  kind: 'affiliate',
  anchorText: id,
  productName: id,
  quote: id,
  before: '',
  after: '',
  occurrence: { paragraph: 0, offset: 0 },
  reason: 'r',
  decision: 'pending',
  ...over,
});

function suggestions(over: Partial<Suggestions> = {}): Suggestions {
  return {
    version: 1,
    slug: 'p',
    iteration: 2,
    generatedAt: 'now',
    status: 'ok',
    models: { chat: 'c', embed: 'e' },
    links: [],
    repos: [],
    dropped: [],
    affiliates: [mention('m1'), mention('m2'), mention('m3')],
    affiliatesStatus: 'ok',
    ...over,
  };
}

const SUMMARY: SuggestionsSummary = {
  iteration: 2, status: 'ok', links: 0, repos: 0, undecided: 0, generatedAt: 'x',
  affiliates: 3, affiliatesUndecided: 3, affiliatesStatus: 'ok',
};
const staged = { slug: 'p', status: 'staged', suggestionsSummary: SUMMARY };

function event(slug: string | undefined, body: unknown): APIGatewayProxyEvent {
  return {
    pathParameters: slug === undefined ? null : { slug },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: {},
  } as unknown as APIGatewayProxyEvent;
}
const text = (t: string) => ({ Body: { transformToString: async () => t } as never, ETag: '"e"' });

function serve(s: Suggestions, frontmatter = 'title: x\namazon_tracking_id: "nakomis-bconn66-21"'): void {
  s3Mock.on(GetObjectCommand, { Key: 'p/iteration-2/suggestions.json' }).resolves(text(JSON.stringify(s)));
  s3Mock.on(GetObjectCommand, { Key: 'p/iteration-1/draft.md' }).resolves(text(`---\n${frontmatter}\n---\n\nBody.\n`));
}

const written = (): Suggestions =>
  JSON.parse(
    s3Mock.commandCalls(PutObjectCommand).find((c) => c.args[0].input.Key === 'p/iteration-2/suggestions.json')!
      .args[0].input.Body as string,
  );

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  process.env.POSTS_TABLE_NAME = 'posts';
  process.env.DRAFTS_BUCKET = 'drafts';
  s3Mock.on(HeadObjectCommand).resolves({});
  s3Mock.on(PutObjectCommand).resolves({});
  ddbMock.on(UpdateCommand).resolves({});
  ddbMock.on(GetCommand).resolves({ Item: staged });
});

describe('postAffiliates: request checks', () => {
  test.each([
    ['missing slug', undefined, { decisions: {} }],
    ['malformed JSON', 'p', '{nope'],
    ['nothing to do', 'p', {}],
    ['decisions as an array', 'p', { decisions: [] }],
    ['an unknown action', 'p', { decisions: { m1: { action: 'maybe' } } }],
    ['link without a url', 'p', { decisions: { m1: { action: 'link' } } }],
    ['a string instead of an object', 'p', { decisions: { m1: 'skip' } }],
    ['a non-string tracking id', 'p', { trackingId: 5 }],
  ])('400: %s', async (_n, slug, body) => {
    expect((await postAffiliates(event(slug as string | undefined, body))).statusCode).toBe(400);
  });

  test('404 when the post does not exist', async () => {
    ddbMock.on(GetCommand).resolves({});
    expect((await postAffiliates(event('p', { skipRemaining: true }))).statusCode).toBe(404);
  });

  test('409 when the post is not staged', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...staged, status: 'approved' } });
    expect((await postAffiliates(event('p', { skipRemaining: true }))).statusCode).toBe(409);
  });

  test('404 when the post has no affiliate step', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { slug: 'p', status: 'staged' } });
    expect((await postAffiliates(event('p', { skipRemaining: true }))).statusCode).toBe(404);
    ddbMock.on(GetCommand).resolves({ Item: staged });
    serve(suggestions({ affiliatesStatus: 'error', affiliates: [] }));
    expect((await postAffiliates(event('p', { skipRemaining: true }))).statusCode).toBe(404);
  });

  test('400 listing unknown ids, writing nothing', async () => {
    serve(suggestions());
    const res = await postAffiliates(event('p', { decisions: { nope: { action: 'skip' } } }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).unknown).toEqual(['nope']);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });
});

describe('postAffiliates: decisions', () => {
  test('stores a valid link exactly as pasted, and the row summary', async () => {
    serve(suggestions());
    const res = await postAffiliates(event('p', { decisions: { m1: { action: 'link', url: `  ${GOOD} ` } } }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results.m1).toEqual({ ok: true, warnings: [] });
    expect(written().affiliates?.[0]).toMatchObject({ decision: 'linked', url: GOOD, warnings: [] });
    const summary = ddbMock.commandCalls(UpdateCommand)[0].args[0].input.ExpressionAttributeValues;
    expect(summary).toMatchObject({ ':s': { affiliates: 3, affiliatesUndecided: 2 } });
  });

  test('partial success: a bad link is reported and not stored, a good one is', async () => {
    serve(suggestions());
    const res = await postAffiliates(
      event('p', {
        decisions: {
          m1: { action: 'link', url: 'https://amzn.to/abc' },
          m2: { action: 'link', url: GOOD },
        },
      }),
    );
    const body = JSON.parse(res.body);
    expect(body.results.m1.ok).toBe(false);
    expect(body.results.m1.error).toContain("SiteStripe's Full link");
    expect(body.results.m2.ok).toBe(true);
    const w = written();
    expect(w.affiliates?.[0]).toMatchObject({ decision: 'pending' });
    expect(w.affiliates?.[0].url).toBeUndefined();
    expect(w.affiliates?.[1]).toMatchObject({ decision: 'linked', url: GOOD });
  });

  test('warns about a tag that differs from the post tracking id, and about duplicates', async () => {
    serve(suggestions({ affiliates: [mention('m1', { decision: 'linked', url: GOOD }), mention('m2')] }));
    const res = await postAffiliates(
      event('p', { decisions: { m2: { action: 'link', url: 'https://www.amazon.co.uk/dp/B0F4D8ZY6L?tag=nakomis-21' } } }),
    );
    const warnings = JSON.parse(res.body).results.m2.warnings.join(' ');
    expect(warnings).toMatch(/tag is nakomis-21 but this post uses nakomis-bconn66-21/);
    expect(warnings).toMatch(/Only the first will be linked/);
  });

  test('skip and reset clear the stored link', async () => {
    serve(suggestions({ affiliates: [mention('m1', { decision: 'linked', url: GOOD, warnings: ['w'] }), mention('m2', { decision: 'linked', url: OTHER })] }));
    await postAffiliates(event('p', { decisions: { m1: { action: 'skip' }, m2: { action: 'reset' } } }));
    const w = written();
    expect(w.affiliates?.[0]).toMatchObject({ decision: 'skipped' });
    expect(w.affiliates?.[0].url).toBeUndefined();
    expect(w.affiliates?.[1]).toMatchObject({ decision: 'pending' });
    expect(w.affiliates?.[1].url).toBeUndefined();
  });

  test('skipRemaining skips every pending mention and leaves linked ones', async () => {
    serve(suggestions({ affiliates: [mention('m1', { decision: 'linked', url: GOOD }), mention('m2'), mention('m3')] }));
    const res = await postAffiliates(event('p', { skipRemaining: true }));
    expect(res.statusCode).toBe(200);
    expect(written().affiliates?.map((a) => a.decision)).toEqual(['linked', 'skipped', 'skipped']);
  });
});

describe('postAffiliates: tracking id', () => {
  const NONE = 'title: x';

  test('can be typed when the source has none, and then counts as the post id', async () => {
    serve(suggestions(), NONE);
    const res = await postAffiliates(
      event('p', { trackingId: 'nakomis-bconn66-21', decisions: { m1: { action: 'link', url: GOOD } } }),
    );
    const body = JSON.parse(res.body);
    expect(body.trackingId).toEqual({ ok: true });
    expect(body.results.m1.warnings).toEqual([]);
    expect(written().trackingId).toBe('nakomis-bconn66-21');
  });

  test('warns that there is none when the source has none and none was typed', async () => {
    serve(suggestions(), NONE);
    const res = await postAffiliates(event('p', { decisions: { m1: { action: 'link', url: GOOD } } }));
    expect(JSON.parse(res.body).results.m1.warnings.join(' ')).toMatch(/No amazon_tracking_id/);
  });

  test('typing one refreshes the warnings on links already pasted', async () => {
    serve(suggestions({ affiliates: [mention('m1', { decision: 'linked', url: GOOD, warnings: ['old'] })] }), NONE);
    await postAffiliates(event('p', { trackingId: 'nakomis-bconn66-21' }));
    expect(written().affiliates?.[0].warnings).toEqual([]);
  });

  test('is rejected when it is not a per-post id', async () => {
    serve(suggestions(), NONE);
    for (const bad of ['nakomis-21', 'other-x-21', 'nakomis-x-22']) {
      const res = await postAffiliates(event('p', { trackingId: bad }));
      expect(JSON.parse(res.body).trackingId.ok).toBe(false);
    }
    expect(written().trackingId).toBeUndefined();
  });

  test('is rejected when the source already has a different one', async () => {
    serve(suggestions());
    const res = await postAffiliates(event('p', { trackingId: 'nakomis-other-21' }));
    const body = JSON.parse(res.body);
    expect(body.trackingId.ok).toBe(false);
    expect(body.trackingId.error).toContain('nakomis-bconn66-21');
  });

  test('null clears a typed one', async () => {
    serve(suggestions({ trackingId: 'nakomis-bconn66-21' }), NONE);
    await postAffiliates(event('p', { trackingId: null }));
    expect(written().trackingId).toBeUndefined();
  });
});

describe('frontmatterTrackingId', () => {
  test('reads the author frontmatter, and is undefined when absent or unreadable', async () => {
    s3Mock.on(GetObjectCommand, { Key: 'p/iteration-1/draft.md' }).resolves(text('---\namazon_tracking_id: "nakomis-a-21"\n---\n\nx'));
    await expect(frontmatterTrackingId('p')).resolves.toBe('nakomis-a-21');
    s3Mock.on(GetObjectCommand, { Key: 'p/iteration-1/draft.md' }).resolves(text('no frontmatter'));
    await expect(frontmatterTrackingId('p')).resolves.toBeUndefined();
    s3Mock.on(GetObjectCommand, { Key: 'p/iteration-1/draft.md' }).rejects(new Error('boom'));
    await expect(frontmatterTrackingId('p')).resolves.toBeUndefined();
  });
});
