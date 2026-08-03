#!/usr/bin/env bash
# 列出机器人已加入的飞书群 chat_id（不含私聊）。
# 依赖 HERMES_ENV_FILE / FEISHU_APP_ID / FEISHU_APP_SECRET
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
eval "$(grep -E '^(FEISHU_APP_ID|FEISHU_APP_SECRET)=' "$ENV_FILE" | sed 's/\r$//')"
: "${FEISHU_APP_ID:?}"
: "${FEISHU_APP_SECRET:?}"

TOKEN_JSON=$(curl -sS -X POST 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal' \
  -H 'Content-Type: application/json' \
  -d "{\"app_id\":\"${FEISHU_APP_ID}\",\"app_secret\":\"${FEISHU_APP_SECRET}\"}")
TENANT=$(python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("code")==0, d; print(d["tenant_access_token"])' <<<"$TOKEN_JSON")

python3 - "$TENANT" <<'PY'
import json, sys, urllib.request

token = sys.argv[1]
page_token = ""
groups = []
while True:
    url = "https://open.feishu.cn/open-apis/im/v1/chats?page_size=100"
    if page_token:
        url += f"&page_token={page_token}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode())
    if data.get("code") != 0:
        raise SystemExit(json.dumps(data, ensure_ascii=False))
    for item in data.get("data", {}).get("items") or []:
        # chat_mode: group | p2p；chat_type 有时是 private/public
        mode = (item.get("chat_mode") or "").lower()
        ctype = (item.get("chat_type") or "").lower()
        name = item.get("name") or ""
        cid = item.get("chat_id") or ""
        if not cid:
            continue
        # 只要群：排除 p2p / 私聊
        if mode == "p2p" or ctype == "p2p":
            continue
        groups.append({"chat_id": cid, "name": name, "chat_mode": mode, "chat_type": ctype})
    if not data.get("data", {}).get("has_more"):
        break
    page_token = data.get("data", {}).get("page_token") or ""
    if not page_token:
        break

print(json.dumps({"count": len(groups), "groups": groups}, ensure_ascii=False, indent=2))
for g in groups:
    print(g["chat_id"], file=sys.stderr)
PY
