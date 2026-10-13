import { mockClient } from 'aws-sdk-client-mock';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import {
  GetParameterCommand,
  ParameterNotFound,
  PutParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';

jest.mock('../../../lambda/images/fal', () => ({ fetchFalBalance: jest.fn() }));

import {
  checkFalCredit,
  creditSettings,
  readCreditState,
  recordGenerations,
  type CreditState,
} from '../../../lambda/images/credit';
import { fetchFalBalance } from '../../../lambda/images/fal';

const ssmMock = mockClient(SSMClient);
const snsMock = mockClient(SNSClient);
const mockBalance = fetchFalBalance as jest.Mock;

const STATE = '/bp/image/fal-credit-state';
const ADMIN = '/bp/image/fal-admin';
const TOPIC = 'arn:aws:sns:eu-west-2:123456789012:blog-pipeline-alerts-sandbox';
const NOW = new Date('2026-10-13T09:00:00Z');

/** Stub the two SSM parameters; `admin` undefined means "not found". */
function stubParams(state: CreditState | string, admin?: string): void {
  ssmMock.on(GetParameterCommand, { Name: STATE }).resolves({
    Parameter: {
      Value: typeof state === 'string' ? state : JSON.stringify(state),
    },
  });
  if (admin === undefined) {
    ssmMock
      .on(GetParameterCommand, { Name: ADMIN })
      .rejects(new ParameterNotFound({ message: 'nope', $metadata: {} }));
  } else {
    ssmMock
      .on(GetParameterCommand, { Name: ADMIN })
      .resolves({ Parameter: { Value: admin } });
  }
}

/** The state JSON most recently written back. */
function writtenState(): CreditState {
  const calls = ssmMock.commandCalls(PutParameterCommand);
  expect(calls.length).toBeGreaterThan(0);
  return JSON.parse(calls[calls.length - 1].args[0].input.Value as string);
}

const check = () =>
  checkFalCredit({
    stateParamName: STATE,
    adminParamName: ADMIN,
    topicArn: TOPIC,
    now: NOW,
  });

beforeEach(() => {
  ssmMock.reset();
  snsMock.reset();
  mockBalance.mockReset();
  ssmMock.on(PutParameterCommand).resolves({});
  snsMock.on(PublishCommand).resolves({ MessageId: 'm-1' });
  delete process.env.FAL_CREDIT_WARN_THRESHOLD_USD;
  delete process.env.FAL_MONTHLY_BUDGET_USD;
  delete process.env.FAL_COST_PER_IMAGE_USD;
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

describe('creditSettings', () => {
  test('defaults to a $5 threshold, $25 budget and $0.06 per image', () => {
    expect(creditSettings()).toEqual({
      thresholdUsd: 5,
      monthlyBudgetUsd: 25,
      costPerImageUsd: 0.06,
    });
  });

  test('honours env overrides and ignores junk', () => {
    process.env.FAL_CREDIT_WARN_THRESHOLD_USD = '12.5';
    process.env.FAL_MONTHLY_BUDGET_USD = 'lots';
    process.env.FAL_COST_PER_IMAGE_USD = '-1';
    expect(creditSettings()).toEqual({
      thresholdUsd: 12.5,
      monthlyBudgetUsd: 25,
      costPerImageUsd: 0.06,
    });
  });
});

describe('checkFalCredit — live fal balance', () => {
  test('credit fine: no warning, snapshot recorded', async () => {
    stubParams({}, 'ADMIN_KEY');
    mockBalance.mockResolvedValue(42.5);

    const out = await check();

    expect(mockBalance).toHaveBeenCalledWith('ADMIN_KEY');
    expect(out).toEqual({
      remainingUsd: 42.5,
      thresholdUsd: 5,
      source: 'fal',
      low: false,
      warned: false,
    });
    expect(snsMock.commandCalls(PublishCommand)).toHaveLength(0);
    expect(writtenState()).toMatchObject({
      remainingUsd: 42.5,
      source: 'fal',
      low: false,
      checkedAt: NOW.toISOString(),
    });
  });

  test('credit low: publishes one warning to the alerts topic', async () => {
    stubParams({}, 'ADMIN_KEY');
    mockBalance.mockResolvedValue(3.2);

    const out = await check();

    expect(out).toMatchObject({ low: true, warned: true, source: 'fal' });
    const calls = snsMock.commandCalls(PublishCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.TopicArn).toBe(TOPIC);
    expect(calls[0].args[0].input.Message).toContain('$3.20 remaining');
    expect(calls[0].args[0].input.Message).toContain('live balance');
    expect(writtenState()).toMatchObject({
      low: true,
      lastWarnedOn: '2026-10-13',
    });
  });

  test('only warns once per day', async () => {
    stubParams({ lastWarnedOn: '2026-10-13' }, 'ADMIN_KEY');
    mockBalance.mockResolvedValue(1);

    const out = await check();

    expect(out).toMatchObject({ low: true, warned: false });
    expect(snsMock.commandCalls(PublishCommand)).toHaveLength(0);
    expect(writtenState().lastWarnedOn).toBe('2026-10-13');
  });

  test('warns again on a later day', async () => {
    stubParams({ lastWarnedOn: '2026-10-12' }, 'ADMIN_KEY');
    mockBalance.mockResolvedValue(1);

    const out = await check();

    expect(out.warned).toBe(true);
    expect(writtenState().lastWarnedOn).toBe('2026-10-13');
  });

  test('a failed publish is retried on the next run', async () => {
    stubParams({ lastWarnedOn: '2026-10-12' }, 'ADMIN_KEY');
    mockBalance.mockResolvedValue(1);
    snsMock.on(PublishCommand).rejects(new Error('sns down'));

    const out = await check();

    expect(out.warned).toBe(false);
    expect(writtenState().lastWarnedOn).toBe('2026-10-12');
  });
});

describe('checkFalCredit — budget proxy', () => {
  test('used when the admin key is still the deploy placeholder', async () => {
    stubParams(
      { month: '2026-10', generations: 100 },
      'REPLACE WITH JSON — see README → Review loop',
    );

    const out = await check();

    expect(mockBalance).not.toHaveBeenCalled();
    // $25 − 100 × $0.06 = $19
    expect(out).toMatchObject({ remainingUsd: 19, source: 'budget', low: false });
    expect(snsMock.commandCalls(PublishCommand)).toHaveLength(0);
  });

  test('used when the admin key parameter is missing', async () => {
    stubParams({ month: '2026-10', generations: 350 });

    const out = await check();

    // $25 − 350 × $0.06 = $4 < $5
    expect(out).toMatchObject({ remainingUsd: 4, source: 'budget', low: true });
    const message = snsMock.commandCalls(PublishCommand)[0].args[0].input
      .Message as string;
    expect(message).toContain('estimate');
    expect(message).toContain('350 image(s)');
  });

  test('used when the fal billing call fails', async () => {
    stubParams({ month: '2026-10', generations: 0 }, 'ADMIN_KEY');
    mockBalance.mockRejectedValue(new Error('fal billing lookup failed (403)'));

    const out = await check();

    expect(out).toMatchObject({ remainingUsd: 25, source: 'budget' });
  });

  test('resets the generation count when the month rolls over', async () => {
    stubParams({ month: '2026-09', generations: 999 });

    const out = await check();

    expect(out).toMatchObject({ remainingUsd: 25, low: false });
    expect(writtenState()).toMatchObject({ month: '2026-10', generations: 0 });
  });

  test('works without an admin parameter name at all', async () => {
    stubParams({});
    const out = await checkFalCredit({
      stateParamName: STATE,
      topicArn: TOPIC,
      now: NOW,
    });
    expect(out.source).toBe('budget');
  });
});

describe('readCreditState', () => {
  test('reads empty for a missing parameter', async () => {
    ssmMock
      .on(GetParameterCommand)
      .rejects(new ParameterNotFound({ message: 'nope', $metadata: {} }));
    await expect(readCreditState(STATE)).resolves.toEqual({});
  });

  test('reads empty for unparseable or non-object JSON', async () => {
    stubParams('not json');
    await expect(readCreditState(STATE)).resolves.toEqual({});
    stubParams('null');
    await expect(readCreditState(STATE)).resolves.toEqual({});
  });

  test('rethrows other SSM errors', async () => {
    ssmMock.on(GetParameterCommand).rejects(new Error('throttled'));
    await expect(readCreditState(STATE)).rejects.toThrow('throttled');
  });
});

describe('recordGenerations', () => {
  test('adds to this month’s tally', async () => {
    stubParams({ month: '2026-10', generations: 4, low: false });
    await recordGenerations(STATE, 3, NOW);
    expect(writtenState()).toMatchObject({
      month: '2026-10',
      generations: 7,
      low: false,
    });
  });

  test('starts a fresh tally in a new month', async () => {
    stubParams({ month: '2026-09', generations: 40 });
    await recordGenerations(STATE, 2, NOW);
    expect(writtenState()).toMatchObject({ month: '2026-10', generations: 2 });
  });

  test('writes nothing when nothing was submitted', async () => {
    await recordGenerations(STATE, 0, NOW);
    expect(ssmMock.calls()).toHaveLength(0);
  });
});
