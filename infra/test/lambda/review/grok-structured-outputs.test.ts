import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { APICallError, generateObject } from 'ai';
import {
  reviewerModel,
  isStructuredOutputRejection,
  structuredOutputsEnabled,
} from '../../../lambda/review/providers/grok';
import { ReviewVerdict } from '../../../lambda/review/schema';

/**
 * PIPE-30: Grok asks for `response_format: json_schema` (behind
 * `GROK_STRUCTURED_OUTPUTS`, default on) and falls back once to plain JSON
 * mode when the Foundry deployment rejects it. Foundry is never called — the
 * real AI SDK provider runs against a mocked `fetch`.
 */
const ssmMock = mockClient(SSMClient);

const VERDICT = { score: 7, blocker: false, critique: 'Solid draft.' };

function completion(): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 0,
      model: 'grok-4.3',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: JSON.stringify(VERDICT) },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function rejection(status = 400, message =
  "Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model."): Response {
  return new Response(
    JSON.stringify({ error: { code: 'invalid_request_error', message } }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

/** The provider-level call `generateObject` does not exercise. */
type StreamingModel = { doStream: (options: unknown) => Promise<unknown> };

let fetchMock: jest.SpyInstance;
let warnMock: jest.SpyInstance;

/** The `response_format` sent on each chat-completions request. */
function sentFormats(): unknown[] {
  return fetchMock.mock.calls.map(
    ([, init]) => JSON.parse((init as RequestInit).body as string).response_format,
  );
}

/**
 * Our fallback warnings. The AI SDK also warns (via `console.warn`) whenever
 * a schema is sent in plain JSON mode; that is expected and ignored here.
 */
function fallbackWarnings(): unknown[][] {
  return warnMock.mock.calls.filter(([text]) =>
    /rejected structured outputs/.test(String(text)),
  );
}

async function review() {
  const { object } = await generateObject({
    model: await reviewerModel(),
    schema: ReviewVerdict,
    prompt: 'Review this draft.',
    maxRetries: 0,
  });
  return object;
}

beforeEach(() => {
  ssmMock.reset();
  process.env.GROK_PARAM_NAME = '/blog-pipeline/test/reviewer/grok';
  delete process.env.GROK_STRUCTURED_OUTPUTS;
  ssmMock.on(GetParameterCommand).resolves({
    Parameter: {
      Value: JSON.stringify({
        apiKey: 'k',
        endpoint: 'https://nakomis-foundry.services.ai.azure.com/',
        deployment: 'grok-4.3',
        apiVersion: '2024-05-01-preview',
      }),
    },
  });
  fetchMock = jest.spyOn(globalThis, 'fetch');
  warnMock = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  fetchMock.mockRestore();
  warnMock.mockRestore();
  delete process.env.GROK_PARAM_NAME;
  delete process.env.GROK_STRUCTURED_OUTPUTS;
});

describe('Grok structured outputs (PIPE-30)', () => {
  test('structured on and accepted: one json_schema request, no warning', async () => {
    fetchMock.mockResolvedValueOnce(completion());

    await expect(review()).resolves.toEqual(VERDICT);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      'https://nakomis-foundry.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview',
    );
    expect(sentFormats()[0]).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'response', strict: true },
    });
    expect(fallbackWarnings()).toHaveLength(0);
  });

  test('structured on but rejected: retries once in json_object mode and warns', async () => {
    fetchMock.mockResolvedValueOnce(rejection()).mockResolvedValueOnce(completion());

    await expect(review()).resolves.toEqual(VERDICT);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentFormats()).toEqual([
      expect.objectContaining({ type: 'json_schema' }),
      { type: 'json_object' },
    ]);
    expect(fallbackWarnings()).toHaveLength(1);
    const [text, detail] = fallbackWarnings()[0];
    expect(text).toMatch(/grok-4\.3.*rejected structured outputs/);
    expect(detail).toMatchObject({
      statusCode: 400,
      url: expect.stringContaining('/models/chat/completions'),
      responseBody: expect.stringContaining("'json_schema' is not supported"),
    });
  });

  test('a 422 naming response_format also falls back', async () => {
    fetchMock
      .mockResolvedValueOnce(rejection(422, 'extra parameter response_format not permitted'))
      .mockResolvedValueOnce(completion());

    await expect(review()).resolves.toEqual(VERDICT);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('the fallback is attempted only once', async () => {
    fetchMock.mockResolvedValueOnce(rejection()).mockResolvedValueOnce(rejection());

    await expect(review()).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('an unrelated 400 is not retried', async () => {
    fetchMock.mockResolvedValueOnce(rejection(400, 'Content filter triggered'));

    await expect(review()).rejects.toThrow(/Content filter/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fallbackWarnings()).toHaveLength(0);
  });

  test('flag off: a single json_object request, no structured attempt', async () => {
    process.env.GROK_STRUCTURED_OUTPUTS = 'false';
    fetchMock.mockResolvedValueOnce(completion());

    await expect(review()).resolves.toEqual(VERDICT);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentFormats()).toEqual([{ type: 'json_object' }]);
    expect(fallbackWarnings()).toHaveLength(0);
  });

  test('streaming falls back the same way', async () => {
    fetchMock.mockResolvedValueOnce(rejection());
    const fallbackStream = jest.fn();
    const model = (await reviewerModel()) as unknown as StreamingModel;
    fetchMock.mockImplementationOnce(async () => {
      fallbackStream();
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      responseFormat: { type: 'json', schema: { type: 'object' } },
    });
    expect(fallbackStream).toHaveBeenCalledTimes(1);
    expect(fallbackWarnings()).toHaveLength(1);
  });

  test('a non-rejection streaming error is rethrown', async () => {
    fetchMock.mockResolvedValueOnce(rejection(500, 'boom'));
    const model = (await reviewerModel()) as unknown as StreamingModel;
    await expect(
      model.doStream({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      }),
    ).rejects.toThrow();
    expect(fallbackWarnings()).toHaveLength(0);
  });
});

describe('structuredOutputsEnabled', () => {
  test.each([
    [undefined, true],
    ['true', true],
    ['1', true],
    ['false', false],
    [' OFF ', false],
    ['0', false],
    ['no', false],
  ])('GROK_STRUCTURED_OUTPUTS=%p → %p', (value, expected) => {
    if (value === undefined) delete process.env.GROK_STRUCTURED_OUTPUTS;
    else process.env.GROK_STRUCTURED_OUTPUTS = value;
    expect(structuredOutputsEnabled()).toBe(expected);
  });
});

describe('isStructuredOutputRejection', () => {
  const apiError = (statusCode: number, responseBody?: string) =>
    new APICallError({
      message: 'Bad Request',
      url: 'https://x/models/chat/completions',
      requestBodyValues: {},
      statusCode,
      responseBody,
    });

  test('matches a 400 naming json_schema', () => {
    expect(isStructuredOutputRejection(apiError(400, 'json_schema unsupported'))).toBe(true);
  });

  test('ignores other statuses, other messages and non-API errors', () => {
    expect(isStructuredOutputRejection(apiError(500, 'json_schema'))).toBe(false);
    expect(isStructuredOutputRejection(apiError(400, 'max_tokens too large'))).toBe(false);
    expect(isStructuredOutputRejection(apiError(400))).toBe(false);
    expect(isStructuredOutputRejection(new Error('response_format'))).toBe(false);
  });
});
