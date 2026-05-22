import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { handler } from '../../../lambda/review/set-outcome';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
  process.env.POSTS_TABLE_NAME = 'posts';
});

test('records a clean pass as staged/passed with no error detail', async () => {
  ddbMock.on(UpdateCommand).resolves({});
  const out = await handler({
    slug: 'a-post',
    status: 'staged',
    reviewOutcome: 'passed',
  });
  expect(out).toEqual({
    slug: 'a-post',
    status: 'staged',
    reviewOutcome: 'passed',
  });
  const update = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
  expect(update.ExpressionAttributeValues?.[':status']).toBe('staged');
  expect(update.ExpressionAttributeValues?.[':outcome']).toBe('passed');
  expect(update.UpdateExpression).not.toContain('reviewError');
});

test('records a failure with the error detail', async () => {
  ddbMock.on(UpdateCommand).resolves({});
  await handler({
    slug: 'a-post',
    status: 'failed',
    reviewOutcome: 'exception',
    error: 'state machine blew up',
  });
  const update = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
  expect(update.UpdateExpression).toContain('reviewError');
  expect(update.ExpressionAttributeValues?.[':error']).toBe(
    'state machine blew up',
  );
});
