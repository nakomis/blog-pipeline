#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { resolveConfig } from '../lib/config';
import { BlogPipelineStack } from '../lib/blog-pipeline-stack';
import { ApiStack } from '../lib/api-stack';
import { WebCertStack } from '../lib/web-cert-stack';
import { WebStack } from '../lib/web-stack';
import { GithubCiStack } from '../lib/github-ci-stack';
import { BlogPipelineReviewStack } from '../lib/blog-pipeline-review-stack';
import { BlogPipelineTriggerStack } from '../lib/blog-pipeline-trigger-stack';

const config = resolveConfig();
const env = { account: config.accountId, region: config.region };
// CloudFront certificates must live in us-east-1.
const usEast1Env = { account: config.accountId, region: 'us-east-1' };

const app = new cdk.App();

// The deployment version is tracked out-of-band by the deployment tracker
// (CLOUD-15); it deliberately is NOT applied as a per-resource tag, because
// bumping a tag on every push forces CloudFormation to update every taggable
// resource (CloudFront, Lambdas, IAM roles, …) on a no-op deploy. See
// docs/cdk-deploy-investigation.md (PIPE-8).
cdk.Tags.of(app).add('MH-Project', 'blog-pipeline');

const dataStack = new BlogPipelineStack(
  app,
  `BlogPipeline-${config.deployEnv}`,
  { env, config },
);

// The us-east-1 certificate is consumed cross-region by both the API and the
// web CloudFront distributions, so the cert stack is created first.
const webCertStack = new WebCertStack(
  app,
  `BlogPipeline-WebCert-${config.deployEnv}`,
  { env: usEast1Env, config, crossRegionReferences: true },
);

// The review loop (PIPE-3) — Step Functions, reviewer Lambdas and the drafts
// bucket. Reads and writes the posts table owned by the data stack. Created
// before the API stack, which consumes its drafts bucket for the image
// callback (PIPE-6).
const reviewStack = new BlogPipelineReviewStack(
  app,
  `BlogPipeline-Review-${config.deployEnv}`,
  {
    env,
    config,
    postsTable: dataStack.postsTable,
    imageJobsTable: dataStack.imageJobsTable,
  },
);

new ApiStack(app, `BlogPipeline-Api-${config.deployEnv}`, {
  env,
  config,
  postsTable: dataStack.postsTable,
  draftsBucket: reviewStack.draftsBucket,
  imageJobsTable: dataStack.imageJobsTable,
  certificate: webCertStack.certificate,
  crossRegionReferences: true,
});

// The trigger (PIPE-2) — one IAM role assumed via OIDC by the blog-content
// GitHub Actions workflow to start the review pipeline. Created in both
// environments for parity; the workflow itself currently only targets prod.
new BlogPipelineTriggerStack(
  app,
  `BlogPipeline-Trigger-${config.deployEnv}`,
  {
    env,
    config,
    postsTable: dataStack.postsTable,
    stateMachine: reviewStack.stateMachine,
  },
);

const webStack = new WebStack(app, `BlogPipeline-Web-${config.deployEnv}`, {
  env,
  config,
  certificate: webCertStack.certificate,
  crossRegionReferences: true,
});

new GithubCiStack(app, `BlogPipeline-GithubCi-${config.deployEnv}`, {
  env,
  config,
  webBucket: webStack.bucket,
  webDistribution: webStack.distribution,
});

app.synth();
