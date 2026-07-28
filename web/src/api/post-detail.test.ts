import { fetchPostDetail, editPost, decidePost } from './post-detail';

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
    expect(JSON.parse(init.body)).toEqual({ decision: 'approve', announceBluesky: true });
  });

  test('throws on failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(decidePost('a', 'reject', 'tok')).rejects.toThrow(/HTTP 500/);
  });
});
