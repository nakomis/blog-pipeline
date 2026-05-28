import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { readParameterJson, requireEnv } from '../runtime';

/**
 * Azure (GPT) reviewer — served from Azure AI Foundry.
 *
 * Our GPT model is deployed on the same Foundry resource as Grok, behind the
 * OpenAI-compatible `/models/chat/completions` endpoint (`api-key` header,
 * `api-version` query parameter) — *not* the classic Azure OpenAI surface. The
 * `@ai-sdk/azure` provider routes reasoning models (e.g. `gpt-5`) through an
 * API version this resource rejects, so we talk to Foundry directly the same
 * way `grok.ts` does. The full hostname, deployment, key and version are all
 * account-specific, so the whole connection is stored as JSON in the Azure
 * reviewer SSM parameter.
 */
interface AzureSecret {
  apiKey: string;
  /** Full Foundry hostname, e.g. `https://<instance>.services.ai.azure.com`. */
  endpoint: string;
  /** Foundry deployment name, e.g. `gpt-5`. */
  deployment: string;
  /** Foundry inference API version, e.g. `2024-05-01-preview`. */
  apiVersion: string;
}

export async function reviewerModel(): Promise<LanguageModel> {
  const secret = await readParameterJson<AzureSecret>(
    requireEnv('AZURE_PARAM_NAME'),
  );
  const baseURL = `${secret.endpoint.replace(/\/$/, '')}/models`;
  const provider = createOpenAICompatible({
    name: 'azure-foundry',
    baseURL,
    headers: { 'api-key': secret.apiKey },
    queryParams: { 'api-version': secret.apiVersion },
    // gpt-5 is a reasoning model; in plain json_object mode it intermittently
    // returns a verdict that fails our Zod schema. Structured outputs constrain
    // it to the exact schema (`response_format: json_schema`, strict).
    supportsStructuredOutputs: true,
  });
  return provider(secret.deployment);
}
