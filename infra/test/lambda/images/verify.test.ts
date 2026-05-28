import {
  generateKeyPairSync,
  createHash,
  sign as cryptoSign,
  type KeyObject,
} from 'crypto';
import {
  extractFalHeaders,
  fetchFalJwks,
  resetJwksCache,
  verifyFalSignature,
  type FalJwks,
} from '../../../lambda/images/verify';

function jwkOf(publicKey: KeyObject): { kty: string; crv: string; x: string } {
  const jwk = publicKey.export({ format: 'jwk' }) as {
    kty: string;
    crv: string;
    x: string;
  };
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x };
}

const real = generateKeyPairSync('ed25519');
const jwks: FalJwks = { keys: [jwkOf(real.publicKey)] };

const TS = 1_700_000_000;
const NOW = new Date(TS * 1000);

function sign(
  rawBody: Buffer,
  privateKey: KeyObject = real.privateKey,
  timestamp: string = String(TS),
): { requestId: string; userId: string; timestamp: string; signature: string } {
  const requestId = 'req-1';
  const userId = 'user-1';
  const digest = createHash('sha256').update(rawBody).digest('hex');
  const message = Buffer.from(
    `${requestId}\n${userId}\n${timestamp}\n${digest}`,
    'utf8',
  );
  return {
    requestId,
    userId,
    timestamp,
    signature: cryptoSign(null, message, privateKey).toString('hex'),
  };
}

describe('verifyFalSignature', () => {
  test('accepts a genuine, fresh, untampered webhook', () => {
    const body = Buffer.from('{"request_id":"req-1","status":"OK"}');
    expect(
      verifyFalSignature({ headers: sign(body), rawBody: body, jwks, now: NOW }),
    ).toBe(true);
  });

  test('rejects a tampered body', () => {
    const body = Buffer.from('{"request_id":"req-1","status":"OK"}');
    const headers = sign(body);
    const tampered = Buffer.from('{"request_id":"req-1","status":"EVIL"}');
    expect(
      verifyFalSignature({ headers, rawBody: tampered, jwks, now: NOW }),
    ).toBe(false);
  });

  test('rejects a stale timestamp', () => {
    const body = Buffer.from('payload');
    const headers = sign(body);
    const wayLater = new Date((TS + 3600) * 1000);
    expect(
      verifyFalSignature({ headers, rawBody: body, jwks, now: wayLater }),
    ).toBe(false);
  });

  test('rejects a signature from a key not in the JWKS', () => {
    const other = generateKeyPairSync('ed25519');
    const body = Buffer.from('payload');
    const headers = sign(body, other.privateKey);
    expect(
      verifyFalSignature({ headers, rawBody: body, jwks, now: NOW }),
    ).toBe(false);
  });

  test('rejects when a required header is missing', () => {
    const body = Buffer.from('payload');
    const { userId, timestamp, signature } = sign(body);
    expect(
      verifyFalSignature({
        headers: { userId, timestamp, signature },
        rawBody: body,
        jwks,
        now: NOW,
      }),
    ).toBe(false);
  });

  test('rejects a malformed (non-64-byte) signature', () => {
    const body = Buffer.from('payload');
    const headers = { ...sign(body), signature: 'abcd' };
    expect(
      verifyFalSignature({ headers, rawBody: body, jwks, now: NOW }),
    ).toBe(false);
  });

  test('rejects a non-numeric timestamp', () => {
    const body = Buffer.from('payload');
    const headers = { ...sign(body), timestamp: 'not-a-number' };
    expect(
      verifyFalSignature({ headers, rawBody: body, jwks, now: NOW }),
    ).toBe(false);
  });
});

describe('fetchFalJwks', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    resetJwksCache();
    fetchMock.mockReset();
    (global as { fetch: unknown }).fetch = fetchMock;
  });

  test('fetches once and serves the cache until reset', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => jwks });

    const first = await fetchFalJwks(1000);
    const second = await fetchFalJwks(2000);
    expect(first).toEqual(jwks);
    expect(second).toEqual(jwks);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resetJwksCache();
    await fetchFalJwks(3000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('throws when the JWKS endpoint is unavailable', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await expect(fetchFalJwks(1000)).rejects.toThrow(/JWKS fetch failed/);
  });
});

describe('extractFalHeaders', () => {
  test('reads the X-Fal-Webhook-* headers case-insensitively', () => {
    expect(
      extractFalHeaders({
        'X-Fal-Webhook-Request-Id': 'r',
        'x-fal-webhook-user-id': 'u',
        'X-FAL-WEBHOOK-TIMESTAMP': 't',
        'x-fal-webhook-signature': 's',
      }),
    ).toEqual({ requestId: 'r', userId: 'u', timestamp: 't', signature: 's' });
  });
});
