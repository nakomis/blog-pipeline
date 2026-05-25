import { createAzure } from '@ai-sdk/azure';
import type { LanguageModel } from 'ai';
import { readParameterJson, requireEnv } from '../runtime';

/**
 * Azure OpenAI reviewer.
 *
 * Azure needs more than a key — the resource name, deployment and API version
 * are all account-specific — so the whole connection is stored as JSON in the
 * Azure reviewer SSM parameter.
 */
interface AzureSecret {
  apiKey: string;
  resourceName: string;
  deployment: string;
  apiVersion: string;
}

export async function reviewerModel(): Promise<LanguageModel> {
  const secret = await readParameterJson<AzureSecret>(
    requireEnv('AZURE_PARAM_NAME'),
  );
  const azure = createAzure({
    apiKey: secret.apiKey,
    resourceName: secret.resourceName,
    apiVersion: secret.apiVersion,
  });
  return azure(secret.deployment);
}
