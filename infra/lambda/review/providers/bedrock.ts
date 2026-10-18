import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import type { LanguageModel } from 'ai';
import { REVIEW } from '../../../lib/config';

/**
 * Bedrock models — the Nova Pro reviewer and the Claude Sonnet redrafter.
 *
 * Both authenticate with the Lambda's IAM role via the standard AWS credential
 * chain, so there is no secret to read. The provider is built once at module
 * load and reused.
 */
const bedrock = createAmazonBedrock();

/** The Bedrock reviewer model — Amazon Nova Pro. */
export async function reviewerModel(): Promise<LanguageModel> {
  return bedrock(REVIEW.models.bedrock);
}

/** The redraft model — Claude Sonnet on Bedrock. */
export function redraftModel(): LanguageModel {
  return bedrock(REVIEW.redraftModel);
}
