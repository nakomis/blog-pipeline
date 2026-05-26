# CDK deploy churn — root-cause investigation (PIPE-8)

## TL;DR

The single root cause of the deploy churn is `bin/blog-pipeline.ts:29`:

```ts
cdk.Tags.of(app).add('MH-Version', version);
```

CI's `scripts/compute-version.sh` bumps the patch version on every push and
writes the new value into `infra/version.json`. The CDK app reads that file at
synth time and applies the resulting `MH-Version` tag to **every taggable
resource in every stack**. CloudFormation sees a changed `Tags` property on 44
resources and updates each one.

There is **no** Lambda asset-hash non-determinism. Two consecutive local synths
produce byte-identical output (`diff -r /tmp/synth-a.out /tmp/synth-b.out`
returned no differences). The previous theory in the Taiga comment that
`ListPostsHandler`'s code asset hash was changing was incorrect — it is the
tag on the function that changes, not the code asset.

A `cdk diff --all` against the deployed sandbox stack with **zero source
changes** confirms the picture: 44 resources show a single difference,
`MH-Version: 0.1.8 → 0.1.0` (deployed at 0.1.8, committed `version.json`
holds 0.1.0).

The previously-observed "Lambda bundles twice per CI run" is a separate, minor
CI-pipeline issue, not a CDK bug — see "Finding 5" below.

The API Gateway `Deployment` resource being **replaced** (rather than updated)
on every push is a real secondary issue not fully explained by the tag theory
alone. Local synths do produce stable Deployment logical IDs, so something
specific to CI flips the hash. Recommended for the follow-up story to dig
into.

## Evidence

### Finding 1 — Synth is deterministic on a single machine

Two consecutive `npm run ci-synth-sandbox` invocations into separate output
directories produced byte-identical trees:

```bash
$ diff -r /tmp/synth-a.out /tmp/synth-b.out
# (no output — every file identical)
```

This rules out the entire family of "bundling non-determinism" hypotheses
(esbuild timestamps, absolute source-map paths, non-deterministic ordering)
as the cause of cross-CI-run resource churn.

### Finding 2 — `MH-Version` tag is the universal churn driver

`bin/blog-pipeline.ts` reads `version.json` and applies it as a stack-level
tag:

```ts
const { version } = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../version.json'), 'utf-8'),
) as { version: string };
// ...
cdk.Tags.of(app).add('MH-Version', version);
```

`scripts/compute-version.sh` (run by the `version` job in `.github/workflows/ci.yml`)
bumps the patch number on every push and rewrites `version.json` before
either deploy job runs. The new value is uploaded as an artifact and
downloaded into the deploy jobs, so the synthed templates carry whatever
version that run produced.

Tag distribution across stacks in `/tmp/synth-a.out`:

```
12 BlogPipeline-Api-sandbox.template.json
20 BlogPipeline-Review-sandbox.template.json
 5 BlogPipeline-Trigger-sandbox.template.json
 4 BlogPipeline-Web-sandbox.template.json
 1 BlogPipeline-sandbox.template.json
 1 BlogPipeline-WebCert-sandbox.template.json
 1 BlogPipeline-GithubCi-sandbox.template.json
```

By taggable resource type in the API stack — every Lambda, IAM role,
RestApi, Stage, CloudFront distribution, ApiKey, UsagePlan, and DynamoDB
table picks up `MH-Version`. (Some resource types — `AWS::ApiGateway::Method`,
`AWS::ApiGateway::Resource`, `AWS::ApiGateway::Deployment`,
`AWS::ApiGateway::UsagePlanKey`, `AWS::Lambda::Permission`,
`AWS::Route53::RecordSet`, `AWS::SSM::Parameter` — do not surface a `Tags`
property in their CFN schema, so the tag is silently skipped on those.
SSM Parameters do carry the tag through their own `Tags` property however
and are affected.)

### Finding 3 — `cdk diff` against deployed state confirms it

Run from this branch (no source changes vs `main`) against the deployed
sandbox stacks (`AWS_PROFILE=nakom.is-sandbox`):

