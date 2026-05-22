import type { LanguageModel } from 'ai';
import type { ReviewProvider } from '../../../lib/config';
import { reviewerModel as bedrock } from './bedrock';
import { reviewerModel as azure } from './azure';
import { reviewerModel as gemini } from './gemini';
import { reviewerModel as anthropic } from './anthropic';

/**
 * The reviewer provider registry.
 *
 * Each factory builds an AI SDK language model for one provider, reading its
 * secret where one is needed. A factory that throws (a missing or empty secret,
 * an unreachable endpoint) is what makes a provider `unavailable` — the reviewer
 * fan-out catches it and the gate's quorum rule does the rest.
 */
const FACTORIES: Record<ReviewProvider, () => Promise<LanguageModel>> = {
  bedrock,
  azure,
  gemini,
  anthropic,
};

/** Build the language model for a reviewer provider. */
export function reviewerModel(provider: ReviewProvider): Promise<LanguageModel> {
  return FACTORIES[provider]();
}

export { redraftModel } from './bedrock';
