/**
 * Seeds the posts table with sample data so the dashboard has something to
 * show before the review loop (PIPE-2/3) exists to populate it for real.
 *
 *   AWS_PROFILE=nakom.is-sandbox npm run seed-sandbox
 *   AWS_PROFILE=nakom.is-admin   npm run seed-prod
 *
 * The table name is derived from the resolved environment — nothing is
 * hard-coded.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { resolveConfig } from '../lib/config';

interface SeedPost {
  slug: string;
  status: 'queued' | 'reviewing' | 'staged' | 'published';
  title: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
  reviewIteration: number;
  publishabilityScore?: number;
}

const POSTS: SeedPost[] = [
  {
    slug: 'cr6-se-bed-adhesion-helper-discs',
    status: 'queued',
    title: 'Helper discs: when good geometry still fails to print',
    summary:
      'Small-footprint prints detach mid-job. A helper disc fixes it — and the lesson is about the gap between CAD and the physical world.',
    createdAt: '2026-05-18T09:12:00Z',
    updatedAt: '2026-05-18T09:12:00Z',
    reviewIteration: 0,
  },
  {
    slug: 'meta-mcp-one-proxy-many-servers',
    status: 'queued',
    title: 'meta-mcp: proxying a dozen MCP servers behind three tools',
    summary:
      'Why I collapsed every sub-MCP behind a single proxy, and what it cost in latency.',
    createdAt: '2026-05-20T14:40:00Z',
    updatedAt: '2026-05-20T14:40:00Z',
    reviewIteration: 0,
  },
  {
    slug: 'cdk-cross-region-references',
    status: 'reviewing',
    title: 'CloudFront certificates and the us-east-1 tax',
    summary:
      'Cross-region references in CDK, and why your ACM certificate lives in a different stack than everything else.',
    createdAt: '2026-05-10T11:00:00Z',
    updatedAt: '2026-05-21T16:05:00Z',
    reviewIteration: 2,
    publishabilityScore: 68,
  },
  {
    slug: 'asdf-python-tensorflow-311',
    status: 'reviewing',
    title: 'Pinning Python with asdf so TensorFlow stops complaining',
    summary:
      'TensorFlow does not support Python 3.13. Here is how I keep 3.11 around without it bleeding into everything else.',
    createdAt: '2026-05-12T08:30:00Z',
    updatedAt: '2026-05-22T10:15:00Z',
    reviewIteration: 1,
    publishabilityScore: 74,
  },
  {
    slug: 'shepherd-drones-cheap-boilerplate',
    status: 'staged',
    title: 'Letting cheap drones write the boilerplate',
    summary:
      'A spec-and-review loop where a small model generates the code and Claude only supervises.',
    createdAt: '2026-04-28T13:20:00Z',
    updatedAt: '2026-05-19T17:45:00Z',
    reviewIteration: 3,
    publishabilityScore: 86,
  },
  {
    slug: 'taiga-self-hosted-project-management',
    status: 'staged',
    title: 'Self-hosting Taiga for a one-person project estate',
    summary:
      'Twenty-odd projects, one prefix scheme, and an MCP that lets Claude pick up stories.',
    createdAt: '2026-05-02T19:00:00Z',
    updatedAt: '2026-05-20T21:30:00Z',
    reviewIteration: 2,
    publishabilityScore: 81,
  },
  {
    slug: 'catcam-spray-detection-wolf',
    status: 'published',
    title: 'Wolf, the stunt double: testing a catcam without a cat',
    summary:
      'A grey stuffed toy stands in for six uncooperative cats while I tune the spray-detection pipeline.',
    createdAt: '2026-03-15T10:00:00Z',
    updatedAt: '2026-04-01T12:00:00Z',
    reviewIteration: 2,
    publishabilityScore: 92,
  },
  {
    slug: 'oidc-github-actions-no-keys',
    status: 'published',
    title: 'Deploying from GitHub Actions without a single access key',
    summary:
      'OIDC federation, a scoped IAM role, and the end of long-lived CI credentials.',
    createdAt: '2026-02-20T09:45:00Z',
    updatedAt: '2026-03-05T15:20:00Z',
    reviewIteration: 1,
    publishabilityScore: 95,
  },
];

async function main(): Promise<void> {
  const config = resolveConfig();
  const tableName = `blog-pipeline-posts-${config.deployEnv}`;

  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: config.region }),
  );

  // BatchWrite caps at 25 items per request; the seed set fits in one.
  await client.send(
    new BatchWriteCommand({
      RequestItems: {
        [tableName]: POSTS.map((post) => ({ PutRequest: { Item: post } })),
      },
    }),
  );

  console.log(`Seeded ${POSTS.length} posts into ${tableName}`);
}

main().catch((err) => {
  console.error('Seeding failed:', err);
  process.exit(1);
});
