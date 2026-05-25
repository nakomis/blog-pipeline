import { decideGate, handler } from '../../lambda/review/gate';
import type { ReviewResult } from '../../lambda/review/schema';

/**
 * These tests assume the shipped `REVIEW` config: 4 providers, quorum 2/3
 * (→ 3 required), threshold 8, max 4 iterations. A config change should prompt
 * a deliberate revisit of these expectations.
 */

const ok = (
  provider: ReviewResult['provider'],
  score: number,
  blocker = false,
): ReviewResult => ({ provider, status: 'ok', score, blocker, critique: 'c' });

const down = (provider: ReviewResult['provider']): ReviewResult => ({
  provider,
  status: 'unavailable',
  error: 'boom',
});

describe('decideGate', () => {
  describe('quorum', () => {
    test('fails as fail-quorum when fewer than 3 reviewers return a verdict', () => {
      const result = decideGate({
        reviews: [ok('bedrock', 9), ok('gemini', 9), down('azure'), down('anthropic')],
        iteration: 1,
      });
      expect(result.decision).toBe('fail-quorum');
      expect(result.okCount).toBe(2);
    });

    test('quorum is checked before the score gate, even at the iteration cap', () => {
      const result = decideGate({
        reviews: [ok('bedrock', 10), down('gemini'), down('azure'), down('anthropic')],
        iteration: 4,
      });
      expect(result.decision).toBe('fail-quorum');
      expect(result.capped).toBe(true);
    });

    test('minScore is null when no reviewer returned a verdict', () => {
      const result = decideGate({
        reviews: [down('bedrock'), down('gemini'), down('azure'), down('anthropic')],
        iteration: 1,
      });
      expect(result.decision).toBe('fail-quorum');
      expect(result.okCount).toBe(0);
      expect(result.minScore).toBeNull();
      expect(result.anyBlocker).toBe(false);
    });

    test('a sub-quorum result still reports minScore and blocker over the ok reviews', () => {
      const result = decideGate({
        reviews: [ok('bedrock', 6, true), ok('gemini', 9), down('azure'), down('anthropic')],
        iteration: 1,
      });
      expect(result.decision).toBe('fail-quorum');
      expect(result.minScore).toBe(6);
      expect(result.anyBlocker).toBe(true);
    });
  });

  describe('pass', () => {
    test('passes when all four reviewers are >= 8 with no blocker', () => {
      const result = decideGate({
        reviews: [ok('bedrock', 8), ok('gemini', 9), ok('azure', 10), ok('anthropic', 8)],
        iteration: 1,
      });
      expect(result.decision).toBe('pass');
      expect(result.minScore).toBe(8);
      expect(result.anyBlocker).toBe(false);
      expect(result.okCount).toBe(4);
    });

    test('passes on exactly the quorum of 3 reviewers, all >= 8', () => {
      const result = decideGate({
        reviews: [ok('bedrock', 8), ok('gemini', 9), ok('anthropic', 9), down('azure')],
        iteration: 2,
      });
      expect(result.decision).toBe('pass');
    });

    test('a pass at the iteration cap is still a pass, not fail-capped', () => {
      const result = decideGate({
        reviews: [ok('bedrock', 9), ok('gemini', 9), ok('azure', 9), ok('anthropic', 9)],
        iteration: 4,
      });
      expect(result.decision).toBe('pass');
      expect(result.capped).toBe(true);
    });
  });

  describe('loop', () => {
    test('loops when one reviewer scores below the threshold', () => {
      const result = decideGate({
        reviews: [ok('bedrock', 7), ok('gemini', 9), ok('azure', 9), ok('anthropic', 9)],
        iteration: 1,
      });
      expect(result.decision).toBe('loop');
      expect(result.minScore).toBe(7);
    });

    test('loops when a reviewer raises a blocker despite high scores', () => {
      const result = decideGate({
        reviews: [ok('bedrock', 9, true), ok('gemini', 10), ok('azure', 9), ok('anthropic', 9)],
        iteration: 2,
      });
      expect(result.decision).toBe('loop');
      expect(result.anyBlocker).toBe(true);
    });
  });

  describe('fail-capped', () => {
    test('fails as fail-capped when a low score persists at iteration 4', () => {
      const result = decideGate({
        reviews: [ok('bedrock', 7), ok('gemini', 9), ok('azure', 9), ok('anthropic', 9)],
        iteration: 4,
      });
      expect(result.decision).toBe('fail-capped');
      expect(result.capped).toBe(true);
    });

    test('fails as fail-capped when a blocker persists at iteration 4', () => {
      const result = decideGate({
        reviews: [ok('bedrock', 9), ok('gemini', 9), ok('azure', 9, true), ok('anthropic', 9)],
        iteration: 4,
      });
      expect(result.decision).toBe('fail-capped');
    });
  });

  test('capped is false below the iteration cap and true at it', () => {
    const reviews = [ok('bedrock', 9), ok('gemini', 9), ok('azure', 9), ok('anthropic', 9)];
    expect(decideGate({ reviews, iteration: 3 }).capped).toBe(false);
    expect(decideGate({ reviews, iteration: 4 }).capped).toBe(true);
  });
});

describe('handler', () => {
  test('returns the decideGate result', async () => {
    const result = await handler({
      reviews: [ok('bedrock', 9), ok('gemini', 9), ok('azure', 9), ok('anthropic', 9)],
      iteration: 1,
    });
    expect(result.decision).toBe('pass');
  });
});
