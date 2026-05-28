import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto';

/**
 * fal.ai webhook signature verification (PIPE-6).
 *
 * The image callback is a public, unauthenticated route — anyone can POST to it.
 * The only thing that makes a request trustworthy is fal's ED25519 signature, so
 * this verification is the security boundary for the whole image path. It must
 * run on the *raw* request bytes (the signature binds the exact body) and is
 * deliberately strict: a missing header, a stale timestamp, a body that does not
 * hash to the signed digest, or a signature no published key validates all fail
 * closed.
 *
 * fal's scheme (https://docs.fal.ai/model-endpoints/webhooks):
 *  - four `X-Fal-Webhook-*` headers carry the request id, user id, unix
 *    timestamp and a hex ED25519 signature;
 *  - the signed message is `requestId\nuserId\ntimestamp\nhex(sha256(body))`;
 *  - public keys are published as an ED25519 JWKS at the well-known URL below.
 *
 * The core (`verifyFalSignature`) is pure — JWKS and clock are injected so it is
 * fully unit-testable with a fixed keypair.
 */

const JWKS_URL = 'https://rest.fal.ai/.well-known/jwks.json';
const JWKS_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TOLERANCE_SECONDS = 300;

export interface FalJwk {
  kty: string;
  crv: string;
  x: string;
}

export interface FalJwks {
  keys: FalJwk[];
}

export interface FalWebhookHeaders {
  requestId?: string;
  userId?: string;
  timestamp?: string;
  signature?: string;
}

/** Pull the four `X-Fal-Webhook-*` headers out, case-insensitively. */
export function extractFalHeaders(
  headers: Record<string, string | undefined>,
): FalWebhookHeaders {
  const lower: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    lower[key.toLowerCase()] = value;
  }
  return {
    requestId: lower['x-fal-webhook-request-id'],
    userId: lower['x-fal-webhook-user-id'],
    timestamp: lower['x-fal-webhook-timestamp'],
    signature: lower['x-fal-webhook-signature'],
  };
}

export interface VerifyFalSignatureInput {
  headers: FalWebhookHeaders;
  /** The exact request body bytes the signature was computed over. */
  rawBody: Buffer;
  jwks: FalJwks;
  now?: Date;
  toleranceSeconds?: number;
}

/** True only if the request is a genuine, fresh, untampered fal webhook. */
export function verifyFalSignature(input: VerifyFalSignatureInput): boolean {
  const { requestId, userId, timestamp, signature } = input.headers;
  if (!requestId || !userId || !timestamp || !signature) {
    return false;
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return false;
  }
  const nowSeconds = (input.now ?? new Date()).getTime() / 1000;
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(nowSeconds - ts) > tolerance) {
    return false;
  }

  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  // A hex string with an odd length / non-hex chars yields a short buffer;
  // an Ed25519 signature is always 64 bytes.
  if (signatureBytes.length !== 64) {
    return false;
  }

  const bodyDigest = createHash('sha256').update(input.rawBody).digest('hex');
  const message = Buffer.from(
    `${requestId}\n${userId}\n${timestamp}\n${bodyDigest}`,
    'utf8',
  );

  return input.jwks.keys.some((jwk) => {
    try {
      const key = createPublicKey({
        key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
        format: 'jwk',
      });
      return cryptoVerify(null, message, key, signatureBytes);
    } catch {
      return false;
    }
  });
}

let jwksCache: { jwks: FalJwks; fetchedAt: number } | undefined;

/** Fetch fal's JWKS, cached for up to 24h. */
export async function fetchFalJwks(now: number = Date.now()): Promise<FalJwks> {
  if (jwksCache && now - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.jwks;
  }
  const res = await fetch(JWKS_URL);
  if (!res.ok) {
    throw new Error(`fal JWKS fetch failed (${res.status})`);
  }
  const jwks = (await res.json()) as FalJwks;
  jwksCache = { jwks, fetchedAt: now };
  return jwks;
}

/** Test-only: drop the cached JWKS so a test starts from a clean slate. */
export function resetJwksCache(): void {
  jwksCache = undefined;
}
