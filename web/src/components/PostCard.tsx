import { Link } from 'react-router';
import { displayStage, type Post } from '../api/posts';

const DAY_MS = 86_400_000;

/** A coarse "x days ago" — exact enough for a pipeline overview. */
export function formatUpdated(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return 'unknown';
  }
  const days = Math.floor((now - then) / DAY_MS);
  if (days <= 0) {
    return 'today';
  }
  if (days === 1) {
    return 'yesterday';
  }
  if (days < 30) {
    return `${days} days ago`;
  }
  const months = Math.floor(days / 30);
  return months === 1 ? '1 month ago' : `${months} months ago`;
}

/**
 * A single post on the dashboard. Links through to the post detail view —
 * "the bag" — which is owned by PIPE-4.
 */
export default function PostCard({ post }: { post: Post }) {
  return (
    <Link className="post-card" to={`/post/${post.slug}`}>
      <h3 className="post-card__title">{post.title}</h3>
      {displayStage(post) === 'scheduled' && (
        <p className="post-card__publish-date">Publishes {post.publishDate}</p>
      )}
      {post.summary && <p className="post-card__summary">{post.summary}</p>}
      <div className="post-card__meta">
        <span className="post-card__slug">{post.slug}</span>
        <span className="post-card__updated">
          Updated {formatUpdated(post.updatedAt)}
        </span>
      </div>
      {post.publishabilityScore !== undefined && (
        <span className="post-card__score">
          Score {post.publishabilityScore}
        </span>
      )}
    </Link>
  );
}
