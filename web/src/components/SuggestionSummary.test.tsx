import { fireEvent, render, screen } from '@testing-library/react';
import type { LinkSuggestion, RepoSuggestion, Suggestions } from '../api/post-detail';
import { SuggestionSummary } from './SuggestionSummary';

const link: LinkSuggestion = {
  id: 'l1', kind: 'link', anchorText: 'the Cabal', context: '', targetSlug: 's', targetTitle: 'Cabal post',
  targetUrl: 'u', targetDate: 'd', occurrence: { paragraph: 0, offset: 0 }, reason: 'r', decision: 'pending',
};
const repo: RepoSuggestion = {
  id: 'r1', kind: 'repo', fullName: 'nakomis/mcps', name: 'mcps', url: 'https://github.com/nakomis/mcps',
  description: 'MCP servers', evidence: 'The tool lives in mcps.', reason: 'Discussed at length.',
  source: 'llm', decision: 'pending',
};
const base: Suggestions = {
  version: 1, slug: 'p', iteration: 2, generatedAt: 'x', status: 'ok',
  models: { chat: 'c', embed: 'e' }, links: [link], repos: [repo], dropped: [],
};

function renderSummary(over: Partial<Suggestions> = {}, extra: { stale?: LinkSuggestion[]; editable?: boolean } = {}) {
  const onDecide = vi.fn();
  const onRejectAll = vi.fn();
  render(
    <SuggestionSummary
      suggestions={{ ...base, ...over }}
      stale={extra.stale ?? []}
      editable={extra.editable ?? true}
      onDecide={onDecide}
      onRejectAll={onRejectAll}
    />,
  );
  return { onDecide, onRejectAll };
}

test('counts what was suggested and what is undecided', () => {
  renderSummary();
  expect(screen.getByText(/1 link, 1 repo suggested/)).toBeInTheDocument();
  expect(screen.getByText(/2 undecided/)).toBeInTheDocument();
});

test('shows a skipped step with its reason, noting the post was staged regardless', () => {
  renderSummary({ status: 'skipped', skippedReason: 'no-embeddings-index', links: [], repos: [] });
  expect(screen.getByRole('status')).toHaveTextContent('skipped (no-embeddings-index)');
  expect(screen.getByRole('status')).toHaveTextContent('staged regardless');
});

test('shows a failed step as such', () => {
  renderSummary({ status: 'error', skippedReason: 'error: Bedrock throttled', links: [], repos: [] });
  expect(screen.getByRole('status')).toHaveTextContent('the step failed (error: Bedrock throttled)');
});

test('says so when there is nothing to suggest', () => {
  renderSummary({ links: [], repos: [], dropped: [] });
  expect(screen.getByRole('status')).toHaveTextContent('No link or repo suggestions for this post');
});

test('leaves suggested repos to the frontmatter panel', () => {
  renderSummary();
  expect(screen.queryByRole('heading', { name: 'Suggested repos' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'mcps' })).toBeNull();
  expect(screen.getByText(/suggested repos appear in the frontmatter panel/)).toBeInTheDocument();
});

test('"Reject all undecided" calls back', () => {
  const { onRejectAll } = renderSummary();
  fireEvent.click(screen.getByRole('button', { name: 'Reject all undecided' }));
  expect(onRejectAll).toHaveBeenCalled();
});

test('lists stale links that cannot be shown inline, and lets them be rejected', () => {
  const { onDecide } = renderSummary({}, { stale: [link] });
  expect(screen.getByText(/will be skipped on approval/)).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole('button', { name: 'Reject' })[0]);
  expect(onDecide).toHaveBeenCalledWith('l1', 'rejected');
});

test('keeps an audit list of what validation dropped', () => {
  renderSummary({ dropped: [{ kind: 'link', value: 'the final review', reason: 'not sure' }] });
  expect(screen.getByText('Dropped by validation (1)')).toBeInTheDocument();
  expect(screen.getByText(/not sure/)).toBeInTheDocument();
});
