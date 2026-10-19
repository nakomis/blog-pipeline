import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { draftKey, getDraftWithEtag, putDraftIfMatch } from '../review/drafts';
import { requireEnv } from '../review/runtime';
import { validateAffiliateUrl } from '../suggest/affiliate';
import { applyLinkSuggestions } from '../suggest/apply';
import type { LinkToApply } from '../suggest/apply';
import type { Decision, Suggestions, SuggestionsSummary } from '../suggest/schema';
import {
  getCurrentSuggestions,
  putSuggestions,
  putSummary,
  summaryOf,
} from '../suggest/store';
import { frontmatterTrackingId } from './affiliates';
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
  applied: { links: number; repos: number; affiliates?: number };
  skipped: { id: string; reason: string }[];
  /** Affiliate links actually written into the draft, for the promotion check (PIPE-41). */
  approvedAffiliateUrls?: string[];
  /** A per-post tracking id typed in the bag, for a source file that has none (PIPE-41). */
  approvedTrackingId?: string;
  /** Things to tell the author after approval; never a reason to refuse it. */
  warnings?: string[];
}

/**
 * At approval: write the accepted links, and the affiliate links pasted in the
 * bag, into the final draft (in place, so the draft the promotion step reads
 * has them) and return the accepted repos. Pending, rejected and skipped items
 * are never applied. Returns null when the post has no usable suggestions.
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
  if (!suggestions) {
    return null;
  }
  const linksOk = suggestions.status === 'ok';
  const affiliatesOk = suggestions.affiliatesStatus === 'ok';
  if (!linksOk && !affiliatesOk) {
    return null;
  }

  const links = linksOk ? suggestions.links.filter((l) => l.decision === 'accepted') : [];
  const repos = linksOk ? suggestions.repos.filter((r) => r.decision === 'accepted') : [];
  const mentions = affiliatesOk ? (suggestions.affiliates ?? []) : [];
  const skipped: AppliedSuggestions['skipped'] = [];
  const warnings: string[] = [];

  // Affiliate links: re-checked now, because nothing pasted earlier is trusted
  // blindly. The source file's tracking id (if any) wins over a typed one.
  const sourceTrackingId = mentions.length > 0 ? await frontmatterTrackingId(slug) : undefined;
  const effectiveTrackingId = sourceTrackingId ?? suggestions.trackingId;
  const toApply: LinkToApply[] = links.map((l) => ({
    id: l.id,
    anchorText: l.anchorText,
    targetUrl: l.targetUrl,
  }));
  const affiliateIds = new Set<string>();
  const affiliateUrls = new Map<string, string>();
  // The same product pasted for two mentions is linked once: the first in
  // document order (the list is in that order), as the pasted-link warning says.
  const seenAsins = new Set<string>();
  for (const m of mentions.filter((a) => a.decision === 'linked' && a.url)) {
    const checked = validateAffiliateUrl(m.url as string, { effectiveTrackingId, otherAsins: [] });
    if (!checked.ok) {
      skipped.push({ id: m.id, reason: checked.error });
      continue;
    }
    if (checked.asin) {
      if (seenAsins.has(checked.asin)) {
        skipped.push({ id: m.id, reason: 'the same product is already linked by an earlier mention' });
        continue;
      }
      seenAsins.add(checked.asin);
    }
    affiliateIds.add(m.id);
    affiliateUrls.set(m.id, checked.url);
    toApply.push({
      id: m.id,
      anchorText: m.anchorText,
      targetUrl: checked.url,
      locator: { before: m.before, after: m.after },
    });
  }

  let appliedIds: string[] = [];
  if (toApply.length > 0) {
    const iteration = Math.max(
      1,
      Number(post.latestIteration) || 1,
      Number(post.reviewIteration) || 1,
    );
    const key = draftKey(slug, iteration);
    for (let attempt = 1; ; attempt += 1) {
      const { body, etag } = await getDraftWithEtag(key);
      const result = applyLinkSuggestions(body, toApply);
      const written =
        result.markdown === body || (await putDraftIfMatch(key, result.markdown, etag));
      if (written) {
        // A retried approval finds its links already written: they count as applied.
        appliedIds = [...result.applied, ...result.alreadyLinked];
        skipped.push(...result.skipped.filter((k) => !result.alreadyLinked.includes(k.id)));
        break;
      }
      if (attempt >= 2) {
        throw new Error('The draft changed during approval; please try again');
      }
    }
  }

  const appliedAffiliates = appliedIds.filter((id) => affiliateIds.has(id));
  const out: AppliedSuggestions = {
    approvedRepos: repos.map((r) => ({ name: r.name, url: r.url })),
    applied: {
      links: appliedIds.length - appliedAffiliates.length,
      repos: repos.length,
      ...(affiliatesOk ? { affiliates: appliedAffiliates.length } : {}),
    },
    skipped,
  };

  if (appliedAffiliates.length > 0) {
    out.approvedAffiliateUrls = appliedAffiliates.map((id) => affiliateUrls.get(id) as string);
    if (!sourceTrackingId && suggestions.trackingId) {
      out.approvedTrackingId = suggestions.trackingId;
    }
    if (!effectiveTrackingId) {
      warnings.push(
        'This post has no amazon_tracking_id, so its affiliate links will earn under nakomis-21 and cannot be attributed to the post. Create nakomis-bconn<N>-21 in Associates Central and add it to the source file.',
      );
    }
  }
  const undecided = mentions.filter((a) => a.decision === 'pending').length;
  if (undecided > 0) {
    warnings.push(
      `${undecided} product mention${undecided === 1 ? ' had' : 's had'} no affiliate link decision and ${undecided === 1 ? 'was' : 'were'} not linked.`,
    );
  }
  if (warnings.length > 0) {
    out.warnings = warnings;
  }
  return out;
}
