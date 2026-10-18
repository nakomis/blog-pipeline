import { repoId, linkId, normalisePicks, validateLinks, validateRepos } from '../../../lambda/suggest/validate';
import { Picks } from '../../../lambda/suggest/schema';
import type { Candidate, LinkPick, RepoInfo, RepoPick } from '../../../lambda/suggest/schema';

const CABAL: Candidate = {
  slug: '2026-07-29-three-of-them-didnt-know-what-they-were',
  title: 'Three of Seven AIs Didn’t Know What They Were',
  date: '2026-07-29',
  url: 'https://blog.nakomis.com/2026-07-29-three-of-them-didnt-know-what-they-were',
  excerpt: 'A panel of models asked who they were.',
  score: 0.8,
  evidence: [],
};
const OTHER: Candidate = {
  ...CABAL,
  slug: '2026-05-01-other',
  title: 'Other',
  url: 'https://blog.nakomis.com/2026-05-01-other',
};

const pick = (anchor: string, over: Partial<LinkPick> = {}): LinkPick => ({
  anchor_text: anchor,
  target_slug: CABAL.slug,
  same_subject: true,
  reason: 'Refers to the cabal post.',
  ...over,
});

const run = (body: string, picks: LinkPick[], maxLinks = 5) =>
  validateLinks({ picks, body, candidates: [CABAL, OTHER], maxLinks });

describe('validateLinks', () => {
  test('accepts a clean pick and builds the suggestion from the candidate, not the model', () => {
    const body = 'I asked the Cabal what it thought.';
    const { accepted, dropped } = run(body, [pick('the Cabal')]);
    expect(dropped).toEqual([]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      kind: 'link',
      anchorText: 'the Cabal',
      targetUrl: CABAL.url,
      targetTitle: CABAL.title,
      targetDate: CABAL.date,
      decision: 'pending',
      occurrence: { paragraph: 0, offset: 8 },
      id: linkId('the Cabal', CABAL.slug),
    });
    expect(accepted[0].context).toContain('the Cabal');
  });

  test('drops a pick the model itself flagged as a different subject (the Alexa false positive)', () => {
    const body = 'I ran a final review on the most capable model.';
    const { accepted, dropped } = run(body, [
      pick('final review on the most capable model', { same_subject: false }),
    ]);
    expect(accepted).toEqual([]);
    expect(dropped[0].reason).toContain('not sure');
  });

  test.each([
    ['unknown target', 'See the Cabal.', pick('the Cabal', { target_slug: 'invented' }), 'candidate list'],
    ['anchor absent', 'Nothing here.', pick('the Cabal'), 'does not appear'],
    ['anchor twice', 'the Cabal and the Cabal', pick('the Cabal'), '2 times'],
    ['too short', 'a b', pick('a'), '2 to 80'],
    ['too many words', 'one two three four five six seven', pick('one two three four five six seven'), 'at most 6'],
    ['brackets', 'see [x] now', pick('[x]'), 'brackets'],
    ['mid-word start', 'theCabal', pick('Cabal'), 'middle of a word'],
    ['mid-word end', 'Cabalistic', pick('Cabal'), 'middle of a word'],
    ['heading', '# The Cabal\n\ntext', pick('The Cabal'), 'heading'],
    ['fenced code', '```\nthe Cabal\n```', pick('the Cabal'), 'inside'],
    ['inline code', 'use `the Cabal` here', pick('the Cabal'), 'inside'],
    ['existing link', 'see [the Cabal](https://x.test)', pick('the Cabal'), 'inside'],
    ['shortcode', '{{image prompt="the Cabal"}}', pick('the Cabal'), 'inside'],
    ['target already linked', `x the Cabal ${CABAL.url}`, pick('the Cabal'), 'already links'],
    [
      'target already linked over http with a trailing slash',
      'x the Cabal [t](http://blog.nakomis.com/2026-07-29-three-of-them-didnt-know-what-they-were/)',
      pick('the Cabal'),
      'already links',
    ],
    [
      'target already linked root-relative',
      'x the Cabal [t](/2026-07-29-three-of-them-didnt-know-what-they-were)',
      pick('the Cabal'),
      'already links',
    ],
  ])('drops: %s', (_name, body, p, reason) => {
    const { accepted, dropped } = run(body, [p]);
    expect(accepted).toEqual([]);
    expect(dropped[0].reason).toContain(reason);
  });

  test('allows an anchor at the very start or end of the body and next to punctuation', () => {
    expect(run('The Cabal, again.', [pick('The Cabal')]).accepted).toHaveLength(1);
    expect(run('I love the Cabal', [pick('the Cabal')]).accepted).toHaveLength(1);
  });

  test('keeps one link per target (the first by document order)', () => {
    const body = 'First the Cabal appears.\n\nThen later the panel appears.';
    const { accepted, dropped } = run(body, [pick('the panel'), pick('the Cabal')]);
    expect(accepted.map((a) => a.anchorText)).toEqual(['the Cabal']);
    expect(dropped[0].reason).toContain('one link per target');
  });

  test('allows one link to each of two different targets', () => {
    const body = 'The Cabal one.\n\nThe other post.';
    const { accepted } = run(body, [
      pick('The Cabal'),
      pick('The other post', { target_slug: OTHER.slug }),
    ]);
    expect(accepted).toHaveLength(2);
  });

  test('allows only one new link per paragraph', () => {
    const body = 'The Cabal and the other post in one paragraph.';
    const { accepted, dropped } = run(body, [
      pick('The Cabal'),
      pick('the other post', { target_slug: OTHER.slug }),
    ]);
    expect(accepted).toHaveLength(1);
    expect(dropped[0].reason).toContain('per paragraph');
  });

  test('applies the density cap in document order', () => {
    const body = 'The Cabal one.\n\nThe other post.';
    const { accepted, dropped } = run(
      body,
      [pick('The other post', { target_slug: OTHER.slug }), pick('The Cabal')],
      1,
    );
    expect(accepted.map((a) => a.anchorText)).toEqual(['The Cabal']);
    expect(dropped[0].reason).toContain('density cap');
  });

  test('drops overlapping anchors', () => {
    const body = 'about the Cabal panel today';
    const { accepted, dropped } = run(body, [
      pick('the Cabal panel'),
      pick('Cabal panel', { target_slug: OTHER.slug }),
    ]);
    expect(accepted).toHaveLength(1);
    expect(dropped[0].reason).toMatch(/overlaps|per paragraph/);
  });

  test('the id is stable for the same anchor and target', () => {
    expect(linkId('a', 'b')).toBe(linkId('a', 'b'));
    expect(linkId('a', 'b')).not.toBe(linkId('a', 'c'));
    expect(linkId('a', 'b')).toHaveLength(12);
  });
});

