#!/bin/bash
set -e
sudo chown -R QQ:QQ /home/QQ/hermes-data
cp ~/config.yaml /home/QQ/hermes-data/config.yaml
GCP_PROJECT_ID=furever-dock-hermes-agent REGION=us-central1 CONTAINER_NAME=furever-dock-hermes-agent bash ~/vm-restart.sh
sleep 10
echo '---WS---'
sudo docker logs --tail 25 furever-dock-hermes-agent 2>&1 | grep -iE 'connected|feishu|error' | tail -12 || true
echo '---MCP clamp test---'
KEY=$(grep '^COCO_MCP_KEY=' /home/QQ/hermes-data/.env | cut -d= -f2-)
curl -sS -m 25 -X POST 'https://hermes-report-rnxa3esnpq-uc.a.run.app/mcp' \
  -H "Authorization: Bearer ${KEY}" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"fetch_daily_revenue","arguments":{"endDate":"2026-07-27"}}}' \
  | head -c 900
echo
echo '---model in config---'
grep -A2 '^model:' /home/QQ/hermes-data/config.yaml
