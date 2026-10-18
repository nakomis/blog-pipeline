import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { draftKey, getDraft } from '../review/drafts';
import { requireEnv } from '../review/runtime';
import { asinOf, isValidTrackingId, validateAffiliateUrl } from '../suggest/affiliate';
import type { AffiliateMention, Suggestions, SuggestionsSummary } from '../suggest/schema';
import {
  getCurrentSuggestions,
  putSuggestions,
  putSummary,
  summaryOf,
} from '../suggest/store';
import { readFrontmatter } from './frontmatter';
import { corsHeaders, jsonResponse } from './http';

/**
 * The affiliate step's write action (PIPE-41).
 *
 * `POST /posts/{slug}/affiliates` records what the author did with each product
 * mention: paste a SiteStripe link, skip, or undo. Pasted links are checked by
 * `validateAffiliateUrl` and stored exactly as pasted; nothing is rewritten and
 * the post is not touched (links are written into the draft at approval, by
 * `applyAcceptedSuggestions`).
 */

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface PostRow {
  status?: string;
  suggestionsSummary?: SuggestionsSummary;
}

type Action =
  | { action: 'link'; url: string }
  | { action: 'skip' }
  | { action: 'reset' };

interface Body {
  decisions?: Record<string, Action>;
  skipRemaining?: boolean;
  trackingId?: string | null;
}

export interface MentionResult {
  ok: boolean;
  error?: string;
  warnings?: string[];
}

/**
 * The `amazon_tracking_id` in the author's frontmatter (iteration 1), if any.
 * Never throws: an unreadable draft just means "none known".
 */
export async function frontmatterTrackingId(slug: string): Promise<string | undefined> {
  try {
    const { fields } = readFrontmatter(await getDraft(draftKey(slug, 1)));
    const value = fields?.amazon_tracking_id;
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  } catch (err) {
    console.error(`Could not read the frontmatter of '${slug}'`, err);
    return undefined;
  }
}

function parseBody(raw: string | null): Body | string {
  let body: unknown;
  try {
    body = JSON.parse(raw ?? '{}');
  } catch {
    return 'Malformed JSON body';
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return 'The body must be an object';
  }
  const b = body as Record<string, unknown>;
  if (b.decisions !== undefined) {
    if (typeof b.decisions !== 'object' || b.decisions === null || Array.isArray(b.decisions)) {
      return 'decisions must map mention ids to actions';
    }
    for (const value of Object.values(b.decisions as Record<string, unknown>)) {
      const a = value as { action?: unknown; url?: unknown } | null;
      const ok =
        a !== null &&
        typeof a === 'object' &&
        (a.action === 'skip' ||
          a.action === 'reset' ||
          (a.action === 'link' && typeof a.url === 'string'));
      if (!ok) {
        return "each decision must be { action: 'link', url }, { action: 'skip' } or { action: 'reset' }";
      }
    }
  }
  if (b.trackingId !== undefined && b.trackingId !== null && typeof b.trackingId !== 'string') {
    return 'trackingId must be a string or null';
  }
  if (b.decisions === undefined && b.skipRemaining !== true && b.trackingId === undefined) {
    return 'Nothing to do: send decisions, skipRemaining or trackingId';
  }
  return b as Body;
}

function withoutLink(m: AffiliateMention): AffiliateMention {
  const { url: _url, warnings: _warnings, ...rest } = m;
  return rest;
}

