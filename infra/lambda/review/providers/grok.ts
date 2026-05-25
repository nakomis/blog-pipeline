import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { readParameterJson, requireEnv } from '../runtime';

/**
 * Grok-on-Foundry reviewer.
 *
 * Azure AI Foundry exposes xAI Grok models behind an OpenAI-compatible
 * `/models/chat/completions` endpoint, authenticated with an `api-key` header
 * and an `api-version` query parameter. The full Foundry hostname, deployment
 * name, key and version are all account-specific, so the whole connection is
 * stored as JSON in the Grok reviewer SSM parameter.
 *
 * Note this is *not* the same shape as the Azure OpenAI reviewer (`azure.ts`),
 * which targets the classic `https://<resource>.openai.azure.com/openai/...`
 * URL — Foundry's inference endpoint is a different surface.
 */
interface GrokSecret {
  apiKey: string;
  /** Full Foundry hostname, e.g. `https://<instance>.services.ai.azure.com`. */
  endpoint: string;
  /** Foundry deployment name, e.g. `grok-4.3`. */
  deployment: string;
  /** Foundry inference API version, e.g. `2024-05-01-preview`. */
  apiVersion: string;
}

export async function reviewerModel(): Promise<LanguageModel> {
  const secret = await readParameterJson<GrokSecret>(
    requireEnv('GROK_PARAM_NAME'),
  );
  const baseURL = `${secret.endpoint.replace(/\/$/, '')}/models`;
  const provider = createOpenAICompatible({
    name: 'grok-foundry',
    baseURL,
    headers: { 'api-key': secret.apiKey },
    queryParams: { 'api-version': secret.apiVersion },
  });
  return provider(secret.deployment);
}
