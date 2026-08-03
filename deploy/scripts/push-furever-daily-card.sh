#!/bin/bash
# Hermes cron no-agent: push interactive daily card to ALL joined Feishu groups.
# Manual: bash push-furever-daily-card.sh [chat_id...]
set -euo pipefail
export HERMES_HOME="${HERMES_HOME:-/opt/data}"
export HERMES_ENV_FILE="${HERMES_ENV_FILE:-/opt/data/.env}"
ALL_SH="${HERMES_HOME}/bin/push-daily-card-all.sh"
if [[ ! -f "$ALL_SH" ]]; then
  echo "ERROR: missing $ALL_SH" >&2
  exit 1
fi
if [[ $# -ge 1 ]]; then
  exec bash "$ALL_SH" "$@"
fi
exec bash "$ALL_SH" --all-groups
