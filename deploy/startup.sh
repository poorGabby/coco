#!/usr/bin/env bash
# VM startup-script: boot-time self-heal for Hermes container on COS.
# Intentionally no `set -e` — pull failures fall back to local image.
set -uo pipefail

GCP_PROJECT_ID="${GCP_PROJECT_ID:-furever-dock-hermes-agent}"
REGION="${GCP_REGION:-us-central1}"
REPO_NAME="${ARTIFACT_REPO:-hermes-agent}"
IMAGE_NAME="${IMAGE_NAME:-gateway}"
CONTAINER_NAME="${CONTAINER_NAME:-furever-dock-hermes-agent}"
DD="${HERMES_DATA_DIR:-$HOME/hermes-data}"
IMG="${REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${REPO_NAME}/${IMAGE_NAME}:latest"
DOCKER_CONFIG=/tmp/hermes-dockercfg

if sudo docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER_NAME"; then
  echo "[startup] $CONTAINER_NAME already running, skip."
  exit 0
fi

mkdir -p "$DD" "$DOCKER_CONFIG"

TOKEN="$(curl -sf -H 'Metadata-Flavor: Google' \
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' \
  | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4 || true)"

if [[ -n "${TOKEN:-}" ]]; then
  echo "$TOKEN" | sudo env DOCKER_CONFIG="$DOCKER_CONFIG" \
    docker login -u oauth2accesstoken --password-stdin \
    "https://${REGION}-docker.pkg.dev" 2>/dev/null || true
  sudo env DOCKER_CONFIG="$DOCKER_CONFIG" docker pull "$IMG" 2>/dev/null || true
fi

sudo docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

if ! sudo docker image inspect "$IMG" &>/dev/null; then
  echo "[startup] No local image $IMG and pull failed — cannot start."
  exit 1
fi

sudo chown -R 10000:10000 "$DD" 2>/dev/null || true

sudo docker run -d --name "$CONTAINER_NAME" --restart unless-stopped \
  -v "$DD:/opt/data" --env-file "$DD/.env" -p 8642:8642 \
  "$IMG" gateway run

echo "[startup] Started $CONTAINER_NAME"
