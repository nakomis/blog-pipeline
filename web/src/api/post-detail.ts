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

/** The full detail bundle for one post — everything the bag renders. */
export interface PostDetail {
  post: Post;
  finalMarkdown: string;
  originalMarkdown: string;
  iterations: IterationDetail[];
  images: ImageDetail[];
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

export interface DecisionResult {
  slug: string;
  decision: 'approve' | 'reject';
  status: string;
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

/** Approves or rejects a staged post. */
export async function decidePost(
  slug: string,
  decision: 'approve' | 'reject',
  idToken: string,
): Promise<DecisionResult> {
  const { apiUrl } = getConfig();
  const response = await fetch(
    `${apiUrl}/posts/${encodeURIComponent(slug)}/decision`,
    {
      method: 'POST',
      headers: { ...authHeaders(idToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to record decision (HTTP ${response.status})`);
  }
  return (await response.json()) as DecisionResult;
}
