import type { RepoInfo } from './schema';

/**
 * Public-repo discovery for repo suggestions (PIPE-38).
 *
 * Haiku never invents `owner/name`: it chooses from the public repositories
 * this module lists from the GitHub API. Unauthenticated by default — a post
 * needs a handful of requests, well inside the 60/hour limit.
 */

export class GithubUnavailableError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GithubUnavailableError';
  }
}

interface GithubRepoJson {
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  owner: { login: string };
}

const PER_PAGE = 100;
const MAX_PAGES = 5;

/** List the public, non-fork (when asked) repositories of each owner. */
export async function listPublicRepos(
  owners: readonly string[],
  options: { excludeForks: boolean; fetchImpl?: typeof fetch },
): Promise<RepoInfo[]> {
  const doFetch = options.fetchImpl ?? fetch;
  const repos: RepoInfo[] = [];

  for (const owner of owners) {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const url =
        `https://api.github.com/users/${encodeURIComponent(owner)}/repos` +
        `?type=owner&per_page=${PER_PAGE}&page=${page}`;
      const response = await doFetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'blog-pipeline-suggest-links',
        },
      });
      if (response.status === 403 || response.status === 429) {
        throw new GithubUnavailableError(
          `GitHub rate limit or access refused (HTTP ${response.status})`,
          response.status,
        );
      }
      if (!response.ok) {
        throw new GithubUnavailableError(
          `GitHub returned HTTP ${response.status} listing ${owner}'s repos`,
          response.status,
        );
      }
      const json = (await response.json()) as GithubRepoJson[];
      for (const r of json) {
        // `private === false` is checked here and again on every validated pick.
        if (r.private !== false || (options.excludeForks && r.fork)) {
          continue;
        }
        repos.push({
          owner: r.owner.login,
          name: r.name,
          fullName: r.full_name,
          url: r.html_url,
          description: r.description,
          private: r.private,
          fork: r.fork,
        });
      }
      if (json.length < PER_PAGE) {
        break;
      }
    }
  }
  return repos;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `owner/name` of every GitHub URL for one of `owners` found in the text (lower-cased). */
export function extractRepoUrls(body: string, owners: readonly string[]): string[] {
  const wanted = new Set(owners.map((o) => o.toLowerCase()));
  const found = new Set<string>();
  for (const m of body.matchAll(/https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)/gi)) {
    const owner = m[1].toLowerCase();
    const name = m[2].replace(/\.git$/i, '').replace(/[.]+$/, '').toLowerCase();
    if (wanted.has(owner) && name !== '') {
      found.add(`${owner}/${name}`);
    }
  }
  return [...found];
}

/**
 * True when the post text names the repo: its bare name as a whole word
 * (case-insensitive), `owner/name`, or a GitHub URL for it. A repo that the
 * text never names is never suggested — whatever the model thinks.
 */
export function mentionsRepo(body: string, repo: RepoInfo): boolean {
  const name = escapeRegExp(repo.name);
  const bare = new RegExp(`(?<![\\w-])${name}(?![\\w-])`, 'i');
  return bare.test(body);
}
