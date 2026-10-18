import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { LINKS } from '../../lib/config';
import { requireEnv } from '../review/runtime';

/**
 * Reading the blog's embeddings index and embedding the draft (PIPE-38).
 *
 * The index is `blog-embeddings.json`, written by `blog-app/scripts/ingest-blog.py`
 * to the nakom.is private bucket and read by the search Lambda in the `nakom.is`
 * repo. Vectors are Titan Embed Text v2, 1024 dimensions, normalised, stored as
 * base64 Float32 — so a dot product is a cosine similarity.
 */

export class IndexIncompatibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndexIncompatibleError';
  }
}

interface RawRecord {
  id: string;
  post_slug: string;
  post_title?: string;
  post_date?: string;
  post_url?: string;
  post_excerpt?: string;
  heading?: string;
  text?: string;
  embedding: string;
}

export interface IndexRecord {
  id: string;
  post_slug: string;
  post_title: string;
  post_date: string;
  post_url: string;
  post_excerpt: string;
  heading: string;
  text: string;
  embedding: Float32Array;
}

/** Decode a base64 Float32 vector into an aligned `Float32Array`. */
export function decodeEmbedding(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64');
  const copy = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(copy as ArrayBuffer);
}

/** Parse the index JSON, checking every vector has the expected dimensions. */
export function parseIndex(json: string, dims: number): IndexRecord[] {
  const raw = JSON.parse(json) as RawRecord[];
  return raw.map((r) => {
    const embedding = decodeEmbedding(r.embedding);
    if (embedding.length !== dims) {
      throw new IndexIncompatibleError(
        `Index vector for ${r.id} has ${embedding.length} dimensions, expected ${dims}`,
      );
    }
    return {
      id: r.id,
      post_slug: r.post_slug,
      post_title: r.post_title ?? '',
      post_date: r.post_date ?? '',
      post_url: r.post_url ?? '',
      post_excerpt: r.post_excerpt ?? '',
      heading: r.heading ?? '',
      text: r.text ?? '',
      embedding,
    };
  });
}

const s3 = new S3Client({});
let cached: IndexRecord[] | null = null;

/**
 * Load the index (cached per warm container). Returns `null` when the object is
 * absent or unreadable — the sandbox has no index, which is expected.
 */
export async function loadIndex(): Promise<IndexRecord[] | null> {
  if (cached) {
    return cached;
  }
  let body: string;
  try {
    const res = await s3.send(
      new GetObjectCommand({
        Bucket: requireEnv('PRIVATE_BUCKET'),
        Key: LINKS.embeddingsKey,
      }),
    );
    if (!res.Body) {
      return null;
    }
    body = await res.Body.transformToString();
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'NoSuchKey' || name === 'NoSuchBucket' || name === 'AccessDenied') {
      console.warn(`Embeddings index unavailable (${name})`);
      return null;
    }
    throw err;
  }
  cached = parseIndex(body, LINKS.embedDims);
  return cached;
}

/** Forget the cached index — for tests. */
export function resetIndexCache(): void {
  cached = null;
}

let bedrock: BedrockRuntimeClient | undefined;

function bedrockClient(): BedrockRuntimeClient {
  bedrock ??= new BedrockRuntimeClient({ region: requireEnv('EMBED_REGION') });
  return bedrock;
}

/** Forget the cached Bedrock client — for tests. */
export function resetBedrockClient(): void {
  bedrock = undefined;
}

async function embedOne(text: string): Promise<Float32Array> {
  const res = await bedrockClient().send(
    new InvokeModelCommand({
      modelId: LINKS.embedModel,
      contentType: 'application/json',
      accept: 'application/json',
      body: Buffer.from(
        JSON.stringify({ inputText: text, dimensions: LINKS.embedDims, normalize: true }),
      ),
    }),
  );
  const parsed = JSON.parse(Buffer.from(res.body).toString('utf-8')) as {
    embedding: number[];
  };
  return new Float32Array(parsed.embedding);
}

/** Embed each text with Titan, a few at a time. Order is preserved. */
export async function embedTexts(texts: string[], concurrency = 5): Promise<Float32Array[]> {
  const out: Float32Array[] = new Array(texts.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < texts.length) {
      const i = next;
      next += 1;
      out[i] = await embedOne(texts[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, texts.length) }, worker));
  return out;
}
