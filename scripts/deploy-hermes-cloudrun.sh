# Hermes 日报服务 → Cloud Run + 飞书 + 定时推送
# 用法（Git Bash 或 WSL）:
#   export GCP_PROJECT_ID=furever-dock-hermes-agent
#   bash scripts/deploy-hermes-cloudrun.sh
#
# PowerShell:
#   $env:GCP_PROJECT_ID="furever-dock-hermes-agent"
#   bash scripts/deploy-hermes-cloudrun.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$ROOT/apps/hermes"
cd "$ROOT"

GCP_PROJECT_ID="${GCP_PROJECT_ID:-furever-dock-hermes-agent}"
REGION="${GCP_REGION:-us-central1}"
SERVICE_NAME="${HERMES_SERVICE_NAME:-hermes-report}"
REPO_NAME="${ARTIFACT_REPO:-hermes-agent}"
IMAGE_NAME="${HERMES_IMAGE_NAME:-hermes-report}"
SCHEDULER_JOB="${HERMES_SCHEDULER_JOB:-hermes-daily-report}"

# Git Bash on Windows: `gcloud` shell wrapper exits 49; use gcloud.cmd.
# Resolve to the FULL path so the space in "...\Cloud SDK\..." can't split the
# command — always invoke as "${GCLOUD}" (quoted) below.
GCLOUD="gcloud"
if command -v gcloud.cmd &>/dev/null; then
  GCLOUD="$(command -v gcloud.cmd)"
fi

if [[ ! -f "$ROOT/.env" ]]; then
  echo "ERROR: $ROOT/.env not found" >&2
  exit 1
fi

