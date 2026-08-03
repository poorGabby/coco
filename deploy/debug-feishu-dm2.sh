#!/bin/bash
sudo docker exec furever-dock-hermes-agent grep -nE 'chat_type|p2p|group_policy|default_group|dm_policy|message.receive|im.message|unauthorized|Access denied|not authorized' /opt/hermes/gateway/platforms/feishu.py | head -100
echo '===='
sudo docker exec furever-dock-hermes-agent grep -nE 'GATEWAY_ALLOW|is_user_allowed|allowlist|_authorize' /opt/hermes/gateway/run.py | head -40
echo '==== recent gateway after connect ==='
sudo awk 'NR==1 || /2026-07-21 03:56/' /home/QQ/hermes-data/logs/gateway.log | tail -40
echo '==== test send via API server ==='
# Does api server respond?
curl -sS -m 5 http://127.0.0.1:8642/v1/models -H "Authorization: Bearer $(grep API_SERVER_KEY /home/QQ/hermes-data/.env | cut -d= -f2-)" | head -c 400 || true
echo
