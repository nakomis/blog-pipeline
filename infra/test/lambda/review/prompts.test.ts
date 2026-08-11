import {
  buildReviewPrompt,
  buildRedraftPrompt,
  REVIEW_SYSTEM_PROMPT,
  REDRAFT_SYSTEM_PROMPT,
} from '../../../lambda/review/prompts';
import type { ReviewResult } from '../../../lambda/review/schema';

const ok = (blocker: boolean): ReviewResult => ({
  provider: 'grok',
  status: 'ok',
  score: 6,
  blocker,
  critique: 'fix the intro',
});

test('buildReviewPrompt embeds the draft', () => {
  expect(buildReviewPrompt('# Hello world')).toContain('# Hello world');
});

test('the system prompts are non-empty', () => {
  expect(REVIEW_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  expect(REDRAFT_SYSTEM_PROMPT.length).toBeGreaterThan(0);
});

describe('buildRedraftPrompt', () => {
  test('includes the draft and the ok critiques', () => {
    const prompt = buildRedraftPrompt('the draft body', [ok(false)]);
    expect(prompt).toContain('the draft body');
    expect(prompt).toContain('fix the intro');
  });

  test('flags a reviewer that raised a blocker', () => {
    expect(buildRedraftPrompt('d', [ok(true)])).toContain('BLOCKER raised');
  });

  test('omits the blocker flag when none was raised', () => {
    expect(buildRedraftPrompt('d', [ok(false)])).not.toContain('BLOCKER raised');
  });

  test('excludes unavailable reviewers from the critiques', () => {
    const prompt = buildRedraftPrompt('d', [
      ok(false),
      { provider: 'azure', status: 'unavailable', error: 'down' },
    ]);
    expect(prompt).not.toContain('azure');
  });
});

// A reviewer is sent the system prompt and one draft — nothing else. Without
// being told so it fills the gap: an early review of a corpusmap post opened
// "genuinely one of the strongest technical write-ups I've reviewed for this
// blog", a comparison it had no set to draw on. The persona implies an ongoing
// role, and the model furnishes the role's backstory.
test('the review prompt forbids comparative and historical claims', () => {
  const p = REVIEW_SYSTEM_PROMPT.toLowerCase();
  expect(p).toContain('in isolation');
  expect(p).toMatch(/no memory of previous\s+reviews/);
  expect(p).toMatch(/do not make\s+comparative/);
});

test('the review prompt still asks for evidence from the draft itself', () => {
  expect(REVIEW_SYSTEM_PROMPT.toLowerCase()).toMatch(
    /supported by the draft in\s+front/,
  );
});
