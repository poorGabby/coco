#!/bin/bash
set -euo pipefail

echo "=== real env ==="
ls -la /home/QQ/hermes-data/.env

echo "=== script env resolution ==="
grep -n 'ENV_FILE\|HERMES_ENV\|/opt/data/.env' \
  /home/QQ/hermes-data/bin/push-daily-card.sh \
  /home/QQ/hermes-data/bin/send-feishu-interactive.sh \
  /home/QQ/hermes-data/scripts/push-furever-daily-card.sh || true

# Symlink so even old HOME=/opt/data/home path works
mkdir -p /home/QQ/hermes-data/home/hermes-data
ln -sfn /opt/data/.env /home/QQ/hermes-data/home/hermes-data/.env
# Also cover $HOME/hermes-data/.env when HOME=/opt/data/home
ln -sfn /opt/data/.env /home/QQ/hermes-data/home/hermes-data/.env 2>/dev/null || true
# If something looks for /opt/data/home/hermes-data/.env — that's the path above via mount

echo "=== symlink ==="
ls -la /home/QQ/hermes-data/home/hermes-data/.env

echo "=== inside container ==="
docker exec furever-dock-hermes-agent ls -la /opt/data/.env /opt/data/home/hermes-data/.env

echo "=== key presence (names only) ==="
docker exec furever-dock-hermes-agent bash -c '
  for f in /opt/data/.env /opt/data/home/hermes-data/.env; do
    echo "-- $f"
    grep -E "^(FEISHU_APP_ID|FEISHU_APP_SECRET|COCO_MCP_KEY)=" "$f" | sed "s/=.*/=present/"
  done
'

echo "=== dry resolve under broken HOME (no send) ==="
docker exec -u hermes \
  -e HOME=/opt/data/home \
  -e HERMES_HOME=/opt/data \
  furever-dock-hermes-agent bash -c '
    # mimic push-daily-card resolve
    for cand in /opt/data/.env "$HOME/.env" "$HOME/hermes-data/.env" /opt/data/home/hermes-data/.env; do
      if [[ -f "$cand" ]]; then echo "FOUND $cand"; break; fi
    done
  '

echo "=== cron ==="
docker exec furever-dock-hermes-agent hermes cron list --all | head -25

echo "DONE — no secrets printed; tomorrow cron uses no-agent script + /opt/data/.env"
