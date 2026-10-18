import {
  AFFILIATE_SYSTEM_PROMPT,
  SUGGEST_SYSTEM_PROMPT,
  buildAffiliatePrompt,
  buildSuggestPrompt,
} from '../../../lambda/suggest/prompt';
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
    const out = buildSuggestPrompt({ body: 'POST BODY', mode: 'evidence', candidates: [cand], repos: [repo], maxLinks: 2, maxRepos: 5 });
    expect(out).toContain('POST BODY');
    expect(out).toContain('slug: 2026-07-29-cabal');
    expect(out).toContain('matched passage in this post: draft passage');
    expect(out).toContain('nakomis/mcps: MCP servers');
    expect(out).toContain('at most 2 links');
    expect(out).toContain('at most 5 repositories');
  });

  test('catalogue mode omits evidence and warns to be strict', () => {
    const out = buildSuggestPrompt({ body: 'b', mode: 'catalogue', candidates: [cand], repos: [], maxLinks: 1, maxRepos: 5 });
    expect(out).not.toContain('matched passage');
    expect(out).toContain('no retrieval signal');
    expect(out).toContain('at most 1 link.');
    expect(out).toContain('Return an empty "repos" list');
  });

  test('says so when there are no candidates', () => {
    const out = buildSuggestPrompt({ body: 'b', mode: 'none', candidates: [], repos: [repo], maxLinks: 1, maxRepos: 5 });
    expect(out).toContain('Return an empty "links" list');
  });
});

describe('AFFILIATE_SYSTEM_PROMPT (PIPE-41)', () => {
  test('forbids writing links and tags, and prefers nothing to a doubtful mention', () => {
    expect(AFFILIATE_SYSTEM_PROMPT).toContain('never write');
    expect(AFFILIATE_SYSTEM_PROMPT).toContain('tag');
    expect(AFFILIATE_SYSTEM_PROMPT).toContain('Returning nothing is a good answer');
  });

  test('requires a specific product that Martin bought or used', () => {
    expect(AFFILIATE_SYSTEM_PROMPT).toContain('bought, owns or used');
    expect(AFFILIATE_SYSTEM_PROMPT).toContain('used_by_author');
  });

  test('lists what is not a product mention', () => {
    for (const phrase of [
      'generic categories',
      'compared, considered, rejected',
      'software, services',
      'already linked to Amazon',
      'heading',
    ]) {
      expect(AFFILIATE_SYSTEM_PROMPT).toContain(phrase);
    }
  });

  test('asks for the exact sentence and a short anchor', () => {
    expect(AFFILIATE_SYSTEM_PROMPT).toContain('exact sentence');
    expect(AFFILIATE_SYSTEM_PROMPT).toContain('2 to 6 words');
    expect(AFFILIATE_SYSTEM_PROMPT).toContain('in ordinary prose');
  });
});

describe('buildAffiliatePrompt', () => {
  test('includes the post, the cap and the existing Amazon link texts', () => {
    const p = buildAffiliatePrompt({ body: 'I used a thing.', existingAmazonTexts: ['Mars 5 Ultra'], max: 8 });
    expect(p).toContain('I used a thing.');
    expect(p).toContain('at most 8');
    expect(p).toContain('Mars 5 Ultra');
  });

  test('says so when nothing is linked yet', () => {
    const p = buildAffiliatePrompt({ body: 'x', existingAmazonTexts: [], max: 1 });
    expect(p).toContain('No product is linked to Amazon yet');
    expect(p).toContain('at most 1 product mention.');
  });
});
