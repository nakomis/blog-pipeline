import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import { REVIEW } from '../../../lib/config';
import { readSecretJson, requireEnv } from '../runtime';

/** Google Gemini reviewer — API key from the Gemini reviewer secret. */
interface GeminiSecret {
  apiKey: string;
}

export async function reviewerModel(): Promise<LanguageModel> {
  const secret = await readSecretJson<GeminiSecret>(
    requireEnv('GEMINI_SECRET_ID'),
  );
  const google = createGoogleGenerativeAI({ apiKey: secret.apiKey });
  return google(REVIEW.models.gemini);
}
