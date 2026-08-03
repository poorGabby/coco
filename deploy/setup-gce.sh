#!/usr/bin/env bash
# One-shot GCP infrastructure setup for Hermes Furever Dock.
# Prerequisites: gcloud CLI authenticated, .env filled, GCP_PROJECT_ID exported.
set -euo pipefail

: "${GCP_PROJECT_ID:?Set GCP_PROJECT_ID (e.g. export GCP_PROJECT_ID=furever-dock-hermes-agent)}"

REGION="${GCP_REGION:-us-central1}"
ZONE="${GCP_ZONE:-us-central1-a}"
VM_NAME="${VM_NAME:-hermes-agent}"
REPO_NAME="${ARTIFACT_REPO:-hermes-agent}"
IMAGE_NAME="${IMAGE_NAME:-gateway}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "ERROR: .env not found. Copy .env.example and fill in secrets." >&2
  exit 1
fi

echo "==> Project: $GCP_PROJECT_ID | Region: $REGION | Zone: $ZONE | VM: $VM_NAME"

gcloud config set project "$GCP_PROJECT_ID"

echo "==> Enabling APIs..."
gcloud services enable compute.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com

echo "==> Artifact Registry repo (idempotent)..."
if ! gcloud artifacts repositories describe "$REPO_NAME" --location="$REGION" &>/dev/null; then
  gcloud artifacts repositories create "$REPO_NAME" \
    --repository-format=docker \
    --location="$REGION" \
    --description="Hermes Agent images for Furever Dock"
fi

echo "==> Firewall rule for health checks (idempotent)..."
if ! gcloud compute firewall-rules describe hermes-agent-healthcheck &>/dev/null; then
  gcloud compute firewall-rules create hermes-agent-healthcheck \
    --direction=INGRESS \
    --priority=1000 \
    --network=default \
    --action=ALLOW \
    --rules=tcp:8080 \
    --source-ranges=130.211.0.0/22,35.191.0.0/16 \
    --target-tags=hermes-agent
fi

echo "==> GCE VM (idempotent)..."
if ! gcloud compute instances describe "$VM_NAME" --zone="$ZONE" &>/dev/null; then
  gcloud compute instances create "$VM_NAME" \
    --zone="$ZONE" \
    --machine-type=e2-small \
    --boot-disk-size=20GB \
    --image-family=cos-stable \
    --image-project=cos-cloud \
    --tags=hermes-agent \
    --scopes=cloud-platform \
    --metadata-from-file startup-script=deploy/startup.sh
else
  echo "    VM $VM_NAME already exists, skipping create."
fi

echo "==> Uploading config to VM..."
gcloud compute ssh "$VM_NAME" --zone="$ZONE" \
  --command='mkdir -p ~/hermes-data'

gcloud compute scp deploy/config.yaml "$VM_NAME":config.yaml \
  --zone="$ZONE"

# 本地 .env 常含 HTTPS_PROXY（开发机代理）；GCE 上必须去掉，否则飞书 WebSocket 会连 127.0.0.1 失败。
grep -v -iE '^(HTTPS?_PROXY|ALL_PROXY|https?_proxy|all_proxy)=' .env > /tmp/hermes-dotenv-noproxy
gcloud compute scp /tmp/hermes-dotenv-noproxy "$VM_NAME":dotenv \
  --zone="$ZONE"
rm -f /tmp/hermes-dotenv-noproxy

gcloud compute ssh "$VM_NAME" --zone="$ZONE" \
  --command='mkdir -p hermes-data && sudo mv config.yaml hermes-data/config.yaml 2>/dev/null || sudo cp config.yaml hermes-data/config.yaml; sudo mv dotenv hermes-data/.env 2>/dev/null || sudo cp dotenv hermes-data/.env; sudo chown -R 10000:10000 hermes-data && sudo chmod 600 hermes-data/.env'

echo ""
echo "==> Infrastructure ready."
echo "    Next: bash scripts/deploy.sh"
echo "    Image will be: ${REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${REPO_NAME}/${IMAGE_NAME}"
