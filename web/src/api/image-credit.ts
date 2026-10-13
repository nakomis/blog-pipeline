import { getConfig } from '../config/config';

/**
 * The latest fal.ai credit snapshot (PIPE-34), recorded by the image-submit
 * Lambda's pre-flight check and served by `GET /image-credit`.
 */
export interface ImageCredit {
  /** True when the remaining credit is below the warning threshold. */
  low: boolean;
  /** Remaining credit in USD — live from fal, or the monthly-budget estimate. */
  remainingUsd?: number;
  thresholdUsd?: number;
  /** `fal` for the live balance, `budget` for the estimate. */
  source?: 'fal' | 'budget';
  /** ISO 8601 timestamp of the check. */
  checkedAt?: string;
}

/**
 * Fetches the fal credit snapshot.
 *
 * @param idToken Cognito ID token — sent as a bearer token, as for `/posts`.
 */
export async function fetchImageCredit(idToken: string): Promise<ImageCredit> {
  const { apiUrl } = getConfig();

  const response = await fetch(`${apiUrl}/image-credit`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch image credit (HTTP ${response.status})`);
  }

  return (await response.json()) as ImageCredit;
}
