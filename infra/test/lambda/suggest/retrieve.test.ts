import type { IndexRecord } from '../../../lambda/suggest/embeddings';
import {
  chooseCandidates,
  eligibleRecords,
  retrievalDefaults,
  scorePosts,
} from '../../../lambda/suggest/retrieve';

function unit(values: number[]): Float32Array {
  const norm = Math.sqrt(values.reduce((s, v) => s + v * v, 0));
  return new Float32Array(values.map((v) => v / norm));
}

function record(slug: string, date: string, vector: number[], text = `${slug} text`): IndexRecord {
  return {
    id: `${slug}:0`,
    post_slug: slug,
    post_title: `Title of ${slug}`,
    post_date: date,
    post_url: `https://blog.nakomis.com/${slug}`,
    post_excerpt: 'excerpt',
    heading: '',
    text,
    embedding: unit(vector),
  };
}

const OPTIONS = { ownSlug: 'my-post', ownDate: '2026-10-18', floor: 0.5, evidencePerPost: 2 };

describe('eligibleRecords', () => {
  const records = [
    record('2026-10-01-earlier', '2026-10-01', [1, 0]),
    record('2026-10-18-same-day', '2026-10-18', [1, 0]),
    record('2026-10-25-later', '2026-10-25', [1, 0]),
    record('2026-10-18-my-post', '2026-10-18', [1, 0]),
    { ...record('2026-09-01-no-url', '2026-09-01', [1, 0]), post_url: '' },
    record('2026-09-02-no-date', '', [1, 0]),
  ];

  test('keeps earlier and same-day posts, drops later, self, undated and URL-less ones', () => {
    expect(eligibleRecords(records, 'my-post', '2026-10-18').map((r) => r.post_slug)).toEqual([
      '2026-10-01-earlier',
      '2026-10-18-same-day',
    ]);
  });

  test('self-exclusion matches the dated stem of the date-stripped slug exactly', () => {
    const near = [record('2026-10-17-not-my-post', '2026-10-17', [1, 0])];
    expect(eligibleRecords(near, 'my-post', '2026-10-18')).toHaveLength(1);
  });
});

describe('scorePosts', () => {
  const records = [
    record('2026-10-01-close', '2026-10-01', [1, 0], 'the earlier passage'),
    record('2026-10-02-far', '2026-10-02', [0, 1]),
  ];
  const windows = ['a window about the cabal', 'another window'];
  const vectors = [unit([1, 0.1]), unit([1, 0])];

  test('ranks by best similarity and records evidence above the floor', () => {
    const scored = scorePosts(windows, vectors, records, OPTIONS);
    expect(scored.map((c) => c.slug)).toEqual(['2026-10-01-close', '2026-10-02-far']);
    expect(scored[0].score).toBeGreaterThan(0.9);
    expect(scored[0].evidence.length).toBeGreaterThan(0);
    expect(scored[0].evidence[0]).toMatchObject({
      passage: expect.stringContaining('window'),
      earlier: 'the earlier passage',
    });
    expect(scored[1].evidence).toEqual([]);
  });

  test('uses one evidence passage per window and honours evidencePerPost', () => {
    const scored = scorePosts(windows, vectors, records, { ...OPTIONS, evidencePerPost: 1 });
    expect(scored[0].evidence).toHaveLength(1);
  });

  test('truncates long passages', () => {
    const long = [record('2026-10-01-long', '2026-10-01', [1, 0], 'x'.repeat(900))];
    const scored = scorePosts(['y'.repeat(900)], [unit([1, 0])], long, OPTIONS);
    expect(scored[0].evidence[0].earlier.endsWith('…')).toBe(true);
  });
});

describe('chooseCandidates', () => {
  const cand = (slug: string, score: number, date = '2026-10-01') => ({
    slug,
    title: slug,
    date,
    url: `https://blog.nakomis.com/${slug}`,
    excerpt: '',
    score,
    evidence: [],
  });
  const base = { floor: 0.5, topPosts: 2, minCandidates: 2, catalogueFallback: true };

  test('evidence mode when enough posts clear the floor, capped at topPosts', () => {
    const out = chooseCandidates([cand('a', 0.9), cand('b', 0.8), cand('c', 0.7)], base);
    expect(out.mode).toBe('evidence');
    expect(out.candidates.map((c) => c.slug)).toEqual(['a', 'b']);
  });

  test('falls back to the whole catalogue, newest first, when too few clear the floor', () => {
    const out = chooseCandidates(
      [cand('a', 0.9, '2026-01-01'), cand('b', 0.1, '2026-05-01')],
      base,
    );
    expect(out.mode).toBe('catalogue');
    expect(out.candidates.map((c) => c.slug)).toEqual(['b', 'a']);
  });

  test('without the fallback, one strong candidate is still used', () => {
    const out = chooseCandidates([cand('a', 0.9), cand('b', 0.1)], {
      ...base,
      catalogueFallback: false,
    });
    expect(out).toEqual({ mode: 'evidence', candidates: [expect.objectContaining({ slug: 'a' })] });
  });

  test('none when nothing is eligible or nothing is strong without the fallback', () => {
    expect(chooseCandidates([], base).mode).toBe('none');
    expect(
      chooseCandidates([cand('b', 0.1)], { ...base, catalogueFallback: false }).mode,
    ).toBe('none');
  });

  test('retrievalDefaults come from config', () => {
    expect(retrievalDefaults().topPosts).toBeGreaterThan(0);
  });
});
