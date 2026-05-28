import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

/**
 * Shared runtime plumbing for the review Lambdas — environment access and
 * SSM Parameter Store reads.
 *
 * The reviewer keys live in plain-`String` SSM parameters (not Secrets Manager
 * and not `SecureString`) for cost: each `String` parameter is free, whereas
 * a Secrets Manager secret is billed per-secret per-month. The keys are still
 * scoped by IAM — only the reviewer Lambda role can read this prefix.
 */

const ssm = new SSMClient({});

/** Read a required environment variable, throwing a clear error if unset. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

/**
 * Fetch an SSM parameter's raw string value.
 *
 * Throws if the parameter has no value — an empty placeholder left over from the
 * stack's first deploy, before the operator populated it by hand.
 */
export async function readParameterString(name: string): Promise<string> {
  const res = await ssm.send(new GetParameterCommand({ Name: name }));
  const value = res.Parameter?.Value;
  if (!value) {
    throw new Error(`SSM parameter ${name} has no value`);
  }
  return value;
}

/**
 * Fetch and JSON-parse an SSM parameter.
 *
 * Throws if the parameter has no value (an empty placeholder left over from
 * the stack's first deploy, before the operator ran `put-parameter`) — that
 * surfaces as a provider failure, which the reviewer fan-out then records as
 * `unavailable` rather than failing the iteration.
 */
export async function readParameterJson<T>(name: string): Promise<T> {
  const res = await ssm.send(new GetParameterCommand({ Name: name }));
  const value = res.Parameter?.Value;
  if (!value) {
    throw new Error(`SSM parameter ${name} has no value`);
  }
  return JSON.parse(value) as T;
}
