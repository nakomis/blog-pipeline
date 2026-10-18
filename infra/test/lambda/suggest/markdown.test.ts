import {
  contextAround,
  crossesWordBoundary,
  linksTo,
  occurrences,
  overlapsRange,
  paragraphIndex,
  parseFrontmatterFacts,
  protectedRanges,
  splitFrontmatter,
  windowsOf,
  wordCount,
} from '../../../lambda/suggest/markdown';

const POST = `---
title: "A post"
date: "2026-10-18"
publish_date: "2026-10-25"
repos:
  - name: "mcps"
    url: "https://github.com/nakomis/mcps"
  - name: "blog-pipeline"
    url: "https://github.com/nakomis/blog-pipeline.git"
approved: true
---

Body text.
`;

describe('splitFrontmatter', () => {
  test('splits head, frontmatter and body without losing a byte', () => {
    const out = splitFrontmatter(POST);
    expect(out.frontmatter).toContain('title: "A post"');
    expect(out.body.trim()).toBe('Body text.');
    expect(out.head + out.body).toBe(POST);
  });

  test('returns the whole text as the body when there is no frontmatter', () => {
    expect(splitFrontmatter('Just text')).toEqual({
      head: '',
      frontmatter: null,
      body: 'Just text',
    });
  });

  test('tolerates CRLF', () => {
    const out = splitFrontmatter('---\r\ntitle: x\r\n---\r\nBody');
    expect(out.frontmatter).toBe('title: x');
    expect(out.body).toBe('Body');
  });

  test('an unterminated block is not frontmatter', () => {
    expect(splitFrontmatter('---\ntitle: x\nBody').frontmatter).toBeNull();
  });
});

describe('parseFrontmatterFacts', () => {
  test('reads dates and existing repos', () => {
    const facts = parseFrontmatterFacts(splitFrontmatter(POST).frontmatter);
    expect(facts.date).toBe('2026-10-18');
    expect(facts.publishDate).toBe('2026-10-25');
    expect(facts.repoFullNames).toEqual(['nakomis/mcps', 'nakomis/blog-pipeline']);
    expect(facts.repoUrls).toContain('https://github.com/nakomis/blog-pipeline');
  });

  test('copes with no frontmatter or no repos', () => {
    expect(parseFrontmatterFacts(null)).toEqual({ repoFullNames: [], repoUrls: [] });
    expect(parseFrontmatterFacts('title: x\ndate: 2026-01-02').date).toBe('2026-01-02');
    expect(parseFrontmatterFacts('title: x').repoUrls).toEqual([]);
  });

  test('stops reading repos at the next top-level key', () => {
    const facts = parseFrontmatterFacts(
      'repos:\n  - name: "a"\n    url: "https://github.com/o/a"\ncanonical: "https://github.com/o/not-a-repo"',
    );
    expect(facts.repoFullNames).toEqual(['o/a']);
  });
});

describe('protectedRanges', () => {
  const protectedText = (body: string): string[] =>
    protectedRanges(body).map(([s, e]) => body.slice(s, e));

  test.each([
    ['fenced code', 'Before\n```ts\nconst cabal = 1;\n```\nAfter', 'const cabal'],
    ['tilde fences', 'x\n~~~\ncabal\n~~~\ny', 'cabal'],
    ['inline code', 'Use `the cabal` here', '`the cabal`'],
    ['headings', '# The Cabal\n\ntext', '# The Cabal'],
    ['links', 'See [the cabal](https://x.test) now', '[the cabal](https://x.test)'],
    ['images', '![the cabal](img.png)', '![the cabal](img.png)'],
    ['reference links', 'See [the cabal][1]', '[the cabal][1]'],
    ['reference definitions', 'x\n[1]: https://x.test\ny', '[1]: https://x.test'],
    ['autolinks', 'Go <https://x.test/cabal> now', '<https://x.test/cabal>'],
    ['bare URLs', 'Go https://x.test/cabal now', 'https://x.test/cabal'],
    ['HTML tags', 'a <span class="cabal">b</span>', '<span class="cabal">'],
    ['image placeholders', 'x {{image prompt="the cabal"}} y', '{{image prompt="the cabal"}}'],
    ['donate shortcodes', 'x {{donate}} y', '{{donate}}'],
  ])('protects %s', (_name, body, expected) => {
    expect(protectedText(body).join('|')).toContain(expected);
  });

  test('an unterminated fence protects to the end', () => {
    const body = 'a\n```\ncode forever';
    const ranges = protectedRanges(body);
    expect(ranges[0][1]).toBe(body.length);
  });

  test('merges overlapping ranges and leaves prose alone', () => {
    const body = 'plain [a `b` c](u) plain';
    expect(protectedRanges(body)).toHaveLength(1);
    expect(overlapsRange(protectedRanges(body), 0, 5)).toBe(false);
    expect(overlapsRange(protectedRanges(body), 6, 8)).toBe(true);
  });
});

