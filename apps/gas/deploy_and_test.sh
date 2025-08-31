#!/usr/bin/env bash
set -euo pipefail

# Deploy latest HEAD to WebApp using a FIXED deployment ID (-i) and test it via curl.
# 固定デプロイID運用（URLを変えない）で、本番URLを常に不変にします。
#
# Usage (GET with query string):
#   ./deploy_and_test.sh 'op=books.find&query=現代文レベル別'
#
# Usage (POST with JSON body):
#   ./deploy_and_test.sh -d '{"op":"books.find","query":"青チャート"}'
#
# Notes:
# - Requires: clasp logged in, Apps Script API enabled
# - Uses fixed PROD_DEPLOY_ID (env PROD_DEPLOY_ID or file .prod_deploy_id)
# - Prints BASE_URL (stderr) and the JSON response (stdout)

method="GET"
data_json=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -X)
      method="$2"; shift 2 ;;
    -d)
      data_json="$2"; shift 2 ;;
    *)
      qs="${1}"; shift ;;
  esac
done

cd "$(dirname "$0")"

# Fixed production deployment ID resolution
if [[ -z "${PROD_DEPLOY_ID-}" ]]; then
  if [[ -f .prod_deploy_id ]]; then
    PROD_DEPLOY_ID=$(tr -d '\r\n' < .prod_deploy_id)
  else
    echo "Missing PROD_DEPLOY_ID. Set env PROD_DEPLOY_ID or create apps/gas/.prod_deploy_id with the deployment ID." >&2
    exit 1
  fi
fi

# Build from src to dist before pushing
echo "[1/4] Building GAS bundle (npm run build)" >&2
npm run --silent build || true

echo "[2/4] Pushing latest script (clasp push)" >&2
clasp push >/dev/null || true

echo "[3/4] Re-deploy fixed PROD deployment (clasp deploy -i)" >&2
clasp deploy -i "$PROD_DEPLOY_ID" -d "redeploy $(date -u +%FT%TZ)" >/dev/null

BASE="https://script.google.com/macros/s/${PROD_DEPLOY_ID}/exec"
echo "PROD_DEPLOY_ID=${PROD_DEPLOY_ID}" >&2
echo "BASE_URL=${BASE}" >&2

echo "[4/4] Hitting WebApp via curl" >&2
# Normalize method to uppercase without requiring Bash 4+ (macOS compatibility)
METHOD_UC=$(printf '%s' "$method" | tr '[:lower:]' '[:upper:]')
if [ "$METHOD_UC" = "POST" ] || [ -n "$data_json" ]; then
  if [[ -z "$data_json" ]]; then
    echo "Missing -d '<json>' for POST." >&2
    exit 1
  fi
  # Important: With Apps Script Web Apps, a 302 redirect to script.googleusercontent.com occurs.
  # Do NOT force POST across redirects (--post302/303). Let curl follow (-L) normally without -X,
  # and set Content-Type explicitly so doPost(e) receives JSON.
  curl -sS -L "$BASE" \
    -H 'Content-Type: application/json' \
    -d "$data_json"
else
  if [[ -z "${qs-}" ]]; then
    echo "Usage: $0 'op=books.find&query=現代文レベル別'" >&2
    exit 1
  fi
  # Support multiple query params split by '&' and encode each
  args=( )
  IFS='&' read -r -a parts <<< "$qs"
  for p in "${parts[@]}"; do
    args+=( --data-urlencode "$p" )
  done
  curl -sS -L --get "${args[@]}" "$BASE"
fi
