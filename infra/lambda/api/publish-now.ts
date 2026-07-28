import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from 'aws-lambda';
import { requireEnv } from '../review/runtime';
import { corsHeaders, jsonResponse } from './http';

/**
 * `POST /publish-now` (PIPE-14).
 *
 * Publishes on demand every post that a human has approved and whose
 * `publish_date` has arrived, without waiting for the 04:00 UTC cron. It does so
 * by dispatching the `promote-approved` workflow on `blog-content` — the exact
 * action the cron performs — which promotes the approved posts and then triggers
 * blog-app's `scheduled-publish` (rendering anything approved with
 * `publish_date <= today`).
 *
 * The handler is a thin trigger: the "approved AND due" logic lives in the
 * workflow, not here. A GitHub fine-grained PAT (Actions:write on blog-content)
 * is read from Secrets Manager; its value is provisioned out-of-band and never
 * reaches this repo.
 */

const secrets = new SecretsManagerClient({});

// Cached across warm invocations. Cleared on a 401/403 so a rotated or revoked
// token is re-read on the next call rather than failing forever.
let cachedToken: string | undefined;

async function githubToken(): Promise<string> {
  if (cachedToken) {
    return cachedToken;
  }
  const { SecretString } = await secrets.send(
    new GetSecretValueCommand({
      SecretId: requireEnv('GITHUB_DISPATCH_SECRET_ARN'),
    }),
  );
  const token = SecretString?.trim();
  if (!token) {
    throw new Error(
      'GitHub dispatch secret is empty — set its value in Secrets Manager',
    );
  }
  cachedToken = token;
  return token;
}

const DISPATCH_REPO = process.env.DISPATCH_REPO ?? 'nakomis/blog-content';
const DISPATCH_WORKFLOW = process.env.DISPATCH_WORKFLOW ?? 'promote-approved.yml';
const DISPATCH_REF = process.env.DISPATCH_REF ?? 'main';

export async function publishNow(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const cors = corsHeaders(event);

  const token = await githubToken();
  const url = `https://api.github.com/repos/${DISPATCH_REPO}/actions/workflows/${DISPATCH_WORKFLOW}/dispatches`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'blog-pipeline-publish-now',
    },
    body: JSON.stringify({ ref: DISPATCH_REF }),
  });

  // A successful workflow_dispatch returns 204 No Content.
  if (response.status !== 204) {
    if (response.status === 401 || response.status === 403) {
      cachedToken = undefined; // force a fresh read next time
    }
    const detail = await response.text().catch(() => '');
    console.error(`workflow_dispatch failed: ${response.status} ${detail}`);
    return jsonResponse(
      502,
      { message: `Could not trigger publish (GitHub returned ${response.status})` },
      cors,
    );
  }

  return jsonResponse(
    202,
    { dispatched: true, workflow: DISPATCH_WORKFLOW, repo: DISPATCH_REPO },
    cors,
  );
}
