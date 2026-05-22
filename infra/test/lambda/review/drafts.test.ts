import { mockClient } from 'aws-sdk-client-mock';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import {
  draftKey,
  reviewsKey,
  getDraft,
  putDraft,
  putReviews,
  draftExists,
} from '../../../lambda/review/drafts';

const s3Mock = mockClient(S3Client);

beforeEach(() => {
  s3Mock.reset();
  process.env.DRAFTS_BUCKET = 'drafts-bucket';
});

describe('key helpers', () => {
  test('draftKey', () => {
    expect(draftKey('my-post', 2)).toBe('my-post/iteration-2/draft.md');
  });
  test('reviewsKey', () => {
    expect(reviewsKey('my-post', 3)).toBe('my-post/iteration-3/reviews.json');
  });
});

describe('getDraft', () => {
  test('returns the object body as a string', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: { transformToString: async () => 'draft content' } as never,
    });
    await expect(getDraft('k')).resolves.toBe('draft content');
  });

  test('throws when the object has no body', async () => {
    s3Mock.on(GetObjectCommand).resolves({});
    await expect(getDraft('k')).rejects.toThrow(/no body/);
  });
});

describe('putDraft / putReviews', () => {
  test('putDraft writes markdown', async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    await putDraft('k', '# hi');
    const input = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input;
    expect(input.Bucket).toBe('drafts-bucket');
    expect(input.ContentType).toBe('text/markdown');
    expect(input.Body).toBe('# hi');
  });

  test('putReviews writes pretty-printed JSON', async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    await putReviews('k', { a: 1 });
    const input = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input;
    expect(input.ContentType).toBe('application/json');
    expect(input.Body).toContain('"a": 1');
  });
});

describe('draftExists', () => {
  test('true when HeadObject succeeds', async () => {
    s3Mock.on(HeadObjectCommand).resolves({});
    await expect(draftExists('k')).resolves.toBe(true);
  });

  test('false when HeadObject reports NotFound', async () => {
    const notFound = new Error('not found');
    notFound.name = 'NotFound';
    s3Mock.on(HeadObjectCommand).rejects(notFound);
    await expect(draftExists('k')).resolves.toBe(false);
  });

  test('rethrows errors other than NotFound', async () => {
    s3Mock.on(HeadObjectCommand).rejects(new Error('access denied'));
    await expect(draftExists('k')).rejects.toThrow('access denied');
  });
});
