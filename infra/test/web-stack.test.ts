import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { WebStack } from '../lib/web-stack';
import { EnvConfig } from '../lib/config';

const sandboxConfig: EnvConfig = {
  deployEnv: 'sandbox',
  accountId: '975050268859',
  region: 'eu-west-2',
  domainName: 'pipeline.blog.sandbox.nakomis.com',
  apiDomainName: 'api.pipeline.blog.sandbox.nakomis.com',
  hostedZoneName: 'sandbox.nakomis.com',
  ssmPrefix: '/blog-pipeline/sandbox',
};

const prodConfig: EnvConfig = {
  deployEnv: 'prod',
  accountId: '637423226886',
  region: 'eu-west-2',
  domainName: 'pipeline.blog.nakomis.com',
  apiDomainName: 'api.pipeline.blog.nakomis.com',
  hostedZoneName: 'nakomis.com',
  ssmPrefix: '/blog-pipeline/prod',
};

function synth(config: EnvConfig): Template {
  const app = new cdk.App();
  const env = { account: config.accountId, region: config.region };
  const stack = new WebStack(app, 'WebStack', {
    env,
    config,
    certificate: acm.Certificate.fromCertificateArn(
      new cdk.Stack(app, 'CertHolder', {
        env: { account: config.accountId, region: 'us-east-1' },
      }),
      'Cert',
      `arn:aws:acm:us-east-1:${config.accountId}:certificate/00000000-0000-0000-0000-000000000000`,
    ),
  });
  return Template.fromStack(stack);
}

describe('WebStack', () => {
  test('creates a private S3 bucket for the SPA', () => {
    synth(sandboxConfig).hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'blog-pipeline-web-975050268859-sandbox',
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('serves the SPA on the custom domain with SPA error rewrites', () => {
    synth(sandboxConfig).hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['pipeline.blog.sandbox.nakomis.com'],
        DefaultRootObject: 'index.html',
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({
            ErrorCode: 403,
            ResponseCode: 200,
            ResponsePagePath: '/index.html',
          }),
          Match.objectLike({
            ErrorCode: 404,
            ResponseCode: 200,
            ResponsePagePath: '/index.html',
          }),
        ]),
      }),
    });
  });

  test('creates A and AAAA alias records', () => {
    const template = synth(sandboxConfig);
    template.hasResourceProperties('AWS::Route53::RecordSet', { Type: 'A' });
    template.hasResourceProperties('AWS::Route53::RecordSet', { Type: 'AAAA' });
  });

  test('publishes bucket and distribution SSM parameters', () => {
    const params = synth(sandboxConfig).findResources('AWS::SSM::Parameter');
    const names = Object.values(params).map((p) => p.Properties.Name);
    expect(names).toEqual(
      expect.arrayContaining([
        '/blog-pipeline/sandbox/web/bucket-name',
        '/blog-pipeline/sandbox/web/distribution-id',
      ]),
    );
  });

  test('sandbox bucket is destroyed, prod bucket is retained', () => {
    synth(sandboxConfig).hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Delete',
    });
    synth(prodConfig).hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
    });
  });
});
