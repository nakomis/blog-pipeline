/**
 * blog-pipeline-temporal.ts — the PIPE-3 review loop, rewritten as a Temporal
 * workflow, purely to compare with the AWS Step Functions version in
 * `blog-pipeline-review-stack.ts`.
 *
 * ⚠️ ILLUSTRATIVE — not wired into the CDK build. It imports `@temporalio/*`
 * (not a dependency here) and won't compile without them. It exists to show
 * "how would this look in Temporal", side by side with the Step Functions CDK.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BIG PICTURE DIFFERENCE
 *
 *   Step Functions:  the workflow IS infrastructure. You define a state machine
 *                    (Amazon States Language, generated here by CDK). AWS runs it.
 *                    The orchestration lives in your infra stack.
 *
 *   Temporal:        the workflow IS application code (this file). The "infra" is
 *                    just: a Temporal cluster (self-hosted or Temporal Cloud) +
 *                    Worker processes you deploy (e.g. on ECS/EKS/Lambda) that
 *                    run this code. The orchestration lives in your app.
 *
 * So the Lambdas here become Temporal *Activities* (the side-effecting units of
 * work), and the state machine (Map / Gate / Choice / loop / Catch) becomes
 * plain, imperative TypeScript in `reviewLoopWorkflow` below.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ROSETTA STONE — Step Functions construct  →  Temporal equivalent
 *
 *   sfn.StateMachine                  →  an exported `async function` (the workflow)
 *   tasks.LambdaInvoke (a Lambda)     →  an Activity (a normal async function)
 *   Retry / retryOnServiceExceptions  →  RetryPolicy in proxyActivities({ retry })
 *   per-task timeout                  →  startToCloseTimeout in proxyActivities
 *   sfn.Map (fan-out, maxConcurrency) →  await Promise.all(items.map(activity))
 *   invokeReviewer.addCatch(...)      →  a per-item .catch(...) on the activity call
 *   sfn.Choice / .when(...)           →  a switch / if-else on the activity's result
 *   redraft.next(reviewFanOut) (loop) →  a `while (true) { ... }` loop
 *   state.addCatch(handleException)   →  try/catch around the whole workflow body
 *   sfn.Succeed                       →  `return` from the workflow
 *   sfn.Fail                          →  `throw` (ApplicationFailure)
 *   load-draft async-invokes image    →  start a detached activity / ABANDON child
 *
 * The determinism rule (Temporal's one big gotcha): workflow code is replayed to
 * rebuild state after a crash, so it must be DETERMINISTIC — no Date.now(),
 * Math.random(), direct network/DB/IO in the workflow. Every side effect goes in
 * an Activity. (Your Lambdas already are those side effects, so the split is
 * natural: the state machine ≈ the workflow, the Lambdas ≈ the activities.)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { proxyActivities, ApplicationFailure, log } from '@temporalio/workflow';
// `import type` — the workflow only needs the *types* of the activities, never
// their implementations (those run in the Worker, not the workflow sandbox).
import type * as activities from './review-activities';

// ── The reviewers, mirroring REVIEW.providers ──────────────────────────────
const PROVIDERS = ['azure', 'gemini', 'anthropic', 'grok'] as const;

// Belt-and-braces cap; in practice the Gate returns 'fail-capped' using the
// iteration it's given, exactly as in the Step Functions version.
const MAX_ITERATIONS = 4;

/**
 * Activity proxies. Each `proxyActivities` call is the Temporal equivalent of a
 * `tasks.LambdaInvoke` plus its Retry/Timeout config. We use three flavours to
 * match the different timeouts/retries in the CDK.
 */

// Default: quick metadata/persistence work (load-draft, gate, persist, set-outcome).
const { loadDraft, gate, persistIteration, setOutcome, submitImages } =
  proxyActivities<typeof activities>({
    startToCloseTimeout: '30 seconds',
    retry: { maximumAttempts: 3 }, // ≈ retryOnServiceExceptions
  });

