#!/usr/bin/env bash
#
# Computes the next semantic version for blog-pipeline and writes it to
# infra/version.json.
#
# The previous version is read from the deployment tracker (CLOUD-15); if the
# tracker is unreachable — not yet wired up, no record, no credentials — the
# committed version.json is used instead. The sandbox environment is the
# high-water mark: it always deploys, whereas prod may lag a pending approval.
#
# The bump is driven by the latest commit message:
#   --bump-major  →  X.0.0
#   --bump-minor  →  0.X.0
#   (default)     →  0.0.X
#
# The new version is written to version.json and echoed to stdout, so CI can
# capture it once and deploy the *same* value to every environment.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(dirname "$SCRIPT_DIR")"
VERSION_FILE="$INFRA_DIR/version.json"

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-eu-west-2}}"
TRACKER_URL="https://tracker.nakomis.com/deployments/blog-pipeline/sandbox/latest"

LATEST=""
if [[ -n "${AWS_ACCESS_KEY_ID:-}" ]]; then
  SIGV4=(--aws-sigv4 "aws:amz:${REGION}:execute-api"
         --user "${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}")
  if [[ -n "${AWS_SESSION_TOKEN:-}" ]]; then
    SIGV4+=(-H "x-amz-security-token: ${AWS_SESSION_TOKEN}")
  fi
  RESPONSE="$(curl -sS "${SIGV4[@]}" "$TRACKER_URL" 2>/dev/null || true)"
  LATEST="$(jq -r '.version // empty' <<< "$RESPONSE" 2>/dev/null || true)"
fi

CURRENT="${LATEST:-$(jq -r '.version' "$VERSION_FILE")}"
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
MAJOR="${MAJOR:-0}"
MINOR="${MINOR:-1}"
PATCH="${PATCH:-0}"

MESSAGE="${COMMIT_MESSAGE:-$(git log -1 --pretty=%B 2>/dev/null || true)}"
if grep -q -- '--bump-major' <<< "$MESSAGE"; then
  MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0
elif grep -q -- '--bump-minor' <<< "$MESSAGE"; then
  MINOR=$((MINOR + 1)); PATCH=0
else
  PATCH=$((PATCH + 1))
fi

NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"
printf '{\n  "version": "%s"\n}\n' "$NEW_VERSION" > "$VERSION_FILE"
echo "blog-pipeline version: ${CURRENT} → ${NEW_VERSION}" >&2
echo "$NEW_VERSION"
