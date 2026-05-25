import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import { REVIEW } from '../../../lib/config';
import { readParameterJson, requireEnv } from '../runtime';

/** Google Gemini reviewer — API key from the Gemini reviewer SSM parameter. */
interface GeminiSecret {
  apiKey: string;
}

export async function reviewerModel(): Promise<LanguageModel> {
  const secret = await readParameterJson<GeminiSecret>(
    requireEnv('GEMINI_PARAM_NAME'),
  );
  const google = createGoogleGenerativeAI({ apiKey: secret.apiKey });
  return google(REVIEW.models.gemini);
}
