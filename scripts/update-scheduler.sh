#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
source <(grep -v '^\s*#' .env | grep -v '^\s*$' | sed 's/\r$//')
"/c/Users/QQ/AppData/Local/Google/Cloud SDK/google-cloud-sdk/bin/gcloud" scheduler jobs update http hermes-daily-report \
  --location=us-central1 \
  --uri="https://hermes-report-rnxa3esnpq-uc.a.run.app/hermes/daily" \
  --http-method=POST \
  --headers="X-Cron-Secret=${HERMES_CRON_SECRET}" \
  --message-body="{}" \
  --attempt-deadline=300s \
  --project=furever-dock-hermes-agent
