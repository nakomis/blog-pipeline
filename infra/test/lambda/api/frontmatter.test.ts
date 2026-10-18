import {
  buildFrontmatterInfo,
  checkFrontmatter,
  deriveSourceFile,
  parseFrontmatter,
  parseRepos,
  readFrontmatter,
  splitFrontmatter,
} from '../../../lambda/api/frontmatter';

const BASE = 'https://blog.example.test';

const POST = `---
title: "Raising Claude"
date: "2026-10-18"
excerpt: "A hook."
tags: ["claude-code", "bash"]
author: "Martin Harris"
canonical: "${BASE}/2026-10-18-raising-claude"
repos:
  - name: "claude-chats"
    url: "https://github.com/nakomis/claude-chats"
  - name: "mcps"
    url: "https://github.com/nakomis/mcps"
---

# Body
`;

describe('splitFrontmatter', () => {
  test('splits LF and CRLF', () => {
    expect(splitFrontmatter(POST)?.body).toBe('\n# Body\n');
    expect(splitFrontmatter(POST.replace(/\n/g, '\r\n'))?.raw).toContain('title:');
  });
  test('null without a block or when unterminated', () => {
    expect(splitFrontmatter('# Just a body')).toBeNull();
    expect(splitFrontmatter('---\ntitle: x\n')).toBeNull();
  });
  test('accepts a closing fence at the end of the file', () => {
    expect(splitFrontmatter('---\ntitle: x\n---')?.raw).toBe('title: x');
  });
});

describe('parseFrontmatter', () => {
  test('parses lists and keeps scalars as strings', () => {
    const r = parseFrontmatter(
      'date: 2026-10-18\napproved: true\ntags: ["a", "b"]\nrepos:\n  - name: n\n    url: u\n',
    );
    expect(r).toEqual({
      fields: {
        date: '2026-10-18',
        approved: 'true',
        tags: ['a', 'b'],
        repos: [{ name: 'n', url: 'u' }],
      },
    });
  });
  test('empty block is an empty mapping', () => {
    expect(parseFrontmatter('')).toEqual({ fields: {} });
  });
  test('reports invalid YAML and non-mappings', () => {
    expect('parseError' in parseFrontmatter('a: [unclosed')).toBe(true);
    expect(parseFrontmatter('- a\n- b')).toEqual({
      parseError: 'Frontmatter is not a set of key: value pairs',
    });
  });
});

describe('readFrontmatter', () => {
  test('absent, invalid and valid', () => {
    expect(readFrontmatter('body')).toEqual({ present: false, raw: null, fields: null });
    expect(readFrontmatter('---\na: [x\n---\n').parseError).toBeDefined();
    expect(readFrontmatter(POST).fields?.title).toBe('Raising Claude');
  });
});

describe('parseRepos', () => {
  test('normalises and flags malformed entries', () => {
    expect(parseRepos(null)).toEqual({ repos: [], malformed: false });
    expect(parseRepos({ repos: 'x' })).toEqual({ repos: [], malformed: true });
    const r = parseRepos({
      repos: [{ name: 'a', url: ' https://github.com/o/a ' }, { name: 'b' }, 'c'],
    });
    expect(r.repos).toEqual([{ name: 'a', url: 'https://github.com/o/a' }]);
    expect(r.malformed).toBe(true);
    expect(parseRepos({ repos: [] }).malformed).toBe(false);
  });
});

describe('deriveSourceFile', () => {
  test('prefers the stored value', () => {
    expect(deriveSourceFile('2026-10-18-p.md', 'p', null)).toBe('2026-10-18-p.md');
  });
  test('falls back to the canonical tail when it matches the slug', () => {
    expect(
      deriveSourceFile(undefined, 'p', { canonical: `${BASE}/2026-10-18-p/` }),
    ).toBe('2026-10-18-p.md');
  });
  test('undefined when it cannot tell', () => {
    expect(deriveSourceFile(undefined, 'p', { canonical: `${BASE}/other` })).toBeUndefined();
    expect(deriveSourceFile(undefined, 'p', { canonical: `${BASE}/2026-10-18-q` })).toBeUndefined();
    expect(deriveSourceFile('', 'p', null)).toBeUndefined();
  });
});

