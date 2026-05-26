/**
 * Environment configuration for the blog-pipeline CDK app.
 *
 * Every environment-specific value (account, domain, SSM prefix) is resolved
 * here from the `NPM_ENVIRONMENT` variable — nothing is hard-coded in the
 * stacks themselves.
 */

export type DeployEnv = 'sandbox' | 'prod';

export interface EnvConfig {
  /** Short environment key — `sandbox` or `prod`. */
  deployEnv: DeployEnv;
  /** AWS account the stacks deploy into. */
  accountId: string;
  /** AWS region — the same for every environment. */
  region: string;
  /** Public domain the pipeline web UI is served from. */
  domainName: string;
  /** Public domain the dashboard API is served from (CloudFront → API Gateway). */
  apiDomainName: string;
  /**
   * Domain name of the Route53 hosted zone the web UI's record lives in.
   *
   * Only the (stable) zone name is configured here — the zone *ID* is resolved
   * at synth time with `route53.HostedZone.fromLookup`, never hard-coded.
   */
  hostedZoneName: string;
  /** Prefix for SSM parameters owned by this environment. */
  ssmPrefix: string;
}

const REGION = 'eu-west-2';

const CONFIG: Record<DeployEnv, EnvConfig> = {
  sandbox: {
    deployEnv: 'sandbox',
    accountId: '975050268859',
    region: REGION,
    domainName: 'pipeline.blog.sandbox.nakomis.com',
    apiDomainName: 'api.pipeline.blog.sandbox.nakomis.com',
    hostedZoneName: 'sandbox.nakomis.com',
    ssmPrefix: '/blog-pipeline/sandbox',
  },
  prod: {
    deployEnv: 'prod',
    accountId: '637423226886',
    region: REGION,
    domainName: 'pipeline.blog.nakomis.com',
    apiDomainName: 'api.pipeline.blog.nakomis.com',
    hostedZoneName: 'nakomis.com',
    ssmPrefix: '/blog-pipeline/prod',
  },
};

/**
 * The deployment tracker (CLOUD-15) is a single REST API in the prod account,
 * reached cross-account over SigV4 at a stable custom domain. CI records every
 * blog-pipeline deployment to it — see `scripts/record-deployment.sh`.
 */
export const DEPLOYMENT_TRACKER_ACCOUNT_ID = CONFIG.prod.accountId;
export const DEPLOYMENT_TRACKER_DOMAIN = 'api.infra.nakomis.com';

/**
 * The GitHub repository whose `push` events trigger the review pipeline
 * (PIPE-2). The trigger role's OIDC trust policy is scoped to this repo on
 * `refs/heads/main` — only pushes to that ref from this repo can assume the
 * role.
 */
export const BLOG_CONTENT_REPO = 'nakomis/blog-content';

/**
 * Cloud review loop (PIPE-3) tuning.
 *
 * These are stable product constants, not environment-specific values — the
 * model ids and loop thresholds are identical in sandbox and prod, so they live
 * here rather than in SSM. The Azure deployment name is the one exception: it is
 * account-specific and lives in the Azure reviewer secret.
 */
export const REVIEW = {
  /**
   * Reviewer providers, fanned out in parallel by the state machine.
   *
   * The agreed best-in-field panel from the 22 May 2026 Cabal bake-off:
   * Opus (Anthropic) + Gemini 3 Pro + Grok-4 (on Azure AI Foundry) + GPT-5-pro
   * (on Azure OpenAI). The Bedrock `nova-pro` reviewer was deliberately dropped
   * — the sub-cent Bedrock chat models rubber-stamped posts and a confidently
   * wrong "looks fine" is worse than no review. The Bedrock provider code and
   * model id are retained below in case we want to flip it back in later (and
   * because the redrafter still runs on Bedrock anyway).
   */
  providers: ['azure', 'gemini', 'anthropic', 'grok'] as const,
  /** Minimum publishability score (out of 10) for a clean pass. */
  publishabilityThreshold: 8,
  /** Hard cap on review iterations before the post is failed as `capped`. */
  maxIterations: 4,
  /**
   * Fraction of configured providers that must return a usable verdict for the
   * gate to trust the result: `ceil(quorum × providers.length)` reviewers are
   * required — `ceil(2/3 × 4) = 3`. A fraction (not a hard count) so it
   * rescales automatically if a provider is added or removed.
   */
  quorum: 2 / 3,
  /**
   * Model ids per provider. The Bedrock id uses the `eu.` cross-region
   * inference profile (eu-west-2 is in the EU geo); the Anthropic id is a
   * direct-API id. Azure's deployment name and Grok's deployment name are
   * account-specific and live in their respective reviewer SSM parameters.
   * `bedrock` is retained for possible future re-inclusion.
   */
  models: {
    bedrock: 'eu.amazon.nova-pro-v1:0',
    // Gemini 3 Pro per the 22 May 2026 Cabal bake-off panel. The model ID the
    // Google v1beta API actually accepts is `gemini-3-pro-preview` — Cabal
    // aliases it as `gemini-3-pro` internally and remaps. An earlier draft of
    // this config had `gemini-2.0-flash` (retired by Google for new users); a
    // first fix to `gemini-3-pro` failed with `models/gemini-3-pro is not
    // found for API version v1beta`, which led us here.
    gemini: 'gemini-3-pro-preview',
    anthropic: 'claude-opus-4-7',
  },
  /** Claude Sonnet on Bedrock redrafts the post between iterations. */
  redraftModel: 'eu.anthropic.claude-sonnet-4-6',
} as const;

/** A reviewer provider id — one of `REVIEW.providers`. */
export type ReviewProvider = (typeof REVIEW.providers)[number];

/**
 * Number of reviewers that must return a usable verdict for the gate to reach a
 * trustworthy decision — `ceil(REVIEW.quorum × providers)`.
 */
export function requiredReviewers(): number {
  return Math.ceil(REVIEW.quorum * REVIEW.providers.length);
}

/**
 * Resolve the configuration for the current deploy environment.
 *
 * @throws if `NPM_ENVIRONMENT` is unset or not one of `sandbox` | `prod`.
 */
export function resolveConfig(): EnvConfig {
  const env = process.env.NPM_ENVIRONMENT;
  if (env !== 'sandbox' && env !== 'prod') {
    throw new Error(
      `NPM_ENVIRONMENT must be set to 'sandbox' or 'prod' (got: ${env ?? 'unset'})`,
    );
  }
  return CONFIG[env];
}