const repo = (name: string, over: Partial<RepoInfo> = {}): RepoInfo => ({
  owner: 'nakomis',
  name,
  fullName: `nakomis/${name}`,
  url: `https://github.com/nakomis/${name}`,
  description: `${name} does things`,
  private: false,
  fork: false,
  ...over,
});
const rpick = (fullName: string, quote: string): RepoPick => ({
  full_name: fullName,
  evidence_quote: quote,
  reason: 'The post is about it.',
});

const repoRun = (
  body: string,
  picks: RepoPick[],
  over: Partial<Parameters<typeof validateRepos>[0]> = {},
) =>
  validateRepos({
    picks,
    body,
    repos: [repo('mcps'), repo('nakotp'), repo('secret', { private: true }), repo('forked', { fork: true })],
    existingFullNames: [],
    urlsInPost: [],
    excludeForks: true,
    maxRepos: 5,
    ...over,
  });

describe('validateRepos', () => {
  const body = 'I put the Alexa tool in mcps this week. It speaks through the Echo.';

  test('accepts a named public repo, taking name and URL from the list', () => {
    const { accepted, dropped } = repoRun(body, [rpick('nakomis/mcps', 'I put the Alexa tool in mcps this week.')]);
    expect(dropped).toEqual([]);
    expect(accepted[0]).toMatchObject({
      kind: 'repo',
      name: 'mcps',
      url: 'https://github.com/nakomis/mcps',
      source: 'llm',
      decision: 'pending',
      id: repoId('nakomis/mcps'),
    });
  });

  test.each([
    ['not on the list', rpick('nakomis/invented', 'mcps'), 'not on the list'],
    ['private (re-checked)', rpick('nakomis/secret', 'mcps'), 'not public'],
    ['a fork', rpick('nakomis/forked', 'mcps'), 'fork'],
    ['never named in the post', rpick('nakomis/nakotp', 'the Echo'), 'never names'],
    ['quote not in the post', rpick('nakomis/mcps', 'a sentence I made up'), 'not in the post'],
  ])('drops: %s', (_name, p, reason) => {
    const { accepted, dropped } = repoRun(`${body} secret forked nakotp`.replace('nakotp', 'x'), [p]);
    expect(accepted).toEqual([]);
    expect(dropped[0].reason).toContain(reason);
  });

  test('drops a repo already in the frontmatter, case-insensitively', () => {
    const { accepted, dropped } = repoRun(body, [rpick('nakomis/mcps', 'the Alexa tool in mcps')], {
      existingFullNames: ['Nakomis/MCPS'],
    });
    expect(accepted).toEqual([]);
    expect(dropped[0].reason).toContain('already listed');
  });

  test('a repo made private since listing never slips through', () => {
    const { accepted, dropped } = repoRun(body, [rpick('nakomis/mcps', 'the Alexa tool in mcps')], {
      repos: [repo('mcps', { private: true })],
    });
    expect(accepted).toEqual([]);
    expect(dropped[0].reason).toContain('not public');
  });

  test('forks are allowed when excludeForks is off', () => {
    const { accepted } = repoRun('The forked repo is mine.', [rpick('nakomis/forked', 'The forked repo is mine')], {
      excludeForks: false,
    });
    expect(accepted).toHaveLength(1);
  });

  test('adds repos whose GitHub URL is in the post, without the model', () => {
    const { accepted } = repoRun('See https://github.com/nakomis/nakotp for it.', [], {
      urlsInPost: ['nakomis/nakotp', 'nakomis/unknown'],
    });
    expect(accepted).toEqual([
      expect.objectContaining({ fullName: 'nakomis/nakotp', source: 'url-in-post' }),
    ]);
  });

  test('does not duplicate a repo the model also picked, nor one already listed', () => {
    const both = repoRun(
      'See https://github.com/nakomis/mcps in mcps.',
      [rpick('nakomis/mcps', 'See https://github.com/nakomis/mcps in mcps.')],
      { urlsInPost: ['nakomis/mcps'] },
    );
    expect(both.accepted).toHaveLength(1);
    const listed = repoRun('x', [], { urlsInPost: ['nakomis/mcps'], existingFullNames: ['nakomis/mcps'] });
    expect(listed.accepted).toEqual([]);
  });

  test('caps the number of repos', () => {
    const { accepted, dropped } = repoRun('mcps nakotp', [], {
      urlsInPost: ['nakomis/mcps', 'nakomis/nakotp'],
      maxRepos: 1,
    });
    expect(accepted).toHaveLength(1);
    expect(dropped[0].reason).toContain('more than 1');
  });
});

