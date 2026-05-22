import { Navigate } from 'react-router';

/** Post-sign-out landing route — returns the user to the dashboard. */
export default function Logout() {
  return <Navigate to="/" replace />;
}
