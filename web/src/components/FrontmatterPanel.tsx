import { useEffect, useState } from 'react';
import {
  fetchRepoChecks,
  type FrontmatterInfo,
  type FrontmatterValue,
  type FrontmatterWarning,
  type RepoCheck,
  type RepoSuggestion,
  type SuggestionDecision,
} from '../api/post-detail';
import { RepoSuggestionRow } from './RepoSuggestionRow';

/**
 * The frontmatter panel in the bag (PIPE-37): every field of the author's
 * frontmatter, the API's warnings, and a live GitHub visibility check of the
 * `repos:` URLs. Collapsed by default, and opened automatically when there are
 * warnings. Warnings never block approval.
 */

/** Known fields, in display order. Anything else lands under "Other fields". */
const KNOWN_FIELDS = [
  'title',
  'date',
  'publish_date',
  'excerpt',
  'tags',
  'author',
  'canonical',
  'repos',
  'amazon_tracking_id',
  'approved',
] as const;

export interface Repo {
  name: string;
  url: string;
}

/** `repos:` entries that have both a name and a URL. */
export function reposOf(
  fields: Record<string, FrontmatterValue> | null,
): Repo[] {
  const value = fields?.repos;
  if (!Array.isArray(value)) {
    return [];
  }
  const repos: Repo[] = [];
  for (const entry of value) {
    if (
      entry !== null &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      typeof entry.name === 'string' &&
      typeof entry.url === 'string'
    ) {
      // Trimmed like the API's copy, so the two match when looking up a check.
      repos.push({ name: entry.name, url: entry.url.trim() });
    }
  }
  return repos;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

const STATE_LABEL: Record<RepoCheck['state'], string> = {
  ok: 'public',
  private: 'private',
  'not-found': 'private or not found',
  unchecked: 'not checked',
  error: 'could not check',
};

/** One `repos:` entry with its live GitHub status. A row of its own so it is easy to extend. */
export function RepoRow({
  repo,
  check,
  pending,
}: {
  repo: Repo;
  check?: RepoCheck;
  pending: boolean;
}) {
  return (
    <li className="frontmatter__repo">
      {isHttpUrl(repo.url) ? (
        <a href={repo.url} target="_blank" rel="noopener noreferrer">
          {repo.name}
        </a>
      ) : (
        <span>{repo.name}</span>
      )}{' '}
      <span className="frontmatter__muted">{repo.url}</span>
      {pending && <span className="badge">checking…</span>}
      {check && (
        <span
          className={`badge${
            check.state === 'private' || check.state === 'not-found'
              ? ' badge--blocker'
              : check.state === 'ok'
                ? ' badge--pass'
                : ''
          }`}
          title={check.detail}
        >
          {STATE_LABEL[check.state]}
        </span>
      )}
    </li>
  );
}

function ValueView({ name, value }: { name: string; value: FrontmatterValue }) {
  if (typeof value === 'string') {
    if (name === 'canonical' && isHttpUrl(value)) {
      return (
        <a href={value} target="_blank" rel="noopener noreferrer">
          {value}
        </a>
      );
    }
    return <>{value}</>;
  }
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return (
      <span className="frontmatter__chips">
        {(value as string[]).map((v, i) => (
          <span key={`${i}-${v}`} className="frontmatter__chip">
            {v}
          </span>
        ))}
      </span>
    );
  }
  return <code>{JSON.stringify(value)}</code>;
}

function FieldRow({ name, value }: { name: string; value: FrontmatterValue }) {
  return (
    <>
      <dt>{name}</dt>
      <dd>
        <ValueView name={name} value={value} />
      </dd>
    </>
  );
}

