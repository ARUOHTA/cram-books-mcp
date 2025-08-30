#!/usr/bin/env bash
set -euo pipefail

# Deploy latest HEAD to WebApp (new deployment) and test it via curl.
# This allows verifying code changes without any manual browser steps.
#
# Usage (GET with query string):
#   ./deploy_and_test.sh 'op=books.find&query=現代文レベル別'
#
# Usage (POST with JSON body):
#   ./deploy_and_test.sh -X POST -d '{"op":"books.filter","where":{"教科":"数学"}}'
#
# Notes:
# - Requires: clasp logged in, Apps Script API enabled, dist/* tracked by clasp
# - Creates a new deployment each time (anonymous access works for curl)
# - Prints DEPLOY_ID and the JSON response from the WebApp

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

echo "[1/3] Pushing latest script (clasp push)" >&2
clasp push >/dev/null || true

echo "[2/3] Creating new WebApp deployment (clasp deploy)" >&2
clasp deploy -d "auto-deploy $(date -u +%FT%TZ)" >/dev/null

DEPLOY_ID=$(clasp deployments | awk '/ @[0-9]+ /{gsub("@","",$3); print $2, $3}' | sort -k2,2n | tail -1 | awk '{print $1}')
if [[ -z "$DEPLOY_ID" ]]; then
  echo "Failed to resolve DEPLOY_ID. Run 'clasp deployments' to inspect." >&2
  exit 1
fi

BASE="https://script.google.com/macros/s/${DEPLOY_ID}/exec"
echo "DEPLOY_ID=${DEPLOY_ID}" >&2
echo "BASE_URL=${BASE}" >&2

echo "[3/3] Hitting WebApp via curl" >&2
# Normalize method to uppercase without requiring Bash 4+ (macOS compatibility)
METHOD_UC=$(printf '%s' "$method" | tr '[:lower:]' '[:upper:]')
if [ "$METHOD_UC" = "POST" ]; then
  if [[ -z "$data_json" ]]; then
    echo "Missing -d '<json>' for POST." >&2
    exit 1
  fi
  curl -sS -L -X POST "$BASE" \
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
