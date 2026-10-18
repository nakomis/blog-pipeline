import {
  GithubUnavailableError,
  extractRepoUrls,
  listPublicRepos,
  mentionsRepo,
} from '../../../lambda/suggest/github';
import type { RepoInfo } from '../../../lambda/suggest/schema';

function repoJson(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    full_name: `nakomis/${name}`,
    html_url: `https://github.com/nakomis/${name}`,
    description: `${name} description`,
    private: false,
    fork: false,
    owner: { login: 'nakomis' },
    ...extra,
  };
}

function respond(status: number, json: unknown): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => json } as Response;
}

describe('listPublicRepos', () => {
  test('lists public repos and skips private ones and forks', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      respond(200, [
        repoJson('mcps'),
        repoJson('secret', { private: true }),
        repoJson('forked', { fork: true }),
      ]),
    );
    const repos = await listPublicRepos(['nakomis'], { excludeForks: true, fetchImpl });
    expect(repos.map((r) => r.fullName)).toEqual(['nakomis/mcps']);
    expect(fetchImpl.mock.calls[0][0]).toContain('/users/nakomis/repos');
    expect(fetchImpl.mock.calls[0][1].headers['User-Agent']).toBeDefined();
  });

  test('keeps forks when asked to', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(respond(200, [repoJson('forked', { fork: true })]));
    const repos = await listPublicRepos(['nakomis'], { excludeForks: false, fetchImpl });
    expect(repos).toHaveLength(1);
  });

  test('paginates until a short page', async () => {
    const full = Array.from({ length: 100 }, (_, i) => repoJson(`r${i}`));
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(respond(200, full))
      .mockResolvedValueOnce(respond(200, [repoJson('last')]));
    const repos = await listPublicRepos(['nakomis'], { excludeForks: true, fetchImpl });
    expect(repos).toHaveLength(101);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test.each([403, 429])('HTTP %i is a rate-limit error', async (status) => {
    const fetchImpl = jest.fn().mockResolvedValue(respond(status, {}));
    await expect(
      listPublicRepos(['nakomis'], { excludeForks: true, fetchImpl }),
    ).rejects.toBeInstanceOf(GithubUnavailableError);
  });

  test('other failures are reported too', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(respond(500, {}));
    await expect(
      listPublicRepos(['nakomis'], { excludeForks: true, fetchImpl }),
    ).rejects.toThrow('HTTP 500');
  });
});

describe('extractRepoUrls', () => {
  test('finds owner/name for configured owners only, tidying suffixes', () => {
    const body =
      'See https://github.com/nakomis/mcps. Also https://github.com/Nakomis/blog-pipeline.git and ' +
      'https://github.com/someoneelse/thing and https://example.com/nakomis/nope';
    expect(extractRepoUrls(body, ['nakomis'])).toEqual(['nakomis/mcps', 'nakomis/blog-pipeline']);
  });
});

describe('mentionsRepo', () => {
  const repo = (name: string): RepoInfo => ({
    owner: 'nakomis',
    name,
    fullName: `nakomis/${name}`,
    url: `https://github.com/nakomis/${name}`,
    description: null,
    private: false,
    fork: false,
  });

  test('matches the bare name as a whole word, case-insensitively', () => {
    expect(mentionsRepo('I wrote Nakotp last week.', repo('nakotp'))).toBe(true);
    expect(mentionsRepo('The mcps repo holds them.', repo('mcps'))).toBe(true);
  });

  test('matches owner/name and URLs because they contain the name', () => {
    expect(mentionsRepo('see nakomis/blog-pipeline', repo('blog-pipeline'))).toBe(true);
    expect(mentionsRepo('https://github.com/nakomis/blog-pipeline', repo('blog-pipeline'))).toBe(true);
  });

  test('does not match inside longer words or hyphenated names', () => {
    expect(mentionsRepo('pipeline things', repo('blog-pipeline'))).toBe(false);
    expect(mentionsRepo('the cabal-mcps variety', repo('mcps'))).toBe(false);
    expect(mentionsRepo('mcpsx', repo('mcps'))).toBe(false);
  });

  test('escapes regex characters in names', () => {
    expect(mentionsRepo('the .github repo', repo('.github'))).toBe(true);
    expect(mentionsRepo('axb', repo('a.b'))).toBe(false);
  });
});
