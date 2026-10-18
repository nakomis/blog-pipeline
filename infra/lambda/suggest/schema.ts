import { z } from 'zod';

/**
 * Schemas and shapes for link and repo suggestions (PIPE-38).
 *
 * The `Picks` schema is what Haiku must return (enforced by the AI SDK's
 * structured output). The TypeScript interfaces below are what we store in
 * S3, serve from `GET /posts/{slug}` and render in the bag — the web app
 * mirrors them in `web/src/api/post-detail.ts`.
 */

export const LinkPick = z.object({
  /** Exact phrase quoted from the post. */
  anchor_text: z.string().min(2),
  /** Must be one of the candidate slugs we supplied. */
  target_slug: z.string(),
  /** The model's own check that the passage refers to the target's subject. */
  same_subject: z.boolean(),
  /** Shown to Martin on hover or focus in the bag. */
  reason: z.string().min(1).max(300),
});

export const RepoPick = z.object({
  /** `owner/name`, must be on the list we supplied. */
  full_name: z.string(),
  /** An exact sentence from the post that shows it discusses the repo. */
  evidence_quote: z.string().min(2),
  reason: z.string().min(1).max(300),
});

export const Picks = z.object({
  // A model told to "return an empty list" sometimes omits the key instead
  // (seen with Haiku 4.5 in the eval); an absent list means none.
  links: z.array(LinkPick).max(10).default([]),
  repos: z.array(RepoPick).max(5).default([]),
});

export type LinkPick = z.infer<typeof LinkPick>;
export type RepoPick = z.infer<typeof RepoPick>;
export type Picks = z.infer<typeof Picks>;

export type Decision = 'pending' | 'accepted' | 'rejected';

export interface LinkSuggestion {
  /** sha1(anchorText + NUL + targetSlug), first 12 hex — stable across regenerations. */
  id: string;
  kind: 'link';
  anchorText: string;
  /** About 80 characters either side of the anchor, for display. */
  context: string;
  /** The dated stem, as in the embeddings index. */
  targetSlug: string;
  targetTitle: string;
  /** From the index record — never from the model. */
  targetUrl: string;
  targetDate: string;
  /** Validated location of the single occurrence when generated. */
  occurrence: { paragraph: number; offset: number };
  reason: string;
  decision: Decision;
}

export interface RepoSuggestion {
  /** sha1('repo' + NUL + lowercase fullName), first 12 hex. */
  id: string;
  kind: 'repo';
  fullName: string;
  /** The frontmatter `name:`. */
  name: string;
  /** `html_url` from the GitHub API. */
  url: string;
  description: string | null;
  evidence: string;
  reason: string;
  source: 'llm' | 'url-in-post';
  decision: Decision;
}

export interface DroppedSuggestion {
  kind: 'link' | 'repo';
  value: string;
  reason: string;
}

export interface Suggestions {
  version: 1;
  slug: string;
  iteration: number;
  generatedAt: string;
  status: 'ok' | 'skipped' | 'error';
  skippedReason?: string;
  models: { chat: string; embed: string };
  links: LinkSuggestion[];
  repos: RepoSuggestion[];
  dropped: DroppedSuggestion[];
}

/** The small summary kept on the post row (`suggestionsSummary`). */
export interface SuggestionsSummary {
  iteration: number;
  status: Suggestions['status'];
  skippedReason?: string;
  links: number;
  repos: number;
  undecided: number;
  generatedAt: string;
}

/** An earlier post the model may link to. */
export interface Candidate {
  /** The dated stem. */
  slug: string;
  title: string;
  date: string;
  url: string;
  excerpt: string;
  score: number;
  evidence: { passage: string; earlier: string; similarity: number }[];
}

/** A public repository we may suggest. */
export interface RepoInfo {
  owner: string;
  name: string;
  fullName: string;
  url: string;
  description: string | null;
  private: boolean;
  fork: boolean;
}
