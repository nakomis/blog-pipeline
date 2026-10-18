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
  setAffiliateDecisions,
  type AffiliateMention,
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
const mockedSetAffiliates = vi.mocked(setAffiliateDecisions);

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
    expect(screen.getByRole('group', { name: /link suggestion/i })).toHaveTextContent('It refers to the panel review.');
    expect(screen.getByText(/2 suggestions are undecided and will not be applied/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  test('accepting saves the choice and the link now reads as applied on approval', async () => {
    mockedFetch.mockResolvedValue(withSuggestions());
    mockedSetDecisions.mockResolvedValue({} as never);
    mockedUseAuth.mockReturnValue(signedIn());
    renderDetail();
    await screen.findByText('My Post');

    fireEvent.click(within(screen.getByRole('group', { name: /link suggestion/i })).getByRole('button', { name: 'Accept' }));

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

    fireEvent.click(within(screen.getByRole('group', { name: /link suggestion/i })).getByRole('button', { name: 'Reject' }));

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
      await screen.findByText(/Applied 1 link and 1 repo\. 1 link was skipped: the anchor text is no longer/),
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
    expect(screen.queryByRole('group', { name: /link suggestion/i })).toBeNull();
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

  test('Approve waits for pending suggestion saves, so an accept is never missed', async () => {
    mockedFetch.mockResolvedValue(withSuggestions());
    let finishSave: () => void = () => undefined;
    const order: string[] = [];
    mockedSetDecisions.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSave = () => {
            order.push('saved');
            resolve({} as never);
          };
        }),
    );
    mockedDecide.mockImplementation(async () => {
      order.push('decided');
      return { slug: 'my-post', decision: 'approve', status: 'approved' };
    });
    mockedUseAuth.mockReturnValue(signedIn());
    renderDetail();
    await screen.findByText('My Post');

    fireEvent.click(within(screen.getByRole('group', { name: /link suggestion/i })).getByRole('button', { name: 'Accept' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await Promise.resolve();
    expect(mockedDecide).not.toHaveBeenCalled();

    finishSave();
    await waitFor(() => expect(mockedDecide).toHaveBeenCalled());
    expect(order).toEqual(['saved', 'decided']);
  });

  test('Approve is abandoned, with a message, if a choice could not be saved', async () => {
    mockedFetch.mockResolvedValue(withSuggestions());
    mockedSetDecisions.mockRejectedValue(new Error('Failed to save suggestion choice (HTTP 500)'));
    mockedUseAuth.mockReturnValue(signedIn());
    renderDetail();
    await screen.findByText('My Post');

    fireEvent.click(within(screen.getByRole('group', { name: /link suggestion/i })).getByRole('button', { name: 'Accept' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(await screen.findByText(/post was not approved/)).toBeInTheDocument();
    expect(mockedDecide).not.toHaveBeenCalled();
    // The choice was rolled back, and a second attempt is allowed.
    mockedSetDecisions.mockReset();
    mockedDecide.mockResolvedValue({ slug: 'my-post', decision: 'approve', status: 'approved' });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(mockedDecide).toHaveBeenCalledTimes(1));
  });
});

describe('PostDetail — affiliate links (PIPE-41)', () => {
  const AMZ = 'https://www.amazon.co.uk/dp/B0F4D8ZY6L?tag=nakomis-bconn66-21';
  const ARTICLE = 'I printed on the Mars 5 Ultra today.\n\nThen I fitted a magnetic flex plate to it.';
  const m1: AffiliateMention = {
    id: 'a1', kind: 'affiliate', anchorText: 'Mars 5 Ultra', productName: 'Elegoo Mars 5 Ultra',
    quote: 'I printed on the Mars 5 Ultra today.', before: 'on the ', after: ' today.',
    occurrence: { paragraph: 0, offset: 0 }, reason: 'He printed on it.', decision: 'pending',
  };
  const m2: AffiliateMention = {
    id: 'a2', kind: 'affiliate', anchorText: 'magnetic flex plate', productName: 'Flex plate',
    quote: 'Then I fitted a magnetic flex plate to it.', before: 'fitted a ', after: ' to it.',
    occurrence: { paragraph: 1, offset: 0 }, reason: 'He fitted it.', decision: 'pending',
  };
  const detail = (affiliates = [m1, m2], extra: Partial<NonNullable<PostDetailData['suggestions']>> = {}, fm = true): PostDetailData => ({
    ...sampleDetail,
    finalMarkdown: ARTICLE,
    ...(fm
      ? {
          frontmatter: {
            present: true, raw: '', filenameKnown: true, warnings: [],
            fields: { amazon_tracking_id: 'nakomis-bconn66-21' },
          },
        }
      : {}),
    suggestions: {
      version: 1, slug: 'my-post', iteration: 2, generatedAt: 'x', status: 'skipped',
      skippedReason: 'no-embeddings-index', models: { chat: 'c', embed: 'e' },
      links: [], repos: [], dropped: [], affiliates, affiliatesStatus: 'ok', ...extra,
    },
  });
  const open = async () => {
    mockedUseAuth.mockReturnValue(signedIn());
    renderDetail();
    await screen.findByText('My Post');
  };
  const tab = () => screen.getByRole('button', { name: /Affiliate links/ });

  test('the tab shows how many mentions still need a decision', async () => {
    mockedFetch.mockResolvedValue(detail());
    await open();
    expect(tab()).toHaveTextContent('Affiliate links (2)');
  });

  test('there is no tab when no step ran or nothing was found', async () => {
    mockedFetch.mockResolvedValue(detail([]));
    await open();
    expect(screen.queryByRole('button', { name: /Affiliate links/ })).not.toBeInTheDocument();
  });

  test('there is no tab for posts without suggestions', async () => {
    mockedFetch.mockResolvedValue(sampleDetail);
    await open();
    expect(screen.queryByRole('button', { name: /Affiliate links/ })).not.toBeInTheDocument();
  });

  test('opening it highlights the mentions and lists a row for each', async () => {
    mockedFetch.mockResolvedValue(detail());
    await open();
    fireEvent.click(tab());
    expect(document.querySelectorAll('mark[data-affiliate-id]')).toHaveLength(2);
    expect(screen.getAllByLabelText(/SiteStripe link for/)).toHaveLength(2);
    expect(screen.getAllByText('Affiliate link needed')).toHaveLength(2);
    expect(screen.getByText(/\(from the source file\)/)).toBeInTheDocument();
  });

  test('pasting a link and pressing Enter saves it and shows it as linked', async () => {
    mockedFetch.mockResolvedValue(detail());
    mockedSetAffiliates.mockResolvedValue({
      suggestions: detail([{ ...m1, decision: 'linked', url: AMZ, warnings: [] }, m2]).suggestions!,
      results: { a1: { ok: true, warnings: [] } },
    });
    await open();
    fireEvent.click(tab());
    const [first] = screen.getAllByLabelText(/SiteStripe link for/);
    fireEvent.change(first, { target: { value: AMZ } });
    fireEvent.keyDown(first, { key: 'Enter' });

    await waitFor(() =>
      expect(mockedSetAffiliates).toHaveBeenCalledWith(
        'my-post',
        { decisions: { a1: { action: 'link', url: AMZ } } },
        'tok',
      ),
    );
    expect(await screen.findByText('Linked')).toBeInTheDocument();
    expect(tab()).toHaveTextContent('Affiliate links (1)');
  });

  test('a link the server refuses stays in the box with the reason', async () => {
    mockedFetch.mockResolvedValue(detail());
    mockedSetAffiliates.mockResolvedValue({
      suggestions: detail().suggestions!,
      results: { a1: { ok: false, error: "That is a short link. Use SiteStripe's Full link." } },
    });
    await open();
    fireEvent.click(tab());
    const [first] = screen.getAllByLabelText(/SiteStripe link for/);
    fireEvent.change(first, { target: { value: 'https://amzn.to/x' } });
    fireEvent.keyDown(first, { key: 'Enter' });
    expect(await screen.findByText(/Use SiteStripe's Full link/)).toBeInTheDocument();
    expect(first).toHaveValue('https://amzn.to/x');
  });

  test('Skip sends a skip, and Undo resets', async () => {
    mockedFetch.mockResolvedValue(detail());
    mockedSetAffiliates.mockResolvedValue({
      suggestions: detail([{ ...m1, decision: 'skipped' }, m2]).suggestions!,
      results: { a1: { ok: true, warnings: [] } },
    });
    await open();
    fireEvent.click(tab());
    fireEvent.click(screen.getAllByRole('button', { name: 'Skip' })[0]);
    await waitFor(() =>
      expect(mockedSetAffiliates).toHaveBeenCalledWith('my-post', { decisions: { a1: { action: 'skip' } } }, 'tok'),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(mockedSetAffiliates).toHaveBeenLastCalledWith('my-post', { decisions: { a1: { action: 'reset' } } }, 'tok'),
    );
  });

  test('Skip all remaining sends one request', async () => {
    mockedFetch.mockResolvedValue(detail());
    mockedSetAffiliates.mockResolvedValue({
      suggestions: detail([{ ...m1, decision: 'skipped' }, { ...m2, decision: 'skipped' }]).suggestions!,
      results: {},
    });
    await open();
    fireEvent.click(tab());
    fireEvent.click(screen.getByRole('button', { name: /Skip all remaining \(2\)/ }));
    await waitFor(() =>
      expect(mockedSetAffiliates).toHaveBeenCalledWith('my-post', { skipRemaining: true }, 'tok'),
    );
    expect(await screen.findAllByText('Skipped')).toHaveLength(2);
    expect(screen.queryByText(/mentions? (had|have) no affiliate link decision/)).not.toBeInTheDocument();
  });

  test('once every mention is decided, focus moves to Approve', async () => {
    mockedFetch.mockResolvedValue(detail([m1]));
    mockedSetAffiliates.mockResolvedValue({
      suggestions: detail([{ ...m1, decision: 'linked', url: AMZ, warnings: [] }]).suggestions!,
      results: { a1: { ok: true, warnings: [] } },
    });
    await open();
    fireEvent.click(tab());
    const [first] = screen.getAllByLabelText(/SiteStripe link for/);
    fireEvent.change(first, { target: { value: AMZ } });
    fireEvent.keyDown(first, { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toHaveFocus());
  });

  test('Skip all remaining also ends on Approve, but not if the request fails', async () => {
    mockedFetch.mockResolvedValue(detail());
    mockedSetAffiliates.mockRejectedValueOnce(new Error('Failed to save affiliate choice (HTTP 500)'));
    await open();
    fireEvent.click(tab());
    fireEvent.click(screen.getByRole('button', { name: /Skip all remaining/ }));
    await screen.findByText(/HTTP 500/);
    expect(screen.getByRole('button', { name: 'Approve' })).not.toHaveFocus();
    mockedSetAffiliates.mockResolvedValue({
      suggestions: detail([{ ...m1, decision: 'skipped' }, { ...m2, decision: 'skipped' }]).suggestions!,
      results: {},
    });
    fireEvent.click(screen.getByRole('button', { name: /Skip all remaining/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toHaveFocus());
  });

  test('a failed request is shown on the row and does not break the page', async () => {
    mockedFetch.mockResolvedValue(detail());
    mockedSetAffiliates.mockRejectedValue(new Error('Failed to save affiliate choice (HTTP 500)'));
    await open();
    fireEvent.click(tab());
    const [first] = screen.getAllByLabelText(/SiteStripe link for/);
    fireEvent.change(first, { target: { value: AMZ } });
    fireEvent.keyDown(first, { key: 'Enter' });
    expect(await screen.findByText(/HTTP 500/)).toBeInTheDocument();
  });

  test('with no tracking id in the source, one can be typed', async () => {
    mockedFetch.mockResolvedValue(detail([m1, m2], {}, false));
    mockedSetAffiliates.mockResolvedValue({
      suggestions: detail([m1, m2], { trackingId: 'nakomis-bconn66-21' }, false).suggestions!,
      results: {},
      trackingId: { ok: true },
    });
    await open();
    fireEvent.click(tab());
    fireEvent.change(screen.getByLabelText('Per-post tracking ID'), { target: { value: 'nakomis-bconn66-21' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use this ID' }));
    await waitFor(() =>
      expect(mockedSetAffiliates).toHaveBeenCalledWith('my-post', { trackingId: 'nakomis-bconn66-21' }, 'tok'),
    );
    expect(await screen.findByText(/entered here/)).toBeInTheDocument();
  });

  test('undecided mentions are warned about, and never block approval', async () => {
    mockedFetch.mockResolvedValue(detail());
    mockedDecide.mockResolvedValue({ slug: 'my-post', decision: 'approve', status: 'approved' });
    await open();
    expect(screen.getByText(/2 product mentions have no affiliate link decision/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(mockedDecide).toHaveBeenCalled());
  });

  test('no warning once every mention is decided', async () => {
    mockedFetch.mockResolvedValue(detail([{ ...m1, decision: 'linked', url: AMZ }, { ...m2, decision: 'skipped' }]));
    await open();
    expect(screen.queryByText(/no affiliate link decision/)).not.toBeInTheDocument();
  });

  test('warns when links are pasted but the post has no tracking id', async () => {
    mockedFetch.mockResolvedValue(detail([{ ...m1, decision: 'linked', url: AMZ }, m2], {}, false));
    await open();
    expect(screen.getByText(/no amazon_tracking_id/i)).toBeInTheDocument();
  });

  test('approval reports affiliate links written and the server warnings', async () => {
    mockedFetch.mockResolvedValue(detail([{ ...m1, decision: 'linked', url: AMZ }, { ...m2, decision: 'skipped' }]));
    mockedDecide.mockResolvedValue({
      slug: 'my-post', decision: 'approve', status: 'approved',
      applied: { links: 0, repos: 0, affiliates: 1 }, skipped: [],
      warnings: ['This post has no amazon_tracking_id, so its links earn under nakomis-21.'],
    });
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(/Applied 0 links, 0 repos and 1 affiliate link\./)).toBeInTheDocument();
    expect(screen.getByText(/earn under nakomis-21/)).toBeInTheDocument();
  });

  test('a failed affiliate step is explained', async () => {
    mockedFetch.mockResolvedValue(detail([], { affiliatesStatus: 'error', affiliatesReason: 'error: overloaded' }));
    await open();
    expect(screen.getByText(/affiliate step failed \(error: overloaded\)/i)).toBeInTheDocument();
  });

  test('the tab is read-only once the post is no longer staged', async () => {
    mockedFetch.mockResolvedValue({ ...detail(), post: { ...sampleDetail.post, status: 'approved' } });
    await open();
    fireEvent.click(tab());
    expect(screen.queryByLabelText(/SiteStripe link for/)).not.toBeInTheDocument();
    expect(screen.getAllByText('Affiliate link needed')).toHaveLength(2);
  });
});
