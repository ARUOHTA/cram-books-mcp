#!/usr/bin/env bash
set -euo pipefail

# Cloud Run へ MCP をデプロイするユーティリティ。
# 使い方:
#   source scripts/gcloud_env.example   # or set PROJECT_ID/REGION/SERVICE
#   scripts/deploy_mcp.sh

ROOT_DIR=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$ROOT_DIR"

PROJECT_ID=${PROJECT_ID:-$(gcloud config get-value project --quiet 2>/dev/null || true)}
if [[ -z "${PROJECT_ID}" || "${PROJECT_ID}" == "(unset)" ]]; then
  echo "PROJECT_ID is not set. Set env PROJECT_ID or run: gcloud config set project <ID>" >&2
  exit 2
fi

REGION=${REGION:-asia-northeast1}
SERVICE=${SERVICE:-cram-books-mcp}

if [[ -z "${EXEC_URL-}" ]]; then
  if [[ -f apps/gas/.prod_deploy_id ]]; then
    DEPLOY_ID=$(tr -d '\r\n' < apps/gas/.prod_deploy_id)
    EXEC_URL="https://script.google.com/macros/s/${DEPLOY_ID}/exec"
  else
    echo "apps/gas/.prod_deploy_id が見つかりません。EXEC_URL を明示してください。" >&2
    exit 2
  fi
fi

echo "PROJECT_ID=${PROJECT_ID} REGION=${REGION} SERVICE=${SERVICE}" >&2
gcloud run deploy "${SERVICE}" \
  --project "${PROJECT_ID}" \
  --source apps/mcp \
  --region "${REGION}" \
  --allow-unauthenticated \
  --set-env-vars EXEC_URL="${EXEC_URL}" \
  --timeout=300 \
  --port=8080 \
  --quiet

URL=$(gcloud run services describe "${SERVICE}" --project "${PROJECT_ID}" --region "${REGION}" --format='value(status.url)')
echo "SERVICE_URL=${URL}"

# ヘルスチェック（406が正常）
curl -i -sS "${URL}/mcp" | head -n 20 || true

