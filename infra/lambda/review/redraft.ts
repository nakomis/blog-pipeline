import { generateText } from 'ai';
import { REVIEW } from '../../lib/config';
import type { ReviewProvider } from '../../lib/config';
import { draftKey, getDraft, putDraft } from './drafts';
import { redraftModel } from './providers';
import { REDRAFT_SYSTEM_PROMPT, buildRedraftPrompt } from './prompts';
import type { ReviewResult } from './schema';

/**
 * The redraft step.
 *
 * Between iterations, Claude Sonnet rewrites the draft against the aggregated
 * reviewer critiques and the new draft is written as the next iteration. The
 * returned object is the *next* loop state — it carries `providers` so the
 * state machine's `Map` can fan out again.
 */
export interface RedraftInput {
  slug: string;
  iteration: number;
  draftKey: string;
  reviews: ReviewResult[];
  /** Carried through so the relative cap survives each loop (PIPE-4). */
  baseIteration?: number;
}

export interface RedraftOutput {
  slug: string;
  iteration: number;
  baseIteration: number;
  draftKey: string;
  providers: ReviewProvider[];
}

export async function handler(event: RedraftInput): Promise<RedraftOutput> {
  const { slug, iteration, reviews } = event;
  const baseIteration = event.baseIteration ?? 1;

  const currentDraft = await getDraft(event.draftKey);

  const { text } = await generateText({
    model: redraftModel(),
    system: REDRAFT_SYSTEM_PROMPT,
    prompt: buildRedraftPrompt(currentDraft, reviews),
  });

  const nextIteration = iteration + 1;
  const nextKey = draftKey(slug, nextIteration);
  await putDraft(nextKey, text);

  return {
    slug,
    iteration: nextIteration,
    baseIteration,
    draftKey: nextKey,
    providers: [...REVIEW.providers],
  };
}
