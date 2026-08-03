#!/bin/bash
sudo docker exec furever-dock-hermes-agent grep -nE 'require_mention|_should_process|skip|ignore.*mention|mentioned' /opt/hermes/gateway/platforms/feishu.py | head -60
echo '==== context around require_mention checks ===='
sudo docker exec furever-dock-hermes-agent awk 'NR>=3980 && NR<=4120' /opt/hermes/gateway/platforms/feishu.py
echo '===='
sudo docker exec furever-dock-hermes-agent awk 'NR>=3000 && NR<=3200' /opt/hermes/gateway/platforms/feishu.py
