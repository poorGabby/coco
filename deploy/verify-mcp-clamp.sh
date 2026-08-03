#!/bin/bash
KEY=$(sudo grep '^COCO_MCP_KEY=' /home/QQ/hermes-data/.env | cut -d= -f2-)
echo "key_len=${#KEY}"
echo '=== clamp endDate=2026-07-27 ==='
curl -sS -m 30 -X POST 'https://hermes-report-rnxa3esnpq-uc.a.run.app/mcp' \
  -H "Authorization: Bearer ${KEY}" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"fetch_daily_revenue","arguments":{"endDate":"2026-07-27"}}}'
echo
echo '=== no dates (default) ==='
curl -sS -m 30 -X POST 'https://hermes-report-rnxa3esnpq-uc.a.run.app/mcp' \
  -H "Authorization: Bearer ${KEY}" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"fetch_amplitude_metric","arguments":{"metricName":"DAU"}}}'
echo
sudo grep -A2 '^model:' /home/QQ/hermes-data/config.yaml
