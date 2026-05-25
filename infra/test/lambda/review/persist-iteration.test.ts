import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

jest.mock('../../../lambda/review/drafts', () => ({
  ...jest.requireActual('../../../lambda/review/drafts'),
  putReviews: jest.fn(),
}));

import { handler } from '../../../lambda/review/persist-iteration';
import { putReviews } from '../../../lambda/review/drafts';
import type { GateOutput } from '../../../lambda/review/gate';
import type { ReviewResult } from '../../../lambda/review/schema';

const ddbMock = mockClient(DynamoDBDocumentClient);
const mockPutReviews = putReviews as jest.Mock;

const reviews: ReviewResult[] = [
  { provider: 'bedrock', status: 'ok', score: 8, blocker: false, critique: 'c' },
];

beforeEach(() => {
  ddbMock.reset();
  jest.clearAllMocks();
  process.env.POSTS_TABLE_NAME = 'posts';
  mockPutReviews.mockResolvedValue(undefined);
});

test('persists reviews.json and the /100 score when there is a verdict', async () => {
  ddbMock.on(UpdateCommand).resolves({});
  const gate: GateOutput = {
    decision: 'pass',
    minScore: 8,
    anyBlocker: false,
    okCount: 3,
    capped: false,
  };
  await handler({ slug: 'a-post', iteration: 2, reviews, gate });

  expect(mockPutReviews).toHaveBeenCalledWith(
    'a-post/iteration-2/reviews.json',
    expect.objectContaining({ slug: 'a-post', iteration: 2 }),
  );
  const update = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
  expect(update.ExpressionAttributeValues?.[':score']).toBe(80);
});

test('skips the score when no reviewer returned a verdict', async () => {
  ddbMock.on(UpdateCommand).resolves({});
  const gate: GateOutput = {
    decision: 'fail-quorum',
    minScore: null,
    anyBlocker: false,
    okCount: 0,
    capped: false,
  };
  await handler({ slug: 'a-post', iteration: 1, reviews: [], gate });
  const update = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
  expect(update.UpdateExpression).not.toContain('publishabilityScore');
});