describe('checkFrontmatter', () => {
  const good = () => readFrontmatter(POST);
  const run = (over: Partial<Parameters<typeof checkFrontmatter>[0]> = {}) => {
    const r = good();
    return checkFrontmatter({
      present: r.present,
      fields: r.fields,
      sourceFile: '2026-10-18-raising-claude.md',
      status: 'staged',
      blogBaseUrl: BASE,
      ...over,
    });
  };

  test('a good post has no warnings', () => {
    expect(run()).toEqual([]);
  });
  test('missing block and invalid block', () => {
    expect(run({ present: false, fields: null })[0].code).toBe('frontmatter-missing');
    expect(run({ fields: null, parseError: 'bad' })[0].code).toBe('frontmatter-invalid');
    expect(run({ fields: null })[0].message).toContain('unknown error');
  });
  test('missing and empty required fields, including empty tags', () => {
    const w = run({ fields: { title: ' ', date: '2026-10-18', tags: [] } });
    const names = w.filter((x) => x.code === 'missing-field').map((x) => x.field);
    expect(names).toEqual(['title', 'excerpt', 'tags', 'author', 'canonical']);
  });
  test('empty mapping counts as empty', () => {
    const w = run({ fields: { title: {} } });
    expect(w.some((x) => x.field === 'title')).toBe(true);
  });
  test('date mismatch', () => {
    const w = run({ fields: { ...good().fields!, date: '2026-10-19' } });
    expect(w.map((x) => x.code)).toEqual(['date-mismatch']);
  });
  test('canonical mismatch, tolerating a trailing slash', () => {
    expect(
      run({ fields: { ...good().fields!, canonical: `${BASE}/wrong` } })[0].code,
    ).toBe('canonical-mismatch');
    expect(
      run({
        fields: { ...good().fields!, canonical: `${BASE}/2026-10-18-raising-claude/` },
        blogBaseUrl: `${BASE}/`,
      }),
    ).toEqual([]);
  });
  test('filename checks are skipped when the filename is unknown', () => {
    expect(
      run({
        sourceFile: undefined,
        fields: { ...good().fields!, date: '1999-01-01', canonical: 'x' },
      }),
    ).toEqual([]);
    expect(run({ sourceFile: 'no-date.md', fields: { ...good().fields!, date: '1999-01-01' } })).toEqual([]);
  });
  test('approved by hand warns unless approved or published', () => {
    const fields = { ...good().fields!, approved: 'true', publish_date: '2026-11-01' };
    expect(run({ fields }).map((x) => x.code)).toEqual(['approved-by-hand']);
    expect(run({ fields, status: 'approved' })).toEqual([]);
    expect(run({ fields, status: 'published' })).toEqual([]);
    expect(run({ fields, status: undefined }).length).toBe(1);
  });
  test('malformed repos', () => {
    expect(
      run({ fields: { ...good().fields!, repos: 'nope' } })[0].code,
    ).toBe('repos-malformed');
  });
  test('frontmatter-changed when the staged copy differs or drops it', () => {
    const same = readFrontmatter(POST);
    const original = same.fields!;
    // Same content, keys inserted in the opposite order.
    const reordered = Object.fromEntries(Object.entries(original).reverse());
    expect(run({ finalRead: { present: true, fields: reordered } })).toEqual([]);
    expect(
      run({ finalRead: { present: true, fields: { ...same.fields!, title: 'Other' } } })[0].code,
    ).toBe('frontmatter-changed');
    expect(run({ finalRead: { present: false, fields: null } })[0].code).toBe(
      'frontmatter-changed',
    );
  });
});

describe('buildFrontmatterInfo', () => {
  const base = {
    slug: 'raising-claude',
    status: 'staged',
    blogBaseUrl: BASE,
  };
  test('assembles the info for a good post', () => {
    const info = buildFrontmatterInfo({
      ...base,
      originalMarkdown: POST,
      finalMarkdown: POST,
      sourceFile: '2026-10-18-raising-claude.md',
    });
    expect(info).toMatchObject({ present: true, filenameKnown: true, warnings: [] });
    expect(info.raw).toContain('title:');
  });
  test('legacy item: filename recovered from canonical', () => {
    const info = buildFrontmatterInfo({ ...base, originalMarkdown: POST });
    expect(info.filenameKnown).toBe(true);
  });
  test('compares the final draft when it differs', () => {
    const info = buildFrontmatterInfo({
      ...base,
      originalMarkdown: POST,
      finalMarkdown: POST.replace('Raising Claude', 'Changed'),
      sourceFile: '2026-10-18-raising-claude.md',
    });
    expect(info.warnings.map((w) => w.code)).toEqual(['frontmatter-changed']);
  });
  test('unparseable and absent frontmatter', () => {
    const bad = buildFrontmatterInfo({ ...base, originalMarkdown: '---\na: [x\n---\n' });
    expect(bad.parseError).toBeDefined();
    expect(bad.filenameKnown).toBe(false);
    expect(buildFrontmatterInfo({ ...base, originalMarkdown: 'body' }).present).toBe(false);
  });
});
