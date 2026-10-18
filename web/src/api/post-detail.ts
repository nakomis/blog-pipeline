import { getConfig } from '../config/config';
import type { Post } from './posts';

/** One reviewer's verdict for an iteration, as surfaced in the bag. */
export type ReviewResult =
  | {
      provider: string;
      status: 'ok';
      score: number;
      blocker: boolean;
      critique: string;
    }
  | { provider: string; status: 'unavailable'; error: string };

/** The gate's deterministic decision for an iteration. */
export interface GateOutcome {
  decision: 'pass' | 'loop' | 'fail-capped' | 'fail-quorum';
  minScore: number | null;
  anyBlocker: boolean;
  okCount: number;
  capped: boolean;
}

/** One review iteration: the reviewers' verdicts plus the gate decision. */
export interface IterationDetail {
  iteration: number;
  reviews: ReviewResult[];
  gate: GateOutcome | null;
  /** True if a human edit produced this iteration rather than a redraft. */
  edited: boolean;
}

/** A generated image with a (presigned) URL once it is ready. */
export interface ImageDetail {
  index: number;
  prompt: string;
  status: 'pending' | 'ready' | 'failed';
  url?: string;
}

/** A parsed frontmatter value: text, a list, or a nested mapping. */
export type FrontmatterValue =
  | string
  | FrontmatterValue[]
  | { [key: string]: FrontmatterValue };

/** One frontmatter check result (PIPE-37). Always a warning, never a blocker. */
export interface FrontmatterWarning {
  code:
    | 'missing-field'
    | 'canonical-mismatch'
    | 'date-mismatch'
    | 'approved-by-hand'
    | 'frontmatter-missing'
    | 'frontmatter-invalid'
    | 'frontmatter-changed'
    | 'repos-malformed'
    /** Added in the browser from the live GitHub check; never sent by the API. */
    | 'repo-unreachable';
  field?: string;
  message: string;
}

/** The author's frontmatter, parsed, with the API's warnings. */
export interface FrontmatterInfo {
  present: boolean;
  raw: string | null;
  fields: Record<string, FrontmatterValue> | null;
  parseError?: string;
  /** False when the filename was unknown, so filename-based checks were skipped. */
  filenameKnown: boolean;
  warnings: FrontmatterWarning[];
}

/** Whether a `repos:` URL is visible on GitHub. */
export interface RepoCheck {
  name: string;
  url: string;
  state: 'ok' | 'private' | 'not-found' | 'unchecked' | 'error';
  detail?: string;
}

/** Martin's call on one suggestion (PIPE-38). */
export type SuggestionDecision = 'pending' | 'accepted' | 'rejected';

/** A suggested link from the post to an earlier post. */
export interface LinkSuggestion {
  id: string;
  kind: 'link';
  /** The exact phrase in the post that would become the link text. */
  anchorText: string;
  /** Surrounding text, for display. */
  context: string;
  targetSlug: string;
  targetTitle: string;
  /** From the blog's own index — never from the model. */
  targetUrl: string;
  targetDate: string;
  occurrence: { paragraph: number; offset: number };
  /** Haiku's reason, shown on hover or focus. */
  reason: string;
  decision: SuggestionDecision;
}

/**
 * A suggested `repos:` entry. `name` and `url` mirror the frontmatter list
 * item shape so a frontmatter panel can render these beside the existing repos.
 */
export interface RepoSuggestion {
  id: string;
  kind: 'repo';
  fullName: string;
  name: string;
  url: string;
  description: string | null;
  evidence: string;
  reason: string;
  source: 'llm' | 'url-in-post';
  decision: SuggestionDecision;
}

/** Everything the link/repo suggestion step produced for a post. */
export interface Suggestions {
  version: 1;
  slug: string;
  iteration: number;
  generatedAt: string;
  /** `skipped` and `error` carry the reason in `skippedReason`; the post is staged regardless. */
  status: 'ok' | 'skipped' | 'error';
  skippedReason?: string;
  models: { chat: string; embed: string };
  links: LinkSuggestion[];
  repos: RepoSuggestion[];
  dropped: { kind: 'link' | 'repo'; value: string; reason: string }[];
}

/** The full detail bundle for one post — everything the bag renders. */
export interface PostDetail {
  post: Post;
  finalMarkdown: string;
  originalMarkdown: string;
  iterations: IterationDetail[];
  images: ImageDetail[];
  /** Absent when the web app is deployed ahead of the API. */
  frontmatter?: FrontmatterInfo;
  /** Optional so a web deploy ahead of the API still works (PIPE-38). */
  suggestions?: Suggestions | null;
}

function authHeaders(idToken: string): Record<string, string> {
  return { Authorization: `Bearer ${idToken}` };
}

/** Fetches the detail bundle for a single post. */
export async function fetchPostDetail(
  slug: string,
  idToken: string,
): Promise<PostDetail> {
  const { apiUrl } = getConfig();
  const response = await fetch(
    `${apiUrl}/posts/${encodeURIComponent(slug)}`,
    { headers: authHeaders(idToken) },
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch post (HTTP ${response.status})`);
  }
  return (await response.json()) as PostDetail;
}

/** Checks, live against GitHub, whether the post's `repos:` URLs are public. */
export async function fetchRepoChecks(
  slug: string,
  idToken: string,
): Promise<RepoCheck[]> {
  const { apiUrl } = getConfig();
  const response = await fetch(
    `${apiUrl}/posts/${encodeURIComponent(slug)}/repo-checks`,
    { headers: authHeaders(idToken) },
  );
  if (!response.ok) {
    throw new Error(`Failed to check repositories (HTTP ${response.status})`);
  }
  const body = (await response.json()) as { repos: RepoCheck[] };
  return body.repos;
}

export interface EditResult {
  slug: string;
  iteration: number;
  reReview: boolean;
  status: string;
}

/**
 * Saves an edited draft as the next iteration. With `reReview` the post
 * re-enters the review loop from that iteration; otherwise it stays in the bag.
 */
export async function editPost(
  slug: string,
  markdown: string,
  reReview: boolean,
  idToken: string,
): Promise<EditResult> {
  const { apiUrl } = getConfig();
  const response = await fetch(
    `${apiUrl}/posts/${encodeURIComponent(slug)}/edit`,
    {
      method: 'POST',
      headers: { ...authHeaders(idToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown, reReview }),
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to save edit (HTTP ${response.status})`);
  }
  return (await response.json()) as EditResult;
}

