import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import PostCard, { formatUpdated } from './PostCard';
import type { Post } from '../api/posts';

const post: Post = {
  slug: 'my-post',
  status: 'reviewing',
  title: 'My Post',
  updatedAt: '2026-05-20T00:00:00Z',
  summary: 'A short summary.',
  publishabilityScore: 72,
};

function renderCard(p: Post = post) {
  return render(
    <MemoryRouter>
      <PostCard post={p} />
    </MemoryRouter>,
  );
}

describe('PostCard', () => {
  test('renders the title and summary, linking to the detail view', () => {
    renderCard();
    expect(
      screen.getByRole('heading', { level: 3, name: 'My Post' }),
    ).toBeInTheDocument();
    expect(screen.getByText('A short summary.')).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', '/post/my-post');
  });

  test('shows the publishability score when present', () => {
    renderCard();
    expect(screen.getByText('Score 72')).toBeInTheDocument();
  });

  test('omits the score when absent', () => {
    renderCard({ ...post, publishabilityScore: undefined });
    expect(screen.queryByText(/^Score/)).not.toBeInTheDocument();
  });
});

describe('formatUpdated', () => {
  const now = new Date('2026-05-20T12:00:00Z').getTime();

  test.each([
    ['2026-05-20T08:00:00Z', 'today'],
    ['2026-05-19T08:00:00Z', 'yesterday'],
    ['2026-05-10T08:00:00Z', '10 days ago'],
    ['2026-03-19T08:00:00Z', '2 months ago'],
  ])('%s → %s', (iso, expected) => {
    expect(formatUpdated(iso, now)).toBe(expected);
  });

  test('returns "unknown" for an invalid date', () => {
    expect(formatUpdated('not-a-date', now)).toBe('unknown');
  });
});
