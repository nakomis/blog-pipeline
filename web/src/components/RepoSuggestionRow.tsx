import type { RepoSuggestion, SuggestionDecision } from '../api/post-detail';

/**
 * One suggested repository (PIPE-38). Its `name` and `url` mirror a frontmatter
 * `repos:` item, so a frontmatter panel can render these rows beside the
 * repositories already listed there.
 */
export function RepoSuggestionRow({
  repo,
  editable,
  onDecide,
}: {
  repo: RepoSuggestion;
  editable: boolean;
  onDecide: (id: string, decision: SuggestionDecision) => void;
}) {
  return (
    <li className={`repo-sugg repo-sugg--${repo.decision}`}>
      <span className="badge">suggested</span>{' '}
      <a href={repo.url} target="_blank" rel="noopener noreferrer">
        {repo.name}
      </a>
      {repo.description && <span className="repo-sugg__description"> — {repo.description}</span>}
      <span className="repo-sugg__why" tabIndex={0} title={repo.reason}>
        <span className="repo-sugg__evidence">“{repo.evidence}”</span>
        <span className="repo-sugg__reason">{repo.reason}</span>
      </span>
      {repo.decision === 'accepted' && (
        <span className="repo-sugg__state"> will be added to repos on approval</span>
      )}
      {repo.decision === 'rejected' && <span className="repo-sugg__state"> rejected</span>}
      {editable && (
        <span className="repo-sugg__actions">
          {repo.decision === 'pending' ? (
            <>
              <button type="button" className="btn btn--small btn--primary" onClick={() => onDecide(repo.id, 'accepted')}>
                Accept
              </button>
              <button type="button" className="btn btn--small" onClick={() => onDecide(repo.id, 'rejected')}>
                Reject
              </button>
            </>
          ) : (
            <button type="button" className="btn btn--small" onClick={() => onDecide(repo.id, 'pending')}>
              Undo
            </button>
          )}
        </span>
      )}
    </li>
  );
}