export async function postAffiliates(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const cors = corsHeaders(event);
  const slug = event.pathParameters?.slug;
  if (!slug) {
    return jsonResponse(400, { message: 'Missing slug' }, cors);
  }
  const body = parseBody(event.body);
  if (typeof body === 'string') {
    return jsonResponse(400, { message: body }, cors);
  }

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
      { message: `Cannot change affiliate links on a post in status '${post.status}'` },
      cors,
    );
  }
  const current = await getCurrentSuggestions(slug, post.suggestionsSummary);
  if (!current || current.affiliatesStatus !== 'ok') {
    return jsonResponse(404, { message: `No affiliate mentions for '${slug}'` }, cors);
  }

  const known = new Set((current.affiliates ?? []).map((a) => a.id));
  const unknown = Object.keys(body.decisions ?? {}).filter((id) => !known.has(id));
  if (unknown.length > 0) {
    return jsonResponse(400, { message: 'Unknown mention ids', unknown }, cors);
  }

  // ── Tracking id: the source file's wins; otherwise the one typed here ─────
  const sourceId = await frontmatterTrackingId(slug);
  let typedId = current.trackingId;
  let trackingResult: { ok: boolean; error?: string } | undefined;
  if (body.trackingId !== undefined) {
    if (body.trackingId === null || body.trackingId.trim() === '') {
      typedId = undefined;
      trackingResult = { ok: true };
    } else if (!isValidTrackingId(body.trackingId.trim())) {
      trackingResult = {
        ok: false,
        error: 'A per-post tracking id looks like nakomis-bconn66-21 (not the bare store id nakomis-21).',
      };
    } else if (sourceId && sourceId !== body.trackingId.trim()) {
      trackingResult = {
        ok: false,
        error: `The source file already has ${sourceId}; edit it there if it is wrong.`,
      };
    } else {
      typedId = sourceId ? undefined : body.trackingId.trim();
      trackingResult = { ok: true };
    }
  }
  const effective = sourceId ?? typedId;

  // ── Decisions ──────────────────────────────────────────────────────────────
  let mentions = [...(current.affiliates ?? [])];
  const results: Record<string, MentionResult> = {};
  // Only mentions earlier in the post count: the first one is the one linked.
  const asinsBefore = (id: string): string[] =>
    mentions
      .slice(0, mentions.findIndex((m) => m.id === id))
      .filter((m) => m.decision === 'linked' && m.url)
      .map((m) => asinOf(new URL(m.url as string).pathname))
      .filter((a): a is string => Boolean(a));

  for (const [id, action] of Object.entries(body.decisions ?? {})) {
    const at = mentions.findIndex((m) => m.id === id);
    if (action.action === 'link') {
      const checked = validateAffiliateUrl(action.url, {
        effectiveTrackingId: effective,
        otherAsins: asinsBefore(id),
      });
      if (!checked.ok) {
        results[id] = { ok: false, error: checked.error };
        continue;
      }
      mentions[at] = { ...withoutLink(mentions[at]), decision: 'linked', url: checked.url, warnings: checked.warnings };
      results[id] = { ok: true, warnings: checked.warnings };
    } else {
      mentions[at] = {
        ...withoutLink(mentions[at]),
        decision: action.action === 'skip' ? 'skipped' : 'pending',
      };
      results[id] = { ok: true, warnings: [] };
    }
  }
  if (body.skipRemaining === true) {
    mentions = mentions.map((m) => (m.decision === 'pending' ? { ...m, decision: 'skipped' as const } : m));
  }

  // The tracking id may have changed, so refresh the warnings on stored links.
  mentions = mentions.map((m) => {
    if (m.decision !== 'linked' || !m.url) {
      return m;
    }
    const again = validateAffiliateUrl(m.url, {
      effectiveTrackingId: effective,
      otherAsins: asinsBefore(m.id),
    });
    return again.ok ? { ...m, warnings: again.warnings } : m;
  });
  for (const m of mentions) {
    if (results[m.id]?.ok && m.decision === 'linked') {
      results[m.id].warnings = m.warnings ?? [];
    }
  }

  const { trackingId: _previous, ...rest } = current;
  const updated: Suggestions = { ...rest, affiliates: mentions, ...(typedId ? { trackingId: typedId } : {}) };
  await putSuggestions(updated);
  await putSummary(slug, summaryOf(updated));
  return jsonResponse(
    200,
    {
      suggestions: updated,
      results,
      ...(trackingResult ? { trackingId: trackingResult } : {}),
    },
    cors,
  );
}
