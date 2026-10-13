import type { APIGatewayProxyEvent } from 'aws-lambda';

jest.mock('../../../lambda/images/credit', () => ({
  readCreditState: jest.fn(),
}));

import { imageCredit } from '../../../lambda/api/image-credit';
import { readCreditState } from '../../../lambda/images/credit';

const mockRead = readCreditState as jest.Mock;
const event = { headers: {} } as unknown as APIGatewayProxyEvent;

beforeEach(() => {
  mockRead.mockReset();
  process.env.FAL_CREDIT_STATE_PARAM_NAME = '/bp/image/fal-credit-state';
});

test('returns the latest snapshot without internal bookkeeping', async () => {
  mockRead.mockResolvedValue({
    month: '2026-10',
    generations: 12,
    lastWarnedOn: '2026-10-13',
    remainingUsd: 3.2,
    thresholdUsd: 5,
    source: 'fal',
    low: true,
    checkedAt: '2026-10-13T09:00:00.000Z',
  });

  const res = await imageCredit(event);

  expect(mockRead).toHaveBeenCalledWith('/bp/image/fal-credit-state');
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body)).toEqual({
    low: true,
    remainingUsd: 3.2,
    thresholdUsd: 5,
    source: 'fal',
    checkedAt: '2026-10-13T09:00:00.000Z',
  });
});

test('reports not-low before any check has run', async () => {
  mockRead.mockResolvedValue({});
  const res = await imageCredit(event);
  expect(JSON.parse(res.body)).toEqual({ low: false });
});

test('500s when the parameter name is not configured', async () => {
  delete process.env.FAL_CREDIT_STATE_PARAM_NAME;
  const res = await imageCredit(event);
  expect(res.statusCode).toBe(500);
});
