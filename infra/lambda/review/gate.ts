import { REVIEW, requiredReviewers } from '../../lib/config';
import type { ReviewResult } from './schema';

/**
 * The review loop's deterministic gate.
 *
 * This is the only place the loop decides what happens next, and it does so
 * with **no LLM and no I/O** — a pure function of the iteration's reviews and
 * the iteration count. That is what makes the loop's behaviour predictable and
 * exhaustively unit-testable.
 */

/** What the gate decides should happen after an iteration's fan-out. */
export type GateDecision = 'pass' | 'loop' | 'fail-capped' | 'fail-quorum';

export interface GateInput {
  /** The fan-out results for this iteration (ok and unavailable mixed). */
  reviews: ReviewResult[];
  /** 1-based iteration number just reviewed. */
  iteration: number;
}

export interface GateOutput {
  decision: GateDecision;
  /** Lowest score among reviewers that returned a verdict; `null` if none did. */
  minScore: number | null;
  /** True if any usable verdict raised a blocker. */
  anyBlocker: boolean;
  /** Number of reviewers that returned a usable verdict. */
  okCount: number;
  /** True once the iteration cap has been reached. */
  capped: boolean;
}

/**
 * Decide the fate of an iteration.
 *
 * 1. **Quorum first.** Fewer than `ceil(REVIEW.quorum × providers)` usable
 *    verdicts and the result cannot be trusted → `fail-quorum`.
 * 2. **Pass.** Every usable verdict at or above the threshold, and no blocker
 *    → `pass`.
 * 3. **Capped.** Not a pass, but the iteration cap is reached → `fail-capped`.
 * 4. **Loop.** Otherwise → `loop`: redraft and review again.
 */
export function decideGate({ reviews, iteration }: GateInput): GateOutput {
  const ok = reviews.filter(
    (r): r is Extract<ReviewResult, { status: 'ok' }> => r.status === 'ok',
  );
  const okCount = ok.length;
  const capped = iteration >= REVIEW.maxIterations;
  const anyBlocker = ok.some((r) => r.blocker);
  const minScore =
    okCount > 0 ? Math.min(...ok.map((r) => r.score)) : null;

  if (okCount < requiredReviewers()) {
    return { decision: 'fail-quorum', minScore, anyBlocker, okCount, capped };
  }

  // minScore is non-null here: okCount >= requiredReviewers() >= 1.
  const passes =
    (minScore as number) >= REVIEW.publishabilityThreshold && !anyBlocker;

  let decision: GateDecision;
  if (passes) {
    decision = 'pass';
  } else if (capped) {
    decision = 'fail-capped';
  } else {
    decision = 'loop';
  }

  return { decision, minScore, anyBlocker, okCount, capped };
}

/** Step Functions Task entry point — a thin async wrapper over `decideGate`. */
export async function handler(event: GateInput): Promise<GateOutput> {
  return decideGate(event);
}
