import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { draftKey, getDraftWithEtag, putDraftIfMatch } from '../review/drafts';
import { requireEnv } from '../review/runtime';
import { applyLinkSuggestions } from '../suggest/apply';
import type { Decision, Suggestions, SuggestionsSummary } from '../suggest/schema';
import {
  getCurrentSuggestions,
  putSuggestions,
  putSummary,
  summaryOf,
} from '../suggest/store';
import { corsHeaders, jsonResponse } from './http';

/**
 * The bag's suggestion actions (PIPE-38).
 *
 * - `POST /posts/{slug}/suggestions` records Martin's accept / reject choices.
 *   It only changes `decision` values in `suggestions.json`; the post is not
 *   touched.
 * - `applyAcceptedSuggestions` is called by the approve action
 *   (`post-actions.ts`) and is the only place accepted links are written into
 *   the Markdown. Accepted repos are returned for the posts row, because the
 *   promotion script keeps the author's frontmatter and needs them handed over.
 */

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const DECISIONS: readonly Decision[] = ['pending', 'accepted', 'rejected'];

interface PostRow {
  status?: string;
  latestIteration?: number;
  reviewIteration?: number;
  suggestionsSummary?: SuggestionsSummary;
}

export async function postSuggestions(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const cors = corsHeaders(event);
  const slug = event.pathParameters?.slug;
  if (!slug) {
    return jsonResponse(400, { message: 'Missing slug' }, cors);
  }

  let decisions: unknown;
  try {
    decisions = (JSON.parse(event.body ?? '{}') as { decisions?: unknown }).decisions;
  } catch {
    return jsonResponse(400, { message: 'Malformed JSON body' }, cors);
  }
  if (
    typeof decisions !== 'object' ||
    decisions === null ||
    Array.isArray(decisions) ||
    Object.values(decisions).some((d) => !DECISIONS.includes(d as Decision))
  ) {
    return jsonResponse(
      400,
      { message: "decisions must map suggestion ids to 'accepted', 'rejected' or 'pending'" },
      cors,
    );
  }
  const wanted = decisions as Record<string, Decision>;

  const { Item } = await docClient.send(
    new GetCommand({ TableName: requireEnv('POSTS_TABLE_NAME'), Key: { slug } }),
  );
  const post = Item as PostRow | undefined;
  if (!post) {
    return jsonResponse(404, { message: `No post '${slug}'` }, cors);
  }
  if (post.status !== 'staged') {
    return jsonResponse(
      409,
      { message: `Cannot change suggestions on a post in status '${post.status}'` },
      cors,
    );
  }

  const suggestions = await getCurrentSuggestions(slug, post.suggestionsSummary);
  if (!suggestions) {
    return jsonResponse(404, { message: `No suggestions for '${slug}'` }, cors);
  }

  const known = new Set([...suggestions.links, ...suggestions.repos].map((s) => s.id));
  const unknown = Object.keys(wanted).filter((id) => !known.has(id));
  if (unknown.length > 0) {
    return jsonResponse(400, { message: 'Unknown suggestion ids', unknown }, cors);
  }

  const updated: Suggestions = {
    ...suggestions,
    links: suggestions.links.map((l) => ({ ...l, decision: wanted[l.id] ?? l.decision })),
    repos: suggestions.repos.map((r) => ({ ...r, decision: wanted[r.id] ?? r.decision })),
  };
  await putSuggestions(updated);
  await putSummary(slug, summaryOf(updated));
  return jsonResponse(200, { suggestions: updated }, cors);
}

export interface AppliedSuggestions {
  /** Accepted repos, as frontmatter `repos:` entries, for the posts row. */
  approvedRepos: { name: string; url: string }[];
  applied: { links: number; repos: number };
  skipped: { id: string; reason: string }[];
}

/**
 * At approval: write the accepted links into the final draft (in place, so the
 * draft the promotion step reads has them) and return the accepted repos.
 * Pending and rejected suggestions are never applied. Returns null when the
 * post has no usable suggestions.
 *
 * The draft is written with an S3 `If-Match` so a late image rewrite cannot be
 * overwritten; on a conflict it re-reads and retries once, then gives up with
 * an error, leaving the post un-approved so the click can simply be repeated.
 */
export async function applyAcceptedSuggestions(
  slug: string,
  post: PostRow,
): Promise<AppliedSuggestions | null> {
  const suggestions = await getCurrentSuggestions(slug, post.suggestionsSummary);
  if (!suggestions || suggestions.status !== 'ok') {
    return null;
  }

  const links = suggestions.links.filter((l) => l.decision === 'accepted');
  const repos = suggestions.repos.filter((r) => r.decision === 'accepted');
  const skipped: AppliedSuggestions['skipped'] = [];
  let appliedLinks = 0;

  if (links.length > 0) {
    const iteration = Math.max(
      1,
      Number(post.latestIteration) || 1,
      Number(post.reviewIteration) || 1,
    );
    const key = draftKey(slug, iteration);
    for (let attempt = 1; ; attempt += 1) {
      const { body, etag } = await getDraftWithEtag(key);
      const result = applyLinkSuggestions(
        body,
        links.map((l) => ({ id: l.id, anchorText: l.anchorText, targetUrl: l.targetUrl })),
      );
      const written =
        result.markdown === body || (await putDraftIfMatch(key, result.markdown, etag));
      if (written) {
        appliedLinks = result.applied.length;
        skipped.push(...result.skipped);
        break;
      }
      if (attempt >= 2) {
        throw new Error('The draft changed during approval; please try again');
      }
    }
  }

  return {
    approvedRepos: repos.map((r) => ({ name: r.name, url: r.url })),
    applied: { links: appliedLinks, repos: repos.length },
    skipped,
  };
}
