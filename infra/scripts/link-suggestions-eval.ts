/**
 * Dry run of the link and repo suggestion step against a real post (PIPE-38).
 *
 *   AWS_PROFILE=nakom.is-admin NPM_ENVIRONMENT=prod AWS_REGION=eu-west-2 \
 *     npx ts-node scripts/link-suggestions-eval.ts <path-to-post.md> [--floor 0.45] [--model <anthropic-model-id>] [--watch <slug-fragment>]
 *     [--forbid <slug-fragment>] [--also-catalogue]
 *
 * Read-only: it reads the embeddings index, calls Titan and Haiku, and lists
 * public GitHub repos, then prints what it would suggest. Nothing is written to
 * S3, DynamoDB or the post. Use it to calibrate `LINKS.retrieval.floor` over
 * posts with known cross-references and to check that a post which merely
 * resembles an earlier one (e.g. the Alexa announce post and the Cabal) gets no
 * false link. `--model` swaps the Anthropic model for the Haiku call (for example
 * to compare models). Needs AWS credentials for S3, Titan and the SSM key.
 *
 * False-positive check: `--forbid <fragment>` fails the run (exit code 2) if any
 * suggested link targets a post whose slug contains the fragment, and
 * `--also-catalogue` repeats the whole run with the floor forced to 0.99 so
 * the model is offered the entire catalogue (catalogue-fallback mode), the case
 * where a wrong post is easiest to reach. For example, the Alexa announce post
 * must never link to the Cabal post in either mode:
 *
 *   npm run eval-links-prod -- <blog-content>/blog/2026-10-10-alexa-announce-hello-world.md \
 *     --forbid three-of-them --also-catalogue
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

  const forbidArg = process.argv.indexOf('--forbid');
  const forbid = forbidArg !== -1 ? process.argv[forbidArg + 1] : undefined;
  const alsoCatalogue = process.argv.includes('--also-catalogue');
  const watchArg = process.argv.indexOf('--watch');
  const watch = watchArg !== -1 ? process.argv[watchArg + 1] : undefined;

  const { deployEnv, ssmPrefix } = resolveConfig();
  process.env.PRIVATE_BUCKET ??= privateBucketName(deployEnv);
  process.env.EMBED_REGION ??= LINKS.embedRegion;
  process.env.ANTHROPIC_PARAM_NAME ??= `${ssmPrefix}/reviewer/anthropic`;

  // Imported after the environment is set; they read it lazily anyway.
  const { defaultDeps, generateSuggestions } = await import('../lambda/suggest/suggest-links');

  const markdown = fs.readFileSync(file, 'utf8');
  const slug = path.basename(file, '.md').replace(/^\d{4}-\d{2}-\d{2}-/, '');
  const deps = defaultDeps();
  if (modelId) {
    const [{ createAnthropic }, { generateObject }, { Picks }, { readParameterJson }] =
      await Promise.all([
        import('@ai-sdk/anthropic'),
        import('ai'),
        import('../lambda/suggest/schema'),
        import('../lambda/review/runtime'),
      ]);
    deps.pick = async (system, prompt) => {
      const { apiKey } = await readParameterJson<{ apiKey: string }>(
        process.env.ANTHROPIC_PARAM_NAME as string,
      );
      const model = createAnthropic({ apiKey })(modelId);
      return (await generateObject({ model, schema: Picks, system, prompt })).object;
    };
  }

  console.log(`Post: ${file}`);
  console.log(`Slug: ${slug}   owners: ${githubOwners().join(', ')}   bucket: ${process.env.PRIVATE_BUCKET}`);

  const floors: (number | undefined)[] = [floor];
  if (alsoCatalogue) {
    floors.push(0.99);
  }
  let violations = 0;

  for (const f of floors) {
    console.log(
      `\n=== Floor: ${f ?? LINKS.retrieval.floor}${f === 0.99 ? ' (forces catalogue-fallback mode)' : ''}   model: ${modelId ?? LINKS.model} ===\n`,
    );
    const result = await generateSuggestions(
      { slug, iteration: 1, draftKey: file, markdown },
      deps,
      {
        floor: f,
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
    if (forbid) {
      const bad = result.links.filter((l) => l.targetSlug.includes(forbid));
      if (bad.length > 0) {
        violations += bad.length;
        console.log(`\nFAIL: ${bad.length} link(s) to a forbidden target '${forbid}'`);
      } else {
        console.log(`\nOK: no link to '${forbid}'`);
      }
    }
  }
  if (violations > 0) {
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
