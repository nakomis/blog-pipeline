import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { AuthContextProps } from 'react-oidc-context';
import { useAuth } from 'react-oidc-context';
import PostDetail from './PostDetail';
import {
  fetchPostDetail,
  editPost,
  decidePost,
  fetchFailedMarkdown,
  saveFailedMarkdown,
  reReviewFailed,
  setSuggestionDecisions,
  type PostDetail as PostDetailData,
} from '../api/post-detail';

vi.mock('react-oidc-context');
vi.mock('../api/post-detail');

const mockedUseAuth = vi.mocked(useAuth);
const mockedFetch = vi.mocked(fetchPostDetail);
const mockedEdit = vi.mocked(editPost);
const mockedDecide = vi.mocked(decidePost);
const mockedFetchFailed = vi.mocked(fetchFailedMarkdown);
const mockedSaveFailed = vi.mocked(saveFailedMarkdown);
const mockedReReview = vi.mocked(reReviewFailed);
const mockedSetDecisions = vi.mocked(setSuggestionDecisions);

function authState(overrides: Partial<AuthContextProps>): AuthContextProps {
  return {
    isLoading: false,
    isAuthenticated: false,
    error: undefined,
    user: undefined,
    signinRedirect: vi.fn(),
    ...overrides,
  } as unknown as AuthContextProps;
}

const signedIn = () =>
  authState({
    isAuthenticated: true,
    user: { id_token: 'tok' },
  } as Partial<AuthContextProps>);

