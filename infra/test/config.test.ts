import {
  resolveConfig,
  DEPLOYMENT_TRACKER_ACCOUNT_ID,
  DEPLOYMENT_TRACKER_DOMAIN,
  REVIEW,
  requiredReviewers,
} from '../lib/config';

describe('resolveConfig', () => {
  const original = process.env.NPM_ENVIRONMENT;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.NPM_ENVIRONMENT;
    } else {
      process.env.NPM_ENVIRONMENT = original;
    }
  });

  test('throws when NPM_ENVIRONMENT is unset', () => {
    delete process.env.NPM_ENVIRONMENT;
    expect(() => resolveConfig()).toThrow(/NPM_ENVIRONMENT/);
  });

  test('throws on an unrecognised environment', () => {
    process.env.NPM_ENVIRONMENT = 'staging';
    expect(() => resolveConfig()).toThrow(/NPM_ENVIRONMENT/);
  });

  test('resolves the sandbox account and domain', () => {
    process.env.NPM_ENVIRONMENT = 'sandbox';
    const config = resolveConfig();
    expect(config.accountId).toBe('975050268859');
    expect(config.domainName).toBe('pipeline.blog.sandbox.nakomis.com');
    expect(config.apiDomainName).toBe('api.pipeline.blog.sandbox.nakomis.com');
    expect(config.hostedZoneName).toBe('sandbox.nakomis.com');
    expect(config.ssmPrefix).toBe('/blog-pipeline/sandbox');
  });

  test('resolves the prod account and domain', () => {
    process.env.NPM_ENVIRONMENT = 'prod';
    const config = resolveConfig();
    expect(config.accountId).toBe('637423226886');
    expect(config.domainName).toBe('pipeline.blog.nakomis.com');
    expect(config.apiDomainName).toBe('api.pipeline.blog.nakomis.com');
    expect(config.hostedZoneName).toBe('nakomis.com');
    expect(config.region).toBe('eu-west-2');
  });
});

describe('deployment tracker constants', () => {
  test('point at the prod account and the stable tracker domain', () => {
    expect(DEPLOYMENT_TRACKER_ACCOUNT_ID).toBe('637423226886');
    expect(DEPLOYMENT_TRACKER_DOMAIN).toBe('api.infra.nakomis.com');
  });
});

describe('review loop config', () => {
  test('fans out to the agreed four-model panel (no bedrock)', () => {
    // PIPE-3 panel after the 22 May 2026 bake-off: Opus + Gemini + Grok +
    // GPT-5-pro. Bedrock was deliberately retired but the model id is kept in
    // `REVIEW.models.bedrock` for possible future re-inclusion.
    expect(REVIEW.providers).toEqual([
      'azure',
      'gemini',
      'anthropic',
      'grok',
    ]);
    expect(REVIEW.models.bedrock).toBe('eu.amazon.nova-pro-v1:0');
  });

  test('caps the loop and sets the publishability threshold', () => {
    expect(REVIEW.maxIterations).toBe(4);
    expect(REVIEW.publishabilityThreshold).toBe(8);
  });

  test('requiredReviewers is ceil(2/3 of the providers) — 3 of 4', () => {
    expect(REVIEW.quorum).toBeCloseTo(2 / 3);
    expect(requiredReviewers()).toBe(3);
  });
});
