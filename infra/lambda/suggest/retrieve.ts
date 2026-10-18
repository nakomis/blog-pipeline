import { LINKS } from '../../lib/config';
import type { IndexRecord } from './embeddings';
import type { Candidate } from './schema';

/**
 * Candidate retrieval for link suggestions (PIPE-38). Pure: vectors in,
 * ranked earlier posts out.
 */

export interface RetrievalOptions {
  /** The pipeline slug (date-stripped) — the post itself is never a candidate. */
  ownSlug: string;
  /** ISO date of this post; only strictly-earlier-or-equal posts qualify. */
  ownDate: string;
  floor: number;
  topPosts: number;
  evidencePerPost: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += a[i] * b[i];
  }
  return sum;
}

function clip(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Records for posts that may be linked from this one. */
export function eligibleRecords(
  records: IndexRecord[],
  ownSlug: string,
  ownDate: string,
): IndexRecord[] {
  // The index keys posts by their dated stem; the pipeline slug has no date.
  const self = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${escapeRegExp(ownSlug)}$`);
  return records.filter(
    (r) =>
      !self.test(r.post_slug) &&
      r.post_slug !== ownSlug &&
      r.post_url.startsWith('https://') &&
      r.post_date !== '' &&
      r.post_date <= ownDate,
  );
}

/** Score every eligible post against the draft's windows. Highest first. */
export function scorePosts(
  windows: string[],
  windowVectors: Float32Array[],
  records: IndexRecord[],
  options: Pick<RetrievalOptions, 'ownSlug' | 'ownDate' | 'floor' | 'evidencePerPost'>,
): Candidate[] {
  const byPost = new Map<
    string,
    { record: IndexRecord; best: { w: number; c: IndexRecord; sim: number }[]; hits: Set<number> }
  >();

  for (const record of eligibleRecords(records, options.ownSlug, options.ownDate)) {
    const entry = byPost.get(record.post_slug) ?? { record, best: [], hits: new Set() };
    byPost.set(record.post_slug, entry);
    windowVectors.forEach((vector, w) => {
      const sim = dot(vector, record.embedding);
      if (sim >= options.floor) {
        entry.hits.add(w);
      }
      entry.best.push({ w, c: record, sim });
    });
    // Keep memory bounded: only the strongest pairs matter.
    entry.best.sort((a, b) => b.sim - a.sim);
    entry.best.length = Math.min(entry.best.length, 20);
  }

  const scored = [...byPost.values()].map((entry) => {
    const usedWindows = new Set<number>();
    const evidence: Candidate['evidence'] = [];
    for (const pair of entry.best) {
      if (evidence.length >= options.evidencePerPost) {
        break;
      }
      if (usedWindows.has(pair.w) || pair.sim < options.floor) {
        continue;
      }
      usedWindows.add(pair.w);
      evidence.push({
        passage: clip(windows[pair.w]),
        earlier: clip(pair.c.text),
        similarity: Number(pair.sim.toFixed(3)),
      });
    }
    const candidate: Candidate & { hits: number } = {
      slug: entry.record.post_slug,
      title: entry.record.post_title,
      date: entry.record.post_date,
      url: entry.record.post_url,
      excerpt: entry.record.post_excerpt,
      score: entry.best[0]?.sim ?? 0,
      evidence,
      hits: entry.hits.size,
    };
    return candidate;
  });

  scored.sort((a, b) => b.score - a.score || b.hits - a.hits);
  return scored.map(({ hits: _hits, ...rest }) => rest);
}

export interface Chosen {
  mode: 'evidence' | 'catalogue' | 'none';
  candidates: Candidate[];
}

/**
 * Decide what Haiku sees. Posts clearing the floor (top N) are given with
 * evidence; if fewer than `minCandidates` clear it, the whole eligible
 * catalogue is offered instead (when the fallback is on), keeping evidence for
 * the ones that had some.
 */
export function chooseCandidates(
  scored: Candidate[],
  options: Pick<RetrievalOptions, 'floor' | 'topPosts'> & {
    minCandidates: number;
    catalogueFallback: boolean;
  },
): Chosen {
  const strong = scored.filter((c) => c.score >= options.floor);
  if (strong.length >= options.minCandidates) {
    return { mode: 'evidence', candidates: strong.slice(0, options.topPosts) };
  }
  if (options.catalogueFallback && scored.length > 0) {
    const byDate = [...scored].sort((a, b) => (a.date < b.date ? 1 : -1));
    return { mode: 'catalogue', candidates: byDate };
  }
  return strong.length > 0
    ? { mode: 'evidence', candidates: strong.slice(0, options.topPosts) }
    : { mode: 'none', candidates: [] };
}

/** Retrieval settings from config. */
export function retrievalDefaults(): Pick<
  RetrievalOptions,
  'floor' | 'topPosts' | 'evidencePerPost'
> & { minCandidates: number; catalogueFallback: boolean } {
  return {
    floor: LINKS.retrieval.floor,
    topPosts: LINKS.retrieval.topPosts,
    evidencePerPost: LINKS.retrieval.evidencePerPost,
    minCandidates: LINKS.retrieval.minCandidates,
    catalogueFallback: LINKS.catalogueFallback,
  };
}
