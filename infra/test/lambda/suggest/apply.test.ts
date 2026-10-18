import { applyLinkSuggestions, mergeDecisions, undecidedAffiliates, undecidedCount } from '../../../lambda/suggest/apply';
import type { Suggestions } from '../../../lambda/suggest/schema';

const URL_A = 'https://blog.nakomis.com/2026-07-29-cabal';
const URL_B = 'https://blog.nakomis.com/2026-05-01-other';
const link = (id: string, anchorText: string, targetUrl: string) => ({ id, anchorText, targetUrl });

const FM = '---\ntitle: "Cabal talk"\ndate: "2026-10-18"\n---\n';

describe('applyLinkSuggestions', () => {
  test('replaces the anchor with a Markdown link and leaves everything else untouched', () => {
    const md = `${FM}\nI asked the Cabal what it thought.\n\nSecond   paragraph, with  odd spacing.\n`;
    const out = applyLinkSuggestions(md, [link('a', 'the Cabal', URL_A)]);
    expect(out.markdown).toBe(md.replace('the Cabal', `[the Cabal](${URL_A})`));
    expect(out.applied).toEqual(['a']);
    expect(out.skipped).toEqual([]);
  });

  test('never touches the frontmatter, even if the anchor appears there', () => {
    const md = '---\ntitle: "the Cabal"\n---\n\nSay the Cabal.\n';
    const out = applyLinkSuggestions(md, [link('a', 'the Cabal', URL_A)]);
    expect(out.markdown.startsWith('---\ntitle: "the Cabal"\n---\n')).toBe(true);
    expect(out.markdown).toContain(`Say [the Cabal](${URL_A}).`);
  });

  test('applies several links right to left so offsets stay valid', () => {
    const md = 'First the Cabal here.\n\nThen another post there.\n';
    const out = applyLinkSuggestions(md, [
      link('b', 'another post', URL_B),
      link('a', 'the Cabal', URL_A),
    ]);
    expect(out.markdown).toBe(
      `First [the Cabal](${URL_A}) here.\n\nThen [another post](${URL_B}) there.\n`,
    );
    expect(out.applied.sort()).toEqual(['a', 'b']);
  });

  test('handles Unicode and adjacent punctuation', () => {
    const out = applyLinkSuggestions('Café “the Cabal”, naïve.', [link('a', 'the Cabal', URL_A)]);
    expect(out.markdown).toBe(`Café “[the Cabal](${URL_A})”, naïve.`);
  });

  test('is idempotent: a second run reports the link as already applied', () => {
    const once = applyLinkSuggestions('The Cabal.', [link('a', 'The Cabal', URL_A)]);
    const twice = applyLinkSuggestions(once.markdown, [link('a', 'The Cabal', URL_A)]);
    expect(twice.markdown).toBe(once.markdown);
    expect(twice.skipped).toEqual([{ id: 'a', reason: 'already linked' }]);
  });

  test.each([
    ['anchor gone', 'Nothing here.', 'no longer in the post'],
    ['anchor twice', 'the Cabal, the Cabal', 'more than once'],
    ['anchor now in a heading', '# the Cabal\n', 'inside a heading'],
    ['anchor now in code', 'use `the Cabal`', 'inside a heading'],
    ['target already linked', `the Cabal and ${URL_A}`, 'already links'],
    ['target linked over http with a trailing slash', 'the Cabal and [x](http://blog.nakomis.com/2026-07-29-cabal/)', 'already links'],
    ['target linked root-relative', 'the Cabal and [x](/2026-07-29-cabal)', 'already links'],
    ['anchor edited into a longer word', 'Cabalistic ideas', 'middle of a word'],
  ])('skips, never forces: %s', (_name, md, reason) => {
    const out = applyLinkSuggestions(md, [link('a', md.startsWith('Cabalistic') ? 'Cabal' : 'the Cabal', URL_A)]);
    expect(out.markdown).toBe(md);
    expect(out.applied).toEqual([]);
    expect(out.skipped[0].reason).toContain(reason);
  });

  test('skips overlapping anchors and a second link to the same target', () => {
    const overlap = applyLinkSuggestions('about the Cabal panel', [
      link('a', 'the Cabal', URL_A),
      link('b', 'Cabal panel', URL_B),
    ]);
    expect(overlap.applied).toEqual(['a']);
    expect(overlap.skipped[0].reason).toContain('overlaps');

    const sameTarget = applyLinkSuggestions('one thing and another thing', [
      link('a', 'one thing', URL_A),
      link('b', 'another thing', URL_A),
    ]);
    expect(sameTarget.applied).toEqual(['a']);
    expect(sameTarget.skipped[0].reason).toContain('that target');
  });
});

function suggestions(over: Partial<Suggestions> = {}): Suggestions {
  const l = (id: string, decision: 'pending' | 'accepted' | 'rejected') => ({
    id,
    kind: 'link' as const,
    anchorText: id,
    context: '',
    targetSlug: 's',
    targetTitle: 't',
    targetUrl: 'u',
    targetDate: 'd',
    occurrence: { paragraph: 0, offset: 0 },
    reason: '',
    decision,
  });
  return {
    version: 1,
    slug: 'p',
    iteration: 1,
    generatedAt: 'now',
    status: 'ok',
    models: { chat: 'c', embed: 'e' },
    links: [l('a', 'pending'), l('b', 'pending')],
    repos: [],
    dropped: [],
    ...over,
  };
}

