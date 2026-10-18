import { render, screen, waitFor } from '@testing-library/react';
import FrontmatterPanel, { reposOf } from './FrontmatterPanel';
import {
  fetchRepoChecks,
  type FrontmatterInfo,
} from '../api/post-detail';

vi.mock('../api/post-detail');

const mockedChecks = vi.mocked(fetchRepoChecks);

function info(overrides: Partial<FrontmatterInfo> = {}): FrontmatterInfo {
  return {
    present: true,
    raw: 'title: "T"',
    filenameKnown: true,
    warnings: [],
    fields: {
      title: 'My Title',
      date: '2026-10-18',
      excerpt: 'A hook.',
      tags: ['claude-code', 'bash'],
      author: 'Martin Harris',
      canonical: 'https://blog.example.test/2026-10-18-my-title',
      approved: 'true',
      bluesky_announce: 'force',
    },
    ...overrides,
  };
}

const withRepos = (extra: Partial<FrontmatterInfo> = {}) =>
  info({
    ...extra,
    fields: {
      ...info().fields!,
      repos: [
        { name: 'claude-chats', url: 'https://github.com/nakomis/claude-chats' },
        { name: 'elsewhere', url: 'https://example.test/x' },
      ],
    },
  });

function renderPanel(frontmatter: FrontmatterInfo | undefined) {
  return render(<FrontmatterPanel frontmatter={frontmatter} slug="p" idToken="tok" />);
}

beforeEach(() => {
  mockedChecks.mockReset();
});

