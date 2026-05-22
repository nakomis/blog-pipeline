import { fetchPosts } from './posts';

vi.mock('../config/config', () => ({
  getConfig: () => ({
    env: 'test',
    apiUrl: 'https://api.example.test',
    cognito: {},
  }),
}));

describe('fetchPosts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('requests /posts with a bearer token and returns the posts array', async () => {
    const posts = [
      { slug: 'a', status: 'queued', title: 'A', updatedAt: '2026-05-01' },
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ posts }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchPosts('tok123');

    expect(result).toEqual(posts);
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.test/posts', {
      headers: { Authorization: 'Bearer tok123' },
    });
  });

  test('throws on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401 }),
    );
    await expect(fetchPosts('bad-token')).rejects.toThrow(/HTTP 401/);
  });
});
