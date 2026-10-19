import {
  fetchPostDetail,
  editPost,
  decidePost,
  fetchFailedMarkdown,
  saveFailedMarkdown,
  reReviewFailed,
  fetchRepoChecks,
  setSuggestionDecisions,
  setAffiliateDecisions,
} from './post-detail';

vi.mock('../config/config', () => ({
  getConfig: () => ({
    env: 'test',
    apiUrl: 'https://api.example.test',
    cognito: {},
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('fetchPostDetail', () => {
  test('requests the post detail with a bearer token', async () => {
    const detail = { post: { slug: 'a' }, finalMarkdown: '# a' };
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => detail });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchPostDetail('a/b', 'tok');

    expect(result).toEqual(detail);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/posts/a%2Fb',
      { headers: { Authorization: 'Bearer tok' } },
    );
  });

  test('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await expect(fetchPostDetail('missing', 'tok')).rejects.toThrow(/HTTP 404/);
  });
});

describe('editPost', () => {
  test('POSTs the markdown and reReview flag', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ slug: 'a', iteration: 2, reReview: true, status: 'reviewing' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await editPost('a', '# new', true, 'tok');

    expect(result.iteration).toBe(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.test/posts/a/edit');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ markdown: '# new', reReview: true });
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer tok',
      'Content-Type': 'application/json',
    });
  });

  test('throws on failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409 }));
    await expect(editPost('a', 'x', false, 'tok')).rejects.toThrow(/HTTP 409/);
  });
});

describe('decidePost', () => {
  test('POSTs the decision', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ slug: 'a', decision: 'approve', status: 'approved' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await decidePost('a', 'approve', 'tok');

    expect(result.status).toBe('approved');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.test/posts/a/decision');
    expect(JSON.parse(init.body)).toEqual({ decision: 'approve', announceBluesky: 'announce' });
  });

  test('throws on failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(decidePost('a', 'reject', 'tok')).rejects.toThrow(/HTTP 500/);
  });
});

describe('failed-post editing (PIPE-36)', () => {
  test('fetchFailedMarkdown GETs the markdown route', async () => {
    const body = { slug: 'a', iteration: 4, markdown: '# a', pendingEdit: false };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    vi.stubGlobal('fetch', fetchMock);

    expect(await fetchFailedMarkdown('a', 'tok')).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/posts/a/markdown',
      { headers: { Authorization: 'Bearer tok' } },
    );
  });

  test('saveFailedMarkdown POSTs the markdown', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ slug: 'a', iteration: 5, status: 'failed', pendingEdit: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    expect((await saveFailedMarkdown('a', '# b', 'tok')).iteration).toBe(5);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.test/posts/a/markdown');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ markdown: '# b' });
  });

  test('reReviewFailed POSTs to the rereview route', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ slug: 'a', iteration: 5, status: 'reviewing', alreadyStarted: false }),
    });
    vi.stubGlobal('fetch', fetchMock);

    expect((await reReviewFailed('a', '# b', 'tok')).status).toBe('reviewing');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.test/posts/a/rereview');
    expect(JSON.parse(init.body)).toEqual({ markdown: '# b' });
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tok' });
  });

  test.each([
    ['fetchFailedMarkdown', () => fetchFailedMarkdown('a', 'tok')],
    ['saveFailedMarkdown', () => saveFailedMarkdown('a', 'x', 'tok')],
    ['reReviewFailed', () => reReviewFailed('a', 'x', 'tok')],
  ])('%s throws on a non-ok response', async (_name, call) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409 }));
    await expect(call()).rejects.toThrow(/HTTP 409/);
  });
});

describe('fetchRepoChecks', () => {
  test('requests the repo checks with a bearer token', async () => {
    const repos = [{ name: 'a', url: 'https://github.com/o/a', state: 'ok' }];
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ repos }) });
    vi.stubGlobal('fetch', fetchMock);

    expect(await fetchRepoChecks('a/b', 'tok')).toEqual(repos);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/posts/a%2Fb/repo-checks',
      { headers: { Authorization: 'Bearer tok' } },
    );
  });

  test('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(fetchRepoChecks('a', 'tok')).rejects.toThrow('HTTP 500');
  });
});

describe('setSuggestionDecisions (PIPE-38)', () => {
  test('posts the decisions and returns the updated suggestions', async () => {
    const suggestions = { status: 'ok', links: [], repos: [] };
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ suggestions }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await setSuggestionDecisions('a/b', { l1: 'accepted' }, 'tok');

    expect(result).toEqual(suggestions);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/posts/a%2Fb/suggestions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ decisions: { l1: 'accepted' } }),
      }),
    );
  });

  test('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409 }));
    await expect(setSuggestionDecisions('a', {}, 'tok')).rejects.toThrow('HTTP 409');
  });
});

describe('setAffiliateDecisions (PIPE-41)', () => {
  test('posts the request and returns the server verdict', async () => {
    const reply = { suggestions: { status: 'ok' }, results: { m1: { ok: true, warnings: [] } } };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => reply });
    vi.stubGlobal('fetch', fetchMock);

    const request = { decisions: { m1: { action: 'link' as const, url: 'https://x' } }, trackingId: 'nakomis-a-21' };
    const result = await setAffiliateDecisions('a/b', request, 'tok');

    expect(result).toEqual(reply);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/posts/a%2Fb/affiliates',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
        body: JSON.stringify(request),
      }),
    );
  });

  test('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409 }));
    await expect(setAffiliateDecisions('a', { skipRemaining: true }, 'tok')).rejects.toThrow('HTTP 409');
  });
});
