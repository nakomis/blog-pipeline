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
 * Public origin of the blog itself (no trailing slash). A post's `canonical`
 * frontmatter is expected to be `${BLOG_BASE_URL}/<filename-without-.md>`; the
 * bag's frontmatter panel (PIPE-37) warns when it is not. Posts in every
 * environment carry the production canonical, so this does not vary by env.
 */
export const BLOG_BASE_URL = 'https://blog.nakomis.com';

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
    // Stable alias that auto-tracks Google's current best Pro Gemini, chosen
    // after three rounds of preview-treadmill failures on this line:
    //   `gemini-2.0-flash`     — retired for new users (first live e2e fail)
    //   `gemini-3-pro`         — not a wire-format model id on v1beta
    //   `gemini-3-pro-preview` — "no longer available, use a newer model"
    // (`gemini-3.1-pro-preview` would be the explicit current Pro, but it's
    // -preview so we'd be back here in 3–6 months. The alias is more robust at
    // the cost of letting Google silently change which model serves it.) The
    // Cabal bake-off agreed on "Gemini 3 Pro" — `gemini-pro-latest` honours
    // the spirit of that without chasing rename treadmills.
    gemini: 'gemini-pro-latest',
    anthropic: 'claude-opus-4-7',
  },
  /** Claude Sonnet on Bedrock redrafts the post between iterations. */
  redraftModel: 'eu.anthropic.claude-sonnet-4-6',
} as const;

/**
 * Image generation (PIPE-6).
 *
 * `{{image}}` placeholders in a draft are illustrated by fal.ai's FLUX model,
 * generated concurrently with the review loop. Like `REVIEW`, the model id and
 * dimensions are stable product constants (identical in sandbox and prod), so
 * they live here rather than in SSM. The fal API key is the one account-specific
 * value and lives in the `${ssmPrefix}/image/fal` parameter.
 */
export const IMAGE = {
  /** Default fal.ai model slug, used when a tag names no model (or an unknown one). */
  model: 'fal-ai/flux-2-pro',
  /**
   * Models a `{{image model="…"}}` tag may name, mapped to fal endpoints
   * (PIPE-27). The choice is editorial — made by the author while writing the
   * tag — from the 2026-07-29 comparison: pro is the house default for
   * cinematic illustration, max the fidelity upgrade at 2.3× the cost,
   * gpt-image-2 the only model that renders readable labels, recraft the flat
   * vector option. An unknown name falls back to `model` rather than failing
   * the review.
   */
  models: {
    'flux-2-pro': 'fal-ai/flux-2-pro',
    'flux-2-max': 'fal-ai/flux-2-max',
    'gpt-image-2': 'fal-ai/gpt-image-2',
    recraft: 'fal-ai/recraft/v4/text-to-image',
  },
  /** Output dimensions — 3:2 landscape, matching the blog's hero images. */
  width: 1216,
  height: 832,
  /**
   * Credit early warning (PIPE-34), all in USD. `image-submit` warns over the
   * alerts topic once the remaining fal credit drops below `warnThresholdUsd`.
   * Without a fal admin key the remaining credit is estimated as
   * `monthlyBudgetUsd − generations this month × costPerImageUsd`.
   */
  credit: {
    warnThresholdUsd: 5,
    monthlyBudgetUsd: 25,
    costPerImageUsd: 0.06,
  },
} as const;

/**
 * Link and repo suggestions (PIPE-38).
 *
 * After the review loop passes, a best-effort step proposes links to earlier
 * posts and `repos:` entries for the bag. Haiku only *chooses* from lists the
 * code builds; it never writes a URL. The embedding settings must match
 * `blog-app/scripts/ingest-blog.py`, which writes the index this step reads.
 */
export const LINKS = {
  /**
   * Claude Haiku via the direct Anthropic API, with the same key as the Opus
   * reviewer (`${ssmPrefix}/reviewer/anthropic`). Not Bedrock: AWS refuses
   * `anthropic.claude-haiku-5-5` for these accounts.
   */
  model: 'claude-haiku-5-5',
  /** Titan Embed Text v2 — must match the model that built the index. */
  embedModel: 'amazon.titan-embed-text-v2:0',
  /** Dimensions of the index vectors — a different length means an incompatible index. */
  embedDims: 1024,
  /** Region Titan is called in (where ingest-blog.py and the search Lambda call it). */
  embedRegion: 'us-east-1',
  /** Object key of the embeddings index in the nakom.is private bucket. */
  embeddingsKey: 'blog-embeddings.json',
  retrieval: {
    /** Window size, matching the index's 700-character chunks. */
    windowChars: 700,
    /** Upper bound on windows embedded per post (cost guard). */
    maxWindows: 80,
    /** Candidate posts handed to Haiku. */
    topPosts: 8,
    /**
     * Minimum chunk-to-chunk cosine similarity for a candidate. Calibrated on
     * 18 Oct 2026 against the prod index: seven known cross-links scored
     * 0.49 to 0.80 (median about 0.6), whilst the Cabal post scored 0.31
     * (rank 28 of 43) against the Alexa announce post it must not be linked from.
     */
    floor: 0.45,
    /** Fewer candidates than this triggers the catalogue fallback. */
    minCandidates: 3,
    /** Evidence passages kept per candidate. */
    evidencePerPost: 2,
  },
  /** Give Haiku every eligible post (title + excerpt) when retrieval finds too few. */
  catalogueFallback: true,
  /** At most one new link per this many words (minimum one per post). */
  wordsPerLink: 300,
  /** Upper bound on link suggestions per post, whatever its length. */
  maxLinks: 10,
  /** Upper bound on repo suggestions per post. */
  maxRepos: 5,
  /** Forks are rarely what a post is about. */
  excludeForks: true,
  /** Hard stop for the Lambda task inside the state machine (seconds). */
  taskTimeoutSeconds: 150,
} as const;

/**
 * Name of the nakom.is private bucket that holds `blog-embeddings.json`.
 * Derived exactly as `nakom.is/lib/deploy-env.ts` does (`envSuffix`).
 */
export function privateBucketName(deployEnv: DeployEnv): string {
  return `nakom.is-private${deployEnv === 'prod' ? '' : '-sandbox'}`;
}

/** GitHub owners whose public repos may be suggested — the owner of `BLOG_CONTENT_REPO`. */
export function githubOwners(): string[] {
  return [BLOG_CONTENT_REPO.split('/')[0]];
}

/** Name of the failure-alerts SNS topic (PIPE-15) — fixed so ARNs derive from it. */
export function alertsTopicName(deployEnv: DeployEnv): string {
  return `blog-pipeline-alerts-${deployEnv}`;
}

/** The object the promote workflow writes for BD-1's queue row (HOME-502). */
export const BLOG_QUEUE_KEY = 'blog-queue.json';

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
