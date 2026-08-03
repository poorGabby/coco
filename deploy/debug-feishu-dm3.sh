#!/bin/bash
sudo docker exec furever-dock-hermes-agent sed -n '1580,1680p' /opt/hermes/gateway/platforms/feishu.py
echo '===='
sudo docker exec furever-dock-hermes-agent sed -n '1480,1580p' /opt/hermes/gateway/platforms/feishu.py
echo '==== encrypt/token usage ===='
sudo docker exec furever-dock-hermes-agent grep -nE 'encrypt_key|verification_token|EventDispatcher|FeishuWSClient' /opt/hermes/gateway/platforms/feishu.py | head -40
