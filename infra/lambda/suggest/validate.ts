import { createHash } from 'crypto';
import {
  contextAround,
  occurrences,
  overlapsRange,
  paragraphIndex,
  protectedRanges,
} from './markdown';
import type {
  Candidate,
  DroppedSuggestion,
  LinkPick,
  LinkSuggestion,
  RepoInfo,
  RepoPick,
  RepoSuggestion,
} from './schema';
import { mentionsRepo } from './github';

/**
 * Code-side validation of everything Haiku chose (PIPE-38). All pure.
 * A pick that fails any rule is dropped with a reason; nothing the model says
 * is trusted, and no URL ever comes from it.
 */

function shortHash(...parts: string[]): string {
  return createHash('sha1').update(parts.join('\0')).digest('hex').slice(0, 12);
}

export function linkId(anchorText: string, targetSlug: string): string {
  return shortHash(anchorText, targetSlug);
}

export function repoId(fullName: string): string {
  return shortHash('repo', fullName.toLowerCase());
}

const ANCHOR_FORBIDDEN = /[[\]()`<>{}\n\r]/;
const WORD_CHAR = /[\p{L}\p{N}_]/u;

export interface LinkValidationInput {
  picks: LinkPick[];
  body: string;
  candidates: Candidate[];
  /** `max(1, floor(words / wordsPerLink))`. */
  maxLinks: number;
}

export interface LinkValidationResult {
  accepted: LinkSuggestion[];
  dropped: DroppedSuggestion[];
}

interface Located {
  pick: LinkPick;
  candidate: Candidate;
  anchor: string;
  start: number;
  end: number;
  paragraph: number;
}

export function validateLinks(input: LinkValidationInput): LinkValidationResult {
  const { picks, body, candidates, maxLinks } = input;
  const dropped: DroppedSuggestion[] = [];
  const drop = (pick: LinkPick, reason: string): void => {
    dropped.push({ kind: 'link', value: pick.anchor_text, reason });
  };
  const bySlug = new Map(candidates.map((c) => [c.slug, c]));
  const protectedAt = protectedRanges(body);
  const located: Located[] = [];

  for (const pick of picks) {
    if (!pick.same_subject) {
      drop(pick, 'the model was not sure the passage refers to the earlier post');
      continue;
    }
    const candidate = bySlug.get(pick.target_slug);
    if (!candidate) {
      drop(pick, `target '${pick.target_slug}' is not on the candidate list`);
      continue;
    }
    const anchor = pick.anchor_text.trim();
    const words = anchor.split(/\s+/).length;
    if (anchor.length < 2 || anchor.length > 80 || words > 6) {
      drop(pick, 'anchor must be 2 to 80 characters and at most 6 words');
      continue;
    }
    if (ANCHOR_FORBIDDEN.test(anchor)) {
      drop(pick, 'anchor contains brackets, backticks or line breaks');
      continue;
    }
    const found = occurrences(body, anchor);
    if (found.length !== 1) {
      drop(
        pick,
        found.length === 0
          ? 'anchor text does not appear in the post'
          : `anchor text appears ${found.length} times, not exactly once`,
      );
      continue;
    }
    const start = found[0];
    const end = start + anchor.length;
    const before = body[start - 1];
    const after = body[end];
    if (
      (WORD_CHAR.test(anchor[0]) && before !== undefined && WORD_CHAR.test(before)) ||
      (WORD_CHAR.test(anchor[anchor.length - 1]) && after !== undefined && WORD_CHAR.test(after))
    ) {
      drop(pick, 'anchor starts or ends in the middle of a word');
      continue;
    }
    if (overlapsRange(protectedAt, start, end)) {
      drop(pick, 'anchor sits inside a heading, code, link, image or shortcode');
      continue;
    }
    if (body.includes(candidate.url)) {
      drop(pick, 'the post already links to that target');
      continue;
    }
    located.push({
      pick,
      candidate,
      anchor,
      start,
      end,
      paragraph: paragraphIndex(body, start),
    });
  }

  // Document-order constraints.
  located.sort((a, b) => a.start - b.start);
  const accepted: LinkSuggestion[] = [];
  const usedTargets = new Set<string>();
  const usedParagraphs = new Set<number>();
  let lastEnd = -1;

  for (const item of located) {
    let reason: string | undefined;
    if (usedTargets.has(item.candidate.slug)) {
      reason = 'only one link per target post';
    } else if (item.start < lastEnd) {
      reason = 'overlaps another suggested anchor';
    } else if (usedParagraphs.has(item.paragraph)) {
      reason = 'only one new link per paragraph';
    } else if (accepted.length >= maxLinks) {
      reason = `link density cap reached (${maxLinks} for this length)`;
    }
    if (reason) {
      drop(item.pick, reason);
      continue;
    }
    usedTargets.add(item.candidate.slug);
    usedParagraphs.add(item.paragraph);
    lastEnd = item.end;
    accepted.push({
      id: linkId(item.anchor, item.candidate.slug),
      kind: 'link',
      anchorText: item.anchor,
      context: contextAround(body, item.start, item.end),
      targetSlug: item.candidate.slug,
      targetTitle: item.candidate.title,
      targetUrl: item.candidate.url,
      targetDate: item.candidate.date,
      occurrence: { paragraph: item.paragraph, offset: item.start },
      reason: item.pick.reason,
      decision: 'pending',
    });
  }
  return { accepted, dropped };
}

export interface RepoValidationInput {
  picks: RepoPick[];
  body: string;
  /** The closed list of public repositories fetched from GitHub in this run. */
  repos: RepoInfo[];
  /** `owner/name` (lower-case) of repos already in the frontmatter. */
  existingFullNames: string[];
  /** `owner/name` (lower-case) of repos whose GitHub URL appears in the post. */
  urlsInPost: string[];
  excludeForks: boolean;
  maxRepos: number;
}

export interface RepoValidationResult {
  accepted: RepoSuggestion[];
  dropped: DroppedSuggestion[];
}

function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function validateRepos(input: RepoValidationInput): RepoValidationResult {
  const { picks, body, repos, existingFullNames, urlsInPost, excludeForks, maxRepos } = input;
  const dropped: DroppedSuggestion[] = [];
  const accepted: RepoSuggestion[] = [];
  const byName = new Map(repos.map((r) => [r.fullName.toLowerCase(), r]));
  const existing = new Set(existingFullNames.map((n) => n.toLowerCase()));
  const seen = new Set<string>();
  const haystack = normalise(body);

  const eligible = (repo: RepoInfo): string | undefined => {
    if (repo.private !== false) {
      return 'repository is not public';
    }
    if (excludeForks && repo.fork) {
      return 'repository is a fork';
    }
    if (existing.has(repo.fullName.toLowerCase())) {
      return 'repository is already listed in the frontmatter';
    }
    if (seen.has(repo.fullName.toLowerCase())) {
      return 'repository already suggested';
    }
    return undefined;
  };

  for (const pick of picks) {
    const repo = byName.get(pick.full_name.toLowerCase());
    if (!repo) {
      dropped.push({ kind: 'repo', value: pick.full_name, reason: 'not on the list of public repositories' });
      continue;
    }
    const problem = eligible(repo);
    if (problem) {
      dropped.push({ kind: 'repo', value: pick.full_name, reason: problem });
      continue;
    }
    if (!mentionsRepo(body, repo)) {
      dropped.push({ kind: 'repo', value: pick.full_name, reason: 'the post never names the repository' });
      continue;
    }
    if (!haystack.includes(normalise(pick.evidence_quote))) {
      dropped.push({ kind: 'repo', value: pick.full_name, reason: 'evidence quote is not in the post' });
      continue;
    }
    seen.add(repo.fullName.toLowerCase());
    accepted.push({
      id: repoId(repo.fullName),
      kind: 'repo',
      fullName: repo.fullName,
      name: repo.name,
      url: repo.url,
      description: repo.description,
      evidence: pick.evidence_quote.trim(),
      reason: pick.reason,
      source: 'llm',
      decision: 'pending',
    });
  }

  // A GitHub URL in the post is itself the mention: add it without the model.
  for (const full of urlsInPost) {
    const repo = byName.get(full.toLowerCase());
    if (!repo || eligible(repo)) {
      continue;
    }
    seen.add(repo.fullName.toLowerCase());
    accepted.push({
      id: repoId(repo.fullName),
      kind: 'repo',
      fullName: repo.fullName,
      name: repo.name,
      url: repo.url,
      description: repo.description,
      evidence: repo.url,
      reason: 'The post links to this repository.',
      source: 'url-in-post',
      decision: 'pending',
    });
  }

  if (accepted.length > maxRepos) {
    for (const extra of accepted.splice(maxRepos)) {
      dropped.push({ kind: 'repo', value: extra.fullName, reason: `more than ${maxRepos} repositories` });
    }
  }
  return { accepted, dropped };
}
