import type { LanguageModel } from 'ai';
import type { ReviewProvider } from '../../../lib/config';
import { reviewerModel as azure } from './azure';
import { reviewerModel as gemini } from './gemini';
import { reviewerModel as anthropic } from './anthropic';
import { reviewerModel as grok } from './grok';

/**
 * The reviewer provider registry.
 *
 * Each factory builds an AI SDK language model for one provider, reading its
 * secret where one is needed. A factory that throws (a missing or empty secret,
 * an unreachable endpoint) is what makes a provider `unavailable` — the reviewer
 * fan-out catches it and the gate's quorum rule does the rest.
 *
 * The Bedrock `reviewerModel` exists in `./bedrock` but is intentionally absent
 * from this registry — the agreed PIPE-3 panel dropped it. To re-include it,
 * add `'bedrock'` to `REVIEW.providers` in `lib/config.ts` and add a `bedrock`
 * entry here. The Bedrock module is still imported below for the redrafter.
 */
const FACTORIES: Record<ReviewProvider, () => Promise<LanguageModel>> = {
  azure,
  gemini,
  anthropic,
  grok,
};

/** Build the language model for a reviewer provider. */
export function reviewerModel(provider: ReviewProvider): Promise<LanguageModel> {
  return FACTORIES[provider]();
}

export { redraftModel } from './bedrock';
