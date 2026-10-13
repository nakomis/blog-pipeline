import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from 'aws-lambda';
import { readCreditState } from '../images/credit';
import { corsHeaders, jsonResponse } from './http';

/**
 * `GET /image-credit` — the latest fal.ai credit snapshot (PIPE-34), recorded
 * by `image-submit`'s pre-flight check. The dashboard shows a banner when
 * `low` is true. Before the first check has run the snapshot is simply
 * `{ low: false }`.
 */
export async function imageCredit(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const cors = corsHeaders(event);
  const name = process.env.FAL_CREDIT_STATE_PARAM_NAME;
  if (!name) {
    return jsonResponse(
      500,
      { message: 'FAL_CREDIT_STATE_PARAM_NAME is not configured' },
      cors,
    );
  }

  const state = await readCreditState(name);
  return jsonResponse(
    200,
    {
      low: state.low === true,
      remainingUsd: state.remainingUsd,
      thresholdUsd: state.thresholdUsd,
      source: state.source,
      checkedAt: state.checkedAt,
    },
    cors,
  );
}
