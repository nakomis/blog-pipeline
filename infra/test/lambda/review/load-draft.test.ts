import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

jest.mock('../../../lambda/review/drafts', () => ({
  ...jest.requireActual('../../../lambda/review/drafts'),
  draftExists: jest.fn(),
}));

import { handler } from '../../../lambda/review/load-draft';
import { draftExists } from '../../../lambda/review/drafts';

const ddbMock = mockClient(DynamoDBDocumentClient);
const mockDraftExists = draftExists as jest.Mock;

beforeEach(() => {
  ddbMock.reset();
  jest.clearAllMocks();
  process.env.POSTS_TABLE_NAME = 'posts';
});

test('marks the post reviewing and returns the starting state', async () => {
  ddbMock.on(GetCommand).resolves({ Item: { slug: 'a-post', status: 'queued' } });
  ddbMock.on(UpdateCommand).resolves({});
  mockDraftExists.mockResolvedValue(true);

  const out = await handler({ slug: 'a-post' });
  expect(out).toEqual({
    slug: 'a-post',
    iteration: 1,
    draftKey: 'a-post/iteration-1/draft.md',
    providers: ['bedrock', 'azure', 'gemini', 'anthropic'],
  });
  const update = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
  expect(update.ExpressionAttributeValues?.[':reviewing']).toBe('reviewing');
});

test('throws when the post item is missing', async () => {
  ddbMock.on(GetCommand).resolves({});
  await expect(handler({ slug: 'ghost' })).rejects.toThrow(/No post item/);
});

test('throws when the iteration-1 draft object is missing', async () => {
  ddbMock.on(GetCommand).resolves({ Item: { slug: 'a-post' } });
  mockDraftExists.mockResolvedValue(false);
  await expect(handler({ slug: 'a-post' })).rejects.toThrow(/No draft object/);
});
