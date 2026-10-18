import { generateObject } from 'ai';
import { LINKS, githubOwners } from '../../lib/config';
import { getDraft } from '../review/drafts';
import { suggestModel } from '../review/providers';
import { mergeDecisions } from './apply';
import { embedTexts, IndexIncompatibleError, loadIndex } from './embeddings';
import type { IndexRecord } from './embeddings';
import { extractRepoUrls, listPublicRepos, mentionsRepo } from './github';
import {
  parseFrontmatterFacts,
  splitFrontmatter,
  windowsOf,
  wordCount,
} from './markdown';
import { SUGGEST_SYSTEM_PROMPT, buildSuggestPrompt } from './prompt';
import { chooseCandidates, eligibleRecords, retrievalDefaults, scorePosts } from './retrieve';
import { Picks } from './schema';
import type { Candidate, RepoInfo, Suggestions, SuggestionsSummary } from './schema';
import {
  getSummary,
  getSuggestions,
  putSuggestions,
  putSummary,
  summaryOf,
} from './store';
import { normalisePicks, validateLinks, validateRepos } from './validate';

/**
 * The `SuggestLinks` step (PIPE-38).
 *
 * Runs once the review loop has passed, before the post is staged. It reads
 * the final draft, finds earlier posts it may genuinely refer to (embedding
 * retrieval over the blog's index), lets Haiku choose from closed lists, and
 * validates every choice in code. The result is stored for the bag; nothing is
 * applied to the post here.
 *
 * It is best-effort by design: whatever goes wrong, `run` returns normally with
 * a recorded reason, so the post is always staged.
 */

export interface SuggestLinksInput {
  slug: string;
  /** The iteration that passed the gate — the one staged and reviewed. */
  iteration: number;
  draftKey: string;
}

export interface Deps {
  getDraft(key: string): Promise<string>;
  loadIndex(): Promise<IndexRecord[] | null>;
  embedTexts(texts: string[]): Promise<Float32Array[]>;
  listRepos(): Promise<RepoInfo[]>;
  pick(system: string, prompt: string): Promise<Picks>;
  getPrevious(slug: string): Promise<Suggestions | null>;
  put(suggestions: Suggestions): Promise<void>;
  putSummary(slug: string, summary: SuggestionsSummary): Promise<void>;
  now(): Date;
}

export function defaultDeps(): Deps {
  return {
    getDraft,
    loadIndex,
    embedTexts,
    listRepos: () =>
      listPublicRepos(githubOwners(), { excludeForks: LINKS.excludeForks }),
    async pick(system, prompt) {
      const { object } = await generateObject({
        model: await suggestModel(),
        schema: Picks,
        system,
        prompt,
      });
      return object;
    },
    async getPrevious(slug) {
      const summary = await getSummary(slug);
      return summary ? getSuggestions(slug, summary.iteration) : null;
    },
    put: putSuggestions,
    putSummary,
    now: () => new Date(),
  };
}

export interface GenerateOptions {
  /** Override the similarity floor (calibration only). */
  floor?: number;
  /** Receives every eligible post's score before candidates are chosen. */
  onScored?: (scored: Candidate[]) => void;
}

function blank(
  input: Pick<SuggestLinksInput, 'slug' | 'iteration'>,
  now: Date,
  status: Suggestions['status'],
  skippedReason?: string,
): Suggestions {
  return {
    version: 1,
    slug: input.slug,
    iteration: input.iteration,
    generatedAt: now.toISOString(),
    status,
    ...(skippedReason ? { skippedReason } : {}),
    models: { chat: LINKS.model, embed: LINKS.embedModel },
    links: [],
    repos: [],
    dropped: [],
  };
}

/**
 * Produce suggestions for a draft. Throws on infrastructure failure; `run`
 * turns that into a recorded `error`. Does not write anything itself.
 */
