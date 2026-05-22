import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

/**
 * Shared runtime plumbing for the review Lambdas — environment access and
 * Secrets Manager reads.
 */

const secrets = new SecretsManagerClient({});

/** Read a required environment variable, throwing a clear error if unset. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

/**
 * Fetch and JSON-parse a Secrets Manager secret.
 *
 * Throws if the secret has no string value — an empty (not-yet-populated)
 * reviewer secret therefore surfaces as a provider failure, which the reviewer
 * fan-out records as `unavailable`.
 */
export async function readSecretJson<T>(secretId: string): Promise<T> {
  const res = await secrets.send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  if (!res.SecretString) {
    throw new Error(`Secret ${secretId} has no string value`);
  }
  return JSON.parse(res.SecretString) as T;
}
