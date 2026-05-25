import { z } from 'zod';
import type { ReviewProvider } from '../../lib/config';

/**
 * The verdict a single reviewer returns for one draft.
 *
 * This is enforced as *structured output*: every provider is asked to return
 * exactly this shape and the AI SDK validates the response against it — there
 * is no text parsing, and a response that cannot satisfy the schema is treated
 * as a provider failure (the reviewer becomes `unavailable`).
 */
export const ReviewVerdict = z.object({
  /** Publishability score: 1 (unpublishable) … 10 (ship it as-is). */
  score: z.number().int().min(1).max(10),
  /**
   * True only when the reviewer found something that *must* block publication
   * — a factual error, a legal/safety problem, broken structure. Ordinary
   * polish is reflected in the score, not here.
   */
  blocker: z.boolean(),
  /** The critique: what works, what does not, and what to change. */
  critique: z.string().min(1),
});

export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

/**
 * One reviewer's result as it travels through the state machine.
 *
 * `ok` carries the verdict; `unavailable` is a provider that could not be
 * reached or did not return a usable verdict — recorded, then excluded from the
 * gate. The gate's quorum rule decides whether enough `ok` results remain.
 */
export type ReviewResult =
  | ({ provider: ReviewProvider; status: 'ok' } & ReviewVerdict)
  | { provider: ReviewProvider; status: 'unavailable'; error: string };

/** Why a post ended where it did — recorded on the post item as `reviewOutcome`. */
export type ReviewOutcome = 'passed' | 'capped' | 'quorum' | 'exception';
