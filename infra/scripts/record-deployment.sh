#!/usr/bin/env bash
#
# Records a blog-pipeline deployment in the deployment tracker (CLOUD-15).
#
# Non-fatal by design: a tracker outage — or the tracker simply not being wired
# up yet — must never fail a deployment. Failures are logged; the script exits 0.
#
# Usage: record-deployment.sh <sandbox|prod>
set -uo pipefail

ENVIRONMENT="${1:?usage: record-deployment.sh <sandbox|prod>}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(dirname "$SCRIPT_DIR")"
VERSION="$(jq -r '.version' "$INFRA_DIR/version.json")"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-eu-west-2}}"
TRACKER_URL="https://api.infra.nakomis.com/deployments/blog-pipeline/${ENVIRONMENT}"

if [[ -z "${AWS_ACCESS_KEY_ID:-}" ]]; then
  echo "No AWS credentials — skipping deployment record" >&2
  exit 0
fi

BODY="$(jq -nc \
  --arg version "$VERSION" \
  --arg commitHash "$(git rev-parse HEAD 2>/dev/null || echo unknown)" \
  --arg branch "$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)" \
  '{version: $version, commitHash: $commitHash, branch: $branch, deployedBy: "github-actions"}')"

SIGV4=(--aws-sigv4 "aws:amz:${REGION}:execute-api"
       --user "${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}")
if [[ -n "${AWS_SESSION_TOKEN:-}" ]]; then
  SIGV4+=(-H "x-amz-security-token: ${AWS_SESSION_TOKEN}")
fi

HTTP_CODE="$(curl -sS -o /dev/null -w '%{http_code}' "${SIGV4[@]}" \
  -X PUT -H 'Content-Type: application/json' -d "$BODY" \
  "$TRACKER_URL" 2>/dev/null || echo 000)"

if [[ "$HTTP_CODE" == "200" ]]; then
  echo "Recorded blog-pipeline ${VERSION} → ${ENVIRONMENT} in the deployment tracker"
else
  echo "WARNING: could not record deployment (HTTP ${HTTP_CODE}) — the tracker" \
       "may not be wired up yet (CLOUD-15). Continuing." >&2
fi
exit 0
