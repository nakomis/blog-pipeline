import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { EnvConfig } from './config';

export interface WebStackProps extends cdk.StackProps {
  config: EnvConfig;
  /** ACM certificate from `WebCertStack` (us-east-1, consumed cross-region). */
  certificate: acm.ICertificate;
}

/**
 * Static hosting for the dashboard SPA: a private S3 bucket fronted by a
 * CloudFront distribution on the custom domain, with a Route53 alias.
 *
 * The bucket and distribution are exposed so `GithubCiStack` can grant the CI
 * role permission to upload assets and invalidate the cache.
 */
export class WebStack extends cdk.Stack {
  public readonly bucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);
    const { config, certificate } = props;
    const { deployEnv, domainName, hostedZoneName, ssmPrefix } = config;
    const isProd = deployEnv === 'prod';

    this.bucket = new s3.Bucket(this, 'SpaBucket', {
      bucketName: `blog-pipeline-web-${this.account}-${deployEnv}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: isProd
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
    });

    const oac = new cloudfront.S3OriginAccessControl(this, 'OAC', {
      originAccessControlName: `blog-pipeline-${deployEnv}`,
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket, {
          originAccessControl: oac,
        }),
        viewerProtocolPolicy:
          cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: 'index.html',
      // SPA client-side routing: serve index.html for unmatched paths.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
      domainNames: [domainName],
      certificate,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    const zone = route53.HostedZone.fromLookup(this, 'Zone', {
      domainName: hostedZoneName,
    });
    const aliasTarget = route53.RecordTarget.fromAlias(
      new route53Targets.CloudFrontTarget(this.distribution),
    );

    new route53.ARecord(this, 'AliasA', {
      zone,
      recordName: domainName,
      target: aliasTarget,
    });
    new route53.AaaaRecord(this, 'AliasAaaa', {
      zone,
      recordName: domainName,
      target: aliasTarget,
    });

    new ssm.StringParameter(this, 'BucketNameParam', {
      parameterName: `${ssmPrefix}/web/bucket-name`,
      stringValue: this.bucket.bucketName,
      description: `Blog-pipeline SPA S3 bucket (${deployEnv})`,
    });
    new ssm.StringParameter(this, 'DistributionIdParam', {
      parameterName: `${ssmPrefix}/web/distribution-id`,
      stringValue: this.distribution.distributionId,
      description: `Blog-pipeline CloudFront distribution ID (${deployEnv})`,
    });

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: this.distribution.distributionDomainName,
      description: 'CloudFront distribution domain name',
    });
    new cdk.CfnOutput(this, 'SiteUrl', {
      value: `https://${domainName}`,
      description: 'Public URL of the dashboard',
    });
  }
}
