#!/bin/bash
set -e
echo '=== printenv FEISHU ==='
sudo docker exec furever-dock-hermes-agent printenv | grep -iE 'FEISHU|GATEWAY_ALLOW|GEMINI' | sort || true
echo '=== .env head ==='
sudo docker exec furever-dock-hermes-agent head -10 /opt/data/.env
echo '=== feishu.py allow patterns ==='
sudo docker exec furever-dock-hermes-agent grep -nE 'unauthorized|ALLOWED|allow_all|pairing|decrypt|ignore' /opt/hermes/gateway/platforms/feishu.py | head -50 || true
echo '=== gateway.log last 20 ==='
sudo tail -20 /home/QQ/hermes-data/logs/gateway.log
echo '=== mark time and wait for inbound ==='
date -u
sudo truncate -s 0 /tmp/gw-watch.txt || true
sudo docker logs -f --since 0s furever-dock-hermes-agent > /tmp/gw-watch.txt 2>&1 &
WPID=$!
sleep 45
kill $WPID 2>/dev/null || true
echo '=== new logs during 45s (send a DM now if testing) ==='
sudo tail -80 /tmp/gw-watch.txt | grep -iE 'message|feishu|lark|dm|chat|inbound|receive|error|unauthorized|deny|allow' || echo '(no matching lines)'
sudo tail -30 /home/QQ/hermes-data/logs/gateway.log
