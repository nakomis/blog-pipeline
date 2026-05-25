jest.mock('ai');
jest.mock('../../../lambda/review/providers');
jest.mock('../../../lambda/review/drafts');

import { generateObject } from 'ai';
import { handler } from '../../../lambda/review/reviewer';
import { getDraft } from '../../../lambda/review/drafts';
import { reviewerModel } from '../../../lambda/review/providers';

const mockGenerateObject = generateObject as jest.Mock;
const mockGetDraft = getDraft as jest.Mock;
const mockReviewerModel = reviewerModel as jest.Mock;

const input = {
  slug: 'a-post',
  iteration: 1,
  draftKey: 'a-post/iteration-1/draft.md',
  provider: 'grok' as const,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetDraft.mockResolvedValue('# A draft post\n\nbody');
  mockReviewerModel.mockResolvedValue({ id: 'mock-model' });
});

test('returns an ok ReviewResult built from the model verdict', async () => {
  mockGenerateObject.mockResolvedValue({
    object: { score: 8, blocker: false, critique: 'solid' },
  });
  await expect(handler(input)).resolves.toEqual({
    provider: 'grok',
    status: 'ok',
    score: 8,
    blocker: false,
    critique: 'solid',
  });
});

test('feeds the draft and the verdict schema to generateObject', async () => {
  mockGenerateObject.mockResolvedValue({
    object: { score: 5, blocker: true, critique: 'x' },
  });
  await handler(input);
  expect(mockGetDraft).toHaveBeenCalledWith('a-post/iteration-1/draft.md');
  const call = mockGenerateObject.mock.calls[0][0];
  expect(call.prompt).toContain('# A draft post');
  expect(call.schema).toBeDefined();
});

test('does not swallow a provider failure — it throws for the Map to catch', async () => {
  mockGenerateObject.mockRejectedValue(new Error('provider down'));
  await expect(handler(input)).rejects.toThrow('provider down');
});
