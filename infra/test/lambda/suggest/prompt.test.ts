import { SUGGEST_SYSTEM_PROMPT, buildSuggestPrompt } from '../../../lambda/suggest/prompt';
import type { Candidate, RepoInfo } from '../../../lambda/suggest/schema';

const cand: Candidate = {
  slug: '2026-07-29-cabal',
  title: 'The Cabal',
  date: '2026-07-29',
  url: 'https://blog.nakomis.com/2026-07-29-cabal',
  excerpt: 'Models asked who they were.',
  score: 0.8,
  evidence: [{ passage: 'draft passage', earlier: 'earlier passage', similarity: 0.8 }],
};
const repo: RepoInfo = {
  owner: 'nakomis', name: 'mcps', fullName: 'nakomis/mcps', url: 'https://github.com/nakomis/mcps',
  description: 'MCP servers', private: false, fork: false,
};

describe('SUGGEST_SYSTEM_PROMPT', () => {
  test('forbids writing URLs and prefers no suggestion to a doubtful one', () => {
    expect(SUGGEST_SYSTEM_PROMPT).toContain('never write');
    expect(SUGGEST_SYSTEM_PROMPT).toContain('Suggesting nothing is a good answer');
  });

  test('requires a genuine reference to the earlier post, not a shared word', () => {
    expect(SUGGEST_SYSTEM_PROMPT).toContain('specific subject of');
    expect(SUGGEST_SYSTEM_PROMPT).toContain('A shared word is not a shared subject');
    expect(SUGGEST_SYSTEM_PROMPT).toContain('final');
  });

  test('allows repos only when discussed and from the list', () => {
    expect(SUGGEST_SYSTEM_PROMPT).toContain('Choose only');
    expect(SUGGEST_SYSTEM_PROMPT).toContain('A passing mention');
  });
});

describe('buildSuggestPrompt', () => {
  test('includes the post, candidates with evidence and the repo list', () => {
    const out = buildSuggestPrompt({ body: 'POST BODY', mode: 'evidence', candidates: [cand], repos: [repo], maxLinks: 2 });
    expect(out).toContain('POST BODY');
    expect(out).toContain('slug: 2026-07-29-cabal');
    expect(out).toContain('matched passage in this post: draft passage');
    expect(out).toContain('nakomis/mcps: MCP servers');
    expect(out).toContain('at most 2 links');
  });

  test('catalogue mode omits evidence and warns to be strict', () => {
    const out = buildSuggestPrompt({ body: 'b', mode: 'catalogue', candidates: [cand], repos: [], maxLinks: 1 });
    expect(out).not.toContain('matched passage');
    expect(out).toContain('no retrieval signal');
    expect(out).toContain('at most 1 link.');
    expect(out).toContain('Return an empty "repos" list');
  });

  test('says so when there are no candidates', () => {
    const out = buildSuggestPrompt({ body: 'b', mode: 'none', candidates: [], repos: [repo], maxLinks: 1 });
    expect(out).toContain('Return an empty "links" list');
  });
});
