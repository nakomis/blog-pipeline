import type { IndexRecord } from '../../../lambda/suggest/embeddings';
import { IndexIncompatibleError } from '../../../lambda/suggest/embeddings';
import { generateSuggestions, run } from '../../../lambda/suggest/suggest-links';
import type { Deps } from '../../../lambda/suggest/suggest-links';
import type { Picks, RepoInfo, Suggestions } from '../../../lambda/suggest/schema';

function unit(values: number[]): Float32Array {
  const norm = Math.sqrt(values.reduce((s, v) => s + v * v, 0));
  return new Float32Array(values.map((v) => v / norm));
}

const CABAL_SLUG = '2026-07-29-three-of-them-didnt-know-what-they-were';
const CABAL_URL = `https://blog.nakomis.com/${CABAL_SLUG}`;

function record(slug: string, date: string, vector: number[]): IndexRecord {
  return {
    id: `${slug}:0`,
    post_slug: slug,
    post_title: `Title ${slug}`,
    post_date: date,
    post_url: `https://blog.nakomis.com/${slug}`,
    post_excerpt: 'excerpt',
    heading: '',
    text: 'earlier text',
    embedding: unit(vector),
  };
}

const INDEX = [
  record(CABAL_SLUG, '2026-07-29', [1, 0]),
  record('2026-08-01-b', '2026-08-01', [1, 0.1]),
  record('2026-08-02-c', '2026-08-02', [1, 0.2]),
  record('2026-08-03-d', '2026-08-03', [1, 0.3]),
];

const MCPS: RepoInfo = {
  owner: 'nakomis',
  name: 'mcps',
  fullName: 'nakomis/mcps',
  url: 'https://github.com/nakomis/mcps',
  description: 'MCP servers',
  private: false,
  fork: false,
};

const MARKDOWN = `---
title: "A post"
date: "2026-10-18"
---

I asked the Cabal what it thought of the draft.

The Alexa tool lives in mcps now.
`;

const EMPTY_PICKS: Picks = { links: [], repos: [] };

function makeDeps(over: Partial<Deps> = {}): Deps & { puts: Suggestions[] } {
  const puts: Suggestions[] = [];
  return {
    puts,
    getDraft: jest.fn().mockResolvedValue(MARKDOWN),
    loadIndex: jest.fn().mockResolvedValue(INDEX),
    embedTexts: jest.fn().mockImplementation(async (texts: string[]) => texts.map(() => unit([1, 0]))),
    listRepos: jest.fn().mockResolvedValue([MCPS]),
    pick: jest.fn().mockResolvedValue(EMPTY_PICKS),
    getPrevious: jest.fn().mockResolvedValue(null),
    put: jest.fn().mockImplementation(async (s: Suggestions) => {
      puts.push(s);
    }),
    putSummary: jest.fn().mockResolvedValue(undefined),
    now: () => new Date('2026-10-18T12:00:00Z'),
    ...over,
  };
}

