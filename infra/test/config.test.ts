import {
  resolveConfig,
  DEPLOYMENT_TRACKER_ACCOUNT_ID,
  DEPLOYMENT_TRACKER_DOMAIN,
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
    expect(DEPLOYMENT_TRACKER_DOMAIN).toBe('tracker.nakomis.com');
  });
});