describe('mergeDecisions', () => {
  test('keeps decisions for suggestions that regenerate with the same id', () => {
    const previous = suggestions();
    previous.links[0].decision = 'accepted';
    previous.links[1].decision = 'rejected';
    const next = suggestions({ iteration: 3 });
    next.links.push({ ...next.links[0], id: 'new' });
    const merged = mergeDecisions(previous, next);
    expect(merged.iteration).toBe(3);
    expect(merged.links.map((l) => l.decision)).toEqual(['accepted', 'rejected', 'pending']);
  });

  test('is a no-op without a previous file, and carries repo decisions', () => {
    const next = suggestions();
    expect(mergeDecisions(null, next)).toBe(next);
    const repo = {
      id: 'r', kind: 'repo' as const, fullName: 'o/r', name: 'r', url: 'u', description: null,
      evidence: '', reason: '', source: 'llm' as const, decision: 'pending' as const,
    };
    const prev = suggestions({ repos: [{ ...repo, decision: 'accepted' }] });
    expect(mergeDecisions(prev, suggestions({ repos: [repo] })).repos[0].decision).toBe('accepted');
  });
});

test('undecidedCount counts pending links and repos', () => {
  const s = suggestions();
  s.links[0].decision = 'accepted';
  expect(undecidedCount(s)).toBe(1);
});

describe('applyLinkSuggestions with a locator (PIPE-41)', () => {
  const AMZ = 'https://www.amazon.co.uk/dp/B0F4D8ZY6L?tag=nakomis-bconn7-21';
  const md = `${FM}\nI printed on the Mars 5 Ultra today.\n\nThe Mars 5 Ultra was loud. Then the Mars 5 Ultra jammed.\n`;
  const aff = (before: string, after: string, over = {}) => ({
    id: 'p',
    anchorText: 'Mars 5 Ultra',
    targetUrl: AMZ,
    locator: { before, after },
    ...over,
  });

  test('links the right one of several identical anchors', () => {
    const out = applyLinkSuggestions(md, [aff('I printed on the ', ' today.')]);
    expect(out.skipped).toEqual([]);
    expect(out.markdown).toBe(md.replace('on the Mars 5 Ultra today', `on the [Mars 5 Ultra](${AMZ}) today`));
  });

  test('skips when the locator is gone or ambiguous', () => {
    const gone = applyLinkSuggestions(md, [aff('I printed on a ', ' today.')]);
    expect(gone.applied).toEqual([]);
    expect(gone.skipped[0].reason).toMatch(/text around the anchor has changed/);
    const ambiguous = applyLinkSuggestions(md, [aff('the ', ' ')]);
    expect(ambiguous.applied).toEqual([]);
    expect(ambiguous.skipped[0].reason).toMatch(/text around the anchor has changed/);
  });

  test('without a locator behaviour is unchanged: repeated anchors are skipped', () => {
    const out = applyLinkSuggestions(md, [aff('', '', { locator: undefined })]);
    expect(out.skipped[0].reason).toMatch(/more than once/);
  });

  test('applies an affiliate link and a post link together, and is idempotent', () => {
    const both = `${FM}\nI asked the Cabal, then printed on the Mars 5 Ultra today.\n`;
    const out = applyLinkSuggestions(both, [
      link('a', 'the Cabal', URL_A),
      aff('then printed on the ', ' today.'),
    ]);
    expect(out.markdown).toContain(`[the Cabal](${URL_A})`);
    expect(out.markdown).toContain(`[Mars 5 Ultra](${AMZ})`);
    const again = applyLinkSuggestions(out.markdown, [aff('then printed on the ', ' today.')]);
    expect(again.applied).toEqual([]);
  });

  test('still refuses a protected or overlapping anchor', () => {
    const code = `${FM}\nUse \`Mars 5 Ultra\` here.\n`;
    const out = applyLinkSuggestions(code, [aff('Use `', '` here.')]);
    expect(out.applied).toEqual([]);
  });
});

describe('mergeDecisions for affiliates (PIPE-41)', () => {
  const mention = (over = {}) => ({
    id: 'm1',
    kind: 'affiliate' as const,
    anchorText: 'Mars',
    productName: 'Mars',
    quote: 'Mars.',
    before: '',
    after: '',
    occurrence: { paragraph: 0, offset: 0 },
    reason: '',
    decision: 'pending' as const,
    ...over,
  });

  test('carries decision, url and warnings across a regeneration, and the tracking id', () => {
    const previous = suggestions({
      affiliates: [mention({ decision: 'linked', url: 'https://u', warnings: ['w'] })],
      trackingId: 'nakomis-x-21',
    });
    const next = suggestions({ affiliates: [mention(), mention({ id: 'm2' })] });
    const merged = mergeDecisions(previous, next);
    expect(merged.affiliates?.[0]).toMatchObject({ decision: 'linked', url: 'https://u', warnings: ['w'] });
    expect(merged.affiliates?.[1].decision).toBe('pending');
    expect(merged.trackingId).toBe('nakomis-x-21');
  });

  test('undecidedAffiliates counts pending mentions, and copes with none', () => {
    expect(undecidedAffiliates(suggestions())).toBe(0);
    expect(
      undecidedAffiliates(
        suggestions({ affiliates: [mention(), mention({ id: 'b', decision: 'skipped' })] }),
      ),
    ).toBe(1);
  });
});
