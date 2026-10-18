import { mockClient } from 'aws-sdk-client-mock';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  IndexIncompatibleError,
  decodeEmbedding,
  embedTexts,
  loadIndex,
  parseIndex,
  resetBedrockClient,
  resetIndexCache,
} from '../../../lambda/suggest/embeddings';

const s3Mock = mockClient(S3Client);
const bedrockMock = mockClient(BedrockRuntimeClient);

function encode(values: number[]): string {
  return Buffer.from(new Float32Array(values).buffer).toString('base64');
}

function indexJson(dims: number): string {
  return JSON.stringify([
    {
      id: 'p:0',
      post_slug: '2026-01-01-p',
      post_title: 'P',
      post_date: '2026-01-01',
      post_url: 'https://blog.nakomis.com/2026-01-01-p',
      embedding: encode(Array.from({ length: dims }, (_, i) => i / dims)),
    },
  ]);
}

beforeEach(() => {
  s3Mock.reset();
  bedrockMock.reset();
  resetIndexCache();
  resetBedrockClient();
  process.env.PRIVATE_BUCKET = 'private-bucket';
  process.env.EMBED_REGION = 'us-east-1';
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

describe('decodeEmbedding', () => {
  test('round-trips a base64 Float32 vector', () => {
    const decoded = decodeEmbedding(encode([0.5, -1, 2.25]));
    expect(Array.from(decoded)).toEqual([0.5, -1, 2.25]);
  });
});

describe('parseIndex', () => {
  test('decodes records and defaults missing metadata', () => {
    const [r] = parseIndex(indexJson(4), 4);
    expect(r.post_slug).toBe('2026-01-01-p');
    expect(r.post_excerpt).toBe('');
    expect(r.embedding).toHaveLength(4);
  });

  test('rejects vectors of the wrong length', () => {
    expect(() => parseIndex(indexJson(3), 4)).toThrow(IndexIncompatibleError);
  });
});

describe('loadIndex', () => {
  test('reads and caches the index from the private bucket', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: { transformToString: async () => indexJson(1024) } as never,
    });
    const first = await loadIndex();
    const second = await loadIndex();
    expect(first).toHaveLength(1);
    expect(second).toBe(first);
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(1);
    expect(s3Mock.commandCalls(GetObjectCommand)[0].args[0].input).toMatchObject({
      Bucket: 'private-bucket',
      Key: 'blog-embeddings.json',
    });
  });

  test.each(['NoSuchKey', 'NoSuchBucket', 'AccessDenied'])('%s means no index', async (name) => {
    s3Mock.on(GetObjectCommand).rejects(Object.assign(new Error(name), { name }));
    await expect(loadIndex()).resolves.toBeNull();
  });

  test('an empty body means no index', async () => {
    s3Mock.on(GetObjectCommand).resolves({});
    await expect(loadIndex()).resolves.toBeNull();
  });

  test('other errors propagate', async () => {
    s3Mock.on(GetObjectCommand).rejects(new Error('boom'));
    await expect(loadIndex()).rejects.toThrow('boom');
  });
});

describe('embedTexts', () => {
  test('calls Titan with the index settings and preserves order', async () => {
    bedrockMock.on(InvokeModelCommand).callsFake(async (input) => {
      const { inputText } = JSON.parse(Buffer.from(input.body).toString());
      return {
        body: Buffer.from(JSON.stringify({ embedding: [inputText.length, 0] })) as never,
      };
    });
    const out = await embedTexts(['a', 'bbb', 'cc'], 2);
    expect(out.map((v) => v[0])).toEqual([1, 3, 2]);
    const call = bedrockMock.commandCalls(InvokeModelCommand)[0].args[0].input;
    expect(call.modelId).toBe('amazon.titan-embed-text-v2:0');
    expect(JSON.parse(Buffer.from(call.body as Buffer).toString())).toMatchObject({
      dimensions: 1024,
      normalize: true,
    });
  });

  test('embeds nothing for no text', async () => {
    await expect(embedTexts([])).resolves.toEqual([]);
  });
});
