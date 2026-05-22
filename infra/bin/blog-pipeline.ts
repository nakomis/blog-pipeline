#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { resolveConfig } from '../lib/config';
import { BlogPipelineStack } from '../lib/blog-pipeline-stack';
import { GithubCiStack } from '../lib/github-ci-stack';

const config = resolveConfig();
const env = { account: config.accountId, region: config.region };

const app = new cdk.App();

new GithubCiStack(app, `BlogPipeline-GithubCi-${config.deployEnv}`, {
  env,
  config,
});

new BlogPipelineStack(app, `BlogPipeline-${config.deployEnv}`, {
  env,
  config,
});

app.synth();
