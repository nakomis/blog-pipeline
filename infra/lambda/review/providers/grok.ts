import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { APICallError, wrapLanguageModel } from 'ai';
import type { LanguageModel, LanguageModelMiddleware } from 'ai';
import { readParameterJson, requireEnv } from '../runtime';

/**
 * Grok-on-Foundry reviewer.
 *
 * Azure AI Foundry exposes xAI Grok models behind an OpenAI-compatible
 * `/models/chat/completions` endpoint, authenticated with an `api-key` header
 * and an `api-version` query parameter. The full Foundry hostname, deployment
 * name, key and version are all account-specific, so the whole connection is
 * stored as JSON in the Grok reviewer SSM parameter.
 *
 * Note this is *not* the same shape as the Azure OpenAI reviewer (`azure.ts`),
 * which targets the classic `https://<resource>.openai.azure.com/openai/...`
 * URL — Foundry's inference endpoint is a different surface.
 *
 * Structured outputs (PIPE-30): like `azure.ts`, we ask for
 * `response_format: json_schema` so the verdict is constrained to our schema.
 * We do not yet know whether the Foundry Grok deployment accepts it, so:
 *
 * - `GROK_STRUCTURED_OUTPUTS` (default on) switches it on or off;
 * - when on, a request the deployment rejects for its `response_format` is
 *   retried once in plain `json_object` mode, and a warning is logged with
 *   what the deployment said.
 */
interface GrokSecret {
  apiKey: string;
  /** Full Foundry hostname, e.g. `https://<instance>.services.ai.azure.com`. */
  endpoint: string;
  /** Foundry deployment name, e.g. `grok-4.3`. */
  deployment: string;
  /** Foundry inference API version, e.g. `2024-05-01-preview`. */
  apiVersion: string;
}

/** Values of `GROK_STRUCTURED_OUTPUTS` that switch structured outputs off. */
const OFF_VALUES = new Set(['false', '0', 'off', 'no']);

/** Whether to ask Grok for structured outputs. Unset means on. */
export function structuredOutputsEnabled(): boolean {
  const raw = process.env.GROK_STRUCTURED_OUTPUTS;
  return raw === undefined || !OFF_VALUES.has(raw.trim().toLowerCase());
}

/**
 * Whether an error is the deployment refusing our structured request: an HTTP
 * 400 (or 422, which Azure's inference API uses for unsupported parameters)
 * whose message or body mentions `response_format` / `json_schema`.
 */
export function isStructuredOutputRejection(err: unknown): err is APICallError {
  if (!APICallError.isInstance(err)) return false;
  if (err.statusCode !== 400 && err.statusCode !== 422) return false;
  const detail = `${err.message} ${err.responseBody ?? ''}`;
  return /response_format|json_schema|responseformat|jsonschema/i.test(detail);
}

/** The provider-level (v3) model type that `wrapLanguageModel` accepts. */
type ProviderModel = Parameters<typeof wrapLanguageModel>[0]['model'];

/** Longest response body we copy into the fallback warning. */
const MAX_LOGGED_BODY = 2000;

/**
 * Middleware that retries a rejected structured request once on `fallback`,
 * the same deployment built without structured outputs.
 */
function structuredOutputFallback(
  fallback: ProviderModel,
  deployment: string,
): LanguageModelMiddleware {
  const warn = (err: APICallError) =>
    console.warn(
      `Grok deployment '${deployment}' rejected structured outputs ` +
        '(response_format: json_schema); retrying once without them. ' +
        'Set GROK_STRUCTURED_OUTPUTS=false to skip the structured attempt.',
      {
        statusCode: err.statusCode,
        url: err.url,
        message: err.message,
        responseBody: err.responseBody?.slice(0, MAX_LOGGED_BODY),
      },
    );
  return {
    specificationVersion: 'v3',
    wrapGenerate: async ({ doGenerate, params }) => {
      try {
        return await doGenerate();
      } catch (err) {
        if (!isStructuredOutputRejection(err)) throw err;
        warn(err);
        return fallback.doGenerate(params);
      }
    },
    wrapStream: async ({ doStream, params }) => {
      try {
        return await doStream();
      } catch (err) {
        if (!isStructuredOutputRejection(err)) throw err;
        warn(err);
        return fallback.doStream(params);
      }
    },
  };
}

export async function reviewerModel(): Promise<LanguageModel> {
  const secret = await readParameterJson<GrokSecret>(
    requireEnv('GROK_PARAM_NAME'),
  );
  const baseURL = `${secret.endpoint.replace(/\/$/, '')}/models`;
  const build = (supportsStructuredOutputs: boolean) =>
    createOpenAICompatible({
      name: 'grok-foundry',
      baseURL,
      headers: { 'api-key': secret.apiKey },
      queryParams: { 'api-version': secret.apiVersion },
      supportsStructuredOutputs,
    })(secret.deployment);

  if (!structuredOutputsEnabled()) return build(false);
  return wrapLanguageModel({
    model: build(true),
    middleware: structuredOutputFallback(build(false), secret.deployment),
  });
}
