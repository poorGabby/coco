#!/bin/bash
set -euo pipefail
# Install multi-group daily push + update cron deliver to local (script already sends cards).

cp /tmp/list-feishu-groups.sh /tmp/push-daily-card-all.sh /home/QQ/hermes-data/bin/
cp /tmp/push-furever-daily-card.sh /home/QQ/hermes-data/scripts/
sed -i 's/\r$//' \
  /home/QQ/hermes-data/bin/list-feishu-groups.sh \
  /home/QQ/hermes-data/bin/push-daily-card-all.sh \
  /home/QQ/hermes-data/scripts/push-furever-daily-card.sh
chmod 755 \
  /home/QQ/hermes-data/bin/list-feishu-groups.sh \
  /home/QQ/hermes-data/bin/push-daily-card-all.sh \
  /home/QQ/hermes-data/scripts/push-furever-daily-card.sh

echo '=== groups bot joined ==='
docker exec -u hermes -e HERMES_HOME=/opt/data -e HERMES_ENV_FILE=/opt/data/.env \
  furever-dock-hermes-agent bash /opt/data/bin/list-feishu-groups.sh

echo '=== update cron deliver=local (script fans out cards itself) ==='
docker exec furever-dock-hermes-agent hermes cron edit 1f8ab7c2e0f6 \
  --script push-furever-daily-card.sh \
  --no-agent \
  --deliver local || \
docker exec furever-dock-hermes-agent hermes cron edit 1f8ab7c2e0f6 \
  --script push-furever-daily-card.sh \
  --no-agent \
  --deliver none || true

docker exec furever-dock-hermes-agent hermes cron list --all | head -30
echo DONE
