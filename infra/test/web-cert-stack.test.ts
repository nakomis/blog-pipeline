import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { WebCertStack } from '../lib/web-cert-stack';
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

describe('WebCertStack', () => {
  test('creates an ACM certificate for the app domain in us-east-1', () => {
    const app = new cdk.App();
    const stack = new WebCertStack(app, 'WebCertStack', {
      env: { account: sandboxConfig.accountId, region: 'us-east-1' },
      config: sandboxConfig,
    });

    expect(stack.region).toBe('us-east-1');
    Template.fromStack(stack).hasResourceProperties(
      'AWS::CertificateManager::Certificate',
      {
        DomainName: 'pipeline.blog.sandbox.nakomis.com',
        SubjectAlternativeNames: ['api.pipeline.blog.sandbox.nakomis.com'],
      },
    );
  });
});
