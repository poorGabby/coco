#!/usr/bin/env bash
# Runs ON the GCE VM (injected via deploy.sh). Restarts container to :latest.
set -euo pipefail

GCP_PROJECT_ID="${GCP_PROJECT_ID:-furever-dock-hermes-agent}"
REGION="${GCP_REGION:-us-central1}"
REPO_NAME="${ARTIFACT_REPO:-hermes-agent}"
IMAGE_NAME="${IMAGE_NAME:-gateway}"
CONTAINER_NAME="${CONTAINER_NAME:-furever-dock-hermes-agent}"
DD="${HERMES_DATA_DIR:-$HOME/hermes-data}"
IMG="${REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${REPO_NAME}/${IMAGE_NAME}:latest"
DOCKER_CONFIG=/tmp/hermes-dockercfg

mkdir -p "$DD" "$DOCKER_CONFIG"

if [[ -f "$DD/config.yaml" ]]; then
  ts="$(date +%Y%m%d-%H%M%S)"
  cp "$DD/config.yaml" "$DD/config.yaml.bak-$ts"
  ls -1t "$DD"/config.yaml.bak-* 2>/dev/null | tail -n +6 | xargs -r rm -f
fi

if [[ -f "$HOME/config.yaml" ]]; then
  cp "$HOME/config.yaml" "$DD/config.yaml"
fi

sudo chown -R 10000:10000 "$DD"
chmod 600 "$DD/.env" 2>/dev/null || true

TOKEN="$(curl -sf -H 'Metadata-Flavor: Google' \
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' \
  | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)"

echo "$TOKEN" | sudo env DOCKER_CONFIG="$DOCKER_CONFIG" \
  docker login -u oauth2accesstoken --password-stdin \
  "https://${REGION}-docker.pkg.dev"

sudo env DOCKER_CONFIG="$DOCKER_CONFIG" docker pull "$IMG"

sudo docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

sudo docker run -d --name "$CONTAINER_NAME" --restart unless-stopped \
  -v "$DD:/opt/data" --env-file "$DD/.env" -p 8642:8642 \
  "$IMG" gateway run

sudo docker image prune -f

sleep 22

if ! sudo docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  echo "ERROR: $CONTAINER_NAME failed to stay running. Logs:" >&2
  sudo docker logs "$CONTAINER_NAME" 2>&1 | tail -80 >&2 || true
  exit 1
fi

echo "OK: $CONTAINER_NAME is running ($IMG)"