# Load dotenv values without evaluating them as shell code. This also accepts
# CRLF handover files created on Windows and preserves '=' inside values.
while IFS='=' read -r key value || [[ -n "$key" ]]; do
  key="${key%$'\r'}"
  value="${value%$'\r'}"
  [[ -z "$key" || "$key" =~ ^[[:space:]]*# ]] && continue
  export "$key=$value"
done < "$ROOT/.env"

# .env 里本地调试用的 HTTPS_PROXY 会导致 gcloud / Cloud Build 连接失败
unset HTTPS_PROXY HTTP_PROXY ALL_PROXY https_proxy http_proxy all_proxy

for key in AMPLITUDE_API_KEY AMPLITUDE_SECRET_KEY AMPLITUDE_RETENTION_CHART_IDS GEMINI_API_KEY \
  FEISHU_APP_ID FEISHU_APP_SECRET HERMES_CRON_SECRET FEISHU_REPORT_CHAT_ID; do
  if [[ -z "${!key:-}" ]]; then
    echo "ERROR: .env missing $key (deploy前请填好飞书 chat_id 等)" >&2
    exit 1
  fi
done

REGISTRY="${REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${REPO_NAME}"
TAG="v-$(date +%Y%m%d-%H%M%S)"
IMAGE="${HERMES_DEPLOY_IMAGE:-${REGISTRY}/${IMAGE_NAME}:${TAG}}"

echo "==> GCP project: $GCP_PROJECT_ID"
"${GCLOUD}" config set project "$GCP_PROJECT_ID"

echo "==> Enable APIs..."
"${GCLOUD}" services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com cloudscheduler.googleapis.com --quiet

echo "==> Artifact Registry (idempotent)..."
if ! "${GCLOUD}" artifacts repositories describe "$REPO_NAME" --location="$REGION" &>/dev/null; then
  "${GCLOUD}" artifacts repositories create "$REPO_NAME" \
    --repository-format=docker --location="$REGION"
fi

if [[ -n "${HERMES_DEPLOY_IMAGE:-}" ]]; then
  echo "==> Reusing prebuilt image: $IMAGE"
else
  echo "==> Build & push: $IMAGE"
  "${GCLOUD}" builds submit "$APP_DIR" --tag "$IMAGE" --timeout=1200
fi

echo "==> Deploy Cloud Run: $SERVICE_NAME"
# 生产环境无需 HTTPS_PROXY；Gemini / Amplitude 在 GCP 上直连
ENV_VARS_FILE="$(mktemp)"
trap 'rm -f "$ENV_VARS_FILE"' EXIT
cat > "$ENV_VARS_FILE" <<EOF
AMPLITUDE_API_KEY: "${AMPLITUDE_API_KEY}"
AMPLITUDE_SECRET_KEY: "${AMPLITUDE_SECRET_KEY}"
AMPLITUDE_RETENTION_CHART_IDS: "${AMPLITUDE_RETENTION_CHART_IDS}"
AMPLITUDE_DAILY_CHART_IDS: "${AMPLITUDE_DAILY_CHART_IDS:-ilhu9t17,1n0bfs5k,bh0r0h4o,ji5sqoml,5of8047n}"
AMPLITUDE_DASHBOARD_URL: "${AMPLITUDE_DASHBOARD_URL:-}"
GEMINI_API_KEY: "${GEMINI_API_KEY}"
GEMINI_MODEL: "${GEMINI_MODEL:-gemini-2.5-flash}"
FEISHU_APP_ID: "${FEISHU_APP_ID}"
FEISHU_APP_SECRET: "${FEISHU_APP_SECRET}"
FEISHU_REPORT_CHAT_ID: "${FEISHU_REPORT_CHAT_ID}"
FEISHU_BOT_OPEN_ID: "${FEISHU_BOT_OPEN_ID:-}"
FEISHU_WIKI_SPACE_IDS: "${FEISHU_WIKI_SPACE_IDS:-}"
FEISHU_WIKI_ROOT_TOKENS: "${FEISHU_WIKI_ROOT_TOKENS:-}"
FEISHU_WIKI_DOC_TOKENS: "${FEISHU_WIKI_DOC_TOKENS:-}"
FEISHU_WIKI_INDEX_DOC_TOKEN: "${FEISHU_WIKI_INDEX_DOC_TOKEN:-}"
FEISHU_COCO_ANALYSIS_DOC_TOKEN: "${FEISHU_COCO_ANALYSIS_DOC_TOKEN:-}"
FEISHU_COCO_BEHAVIOR_DOC_TOKEN: "${FEISHU_COCO_BEHAVIOR_DOC_TOKEN:-}"
FEISHU_COCO_SKILL_DOC_TOKEN: "${FEISHU_COCO_SKILL_DOC_TOKEN:-}"
HERMES_CRON_SECRET: "${HERMES_CRON_SECRET}"
HERMES_AGENT_ENABLED: "${HERMES_AGENT_ENABLED:-}"
STRIPE_API_KEY: "${STRIPE_API_KEY:-}"
COCO_MCP_KEY: "${COCO_MCP_KEY:-}"
HERMES_MCP_ENABLED: "${HERMES_MCP_ENABLED:-}"
HERMES_MCP_SERVERS: "${HERMES_MCP_SERVERS:-}"
EOF
"${GCLOUD}" run deploy "$SERVICE_NAME" \
  --image "$IMAGE" \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --timeout 300 \
  --memory 512Mi \
  --min-instances 0 \
  --no-cpu-throttling \
  --env-vars-file "$ENV_VARS_FILE"

SERVICE_URL="$("${GCLOUD}" run services describe "$SERVICE_NAME" --region "$REGION" --format='value(status.url)')"
echo ""
echo "==> Service URL: $SERVICE_URL"
echo "    飞书事件回调: ${SERVICE_URL}/feishu/events"
echo "    日报预览:     ${SERVICE_URL}/hermes/report"
echo ""

if [[ "${SKIP_SCHEDULER_UPDATE:-0}" == "1" ]]; then
  echo "==> Cloud Scheduler update skipped (SKIP_SCHEDULER_UPDATE=1)"
else
  echo "==> Cloud Scheduler (每天北京时间 9:00)"
  # --message-body="{}" 是必须的：POST 无 body 时 Google Frontend 返回 411 Length Required
  if "${GCLOUD}" scheduler jobs describe "$SCHEDULER_JOB" --location="$REGION" &>/dev/null; then
    "${GCLOUD}" scheduler jobs update http "$SCHEDULER_JOB" \
      --location="$REGION" \
      --schedule="0 9 * * *" \
      --time-zone="Asia/Shanghai" \
      --uri="${SERVICE_URL}/hermes/daily" \
      --http-method=POST \
      --update-headers="X-Cron-Secret=${HERMES_CRON_SECRET}" \
      --message-body="{}" \
      --attempt-deadline=300s
  else
    "${GCLOUD}" scheduler jobs create http "$SCHEDULER_JOB" \
      --location="$REGION" \
      --schedule="0 9 * * *" \
      --time-zone="Asia/Shanghai" \
      --uri="${SERVICE_URL}/hermes/daily" \
      --http-method=POST \
      --headers="X-Cron-Secret=${HERMES_CRON_SECRET}" \
      --message-body="{}" \
      --attempt-deadline=300s
  fi
fi

echo ""
echo "==> 完成。请在飞书开放平台配置:"
echo "    事件订阅 URL: ${SERVICE_URL}/feishu/events"
echo "    订阅事件: im.message.receive_v1"
echo ""
echo "手动触发一次日报测试:"
echo "  curl -X POST -H \"X-Cron-Secret: ${HERMES_CRON_SECRET}\" ${SERVICE_URL}/hermes/daily"