describe('FrontmatterPanel', () => {
  test('renders nothing without frontmatter', () => {
    const { container } = renderPanel(undefined);
    expect(container).toBeEmptyDOMElement();
  });

  test('shows every known field in order, tags as chips, and other fields', () => {
    const { container } = renderPanel(info());
    const names = [...container.querySelectorAll('.frontmatter__fields dt')].map(
      (d) => d.textContent,
    );
    expect(names).toEqual([
      'title',
      'date',
      'excerpt',
      'tags',
      'author',
      'canonical',
      'approved',
      'bluesky_announce',
    ]);
    expect(screen.getByText('My Title')).toBeInTheDocument();
    expect(screen.getByText('claude-code')).toHaveClass('frontmatter__chip');
    expect(
      screen.getByRole('link', { name: /2026-10-18-my-title/ }),
    ).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('Other fields')).toBeInTheDocument();
    expect(screen.getByText('Raw frontmatter')).toBeInTheDocument();
  });

  test('is collapsed with no warnings', () => {
    const { container } = renderPanel(info());
    expect(container.querySelector('details.frontmatter')).not.toHaveAttribute('open');
    expect(screen.queryByText(/warning/)).not.toBeInTheDocument();
  });

  test('opens automatically and counts warnings', () => {
    const { container } = renderPanel(
      info({
        warnings: [
          { code: 'canonical-mismatch', field: 'canonical', message: 'canonical is wrong' },
          { code: 'missing-field', field: 'author', message: 'author missing' },
        ],
      }),
    );
    expect(container.querySelector('details.frontmatter')).toHaveAttribute('open');
    expect(screen.getByText('2 warnings')).toBeInTheDocument();
    expect(screen.getByText('canonical is wrong')).toBeInTheDocument();
  });

  test('singular warning label', () => {
    renderPanel(info({ warnings: [{ code: 'missing-field', message: 'x' }] }));
    expect(screen.getByText('1 warning')).toBeInTheDocument();
  });

  test('explains skipped filename checks', () => {
    renderPanel(info({ filenameKnown: false }));
    expect(screen.getByText(/Source filename unknown/)).toBeInTheDocument();
  });

  test('missing or unparseable frontmatter still renders the raw text and warnings', () => {
    renderPanel({
      present: true,
      raw: 'a: [oops',
      fields: null,
      parseError: 'bad',
      filenameKnown: false,
      warnings: [{ code: 'frontmatter-invalid', message: 'could not be parsed' }],
    });
    expect(screen.getByText('could not be parsed')).toBeInTheDocument();
    expect(screen.getByText('a: [oops')).toBeInTheDocument();
    renderPanel({ present: false, raw: null, fields: null, filenameKnown: false, warnings: [] });
  });

  test('renders non-string values as JSON', () => {
    renderPanel(info({ fields: { title: 'T', extra: { a: 'b' } } }));
    expect(screen.getByText('{"a":"b"}')).toBeInTheDocument();
  });

  describe('repos', () => {
    test('shows checking, then each status, without calling for none', async () => {
      mockedChecks.mockResolvedValue([
        { name: 'claude-chats', url: 'https://github.com/nakomis/claude-chats', state: 'ok' },
        { name: 'elsewhere', url: 'https://example.test/x', state: 'unchecked' },
      ]);
      renderPanel(withRepos());
      expect(screen.getAllByText('checking…')).toHaveLength(2);
      expect(await screen.findByText('public')).toBeInTheDocument();
      expect(screen.getByText('not checked')).toBeInTheDocument();
      expect(screen.queryByText(/warning/)).not.toBeInTheDocument();
      expect(mockedChecks).toHaveBeenCalledWith('p', 'tok');
    });

    test('a private or missing repo adds a warning and opens the panel', async () => {
      mockedChecks.mockResolvedValue([
        { name: 'claude-chats', url: 'https://github.com/nakomis/claude-chats', state: 'not-found' },
      ]);
      const { container } = renderPanel(withRepos());
      expect(await screen.findByText('1 warning')).toBeInTheDocument();
      expect(screen.getByText('private or not found')).toBeInTheDocument();
      expect(container.querySelector('details.frontmatter')).toHaveAttribute('open');
    });

    test('a private repo is reported too, an unreachable check is not a warning', async () => {
      mockedChecks.mockResolvedValue([
        { name: 'claude-chats', url: 'https://github.com/nakomis/claude-chats', state: 'private' },
        { name: 'elsewhere', url: 'https://example.test/x', state: 'error' },
      ]);
      renderPanel(withRepos());
      expect(await screen.findByText('private')).toBeInTheDocument();
      expect(screen.getByText('could not check')).toBeInTheDocument();
      expect(screen.getByText('1 warning')).toBeInTheDocument();
    });

    test('a failed check says so and does not crash', async () => {
      mockedChecks.mockRejectedValue(new Error('boom'));
      renderPanel(withRepos());
      expect(
        await screen.findByText('Could not check the repositories on GitHub.'),
      ).toBeInTheDocument();
      expect(screen.queryByText('checking…')).not.toBeInTheDocument();
    });

    test('makes no request when there are no repos', () => {
      renderPanel(info());
      expect(mockedChecks).not.toHaveBeenCalled();
    });

    test('ignores a result that arrives after unmount', async () => {
      let resolve: (v: never[]) => void = () => undefined;
      mockedChecks.mockReturnValue(new Promise((r) => (resolve = r)));
      const { unmount } = renderPanel(withRepos());
      unmount();
      resolve([]);
      await waitFor(() => expect(mockedChecks).toHaveBeenCalledTimes(1));
    });

    test('non-http URLs are not linked', () => {
      mockedChecks.mockResolvedValue([]);
      renderPanel(
        info({ fields: { title: 'T', repos: [{ name: 'odd', url: 'javascript:alert(1)' }] } }),
      );
      expect(screen.queryByRole('link', { name: 'odd' })).not.toBeInTheDocument();
      expect(screen.getAllByText('odd').length).toBeGreaterThan(0);
    });
  });
});

describe('reposOf', () => {
  test('keeps only well-formed entries', () => {
    expect(reposOf(null)).toEqual([]);
    expect(reposOf({ repos: 'x' })).toEqual([]);
    expect(
      reposOf({ repos: [{ name: 'a', url: 'u' }, { name: 'b' }, ['c'], 'd'] }),
    ).toEqual([{ name: 'a', url: 'u' }]);
  });
});
