#!/usr/bin/env bash
# Build daily card once via MCP, then send to many chat_ids.
# Usage:
#   echo -e "oc_aaa\noc_bbb" | bash push-daily-card-all.sh
#   bash push-daily-card-all.sh oc_aaa oc_bbb
#   bash push-daily-card-all.sh --all-groups
set -euo pipefail

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
export HERMES_ENV_FILE="$ENV_FILE"
MCP_URL="${COCO_MCP_URL:-https://hermes-report-rnxa3esnpq-uc.a.run.app/mcp}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEND_SH="${SCRIPT_DIR}/send-feishu-interactive.sh"
LIST_SH="${SCRIPT_DIR}/list-feishu-groups.sh"

if [[ ! -f "$SEND_SH" ]]; then
  echo "ERROR: send-feishu-interactive.sh not found" >&2
  exit 1
fi

eval "$(grep -E '^(COCO_MCP_KEY)=' "$ENV_FILE" | sed 's/\r$//')"
: "${COCO_MCP_KEY:?COCO_MCP_KEY missing in $ENV_FILE}"

CHAT_IDS=()
if [[ "${1:-}" == "--all-groups" ]]; then
  shift
  LIST_JSON=$(bash "$LIST_SH" 2>/dev/null)
  while IFS= read -r cid; do
    [[ -n "$cid" ]] && CHAT_IDS+=("$cid")
  done < <(python3 -c 'import json,sys; d=json.load(sys.stdin); print("\n".join(g["chat_id"] for g in d["groups"]))' <<<"$LIST_JSON")
elif [[ $# -ge 1 ]]; then
  CHAT_IDS=("$@")
else
  # stdin: one chat_id per line
  while IFS= read -r cid; do
    cid="${cid//$'\r'/}"
    [[ -n "$cid" ]] && CHAT_IDS+=("$cid")
  done
fi

if [[ ${#CHAT_IDS[@]} -eq 0 ]]; then
  echo "ERROR: no chat_id targets" >&2
  exit 1
fi

TMP=$(mktemp)
trap 'rm -f "$TMP" "$TMP.card"' EXIT

curl -sS -m 180 -X POST "$MCP_URL" \
  -H "Authorization: Bearer ${COCO_MCP_KEY}" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"build_daily_report_card","arguments":{}}}' \
  > "$TMP"

python3 - "$TMP" "$TMP.card" <<'PY'
import json,sys
raw=open(sys.argv[1],encoding="utf-8").read()
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

ok=0
fail=0
results=()
for cid in "${CHAT_IDS[@]}"; do
  if out=$(bash "$SEND_SH" "$cid" "$TMP.card" 2>&1); then
    ok=$((ok + 1))
    results+=("{\"chat_id\":\"$cid\",\"ok\":true,\"result\":$out}")
    echo "OK $cid $out" >&2
  else
    fail=$((fail + 1))
    # escape for json-ish log
    safe=$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
    results+=("{\"chat_id\":\"$cid\",\"ok\":false,\"error\":$safe}")
    echo "FAIL $cid $out" >&2
  fi
done

python3 - <<PY
import json
print(json.dumps({
  "ok": ${fail} == 0,
  "sent": ${ok},
  "failed": ${fail},
  "total": ${#CHAT_IDS[@]},
}, ensure_ascii=False))
PY

[[ "$fail" -eq 0 ]]
