import { generateObject } from 'ai';
import type { ReviewProvider } from '../../lib/config';
import { getDraft } from './drafts';
import { reviewerModel } from './providers';
import { REVIEW_SYSTEM_PROMPT, buildReviewPrompt } from './prompts';
import { ReviewVerdict } from './schema';
import type { ReviewResult } from './schema';

/**
 * One reviewer in the fan-out.
 *
 * Invoked once per provider by the state machine's `Map`. It reads the draft,
 * builds the provider's model, and asks for a structured `ReviewVerdict` — the
 * AI SDK enforces the schema, so there is nothing to parse.
 *
 * This handler **does not catch failures**. A missing secret, an unreachable
 * provider or a response that cannot satisfy the schema all throw — and the
 * `Map` branch's `Catch` turns the failure into an `unavailable` result. The
 * gate's quorum rule decides whether enough reviewers remained.
 */
export interface ReviewerInput {
  slug: string;
  iteration: number;
  draftKey: string;
  provider: ReviewProvider;
}

export async function handler(event: ReviewerInput): Promise<ReviewResult> {
  const { provider, draftKey } = event;

  const draft = await getDraft(draftKey);
  const model = await reviewerModel(provider);

  const { object } = await generateObject({
    model,
    schema: ReviewVerdict,
    system: REVIEW_SYSTEM_PROMPT,
    prompt: buildReviewPrompt(draft),
  });

  return {
    provider,
    status: 'ok',
    score: object.score,
    blocker: object.blocker,
    critique: object.critique,
  };
}
