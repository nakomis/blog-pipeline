import {
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
}

export interface ApplyResult {
  markdown: string;
  applied: string[];
  skipped: { id: string; reason: string }[];
}

export function applyLinkSuggestions(markdown: string, links: LinkToApply[]): ApplyResult {
  const { head, body } = splitFrontmatter(markdown);
  const protectedAt = protectedRanges(body);
  const skipped: ApplyResult['skipped'] = [];
  const planned: { id: string; start: number; end: number; replacement: string }[] = [];

  for (const link of links) {
    const found = occurrences(body, link.anchorText);
    if (body.includes(`[${link.anchorText}](${link.targetUrl})`)) {
      skipped.push({ id: link.id, reason: 'already linked' });
    } else if (found.length !== 1) {
      skipped.push({
        id: link.id,
        reason:
          found.length === 0
            ? 'the anchor text is no longer in the post'
            : 'the anchor text now appears more than once',
      });
    } else if (overlapsRange(protectedAt, found[0], found[0] + link.anchorText.length)) {
      skipped.push({ id: link.id, reason: 'the anchor text is now inside a heading, code, link or shortcode' });
    } else if (body.includes(link.targetUrl)) {
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
  return { markdown: head + out, applied: kept.map((k) => k.id), skipped };
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
  return {
    ...next,
    links: next.links.map((l) => ({ ...l, decision: decided.get(l.id) ?? l.decision })),
    repos: next.repos.map((r) => ({ ...r, decision: decided.get(r.id) ?? r.decision })),
  };
}

/** Count of suggestions still awaiting a decision. */
export function undecidedCount(s: Pick<Suggestions, 'links' | 'repos'>): number {
  return [...s.links, ...s.repos].filter((x) => x.decision === 'pending').length;
}
