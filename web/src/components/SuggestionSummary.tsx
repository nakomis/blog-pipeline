import type { LinkSuggestion, SuggestionDecision, Suggestions } from '../api/post-detail';

/**
 * The bar above the article summarising what the suggestion step produced
 * (PIPE-38): counts, the reason when it produced nothing, links that could not
 * be shown inline, and the audit list of what validation dropped. Suggested
 * repos are shown in the frontmatter panel, beside the repos already listed.
 */
export function SuggestionSummary({
  suggestions,
  stale,
  editable,
  onDecide,
  onRejectAll,
}: {
  suggestions: Suggestions;
  /** Link suggestions whose anchor is no longer exactly once in the article. */
  stale: LinkSuggestion[];
  editable: boolean;
  onDecide: (id: string, decision: SuggestionDecision) => void;
  onRejectAll: () => void;
}) {
  const { status, links, repos, dropped } = suggestions;

  if (status !== 'ok') {
    return (
      <p className="sugg-summary sugg-summary--empty" role="status">
        No link or repo suggestions: {status === 'error' ? 'the step failed' : 'the step was skipped'}
        {suggestions.skippedReason ? ` (${suggestions.skippedReason})` : ''}. The post was staged
        regardless.
      </p>
    );
  }

  const all = [...links, ...repos];
  const undecided = all.filter((s) => s.decision === 'pending').length;
  const staleIds = new Set(stale.map((l) => l.id));
  const unplaced = links.filter((l) => staleIds.has(l.id));

  if (all.length === 0 && dropped.length === 0) {
    return (
      <p className="sugg-summary sugg-summary--empty" role="status">
        No link or repo suggestions for this post.
      </p>
    );
  }

  return (
    <section className="sugg-summary" aria-label="Link and repo suggestions">
      <p>
        <strong>
          {links.length} link{links.length === 1 ? '' : 's'}, {repos.length} repo
          {repos.length === 1 ? '' : 's'} suggested
        </strong>
        {all.length > 0 && <> · {undecided} undecided</>}. Highlighted text in the article shows
        each link and suggested repos appear in the frontmatter panel; nothing is applied until you
        approve.
        {editable && undecided > 0 && (
          <>
            {' '}
            <button type="button" className="btn btn--small" onClick={onRejectAll}>
              Reject all undecided
            </button>
          </>
        )}
      </p>

      {unplaced.length > 0 && (
        <div className="sugg-summary__unplaced">
          <p>Not shown inline (the text has changed since they were suggested):</p>
          <ul>
            {unplaced.map((l) => (
              <li key={l.id}>
                “{l.anchorText}” → {l.targetTitle} <em>(stale; will be skipped on approval)</em>
                {editable && l.decision !== 'rejected' && (
                  <button type="button" className="btn btn--small" onClick={() => onDecide(l.id, 'rejected')}>
                    Reject
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {dropped.length > 0 && (
        <details className="sugg-summary__dropped">
          <summary>Dropped by validation ({dropped.length})</summary>
          <ul>
            {dropped.map((d, i) => (
              <li key={`${d.kind}-${i}`}>
                {d.kind}: <code>{d.value}</code> — {d.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
