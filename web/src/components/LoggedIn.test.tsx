import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { AuthContextProps } from 'react-oidc-context';
import { useAuth } from 'react-oidc-context';
import LoggedIn from './LoggedIn';

vi.mock('react-oidc-context');
const mockedUseAuth = vi.mocked(useAuth);

function renderAtLoggedIn() {
  return render(
    <MemoryRouter initialEntries={['/loggedin']}>
      <Routes>
        <Route path="/loggedin" element={<LoggedIn />} />
        <Route path="/" element={<div>Dashboard home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('LoggedIn', () => {
  test('shows a signing-in notice while auth resolves', () => {
    mockedUseAuth.mockReturnValue({
      isLoading: true,
    } as unknown as AuthContextProps);
    renderAtLoggedIn();
    expect(screen.getByText('Signing in…')).toBeInTheDocument();
  });

  test('redirects to the dashboard once auth settles', () => {
    mockedUseAuth.mockReturnValue({
      isLoading: false,
    } as unknown as AuthContextProps);
    renderAtLoggedIn();
    expect(screen.getByText('Dashboard home')).toBeInTheDocument();
  });
});
