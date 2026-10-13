import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import {
  GetParameterCommand,
  ParameterNotFound,
  PutParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import { IMAGE } from '../../lib/config';
import { fetchFalBalance } from './fal';

/**
 * fal.ai credit early warning (PIPE-34).
 *
 * fal locks an account — and rejects every generation — once its prepaid
 * balance runs dry, and image generation is fire-and-forget, so an empty
 * balance would otherwise only show up as posts quietly missing their
 * illustrations. Before each `image-submit` run this module estimates the
 * remaining credit and, when it falls below a threshold, publishes a warning to
 * the pipeline's failure-alerts SNS topic (PIPE-15) at most once per UTC day.
 *
 * The remaining credit comes from one of two sources:
 *
 *   - `fal`    — the real balance from fal's account-billing Platform API. That
 *                endpoint needs an *admin* key, kept in its own SSM parameter;
 *                while that parameter is still at its deploy placeholder (or the
 *                call fails for any reason) we fall back to…
 *   - `budget` — a proxy: a configurable monthly budget minus this month's
 *                generation count × an estimated cost per image.
 *
 * All state — this month's generation count, the day we last warned, and the
 * latest snapshot the dashboard banner reads — lives in one small JSON SSM
 * parameter (`${ssmPrefix}/image/fal-credit-state`), the same plain-`String`
 * pattern the pipeline already uses for its keys.
 *
 * Nothing here may ever change generation behaviour: callers wrap every call in
 * a catch, and a low balance only warns — it never blocks a submission.
 */

const ssm = new SSMClient({});
const sns = new SNSClient({});

/** Defaults (USD) — see `IMAGE.credit`; each is overridable by env var. */
export const DEFAULT_WARN_THRESHOLD_USD = IMAGE.credit.warnThresholdUsd;
export const DEFAULT_MONTHLY_BUDGET_USD = IMAGE.credit.monthlyBudgetUsd;
export const DEFAULT_COST_PER_IMAGE_USD = IMAGE.credit.costPerImageUsd;

export type CreditSource = 'fal' | 'budget';

/** The JSON stored in the credit-state SSM parameter. */
export interface CreditState {
  /** `YYYY-MM` (UTC) the generation count belongs to. */
  month?: string;
  /** Images submitted to fal this month — the proxy's input. */
  generations?: number;
  /** `YYYY-MM-DD` (UTC) of the last SNS warning — once-a-day throttle. */
  lastWarnedOn?: string;
  /** Snapshot of the latest check, served to the dashboard banner. */
  remainingUsd?: number;
  thresholdUsd?: number;
  source?: CreditSource;
  low?: boolean;
  checkedAt?: string;
}

export interface CreditSettings {
  thresholdUsd: number;
  monthlyBudgetUsd: number;
  costPerImageUsd: number;
}

export interface CreditCheckResult {
  remainingUsd: number;
  thresholdUsd: number;
  source: CreditSource;
  low: boolean;
  /** True when this call published the SNS warning. */
  warned: boolean;
}

/** A positive number from the environment, or the default if unset/invalid. */
function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Thresholds and proxy inputs, overridable per environment. */
export function creditSettings(): CreditSettings {
  return {
    thresholdUsd: numberEnv(
      'FAL_CREDIT_WARN_THRESHOLD_USD',
      DEFAULT_WARN_THRESHOLD_USD,
    ),
    monthlyBudgetUsd: numberEnv(
      'FAL_MONTHLY_BUDGET_USD',
      DEFAULT_MONTHLY_BUDGET_USD,
    ),
    costPerImageUsd: numberEnv(
      'FAL_COST_PER_IMAGE_USD',
      DEFAULT_COST_PER_IMAGE_USD,
    ),
  };
}

const monthOf = (now: Date): string => now.toISOString().slice(0, 7);
const dayOf = (now: Date): string => now.toISOString().slice(0, 10);

/**
 * Read the credit state. A missing parameter, its deploy placeholder or
 * unparseable JSON all read as an empty state — never a throw.
 */
export async function readCreditState(name: string): Promise<CreditState> {
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: name }));
    const parsed: unknown = JSON.parse(res.Parameter?.Value ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as CreditState) : {};
  } catch (err) {
    if (!(err instanceof ParameterNotFound) && !(err instanceof SyntaxError)) {
      throw err;
    }
    return {};
  }
}

async function writeCreditState(
  name: string,
  state: CreditState,
): Promise<void> {
  await ssm.send(
    new PutParameterCommand({
      Name: name,
      Value: JSON.stringify(state),
      Type: 'String',
      Overwrite: true,
    }),
  );
}

