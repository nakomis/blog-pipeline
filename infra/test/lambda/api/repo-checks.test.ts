import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { githubRepoOf, repoChecks } from '../../../lambda/api/repo-checks';
import { resetGithubTokenCache } from '../../../lambda/api/github';

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);
const secretsMock = mockClient(SecretsManagerClient);
const fetchMock = jest.fn();

function event(slug: string | undefined): APIGatewayProxyEvent {
  return {
    pathParameters: slug === undefined ? null : { slug },
    headers: {},
  } as unknown as APIGatewayProxyEvent;
}

function draft(repos: Array<[string, string]>): string {
  const lines = repos.map(([n, u]) => `  - name: "${n}"\n    url: "${u}"`).join('\n');
  return `---\ntitle: "T"\nrepos:\n${lines}\n---\nbody`;
}

function setDraft(text: string) {
  s3Mock.on(HeadObjectCommand).resolves({});
  s3Mock.on(GetObjectCommand).resolves({
    Body: { transformToString: async () => text } as never,
  });
}

function reply(status: number, body: unknown = {}) {
  return { status, json: async () => body };
}

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  secretsMock.reset();
  fetchMock.mockReset();
  resetGithubTokenCache();
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
  process.env.POSTS_TABLE_NAME = 'posts';
  process.env.DRAFTS_BUCKET = 'drafts';
  process.env.GITHUB_DISPATCH_SECRET_ARN = 'arn:secret';
  secretsMock.on(GetSecretValueCommand).resolves({ SecretString: ' tok-123 \n' });
  ddbMock.on(GetCommand).resolves({ Item: { slug: 'p', status: 'staged' } });
});

afterEach(() => {
  delete process.env.GITHUB_DISPATCH_SECRET_ARN;
});

describe('githubRepoOf', () => {
  test('accepts github.com URLs, stripping .git and extra path', () => {
    expect(githubRepoOf('https://github.com/o/r')).toBe('o/r');
    expect(githubRepoOf('https://github.com/o/r.git')).toBe('o/r');
    expect(githubRepoOf('https://github.com/o/r/tree/main')).toBe('o/r');
  });
  test('rejects other hosts, schemes, junk and short paths', () => {
    expect(githubRepoOf('https://gitlab.com/o/r')).toBeUndefined();
    expect(githubRepoOf('http://github.com/o/r')).toBeUndefined();
    expect(githubRepoOf('not a url')).toBeUndefined();
    expect(githubRepoOf('https://github.com/o')).toBeUndefined();
    expect(githubRepoOf('https://github.com/o/r%2F..')).toBeUndefined();
  });
});

describe('repoChecks', () => {
  test('400 without a slug, 404 for an unknown post or missing draft', async () => {
    expect((await repoChecks(event(undefined))).statusCode).toBe(400);
    ddbMock.on(GetCommand).resolves({});
    expect((await repoChecks(event('p'))).statusCode).toBe(404);
    ddbMock.on(GetCommand).resolves({ Item: { slug: 'p' } });
    s3Mock.on(HeadObjectCommand).rejects(
      Object.assign(new Error('nf'), { name: 'NotFound' }),
    );
    expect((await repoChecks(event('p'))).statusCode).toBe(404);
  });

  test('classifies ok, private, not-found, error, unchecked', async () => {
    setDraft(
      draft([
        ['ok', 'https://github.com/o/ok'],
        ['priv', 'https://github.com/o/priv'],
        ['gone', 'https://github.com/o/gone'],
        ['limited', 'https://github.com/o/limited'],
        ['other', 'https://example.test/x'],
      ]),
    );
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/o/ok')) return reply(200, { private: false });
      if (url.endsWith('/o/priv')) return reply(200, { private: true });
      if (url.endsWith('/o/gone')) return reply(404);
      return reply(403);
    });
    const res = await repoChecks(event('p'));
    const states = JSON.parse(res.body).repos.map((r: { state: string }) => r.state);
    expect(states).toEqual(['ok', 'private', 'not-found', 'error', 'unchecked']);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  test('sends the token as a bearer header and never returns it', async () => {
    setDraft(draft([['a', 'https://github.com/o/a']]));
    fetchMock.mockResolvedValue(reply(200, { private: false }));
    const res = await repoChecks(event('p'));
    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe('Bearer tok-123');
    expect(res.body).not.toContain('tok-123');
  });

  test('carries on unauthenticated when the secret is unset or unreadable', async () => {
    setDraft(draft([['a', 'https://github.com/o/a']]));
    fetchMock.mockResolvedValue(reply(200, { private: false }));
    delete process.env.GITHUB_DISPATCH_SECRET_ARN;
    await repoChecks(event('p'));
    expect((fetchMock.mock.calls[0][1] as { headers: object }).headers).not.toHaveProperty('Authorization');

    process.env.GITHUB_DISPATCH_SECRET_ARN = 'arn:secret';
    secretsMock.on(GetSecretValueCommand).rejects(new Error('denied'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await repoChecks(event('p'));
    expect((fetchMock.mock.calls[1][1] as { headers: object }).headers).not.toHaveProperty('Authorization');

    secretsMock.on(GetSecretValueCommand).resolves({ SecretString: '  ' });
    await repoChecks(event('p'));
    expect((fetchMock.mock.calls[2][1] as { headers: object }).headers).not.toHaveProperty('Authorization');
  });

  test('caches the token across calls', async () => {
    setDraft(draft([['a', 'https://github.com/o/a']]));
    fetchMock.mockResolvedValue(reply(200, { private: false }));
    await repoChecks(event('p'));
    await repoChecks(event('p'));
    expect(secretsMock.commandCalls(GetSecretValueCommand)).toHaveLength(1);
  });

  test('a network failure or timeout is an error, not a throw', async () => {
    setDraft(draft([['a', 'https://github.com/o/a']]));
    fetchMock.mockRejectedValue(new Error('timeout'));
    const res = await repoChecks(event('p'));
    expect(JSON.parse(res.body).repos[0]).toMatchObject({ state: 'error' });
  });

  test('checks only the first ten repositories', async () => {
    setDraft(
      draft(Array.from({ length: 12 }, (_, i) => [`r${i}`, `https://github.com/o/r${i}`] as [string, string])),
    );
    fetchMock.mockResolvedValue(reply(200, { private: false }));
    const res = await repoChecks(event('p'));
    const repos = JSON.parse(res.body).repos;
    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(repos[10].state).toBe('unchecked');
    expect(repos).toHaveLength(12);
  });

  test('a post with no repos makes no calls', async () => {
    setDraft('---\ntitle: "T"\n---\nbody');
    const res = await repoChecks(event('p'));
    expect(JSON.parse(res.body)).toEqual({ repos: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(secretsMock.calls()).toHaveLength(0);
  });
});
