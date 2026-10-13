import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

jest.mock('../../../lambda/images/fal', () => ({ submitImage: jest.fn() }));
jest.mock('../../../lambda/images/credit', () => ({
  checkFalCredit: jest.fn(),
  recordGenerations: jest.fn(),
}));
jest.mock('../../../lambda/images/jobs', () => ({ putJob: jest.fn() }));
jest.mock('../../../lambda/images/store', () => ({ imageExists: jest.fn() }));
jest.mock('../../../lambda/review/drafts', () => ({
  ...jest.requireActual('../../../lambda/review/drafts'),
  getDraft: jest.fn(),
}));
jest.mock('../../../lambda/review/runtime', () => ({
  ...jest.requireActual('../../../lambda/review/runtime'),
  readParameterString: jest.fn(),
}));

import { handler } from '../../../lambda/review/image-submit';
import { submitImage } from '../../../lambda/images/fal';
import {
  checkFalCredit,
  recordGenerations,
} from '../../../lambda/images/credit';
import { putJob } from '../../../lambda/images/jobs';
import { imageExists } from '../../../lambda/images/store';
import { getDraft } from '../../../lambda/review/drafts';
import { readParameterString } from '../../../lambda/review/runtime';

const ddbMock = mockClient(DynamoDBDocumentClient);
const mockSubmit = submitImage as jest.Mock;
const mockPutJob = putJob as jest.Mock;
const mockImageExists = imageExists as jest.Mock;
const mockGetDraft = getDraft as jest.Mock;
const mockReadParam = readParameterString as jest.Mock;
const mockCheckCredit = checkFalCredit as jest.Mock;
const mockRecordGenerations = recordGenerations as jest.Mock;

beforeEach(() => {
  ddbMock.reset();
  jest.clearAllMocks();
  process.env.POSTS_TABLE_NAME = 'posts';
  process.env.IMAGE_JOBS_TABLE_NAME = 'jobs';
  process.env.DRAFTS_BUCKET = 'drafts';
  process.env.FAL_PARAM_NAME = '/image/fal';
  process.env.IMAGE_CALLBACK_URL = 'https://api.example.com/image-callback';
  process.env.FAL_CREDIT_STATE_PARAM_NAME = '/image/fal-credit-state';
  process.env.FAL_ADMIN_PARAM_NAME = '/image/fal-admin';
  process.env.ALERTS_TOPIC_ARN = 'arn:aws:sns:eu-west-2:1:alerts';
  mockCheckCredit.mockResolvedValue({ low: false, warned: false });
  mockRecordGenerations.mockResolvedValue(undefined);
  ddbMock.on(UpdateCommand).resolves({});
  mockReadParam.mockResolvedValue('FAL_KEY');
  let n = 0;
  mockSubmit.mockImplementation(() => Promise.resolve(`req-${++n}`));
});

test('submits a fal job per placeholder and records them on the post', async () => {
  mockGetDraft.mockResolvedValue(
    '{{image prompt="one"}}\nbody\n{{image prompt="two"}}',
  );
  mockImageExists.mockResolvedValue(false);

  const out = await handler({ slug: 'a-post' });

  expect(out).toEqual({ slug: 'a-post', submitted: 2, skipped: 0 });
  expect(mockSubmit).toHaveBeenCalledTimes(2);
  expect(mockPutJob).toHaveBeenCalledTimes(2);
  expect(mockPutJob).toHaveBeenCalledWith(
    expect.objectContaining({ slug: 'a-post', index: 1, prompt: 'one' }),
  );

  const update = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
  expect(update.ExpressionAttributeValues?.[':images']).toEqual([
    { index: 1, prompt: 'one', status: 'pending', key: 'a-post/images/a-post-1.png' },
    { index: 2, prompt: 'two', status: 'pending', key: 'a-post/images/a-post-2.png' },
  ]);
});

test('passes a tag-named model through to submit and the job row (PIPE-27)', async () => {
  mockGetDraft.mockResolvedValue(
    '{{image prompt="a labelled diagram" model="gpt-image-2"}}',
  );
  mockImageExists.mockResolvedValue(false);

  await handler({ slug: 'a-post' });

  expect(mockSubmit).toHaveBeenCalledWith(
    expect.objectContaining({ model: 'gpt-image-2' }),
  );
  expect(mockPutJob).toHaveBeenCalledWith(
    expect.objectContaining({ index: 1, model: 'gpt-image-2' }),
  );
});

test('skips a placeholder whose image already exists (idempotent re-run)', async () => {
  mockGetDraft.mockResolvedValue(
    '{{image prompt="one"}}\n{{image prompt="two"}}',
  );
  mockImageExists.mockImplementation((_slug: string, index: number) =>
    Promise.resolve(index === 1),
  );

  const out = await handler({ slug: 'a-post' });

  expect(out).toEqual({ slug: 'a-post', submitted: 1, skipped: 1 });
  expect(mockSubmit).toHaveBeenCalledTimes(1);
});

test('does nothing — and never reads the fal key — with no placeholders', async () => {
  mockGetDraft.mockResolvedValue('a plain post, no images');

  const out = await handler({ slug: 'a-post' });

  expect(out).toEqual({ slug: 'a-post', submitted: 0, skipped: 0 });
  expect(mockReadParam).not.toHaveBeenCalled();
  expect(mockSubmit).not.toHaveBeenCalled();
  expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
});

describe('fal credit pre-flight (PIPE-34)', () => {
  beforeEach(() => {
    mockGetDraft.mockResolvedValue(
      '{{image prompt="one"}}\n{{image prompt="two"}}',
    );
    mockImageExists.mockResolvedValue(false);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  test('checks credit before submitting and records the generations', async () => {
    await handler({ slug: 'a-post' });

    expect(mockCheckCredit).toHaveBeenCalledWith({
      stateParamName: '/image/fal-credit-state',
      adminParamName: '/image/fal-admin',
      topicArn: 'arn:aws:sns:eu-west-2:1:alerts',
    });
    expect(mockCheckCredit.mock.invocationCallOrder[0]).toBeLessThan(
      mockSubmit.mock.invocationCallOrder[0],
    );
    expect(mockRecordGenerations).toHaveBeenCalledWith(
      '/image/fal-credit-state',
      2,
    );
  });

  test('low credit still generates every image', async () => {
    mockCheckCredit.mockResolvedValue({ low: true, warned: true });

    const out = await handler({ slug: 'a-post' });

    expect(out).toEqual({ slug: 'a-post', submitted: 2, skipped: 0 });
  });

  test('a failing credit check or tally never blocks generation', async () => {
    mockCheckCredit.mockRejectedValue(new Error('ssm down'));
    mockRecordGenerations.mockRejectedValue(new Error('ssm down'));

    const out = await handler({ slug: 'a-post' });

    expect(out).toEqual({ slug: 'a-post', submitted: 2, skipped: 0 });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
  });

  test('is skipped when the credit wiring is not configured', async () => {
    delete process.env.FAL_CREDIT_STATE_PARAM_NAME;
    delete process.env.ALERTS_TOPIC_ARN;

    const out = await handler({ slug: 'a-post' });

    expect(out.submitted).toBe(2);
    expect(mockCheckCredit).not.toHaveBeenCalled();
    expect(mockRecordGenerations).not.toHaveBeenCalled();
  });
});
