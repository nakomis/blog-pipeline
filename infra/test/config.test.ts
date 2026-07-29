import {
  resolveConfig,
  DEPLOYMENT_TRACKER_ACCOUNT_ID,
  DEPLOYMENT_TRACKER_DOMAIN,
  BLOG_CONTENT_REPO,
  REVIEW,
  requiredReviewers,
} from '../lib/config';
import { decideGate } from '../lambda/review/gate';

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

describe('trigger constants', () => {
  test('BLOG_CONTENT_REPO names the source repo for the trigger role', () => {
    expect(BLOG_CONTENT_REPO).toBe('nakomis/blog-content');
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

  test('requiredReviewers is ceil(2/3 of the providers) — 3 of 4', () => {
    expect(REVIEW.quorum).toBeCloseTo(2 / 3);
    expect(requiredReviewers()).toBe(3);
  });
});

/**
 * Review-gate tripwire (PIPE-26).
 *
 * `publishabilityThreshold`, `maxIterations` and `quorum` are the three numbers
 * that decide what actually gets published. Each is a one-character edit in
 * `config.ts`, and a one-character edit that weakens the gate looks identical in
 * review to one that tightens it.
 *
 * The risk isn't the day the gate blocks too much. It's the quiet recalibration
 * afterwards — nudging the threshold from 8 to 7 at eleven at night to get a
 * post you like through, at which point the panel is tuned to accommodate its
 * weakest member and is worth less than the single best reviewer would have been.
 *
 * So these are pinned deliberately, and the pins are the point: changing what
 * gets published now costs a two-file diff with a test named after the thing
 * being weakened. **If one of these tests fails, do not just update the number —
 * justify the change in the PR description.**
 *
 * The last test ties each constant to its consequence, so none of them can rot
 * into a value nothing reads.
 */
describe('review gate tripwire', () => {
  test('publishability threshold is 8 of 10 — every reviewer must clear it', () => {
    expect(REVIEW.publishabilityThreshold).toBe(8);
  });

  test('the loop is capped at 4 iterations', () => {
    // Raising the cap is not free: each extra iteration redrafts the post
    // further towards the reviewers' collective taste and away from the
    // author's, so a higher number trades voice for score.
    expect(REVIEW.maxIterations).toBe(4);
  });

  test('quorum is 2/3 of the panel, so two outages cannot become a one-model gate', () => {
    expect(REVIEW.quorum).toBeCloseTo(2 / 3);
    expect(requiredReviewers()).toBe(3);
  });

  test('the constants are the ones the gate actually enforces', () => {
    const at = (score: number) =>
      [...REVIEW.providers].map((provider) => ({
        provider,
        status: 'ok' as const,
        score,
        blocker: false,
        critique: 'c',
      }));

    // One point below the threshold must not pass, at any iteration. If this
    // starts passing, the threshold has been lowered.
    const below = REVIEW.publishabilityThreshold - 1;
    expect(decideGate({ reviews: at(below), iteration: 1 }).decision).toBe('loop');
    expect(
      decideGate({ reviews: at(below), iteration: REVIEW.maxIterations }).decision,
    ).toBe('fail-capped');

    // Exactly at the threshold must pass — the bar is inclusive.
    expect(
      decideGate({ reviews: at(REVIEW.publishabilityThreshold), iteration: 1 })
        .decision,
    ).toBe('pass');

    // A single blocker vetoes a full-marks panel: the blocker flag is not
    // advisory, and softening it is as consequential as lowering the score.
    const perfect = at(10);
    expect(
      decideGate({
        reviews: [{ ...perfect[0], blocker: true }, ...perfect.slice(1)],
        iteration: 1,
      }).decision,
    ).toBe('loop');

    // The gate takes the minimum, not the mean — one dissenting reviewer is
    // enough. A switch to averaging would silently restore majority rule.
    const split = [
      { ...perfect[0], score: below },
      ...perfect.slice(1),
    ];
    expect(decideGate({ reviews: split, iteration: 1 }).decision).toBe('loop');
  });
});