const sampleDetail: PostDetailData = {
  post: {
    slug: 'my-post',
    status: 'staged',
    title: 'My Post',
    updatedAt: '2026-05-01T00:00:00Z',
  },
  finalMarkdown: '# Final heading\n\nFinal body.',
  originalMarkdown: '# Original heading\n\nOriginal body.',
  iterations: [
    {
      iteration: 1,
      reviews: [
        { provider: 'azure', status: 'ok', score: 6, blocker: false, critique: 'Tighten the intro.' },
        { provider: 'grok', status: 'unavailable', error: 'timeout' },
      ],
      gate: { decision: 'loop', minScore: 6, anyBlocker: false, okCount: 1, capped: false },
      edited: false,
    },
    {
      iteration: 2,
      reviews: [
        { provider: 'azure', status: 'ok', score: 8, blocker: false, critique: 'Good now.' },
      ],
      gate: { decision: 'pass', minScore: 8, anyBlocker: false, okCount: 1, capped: false },
      edited: true,
    },
  ],
  images: [
    { index: 1, prompt: 'a black cat', status: 'ready', url: 'https://img.test/1.png' },
    { index: 2, prompt: 'a ginger cat', status: 'pending' },
  ],
};

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/post/my-post']}>
      <Routes>
        <Route path="/post/:slug" element={<PostDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PostDetail — auth gate', () => {
  test('shows a sign-in button when signed out', () => {
    mockedUseAuth.mockReturnValue(authState({}));
    renderDetail();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  test('shows a loading notice while auth resolves', () => {
    mockedUseAuth.mockReturnValue(authState({ isLoading: true }));
    renderDetail();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  test('shows an authentication error', () => {
    mockedUseAuth.mockReturnValue(
      authState({ error: new Error('boom') as AuthContextProps['error'] }),
    );
    renderDetail();
    expect(screen.getByText(/Authentication error: boom/)).toBeInTheDocument();
  });
});

describe('PostDetail — frontmatter panel (PIPE-37)', () => {
  test('shows the panel above the tabs and leaves Approve enabled despite warnings', async () => {
    mockedUseAuth.mockReturnValue(signedIn());
    mockedFetch.mockResolvedValue({
      ...sampleDetail,
      frontmatter: {
        present: true,
        raw: 'title: "My Post"',
        fields: { title: 'My Post' },
        filenameKnown: true,
        warnings: [
          { code: 'missing-field', field: 'author', message: "Required field 'author' is missing or empty." },
        ],
      },
    });
    renderDetail();

    const warning = await screen.findByText("Required field 'author' is missing or empty.");
    const tabs = screen.getByRole('navigation', { name: 'Post views' });
    expect(
      warning.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  test('renders without the panel when the API sends no frontmatter', async () => {
    mockedUseAuth.mockReturnValue(signedIn());
    mockedFetch.mockResolvedValue(sampleDetail);
    renderDetail();
    await screen.findByText('Final heading');
    expect(screen.queryByText('Frontmatter')).not.toBeInTheDocument();
  });
});

describe('PostDetail — content', () => {
  test('fetches and renders the article', async () => {
    mockedFetch.mockResolvedValue(sampleDetail);
    mockedUseAuth.mockReturnValue(signedIn());
    renderDetail();

    expect(await screen.findByText('My Post')).toBeInTheDocument();
    expect(mockedFetch).toHaveBeenCalledWith('my-post', 'tok');
    expect(
      screen.getByRole('heading', { name: 'Final heading' }),
    ).toBeInTheDocument();
  });

  test('rewrites inline image links to the presigned URL', async () => {
    mockedFetch.mockResolvedValue({
      ...sampleDetail,
      finalMarkdown:
        '# Heading\n\n![a black cat](images/my-post-1.png)\n\n![a ginger cat](images/my-post-2.png)',
    });
    mockedUseAuth.mockReturnValue(signedIn());
    renderDetail();
    await screen.findByText('My Post');

    // Index 1 is ready → presigned URL; index 2 has no generated image →
    // falls back to the repo-hosted copy on the blog CDN.
    expect(screen.getByAltText('a black cat')).toHaveAttribute(
      'src',
      'https://img.test/1.png',
    );
    expect(screen.getByAltText('a ginger cat')).toHaveAttribute(
      'src',
      'https://blog.nakomis.com/images/my-post-2.png',
    );
  });

  test('strips frontmatter from the article preview', async () => {
    mockedFetch.mockResolvedValue({
      ...sampleDetail,
      finalMarkdown:
        '---\ntitle: "My Post"\ntags: ["cats"]\n---\n\n# Heading\n\nBody text.',
    });
    mockedUseAuth.mockReturnValue(signedIn());
    renderDetail();
    await screen.findByText('My Post');

    expect(screen.getByText('Body text.')).toBeInTheDocument();
    expect(screen.queryByText(/tags:/)).not.toBeInTheDocument();
  });

  test('surfaces a load error', async () => {
    mockedFetch.mockRejectedValue(new Error('network down'));
    mockedUseAuth.mockReturnValue(signedIn());
    renderDetail();
    expect(await screen.findByRole('alert')).toHaveTextContent(/network down/);
  });

  test('the Changes tab shows a line diff', async () => {
    mockedFetch.mockResolvedValue(sampleDetail);
    mockedUseAuth.mockReturnValue(signedIn());
    renderDetail();
    await screen.findByText('My Post');

    fireEvent.click(screen.getByRole('button', { name: 'Changes' }));
    expect(
      screen.getByLabelText('Changes from the original draft'),
    ).toBeInTheDocument();
  });

  test('the Reviews tab shows verdicts and the edited badge', async () => {
    mockedFetch.mockResolvedValue(sampleDetail);
    mockedUseAuth.mockReturnValue(signedIn());
    renderDetail();
    await screen.findByText('My Post');

    fireEvent.click(screen.getByRole('button', { name: 'Reviews' }));
    expect(screen.getByText('Tighten the intro.')).toBeInTheDocument();
    expect(screen.getByText('timeout')).toBeInTheDocument();
    expect(screen.getByText('edited')).toBeInTheDocument();
  });

  test('the Images tab renders ready images and placeholders', async () => {
    mockedFetch.mockResolvedValue(sampleDetail);
    mockedUseAuth.mockReturnValue(signedIn());
    renderDetail();
    await screen.findByText('My Post');

    fireEvent.click(screen.getByRole('button', { name: 'Images' }));
    expect(screen.getByAltText('a black cat')).toBeInTheDocument();
    expect(screen.getByText('Generating…')).toBeInTheDocument();
  });
});

describe('PostDetail — actions', () => {
  test('editing and saving writes the draft and reloads', async () => {
    mockedFetch.mockResolvedValue(sampleDetail);
    mockedEdit.mockResolvedValue({
      slug: 'my-post',
      iteration: 3,
      reReview: false,
      status: 'staged',
    });
    mockedUseAuth.mockReturnValue(signedIn());
    renderDetail();
    await screen.findByText('My Post');

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Edit article Markdown'), {
      target: { value: '# Edited' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mockedEdit).toHaveBeenCalledWith('my-post', '# Edited', false, 'tok'),
    );
    expect(await screen.findByText(/Saved as iteration 3/)).toBeInTheDocument();
  });

  test('save & re-review passes the reReview flag', async () => {
    mockedFetch.mockResolvedValue(sampleDetail);
    mockedEdit.mockResolvedValue({
      slug: 'my-post',
      iteration: 3,
      reReview: true,
      status: 'reviewing',
    });
    mockedUseAuth.mockReturnValue(signedIn());
    renderDetail();
    await screen.findByText('My Post');

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save & re-review' }));

    await waitFor(() =>
      expect(mockedEdit).toHaveBeenCalledWith('my-post', expect.any(String), true, 'tok'),
    );
    expect(await screen.findByText(/re-review started/)).toBeInTheDocument();
  });

  test('approving calls the decision API', async () => {
    mockedFetch.mockResolvedValue(sampleDetail);
    mockedDecide.mockResolvedValue({
      slug: 'my-post',
      decision: 'approve',
      status: 'approved',
    });
    mockedUseAuth.mockReturnValue(signedIn());
    renderDetail();
    await screen.findByText('My Post');

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(mockedDecide).toHaveBeenCalledWith('my-post', 'approve', 'tok', 'announce'),
    );
    expect(await screen.findByText('Post approved.')).toBeInTheDocument();
  });

  test("selecting Don't Announce approves with announceBluesky 'skip'", async () => {
    mockedFetch.mockResolvedValue(sampleDetail);
    mockedDecide.mockResolvedValue({
      slug: 'my-post',
      decision: 'approve',
      status: 'approved',
    });
    mockedUseAuth.mockReturnValue(signedIn());
    renderDetail();
    await screen.findByText('My Post');

    fireEvent.change(screen.getByRole('combobox', { name: /Bluesky/ }), {
      target: { value: 'skip' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(mockedDecide).toHaveBeenCalledWith('my-post', 'approve', 'tok', 'skip'),
    );
  });

  test("selecting Force Announce approves with announceBluesky 'force'", async () => {
    mockedFetch.mockResolvedValue(sampleDetail);
    mockedDecide.mockResolvedValue({
      slug: 'my-post',
      decision: 'approve',
      status: 'approved',
    });
    mockedUseAuth.mockReturnValue(signedIn());
    renderDetail();
    await screen.findByText('My Post');

    fireEvent.change(screen.getByRole('combobox', { name: /Bluesky/ }), {
      target: { value: 'force' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(mockedDecide).toHaveBeenCalledWith('my-post', 'approve', 'tok', 'force'),
    );
  });

  test('actions are disabled for a non-staged post', async () => {
    mockedFetch.mockResolvedValue({
      ...sampleDetail,
      post: { ...sampleDetail.post, status: 'approved' },
    });
    mockedUseAuth.mockReturnValue(signedIn());
    renderDetail();
    await screen.findByText('My Post');

    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled();
  });
});

describe('PostDetail — failed posts (PIPE-36)', () => {
  const failedDetail: PostDetailData = {
    ...sampleDetail,
    post: {
      ...sampleDetail.post,
      status: 'failed',
      reviewOutcome: 'exception',
      reviewError: 'Bedrock throttled',
    },
  };

  async function openFailed(detail: PostDetailData = failedDetail) {
    mockedFetch.mockResolvedValue(detail);
    mockedUseAuth.mockReturnValue(signedIn());
    renderDetail();
    await screen.findByText('My Post');
  }

  test('shows the failure reason and enables Edit but not Approve', async () => {
    await openFailed();

    const reason = screen.getByLabelText('Failure reason');
    expect(reason).toHaveTextContent('The review loop hit an error.');
    expect(reason).toHaveTextContent('Bedrock throttled');
    expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });

  test('describes a human rejection', async () => {
    await openFailed({
      ...sampleDetail,
      post: { ...sampleDetail.post, status: 'failed', rejectedAt: '2026-10-01T00:00:00Z' },
    });
    expect(screen.getByLabelText('Failure reason')).toHaveTextContent(
      'Rejected in the bag.',
    );
  });

  test('Edit loads the Markdown, Save stores it and keeps the post failed', async () => {
    mockedFetchFailed.mockResolvedValue({
      slug: 'my-post',
      iteration: 4,
      markdown: '# Latest draft',
      pendingEdit: false,
    });
    mockedSaveFailed.mockResolvedValue({
      slug: 'my-post',
      iteration: 5,
      status: 'failed',
      pendingEdit: true,
    });
    await openFailed();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const editor = await screen.findByLabelText('Edit article Markdown');
    expect(editor).toHaveValue('# Latest draft');
    expect(mockedFetchFailed).toHaveBeenCalledWith('my-post', 'tok');
    expect(
      screen.queryByRole('button', { name: 'Save & re-review' }),
    ).not.toBeInTheDocument();

    fireEvent.change(editor, { target: { value: '# Fixed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mockedSaveFailed).toHaveBeenCalledWith('my-post', '# Fixed', 'tok'),
    );
    expect(await screen.findByText(/Saved as iteration 5/)).toBeInTheDocument();
    expect(mockedEdit).not.toHaveBeenCalled();
    expect(mockedReReview).not.toHaveBeenCalled();
  });

  test('Re-review submits the edited Markdown and reloads', async () => {
    mockedFetchFailed.mockResolvedValue({
      slug: 'my-post',
      iteration: 4,
      markdown: '# Latest draft',
      pendingEdit: false,
    });
    mockedReReview.mockResolvedValue({
      slug: 'my-post',
      iteration: 5,
      status: 'reviewing',
      alreadyStarted: false,
    });
    await openFailed();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(await screen.findByLabelText('Edit article Markdown'), {
      target: { value: '# Better' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Re-review' }));

    await waitFor(() =>
      expect(mockedReReview).toHaveBeenCalledWith('my-post', '# Better', 'tok'),
    );
    expect(
      await screen.findByText('Re-review started from iteration 5.'),
    ).toBeInTheDocument();
    // Initial load plus the reload after re-review.
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  test('says so when the re-review was already under way', async () => {
    mockedFetchFailed.mockResolvedValue({
      slug: 'my-post',
      iteration: 5,
      markdown: '# Saved',
      pendingEdit: true,
    });
    mockedReReview.mockResolvedValue({
      slug: 'my-post',
      iteration: 5,
      status: 'reviewing',
      alreadyStarted: true,
    });
    await openFailed();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await screen.findByLabelText('Edit article Markdown');
    fireEvent.click(screen.getByRole('button', { name: 'Re-review' }));

    expect(await screen.findByText(/already under way/)).toBeInTheDocument();
  });

  test('Re-review is disabled for blank Markdown', async () => {
    mockedFetchFailed.mockResolvedValue({
      slug: 'my-post',
      iteration: 4,
      markdown: '# Latest draft',
      pendingEdit: false,
    });
    await openFailed();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(await screen.findByLabelText('Edit article Markdown'), {
      target: { value: '   ' },
    });
    expect(screen.getByRole('button', { name: 'Re-review' })).toBeDisabled();
  });

  test('surfaces an error loading the Markdown', async () => {
    mockedFetchFailed.mockRejectedValue(new Error('HTTP 409'));
    await openFailed();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 409');
    expect(screen.queryByLabelText('Edit article Markdown')).not.toBeInTheDocument();
  });

  test('surfaces save and re-review errors', async () => {
    mockedFetchFailed.mockResolvedValue({
      slug: 'my-post',
      iteration: 4,
      markdown: '# Latest draft',
      pendingEdit: false,
    });
    mockedSaveFailed.mockRejectedValue(new Error('save broke'));
    mockedReReview.mockRejectedValue(new Error('rereview broke'));
    await openFailed();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await screen.findByLabelText('Edit article Markdown');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('save broke');

    fireEvent.click(screen.getByRole('button', { name: 'Re-review' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('rereview broke'),
    );
  });

  test('keeps earlier failures visible after a re-review', async () => {
    await openFailed({
      ...sampleDetail,
      post: {
        ...sampleDetail.post,
        status: 'reviewing',
        failureHistory: [
          {
            reviewOutcome: 'capped',
            iteration: 4,
            failedAt: '2026-10-01T09:00:00Z',
            clearedAt: '2026-10-02T09:00:00Z',
            reReviewIteration: 5,
          },
          {
            reviewOutcome: 'quorum',
            reviewError: 'only 2 of 4 reviewers',
            clearedAt: '2026-10-03T09:00:00Z',
            reReviewIteration: 9,
          },
        ],
      },
    });

    expect(screen.queryByLabelText('Failure reason')).not.toBeInTheDocument();
    expect(screen.getByText('Previous failures (2)')).toBeInTheDocument();
    expect(
      screen.getByText('Reached the iteration cap without passing review.'),
    ).toBeInTheDocument();
    expect(screen.getByText('only 2 of 4 reviewers')).toBeInTheDocument();
    expect(screen.getByText(/re-reviewed from iteration\s+9/)).toBeInTheDocument();
    // Not failed any more, so not editable here.
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled();
  });
});

describe('PostDetail — link and repo suggestions (PIPE-38)', () => {
  const withSuggestions = (over: Partial<NonNullable<PostDetailData['suggestions']>> = {}): PostDetailData => ({
    ...sampleDetail,
    finalMarkdown: 'I asked the Cabal what it thought.',
    suggestions: {
      version: 1,
      slug: 'my-post',
      iteration: 2,
      generatedAt: 'x',
      status: 'ok',
      models: { chat: 'c', embed: 'e' },
      links: [
        {
          id: 'l1', kind: 'link', anchorText: 'the Cabal', context: '', targetSlug: 's',
          targetTitle: 'Three of Seven AIs', targetUrl: 'https://blog.nakomis.com/s', targetDate: '2026-07-29',
          occurrence: { paragraph: 0, offset: 0 }, reason: 'It refers to the panel review.', decision: 'pending',
        },
      ],
      repos: [
        {
          id: 'r1', kind: 'repo', fullName: 'nakomis/mcps', name: 'mcps', url: 'https://github.com/nakomis/mcps',
          description: null, evidence: 'e', reason: 'r', source: 'llm', decision: 'pending',
        },
      ],
      dropped: [],
      ...over,
    },
  });

  test('highlights the suggested link inline and warns that undecided ones will not be applied', async () => {
    mockedFetch.mockResolvedValue(withSuggestions());
    mockedUseAuth.mockReturnValue(signedIn());
    renderDetail();
    await screen.findByText('My Post');

    expect(screen.getByText('the Cabal').tagName).toBe('MARK');
    expect(screen.getByRole('tooltip')).toHaveTextContent('It refers to the panel review.');
    expect(screen.getByText(/2 suggestions are undecided and will not be applied/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  test('accepting saves the choice and the link now reads as applied on approval', async () => {
    mockedFetch.mockResolvedValue(withSuggestions());
    mockedSetDecisions.mockResolvedValue({} as never);
    mockedUseAuth.mockReturnValue(signedIn());
    renderDetail();
    await screen.findByText('My Post');

    fireEvent.click(within(screen.getByRole('tooltip')).getByRole('button', { name: 'Accept' }));

    await waitFor(() =>
      expect(mockedSetDecisions).toHaveBeenCalledWith('my-post', { l1: 'accepted' }, 'tok'),
    );
    expect(screen.getByRole('link', { name: 'the Cabal' })).toBeInTheDocument();
    expect(screen.getByText(/1 suggestion is undecided/)).toBeInTheDocument();
  });

  test('rolls the choice back and shows the error when saving fails', async () => {
    mockedFetch.mockResolvedValue(withSuggestions());
    mockedSetDecisions.mockRejectedValue(new Error('Failed to save suggestion choice (HTTP 500)'));
    mockedUseAuth.mockReturnValue(signedIn());
    renderDetail();
    await screen.findByText('My Post');

    fireEvent.click(within(screen.getByRole('tooltip')).getByRole('button', { name: 'Reject' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 500');
    await waitFor(() => expect(screen.getByText('the Cabal').tagName).toBe('MARK'));
  });

  test('"Reject all undecided" rejects every pending suggestion in one request', async () => {
    mockedFetch.mockResolvedValue(withSuggestions());
    mockedSetDecisions.mockResolvedValue({} as never);
    mockedUseAuth.mockReturnValue(signedIn());
    renderDetail();
    await screen.findByText('My Post');

    fireEvent.click(screen.getByRole('button', { name: 'Reject all undecided' }));

    await waitFor(() =>
      expect(mockedSetDecisions).toHaveBeenCalledWith(
        'my-post',
        { l1: 'rejected', r1: 'rejected' },
        'tok',
      ),
    );
  });

  test('approval reports what was applied and what was skipped', async () => {
    mockedFetch.mockResolvedValue(withSuggestions());
    mockedDecide.mockResolvedValue({
      slug: 'my-post',
      decision: 'approve',
      status: 'approved',
      applied: { links: 1, repos: 1 },
      skipped: [{ id: 'x', reason: 'the anchor text is no longer in the post' }],
    });
    mockedUseAuth.mockReturnValue(signedIn());
    renderDetail();
    await screen.findByText('My Post');

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(
      await screen.findByText(/Applied 1 link and 1 repo\. 1 accepted link was skipped: the anchor text is no longer/),
    ).toBeInTheDocument();
  });

  test('a failed step is explained and the post is still approvable', async () => {
    mockedFetch.mockResolvedValue({
      ...sampleDetail,
      suggestions: {
        version: 1, slug: 'my-post', iteration: 2, generatedAt: 'x', status: 'error',
        skippedReason: 'error: Bedrock throttled', models: { chat: 'c', embed: 'e' },
        links: [], repos: [], dropped: [],
      },
    });
    mockedUseAuth.mockReturnValue(signedIn());
    renderDetail();
    await screen.findByText('My Post');

    expect(screen.getByText(/the step failed \(error: Bedrock throttled\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  test('stale suggestions are listed rather than highlighted', async () => {
    mockedFetch.mockResolvedValue({ ...withSuggestions(), finalMarkdown: 'The text was rewritten.' });
    mockedUseAuth.mockReturnValue(signedIn());
    renderDetail();
    await screen.findByText('My Post');

    expect(screen.getByText(/will be skipped on approval/)).toBeInTheDocument();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  test('posts without suggestions render exactly as before', async () => {
    mockedFetch.mockResolvedValue({ ...sampleDetail, suggestions: null });
    mockedUseAuth.mockReturnValue(signedIn());
    renderDetail();
    await screen.findByText('My Post');
    expect(screen.queryByText(/suggested/i)).toBeNull();
  });

  test('suggested repos appear in the frontmatter panel and can be accepted there', async () => {
    mockedFetch.mockResolvedValue({
      ...withSuggestions(),
      frontmatter: {
        present: true, raw: 'title: x', filenameKnown: true, warnings: [],
        fields: { title: 'Another title' },
      },
    });
    mockedSetDecisions.mockResolvedValue({} as never);
    mockedUseAuth.mockReturnValue(signedIn());
    renderDetail();
    await screen.findByRole('heading', { name: 'My Post' });

    const panel = screen.getByText('Frontmatter').closest('details') as HTMLElement;
    expect(within(panel).getByRole('link', { name: 'mcps' })).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Accept' }));
    await waitFor(() =>
      expect(mockedSetDecisions).toHaveBeenCalledWith('my-post', { r1: 'accepted' }, 'tok'),
    );
  });
});
