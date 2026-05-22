import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';
import { REVIEW } from '../../../lib/config';
import { readSecretJson, requireEnv } from '../runtime';

/**
 * Anthropic reviewer — Claude Opus via the direct Anthropic API.
 *
 * Deliberately a different model from the Bedrock Claude Sonnet redrafter, so
 * the model that rewrites the post never also grades its own work.
 */
interface AnthropicSecret {
  apiKey: string;
}

export async function reviewerModel(): Promise<LanguageModel> {
  const secret = await readSecretJson<AnthropicSecret>(
    requireEnv('ANTHROPIC_SECRET_ID'),
  );
  const anthropic = createAnthropic({ apiKey: secret.apiKey });
  return anthropic(REVIEW.models.anthropic);
}