```
Number of stacks with differences: 6
```

44 resources flagged as modified (`[~]`). For **every single one**, the
diff is exactly:

```
 └─ [~] Tags
     └─ @@ -5,6 +5,6 @@
        [ ]   {
        [ ]     "Key": "MH-Version",
        [-]     "Value": "0.1.8"     ← deployed (last CI version bump)
        [+]     "Value": "0.1.0"     ← committed version.json
        [ ]   }
```

Resource types affected:

- `AWS::Lambda::Function` × 8 (every NodejsFunction + the auto-created
  custom-resource provider Lambda + the CrossRegionExportReader)
- `AWS::IAM::Role` × 10 (every Lambda's service role + the Step Functions
  role + the trigger role + the GitHub CI role)
- `AWS::ApiGateway::RestApi`, `Stage`, `ApiKey`, `UsagePlan` (4)
- `AWS::CloudFront::Distribution` × 2 (the API distribution and the SPA
  distribution)
- `AWS::SSM::Parameter` × 9
- `AWS::S3::Bucket` × 1 (DraftsBucket)
- `AWS::DynamoDB::Table` × 1 (PostsTable)
- `AWS::StepFunctions::StateMachine` × 1

Plus one resource being replaced rather than tagged-updated — see Finding 4.

### Finding 4 — API Gateway `Deployment` is replaced on every CI run (secondary issue)

The `cdk diff` showed:

```
[-] AWS::ApiGateway::Deployment RestApi/Deployment RestApiDeployment180EC503fe33b7bc75197722e314ccfdf05b6cab destroy
[+] AWS::ApiGateway::Deployment RestApi/Deployment RestApiDeployment180EC503ad44c6764501cd276b422b1f0db126e4
```

The logical-id suffix has flipped. The Stage's `DeploymentId` `Ref` updates
to match.

This is **not** caused by the tag (Deployments are not directly taggable, and
the tag does not appear in any input the Deployment hash consumes). Local
synths produce a stable Deployment id across runs, so the variable is
CI-specific.

Candidate causes (not fully verified in this investigation):

- CDK's `RestApi.Deployment` includes a hash of the entire methods +
  integrations sub-tree in its logical id. Something in the rendered output
  for that sub-tree differs between local synth and what was deployed —
  possibly a Lambda integration URI whose resolved form differs (e.g. an
  intrinsic function rendered differently between CDK minor versions), or a
  method's `RequestParameters` ordering.
- Less likely but worth eliminating: a CDK `aws-cdk-lib` minor-version drift
  between dev and CI changing how the deployment hash is computed.

Recommend reproducing by re-running CI on this branch and diffing the
two CI-produced templates against each other (i.e. compare two consecutive
real CI synth outputs from different runs, not local-vs-deployed).

### Finding 5 — "Bundles twice per CI run" is two GitHub Actions jobs, not a CDK bug

The Taiga comment observed bundling happening twice (~8s apart) per CI run.
Looking at `.github/workflows/ci.yml`:

- The `synth` job runs `npm run ci-synth-sandbox` on its own runner
- The `deploy-sandbox` job runs `npm run ci-deploy-sandbox` on a separate
  runner

Each runner has a fresh checkout and a fresh `cdk.out` workspace, so each
performs its own bundling pass. This is expected with the current workflow
layout — there is no CDK misconfiguration here.

The optimisation (for the follow-up) is to upload the `cdk.out` cloud
assembly from `synth` as a workflow artifact and have `deploy-sandbox`
download it and run `cdk deploy --app cdk.out`, skipping resynth. Modest
saving (~5–10 s per deploy job) but conceptually clean.

### Finding 6 — CloudFront 70s is no fix on the CDK side, it is CFN behaviour

CloudFront `UPDATE_IN_PROGRESS` takes ~70 s because that is how long
CloudFront takes to acknowledge a tag-only change. Once Finding 2 is
addressed and the tag stops changing, the distribution will no-op (no event
emitted, no waiting) and the time disappears entirely.

## Cascade map

