import { mockClient } from 'aws-sdk-client-mock';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { publishNow } from '../../../lambda/api/publish-now';

const secretsMock = mockClient(SecretsManagerClient);

function event(): APIGatewayProxyEvent {
  return { headers: {} } as unknown as APIGatewayProxyEvent;
}

beforeEach(() => {
  secretsMock.reset();
  secretsMock.on(GetSecretValueCommand).resolves({ SecretString: 'ghp_token' });
  process.env.GITHUB_DISPATCH_SECRET_ARN =
    'arn:aws:secretsmanager:eu-west-2:1:secret:blog-pipeline-github-dispatch-prod';
});

afterEach(() => {
  delete process.env.GITHUB_DISPATCH_SECRET_ARN;
});

// The handler caches the fetched token in a module-level variable that survives
// across tests (it is only cleared on a 401/403). The empty-secret case must
// therefore run before any test populates that cache, so it stays first.
test('throws when the secret is empty', async () => {
  secretsMock.on(GetSecretValueCommand).resolves({ SecretString: '  ' });
  global.fetch = jest.fn() as unknown as typeof fetch;

  await expect(publishNow(event())).rejects.toThrow(/empty/);
});

test('dispatches the workflow and returns 202 on a 204 from GitHub', async () => {
  const fetchMock = jest
    .fn()
    .mockResolvedValue({ status: 204, text: async () => '' });
  global.fetch = fetchMock as unknown as typeof fetch;

  const res = await publishNow(event());

  expect(res.statusCode).toBe(202);
  expect(JSON.parse(res.body)).toMatchObject({ dispatched: true });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe(
    'https://api.github.com/repos/nakomis/blog-content/actions/workflows/promote-approved.yml/dispatches',
  );
  expect(init.method).toBe('POST');
  expect(init.headers.Authorization).toBe('Bearer ghp_token');
  expect(JSON.parse(init.body)).toEqual({ ref: 'main' });
});

test('returns 502 when GitHub does not return 204', async () => {
  const fetchMock = jest
    .fn()
    .mockResolvedValue({ status: 422, text: async () => 'bad ref' });
  global.fetch = fetchMock as unknown as typeof fetch;

  const res = await publishNow(event());

  expect(res.statusCode).toBe(502);
});