const EVENT = { slug: 'a-post', iteration: 2, draftKey: 'a-post/iteration-2/draft.md' };

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('generateSuggestions', () => {
  test('suggests a validated link and a named repo', async () => {
    const deps = makeDeps({
      pick: jest.fn().mockResolvedValue({
        links: [
          { anchor_text: 'the Cabal', target_slug: CABAL_SLUG, same_subject: true, reason: 'Refers to it.' },
          { anchor_text: 'the draft', target_slug: 'invented-slug', same_subject: true, reason: 'x' },
        ],
        repos: [
          { full_name: 'nakomis/mcps', evidence_quote: 'The Alexa tool lives in mcps now.', reason: 'Discussed.' },
        ],
      }),
    });
    const out = await generateSuggestions({ ...EVENT, markdown: MARKDOWN }, deps);
    expect(out.status).toBe('ok');
    expect(out.links).toHaveLength(1);
    expect(out.links[0]).toMatchObject({ targetUrl: CABAL_URL, decision: 'pending' });
    expect(out.repos[0]).toMatchObject({ fullName: 'nakomis/mcps', url: MCPS.url });
    // A short post allows one link, so the second proposal is trimmed, not fatal.
    expect(out.dropped.some((d) => d.reason.includes('more than 1 links'))).toBe(true);
    expect(out.models.chat).toBe('claude-haiku-5-5');
  });

  test('the model sees only repos the post names and earlier-dated candidates', async () => {
    const deps = makeDeps({
      listRepos: jest.fn().mockResolvedValue([MCPS, { ...MCPS, name: 'unmentioned', fullName: 'nakomis/unmentioned' }]),
    });
    await generateSuggestions({ ...EVENT, markdown: MARKDOWN }, deps);
    const prompt = (deps.pick as jest.Mock).mock.calls[0][1] as string;
    expect(prompt).toContain('nakomis/mcps');
    expect(prompt).not.toContain('nakomis/unmentioned');
    expect(prompt).toContain(CABAL_SLUG);
  });

  test('does not offer a repo already in the frontmatter', async () => {
    const md = MARKDOWN.replace(
      'date: "2026-10-18"',
      'date: "2026-10-18"\nrepos:\n  - name: "mcps"\n    url: "https://github.com/nakomis/mcps"',
    );
    const deps = makeDeps();
    const out = await generateSuggestions({ ...EVENT, markdown: md }, deps);
    expect(out.repos).toEqual([]);
    expect((deps.pick as jest.Mock).mock.calls[0][1]).toContain('Return an empty "repos" list');
  });

  test('skips with a reason when the embeddings index is absent (sandbox)', async () => {
    const deps = makeDeps({ loadIndex: jest.fn().mockResolvedValue(null) });
    const out = await generateSuggestions({ ...EVENT, markdown: MARKDOWN }, deps);
    expect(out).toMatchObject({ status: 'skipped', skippedReason: 'no-embeddings-index', links: [], repos: [] });
    expect(deps.pick).not.toHaveBeenCalled();
  });

  test('makes no model call when there is nothing to choose from', async () => {
    const deps = makeDeps({
      loadIndex: jest.fn().mockResolvedValue([record('2026-12-01-future', '2026-12-01', [1, 0])]),
      listRepos: jest.fn().mockResolvedValue([]),
    });
    const out = await generateSuggestions({ ...EVENT, markdown: MARKDOWN }, deps);
    expect(out).toMatchObject({ status: 'ok', skippedReason: 'no-candidates' });
    expect(deps.pick).not.toHaveBeenCalled();
  });

  test('a GitHub failure still yields link suggestions, with the reason recorded', async () => {
    const deps = makeDeps({ listRepos: jest.fn().mockRejectedValue(new Error('HTTP 403')) });
    const out = await generateSuggestions({ ...EVENT, markdown: MARKDOWN }, deps);
    expect(out.status).toBe('ok');
    expect(out.dropped[0].reason).toContain('repository list unavailable');
    expect(deps.pick).toHaveBeenCalled();
  });

  test('reports scores and honours a floor override', async () => {
    const onScored = jest.fn();
    const deps = makeDeps();
    await generateSuggestions({ ...EVENT, markdown: MARKDOWN }, deps, { floor: 0.99, onScored });
    expect(onScored).toHaveBeenCalledTimes(1);
    expect(onScored.mock.calls[0][0].length).toBe(4);
    // floor 0.99 leaves too few strong posts, so the catalogue is offered
    expect((deps.pick as jest.Mock).mock.calls[0][1]).toContain('no retrieval signal');
  });

  test('uses today when the draft has no date', async () => {
    const deps = makeDeps();
    const out = await generateSuggestions({ ...EVENT, markdown: 'No frontmatter. The Cabal.' }, deps);
    expect(out.status).toBe('ok');
  });
});

describe('an oversized model answer', () => {
  test('keeps what fits instead of discarding every suggestion', async () => {
    const md = `---\ntitle: "A post"\ndate: "2026-10-18"\n---\n\nI asked the Cabal what it thought.\n`;
    const picks = {
      links: [
        { anchor_text: 'the Cabal', target_slug: CABAL_SLUG, same_subject: true, reason: 'z'.repeat(900) },
        ...Array.from({ length: 12 }, (_, i) => ({
          anchor_text: `filler ${i}`, target_slug: CABAL_SLUG, same_subject: true, reason: 'x',
        })),
      ],
      repos: Array.from({ length: 9 }, (_, i) => ({
        full_name: `nakomis/none${i}`, evidence_quote: 'q', reason: 'x',
      })),
    };
    const deps = makeDeps({ pick: jest.fn().mockResolvedValue(picks) });
    const out = await generateSuggestions({ ...EVENT, markdown: md }, deps);
    expect(out.status).toBe('ok');
    expect(out.links).toHaveLength(1);
    expect(out.links[0].reason).toHaveLength(300);
    expect(out.dropped.filter((d) => d.reason.includes('more than')).length).toBeGreaterThanOrEqual(2);
  });

  test('never asks for more than the configured number of links, however long the post', async () => {
    const long = `---\ndate: "2026-10-18"\n---\n\n${'word '.repeat(6000)}`;
    const deps = makeDeps();
    await generateSuggestions({ ...EVENT, markdown: long }, deps);
    expect((deps.pick as jest.Mock).mock.calls[0][1]).toContain('at most 10 links');
  });
});

