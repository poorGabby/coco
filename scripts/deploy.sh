#!/usr/bin/env bash
# Build → push → update VM for Hermes Furever Dock.
# Usage:
#   bash scripts/deploy.sh              # full deploy
#   bash scripts/deploy.sh build-only   # build + push only
#   bash scripts/deploy.sh update-only  # update VM with existing :latest
set -euo pipefail

# 上游 hermes-agent 版本（tag）。默认钉在交接时期验证过的点；升级入口见下方。
# 升级步骤（HERMES_DEPLOYMENT_GUIDE.md）：
#   1) export HERMES_REF=<新 tag，如 v2026.7.20>
#   2) 用上游对应版本 Dockerfile 覆盖 deploy/Dockerfile，并重新补回 --extra feishu
#   3) bash scripts/deploy.sh   # 构建前会 grep 校验 --extra feishu
HERMES_REF="${HERMES_REF:-v2026.5.29.2}"
GCP_PROJECT_ID="${GCP_PROJECT_ID:-furever-dock-hermes-agent}"
REGION="${GCP_REGION:-us-central1}"
ZONE="${GCP_ZONE:-us-central1-a}"
VM_NAME="${VM_NAME:-hermes-agent}"
CONTAINER_NAME="${CONTAINER_NAME:-furever-dock-hermes-agent}"
REPO_NAME="${ARTIFACT_REPO:-hermes-agent}"
IMAGE_NAME="${IMAGE_NAME:-gateway}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REGISTRY="${REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${REPO_NAME}"
TAG="v-$(date +%Y%m%d-%H%M%S)"
IMAGE="${REGISTRY}/${IMAGE_NAME}:${TAG}"
LATEST="${REGISTRY}/${IMAGE_NAME}:latest"

MODE="${1:-all}"

build() {
  if [[ ! -f .env ]]; then
    echo "ERROR: .env not found. Copy .env.example and fill secrets." >&2
    exit 1
  fi

  if ! grep -q -- '--extra feishu' deploy/Dockerfile; then
    echo "ERROR: deploy/Dockerfile missing --extra feishu (required for Feishu WebSocket)." >&2
    exit 1
  fi

  echo "==> Cloud Build: $IMAGE (ref=${HERMES_REF}, clone on GCP)..."
  gcloud config set project "$GCP_PROJECT_ID"
  gcloud builds submit "$ROOT/deploy" \
    --config="$ROOT/deploy/cloudbuild.yaml" \
    --substitutions="_IMAGE=${IMAGE},_HERMES_REF=${HERMES_REF}"

  echo "==> Tagging :latest..."
  gcloud artifacts docker tags add "$IMAGE" "$LATEST"
  echo "    Built: $LATEST"
}

update_vm() {
  # 交接文档验证示例带 --tunnel-through-iap；本机 Windows(gcloud→plink) 下 IAP SSH 会断连。
  # 该 VM 已有公网 IP + default-allow-ssh，直连可用（与仓库原 deploy.sh 一致）。
  # 若日后在 Linux/WSL 上部署，可加 --tunnel-through-iap。
  echo "==> Updating VM $VM_NAME..."
  gcloud compute scp deploy/config.yaml "$VM_NAME":config.yaml \
    --zone="$ZONE"

  gcloud compute ssh "$VM_NAME" --zone="$ZONE" \
    --command="GCP_PROJECT_ID=$GCP_PROJECT_ID REGION=$REGION CONTAINER_NAME=$CONTAINER_NAME bash -s" \
    < deploy/vm-restart.sh
}

case "$MODE" in
  all)
    build
    update_vm
    ;;
  build-only)
    build
    ;;
  update-only)
    update_vm
    ;;
  *)
    echo "Usage: $0 [all|build-only|update-only]" >&2
    exit 1
    ;;
esac

echo ""
echo "==> Deploy complete."
echo "    Verify: gcloud compute ssh $VM_NAME --zone=$ZONE --tunnel-through-iap --command='sudo docker logs --tail 50 $CONTAINER_NAME'"
