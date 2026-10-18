import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from 'react-oidc-context';
import { Link, useParams } from 'react-router';
import { diffLines } from 'diff';
import Markdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  decidePost,
  editPost,
  fetchFailedMarkdown,
  fetchPostDetail,
  reReviewFailed,
  saveFailedMarkdown,
  setAffiliateDecisions,
  setSuggestionDecisions,
  type AffiliateRequest,
  type AffiliateResponse,
  type AnnounceMode,
  type SuggestionDecision,
  type PostDetail as PostDetailData,
} from '../api/post-detail';
import { displayStage, type FailureHistoryEntry, type Post } from '../api/posts';
import { AffiliateStep } from './AffiliateStep';
import FrontmatterPanel from './FrontmatterPanel';
import {
  SuggestionMark,
  SuggestionProvider,
  staleLinks,
  suggestionPlugin,
} from './InlineSuggestions';
import { SuggestionSummary } from './SuggestionSummary';
import './PostDetail.css';

type Tab = 'article' | 'affiliate' | 'diff' | 'reviews' | 'images';

/**
 * Where repo-hosted post images live. Posts that arrive with ready-made
 * images (rather than `{{image}}` placeholders) reference `images/…` paths
 * that exist in blog-content and are synced to the blog CDN on push — not in
 * the pipeline's drafts bucket.
 */
const BLOG_IMAGE_BASE = 'https://blog.nakomis.com/';

/** Drop a leading YAML frontmatter block — the preview renders the article, not the file. */
function stripFrontmatter(markdown: string): string {
  const match = markdown.match(/^---\n[\s\S]*?\n---\n?/);
  return match ? markdown.slice(match[0].length) : markdown;
}

/** A read-only line diff between the original and the final draft. */
function DiffView({ original, final }: { original: string; final: string }) {
  const parts = useMemo(() => diffLines(original, final), [original, final]);
  if (original === final) {
    return <p className="detail__empty">No changes from the original draft.</p>;
  }
  return (
    <pre className="diff" aria-label="Changes from the original draft">
      {parts.map((part, i) => {
        const kind = part.added ? 'added' : part.removed ? 'removed' : 'same';
        const sign = part.added ? '+' : part.removed ? '-' : ' ';
        return part.value
          .replace(/\n$/, '')
          .split('\n')
          .map((line, j) => (
            <span key={`${i}-${j}`} className={`diff__line diff__line--${kind}`}>
              {sign} {line}
            </span>
          ));
      })}
    </pre>
  );
}

/** The reviewer verdicts, grouped by iteration. */
function ReviewsView({
  iterations,
}: {
  iterations: PostDetailData['iterations'];
}) {
  if (iterations.length === 0) {
    return <p className="detail__empty">No reviews recorded yet.</p>;
  }
  return (
    <div className="reviews">
      {iterations.map((it) => (
        <section key={it.iteration} className="reviews__iteration">
          <h3>
            Iteration {it.iteration}
            {it.edited && <span className="badge">edited</span>}
            {it.gate && (
              <span className={`badge badge--${it.gate.decision}`}>
                {it.gate.decision}
              </span>
            )}
          </h3>
          {it.reviews.map((r, i) =>
            r.status === 'ok' ? (
              <article key={`${r.provider}-${i}`} className="review">
                <header>
                  <strong>{r.provider}</strong>
                  <span className="review__score">{r.score}/10</span>
                  {r.blocker && <span className="badge badge--blocker">blocker</span>}
                </header>
                <p className="review__critique">{r.critique}</p>
              </article>
            ) : (
              <article key={`${r.provider}-${i}`} className="review review--down">
                <header>
                  <strong>{r.provider}</strong>
                  <span className="badge">unavailable</span>
                </header>
                <p className="review__critique">{r.error}</p>
              </article>
            ),
          )}
        </section>
      ))}
    </div>
  );
}

