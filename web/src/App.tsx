import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth, type AuthContextProps } from 'react-oidc-context';
import { displayStage, fetchPosts, type Post } from './api/posts';
import { publishNow } from './api/post-detail';
import PostCard from './components/PostCard';
import { getConfig } from './config/config';
import './App.css';

/**
 * The stages a post moves through in the review pipeline. The dashboard
 * renders one column per stage; posts are slotted into a column by their
 * `status` attribute in DynamoDB.
 */
export const PIPELINE_STAGES = [
  { id: 'queued', label: 'Awaiting review' },
  { id: 'reviewing', label: 'In review' },
  { id: 'staged', label: 'In the bag' },
  // A human approved the staged post (PIPE-4); PIPE-5 publishes it.
  { id: 'approved', label: 'Approved' },
  // Derived, not a DynamoDB status: `published` rows whose publish date is
  // still in the future — promoted and scheduled, but not yet live (PIPE-17).
  { id: 'scheduled', label: 'Queued' },
  { id: 'published', label: 'Published' },
  // A terminal off-ramp: posts the review loop could not pass — capped after
  // four iterations, quorum not met, or an unexpected error (PIPE-3).
  { id: 'failed', label: 'Failed review' },
] as const;

export type PipelineStageId = (typeof PIPELINE_STAGES)[number]['id'];

type StageFilter = PipelineStageId | 'all';

/** Centred single-line message — used for auth loading / error states. */
function Notice({ children }: { children: React.ReactNode }) {
  return (
    <main className="app">
      <p className="app__status">{children}</p>
    </main>
  );
}

/** The signed-out landing screen. */
function SignIn({ onSignIn }: { onSignIn: () => void }) {
  return (
    <main className="app signin">
      <img className="signin__logo" src="/icon.png" alt="Blog Pipeline" />
      <h1 className="signin__title">Welcome to Blog Pipeline</h1>
      <p className="signin__subtitle">Sign in below to continue</p>
      <button type="button" className="btn btn--primary" onClick={onSignIn}>
        Sign in
      </button>
    </main>
  );
}

/** The authenticated dashboard: posts grouped into pipeline-stage columns. */
function Dashboard({ auth }: { auth: AuthContextProps }) {
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<StageFilter>('all');
  const [publishing, setPublishing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // The API Gateway Cognito authorizer is scopeless, so it validates the ID
  // token, not the access token.
  const token = auth.user?.id_token;

  const load = useCallback(async () => {
    if (!token) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setPosts(await fetchPosts(token));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const postsByStage = useMemo(() => {
    const byStage = new Map<PipelineStageId, Post[]>(
      PIPELINE_STAGES.map((stage) => [stage.id, []]),
    );
    for (const post of posts ?? []) {
      byStage.get(displayStage(post))?.push(post);
    }
    return byStage;
  }, [posts]);

  const signOut = () => {
    const { domain, clientId, logoutUri } = getConfig().cognito;
    void auth.removeUser();
    window.location.href =
      `https://${domain}/logout?client_id=${clientId}` +
      `&logout_uri=${encodeURIComponent(logoutUri)}`;
  };

  const triggerPublish = async () => {
    if (!token) {
      return;
    }
    setPublishing(true);
    setError(null);
    setNotice(null);
    try {
      await publishNow(token);
      setNotice(
        'Publishing approved, due posts — the promote workflow is running. ' +
          'It may take a minute or two to appear on the blog.',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPublishing(false);
    }
  };

  const visibleStages =
    filter === 'all'
      ? PIPELINE_STAGES
      : PIPELINE_STAGES.filter((stage) => stage.id === filter);

  return (
    <main className="app">
      <header className="app__header">
        <div>
          <h1>Blog Pipeline</h1>
          <p>Cloud-native review pipeline for blog.nakomis.com content.</p>
        </div>
        <div className="app__controls">
          <label className="app__filter">
            Filter
            <select
              aria-label="Filter by stage"
              value={filter}
              onChange={(event) =>
                setFilter(event.target.value as StageFilter)
              }
            >
              <option value="all">All stages</option>
              {PIPELINE_STAGES.map((stage) => (
                <option key={stage.id} value={stage.id}>
                  {stage.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void triggerPublish()}
            disabled={publishing}
            title="Promote approved posts whose publish date has arrived, without waiting for the nightly cron"
          >
            {publishing ? 'Publishing…' : 'Publish now'}
          </button>
          <button type="button" className="btn" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      {error && (
        <p role="alert" className="app__error">
          Could not load posts: {error}
        </p>
      )}

      {notice && (
        <p role="status" className="app__status">
          {notice}
        </p>
      )}

      {posts === null && !error ? (
        <p className="app__status">Loading posts…</p>
      ) : (
        <section className="stages" aria-label="Pipeline stages">
          {visibleStages.map((stage) => {
            const stagePosts = postsByStage.get(stage.id) ?? [];
            return (
              <article
                key={stage.id}
                className="stage"
                data-stage={stage.id}
              >
                <h2>
                  {stage.label}
                  <span className="stage__count">{stagePosts.length}</span>
                </h2>
                {stagePosts.length === 0 ? (
                  <p className="stage__empty">No posts yet</p>
                ) : (
                  stagePosts.map((post) => (
                    <PostCard key={post.slug} post={post} />
                  ))
                )}
              </article>
            );
          })}
        </section>
      )}
    </main>
  );
}

/** Gates the dashboard behind Cognito authentication. */
export default function App() {
  const auth = useAuth();

  if (auth.isLoading) {
    return <Notice>Loading…</Notice>;
  }
  if (auth.error) {
    return <Notice>Authentication error: {auth.error.message}</Notice>;
  }
  if (!auth.isAuthenticated) {
    return <SignIn onSignIn={() => void auth.signinRedirect()} />;
  }
  return <Dashboard auth={auth} />;
}