describe('run', () => {
  test('stores the suggestions and the row summary', async () => {
    const deps = makeDeps({
      pick: jest.fn().mockResolvedValue({
        links: [{ anchor_text: 'the Cabal', target_slug: CABAL_SLUG, same_subject: true, reason: 'r' }],
        repos: [],
      }),
    });
    const out = await run(EVENT, deps);
    expect(out.suggestions).toMatchObject({ iteration: 2, status: 'ok', links: 1, undecided: 1 });
    expect(deps.puts[0].links).toHaveLength(1);
    expect(deps.putSummary).toHaveBeenCalledWith('a-post', out.suggestions);
  });

  test('carries earlier decisions over to identical suggestions', async () => {
    const link = { anchor_text: 'the Cabal', target_slug: CABAL_SLUG, same_subject: true, reason: 'r' };
    const first = makeDeps({ pick: jest.fn().mockResolvedValue({ links: [link], repos: [] }) });
    await run(EVENT, first);
    const previous = { ...first.puts[0], links: first.puts[0].links.map((l) => ({ ...l, decision: 'accepted' as const })) };
    const second = makeDeps({
      pick: jest.fn().mockResolvedValue({ links: [link], repos: [] }),
      getPrevious: jest.fn().mockResolvedValue(previous),
    });
    const out = await run({ ...EVENT, iteration: 3 }, second);
    expect(second.puts[0].links[0].decision).toBe('accepted');
    expect(out.suggestions.undecided).toBe(0);
  });

  test('a model failure is recorded as an error and does not throw', async () => {
    const deps = makeDeps({ pick: jest.fn().mockRejectedValue(new Error('Bedrock throttled')) });
    const out = await run(EVENT, deps);
    expect(out.suggestions.status).toBe('error');
    expect(out.suggestions.skippedReason).toContain('Bedrock throttled');
    expect(deps.puts[0].status).toBe('error');
  });

  test('an unreadable draft is recorded as an error and does not throw', async () => {
    const deps = makeDeps({ getDraft: jest.fn().mockRejectedValue(new Error('no such key')) });
    await expect(run(EVENT, deps)).resolves.toMatchObject({ suggestions: { status: 'error' } });
  });

  test('an incompatible index is skipped, not an error', async () => {
    const deps = makeDeps({ loadIndex: jest.fn().mockRejectedValue(new IndexIncompatibleError('bad dims')) });
    const out = await run(EVENT, deps);
    expect(out.suggestions).toMatchObject({ status: 'skipped', skippedReason: 'index-incompatible' });
  });

  test('still returns when recording the result fails too', async () => {
    const deps = makeDeps({ put: jest.fn().mockRejectedValue(new Error('S3 down')) });
    await expect(run(EVENT, deps)).resolves.toMatchObject({ slug: 'a-post' });
  });

  test('a failure to read previous decisions does not lose the new suggestions', async () => {
    const deps = makeDeps({ getPrevious: jest.fn().mockRejectedValue(new Error('x')) });
    const out = await run(EVENT, deps);
    expect(out.suggestions.status).toBe('ok');
  });
});

describe('defaultDeps wiring', () => {
  test('pick asks the model for structured output and getPrevious follows the row summary', async () => {
    jest.resetModules();
    const generateObject = jest.fn().mockResolvedValue({ object: { links: [], repos: [] } });
    jest.doMock('ai', () => ({ generateObject }));
    jest.doMock('../../../lambda/review/providers', () => ({ suggestModel: async () => ({ id: 'haiku' }) }));
    const getSummary = jest.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce({ iteration: 4 });
    const getSuggestions = jest.fn().mockResolvedValue({ slug: 'p' });
    jest.doMock('../../../lambda/suggest/store', () => ({
      ...jest.requireActual('../../../lambda/suggest/store'),
      getSummary,
      getSuggestions,
    }));
    const { defaultDeps } = await import('../../../lambda/suggest/suggest-links');
    const deps = defaultDeps();

    await expect(deps.pick('sys', 'prompt')).resolves.toEqual({ links: [], repos: [] });
    expect(generateObject).toHaveBeenCalledWith(
      expect.objectContaining({ system: 'sys', prompt: 'prompt', model: { id: 'haiku' } }),
    );
    await expect(deps.getPrevious('p')).resolves.toBeNull();
    await expect(deps.getPrevious('p')).resolves.toEqual({ slug: 'p' });
    expect(getSuggestions).toHaveBeenCalledWith('p', 4);
    expect(deps.now()).toBeInstanceOf(Date);
    const fetchImpl = jest.spyOn(global, 'fetch').mockResolvedValue({
      status: 200, ok: true, json: async () => [],
    } as Response);
    await expect(deps.listRepos()).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalled();
    jest.dontMock('ai');
    jest.dontMock('../../../lambda/review/providers');
    jest.dontMock('../../../lambda/suggest/store');
  });
});