export async function generateSuggestions(
  input: SuggestLinksInput & { markdown: string },
  deps: Deps,
  options: GenerateOptions = {},
): Promise<Suggestions> {
  const now = deps.now();
  const { frontmatter, body } = splitFrontmatter(input.markdown);
  const facts = parseFrontmatterFacts(frontmatter);
  const ownDate = facts.date ?? facts.publishDate ?? now.toISOString().slice(0, 10);

  const index = await deps.loadIndex();
  if (!index) {
    return blank(input, now, 'skipped', 'no-embeddings-index');
  }

  // ── Candidate posts ───────────────────────────────────────────────────────
  const retrieval = { ...retrievalDefaults(), ...(options.floor !== undefined ? { floor: options.floor } : {}) };
  const windows = windowsOf(body, LINKS.retrieval.windowChars, LINKS.retrieval.maxWindows);
  let chosen: ReturnType<typeof chooseCandidates> = { mode: 'none', candidates: [] };
  if (windows.length > 0 && eligibleRecords(index, input.slug, ownDate).length > 0) {
    const vectors = await deps.embedTexts(windows);
    const scored = scorePosts(windows, vectors, index, {
      ownSlug: input.slug,
      ownDate,
      floor: retrieval.floor,
      evidencePerPost: retrieval.evidencePerPost,
    });
    options.onScored?.(scored);
    chosen = chooseCandidates(scored, retrieval);
  }

  // ── Repositories: only public repos the post actually names ───────────────
  const dropped: Suggestions['dropped'] = [];
  let repoList: RepoInfo[] = [];
  try {
    repoList = await deps.listRepos();
  } catch (err) {
    dropped.push({
      kind: 'repo',
      value: '*',
      reason: `repository list unavailable: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  const existing = new Set(facts.repoFullNames);
  const named = repoList.filter(
    (r) => mentionsRepo(body, r) && !existing.has(r.fullName.toLowerCase()),
  );

  const result = blank(input, now, 'ok');
  result.dropped.push(...dropped);

  if (chosen.candidates.length === 0 && named.length === 0) {
    result.skippedReason = 'no-candidates';
    return result;
  }

  // ── One Haiku call, then code decides what survives ───────────────────────
  const maxLinks = Math.min(
    LINKS.maxLinks,
    Math.max(1, Math.floor(wordCount(body) / LINKS.wordsPerLink)),
  );
  const answer = await deps.pick(
    SUGGEST_SYSTEM_PROMPT,
    buildSuggestPrompt({
      body,
      mode: chosen.mode,
      candidates: chosen.candidates,
      repos: named,
      maxLinks,
      maxRepos: LINKS.maxRepos,
    }),
  );
  // Limits are enforced here, by trimming, so an over-long answer loses only its
  // excess instead of failing validation and discarding everything.
  const { picks, dropped: trimmed } = normalisePicks(answer, {
    maxLinks,
    maxRepos: LINKS.maxRepos,
  });
  result.dropped.push(...trimmed);

  const links = validateLinks({
    picks: picks.links,
    body,
    candidates: chosen.candidates,
    maxLinks,
  });
  const repos = validateRepos({
    picks: picks.repos,
    body,
    repos: repoList,
    existingFullNames: facts.repoFullNames,
    urlsInPost: extractRepoUrls(body, githubOwners()),
    excludeForks: LINKS.excludeForks,
    maxRepos: LINKS.maxRepos,
  });

  result.links = links.accepted;
  result.repos = repos.accepted;
  result.dropped.push(...links.dropped, ...repos.dropped);
  return result;
}

export interface SuggestLinksOutput {
  slug: string;
  suggestions: SuggestionsSummary;
}

/** The step proper: generate, carry earlier decisions over, persist. Never throws. */
export async function run(
  event: SuggestLinksInput,
  deps: Deps,
): Promise<SuggestLinksOutput> {
  let suggestions: Suggestions;
  try {
    const markdown = await deps.getDraft(event.draftKey);
    suggestions = await generateSuggestions({ ...event, markdown }, deps);
    suggestions = mergeDecisions(await deps.getPrevious(event.slug).catch(() => null), suggestions);
  } catch (err) {
    const reason =
      err instanceof IndexIncompatibleError
        ? 'index-incompatible'
        : `error: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`suggest-links failed for '${event.slug}'`, err);
    suggestions = blank(
      event,
      deps.now(),
      err instanceof IndexIncompatibleError ? 'skipped' : 'error',
      reason.slice(0, 500),
    );
  }

  const summary = summaryOf(suggestions);
  try {
    await deps.put(suggestions);
    await deps.putSummary(event.slug, summary);
  } catch (err) {
    // Even a failure to record the outcome must not stop the post being staged.
    console.error(`suggest-links could not record its result for '${event.slug}'`, err);
  }
  return { slug: event.slug, suggestions: summary };
}

export async function handler(event: SuggestLinksInput): Promise<SuggestLinksOutput> {
  return run(event, defaultDeps());
}
