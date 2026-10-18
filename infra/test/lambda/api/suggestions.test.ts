import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { applyAcceptedSuggestions, postSuggestions } from '../../../lambda/api/suggestions';
import type { Suggestions, SuggestionsSummary } from '../../../lambda/suggest/schema';

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

const URL_A = 'https://blog.nakomis.com/2026-07-29-cabal';

function suggestions(over: Partial<Suggestions> = {}): Suggestions {
  return {
    version: 1,
    slug: 'p',
    iteration: 2,
    generatedAt: '2026-10-18T12:00:00.000Z',
    status: 'ok',
    models: { chat: 'c', embed: 'e' },
    links: [
      {
        id: 'link1', kind: 'link', anchorText: 'the Cabal', context: '', targetSlug: '2026-07-29-cabal',
        targetTitle: 'Cabal', targetUrl: URL_A, targetDate: '2026-07-29',
        occurrence: { paragraph: 0, offset: 0 }, reason: 'r', decision: 'pending',
      },
    ],
    repos: [
      {
        id: 'repo1', kind: 'repo', fullName: 'nakomis/mcps', name: 'mcps',
        url: 'https://github.com/nakomis/mcps', description: null, evidence: 'e', reason: 'r',
        source: 'llm', decision: 'pending',
      },
    ],
    dropped: [],
    ...over,
  };
}

const SUMMARY: SuggestionsSummary = { iteration: 2, status: 'ok', links: 1, repos: 1, undecided: 2, generatedAt: 'x' };

function event(slug: string | undefined, body: unknown): APIGatewayProxyEvent {
  return {
    pathParameters: slug === undefined ? null : { slug },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: {},
  } as unknown as APIGatewayProxyEvent;
}

function s3Text(text: string, etag = '"etag-1"') {
  return { Body: { transformToString: async () => text } as never, ETag: etag };
}

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  process.env.POSTS_TABLE_NAME = 'posts';
  process.env.DRAFTS_BUCKET = 'drafts';
  s3Mock.on(HeadObjectCommand).resolves({});
  s3Mock.on(PutObjectCommand).resolves({});
  ddbMock.on(UpdateCommand).resolves({});
});

function serveSuggestions(s: Suggestions): void {
  s3Mock.on(GetObjectCommand, { Key: 'p/iteration-2/suggestions.json' }).resolves(s3Text(JSON.stringify(s)));
}

describe('postSuggestions', () => {
  const staged = { slug: 'p', status: 'staged', suggestionsSummary: SUMMARY };

  test.each([
    ['missing slug', undefined, { decisions: {} }],
    ['malformed JSON', 'p', '{nope'],
    ['no decisions', 'p', {}],
    ['a bad decision value', 'p', { decisions: { link1: 'maybe' } }],
    ['decisions as an array', 'p', { decisions: ['accepted'] }],
  ])('400: %s', async (_name, slug, body) => {
    const res = await postSuggestions(event(slug as string | undefined, body));
    expect(res.statusCode).toBe(400);
  });

  test('404 when the post does not exist', async () => {
    ddbMock.on(GetCommand).resolves({});
    expect((await postSuggestions(event('p', { decisions: {} }))).statusCode).toBe(404);
  });

  test('409 when the post is not staged', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...staged, status: 'approved' } });
    expect((await postSuggestions(event('p', { decisions: {} }))).statusCode).toBe(409);
  });

  test('404 when the post has no suggestions', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { slug: 'p', status: 'staged' } });
    expect((await postSuggestions(event('p', { decisions: {} }))).statusCode).toBe(404);
  });

  test('400 listing unknown ids', async () => {
    ddbMock.on(GetCommand).resolves({ Item: staged });
    serveSuggestions(suggestions());
    const res = await postSuggestions(event('p', { decisions: { nope: 'accepted' } }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).unknown).toEqual(['nope']);
  });

  test('records decisions, leaves others alone and updates the row summary', async () => {
    ddbMock.on(GetCommand).resolves({ Item: staged });
    serveSuggestions(suggestions());
    const res = await postSuggestions(event('p', { decisions: { link1: 'accepted' } }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body).suggestions as Suggestions;
    expect(body.links[0].decision).toBe('accepted');
    expect(body.repos[0].decision).toBe('pending');

    const put = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input;
    expect(put.Key).toBe('p/iteration-2/suggestions.json');
    const summary = ddbMock.commandCalls(UpdateCommand)[0].args[0].input.ExpressionAttributeValues;
    expect(summary).toMatchObject({ ':s': { undecided: 1, links: 1, repos: 1 } });
  });
});

