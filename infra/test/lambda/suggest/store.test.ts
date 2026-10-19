import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  getCurrentSuggestions,
  getSuggestions,
  getSummary,
  putSuggestions,
  putSummary,
  suggestionsKey,
  summaryOf,
} from '../../../lambda/suggest/store';
import type { Suggestions } from '../../../lambda/suggest/schema';

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

const base: Suggestions = {
  version: 1, slug: 'p', iteration: 2, generatedAt: 'now', status: 'ok',
  models: { chat: 'c', embed: 'e' }, links: [], repos: [], dropped: [],
};

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  process.env.POSTS_TABLE_NAME = 'posts';
  process.env.DRAFTS_BUCKET = 'drafts';
});

test('suggestionsKey sits beside reviews.json', () => {
  expect(suggestionsKey('p', 2)).toBe('p/iteration-2/suggestions.json');
});

test('summaryOf counts undecided and carries the skip reason', () => {
  expect(summaryOf({ ...base, status: 'skipped', skippedReason: 'no-embeddings-index' })).toEqual({
    iteration: 2, status: 'skipped', skippedReason: 'no-embeddings-index',
    links: 0, repos: 0, undecided: 0, generatedAt: 'now',
  });
  expect(summaryOf(base)).not.toHaveProperty('skippedReason');
});

test('putSuggestions writes JSON to S3', async () => {
  s3Mock.on(PutObjectCommand).resolves({});
  await putSuggestions(base);
  const input = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input;
  expect(input.Key).toBe('p/iteration-2/suggestions.json');
  expect(JSON.parse(input.Body as string)).toMatchObject({ slug: 'p' });
});

test('getSuggestions is null when the file is absent, parsed when present', async () => {
  s3Mock.on(HeadObjectCommand).rejectsOnce(Object.assign(new Error('nf'), { name: 'NotFound' }));
  await expect(getSuggestions('p', 2)).resolves.toBeNull();
  s3Mock.on(HeadObjectCommand).resolves({});
  s3Mock.on(GetObjectCommand).resolves({
    Body: { transformToString: async () => JSON.stringify(base) } as never,
  });
  await expect(getSuggestions('p', 2)).resolves.toMatchObject({ status: 'ok' });
});

test('putSummary and getSummary use the posts row', async () => {
  ddbMock.on(UpdateCommand).resolves({});
  await putSummary('p', summaryOf(base));
  expect(ddbMock.commandCalls(UpdateCommand)[0].args[0].input).toMatchObject({
    Key: { slug: 'p' },
    UpdateExpression: 'SET suggestionsSummary = :s',
  });
  ddbMock.on(GetCommand).resolves({ Item: { suggestionsSummary: summaryOf(base) } });
  await expect(getSummary('p')).resolves.toMatchObject({ iteration: 2 });
});

test('getCurrentSuggestions needs a summary naming an iteration', async () => {
  await expect(getCurrentSuggestions('p', undefined)).resolves.toBeNull();
  await expect(
    getCurrentSuggestions('p', { ...summaryOf(base), iteration: Number.NaN }),
  ).resolves.toBeNull();
  s3Mock.on(HeadObjectCommand).resolves({});
  s3Mock.on(GetObjectCommand).resolves({
    Body: { transformToString: async () => JSON.stringify(base) } as never,
  });
  await expect(getCurrentSuggestions('p', summaryOf(base))).resolves.toMatchObject({ slug: 'p' });
});

test('a failed step with no file yields a placeholder so the bag says it failed', async () => {
  s3Mock.on(HeadObjectCommand).rejects(Object.assign(new Error('nf'), { name: 'NotFound' }));
  const out = await getCurrentSuggestions('p', {
    iteration: 3, status: 'error', skippedReason: 'step failed: States.Timeout',
    links: 0, repos: 0, undecided: 0, generatedAt: 'then',
  });
  expect(out).toMatchObject({
    slug: 'p', iteration: 3, status: 'error', skippedReason: 'step failed: States.Timeout',
    generatedAt: 'then', links: [], repos: [],
  });
});

test('an ok summary whose file is missing yields nothing, not a placeholder', async () => {
  s3Mock.on(HeadObjectCommand).rejects(Object.assign(new Error('nf'), { name: 'NotFound' }));
  await expect(getCurrentSuggestions('p', summaryOf(base))).resolves.toBeNull();
});

test('summaryOf counts affiliate mentions when the affiliate step ran (PIPE-41)', () => {
  const mention = {
    id: 'm', kind: 'affiliate' as const, anchorText: 'a', productName: 'a', quote: 'a', before: '', after: '',
    occurrence: { paragraph: 0, offset: 0 }, reason: '', decision: 'pending' as const,
  };
  expect(
    summaryOf({
      ...base,
      affiliatesStatus: 'ok',
      affiliates: [mention, { ...mention, id: 'n', decision: 'skipped' }],
    }),
  ).toMatchObject({ affiliates: 2, affiliatesUndecided: 1, affiliatesStatus: 'ok' });
});

test('the placeholder for a failed step carries the affiliate status (PIPE-41)', async () => {
  s3Mock.on(HeadObjectCommand).rejects(Object.assign(new Error('nf'), { name: 'NotFound' }));
  const placeholder = await getCurrentSuggestions('p', {
    iteration: 2, status: 'error', links: 0, repos: 0, undecided: 0, generatedAt: 'now', affiliatesStatus: 'error',
  });
  expect(placeholder).toMatchObject({ status: 'error', affiliates: [], affiliatesStatus: 'error' });
});
