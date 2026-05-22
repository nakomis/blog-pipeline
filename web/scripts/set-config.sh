#!/bin/bash

# Generates web/public/config.json — the runtime config the SPA fetches on
# startup — from the SSM parameters published by the CDK stacks.
#
# Usage: scripts/set-config.sh [sandbox|prod|localhost]
#
# `localhost` reads the sandbox SSM parameters but points the OAuth redirect
# URIs at the Vite dev server.

set -euo pipefail

ENV="${1:-sandbox}"

case "$ENV" in
  localhost) AWS_ENV=sandbox ;;
  sandbox|prod) AWS_ENV=$ENV ;;
  *) echo "Unknown environment: $ENV (expected sandbox|prod|localhost)"; exit 1 ;;
esac

REGION=eu-west-2
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG_FILE="$WEB_DIR/public/config.json"

# In CI, configure-aws-credentials sets the credential env vars directly;
# only fall back to a named profile for local development.
if [[ -z "${AWS_ACCESS_KEY_ID:-}" ]]; then
  export AWS_PROFILE="nakom.is-$AWS_ENV"
fi

mkdir -p "$WEB_DIR/public"
cp "$WEB_DIR/config.template.json" "$CONFIG_FILE"

setValue() {
  local key="$1" value="$2" tmp
  tmp=$(mktemp)
  sed "s|\"$key\": \".*\"|\"$key\": \"$value\"|g" "$CONFIG_FILE" > "$tmp"
  mv "$tmp" "$CONFIG_FILE"
}

ssm() {
  aws ssm get-parameter --region "$REGION" --name "$1" \
    --query 'Parameter.Value' --output text
}

# The API has a stable custom domain, so its URL is derived from the
# environment rather than looked up from SSM.
SSM_PREFIX="/blog-pipeline/$AWS_ENV"
USER_POOL_ID=$(ssm "$SSM_PREFIX/cognito/user-pool-id")
CLIENT_ID=$(ssm "$SSM_PREFIX/cognito/client-id")
LOGIN_DOMAIN=$(ssm "$SSM_PREFIX/cognito/login-domain")

case "$ENV" in
  prod)
    APP_ORIGIN="https://pipeline.blog.nakomis.com"
    API_URL="https://api.pipeline.blog.nakomis.com"
    ;;
  sandbox)
    APP_ORIGIN="https://pipeline.blog.sandbox.nakomis.com"
    API_URL="https://api.pipeline.blog.sandbox.nakomis.com"
    ;;
  localhost)
    APP_ORIGIN="http://localhost:5173"
    # Local dev talks to the sandbox API — its CORS allows the localhost origin.
    API_URL="https://api.pipeline.blog.sandbox.nakomis.com"
    ;;
esac

setValue env "$ENV"
setValue apiUrl "$API_URL"
setValue authority "https://cognito-idp.$REGION.amazonaws.com/$USER_POOL_ID"
setValue clientId "$CLIENT_ID"
setValue domain "$LOGIN_DOMAIN"
setValue redirectUri "$APP_ORIGIN/loggedin"
setValue logoutUri "$APP_ORIGIN/logout"

echo "Wrote $CONFIG_FILE for env '$ENV'"
