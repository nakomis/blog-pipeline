import { useAuth } from 'react-oidc-context';
import { Navigate } from 'react-router';

/**
 * OIDC redirect landing route. `AuthProvider` processes the authorization code
 * in the URL; once that settles we send the user back to the dashboard.
 */
export default function LoggedIn() {
  const auth = useAuth();

  if (auth.isLoading) {
    return <p className="app__status">Signing in…</p>;
  }

  return <Navigate to="/" replace />;
}
