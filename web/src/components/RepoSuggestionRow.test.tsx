import { fireEvent, render, screen } from '@testing-library/react';
import type { RepoSuggestion } from '../api/post-detail';
import { RepoSuggestionRow } from './RepoSuggestionRow';

const repo: RepoSuggestion = {
  id: 'r1', kind: 'repo', fullName: 'nakomis/mcps', name: 'mcps', url: 'https://github.com/nakomis/mcps',
  description: 'MCP servers', evidence: 'The tool lives in mcps.', reason: 'Discussed at length.',
  source: 'llm', decision: 'pending',
};

function renderRow(over: Partial<RepoSuggestion> = {}, editable = true) {
  const onDecide = vi.fn();
  render(
    <ul>
      <RepoSuggestionRow repo={{ ...repo, ...over }} editable={editable} onDecide={onDecide} />
    </ul>,
  );
  return onDecide;
}

test('shows the repo, its evidence and Haiku’s reason, with accept and reject', () => {
  const onDecide = renderRow();
  expect(screen.getByRole('link', { name: 'mcps' })).toHaveAttribute('href', 'https://github.com/nakomis/mcps');
  expect(screen.getByText('suggested')).toBeInTheDocument();
  expect(screen.getByText(/The tool lives in mcps/)).toBeInTheDocument();
  expect(screen.getByText('Discussed at length.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
  fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
  expect(onDecide).toHaveBeenNthCalledWith(1, 'r1', 'accepted');
  expect(onDecide).toHaveBeenNthCalledWith(2, 'r1', 'rejected');
});

test('an accepted repo says it will be added on approval and offers undo', () => {
  const onDecide = renderRow({ decision: 'accepted' });
  expect(screen.getByText(/will be added to repos on approval/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  expect(onDecide).toHaveBeenCalledWith('r1', 'pending');
});

test('a rejected repo is marked, and read-only mode hides every control', () => {
  renderRow({ decision: 'rejected', description: null }, false);
  expect(screen.getByText(/rejected/)).toBeInTheDocument();
  expect(screen.queryByRole('button')).toBeNull();
});
