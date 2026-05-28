import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from 'react-oidc-context';
import { Link, useParams } from 'react-router';
import { diffLines } from 'diff';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  decidePost,
  editPost,
  fetchPostDetail,
  type PostDetail as PostDetailData,
} from '../api/post-detail';
import './PostDetail.css';

type Tab = 'article' | 'diff' | 'reviews' | 'images';

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

/** The generated images. */
function ImagesView({ images }: { images: PostDetailData['images'] }) {
  if (images.length === 0) {
    return <p className="detail__empty">This post has no images.</p>;
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

  const decide = async (decision: 'approve' | 'reject') => {
    if (!slug) {
      return;
    }
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const result = await decidePost(slug, decision, idToken);
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
            <span className={`badge badge--status badge--${data.post.status}`}>
              {data.post.status}
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
                onClick={() => void save(false)}
              >
                Save
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void save(true)}
              >
                Save & re-review
              </button>
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
                disabled={!staged}
                onClick={() => setEditing(true)}
              >
                Edit
              </button>
            </div>
            <div className="markdown">
              <Markdown remarkPlugins={[remarkGfm]}>
                {data.finalMarkdown}
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