describe('Picks schema', () => {
  test('treats an omitted list as empty rather than failing the whole answer', () => {
    expect(Picks.parse({ links: [] })).toEqual({ links: [], repos: [] });
    expect(Picks.parse({})).toEqual({ links: [], repos: [] });
  });

  test('still rejects structurally malformed picks', () => {
    expect(() => Picks.parse({ links: [{ anchor_text: 'x' }] })).toThrow();
  });

  test('does not reject an answer for being long, short or over the counts', () => {
    const many = Array.from({ length: 30 }, () => ({
      anchor_text: 'a', target_slug: 's', same_subject: true, reason: 'y'.repeat(900),
    }));
    expect(Picks.parse({ links: many }).links).toHaveLength(30);
    expect(Picks.parse({ links: [{ anchor_text: '', target_slug: 's', same_subject: true }] }).links[0].reason).toBe('');
  });
});

describe('normalisePicks', () => {
  const link = (n: number, reason = 'r') => ({
    anchor_text: `anchor ${n}`, target_slug: 's', same_subject: true, reason,
  });
  const repo = (n: number, reason = 'r') => ({
    full_name: `o/r${n}`, evidence_quote: 'q', reason,
  });

  test('trims an oversized answer to the limits and reports the excess', () => {
    const picks = {
      links: Array.from({ length: 14 }, (_, i) => link(i)),
      repos: Array.from({ length: 8 }, (_, i) => repo(i)),
    };
    const out = normalisePicks(picks, { maxLinks: 10, maxRepos: 5 });
    expect(out.picks.links).toHaveLength(10);
    expect(out.picks.repos).toHaveLength(5);
    expect(out.picks.links[9].anchor_text).toBe('anchor 9');
    expect(out.dropped).toHaveLength(7);
    expect(out.dropped[0]).toMatchObject({ kind: 'link', value: 'anchor 10' });
    expect(out.dropped[4].reason).toContain('more than 5 repositories');
  });

  test('truncates a long reason and fills a missing one', () => {
    const out = normalisePicks(
      { links: [link(1, 'x'.repeat(500)), link(2, '   ')], repos: [repo(1, '')] },
      { maxLinks: 10, maxRepos: 5 },
    );
    expect(out.picks.links[0].reason).toHaveLength(300);
    expect(out.picks.links[0].reason.endsWith('…')).toBe(true);
    expect(out.picks.links[1].reason).toBe('No reason given.');
    expect(out.picks.repos[0].reason).toBe('No reason given.');
  });

  test('leaves a within-limits answer alone', () => {
    const picks = { links: [link(1)], repos: [repo(1)] };
    const out = normalisePicks(picks, { maxLinks: 10, maxRepos: 5 });
    expect(out.picks).toEqual(picks);
    expect(out.dropped).toEqual([]);
  });
});