describe('applyAcceptedSuggestions', () => {
  const post = { latestIteration: 3, reviewIteration: 2, suggestionsSummary: SUMMARY };
  const accepted = (): Suggestions => {
    const s = suggestions();
    s.links[0].decision = 'accepted';
    s.repos[0].decision = 'accepted';
    return s;
  };

  test('null without a summary or when the step did not produce suggestions', async () => {
    await expect(applyAcceptedSuggestions('p', {})).resolves.toBeNull();
    serveSuggestions(suggestions({ status: 'skipped' }));
    await expect(applyAcceptedSuggestions('p', post)).resolves.toBeNull();
  });

  test('writes accepted links into the final draft in place, guarded by If-Match', async () => {
    serveSuggestions(accepted());
    s3Mock
      .on(GetObjectCommand, { Key: 'p/iteration-3/draft.md' })
      .resolves(s3Text('---\ntitle: x\n---\n\nI asked the Cabal today.\n'));
    const out = await applyAcceptedSuggestions('p', post);
    expect(out).toEqual({
      approvedRepos: [{ name: 'mcps', url: 'https://github.com/nakomis/mcps' }],
      applied: { links: 1, repos: 1 },
      skipped: [],
    });
    const put = s3Mock.commandCalls(PutObjectCommand).find((c) => c.args[0].input.Key === 'p/iteration-3/draft.md')!;
    expect(put.args[0].input.Body).toBe(`---\ntitle: x\n---\n\nI asked [the Cabal](${URL_A}) today.\n`);
    expect(put.args[0].input.IfMatch).toBe('"etag-1"');
  });

  test('applies nothing for pending or rejected suggestions', async () => {
    const s = suggestions();
    s.links[0].decision = 'rejected';
    serveSuggestions(s);
    const out = await applyAcceptedSuggestions('p', post);
    expect(out).toEqual({ approvedRepos: [], applied: { links: 0, repos: 0 }, skipped: [] });
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  test('reports a stale link as skipped without writing', async () => {
    serveSuggestions(accepted());
    s3Mock.on(GetObjectCommand, { Key: 'p/iteration-3/draft.md' }).resolves(s3Text('The text changed.'));
    const out = await applyAcceptedSuggestions('p', post);
    expect(out?.applied.links).toBe(0);
    expect(out?.skipped).toEqual([{ id: 'link1', reason: 'the anchor text is no longer in the post' }]);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  test('retries once when the draft changed underneath it', async () => {
    serveSuggestions(accepted());
    s3Mock
      .on(GetObjectCommand, { Key: 'p/iteration-3/draft.md' })
      .resolvesOnce(s3Text('the Cabal v1', '"a"'))
      .resolves(s3Text('the Cabal v2', '"b"'));
    s3Mock
      .on(PutObjectCommand)
      .rejectsOnce(Object.assign(new Error('precondition'), { $metadata: { httpStatusCode: 412 } }))
      .resolves({});
    const out = await applyAcceptedSuggestions('p', post);
    expect(out?.applied.links).toBe(1);
    const puts = s3Mock.commandCalls(PutObjectCommand);
    expect(puts[1].args[0].input.Body).toContain('v2');
  });

  test('gives up with an error after a second conflict', async () => {
    serveSuggestions(accepted());
    s3Mock.on(GetObjectCommand, { Key: 'p/iteration-3/draft.md' }).resolves(s3Text('the Cabal'));
    s3Mock
      .on(PutObjectCommand)
      .rejects(Object.assign(new Error('precondition'), { name: 'PreconditionFailed' }));
    await expect(applyAcceptedSuggestions('p', post)).rejects.toThrow('try again');
  });
});

describe('applyAcceptedSuggestions with affiliate links (PIPE-41)', () => {
  const AMZ = 'https://www.amazon.co.uk/dp/B0F4D8ZY6L?tag=nakomis-bconn66-21';
  const post = { latestIteration: 3, reviewIteration: 2, suggestionsSummary: SUMMARY };
  const DRAFT = '---\ntitle: x\n---\n\nI asked the Cabal, then printed on the Mars 5 Ultra today.\n';
  const mention = (over = {}) => ({
    id: 'aff1', kind: 'affiliate' as const, anchorText: 'Mars 5 Ultra', productName: 'Mars', quote: 'q',
    before: 'then printed on the ', after: ' today.', occurrence: { paragraph: 0, offset: 0 }, reason: 'r',
    decision: 'linked' as const, url: AMZ, ...over,
  });
  const withAff = (over: Partial<Suggestions> = {}): Suggestions => {
    const s = suggestions({ affiliates: [mention()], affiliatesStatus: 'ok', ...over });
    if (s.links[0]) {
      s.links[0].decision = 'accepted';
    }
    return s;
  };
  const serveDraft = (frontmatter = 'title: x') =>
    s3Mock.on(GetObjectCommand, { Key: 'p/iteration-3/draft.md' }).resolves(s3Text(DRAFT));
  const serveSource = (frontmatter: string) =>
    s3Mock
      .on(GetObjectCommand, { Key: 'p/iteration-1/draft.md' })
      .resolves(s3Text(`---\n${frontmatter}\n---\n\nBody\n`));

  test('writes a post link and an affiliate link in one If-Match write, verbatim', async () => {
    serveSuggestions(withAff());
    serveDraft();
    serveSource('amazon_tracking_id: "nakomis-bconn66-21"');
    const out = await applyAcceptedSuggestions('p', post);
    expect(out).toMatchObject({
      applied: { links: 1, repos: 0, affiliates: 1 },
      approvedAffiliateUrls: [AMZ],
      skipped: [],
    });
    expect(out?.approvedTrackingId).toBeUndefined();
    expect(out?.warnings).toBeUndefined();
    const puts = s3Mock.commandCalls(PutObjectCommand).filter((c) => c.args[0].input.Key === 'p/iteration-3/draft.md');
    expect(puts).toHaveLength(1);
    expect(puts[0].args[0].input.Body).toContain(`[Mars 5 Ultra](${AMZ})`);
    expect(puts[0].args[0].input.Body).toContain(`[the Cabal](${URL_A})`);
    expect(puts[0].args[0].input.IfMatch).toBe('"etag-1"');
  });

  test('works when the link half was skipped (no embeddings index)', async () => {
    serveSuggestions(withAff({ status: 'skipped', links: [], repos: [] }));
    serveDraft();
    serveSource('amazon_tracking_id: "nakomis-bconn66-21"');
    const out = await applyAcceptedSuggestions('p', post);
    expect(out?.applied).toEqual({ links: 0, repos: 0, affiliates: 1 });
    expect(out?.approvedRepos).toEqual([]);
  });

  test('pending and skipped mentions are not applied; undecided ones are warned about', async () => {
    serveSuggestions(withAff({ affiliates: [mention({ decision: 'pending', url: undefined }), mention({ id: 'aff2', decision: 'skipped', url: undefined, anchorText: 'x' })] }));
    serveDraft();
    serveSource('amazon_tracking_id: "nakomis-bconn66-21"');
    const out = await applyAcceptedSuggestions('p', post);
    expect(out?.applied.affiliates).toBe(0);
    expect(out?.approvedAffiliateUrls).toBeUndefined();
    expect(out?.warnings?.join(' ')).toMatch(/1 product mention had no affiliate link decision/);
  });

  test('warns when links go in but the post has no tracking id', async () => {
    serveSuggestions(withAff());
    serveDraft();
    serveSource('title: x');
    const out = await applyAcceptedSuggestions('p', post);
    expect(out?.warnings?.join(' ')).toMatch(/no amazon_tracking_id/);
    expect(out?.approvedTrackingId).toBeUndefined();
  });

  test('hands over a typed tracking id when the source has none', async () => {
    serveSuggestions(withAff({ trackingId: 'nakomis-bconn66-21' }));
    serveDraft();
    serveSource('title: x');
    const out = await applyAcceptedSuggestions('p', post);
    expect(out?.approvedTrackingId).toBe('nakomis-bconn66-21');
    expect(out?.warnings).toBeUndefined();
  });

  test('does not hand over a typed id when the source already has one', async () => {
    serveSuggestions(withAff({ trackingId: 'nakomis-other-21' }));
    serveDraft();
    serveSource('amazon_tracking_id: "nakomis-bconn66-21"');
    expect((await applyAcceptedSuggestions('p', post))?.approvedTrackingId).toBeUndefined();
  });

  test('a pasted link that no longer validates is skipped, not written', async () => {
    serveSuggestions(withAff({ affiliates: [mention({ url: 'https://amzn.to/abc' })] }));
    serveDraft();
    serveSource('amazon_tracking_id: "nakomis-bconn66-21"');
    const out = await applyAcceptedSuggestions('p', post);
    expect(out?.applied.affiliates).toBe(0);
    expect(out?.skipped[0]).toMatchObject({ id: 'aff1' });
    expect(out?.approvedAffiliateUrls).toBeUndefined();
  });

  test('a stale locator is skipped and not reported as applied', async () => {
    serveSuggestions(withAff({ affiliates: [mention({ before: 'something else ' })] }));
    serveDraft();
    serveSource('amazon_tracking_id: "nakomis-bconn66-21"');
    const out = await applyAcceptedSuggestions('p', post);
    expect(out?.skipped).toEqual([{ id: 'aff1', reason: 'the text around the anchor has changed' }]);
    expect(out?.approvedAffiliateUrls).toBeUndefined();
  });

  test('null when neither half produced anything usable', async () => {
    serveSuggestions(suggestions({ status: 'error', affiliatesStatus: 'error' }));
    await expect(applyAcceptedSuggestions('p', post)).resolves.toBeNull();
  });

  test('a retried approval still hands over the links that are already in the draft', async () => {
    // The first attempt wrote the draft, then the row update failed; the retry finds the link there.
    serveSuggestions(withAff());
    s3Mock
      .on(GetObjectCommand, { Key: 'p/iteration-3/draft.md' })
      .resolves(s3Text(`---\ntitle: x\n---\n\nI asked [the Cabal](${URL_A}), then printed on the [Mars 5 Ultra](${AMZ}) today.\n`));
    serveSource('amazon_tracking_id: "nakomis-bconn66-21"');
    const out = await applyAcceptedSuggestions('p', post);
    expect(out?.approvedAffiliateUrls).toEqual([AMZ]);
    expect(out?.applied).toMatchObject({ links: 1, affiliates: 1 });
    expect(out?.skipped).toEqual([]);
    expect(s3Mock.commandCalls(PutObjectCommand).filter((c) => c.args[0].input.Key === 'p/iteration-3/draft.md')).toHaveLength(0);
  });

  test('the same product pasted for two mentions is linked once, the first in document order', async () => {
    const DRAFT2 = '---\ntitle: x\n---\n\nFirst the Mars 5 Ultra, then the Mars Ultra again.\n';
    serveSuggestions(
      withAff({
        links: [],
        affiliates: [
          mention({ id: 'first', anchorText: 'Mars 5 Ultra', before: 'First the ', after: ', then' }),
          mention({ id: 'second', anchorText: 'Mars Ultra', before: 'then the ', after: ' again.', url: AMZ.replace('bconn66', 'bconn66') }),
        ],
      }),
    );
    s3Mock.on(GetObjectCommand, { Key: 'p/iteration-3/draft.md' }).resolves(s3Text(DRAFT2));
    serveSource('amazon_tracking_id: "nakomis-bconn66-21"');
    const out = await applyAcceptedSuggestions('p', post);
    expect(out?.applied.affiliates).toBe(1);
    expect(out?.approvedAffiliateUrls).toEqual([AMZ]);
    expect(out?.skipped).toEqual([{ id: 'second', reason: 'the same product is already linked by an earlier mention' }]);
    const put = s3Mock.commandCalls(PutObjectCommand).find((c) => c.args[0].input.Key === 'p/iteration-3/draft.md')!;
    expect(put.args[0].input.Body).toBe(`---\ntitle: x\n---\n\nFirst the [Mars 5 Ultra](${AMZ}), then the Mars Ultra again.\n`);
  });

  test('different products are both linked', async () => {
    const B = 'https://www.amazon.co.uk/dp/B0CRK47HXM?tag=nakomis-bconn66-21';
    serveSuggestions(
      withAff({
        links: [],
        affiliates: [
          mention({ id: 'first', anchorText: 'Mars 5 Ultra', before: 'First the ', after: ', then' }),
          mention({ id: 'second', anchorText: 'Mars Ultra', before: 'then the ', after: ' again.', url: B }),
        ],
      }),
    );
    s3Mock
      .on(GetObjectCommand, { Key: 'p/iteration-3/draft.md' })
      .resolves(s3Text('---\ntitle: x\n---\n\nFirst the Mars 5 Ultra, then the Mars Ultra again.\n'));
    serveSource('amazon_tracking_id: "nakomis-bconn66-21"');
    const out = await applyAcceptedSuggestions('p', post);
    expect(out?.approvedAffiliateUrls).toEqual([AMZ, B]);
  });
});
