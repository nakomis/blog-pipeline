import { mockClient } from 'aws-sdk-client-mock';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
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
const lambdaMock = mockClient(LambdaClient);
const mockDraftExists = draftExists as jest.Mock;

beforeEach(() => {
  ddbMock.reset();
  lambdaMock.reset();
  jest.clearAllMocks();
  process.env.POSTS_TABLE_NAME = 'posts';
  delete process.env.IMAGE_SUBMIT_FUNCTION_NAME;
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
    providers: ['azure', 'gemini', 'anthropic', 'grok'],
  });
  const update = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
  expect(update.ExpressionAttributeValues?.[':reviewing']).toBe('reviewing');
});

test('fire-and-forgets an image-submit invoke when configured (PIPE-6)', async () => {
  process.env.IMAGE_SUBMIT_FUNCTION_NAME = 'image-submit-fn';
  ddbMock.on(GetCommand).resolves({ Item: { slug: 'a-post', status: 'queued' } });
  ddbMock.on(UpdateCommand).resolves({});
  mockDraftExists.mockResolvedValue(true);
  lambdaMock.on(InvokeCommand).resolves({});

  await handler({ slug: 'a-post' });

  const calls = lambdaMock.commandCalls(InvokeCommand);
  expect(calls).toHaveLength(1);
  expect(calls[0].args[0].input).toMatchObject({
    FunctionName: 'image-submit-fn',
    InvocationType: 'Event',
  });
});

test('a failed image-submit invoke never fails the review (PIPE-6)', async () => {
  process.env.IMAGE_SUBMIT_FUNCTION_NAME = 'image-submit-fn';
  ddbMock.on(GetCommand).resolves({ Item: { slug: 'a-post', status: 'queued' } });
  ddbMock.on(UpdateCommand).resolves({});
  mockDraftExists.mockResolvedValue(true);
  lambdaMock.on(InvokeCommand).rejects(new Error('lambda unavailable'));

  await expect(handler({ slug: 'a-post' })).resolves.toMatchObject({
    slug: 'a-post',
    iteration: 1,
  });
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
