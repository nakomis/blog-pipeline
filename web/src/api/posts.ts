import { getConfig } from '../config/config';
import type { PipelineStageId } from '../App';

/** One blog post as stored in DynamoDB and served by the dashboard API. */
export interface Post {
  /** Unique post slug — the DynamoDB partition key. */
  slug: string;
  /** Pipeline stage the post currently sits in. */
  status: PipelineStageId;
  title: string;
  /** ISO 8601 timestamp of the last pipeline activity. */
  updatedAt: string;
  createdAt?: string;
  /** Short blurb shown on the dashboard card. */
  summary?: string;
  /** Number of review iterations run so far (0–4). */
  reviewIteration?: number;
  /** Latest minimum publishability score (0–100), if reviewed. */
  publishabilityScore?: number;
  /** The blog go-live date (YYYY-MM-DD), stamped when the post is promoted. */
  publishDate?: string;
}

/**
 * The dashboard stage a post presents in. `published` rows whose publish date
 * has not yet arrived show as the derived `scheduled` stage ("Queued" column)
 * — promoted to blog-content, but the blog's date gate holds them back
 * (PIPE-17).
 */
export function displayStage(
  post: Pick<Post, 'status' | 'publishDate'>,
  today: string = new Date().toISOString().slice(0, 10),
): PipelineStageId {
  if (
    post.status === 'published' &&
    post.publishDate !== undefined &&
    post.publishDate > today
  ) {
    return 'scheduled';
  }
  return post.status;
}

/**
 * Fetches every post from the dashboard API.
 *
 * @param idToken Cognito ID token — sent as a bearer token. API Gateway's
 *                scopeless Cognito authorizer validates the ID token; an
 *                access token (`token_use: "access"`) is rejected with 401.
 */
export async function fetchPosts(idToken: string): Promise<Post[]> {
  const { apiUrl } = getConfig();

  const response = await fetch(`${apiUrl}/posts`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch posts (HTTP ${response.status})`);
  }

  const body = (await response.json()) as { posts: Post[] };
  return body.posts;
}
