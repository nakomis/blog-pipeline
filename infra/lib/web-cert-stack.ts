import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { EnvConfig } from './config';

export interface WebCertStackProps extends cdk.StackProps {
  config: EnvConfig;
}

/**
 * ACM certificate for the pipeline's CloudFront custom domains.
 *
 * CloudFront only accepts certificates from `us-east-1`, so this stack is
 * deployed there and the certificate is consumed cross-region by both
 * `WebStack` (the dashboard) and `ApiStack` (the API distribution). A single
 * certificate covers both names — the web domain, plus the API domain as a SAN.
 *
 * The hosted zone is resolved by name with `HostedZone.fromLookup` — the zone
 * *ID* is never hard-coded.
 */
export class WebCertStack extends cdk.Stack {
  public readonly certificate: acm.ICertificate;

  constructor(scope: Construct, id: string, props: WebCertStackProps) {
    super(scope, id, props);
    const { config } = props;

    const zone = route53.HostedZone.fromLookup(this, 'Zone', {
      domainName: config.hostedZoneName,
    });

    this.certificate = new acm.Certificate(this, 'Certificate', {
      domainName: config.domainName,
      subjectAlternativeNames: [config.apiDomainName],
      validation: acm.CertificateValidation.fromDns(zone),
    });
  }
}