describe('occurrences, paragraphs, context, words', () => {
  test('occurrences finds every non-overlapping match', () => {
    expect(occurrences('aaaa', 'aa')).toEqual([0, 2]);
    expect(occurrences('abc', 'z')).toEqual([]);
    expect(occurrences('abc', '')).toEqual([]);
  });

  test('paragraphIndex counts blank-line separators', () => {
    const body = 'one\n\ntwo\n\nthree';
    expect(paragraphIndex(body, 0)).toBe(0);
    expect(paragraphIndex(body, body.indexOf('two'))).toBe(1);
    expect(paragraphIndex(body, body.indexOf('three'))).toBe(2);
  });

  test('contextAround flattens whitespace and marks truncation', () => {
    const body = `${'a '.repeat(100)}TARGET${' b'.repeat(100)}`;
    const start = body.indexOf('TARGET');
    const ctx = contextAround(body, start, start + 6, 10);
    expect(ctx.startsWith('…')).toBe(true);
    expect(ctx.endsWith('…')).toBe(true);
    expect(ctx).toContain('TARGET');
    expect(contextAround('short', 0, 5)).toBe('short');
  });

  test('wordCount ignores code fences and shortcodes', () => {
    expect(wordCount('one two\n```\nignored words here\n```\nthree {{image prompt="x y"}}')).toBe(3);
  });
});

describe('windowsOf', () => {
  test('merges short paragraphs up to the window size', () => {
    const body = 'First para.\n\nSecond para.\n\nThird para.';
    expect(windowsOf(body, 700, 80)).toEqual(['First para. Second para. Third para.']);
  });

  test('starts a new window when the next paragraph would overflow', () => {
    const p = 'x'.repeat(400);
    expect(windowsOf(`${p}\n\n${p}`, 700, 80)).toHaveLength(2);
  });

  test('splits an over-long paragraph at sentence ends', () => {
    const sentence = `${'word '.repeat(30).trim()}. `;
    const out = windowsOf(sentence.repeat(12), 300, 80);
    expect(out.length).toBeGreaterThan(1);
    expect(out.every((w) => w.length <= 400)).toBe(true);
  });

  test('drops fenced code and shortcodes, and caps the count', () => {
    const body = 'Prose.\n\n```\nsecret code\n```\n\n{{image prompt="x"}}\n\nMore prose.';
    expect(windowsOf(body, 700, 80).join(' ')).not.toContain('secret');
    const many = Array.from({ length: 10 }, () => 'y'.repeat(600)).join('\n\n');
    expect(windowsOf(many, 700, 3)).toHaveLength(3);
  });
});

describe('crossesWordBoundary', () => {
  test('flags a range that starts or ends inside a word', () => {
    expect(crossesWordBoundary('Cabalistic', 0, 5)).toBe(true);
    expect(crossesWordBoundary('theCabal', 3, 8)).toBe(true);
  });
  test('allows whole words, punctuation and the ends of the text', () => {
    expect(crossesWordBoundary('the Cabal, again', 4, 9)).toBe(false);
    expect(crossesWordBoundary('Cabal', 0, 5)).toBe(false);
    expect(crossesWordBoundary('“Cabal”', 1, 6)).toBe(false);
  });
});

describe('linksTo', () => {
  const url = 'https://blog.nakomis.com/2026-07-29-cabal';

  test.each([
    ['the exact URL in a link', `see [x](${url})`],
    ['http rather than https', 'see [x](http://blog.nakomis.com/2026-07-29-cabal)'],
    ['a trailing slash', `see [x](${url}/)`],
    ['different case', 'see [x](https://Blog.Nakomis.com/2026-07-29-CABAL)'],
    ['a fragment or query', `see [x](${url}#section)`],
    ['a root-relative link', 'see [x](/2026-07-29-cabal)'],
    ['a bare URL', `see ${url} now`],
    ['an autolink', `see <${url}>`],
  ])('detects %s', (_name, body) => {
    expect(linksTo(body, url)).toBe(true);
  });

  test.each([
    ['another post', 'see [x](https://blog.nakomis.com/2026-07-30-other)'],
    ['a longer slug sharing the prefix', 'see [x](https://blog.nakomis.com/2026-07-29-cabal-two)'],
    ['a different host', 'see [x](https://example.test/2026-07-29-cabal)'],
    ['a relative link to something else', 'see [x](/images/cabal.png)'],
    ['no links', 'just the Cabal'],
  ])('does not mistake %s', (_name, body) => {
    expect(linksTo(body, url)).toBe(false);
  });
});