export default function FrontmatterPanel({
  frontmatter,
  slug,
  idToken,
  repoSuggestions,
  onDecideSuggestion,
  suggestionsEditable = false,
}: {
  frontmatter: FrontmatterInfo | undefined;
  slug: string;
  idToken: string;
  /** Repos the link/repo suggestion step proposes adding to `repos:` (PIPE-38). */
  repoSuggestions?: RepoSuggestion[];
  onDecideSuggestion?: (id: string, decision: SuggestionDecision) => void;
  suggestionsEditable?: boolean;
}) {
  const fields = frontmatter?.fields ?? null;
  const repos = reposOf(fields);
  const hasRepos = repos.length > 0;
  const [checks, setChecks] = useState<RepoCheck[] | null>(null);
  const [checkFailed, setCheckFailed] = useState(false);

  useEffect(() => {
    if (!hasRepos) {
      return;
    }
    let cancelled = false;
    setChecks(null);
    setCheckFailed(false);
    fetchRepoChecks(slug, idToken)
      .then((result) => {
        if (!cancelled) {
          setChecks(result);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCheckFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [slug, idToken, hasRepos]);

  if (!frontmatter) {
    return null;
  }

  const checkFor = (repo: Repo) =>
    checks?.find((c) => c.url === repo.url && c.name === repo.name);

  const repoWarnings: FrontmatterWarning[] = (checks ?? [])
    .filter((c) => c.state === 'private' || c.state === 'not-found')
    .map((c) => ({
      code: 'repo-unreachable' as const,
      field: 'repos',
      message: `Repository '${c.name}' may be private or missing on GitHub (${c.url}).`,
    }));
  const warnings = [...frontmatter.warnings, ...repoWarnings];

  const suggestedRepos = repoSuggestions ?? [];
  const suggestedRows = suggestedRepos.map((r) => (
    <RepoSuggestionRow
      key={r.id}
      repo={r}
      editable={suggestionsEditable && onDecideSuggestion !== undefined}
      onDecide={onDecideSuggestion ?? (() => undefined)}
    />
  ));
  const hasPendingSuggestion = suggestedRepos.some((r) => r.decision === 'pending');

  const known = new Set<string>(KNOWN_FIELDS);
  const present = KNOWN_FIELDS.filter((k) => fields && k in fields);
  const others = Object.keys(fields ?? {}).filter((k) => !known.has(k));

  return (
    <details className="frontmatter" open={warnings.length > 0 || hasPendingSuggestion}>
      <summary>
        Frontmatter
        {warnings.length > 0 && (
          <span className="badge badge--blocker">
            {warnings.length} {warnings.length === 1 ? 'warning' : 'warnings'}
          </span>
        )}
      </summary>

      {warnings.length > 0 && (
        <ul className="frontmatter__warnings" aria-label="Frontmatter warnings">
          {warnings.map((w, i) => (
            <li key={`${w.code}-${w.field ?? ''}-${i}`}>{w.message}</li>
          ))}
        </ul>
      )}
      {!frontmatter.filenameKnown && frontmatter.present && (
        <p className="frontmatter__muted">
          Source filename unknown, so the date and canonical checks were skipped.
        </p>
      )}

      {fields && (
        <dl className="frontmatter__fields">
          {present.map((name) =>
            name === 'repos' ? (
              <div key="repos" className="frontmatter__group">
                <dt>repos</dt>
                <dd>
                  <ul className="frontmatter__repos">
                    {repos.map((repo) => (
                      <RepoRow
                        key={`${repo.name}-${repo.url}`}
                        repo={repo}
                        check={checkFor(repo)}
                        pending={hasRepos && checks === null && !checkFailed}
                      />
                    ))}
                    {suggestedRows}
                  </ul>
                  {checkFailed && (
                    <span className="frontmatter__muted">
                      Could not check the repositories on GitHub.
                    </span>
                  )}
                </dd>
              </div>
            ) : (
              <FieldRow key={name} name={name} value={fields[name]} />
            ),
          )}
        </dl>
      )}

      {suggestedRows.length > 0 && !present.includes('repos') && (
        <dl className="frontmatter__fields">
          <div className="frontmatter__group">
            <dt>repos</dt>
            <dd>
              <ul className="frontmatter__repos">{suggestedRows}</ul>
            </dd>
          </div>
        </dl>
      )}

      {others.length > 0 && fields && (
        <>
          <h4 className="frontmatter__heading">Other fields</h4>
          <dl className="frontmatter__fields">
            {others.map((name) => (
              <FieldRow key={name} name={name} value={fields[name]} />
            ))}
          </dl>
        </>
      )}

      {frontmatter.raw !== null && (
        <details className="frontmatter__raw">
          <summary>Raw frontmatter</summary>
          <pre>{frontmatter.raw}</pre>
        </details>
      )}
    </details>
  );
}
