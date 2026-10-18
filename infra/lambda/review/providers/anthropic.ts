import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';
import { LINKS, REVIEW } from '../../../lib/config';
import { readParameterJson, requireEnv } from '../runtime';

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
  const secret = await readParameterJson<AnthropicSecret>(
    requireEnv('ANTHROPIC_PARAM_NAME'),
  );
  const anthropic = createAnthropic({ apiKey: secret.apiKey });
  return anthropic(REVIEW.models.anthropic);
}

/**
 * The link/repo suggestion model (PIPE-38) — Claude Haiku via the direct
 * Anthropic API, using the same key parameter as the reviewer.
 */
export async function suggestModel(): Promise<LanguageModel> {
  const secret = await readParameterJson<AnthropicSecret>(
    requireEnv('ANTHROPIC_PARAM_NAME'),
  );
  return createAnthropic({ apiKey: secret.apiKey })(LINKS.model);
}
