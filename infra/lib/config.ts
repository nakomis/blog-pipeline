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
export const DEPLOYMENT_TRACKER_DOMAIN = 'tracker.nakomis.com';

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
