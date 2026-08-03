# Update GCE VM with :latest image (Windows-native, avoids Git Bash gcloud issues).
param(
    [switch]$SkipConfig
)

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
Set-Location $Root

$GcloudCandidates = @(
    "$env:ProgramFiles\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd",
    "${env:ProgramFiles(x86)}\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd",
    "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
)
$Gcloud = $GcloudCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Gcloud) { throw "gcloud not found" }

$KeyFile = Join-Path $Root "hermes-deployer-key.json"
if (Test-Path $KeyFile) {
    & $Gcloud auth activate-service-account --key-file=$KeyFile | Out-Null
}

$Zone = "us-central1-a"
$Vm = "hermes-agent"
$Project = if ($env:GCP_PROJECT_ID) { $env:GCP_PROJECT_ID } else { "furever-dock-hermes-agent" }
$env:GCP_PROJECT_ID = $Project

if (-not $SkipConfig) {
    Write-Host "==> Uploading config.yaml..."
    & $Gcloud compute scp "$Root\deploy\config.yaml" "${Vm}:config.yaml" --zone=$Zone
}

# Remote script uses LF only (CRLF breaks bash on COS).
$RemoteScript = @'
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
if [[ -f "$HOME/config.yaml" ]]; then
  sudo cp "$HOME/config.yaml" "$DD/config.yaml"
  sudo chown 10000:10000 "$DD/config.yaml"
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
sleep 10
sudo docker ps --filter "name=$CONTAINER_NAME"
'@

$TempScript = Join-Path $env:TEMP "hermes-vm-restart.sh"
[System.IO.File]::WriteAllText($TempScript, $RemoteScript.Replace("`r`n", "`n"))

Write-Host "==> Updating VM $Vm..."
& $Gcloud compute scp $TempScript "${Vm}:vm-restart.sh" --zone=$Zone
& $Gcloud compute ssh $Vm --zone=$Zone `
    --command="GCP_PROJECT_ID=$Project REGION=us-central1 CONTAINER_NAME=furever-dock-hermes-agent bash ~/vm-restart.sh"

Write-Host "==> VM update complete."
