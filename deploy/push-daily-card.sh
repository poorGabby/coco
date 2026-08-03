#!/usr/bin/env bash
# 一键：从 Cloud Run MCP 拉取 Card JSON，再用 VM 正式飞书凭证发出 interactive 卡片。
# 用法:
#   bash push-daily-card.sh <chat_id>
# 环境:
#   HERMES_ENV_FILE  默认 ~/hermes-data/.env（需含 FEISHU_* 与 COCO_MCP_KEY）
#   COCO_MCP_URL     默认 https://hermes-report-rnxa3esnpq-uc.a.run.app/mcp
set -euo pipefail

CHAT_ID="${1:?usage: push-daily-card.sh <chat_id>}"
# Cron 在容器内 HOME 不是宿主机路径；优先固定 HERMES_HOME=/opt/data/.env
resolve_env_file() {
  if [[ -n "${HERMES_ENV_FILE:-}" && -f "$HERMES_ENV_FILE" ]]; then
    echo "$HERMES_ENV_FILE"
    return
  fi
  local cand
  for cand in \
    "${HERMES_HOME:-/opt/data}/.env" \
    /opt/data/.env \
    "$HOME/.env" \
    "$HOME/hermes-data/.env" \
    /home/QQ/hermes-data/.env; do
    if [[ -f "$cand" ]]; then
      echo "$cand"
      return
    fi
  done
  echo "${HERMES_HOME:-/opt/data}/.env"
}
ENV_FILE="$(resolve_env_file)"
MCP_URL="${COCO_MCP_URL:-https://hermes-report-rnxa3esnpq-uc.a.run.app/mcp}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEND_SH="${SCRIPT_DIR}/send-feishu-interactive.sh"
if [[ ! -x "$SEND_SH" && -f "$HOME/send-feishu-interactive.sh" ]]; then
  SEND_SH="$HOME/send-feishu-interactive.sh"
fi
if [[ ! -f "$SEND_SH" ]]; then
  echo "ERROR: send-feishu-interactive.sh not found" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: missing $ENV_FILE (need FEISHU_* and COCO_MCP_KEY)" >&2
  exit 1
fi
export HERMES_ENV_FILE="$ENV_FILE"

eval "$(grep -E '^(COCO_MCP_KEY)=' "$ENV_FILE" | sed 's/\r$//')"
: "${COCO_MCP_KEY:?COCO_MCP_KEY missing in $ENV_FILE}"

TMP=$(mktemp)
trap 'rm -f "$TMP" "$TMP.card"' EXIT

# MCP Streamable HTTP: initialize then tools/call (stateless server accepts tools/call directly in our setup)
curl -sS -m 180 -X POST "$MCP_URL" \
  -H "Authorization: Bearer ${COCO_MCP_KEY}" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"build_daily_report_card","arguments":{}}}' \
  > "$TMP"

python3 - "$TMP" "$TMP.card" <<'PY'
import json,sys,re
raw=open(sys.argv[1],encoding="utf-8").read()
# SSE: lines like "data: {...}"
payload=None
for line in raw.splitlines():
    if line.startswith("data:"):
        payload=json.loads(line[5:].strip())
        break
if payload is None:
    payload=json.loads(raw)
if "error" in payload:
    raise SystemExit(json.dumps(payload, ensure_ascii=False))
content=payload.get("result",{}).get("content",[])
text=content[0]["text"] if content else ""
data=json.loads(text)
if data.get("error"):
    raise SystemExit(json.dumps(data, ensure_ascii=False))
card=data.get("card")
if not isinstance(card, dict):
    raise SystemExit("no card in MCP result")
open(sys.argv[2],"w",encoding="utf-8").write(json.dumps(card, ensure_ascii=False))
print(json.dumps({
  "built": True,
  "title": data.get("title"),
  "subtitle": data.get("subtitle"),
}, ensure_ascii=False))
PY

bash "$SEND_SH" "$CHAT_ID" "$TMP.card"