/** A plain-English reason for a review outcome or a rejection. */
export function describeFailure(outcome: string | undefined): string {
  switch (outcome) {
    case 'capped':
      return 'Reached the iteration cap without passing review.';
    case 'quorum':
      return 'Too few reviewers returned a verdict.';
    case 'exception':
      return 'The review loop hit an error.';
    case 'rejected':
      return 'Rejected in the bag.';
    default:
      return 'Review failed.';
  }
}

function formatWhen(iso: string | undefined): string {
  return iso ? new Date(iso).toLocaleString('en-GB') : 'unknown time';
}

/** Why a failed post failed, shown above the tabs (PIPE-36). */
function FailureReason({ post }: { post: Post }) {
  const outcome = post.reviewOutcome ?? (post.rejectedAt ? 'rejected' : undefined);
  return (
    <section className="failure" aria-label="Failure reason">
      <strong>{describeFailure(outcome)}</strong>
      {post.reviewError && <p className="failure__error">{post.reviewError}</p>}
      <p className="failure__hint">
        Edit the article and choose Re-review to send it back through the
        review loop.
      </p>
    </section>
  );
}

/** Failures cleared by earlier re-reviews — kept so the history stays visible. */
function FailureHistory({ entries }: { entries: FailureHistoryEntry[] }) {
  return (
    <details className="failure-history">
      <summary>Previous failures ({entries.length})</summary>
      <ol>
        {entries.map((entry, i) => (
          <li key={`${entry.clearedAt}-${i}`}>
            <strong>{describeFailure(entry.reviewOutcome)}</strong>{' '}
            <span className="failure-history__meta">
              {entry.iteration !== undefined && `Iteration ${entry.iteration}, `}
              failed {formatWhen(entry.failedAt)}; re-reviewed from iteration{' '}
              {entry.reReviewIteration} on {formatWhen(entry.clearedAt)}.
            </span>
            {entry.reviewError && (
              <p className="failure__error">{entry.reviewError}</p>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}

/** The generated images. */
function ImagesView({ images }: { images: PostDetailData['images'] }) {
  if (images.length === 0) {
    return (
      <p className="detail__empty">
        This post has no pipeline-generated images. Any ready-made images it
        references are shown in place in the Article tab.
      </p>
    );
  }
  return (
    <div className="images">
      {images.map((img) => (
        <figure key={img.index} className="images__item">
          {img.status === 'ready' && img.url ? (
            <img src={img.url} alt={img.prompt} loading="lazy" />
          ) : (
            <div className={`images__placeholder images__placeholder--${img.status}`}>
              {img.status === 'failed' ? 'Generation failed' : 'Generating…'}
            </div>
          )}
          <figcaption>{img.prompt}</figcaption>
        </figure>
      ))}
    </div>
  );
}

/** The post detail view — "the bag" (PIPE-4). */
function PostDetailInner({ idToken }: { idToken: string }) {
  const { slug } = useParams<{ slug: string }>();
  const [data, setData] = useState<PostDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('article');

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  // Default 'announce': most posts get announced on publication; 'skip' for
  // the quieter ones, 'force' to jump the flood guard (PIPE-20/PIPE-29).
  const [announceBluesky, setAnnounceBluesky] = useState<AnnounceMode>('announce');
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!slug) {
      return;
    }
    setError(null);
    try {
      const detail = await fetchPostDetail(slug, idToken);
      setData(detail);
      setDraft(detail.finalMarkdown);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [slug, idToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const staged = data?.post.status === 'staged';
  // A failed post is edited in place and re-reviewed (PIPE-36), through its
  // own endpoints rather than the staged-post edit.
  const failed = data?.post.status === 'failed';
  const failureHistory = data?.post.failureHistory ?? [];

  // The stored Markdown links generated images by their pipeline-relative path
  // (`images/{slug}-N.png`), which 404s in the SPA. Swap those for the
  // presigned URLs the detail bundle provides, matched by image index.
  const imageUrlByPath = useMemo(() => {
    const map = new Map<string, string>();
    if (data) {
      for (const img of data.images) {
        if (img.status === 'ready' && img.url) {
          map.set(`images/${data.post.slug}-${img.index}.png`, img.url);
        }
      }
    }
    return map;
  }, [data]);

  // ── Link and repo suggestions (PIPE-38) ──────────────────────────────────
  const suggestions = data?.suggestions ?? null;
  const links = suggestions?.status === 'ok' ? suggestions.links : [];
  const articleMarkdown = data ? stripFrontmatter(data.finalMarkdown) : '';
  const stale = useMemo(() => staleLinks(links, articleMarkdown), [links, articleMarkdown]);
  const staleIds = useMemo(() => new Set(stale.map((l) => l.id)), [stale]);
  const inlineLinks = useMemo(
    () => links.filter((l) => !staleIds.has(l.id)),
    [links, staleIds],
  );
  const remarkPlugins = useMemo(
    () => [remarkGfm, suggestionPlugin(inlineLinks)],
    [inlineLinks],
  );
  const undecided = suggestions
    ? [...suggestions.links, ...suggestions.repos].filter((s) => s.decision === 'pending').length
    : 0;

  // ── Affiliate links (PIPE-41) ────────────────────────────────────────────
  const affiliates = suggestions?.affiliatesStatus === 'ok' ? (suggestions.affiliates ?? []) : [];
  const affiliatePending = affiliates.filter((a) => a.decision === 'pending').length;
  const affiliateLinked = affiliates.filter((a) => a.decision === 'linked').length;
  const frontmatterTrackingId = data?.frontmatter?.fields?.amazon_tracking_id;
  const sourceTrackingId =
    typeof frontmatterTrackingId === 'string' && frontmatterTrackingId.trim() !== ''
      ? frontmatterTrackingId.trim()
      : undefined;
  const typedTrackingId = suggestions?.trackingId;

  // Choices are saved one at a time, in order, so quick clicks cannot overwrite
  // each other on the server.
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  // Set when a queued save failed (and was rolled back), so approval can refuse
  // to go ahead on choices the server never recorded.
  const suggestionSaveFailed = useRef(false);

  const setLocalDecisions = (changes: Record<string, SuggestionDecision>) => {
    setData((prev) => {
      if (!prev?.suggestions) {
        return prev;
      }
      const apply = <T extends { id: string; decision: SuggestionDecision }>(items: T[]): T[] =>
        items.map((i) => (changes[i.id] ? { ...i, decision: changes[i.id] } : i));
      return {
        ...prev,
        suggestions: {
          ...prev.suggestions,
          links: apply(prev.suggestions.links),
          repos: apply(prev.suggestions.repos),
        },
      };
    });
  };

  const decideSuggestions = (changes: Record<string, SuggestionDecision>) => {
    if (!slug || !data?.suggestions) {
      return;
    }
    const before: Record<string, SuggestionDecision> = {};
    for (const s of [...data.suggestions.links, ...data.suggestions.repos]) {
      if (changes[s.id]) {
        before[s.id] = s.decision;
      }
    }
    setError(null);
    setLocalDecisions(changes);
    saveQueue.current = saveQueue.current.then(async () => {
      try {
        await setSuggestionDecisions(slug, changes, idToken);
      } catch (err) {
        suggestionSaveFailed.current = true;
        setLocalDecisions(before);
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  const decideSuggestion = (id: string, decision: SuggestionDecision) =>
    decideSuggestions({ [id]: decision });

  const rejectAllUndecided = () => {
    if (!suggestions) {
      return;
    }
    const changes: Record<string, SuggestionDecision> = {};
    for (const s of [...suggestions.links, ...suggestions.repos]) {
      if (s.decision === 'pending') {
        changes[s.id] = 'rejected';
      }
    }
    decideSuggestions(changes);
  };

  // Affiliate choices go through the same queue as accept / reject. They are not
  // applied optimistically: the server checks the pasted link, so its answer is
  // what the page shows.
  const sendAffiliates = (request: AffiliateRequest): Promise<AffiliateResponse> =>
    new Promise((resolve, reject) => {
      if (!slug) {
        reject(new Error('No post'));
        return;
      }
      saveQueue.current = saveQueue.current.then(async () => {
        try {
          const response = await setAffiliateDecisions(slug, request, idToken);
          setData((prev) =>
            prev?.suggestions
              ? {
                  ...prev,
                  suggestions: {
                    ...prev.suggestions,
                    affiliates: response.suggestions.affiliates,
                    trackingId: response.suggestions.trackingId,
                  },
                }
              : prev,
          );
          resolve(response);
        } catch (err) {
          reject(err);
        }
      });
    });

  const showError = (err: unknown) => setError(err instanceof Error ? err.message : String(err));

  const saveAffiliateLink = async (id: string, url: string) => {
    const response = await sendAffiliates({ decisions: { [id]: { action: 'link', url } } });
    return response.results[id] ?? { ok: false, error: 'The server did not answer for that mention.' };
  };
  const skipAffiliate = (id: string) =>
    void sendAffiliates({ decisions: { [id]: { action: 'skip' } } }).catch(showError);
  const resetAffiliate = (id: string) =>
    void sendAffiliates({ decisions: { [id]: { action: 'reset' } } }).catch(showError);
  const skipRemainingAffiliates = async (): Promise<boolean> => {
    try {
      await sendAffiliates({ skipRemaining: true });
      return true;
    } catch (err) {
      showError(err);
      return false;
    }
  };
  // When nothing is left to decide, the natural next move is Approve.
  const approveButton = useRef<HTMLButtonElement>(null);
  const setTrackingId = async (id: string | null) => {
    const response = await sendAffiliates({ trackingId: id });
    return response.trackingId ?? { ok: true };
  };

  // Generated images and the like are resolved the same way in both article views.
  const imageComponent: Components['img'] = ({ src, alt, ...props }) => {
    const normalised = src?.replace(/^\.\//, '') ?? '';
    const resolved =
      imageUrlByPath.get(normalised) ??
      (normalised.startsWith('images/') ? `${BLOG_IMAGE_BASE}${normalised}` : src);
    return <img src={resolved} alt={alt} loading="lazy" {...props} />;
  };

  const save = async (reReview: boolean) => {
    if (!slug) {
      return;
    }
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const result = await editPost(slug, draft, reReview, idToken);
      setEditing(false);
      setNotice(
        reReview
          ? `Saved as iteration ${result.iteration}; re-review started.`
          : `Saved as iteration ${result.iteration}.`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const startEditing = async () => {
    if (!failed) {
      setEditing(true);
      return;
    }
    if (!slug) {
      return;
    }
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const editable = await fetchFailedMarkdown(slug, idToken);
      setDraft(editable.markdown);
      setEditing(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const saveFailed = async () => {
    if (!slug) {
      return;
    }
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const result = await saveFailedMarkdown(slug, draft, idToken);
      setEditing(false);
      setNotice(
        `Saved as iteration ${result.iteration}. Choose Re-review when you are ready.`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const reReview = async () => {
    if (!slug) {
      return;
    }
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const result = await reReviewFailed(slug, draft, idToken);
      setEditing(false);
      setNotice(
        result.alreadyStarted
          ? `Re-review from iteration ${result.iteration} was already under way.`
          : `Re-review started from iteration ${result.iteration}.`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const decide = async (decision: 'approve' | 'reject') => {
    if (!slug) {
      return;
    }
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      if (decision === 'approve') {
        // Approval applies what the server has recorded, so let every pending
        // accept / reject reach it first; and do not approve if one was lost.
        await saveQueue.current;
        if (suggestionSaveFailed.current) {
          suggestionSaveFailed.current = false;
          setError(
            'A suggestion choice could not be saved, so the post was not approved. Check the suggestions and approve again.',
          );
          return;
        }
      }
      const result = await decidePost(slug, decision, idToken, announceBluesky);
      const applied = result.applied;
      const affiliatesApplied = applied?.affiliates ?? 0;
      const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
      const appliedText =
        decision === 'approve' && applied && affiliatesApplied > 0
          ? ` Applied ${plural(applied.links, 'link')}, ${plural(applied.repos, 'repo')} and ${plural(affiliatesApplied, 'affiliate link')}.`
          : decision === 'approve' && applied && (applied.links > 0 || applied.repos > 0)
            ? ` Applied ${applied.links} link${applied.links === 1 ? '' : 's'} and ${applied.repos} repo${applied.repos === 1 ? '' : 's'}.`
            : '';
      const warningsText =
        decision === 'approve' && result.warnings && result.warnings.length > 0
          ? ` ${result.warnings.join(' ')}`
          : '';
      const skippedText =
        result.skipped && result.skipped.length > 0
          ? ` ${result.skipped.length} link${result.skipped.length === 1 ? ' was' : 's were'} skipped: ${result.skipped
              .map((k) => k.reason)
              .join('; ')}.`
          : '';
      setNotice(
        `Post ${decision === 'approve' ? 'approved' : 'rejected'}.${appliedText}${skippedText}${warningsText}`,
      );
      setData((prev) =>
        prev ? { ...prev, post: { ...prev.post, status: result.status as never } } : prev,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (error && !data) {
    return (
      <main className="detail">
        <Link to="/" className="detail__back">
          ← Back to pipeline
        </Link>
        <p role="alert" className="app__error">
          Could not load post: {error}
        </p>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="detail">
        <p className="app__status">Loading post…</p>
      </main>
    );
  }

  return (
    <main className="detail">
      <Link to="/" className="detail__back">
        ← Back to pipeline
      </Link>

      <header className="detail__header">
        <div>
          <h1>{data.post.title}</h1>
          <p className="detail__meta">
            <span>{data.post.slug}</span>
            <span
              className={`badge badge--status badge--${displayStage(data.post)}`}
            >
              {displayStage(data.post) === 'scheduled'
                ? `queued · publishes ${data.post.publishDate}`
                : data.post.status}
            </span>
          </p>
        </div>
        <div className="detail__actions">
          <button
            ref={approveButton}
            type="button"
            className="btn btn--primary"
            disabled={!staged || busy}
            onClick={() => void decide('approve')}
          >
            Approve
          </button>
          {staged && (
            <label className="detail__announce">
              Bluesky:{' '}
              <select
                value={announceBluesky}
                disabled={busy}
                onChange={(e) => setAnnounceBluesky(e.target.value as AnnounceMode)}
              >
                <option value="announce">Announce</option>
                <option value="skip">Don&apos;t Announce</option>
                <option value="force">Force Announce</option>
              </select>
            </label>
          )}
          <button
            type="button"
            className="btn"
            disabled={!staged || busy}
            onClick={() => void decide('reject')}
          >
            Reject
          </button>
        </div>
      </header>

      {notice && <p className="detail__notice">{notice}</p>}
      {staged && undecided > 0 && (
        <p className="detail__notice detail__notice--warn" role="status">
          {undecided} suggestion{undecided === 1 ? ' is' : 's are'} undecided and will not be
          applied if you approve now.
        </p>
      )}
      {staged && affiliatePending > 0 && (
        <p className="detail__notice detail__notice--warn" role="status">
          {affiliatePending} product mention{affiliatePending === 1 ? ' has' : 's have'} no affiliate
          link decision and will not be linked if you approve now.
        </p>
      )}
      {staged && affiliateLinked > 0 && !sourceTrackingId && !typedTrackingId && (
        <p className="detail__notice detail__notice--warn" role="status">
          {affiliateLinked} affiliate link{affiliateLinked === 1 ? '' : 's'} pasted, but this post has
          no amazon_tracking_id: they will earn under nakomis-21 and cannot be attributed to the post.
        </p>
      )}
      {failed && <FailureReason post={data.post} />}
      {failureHistory.length > 0 && <FailureHistory entries={failureHistory} />}
      {error && (
        <p role="alert" className="app__error">
          {error}
        </p>
      )}

      <FrontmatterPanel
        frontmatter={data.frontmatter}
        slug={data.post.slug}
        idToken={idToken}
        repoSuggestions={suggestions?.status === 'ok' ? suggestions.repos : undefined}
        onDecideSuggestion={decideSuggestion}
        suggestionsEditable={staged}
      />

      <nav className="detail__tabs" aria-label="Post views">
        {(
          [
            'article',
            ...(affiliates.length > 0 ? (['affiliate'] as const) : []),
            'diff',
            'reviews',
            'images',
          ] as const
        ).map((t) => (
          <button
            key={t}
            type="button"
            className={`detail__tab${tab === t ? ' detail__tab--active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'article'
              ? 'Article'
              : t === 'affiliate'
                ? `Affiliate links${affiliatePending > 0 ? ` (${affiliatePending})` : ''}`
                : t === 'diff'
                  ? 'Changes'
                  : t === 'reviews'
                    ? 'Reviews'
                    : 'Images'}
          </button>
        ))}
      </nav>

      {tab === 'article' &&
        (editing ? (
          <div className="editor">
            <textarea
              className="editor__textarea"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label="Edit article Markdown"
            />
            <div className="editor__actions">
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy}
                onClick={() => void (failed ? saveFailed() : save(false))}
              >
                Save
              </button>
              {failed ? (
                <button
                  type="button"
                  className="btn"
                  disabled={busy || draft.trim().length === 0}
                  onClick={() => void reReview()}
                >
                  Re-review
                </button>
              ) : (
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void save(true)}
                >
                  Save & re-review
                </button>
              )}
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  setDraft(data.finalMarkdown);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="article">
            <div className="article__toolbar">
              <button
                type="button"
                className="btn"
                disabled={!(staged || failed) || busy}
                onClick={() => void startEditing()}
              >
                Edit
              </button>
            </div>
            {suggestions && (
              <SuggestionSummary
                suggestions={suggestions}
                stale={stale}
                editable={staged}
                onDecide={decideSuggestion}
                onRejectAll={rejectAllUndecided}
              />
            )}
            <SuggestionProvider links={inlineLinks} onDecide={decideSuggestion} editable={staged}>
            <div className="markdown">
              <Markdown
                remarkPlugins={remarkPlugins}
                components={{
                  mark: (props) => <SuggestionMark {...props} />,
                  img: imageComponent,
                }}
              >
                {articleMarkdown}
              </Markdown>
            </div>
            </SuggestionProvider>
          </div>
        ))}

      {tab === 'affiliate' && affiliates.length > 0 && (
        <AffiliateStep
          mentions={affiliates}
          markdown={articleMarkdown}
          editable={staged}
          sourceTrackingId={sourceTrackingId}
          typedTrackingId={typedTrackingId}
          renderArticle={(plugin, components) => (
            <Markdown
              remarkPlugins={[remarkGfm, plugin]}
              components={{ ...components, img: imageComponent }}
            >
              {articleMarkdown}
            </Markdown>
          )}
          onSave={saveAffiliateLink}
          onSkip={skipAffiliate}
          onReset={resetAffiliate}
          onSkipRemaining={skipRemainingAffiliates}
          onAllDecided={() => approveButton.current?.focus()}
          onSetTrackingId={setTrackingId}
        />
      )}

      {tab === 'diff' && (
        <DiffView original={data.originalMarkdown} final={data.finalMarkdown} />
      )}
      {tab === 'reviews' && <ReviewsView iterations={data.iterations} />}
      {tab === 'images' && <ImagesView images={data.images} />}
    </main>
  );
}

/** Gates the detail view behind Cognito, mirroring `App`. */
export default function PostDetail() {
  const auth = useAuth();

  if (auth.isLoading) {
    return (
      <main className="detail">
        <p className="app__status">Loading…</p>
      </main>
    );
  }
  if (auth.error) {
    return (
      <main className="detail">
        <p className="app__error">Authentication error: {auth.error.message}</p>
      </main>
    );
  }
  if (!auth.isAuthenticated || !auth.user?.id_token) {
    return (
      <main className="detail app--centred">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void auth.signinRedirect()}
        >
          Sign in
        </button>
      </main>
    );
  }
  return <PostDetailInner idToken={auth.user.id_token} />;
}