/** A failed post's editable Markdown (PIPE-36). */
export interface FailedMarkdown {
  slug: string;
  iteration: number;
  markdown: string;
  /** True if this is a saved edit that has not been reviewed yet. */
  pendingEdit: boolean;
}

/** Fetches a failed post's Markdown for editing in place. */
export async function fetchFailedMarkdown(
  slug: string,
  idToken: string,
): Promise<FailedMarkdown> {
  const { apiUrl } = getConfig();
  const response = await fetch(
    `${apiUrl}/posts/${encodeURIComponent(slug)}/markdown`,
    { headers: authHeaders(idToken) },
  );
  if (!response.ok) {
    throw new Error(`Failed to load Markdown for editing (HTTP ${response.status})`);
  }
  return (await response.json()) as FailedMarkdown;
}

export interface SaveFailedResult {
  slug: string;
  iteration: number;
  status: string;
  pendingEdit: boolean;
}

/**
 * Saves an edit to a failed post. The post stays failed; repeated saves
 * overwrite the same pending iteration until it is re-reviewed.
 */
export async function saveFailedMarkdown(
  slug: string,
  markdown: string,
  idToken: string,
): Promise<SaveFailedResult> {
  const { apiUrl } = getConfig();
  const response = await fetch(
    `${apiUrl}/posts/${encodeURIComponent(slug)}/markdown`,
    {
      method: 'POST',
      headers: { ...authHeaders(idToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown }),
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to save edit (HTTP ${response.status})`);
  }
  return (await response.json()) as SaveFailedResult;
}

export interface ReReviewResult {
  slug: string;
  iteration: number;
  status: string;
  /** True if this request repeated a re-review that had already started. */
  alreadyStarted: boolean;
}

/**
 * Sends a failed post back into the review loop with the given Markdown,
 * clearing its failure reason (the history is kept). Safe to retry.
 */
export async function reReviewFailed(
  slug: string,
  markdown: string,
  idToken: string,
): Promise<ReReviewResult> {
  const { apiUrl } = getConfig();
  const response = await fetch(
    `${apiUrl}/posts/${encodeURIComponent(slug)}/rereview`,
    {
      method: 'POST',
      headers: { ...authHeaders(idToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown }),
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to start re-review (HTTP ${response.status})`);
  }
  return (await response.json()) as ReReviewResult;
}

export interface DecisionResult {
  slug: string;
  decision: 'approve' | 'reject';
  status: string;
  /** On approval: how many accepted suggestions were written (PIPE-38). */
  applied?: { links: number; repos: number };
  /** Accepted links that no longer fitted the text and were left out. */
  skipped?: { id: string; reason: string }[];
}

/**
 * Records accept / reject / pending choices for suggestions. Nothing is
 * applied to the post until it is approved.
 */
export async function setSuggestionDecisions(
  slug: string,
  decisions: Record<string, SuggestionDecision>,
  idToken: string,
): Promise<Suggestions> {
  const { apiUrl } = getConfig();
  const response = await fetch(
    `${apiUrl}/posts/${encodeURIComponent(slug)}/suggestions`,
    {
      method: 'POST',
      headers: { ...authHeaders(idToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ decisions }),
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to save suggestion choice (HTTP ${response.status})`);
  }
  return ((await response.json()) as { suggestions: Suggestions }).suggestions;
}

export interface PublishNowResult {
  dispatched: boolean;
  workflow: string;
  repo: string;
}

/**
 * Publishes on demand every approved post whose `publish_date` has arrived,
 * without waiting for the 04:00 UTC cron. Dispatches the `promote-approved`
 * workflow on blog-content (PIPE-14).
 */
export async function publishNow(idToken: string): Promise<PublishNowResult> {
  const { apiUrl } = getConfig();
  const response = await fetch(`${apiUrl}/publish-now`, {
    method: 'POST',
    headers: { ...authHeaders(idToken), 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) {
    throw new Error(`Failed to trigger publish (HTTP ${response.status})`);
  }
  return (await response.json()) as PublishNowResult;
}

/**
 * How a post should behave on Bluesky once live (PIPE-29):
 * - 'announce' — announced on publication, subject to the flood guard;
 * - 'skip' — never announced;
 * - 'force' — announced on publication, bypassing the flood guard.
 */
export type AnnounceMode = 'announce' | 'skip' | 'force';

/**
 * Approves or rejects a staged post. On approval, `announceBluesky` records
 * how the post should be announced on Bluesky once live (PIPE-20/PIPE-29).
 */
export async function decidePost(
  slug: string,
  decision: 'approve' | 'reject',
  idToken: string,
  announceBluesky: AnnounceMode = 'announce',
): Promise<DecisionResult> {
  const { apiUrl } = getConfig();
  const response = await fetch(
    `${apiUrl}/posts/${encodeURIComponent(slug)}/decision`,
    {
      method: 'POST',
      headers: { ...authHeaders(idToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, announceBluesky }),
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to record decision (HTTP ${response.status})`);
  }
  return (await response.json()) as DecisionResult;
}
