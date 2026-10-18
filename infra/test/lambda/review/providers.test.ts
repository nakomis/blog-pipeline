import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  reviewerModel,
  redraftModel,
  suggestModel,
} from '../../../lambda/review/providers';
import { requireEnv, readParameterJson } from '../../../lambda/review/runtime';

const ssmMock = mockClient(SSMClient);

beforeEach(() => {
  ssmMock.reset();
  delete process.env.AZURE_PARAM_NAME;
  delete process.env.GEMINI_PARAM_NAME;
  delete process.env.ANTHROPIC_PARAM_NAME;
  delete process.env.GROK_PARAM_NAME;
});

describe('reviewerModel registry', () => {
  test('azure reads its parameter and builds a model', async () => {
    process.env.AZURE_PARAM_NAME = '/blog-pipeline/test/reviewer/azure';
    ssmMock
      .on(GetParameterCommand, { Name: '/blog-pipeline/test/reviewer/azure' })
      .resolves({
        Parameter: {
          Value: JSON.stringify({
            apiKey: 'k',
            endpoint: 'https://nakomis-foundry.services.ai.azure.com',
            deployment: 'gpt-5',
            apiVersion: '2024-05-01-preview',
          }),
        },
      });
    await expect(reviewerModel('azure')).resolves.toBeDefined();
  });

  test('gemini reads its parameter and builds a model', async () => {
    process.env.GEMINI_PARAM_NAME = '/blog-pipeline/test/reviewer/gemini';
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify({ apiKey: 'k' }) },
    });
    await expect(reviewerModel('gemini')).resolves.toBeDefined();
  });

  test('anthropic reads its parameter and builds a model', async () => {
    process.env.ANTHROPIC_PARAM_NAME = '/blog-pipeline/test/reviewer/anthropic';
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify({ apiKey: 'k' }) },
    });
    await expect(reviewerModel('anthropic')).resolves.toBeDefined();
  });

  test('grok reads its parameter and builds a model', async () => {
    process.env.GROK_PARAM_NAME = '/blog-pipeline/test/reviewer/grok';
    ssmMock
      .on(GetParameterCommand, { Name: '/blog-pipeline/test/reviewer/grok' })
      .resolves({
        Parameter: {
          Value: JSON.stringify({
            apiKey: 'k',
            endpoint: 'https://nakomis-foundry.services.ai.azure.com',
            deployment: 'grok-4.3',
            apiVersion: '2024-05-01-preview',
          }),
        },
      });
    await expect(reviewerModel('grok')).resolves.toBeDefined();
  });

  test('a provider whose parameter env var is unset rejects', async () => {
    await expect(reviewerModel('azure')).rejects.toThrow(/AZURE_PARAM_NAME/);
  });

  test('grok rejects when its parameter env var is unset', async () => {
    await expect(reviewerModel('grok')).rejects.toThrow(/GROK_PARAM_NAME/);
  });
});

describe('redraftModel', () => {
  test('builds the Bedrock redraft model with no parameter', () => {
    expect(redraftModel()).toBeDefined();
  });
});

describe('runtime helpers', () => {
  test('requireEnv returns a set variable', () => {
    process.env.GEMINI_PARAM_NAME = 'present';
    expect(requireEnv('GEMINI_PARAM_NAME')).toBe('present');
  });

  test('requireEnv throws on an unset variable', () => {
    expect(() => requireEnv('GEMINI_PARAM_NAME')).toThrow(/GEMINI_PARAM_NAME/);
  });

  test('readParameterJson parses the parameter value', async () => {
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify({ hello: 'world' }) },
    });
    await expect(readParameterJson('any')).resolves.toEqual({ hello: 'world' });
  });

  test('readParameterJson throws when the parameter has no value', async () => {
    ssmMock.on(GetParameterCommand).resolves({});
    await expect(readParameterJson('empty')).rejects.toThrow(/no value/);
  });
});

describe('suggestModel (PIPE-38)', () => {
  test('reads the reviewer’s Anthropic key and builds Claude Haiku on the direct API', async () => {
    process.env.ANTHROPIC_PARAM_NAME = '/blog-pipeline/test/reviewer/anthropic';
    ssmMock
      .on(GetParameterCommand, { Name: '/blog-pipeline/test/reviewer/anthropic' })
      .resolves({ Parameter: { Value: JSON.stringify({ apiKey: 'k' }) } });
    const model = await suggestModel();
    expect(model).toMatchObject({ modelId: 'claude-haiku-5-5', provider: expect.stringContaining('anthropic') });
  });

  test('fails clearly when the key parameter is not configured', async () => {
    delete process.env.ANTHROPIC_PARAM_NAME;
    await expect(suggestModel()).rejects.toThrow('ANTHROPIC_PARAM_NAME');
  });
});
