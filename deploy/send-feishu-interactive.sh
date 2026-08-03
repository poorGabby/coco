#!/usr/bin/env bash
# 在 GCE VM 上用正式 CoCo 飞书凭证发送 interactive 卡片。
# 用法:
#   bash send-feishu-interactive.sh <chat_id> <card.json>
#   echo '{"schema":"2.0",...}' | bash send-feishu-interactive.sh <chat_id> -
set -euo pipefail

CHAT_ID="${1:?chat_id required}"
CARD_SRC="${2:?card json file or - for stdin}"

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
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: missing $ENV_FILE" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a
# strip CR; ignore comments/blank
eval "$(grep -E '^(FEISHU_APP_ID|FEISHU_APP_SECRET)=' "$ENV_FILE" | sed 's/\r$//')"
set +a

: "${FEISHU_APP_ID:?}"
: "${FEISHU_APP_SECRET:?}"

if [[ "$CARD_SRC" == "-" ]]; then
  CARD_JSON=$(cat)
else
  CARD_JSON=$(cat "$CARD_SRC")
fi

TOKEN_JSON=$(curl -sS -X POST 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal' \
  -H 'Content-Type: application/json' \
  -d "{\"app_id\":\"${FEISHU_APP_ID}\",\"app_secret\":\"${FEISHU_APP_SECRET}\"}")
TENANT=$(python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("code")==0, d; print(d["tenant_access_token"])' <<<"$TOKEN_JSON")

# Feishu expects content as a JSON string field
BODY=$(python3 -c '
import json,sys
chat_id=sys.argv[1]
card=json.load(sys.stdin)
print(json.dumps({"receive_id": chat_id, "msg_type": "interactive", "content": json.dumps(card, ensure_ascii=False)}, ensure_ascii=False))
' "$CHAT_ID" <<<"$CARD_JSON")

RESP=$(curl -sS -X POST 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id' \
  -H "Authorization: Bearer ${TENANT}" \
  -H 'Content-Type: application/json; charset=utf-8' \
  -d "$BODY")

python3 -c '
import json,sys
d=json.load(sys.stdin)
if d.get("code")!=0:
  print(json.dumps(d, ensure_ascii=False), file=sys.stderr)
  sys.exit(1)
msg=d.get("data",{}).get("message_id","")
print(json.dumps({"ok": True, "message_id": msg}, ensure_ascii=False))
' <<<"$RESP"
