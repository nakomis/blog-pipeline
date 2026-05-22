#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { resolveConfig } from '../lib/config';
import { BlogPipelineStack } from '../lib/blog-pipeline-stack';
import { ApiStack } from '../lib/api-stack';
import { WebCertStack } from '../lib/web-cert-stack';
import { WebStack } from '../lib/web-stack';
import { GithubCiStack } from '../lib/github-ci-stack';

const config = resolveConfig();
const env = { account: config.accountId, region: config.region };
// CloudFront certificates must live in us-east-1.
const usEast1Env = { account: config.accountId, region: 'us-east-1' };

const app = new cdk.App();

const dataStack = new BlogPipelineStack(
  app,
  `BlogPipeline-${config.deployEnv}`,
  { env, config },
);

new ApiStack(app, `BlogPipeline-Api-${config.deployEnv}`, {
  env,
  config,
  postsTable: dataStack.postsTable,
});

const webCertStack = new WebCertStack(
  app,
  `BlogPipeline-WebCert-${config.deployEnv}`,
  { env: usEast1Env, config, crossRegionReferences: true },
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
