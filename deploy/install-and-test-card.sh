#!/bin/bash
set -euo pipefail
sudo mkdir -p /home/QQ/hermes-data/bin /home/QQ/hermes-data/skills/domain/furever-daily-report
sudo cp -f /home/QQ/send-feishu-interactive.sh /home/QQ/hermes-data/bin/send-feishu-interactive.sh
sudo cp -f /home/QQ/push-daily-card.sh /home/QQ/hermes-data/bin/push-daily-card.sh
sudo cp -f /home/QQ/SKILL-daily.md /home/QQ/hermes-data/skills/domain/furever-daily-report/SKILL.md
sudo sed -i 's/\r$//' /home/QQ/hermes-data/bin/send-feishu-interactive.sh /home/QQ/hermes-data/bin/push-daily-card.sh
sudo chmod 755 /home/QQ/hermes-data/bin/send-feishu-interactive.sh /home/QQ/hermes-data/bin/push-daily-card.sh
# Keep parent hermes-data traversable by QQ for ops; data files stay hermes uid inside container
sudo chown -R 10000:10000 /home/QQ/hermes-data/bin /home/QQ/hermes-data/skills
sudo chmod 755 /home/QQ/hermes-data /home/QQ/hermes-data/bin
sudo ls -la /home/QQ/hermes-data/bin/
echo '=== MCP build smoke ==='
KEY=$(sudo grep '^COCO_MCP_KEY=' /home/QQ/hermes-data/.env | cut -d= -f2-)
curl -sS -m 180 -o /tmp/mcp-card.out -w "http=%{http_code} time=%{time_total}\n" -X POST 'https://hermes-report-rnxa3esnpq-uc.a.run.app/mcp' \
  -H "Authorization: Bearer ${KEY}" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"build_daily_report_card","arguments":{}}}'
python3 - <<'PY'
import json
raw=open("/tmp/mcp-card.out",encoding="utf-8").read()
payload=None
for line in raw.splitlines():
    if line.startswith("data:"):
        payload=json.loads(line[5:].strip()); break
if payload is None:
    try: payload=json.loads(raw)
    except Exception as e:
        print("parse_fail", e, raw[:200]); raise
content=(payload.get("result") or {}).get("content") or []
text=content[0]["text"] if content else ""
data=json.loads(text) if text else payload
print("title=", data.get("title"))
print("subtitle=", data.get("subtitle"))
print("has_card=", isinstance(data.get("card"), dict))
if data.get("error"):
    raise SystemExit(data["error"])
PY
echo '=== push to DM ==='
sudo HERMES_ENV_FILE=/home/QQ/hermes-data/.env bash /home/QQ/hermes-data/bin/push-daily-card.sh oc_6fdf290c3265436ad5a4cf0136beabd8
