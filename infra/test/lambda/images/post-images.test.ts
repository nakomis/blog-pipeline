import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { setImageStatus } from '../../../lambda/images/post-images';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
  process.env.POSTS_TABLE_NAME = 'posts';
});

test('updates the indexed image slot, guarded by the index', async () => {
  ddbMock.on(UpdateCommand).resolves({});

  await setImageStatus('p', 2, 'ready');

  const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
  // index 2 → list position 1.
  expect(input.UpdateExpression).toBe('SET images[1].#st = :st');
  expect(input.ConditionExpression).toBe('images[1].#ix = :ix');
  expect(input.ExpressionAttributeValues).toEqual({ ':st': 'ready', ':ix': 2 });
});

test('is best-effort: a failed update is swallowed', async () => {
  ddbMock.on(UpdateCommand).rejects(new Error('conditional check failed'));
  await expect(setImageStatus('p', 1, 'failed')).resolves.toBeUndefined();
});
