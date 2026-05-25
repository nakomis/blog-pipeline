import { createAzure } from '@ai-sdk/azure';
import type { LanguageModel } from 'ai';
import { readSecretJson, requireEnv } from '../runtime';

/**
 * Azure OpenAI reviewer.
 *
 * Azure needs more than a key — the resource name, deployment and API version
 * are all account-specific — so the whole connection is stored as JSON in the
 * Azure reviewer secret.
 */
interface AzureSecret {
  apiKey: string;
  resourceName: string;
  deployment: string;
  apiVersion: string;
}

export async function reviewerModel(): Promise<LanguageModel> {
  const secret = await readSecretJson<AzureSecret>(
    requireEnv('AZURE_SECRET_ID'),
  );
  const azure = createAzure({
    apiKey: secret.apiKey,
    resourceName: secret.resourceName,
    apiVersion: secret.apiVersion,
  });
  return azure(secret.deployment);
}
