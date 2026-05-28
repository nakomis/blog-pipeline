import type { APIGatewayProxyEvent } from 'aws-lambda';

jest.mock('../../../lambda/images/verify', () => ({
  verifyFalSignature: jest.fn(),
  fetchFalJwks: jest.fn().mockResolvedValue({ keys: [] }),
  extractFalHeaders: jest.fn().mockReturnValue({}),
}));
jest.mock('../../../lambda/images/jobs', () => ({
  getJob: jest.fn(),
  markJobDone: jest.fn(),
  markJobFailed: jest.fn(),
}));
jest.mock('../../../lambda/images/store', () => ({
  downloadImage: jest.fn(),
  putImage: jest.fn(),
}));
jest.mock('../../../lambda/images/placeholders', () => ({
  applyPlaceholders: jest.fn(),
  defaultApplyDeps: jest.fn().mockReturnValue({}),
}));

import { imageCallback } from '../../../lambda/api/image-callback';
import { verifyFalSignature } from '../../../lambda/images/verify';
import { getJob, markJobDone, markJobFailed } from '../../../lambda/images/jobs';
import { downloadImage, putImage } from '../../../lambda/images/store';
import { applyPlaceholders } from '../../../lambda/images/placeholders';

const mockVerify = verifyFalSignature as jest.Mock;
const mockGetJob = getJob as jest.Mock;
const mockMarkDone = markJobDone as jest.Mock;
const mockMarkFailed = markJobFailed as jest.Mock;
const mockDownload = downloadImage as jest.Mock;
const mockPutImage = putImage as jest.Mock;
const mockApply = applyPlaceholders as jest.Mock;

function event(body: unknown, isBase64Encoded = false): APIGatewayProxyEvent {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    body: isBase64Encoded ? Buffer.from(raw).toString('base64') : raw,
    isBase64Encoded,
    headers: {},
  } as unknown as APIGatewayProxyEvent;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockVerify.mockReturnValue(true);
});

test('rejects an invalid signature with 401 and touches no job', async () => {
  mockVerify.mockReturnValue(false);
  const res = await imageCallback(event({ request_id: 'r' }));
  expect(res.statusCode).toBe(401);
  expect(mockGetJob).not.toHaveBeenCalled();
});

test('acknowledges an unknown request_id without doing work', async () => {
  mockGetJob.mockResolvedValue(undefined);
  const res = await imageCallback(event({ request_id: 'gone', status: 'OK' }));
  expect(res.statusCode).toBe(200);
  expect(mockDownload).not.toHaveBeenCalled();
});

test('marks the job failed on a fal ERROR and does not store an image', async () => {
  mockGetJob.mockResolvedValue({ slug: 'a-post', index: 1 });
  const res = await imageCallback(event({ request_id: 'r', status: 'ERROR' }));
  expect(res.statusCode).toBe(200);
  expect(mockMarkFailed).toHaveBeenCalledWith('r');
  expect(mockPutImage).not.toHaveBeenCalled();
});

test('on OK: stores the image, marks done, and applies placeholders', async () => {
  mockGetJob.mockResolvedValue({ slug: 'a-post', index: 2 });
  mockDownload.mockResolvedValue(new Uint8Array([1, 2, 3]));

  const res = await imageCallback(
    event({
      request_id: 'r',
      status: 'OK',
      images: [{ url: 'https://fal.example/img.png' }],
    }),
  );

  expect(res.statusCode).toBe(200);
  expect(mockDownload).toHaveBeenCalledWith('https://fal.example/img.png');
  expect(mockPutImage).toHaveBeenCalledWith('a-post', 2, expect.any(Uint8Array));
  expect(mockMarkDone).toHaveBeenCalledWith('r');
  expect(mockApply).toHaveBeenCalledWith('a-post', expect.anything());
});

test('verifies the signature over the decoded body when base64-encoded', async () => {
  mockGetJob.mockResolvedValue(undefined);
  await imageCallback(event({ request_id: 'r', status: 'OK' }, true));
  const rawBody = mockVerify.mock.calls[0][0].rawBody as Buffer;
  expect(JSON.parse(rawBody.toString('utf8'))).toMatchObject({
    request_id: 'r',
  });
});

test('rejects a malformed JSON body with 400', async () => {
  const res = await imageCallback(event('not json{', false));
  expect(res.statusCode).toBe(400);
});