/** Reset the generation count when the month has rolled over. */
function forMonth(state: CreditState, now: Date): CreditState {
  const month = monthOf(now);
  return state.month === month
    ? state
    : { ...state, month, generations: 0 };
}

/**
 * The admin key, or `undefined` when none is configured — no parameter name,
 * an unreadable parameter, or the stack's `REPLACE …` deploy placeholder.
 */
async function readAdminKey(name?: string): Promise<string | undefined> {
  if (!name) {
    return undefined;
  }
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: name }));
    const value = res.Parameter?.Value?.trim();
    return value && !value.startsWith('REPLACE') ? value : undefined;
  } catch {
    return undefined;
  }
}

export interface CheckFalCreditInput {
  /** The credit-state SSM parameter name. */
  stateParamName: string;
  /** The fal admin-key SSM parameter name — optional; absent means proxy only. */
  adminParamName?: string;
  /** The failure-alerts SNS topic (PIPE-15). */
  topicArn: string;
  now?: Date;
}

/**
 * Pre-flight credit check. Estimates the remaining credit, warns over SNS when
 * it is below the threshold (once per UTC day), and records the snapshot for
 * the dashboard. Throws only on a state-store failure — callers must catch.
 */
export async function checkFalCredit(
  input: CheckFalCreditInput,
): Promise<CreditCheckResult> {
  const now = input.now ?? new Date();
  const settings = creditSettings();
  const state = forMonth(await readCreditState(input.stateParamName), now);

  let remainingUsd: number;
  let source: CreditSource;
  const adminKey = await readAdminKey(input.adminParamName);
  try {
    if (!adminKey) {
      throw new Error('no fal admin key configured');
    }
    remainingUsd = await fetchFalBalance(adminKey);
    source = 'fal';
  } catch (err) {
    if (adminKey) {
      console.warn('fal balance lookup failed; using budget proxy', err);
    }
    remainingUsd =
      settings.monthlyBudgetUsd -
      (state.generations ?? 0) * settings.costPerImageUsd;
    source = 'budget';
  }
  remainingUsd = Math.round(remainingUsd * 100) / 100;

  const low = remainingUsd < settings.thresholdUsd;
  const today = dayOf(now);
  let warned = false;
  let lastWarnedOn = state.lastWarnedOn;

  if (low && state.lastWarnedOn !== today) {
    try {
      await sns.send(
        new PublishCommand({
          TopicArn: input.topicArn,
          Subject: 'Blog pipeline: fal.ai credit running low',
          Message: warningMessage(remainingUsd, source, settings, state),
        }),
      );
      warned = true;
      lastWarnedOn = today;
    } catch (err) {
      // Leave lastWarnedOn alone so the next run tries again.
      console.error('Failed to publish fal credit warning', err);
    }
  }

  await writeCreditState(input.stateParamName, {
    ...state,
    lastWarnedOn,
    remainingUsd,
    thresholdUsd: settings.thresholdUsd,
    source,
    low,
    checkedAt: now.toISOString(),
  });

  return {
    remainingUsd,
    thresholdUsd: settings.thresholdUsd,
    source,
    low,
    warned,
  };
}

function warningMessage(
  remainingUsd: number,
  source: CreditSource,
  settings: CreditSettings,
  state: CreditState,
): string {
  const usd = (n: number): string => `$${n.toFixed(2)}`;
  const basis =
    source === 'fal'
      ? 'This is the live balance reported by fal.ai.'
      : `This is an estimate: a ${usd(settings.monthlyBudgetUsd)} monthly ` +
        `budget less ${state.generations ?? 0} image(s) generated this month ` +
        `at ~${usd(settings.costPerImageUsd)} each. Configure a fal admin key ` +
        'to report the real balance.';
  return [
    `fal.ai credit is below the ${usd(settings.thresholdUsd)} warning ` +
      `threshold: ${usd(remainingUsd)} remaining.`,
    basis,
    'When the balance runs out fal rejects generations and posts will be ' +
      'staged without their illustrations. Top up at https://fal.ai/dashboard/billing.',
    'This warning is sent at most once a day.',
  ].join('\n\n');
}

/**
 * Add `count` freshly submitted generations to this month's tally — the
 * budget proxy's input. A read-modify-write: two overlapping `image-submit`
 * runs can drop an increment, which is tolerable for an early-warning estimate.
 */
export async function recordGenerations(
  stateParamName: string,
  count: number,
  now: Date = new Date(),
): Promise<void> {
  if (count <= 0) {
    return;
  }
  const state = forMonth(await readCreditState(stateParamName), now);
  await writeCreditState(stateParamName, {
    ...state,
    generations: (state.generations ?? 0) + count,
  });
}
