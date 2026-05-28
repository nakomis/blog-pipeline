import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

jest.mock('../../../lambda/images/fal', () => ({ submitImage: jest.fn() }));
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

beforeEach(() => {
  ddbMock.reset();
  jest.clearAllMocks();
  process.env.POSTS_TABLE_NAME = 'posts';
  process.env.IMAGE_JOBS_TABLE_NAME = 'jobs';
  process.env.DRAFTS_BUCKET = 'drafts';
  process.env.FAL_PARAM_NAME = '/image/fal';
  process.env.IMAGE_CALLBACK_URL = 'https://api.example.com/image-callback';
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
