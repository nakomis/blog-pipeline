import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { LINKS } from '../../lib/config';
import { draftExists, getDraft, putReviews } from '../review/drafts';
import { requireEnv } from '../review/runtime';
import { undecidedCount } from './apply';
import type { Suggestions, SuggestionsSummary } from './schema';

/**
 * Persistence for suggestions (PIPE-38): the full object in S3 beside
 * `reviews.json`, a small summary on the post row.
 */

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export function suggestionsKey(slug: string, iteration: number): string {
  return `${slug}/iteration-${iteration}/suggestions.json`;
}

export async function getSuggestions(
  slug: string,
  iteration: number,
): Promise<Suggestions | null> {
  const key = suggestionsKey(slug, iteration);
  if (!(await draftExists(key))) {
    return null;
  }
  return JSON.parse(await getDraft(key)) as Suggestions;
}

export async function putSuggestions(suggestions: Suggestions): Promise<void> {
  await putReviews(suggestionsKey(suggestions.slug, suggestions.iteration), suggestions);
}

export function summaryOf(s: Suggestions): SuggestionsSummary {
  return {
    iteration: s.iteration,
    status: s.status,
    ...(s.skippedReason ? { skippedReason: s.skippedReason } : {}),
    links: s.links.length,
    repos: s.repos.length,
    undecided: undecidedCount(s),
    generatedAt: s.generatedAt,
  };
}

export async function putSummary(slug: string, summary: SuggestionsSummary): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: requireEnv('POSTS_TABLE_NAME'),
      Key: { slug },
      UpdateExpression: 'SET suggestionsSummary = :s',
      ExpressionAttributeValues: { ':s': summary },
    }),
  );
}

/** The summary on the post row, which points at the iteration holding the file. */
export async function getSummary(slug: string): Promise<SuggestionsSummary | undefined> {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: requireEnv('POSTS_TABLE_NAME'), Key: { slug } }),
  );
  return Item?.suggestionsSummary as SuggestionsSummary | undefined;
}

/**
 * The suggestions currently attached to a post: the file at the iteration the
 * row's summary names (a bag edit adds later iterations but does not move it).
 *
 * If the summary records that the step did not succeed for that iteration but
 * left no file (the Lambda crashed or timed out, so the state machine wrote the
 * marker), a placeholder is returned so the bag says the step failed instead of
 * showing nothing or an earlier iteration's suggestions.
 */
export async function getCurrentSuggestions(
  slug: string,
  summary: SuggestionsSummary | undefined,
): Promise<Suggestions | null> {
  if (!summary || !Number.isInteger(summary.iteration)) {
    return null;
  }
  const stored = await getSuggestions(slug, summary.iteration);
  if (stored) {
    return stored;
  }
  if (summary.status === 'ok') {
    return null;
  }
  return {
    version: 1,
    slug,
    iteration: summary.iteration,
    generatedAt: summary.generatedAt,
    status: summary.status,
    ...(summary.skippedReason ? { skippedReason: summary.skippedReason } : {}),
    models: { chat: LINKS.model, embed: LINKS.embedModel },
    links: [],
    repos: [],
    dropped: [],
  };
}
