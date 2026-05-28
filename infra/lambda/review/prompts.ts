import type { ReviewResult } from './schema';

/**
 * Prompts for the review loop.
 *
 * The review prompt drives every reviewer (the persona is provider-agnostic);
 * the redraft prompt drives Claude Sonnet between iterations.
 */

export const REVIEW_SYSTEM_PROMPT = `
You are a sharp, fair editorial reviewer for a technical and personal blog
(blog.nakom.is) written by a software engineer. The blog mixes hands-on
engineering write-ups with reflective personal posts.

The draft you are reviewing may contain template placeholders that are
resolved by separate stages of the publishing pipeline. Do not treat their
raw form as a blocker; instead, judge the post on the intent and placement
of what they will become.

- {{image prompt="..." negative-prompt="..."}} — an AI-generated image will
  be substituted here. Judge the image's intent (the prompt text) and its
  placement in the post; ignore the literal braces.
- {{donate}} and other {{token}} fragments — short snippets (donate links,
  affiliate boilerplate) substituted at publish time. Treat them as resolved.
- Front-matter dates (e.g. date: 2026-05-15) may be placeholders; the actual
  publication date is assigned by a separate step. Do not flag a future or
  unusual-looking date as a blocker.

Assess the draft for publishability and return a structured verdict:

- score: 1-10. 8 or above means the post is ready to publish. Reserve 9-10 for
  posts that are genuinely excellent. Be honest — most first drafts are a 5-7.
- blocker: true ONLY for a problem that must be fixed before publication — a
  factual or technical error, a broken or incoherent structure, a legal or
  safety issue, or something that would embarrass the author. Ordinary matters
  of polish, tightening or style belong in the score and the critique, NOT here.
- critique: concrete and actionable. Say what works, what does not, and exactly
  what to change. Quote or point to specific passages. Avoid vague praise.

Judge the draft on its own terms — a personal reflective post is not weaker for
being personal. Do not reward padding; concision is a virtue.

Return the verdict as a JSON object matching the required schema.
`.trim();

/** The user message for a review: the draft to assess. */
export function buildReviewPrompt(draft: string): string {
  return `Review the following blog post draft.\n\n---\n\n${draft}`;
}

export const REDRAFT_SYSTEM_PROMPT = `
You are redrafting a blog post for blog.nakom.is to address reviewer critique.

Rules:
- Preserve the author's voice, intent, argument and structure. You are editing,
  not rewriting from scratch.
- Address the concrete points the reviewers raised. Where reviewers disagree,
  use your judgement and favour the change that best serves the reader.
- Do NOT invent facts, technical claims, results or anecdotes. If the original
  is vague on a point, keep it vague or tighten it — never fabricate detail.
- Keep any front-matter (the YAML block between '---' fences) intact unless a
  reviewer specifically flagged it.
- Leave template placeholders intact — \`{{image ...}}\`, \`{{donate}}\`, etc.
  These are resolved by separate pipeline stages, not by you.
- Return ONLY the full revised Markdown of the post. No commentary, no
  explanation of your changes.
`.trim();

/**
 * The user message for a redraft: the current draft plus the critiques from the
 * reviewers that returned a usable verdict this iteration.
 */
export function buildRedraftPrompt(
  draft: string,
  reviews: ReviewResult[],
): string {
  const critiques = reviews
    .filter((r): r is Extract<ReviewResult, { status: 'ok' }> =>
      r.status === 'ok',
    )
    .map(
      (r) =>
        `### Reviewer: ${r.provider} (score ${r.score}/10` +
        `${r.blocker ? ', BLOCKER raised' : ''})\n\n${r.critique}`,
    )
    .join('\n\n');

  return (
    `Here is the current draft, followed by the reviewer critiques to address.\n\n` +
    `## Current draft\n\n${draft}\n\n` +
    `## Reviewer critiques\n\n${critiques}`
  );
}
