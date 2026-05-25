jest.mock('ai');
jest.mock('../../../lambda/review/providers');
jest.mock('../../../lambda/review/drafts', () => ({
  ...jest.requireActual('../../../lambda/review/drafts'),
  getDraft: jest.fn(),
  putDraft: jest.fn(),
}));

import { generateText } from 'ai';
import { handler } from '../../../lambda/review/redraft';
import { getDraft, putDraft } from '../../../lambda/review/drafts';
import { redraftModel } from '../../../lambda/review/providers';
import type { ReviewResult } from '../../../lambda/review/schema';

const mockGenerateText = generateText as jest.Mock;
const mockGetDraft = getDraft as jest.Mock;
const mockPutDraft = putDraft as jest.Mock;
const mockRedraftModel = redraftModel as jest.Mock;

const reviews: ReviewResult[] = [
  {
    provider: 'grok',
    status: 'ok',
    score: 6,
    blocker: false,
    critique: 'tighten the intro',
  },
  { provider: 'azure', status: 'unavailable', error: 'pending approval' },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockGetDraft.mockResolvedValue('old draft');
  mockPutDraft.mockResolvedValue(undefined);
  mockRedraftModel.mockReturnValue({ id: 'sonnet' });
  mockGenerateText.mockResolvedValue({ text: 'new draft' });
});

test('writes the next iteration draft and returns the next loop state', async () => {
  const out = await handler({
    slug: 'a-post',
    iteration: 1,
    draftKey: 'a-post/iteration-1/draft.md',
    reviews,
  });
  expect(out.iteration).toBe(2);
  expect(out.draftKey).toBe('a-post/iteration-2/draft.md');
  expect(out.providers).toHaveLength(4);
  expect(mockPutDraft).toHaveBeenCalledWith(
    'a-post/iteration-2/draft.md',
    'new draft',
  );
});

test('feeds the current draft and the ok critiques to the model', async () => {
  await handler({
    slug: 'a-post',
    iteration: 1,
    draftKey: 'a-post/iteration-1/draft.md',
    reviews,
  });
  const call = mockGenerateText.mock.calls[0][0];
  expect(call.prompt).toContain('old draft');
  expect(call.prompt).toContain('tighten the intro');
});
