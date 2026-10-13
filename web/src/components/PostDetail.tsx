import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from 'react-oidc-context';
import { Link, useParams } from 'react-router';
import { diffLines } from 'diff';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  decidePost,
  editPost,
  fetchFailedMarkdown,
  fetchPostDetail,
  reReviewFailed,
  saveFailedMarkdown,
  type AnnounceMode,
  type PostDetail as PostDetailData,
} from '../api/post-detail';
import { displayStage, type FailureHistoryEntry, type Post } from '../api/posts';
import './PostDetail.css';

type Tab = 'article' | 'diff' | 'reviews' | 'images';

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
      const result = await decidePost(slug, decision, idToken, announceBluesky);
      setNotice(`Post ${decision === 'approve' ? 'approved' : 'rejected'}.`);
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
      {failed && <FailureReason post={data.post} />}
      {failureHistory.length > 0 && <FailureHistory entries={failureHistory} />}
      {error && (
        <p role="alert" className="app__error">
          {error}
        </p>
      )}

      <nav className="detail__tabs" aria-label="Post views">
        {(['article', 'diff', 'reviews', 'images'] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={`detail__tab${tab === t ? ' detail__tab--active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'article'
              ? 'Article'
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
            <div className="markdown">
              <Markdown
                remarkPlugins={[remarkGfm]}
                components={{
                  img: ({ src, alt, ...props }) => {
                    const normalised = src?.replace(/^\.\//, '') ?? '';
                    const resolved =
                      imageUrlByPath.get(normalised) ??
                      (normalised.startsWith('images/')
                        ? `${BLOG_IMAGE_BASE}${normalised}`
                        : src);
                    return <img src={resolved} alt={alt} loading="lazy" {...props} />;
                  },
                }}
              >
                {stripFrontmatter(data.finalMarkdown)}
              </Markdown>
            </div>
          </div>
        ))}

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
