import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { AuthContextProps } from 'react-oidc-context';
import { useAuth } from 'react-oidc-context';
import PostDetail from './PostDetail';
import {
  fetchPostDetail,
  editPost,
  decidePost,
  type PostDetail as PostDetailData,
} from '../api/post-detail';

vi.mock('react-oidc-context');
vi.mock('../api/post-detail');

const mockedUseAuth = vi.mocked(useAuth);
const mockedFetch = vi.mocked(fetchPostDetail);
const mockedEdit = vi.mocked(editPost);
const mockedDecide = vi.mocked(decidePost);

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
      expect(mockedDecide).toHaveBeenCalledWith('my-post', 'approve', 'tok'),
    );
    expect(await screen.findByText('Post approved.')).toBeInTheDocument();
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
