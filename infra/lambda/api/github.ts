import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

/**
 * Optional GitHub credential for read-only lookups (PIPE-37).
 *
 * Reuses the dispatch PAT that `publish-now` reads. It is scoped to the
 * blog-content repo only, so it sees what the public sees (plus a higher rate
 * limit); it is never required. If the secret is unset, empty or unreadable the
 * caller carries on unauthenticated.
 */
const secrets = new SecretsManagerClient({});

let cachedToken: string | undefined;

export async function optionalGithubToken(): Promise<string | undefined> {
  if (cachedToken) {
    return cachedToken;
  }
  const arn = process.env.GITHUB_DISPATCH_SECRET_ARN;
  if (!arn) {
    return undefined;
  }
  try {
    const { SecretString } = await secrets.send(
      new GetSecretValueCommand({ SecretId: arn }),
    );
    const token = SecretString?.trim();
    if (token) {
      cachedToken = token;
    }
    return token || undefined;
  } catch (err) {
    console.error('Could not read the GitHub secret; checking unauthenticated', err);
    return undefined;
  }
}

/** Forget the cached token: on a 401 (so a rotated token is re-read), and in tests. */
export function resetGithubTokenCache(): void {
  cachedToken = undefined;
}