```
compute-version.sh bumps patch
        │
        ▼
version.json patched (CI artifact)
        │
        ▼
bin/blog-pipeline.ts reads version → cdk.Tags.of(app).add('MH-Version', …)
        │
        ▼
~44 resources have new Tags value in synthed templates
        │
        ▼
CloudFormation drives UPDATE_IN_PROGRESS on each
        │
        ├─→ 8 × Lambda::Function (incl. ListPostsHandler — not "asset hash")
        ├─→ 10 × IAM::Role
        ├─→ CloudFront × 2 (each ~70 s — the dominant wall-clock cost)
        ├─→ API Gateway RestApi / Stage / ApiKey / UsagePlan
        ├─→ 9 × SSM::Parameter
        ├─→ S3::Bucket, DynamoDB::Table, StepFunctions::StateMachine
        └─→ (separate cause) API Gateway Deployment hash flips → replacement

Parallel observation (orthogonal):
   GH Actions split synth+deploy → bundling runs twice per push (expected)
```

## Prioritised fix list (for the follow-up story)

1. **Stop applying `MH-Version` as a tag on every resource.** Highest
   leverage by an order of magnitude — fixes Findings 2, 3 and 6 in one
   change. Options:
   - Remove the tag entirely (the version is already tracked by the
     deployment tracker mentioned in `compute-version.sh`, so the on-resource
     copy is redundant)
   - Apply it only to a single stable "release marker" resource (e.g. one
     SSM parameter or a tag on the stack itself, not propagated to
     constructs)
   - Keep tagging but only bump the version when the deploy actually
     changes something (the current "bump every push" policy is what
     converts the tag into a churn driver)

   *Estimated saving:* ~70–100 s per deploy (CloudFront alone) plus
   eliminates the misleading "everything is updating" signal.
   *Risk:* low. The tag has no functional purpose; nothing reads it.

2. **Investigate why the API Gateway `Deployment` hash flips between CI
   runs.** Needs a second piece of evidence (two real CI synth outputs).
   *Estimated saving:* skips a Deployment replacement (~5–10 s) on every
   push and eliminates the spurious churn signal.
   *Risk:* medium. Diagnosing CDK internal hash inputs may require reading
   `aws-cdk-lib/aws-apigateway` source.

3. **Pass the synth cloud assembly as a workflow artifact from `synth` to
   `deploy-sandbox` / `deploy-production`.** Avoids re-bundling.
   *Estimated saving:* ~5–10 s per deploy job.
   *Risk:* low. Standard CDK pattern (`cdk deploy --app cdk.out`).

## Method / reproduction

All commands run from `infra/` with `AWS_PROFILE=nakom.is-sandbox`.

```bash
# Two consecutive synths
NPM_ENVIRONMENT=sandbox npx cdk synth --all --output /tmp/synth-a.out
NPM_ENVIRONMENT=sandbox npx cdk synth --all --output /tmp/synth-b.out
diff -r /tmp/synth-a.out /tmp/synth-b.out   # zero output

# Tag-application audit
for f in /tmp/synth-a.out/*.template.json; do
  echo "$(grep -c '"MH-Version"' "$f") $(basename "$f")"
done

# Diff vs deployed state (with no source changes)
NPM_ENVIRONMENT=sandbox npx cdk diff --all
```

## What is NOT a cause

For posterity (these were on the table and are now ruled out):

- ❌ esbuild output non-determinism (timestamps, source-map paths)
- ❌ CDK `cdk.context.json` drift (it is gitignored and lookups resolve
  identically; not present in `/tmp/synth-*.out` since the resolved values
  are inlined into the templates)
- ❌ Custom resource provider Lambda regeneration (their asset hashes are
  identical between the two synths and identical to the deployed state —
  the only diff on the custom-resource Lambda is `MH-Version`)
- ❌ CloudFront cascading from upstream config changes (its config is
  unchanged in the diff; only `Tags` differs)
- ❌ Asset bundle re-hashing for unrelated Lambdas (e.g. `ListPostsHandler`
  in `BlogPipeline-Api-sandbox`) — the *function* shows up in the diff
  because its `Tags` differ, not because its code asset hash changed
