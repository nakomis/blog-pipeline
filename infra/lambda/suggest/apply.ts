import {
  crossesWordBoundary,
  linksTo,
  occurrences,
  overlapsRange,
  protectedRanges,
  splitFrontmatter,
} from './markdown';
import type { Decision, Suggestions } from './schema';

/**
 * Applying accepted link suggestions to Markdown at approval (PIPE-38).
 * Pure. Every link is re-validated against the text as it is now, because a
 * bag edit may have moved things since the suggestion was generated; a link
 * that no longer fits is skipped, never forced.
 */

export interface LinkToApply {
  id: string;
  anchorText: string;
  targetUrl: string;
  /**
   * For anchors that may occur more than once (affiliate mentions, PIPE-41):
   * the text just around the anchor. The target is `before + anchor + after`,
   * which must occur exactly once.
   */
  locator?: { before: string; after: string };
}

export interface ApplyResult {
  markdown: string;
  applied: string[];
  /**
   * Ids whose `[anchor](url)` was already in the text (a retried approval). They
   * are also in `skipped`, but they count as applied: the link is there.
   */
  alreadyLinked: string[];
  skipped: { id: string; reason: string }[];
}

export function applyLinkSuggestions(markdown: string, links: LinkToApply[]): ApplyResult {
  const { head, body } = splitFrontmatter(markdown);
  const protectedAt = protectedRanges(body);
  const skipped: ApplyResult['skipped'] = [];
  const alreadyLinked: string[] = [];
  const planned: { id: string; start: number; end: number; replacement: string }[] = [];

  for (const link of links) {
    let found = occurrences(body, link.anchorText);
    let locatorFailed = false;
    if (link.locator) {
      const { before, after } = link.locator;
      const context = occurrences(body, before + link.anchorText + after);
      found = context.length === 1 ? [context[0] + before.length] : [];
      locatorFailed = context.length !== 1;
    }
    if (body.includes(`[${link.anchorText}](${link.targetUrl})`)) {
      skipped.push({ id: link.id, reason: 'already linked' });
      alreadyLinked.push(link.id);
    } else if (locatorFailed) {
      skipped.push({ id: link.id, reason: 'the text around the anchor has changed' });
    } else if (found.length !== 1) {
      skipped.push({
        id: link.id,
        reason:
          found.length === 0
            ? 'the anchor text is no longer in the post'
            : 'the anchor text now appears more than once',
      });
    } else if (crossesWordBoundary(body, found[0], found[0] + link.anchorText.length)) {
      skipped.push({ id: link.id, reason: 'the anchor text now starts or ends in the middle of a word' });
    } else if (overlapsRange(protectedAt, found[0], found[0] + link.anchorText.length)) {
      skipped.push({ id: link.id, reason: 'the anchor text is now inside a heading, code, link or shortcode' });
    } else if (linksTo(body, link.targetUrl)) {
      skipped.push({ id: link.id, reason: 'the post already links to that target' });
    } else {
      const start = found[0];
      planned.push({
        id: link.id,
        start,
        end: start + link.anchorText.length,
        replacement: `[${link.anchorText}](${link.targetUrl})`,
      });
    }
  }

  // Drop overlaps and duplicate targets, then replace right to left so earlier
  // offsets stay valid.
  planned.sort((a, b) => a.start - b.start);
  const kept: typeof planned = [];
  const urls = new Set<string>();
  for (const item of planned) {
    const url = item.replacement.slice(item.replacement.lastIndexOf('](') + 2, -1);
    const last = kept[kept.length - 1];
    if (last && item.start < last.end) {
      skipped.push({ id: item.id, reason: 'overlaps another accepted link' });
    } else if (urls.has(url)) {
      skipped.push({ id: item.id, reason: 'another accepted link already points at that target' });
    } else {
      urls.add(url);
      kept.push(item);
    }
  }

  let out = body;
  for (const item of [...kept].reverse()) {
    out = out.slice(0, item.start) + item.replacement + out.slice(item.end);
  }
  return { markdown: head + out, applied: kept.map((k) => k.id), alreadyLinked, skipped };
}

/** Carry decisions over from a previous file for suggestions with the same id. */
export function mergeDecisions(
  previous: Suggestions | null,
  next: Suggestions,
): Suggestions {
  if (!previous) {
    return next;
  }
  const decided = new Map<string, Decision>();
  for (const s of [...previous.links, ...previous.repos]) {
    if (s.decision !== 'pending') {
      decided.set(s.id, s.decision);
    }
  }
  const earlier = new Map((previous.affiliates ?? []).map((a) => [a.id, a]));
  return {
    ...next,
    links: next.links.map((l) => ({ ...l, decision: decided.get(l.id) ?? l.decision })),
    repos: next.repos.map((r) => ({ ...r, decision: decided.get(r.id) ?? r.decision })),
    ...(next.affiliates
      ? {
          affiliates: next.affiliates.map((a) => {
            const was = earlier.get(a.id);
            return was && was.decision !== 'pending'
              ? {
                  ...a,
                  decision: was.decision,
                  ...(was.url ? { url: was.url } : {}),
                  ...(was.warnings ? { warnings: was.warnings } : {}),
                }
              : a;
          }),
        }
      : {}),
    ...(previous.trackingId && !next.trackingId ? { trackingId: previous.trackingId } : {}),
  };
}

/** Product mentions still awaiting a decision (PIPE-41). */
export function undecidedAffiliates(s: Pick<Suggestions, 'affiliates'>): number {
  return (s.affiliates ?? []).filter((a) => a.decision === 'pending').length;
}

/** Count of suggestions still awaiting a decision. */
export function undecidedCount(s: Pick<Suggestions, 'links' | 'repos'>): number {
  return [...s.links, ...s.repos].filter((x) => x.decision === 'pending').length;
}
