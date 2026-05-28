import { submitImage } from '../../../lambda/images/fal';

describe('submitImage', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    (global as { fetch: unknown }).fetch = fetchMock;
  });

  test('posts to the flux-2-pro queue with the key, webhook and dimensions', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ request_id: 'req-123' }),
    });

    const id = await submitImage({
      prompt: 'a black cat on a radiator',
      callbackUrl: 'https://api.example.com/image-callback',
      falKey: 'SECRET',
    });

    expect(id).toBe('req-123');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('https://queue.fal.run/fal-ai/flux-2-pro');
    expect(url).toContain(
      `fal_webhook=${encodeURIComponent('https://api.example.com/image-callback')}`,
    );
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Key SECRET');
    expect(JSON.parse(init.body)).toMatchObject({
      prompt: 'a black cat on a radiator',
      image_size: { width: 1216, height: 832 },
      output_format: 'png',
    });
  });

  test('throws on a non-OK response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'overloaded',
    });
    await expect(
      submitImage({ prompt: 'x', callbackUrl: 'u', falKey: 'k' }),
    ).rejects.toThrow(/fal submit failed \(503\)/);
  });

  test('throws when fal returns no request_id', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    await expect(
      submitImage({ prompt: 'x', callbackUrl: 'u', falKey: 'k' }),
    ).rejects.toThrow(/no request_id/);
  });
});
