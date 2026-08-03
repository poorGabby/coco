#!/bin/bash
set -euo pipefail
cp /tmp/push-daily-card.sh /tmp/send-feishu-interactive.sh /home/QQ/hermes-data/bin/
cp /tmp/push-furever-daily-card.sh /home/QQ/hermes-data/scripts/
sed -i 's/\r$//' /home/QQ/hermes-data/bin/push-daily-card.sh \
  /home/QQ/hermes-data/bin/send-feishu-interactive.sh \
  /home/QQ/hermes-data/scripts/push-furever-daily-card.sh
chmod 755 /home/QQ/hermes-data/bin/*.sh /home/QQ/hermes-data/scripts/*.sh

# Simulate cron HOME that previously broke ($HOME/hermes-data/.env)
docker exec -u hermes \
  -e HOME=/opt/data/home \
  -e HERMES_HOME=/opt/data \
  furever-dock-hermes-agent \
  bash /opt/data/scripts/push-furever-daily-card.sh oc_6fdf290c3265436ad5a4cf0136beabd8
