import { fetchImageCredit } from './image-credit';

vi.mock('../config/config', () => ({
  getConfig: () => ({
    env: 'test',
    apiUrl: 'https://api.example.test',
    cognito: {},
  }),
}));

describe('fetchImageCredit', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('requests /image-credit with a bearer token', async () => {
    const credit = { low: true, remainingUsd: 3.2, thresholdUsd: 5 };
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => credit });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchImageCredit('tok123')).resolves.toEqual(credit);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/image-credit',
      { headers: { Authorization: 'Bearer tok123' } },
    );
  });

  test('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    await expect(fetchImageCredit('tok')).rejects.toThrow(/HTTP 403/);
  });
});
