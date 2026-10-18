import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from 'aws-lambda';
import { draftExists, draftKey, getDraft } from '../review/drafts';
import { requireEnv } from '../review/runtime';
import { readFrontmatter, parseRepos } from './frontmatter';
import { optionalGithubToken, resetGithubTokenCache } from './github';
import { corsHeaders, jsonResponse } from './http';

/**
 * `GET /posts/{slug}/repo-checks` — are the post's `repos:` URLs visible on
 * GitHub? (PIPE-37)
 *
 * The URLs come from the author's iteration-1 draft, read here; nothing is
 * taken from the client, so this cannot be used as a fetch proxy. Only
 * `github.com/{owner}/{repo}` URLs are checked (via the GitHub API); anything
 * else is reported `unchecked`.
 */
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const MAX_REPOS = 10;
const TIMEOUT_MS = 5000;

export type RepoState = 'ok' | 'private' | 'not-found' | 'unchecked' | 'error';

export interface RepoCheck {
  name: string;
  url: string;
  state: RepoState;
  detail?: string;
}

/** `owner/repo` from a github.com URL, or undefined for anything else. */
export function githubRepoOf(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
    return undefined;
  }
  const [owner, repo] = parsed.pathname.split('/').filter(Boolean);
  if (!owner || !repo) {
    return undefined;
  }
  const clean = repo.replace(/\.git$/, '');
  const safe = /^[A-Za-z0-9._-]+$/;
  return safe.test(owner) && safe.test(clean) ? `${owner}/${clean}` : undefined;
}

async function checkOne(
  name: string,
  url: string,
  token: string | undefined,
): Promise<RepoCheck> {
  const full = githubRepoOf(url);
  if (!full) {
    return { name, url, state: 'unchecked', detail: 'Not a GitHub repository URL' };
  }
  const request = (bearer: string | undefined) =>
    fetch(`https://api.github.com/repos/${full}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'blog-pipeline',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  try {
    let response = await request(token);
    if (response.status === 401 && token) {
      // An expired or revoked token: forget it so a rotated one is re-read,
      // and retry this lookup as the public would see it.
      resetGithubTokenCache();
      response = await request(undefined);
    }
    if (response.status === 404) {
      return { name, url, state: 'not-found', detail: 'Private or does not exist' };
    }
    if (response.status === 200) {
      const body = (await response.json()) as { private?: boolean };
      return body.private === true
        ? { name, url, state: 'private', detail: 'Repository is private' }
        : { name, url, state: 'ok' };
    }
    return { name, url, state: 'error', detail: `GitHub returned ${response.status}` };
  } catch {
    return { name, url, state: 'error', detail: 'Could not reach GitHub' };
  }
}

export async function repoChecks(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const cors = corsHeaders(event);
  const slug = event.pathParameters?.slug;
  if (!slug) {
    return jsonResponse(400, { message: 'Missing slug' }, cors);
  }
  const { Item } = await docClient.send(
    new GetCommand({ TableName: requireEnv('POSTS_TABLE_NAME'), Key: { slug } }),
  );
  if (!Item) {
    return jsonResponse(404, { message: `No post '${slug}'` }, cors);
  }
  const key = draftKey(slug, 1);
  if (!(await draftExists(key))) {
    return jsonResponse(404, { message: `No draft for '${slug}'` }, cors);
  }

  const { repos } = parseRepos(readFrontmatter(await getDraft(key)).fields);
  const token = repos.length > 0 ? await optionalGithubToken() : undefined;
  const results = await Promise.all(
    repos.map((repo, i) =>
      i < MAX_REPOS
        ? checkOne(repo.name, repo.url, token)
        : Promise.resolve<RepoCheck>({
            name: repo.name,
            url: repo.url,
            state: 'unchecked',
            detail: `Only the first ${MAX_REPOS} repositories are checked`,
          }),
    ),
  );
  return jsonResponse(200, { repos: results }, cors);
}
