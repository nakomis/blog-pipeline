/**
 * Seeds one deliberately-imperfect draft so the review loop (PIPE-3) has
 * something real to chew on before the webhook (PIPE-2) exists to feed it.
 *
 *   AWS_PROFILE=nakom.is-sandbox npm run seed-draft-sandbox
 *   AWS_PROFILE=nakom.is-admin   npm run seed-draft-prod
 *
 * It writes two things, both derived from the resolved environment — nothing
 * is hard-coded:
 *
 *   - a `queued` post item in `blog-pipeline-posts-{env}`
 *   - the iteration-1 draft Markdown at `{slug}/iteration-1/draft.md` in
 *     `blog-pipeline-drafts-{env}`
 *
 * Those are exactly the two preconditions `load-draft` checks, so once seeded
 * the state machine can be started against the slug:
 *
 *   aws stepfunctions start-execution \
 *     --state-machine-arn "$(aws ssm get-parameter \
 *       --name /blog-pipeline/sandbox/review/state-machine-arn \
 *       --query Parameter.Value --output text)" \
 *     --input '{"slug":"<slug>"}'
 *
 * The draft is intentionally weak — vague claims, padding, no concrete
 * detail — so reviewers score it below the threshold and the loop redrafts.
 *
 * An optional first argument overrides the slug, so the script can be re-run
 * to seed a fresh post without clobbering the previous one.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { resolveConfig } from '../lib/config';

const DEFAULT_SLUG = 'why-i-use-git-worktrees';

/**
 * A deliberately mediocre draft: it makes broad claims without evidence,
 * pads sentences, and never shows a command. A good review loop should score
 * it under the publishability threshold and ask for a redraft.
 */
const DRAFT_MARKDOWN = `---
title: Why I Use Git Worktrees
date: 2026-05-22
tags: [git, workflow]
---

# Why I Use Git Worktrees

Git worktrees are something that I have been using for a while now and I think
that they are honestly a really great feature that more people should probably
know about because they are very useful in a lot of different situations.

## The Problem

Sometimes you are working on something and then you need to work on something
else as well. This can be quite annoying and frustrating because you have to
deal with it somehow. There are various ways to deal with it but they all have
their own problems and downsides which is not ideal.

## The Solution

This is where worktrees come in. They basically let you have more than one
thing checked out at the same time which is obviously very helpful. It just
works really well and I have never had any issues with it at all, ever.

You should definitely try them out because they will probably change the way
that you work in a big way. Most developers would benefit from this.

## Conclusion

In conclusion, git worktrees are great and you should use them. Thanks for
reading this blog post and I hope that you found it useful and informative.
`;

async function main(): Promise<void> {
  const config = resolveConfig();
  const slug = process.argv[2] ?? DEFAULT_SLUG;

  const tableName = `blog-pipeline-posts-${config.deployEnv}`;
  const bucketName = `blog-pipeline-drafts-${config.deployEnv}`;
  const draftKey = `${slug}/iteration-1/draft.md`;
  const now = new Date().toISOString();

  const s3 = new S3Client({ region: config.region });
  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: draftKey,
      Body: DRAFT_MARKDOWN,
      ContentType: 'text/markdown',
    }),
  );
  console.log(`Wrote draft to s3://${bucketName}/${draftKey}`);

  const docClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: config.region }),
  );
  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        slug,
        status: 'queued',
        title: 'Why I Use Git Worktrees',
        summary:
          'A deliberately weak seed draft for exercising the review loop end to end.',
        createdAt: now,
        updatedAt: now,
        reviewIteration: 0,
      },
    }),
  );
  console.log(`Wrote queued post '${slug}' into ${tableName}`);
  console.log(
    `\nStart the review loop with input: {"slug":"${slug}"}`,
  );
}

main().catch((err) => {
  console.error('Seeding the draft failed:', err);
  process.exit(1);
});
