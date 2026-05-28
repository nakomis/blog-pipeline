import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider } from 'react-oidc-context';
import { BrowserRouter, Route, Routes } from 'react-router';
import App from './App';
import LoggedIn from './components/LoggedIn';
import Logout from './components/Logout';
import PostDetail from './components/PostDetail';
import { loadConfig } from './config/config';
import './index.css';

const root = createRoot(document.getElementById('root')!);

loadConfig()
  .then((config) => {
    const oidcConfig = {
      authority: config.cognito.authority,
      client_id: config.cognito.clientId,
      redirect_uri: config.cognito.redirectUri,
      post_logout_redirect_uri: config.cognito.logoutUri,
      response_type: 'code',
      scope: 'openid email profile',
    };

    root.render(
      <StrictMode>
        <AuthProvider {...oidcConfig}>
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<App />} />
              <Route path="/post/:slug" element={<PostDetail />} />
              <Route path="/loggedin" element={<LoggedIn />} />
              <Route path="/logout" element={<Logout />} />
            </Routes>
          </BrowserRouter>
        </AuthProvider>
      </StrictMode>,
    );
  })
  .catch((err: unknown) => {
    root.render(
      <main className="app">
        <h1>Blog Pipeline</h1>
        <p>Failed to load application configuration.</p>
        <pre>{String(err)}</pre>
      </main>,
    );
  });
