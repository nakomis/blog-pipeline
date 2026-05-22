/**
 * Runtime configuration.
 *
 * The SPA is built once and deployed to several environments, so environment
 * values are not baked into the bundle — they are fetched from `/config.json`
 * at startup. `set-config.sh` generates that file per environment from SSM.
 */

export interface CognitoConfig {
  /** OIDC issuer — `https://cognito-idp.{region}.amazonaws.com/{userPoolId}`. */
  authority: string;
  /** The blog-pipeline app client ID. */
  clientId: string;
  /** Cognito hosted-login domain, used to build the sign-out URL. */
  domain: string;
  /** Where Cognito returns the user after sign-in. */
  redirectUri: string;
  /** Where Cognito returns the user after sign-out. */
  logoutUri: string;
}

export interface AppConfig {
  env: string;
  apiUrl: string;
  cognito: CognitoConfig;
}

let cached: AppConfig | undefined;

/** Fetches the runtime config once; later calls return the cached value. */
export async function loadConfig(): Promise<AppConfig> {
  if (!cached) {
    const response = await fetch('/config.json', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Could not load /config.json (HTTP ${response.status})`);
    }
    cached = (await response.json()) as AppConfig;
  }
  return cached;
}

/** Returns the loaded config. Throws if `loadConfig()` has not resolved yet. */
export function getConfig(): AppConfig {
  if (!cached) {
    throw new Error('App config not loaded — loadConfig() must resolve first');
  }
  return cached;
}