// Reviewers: slower (120s in the CDK) and, crucially, BOUNDED retries — after a
// few attempts we let the failure through so the workflow can mark the provider
// `unavailable` rather than retry a genuinely-down provider forever.
const { reviewOne } = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 3 },
});

// Redraft: the longest step (180s in the CDK) — Claude Sonnet rewriting the post.
const { redraft } = proxyActivities<typeof activities>({
  startToCloseTimeout: '3 minutes',
  retry: { maximumAttempts: 2 },
});

export interface ReviewLoopInput {
  slug: string;
}

/**
 * The review loop — the whole Step Functions state machine as one function.
 *
 * Compare with the CDK: `loadDraft.next(reviewFanOut)`, `reviewFanOut.next(gate)`,
 * `gate.next(persistIteration)`, `persistIteration.next(decideLoop)`,
 * `redraft.next(reviewFanOut)` — all of that wiring is now just the control flow
 * you can read top-to-bottom.
 */
export async function reviewLoopWorkflow(input: ReviewLoopInput): Promise<void> {
  const { slug } = input;

  try {
    // ── LoadDraft ──────────────────────────────────────────────────────────
    const { draftKey } = await loadDraft({ slug });

    // load-draft async-invokes image-submit (fire-and-forget) in the CDK. In
    // Temporal you don't leave a bare un-awaited promise dangling; the idiomatic
    // "kick off and forget" is a child workflow started with
    // ParentClosePolicy.ABANDON, or a detached activity. Shown minimally here —
    // start it, don't await it. (In real code: `await startChild(imageWorkflow,
    // { parentClosePolicy: ABANDON, ... })`.)
    void submitImages({ slug, draftKey });

    let iteration = 1;
    let currentDraftKey = draftKey;

    // ── The loop (redraft.next(reviewFanOut) in the CDK) ───────────────────
    while (true) {
      // ── ReviewFanOut: sfn.Map(maxConcurrency = providers.length) ─────────
      // Promise.all runs all four reviewers concurrently. The per-reviewer
      // `.catch` is the exact equivalent of `invokeReviewer.addCatch(
      // markUnavailable)` — a failed reviewer becomes `unavailable` and never
      // fails the iteration; the three-of-four quorum can still be met.
      const reviews = await Promise.all(
        PROVIDERS.map((provider) =>
          reviewOne({
            slug,
            iteration,
            draftKey: currentDraftKey,
            provider,
          }).catch((err) => ({
            provider,
            status: 'unavailable' as const,
            error: String(err),
          })),
        ),
      );

      // ── Gate: the deterministic decision ─────────────────────────────────
      const decision = await gate({ slug, iteration, reviews, maxIterations: MAX_ITERATIONS });

      // ── PersistIteration ─────────────────────────────────────────────────
      await persistIteration({ slug, iteration, reviews, decision });

      // ── DecideLoop: sfn.Choice(...) ──────────────────────────────────────
      switch (decision.decision) {
        case 'pass':
          await setOutcome({ slug, status: 'staged', reviewOutcome: 'passed' });
          return; // sfn.Succeed (ReviewComplete)

        case 'fail-capped':
          await setOutcome({ slug, status: 'failed', reviewOutcome: 'capped' });
          return;

        case 'fail-quorum':
          await setOutcome({ slug, status: 'failed', reviewOutcome: 'quorum' });
          return;

        case 'loop':
          // redraft → back round the loop. The reassignment + `continue` is the
          // `redraft.next(reviewFanOut)` edge, made obvious.
          currentDraftKey = await redraft({ slug, iteration, reviews });
          iteration += 1;
          continue;

        default:
          // sfn.Fail('UnknownGateDecision'). Non-retryable — retrying a bad
          // decision would just fail again.
          throw ApplicationFailure.nonRetryable(
            `The gate returned an unrecognised decision: ${decision.decision}`,
            'UnknownGateDecision',
          );
      }
    }
  } catch (err) {
    // ── catchToException / HandleException in the CDK ──────────────────────
    // One try/catch replaces `addCatch(handleException)` on every state: record
    // the failed/exception outcome, then re-throw so the workflow itself fails
    // (the sfn.Fail 'ReviewFailed' equivalent). setOutcome here is best-effort;
    // in production you'd guard it so a failure to record doesn't mask the
    // original error.
    log.error('Review loop failed', { slug, err: String(err) });
    await setOutcome({
      slug,
      status: 'failed',
      reviewOutcome: 'exception',
      error: String(err),
    });
    throw err;
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * FOR REFERENCE — the other two files you'd have alongside this one.
 * (Commented out; they'd normally live in their own modules.)
 *
 * 1) review-activities.ts — the Activities. These are your Lambdas' bodies,
 *    minus the Lambda wrapper. Ordinary async functions; here they can do IO,
 *    call Bedrock/Azure/Gemini, read/write S3 and DynamoDB — no determinism
 *    restriction, because Activities are NOT replayed.
 *
 *    export async function loadDraft(a: { slug: string }): Promise<{ draftKey: string }> { ... }
 *    export async function reviewOne(a: { slug: string; iteration: number; draftKey: string; provider: string })
 *        : Promise<{ provider: string; status: 'ok' | 'unavailable'; score?: number; critique?: string }> { ... }
 *    export async function gate(a: { slug: string; iteration: number; reviews: unknown[]; maxIterations: number })
 *        : Promise<{ decision: 'pass' | 'loop' | 'fail-capped' | 'fail-quorum' }> { ... }
 *    export async function persistIteration(a: { slug: string; iteration: number; reviews: unknown[]; decision: unknown }): Promise<void> { ... }
 *    export async function redraft(a: { slug: string; iteration: number; reviews: unknown[] }): Promise<string> { ... } // returns the new draftKey
 *    export async function setOutcome(a: { slug: string; status: 'staged' | 'failed'; reviewOutcome: string; error?: string }): Promise<void> { ... }
 *    export async function submitImages(a: { slug: string; draftKey: string }): Promise<void> { ... }
 *
 * 2) worker.ts — the process that actually runs the workflow + activities. THIS
 *    is your "infrastructure" in the Temporal world (you'd deploy it on ECS/EKS).
 *    It replaces "AWS runs your state machine".
 *
 *    import { Worker, NativeConnection } from '@temporalio/worker';
 *    import * as activities from './review-activities';
 *    const connection = await NativeConnection.connect({ address: 'temporal:7233' });
 *    const worker = await Worker.create({
 *      connection,
 *      taskQueue: 'blog-review',
 *      workflowsPath: require.resolve('./blog-pipeline-temporal'),
 *      activities,
 *    });
 *    await worker.run();
 *
 * 3) Triggering it — the equivalent of PIPE-2's webhook starting the state
 *    machine. A client starts a workflow execution:
 *
 *    import { Client } from '@temporalio/client';
 *    const client = new Client();
 *    await client.workflow.start(reviewLoopWorkflow, {
 *      taskQueue: 'blog-review',
 *      workflowId: `review-${slug}`,   // dedupe key — one live review per slug
 *      args: [{ slug }],
 *    });
 *
 * WHAT YOU GAIN vs WHAT YOU PAY
 *   Gain:  the loop and branching read like normal code; arbitrarily complex or
 *          dynamic logic is trivial; testable with plain unit tests; not tied to
 *          AWS; a review that runs for hours/days is the same code.
 *   Pay:   you run the Temporal cluster (or pay Temporal Cloud) and deploy
 *          Workers — there's no "serverless, AWS runs it for you" as with SFN;
 *          and you must respect the workflow determinism rule.
 * ───────────────────────────────────────────────────────────────────────────── */
