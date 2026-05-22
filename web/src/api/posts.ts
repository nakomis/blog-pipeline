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
}

/**
 * Fetches every post from the dashboard API.
 *
 * @param accessToken Cognito access token — sent as a bearer token; the API's
 *                    JWT authorizer rejects the request without it.
 */
export async function fetchPosts(accessToken: string): Promise<Post[]> {
  const { apiUrl } = getConfig();

  const response = await fetch(`${apiUrl}/posts`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch posts (HTTP ${response.status})`);
  }

  const body = (await response.json()) as { posts: Post[] };
  return body.posts;
}
