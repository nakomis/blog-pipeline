import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { draftKey, getDraft, putDraft } from '../review/drafts';
import { requireEnv } from '../review/runtime';

/**
 * `{{image}}` placeholder handling (PIPE-6).
 *
 * An author marks where an illustration should go with a placeholder tag:
 *   {{image prompt="a black cat asleep on a warm radiator" negative="text, watermark"}}
 *
 * `image-submit` parses these and fires a fal.ai job per tag; once a post leaves
 * review, `applyPlaceholders` rewrites each tag whose PNG has arrived into a
 * standard Markdown image reference:
 *   ![a black cat asleep on a warm radiator](images/{slug}-1.png)
 *
 * ## Stable indexing
 *
 * Each tag's index is its 1-based position in the draft, and that index is baked
 * into the image filename (`{slug}-{n}.png`). Rewriting is partial and
 * re-runnable — the callback and the terminal step both call it, and only PNGs
 * that have actually arrived are rewritten. So a re-run must still number the
 * *remaining* `{{image}}` tags by their original position. We do that by walking
 * "slots" — both unrewritten placeholders and links we previously generated —
 * in document order. A generated link consumes its slot without being touched,
 * keeping every later placeholder on its original index.
 */

const PLACEHOLDER_SOURCE = '\\{\\{\\s*image\\b[^}]*\\}\\}';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A regex matching every image "slot" in the draft, in document order: an
 * unrewritten `{{image …}}` placeholder, or a link this module generated for
 * the given slug (`![…](images/{slug}-N.png)`). Counting matches recovers each
 * placeholder's original 1-based index even after a partial rewrite.
 */
function slotRegExp(slug: string): RegExp {
  const link = `!\\[[^\\]]*\\]\\(images\\/${escapeRegExp(slug)}-\\d+\\.png\\)`;
  return new RegExp(`${PLACEHOLDER_SOURCE}|${link}`, 'g');
}

function isPlaceholder(slot: string): boolean {
  return slot.startsWith('{{');
}

/** Pull `name="value"` (or single-quoted) out of a tag's attribute string. */
function attr(attrs: string, name: string): string | undefined {
  const match = attrs.match(
    new RegExp(`${name}\\s*=\\s*"([^"]*)"|${name}\\s*=\\s*'([^']*)'`),
  );
  if (!match) {
    return undefined;
  }
  return match[1] ?? match[2];
}

export interface ImagePlaceholder {
  /** 1-based position among image slots in the draft. */
  index: number;
  /** The generation prompt — empty string if the tag carried none. */
  prompt: string;
  /** Optional negative prompt — parsed and stored, not sent to flux-2-pro. */
  negative?: string;
  /**
   * Optional model name (PIPE-27) — a key of `IMAGE.models`, chosen by the
   * author. Resolution and fallback happen at submit time, not here.
   */
  model?: string;
}

/**
 * Parse the `{{image}}` placeholders still present in a draft, each tagged with
 * its stable slot index. Already-generated links advance the index but are not
 * returned — only outstanding placeholders are.
 */
export function parseImagePlaceholders(
  md: string,
  slug: string,
): ImagePlaceholder[] {
  const placeholders: ImagePlaceholder[] = [];
  let index = 0;
  for (const match of md.matchAll(slotRegExp(slug))) {
    index += 1;
    const slot = match[0];
    if (!isPlaceholder(slot)) {
      continue;
    }
    const attrs = slot.replace(/^\{\{\s*image\b/, '').replace(/\}\}$/, '');
    placeholders.push({
      index,
      prompt: attr(attrs, 'prompt') ?? '',
      negative: attr(attrs, 'negative'),
      model: attr(attrs, 'model'),
    });
  }
  return placeholders;
}

/** S3 object key for a generated image. */
export function imageKey(slug: string, index: number): string {
  return `${slug}/images/${slug}-${index}.png`;
}

/** Markdown-relative path for a generated image (PIPE-5 copies it verbatim). */
export function imageMarkdownPath(slug: string, index: number): string {
  return `images/${slug}-${index}.png`;
}

