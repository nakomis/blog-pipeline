import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { AuthContextProps } from 'react-oidc-context';
import { useAuth } from 'react-oidc-context';
import App, { PIPELINE_STAGES } from './App';
import { fetchPosts, type Post } from './api/posts';

vi.mock('react-oidc-context');
vi.mock('./api/posts');
vi.mock('./config/config', () => ({
  getConfig: () => ({
    env: 'test',
    apiUrl: 'https://api.test',
    cognito: {
      authority: 'https://issuer.test',
      clientId: 'cid',
      domain: 'login.test',
      redirectUri: 'https://app.test/loggedin',
      logoutUri: 'https://app.test/logout',
    },
  }),
}));

const mockedUseAuth = vi.mocked(useAuth);
const mockedFetchPosts = vi.mocked(fetchPosts);

/** Builds an `AuthContextProps` stand-in with sensible signed-out defaults. */
function authState(overrides: Partial<AuthContextProps>): AuthContextProps {
  return {
    isLoading: false,
    isAuthenticated: false,
    error: undefined,
    user: undefined,
    signinRedirect: vi.fn(),
    removeUser: vi.fn(),
    ...overrides,
  } as unknown as AuthContextProps;
}

const signedIn = (overrides: Partial<AuthContextProps> = {}) =>
  authState({
    isAuthenticated: true,
    user: { id_token: 'tok' },
    ...overrides,
  } as Partial<AuthContextProps>);

const samplePosts: Post[] = [
  { slug: 'p1', status: 'queued', title: 'Queued Post', updatedAt: '2026-05-01T00:00:00Z' },
  { slug: 'p2', status: 'published', title: 'Published Post', updatedAt: '2026-05-02T00:00:00Z' },
];

function renderApp() {
  return render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('App — authentication gate', () => {
  test('shows a sign-in screen when signed out', () => {
    mockedUseAuth.mockReturnValue(authState({}));
    renderApp();
    expect(
      screen.getByRole('button', { name: 'Sign in' }),
    ).toBeInTheDocument();
  });

  test('signing in triggers the Cognito redirect', () => {
    const signinRedirect = vi.fn();
    mockedUseAuth.mockReturnValue(authState({ signinRedirect }));
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(signinRedirect).toHaveBeenCalled();
  });

  test('shows a loading notice while auth resolves', () => {
    mockedUseAuth.mockReturnValue(authState({ isLoading: true }));
    renderApp();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  test('shows authentication errors', () => {
    mockedUseAuth.mockReturnValue(
      authState({ error: new Error('boom') as AuthContextProps['error'] }),
    );
    renderApp();
    expect(
      screen.getByText(/Authentication error: boom/),
    ).toBeInTheDocument();
  });
});

describe('App — dashboard', () => {
  test('fetches posts with the ID token and renders every stage column', async () => {
    mockedFetchPosts.mockResolvedValue(samplePosts);
    mockedUseAuth.mockReturnValue(signedIn());
    renderApp();

    expect(await screen.findByText('Queued Post')).toBeInTheDocument();
    expect(screen.getByText('Published Post')).toBeInTheDocument();
    expect(mockedFetchPosts).toHaveBeenCalledWith('tok');

    for (const stage of PIPELINE_STAGES) {
      expect(
        screen.getByRole('heading', {
          level: 2,
          name: new RegExp(stage.label),
        }),
      ).toBeInTheDocument();
    }
  });

  test('shows an empty-state message in each stage when there are no posts', async () => {
    mockedFetchPosts.mockResolvedValue([]);
    mockedUseAuth.mockReturnValue(signedIn());
    renderApp();

    await waitFor(() =>
      expect(screen.getAllByText('No posts yet')).toHaveLength(
        PIPELINE_STAGES.length,
      ),
    );
  });

  test('slots a failed-review post into the Failed review column', async () => {
    mockedFetchPosts.mockResolvedValue([
      {
        slug: 'fp',
        status: 'failed',
        title: 'Failed Post',
        updatedAt: '2026-05-03T00:00:00Z',
      },
    ]);
    mockedUseAuth.mockReturnValue(signedIn());
    renderApp();
    await screen.findByText('Failed Post');

    fireEvent.change(screen.getByLabelText('Filter by stage'), {
      target: { value: 'failed' },
    });
    expect(
      screen.getByRole('heading', { level: 2, name: /Failed review/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('Failed Post')).toBeInTheDocument();
  });

  test('filtering by stage shows only the chosen column', async () => {
    mockedFetchPosts.mockResolvedValue(samplePosts);
    mockedUseAuth.mockReturnValue(signedIn());
    renderApp();
    await screen.findByText('Queued Post');

    fireEvent.change(screen.getByLabelText('Filter by stage'), {
      target: { value: 'published' },
    });

    expect(screen.queryByText('Queued Post')).not.toBeInTheDocument();
    expect(screen.getByText('Published Post')).toBeInTheDocument();
  });

  test('the refresh button refetches posts', async () => {
    mockedFetchPosts.mockResolvedValue(samplePosts);
    mockedUseAuth.mockReturnValue(signedIn());
    renderApp();
    await screen.findByText('Queued Post');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() =>
      expect(mockedFetchPosts).toHaveBeenCalledTimes(2),
    );
  });

  test('surfaces an error when the API call fails', async () => {
    mockedFetchPosts.mockRejectedValue(new Error('network down'));
    mockedUseAuth.mockReturnValue(signedIn());
    renderApp();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /network down/,
    );
  });

  test('signing out clears the OIDC session', async () => {
    const removeUser = vi.fn();
    mockedFetchPosts.mockResolvedValue([]);
    mockedUseAuth.mockReturnValue(signedIn({ removeUser }));
    renderApp();
    await screen.findByRole('button', { name: 'Sign out' });

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(removeUser).toHaveBeenCalled();
  });
});
