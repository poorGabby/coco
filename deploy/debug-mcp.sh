#!/bin/bash
set -e
echo '=== errors.log mcp ==='
sudo grep -iE 'mcp|coco_data|timeout|7897|Connect' /home/QQ/hermes-data/logs/errors.log | tail -50 || true
echo '=== gateway mcp/tool ==='
sudo grep -iE 'mcp|coco_data|tool|error|fetch_' /home/QQ/hermes-data/logs/gateway.log | tail -50 || true
echo '=== agent recent ==='
sudo tail -100 /home/QQ/hermes-data/logs/agent.log | grep -iE 'mcp|error|tool|fetch_|revenue|amplitude|purchase' | tail -40 || true
echo '=== curl mcp from VM ==='
KEY=$(sudo grep '^COCO_MCP_KEY=' /home/QQ/hermes-data/.env | cut -d= -f2-)
curl -sS -m 25 -o /tmp/mcp.out -w "http=%{http_code} time=%{time_total}\n" \
  -X POST 'https://hermes-report-rnxa3esnpq-uc.a.run.app/mcp' \
  -H "Authorization: Bearer ${KEY}" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"diag","version":"0"}}}'
head -c 800 /tmp/mcp.out; echo
echo '=== env proxy check ==='
sudo docker exec furever-dock-hermes-agent printenv | grep -iE 'PROXY|COCO_MCP' || true
echo '=== cloud run health ==='
curl -sS -m 10 -o /tmp/health.out -w "health=%{http_code}\n" https://hermes-report-rnxa3esnpq-uc.a.run.app/health || true
cat /tmp/health.out; echo