/**
 * Rewrite the `{{image}}` placeholders whose index is in `available` into
 * Markdown image references; leave every other slot untouched. Pure and
 * idempotent — a rewritten link is no longer a placeholder, so re-running with
 * the same input is a no-op.
 */
export function rewritePlaceholders(
  md: string,
  slug: string,
  available: ReadonlySet<number>,
): string {
  let index = 0;
  return md.replace(slotRegExp(slug), (slot) => {
    index += 1;
    if (!isPlaceholder(slot) || !available.has(index)) {
      return slot;
    }
    const attrs = slot.replace(/^\{\{\s*image\b/, '').replace(/\}\}$/, '');
    const prompt = attr(attrs, 'prompt') ?? '';
    const alt = prompt.replace(/[[\]]/g, '');
    return `![${alt}](${imageMarkdownPath(slug, index)})`;
  });
}

export interface ApplyPlaceholdersDeps {
  /** The post item — its `status` and `reviewIteration` drive the rewrite. */
  getPost(
    slug: string,
  ): Promise<{ status?: string; reviewIteration?: number } | undefined>;
  /** True once the image's PNG has landed in S3. */
  pngExists(slug: string, index: number): Promise<boolean>;
  readDraft(key: string): Promise<string>;
  writeDraft(key: string, md: string): Promise<void>;
}

export interface ApplyPlaceholdersResult {
  /** Indices rewritten on this run. */
  applied: number[];
  /**
   * Why the run did not rewrite (everything):
   *  - `reviewing` — refused to touch a draft still under review;
   *  - `missing-post` — no post item;
   *  - `nothing-to-do` — no outstanding placeholders, or none with a PNG yet.
   */
  reason?: 'reviewing' | 'missing-post' | 'nothing-to-do';
}

/**
 * Rewrite every `{{image}}` placeholder whose PNG has arrived, in the post's
 * current (final) draft.
 *
 * Guards:
 *  - never runs while the post is `reviewing` — the loop may yet redraft;
 *  - only rewrites placeholders whose PNG actually exists in S3;
 *  - idempotent, so the callback and the terminal step can both call it and
 *    whichever runs last fills in the rest.
 */
export async function applyPlaceholders(
  slug: string,
  deps: ApplyPlaceholdersDeps,
): Promise<ApplyPlaceholdersResult> {
  const post = await deps.getPost(slug);
  if (!post) {
    return { applied: [], reason: 'missing-post' };
  }
  if (post.status === 'reviewing') {
    return { applied: [], reason: 'reviewing' };
  }

  const key = draftKey(slug, post.reviewIteration ?? 1);
  const md = await deps.readDraft(key);
  const placeholders = parseImagePlaceholders(md, slug);
  if (placeholders.length === 0) {
    return { applied: [], reason: 'nothing-to-do' };
  }

  const available = new Set<number>();
  for (const placeholder of placeholders) {
    if (await deps.pngExists(slug, placeholder.index)) {
      available.add(placeholder.index);
    }
  }
  if (available.size === 0) {
    return { applied: [], reason: 'nothing-to-do' };
  }

  const rewritten = rewritePlaceholders(md, slug, available);
  if (rewritten !== md) {
    await deps.writeDraft(key, rewritten);
  }
  return { applied: [...available].sort((a, b) => a - b) };
}

/** Wire `applyPlaceholders` against the real DynamoDB and S3 clients. */
export function defaultApplyDeps(): ApplyPlaceholdersDeps {
  const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const s3 = new S3Client({});
  const postsTable = requireEnv('POSTS_TABLE_NAME');
  const bucket = requireEnv('DRAFTS_BUCKET');

  return {
    async getPost(slug) {
      const { Item } = await docClient.send(
        new GetCommand({ TableName: postsTable, Key: { slug } }),
      );
      return Item as { status?: string; reviewIteration?: number } | undefined;
    },
    async pngExists(slug, index) {
      try {
        await s3.send(
          new HeadObjectCommand({ Bucket: bucket, Key: imageKey(slug, index) }),
        );
        return true;
      } catch (err) {
        if (err instanceof Error && err.name === 'NotFound') {
          return false;
        }
        throw err;
      }
    },
    readDraft: getDraft,
    writeDraft: putDraft,
  };
}
