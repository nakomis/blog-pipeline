/**
 * Dry run of the link and repo suggestion step against a real post (PIPE-38).
 *
 *   AWS_PROFILE=nakom.is-admin NPM_ENVIRONMENT=prod AWS_REGION=eu-west-2 \
 *     npx ts-node scripts/link-suggestions-eval.ts <path-to-post.md> [--floor 0.45] [--model <bedrock-id>] [--watch <slug-fragment>]
 *
 * Read-only: it reads the embeddings index, calls Titan and Haiku, and lists
 * public GitHub repos, then prints what it would suggest. Nothing is written to
 * S3, DynamoDB or the post. Use it to calibrate `LINKS.retrieval.floor` over
 * posts with known cross-references and to check that a post which merely
 * resembles an earlier one (e.g. the Alexa announce post and the Cabal) gets no
 * false link. `--model` swaps the Bedrock model for the Haiku call (for example
 * when `LINKS.model` is not yet enabled in the account being tested).
 */
import * as fs from 'fs';
import * as path from 'path';
import { githubOwners, LINKS, privateBucketName, resolveConfig } from '../lib/config';

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    throw new Error('Usage: link-suggestions-eval.ts <post.md> [--floor <n>]');
  }
  const floorArg = process.argv.indexOf('--floor');
  const floor = floorArg !== -1 ? Number(process.argv[floorArg + 1]) : undefined;

  const modelArg = process.argv.indexOf('--model');
  const modelId = modelArg !== -1 ? process.argv[modelArg + 1] : undefined;

  const watchArg = process.argv.indexOf('--watch');
  const watch = watchArg !== -1 ? process.argv[watchArg + 1] : undefined;

  const { deployEnv } = resolveConfig();
  process.env.PRIVATE_BUCKET ??= privateBucketName(deployEnv);
  process.env.EMBED_REGION ??= LINKS.embedRegion;

  // The AI SDK's Bedrock provider signs with AWS_* environment credentials
  // (inside Lambda they exist already); a named profile needs resolving first.
  if (!process.env.AWS_ACCESS_KEY_ID) {
    const { defaultProvider } = await import('@aws-sdk/credential-provider-node');
    const credentials = await defaultProvider()();
    process.env.AWS_ACCESS_KEY_ID = credentials.accessKeyId;
    process.env.AWS_SECRET_ACCESS_KEY = credentials.secretAccessKey;
    if (credentials.sessionToken) {
      process.env.AWS_SESSION_TOKEN = credentials.sessionToken;
    }
  }

  // Imported after the environment is set; they read it lazily anyway.
  const { defaultDeps, generateSuggestions } = await import('../lambda/suggest/suggest-links');

  const markdown = fs.readFileSync(file, 'utf8');
  const slug = path.basename(file, '.md').replace(/^\d{4}-\d{2}-\d{2}-/, '');
  const deps = defaultDeps();
  if (modelId) {
    const [{ createAmazonBedrock }, { generateObject }, { Picks }] = await Promise.all([
      import('@ai-sdk/amazon-bedrock'),
      import('ai'),
      import('../lambda/suggest/schema'),
    ]);
    const bedrock = createAmazonBedrock();
    deps.pick = async (system, prompt) =>
      (await generateObject({ model: bedrock(modelId), schema: Picks, system, prompt })).object;
  }

  console.log(`Post: ${file}`);
  console.log(`Slug: ${slug}   owners: ${githubOwners().join(', ')}   bucket: ${process.env.PRIVATE_BUCKET}`);
  console.log(`Floor: ${floor ?? LINKS.retrieval.floor}   model: ${modelId ?? LINKS.model}\n`);

  const result = await generateSuggestions(
    { slug, iteration: 1, draftKey: file, markdown },
    deps,
    {
      floor,
      onScored: (scored) => {
        console.log('Top eligible posts by best chunk similarity:');
        for (const c of scored.slice(0, 12)) {
          console.log(`  ${c.score.toFixed(3)}  ${c.slug}`);
        }
        if (watch) {
          for (const c of scored.filter((x) => x.slug.includes(watch))) {
            console.log(`  watched: ${c.score.toFixed(3)}  ${c.slug}  (rank ${scored.indexOf(c) + 1})`);
          }
        }
        console.log(`  (${scored.length} eligible posts)\n`);
      },
    },
  );

  console.log(`Status: ${result.status}${result.skippedReason ? ` (${result.skippedReason})` : ''}`);
  console.log(`\nLINK SUGGESTIONS (${result.links.length}):`);
  for (const l of result.links) {
    console.log(`  "${l.anchorText}" -> ${l.targetUrl}\n    why: ${l.reason}\n    context: ${l.context}`);
  }
  console.log(`\nREPO SUGGESTIONS (${result.repos.length}):`);
  for (const r of result.repos) {
    console.log(`  ${r.fullName} [${r.source}]\n    why: ${r.reason}\n    evidence: ${r.evidence}`);
  }
  console.log(`\nDROPPED BY VALIDATION (${result.dropped.length}):`);
  for (const d of result.dropped) {
    console.log(`  ${d.kind}: ${d.value} -- ${d.reason}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
