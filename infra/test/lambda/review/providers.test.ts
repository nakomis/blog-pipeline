import { mockClient } from 'aws-sdk-client-mock';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import {
  reviewerModel,
  redraftModel,
} from '../../../lambda/review/providers';
import { requireEnv, readSecretJson } from '../../../lambda/review/runtime';

const secretsMock = mockClient(SecretsManagerClient);

beforeEach(() => {
  secretsMock.reset();
  delete process.env.AZURE_SECRET_ID;
  delete process.env.GEMINI_SECRET_ID;
  delete process.env.ANTHROPIC_SECRET_ID;
});

describe('reviewerModel registry', () => {
  test('bedrock needs no secret and builds a model', async () => {
    await expect(reviewerModel('bedrock')).resolves.toBeDefined();
  });

  test('azure reads its secret and builds a model', async () => {
    process.env.AZURE_SECRET_ID = 'azure-secret';
    secretsMock.on(GetSecretValueCommand, { SecretId: 'azure-secret' }).resolves({
      SecretString: JSON.stringify({
        apiKey: 'k',
        resourceName: 'my-resource',
        deployment: 'gpt-5-pro',
        apiVersion: '2024-10-01',
      }),
    });
    await expect(reviewerModel('azure')).resolves.toBeDefined();
  });

  test('gemini reads its secret and builds a model', async () => {
    process.env.GEMINI_SECRET_ID = 'gemini-secret';
    secretsMock.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({ apiKey: 'k' }),
    });
    await expect(reviewerModel('gemini')).resolves.toBeDefined();
  });

  test('anthropic reads its secret and builds a model', async () => {
    process.env.ANTHROPIC_SECRET_ID = 'anthropic-secret';
    secretsMock.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({ apiKey: 'k' }),
    });
    await expect(reviewerModel('anthropic')).resolves.toBeDefined();
  });

  test('a provider whose secret env var is unset rejects', async () => {
    await expect(reviewerModel('azure')).rejects.toThrow(/AZURE_SECRET_ID/);
  });
});

describe('redraftModel', () => {
  test('builds the Bedrock redraft model with no secret', () => {
    expect(redraftModel()).toBeDefined();
  });
});

describe('runtime helpers', () => {
  test('requireEnv returns a set variable', () => {
    process.env.GEMINI_SECRET_ID = 'present';
    expect(requireEnv('GEMINI_SECRET_ID')).toBe('present');
  });

  test('requireEnv throws on an unset variable', () => {
    expect(() => requireEnv('GEMINI_SECRET_ID')).toThrow(/GEMINI_SECRET_ID/);
  });

  test('readSecretJson parses the secret string', async () => {
    secretsMock.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({ hello: 'world' }),
    });
    await expect(readSecretJson('any')).resolves.toEqual({ hello: 'world' });
  });

  test('readSecretJson throws when the secret has no string value', async () => {
    secretsMock.on(GetSecretValueCommand).resolves({});
    await expect(readSecretJson('empty')).rejects.toThrow(/no string value/);
  });
});
