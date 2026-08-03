#!/usr/bin/env bash
set -euo pipefail
cp /tmp/SKILL-furever-daily.md /opt/data/skills/domain/furever-daily-report/SKILL.md 2>/dev/null || true
# If skill is on host path via volume:
if [[ -f /home/QQ/SKILL-furever-daily.md ]]; then
  cp /home/QQ/SKILL-furever-daily.md /opt/data/skills/domain/furever-daily-report/SKILL.md
fi
python3 - <<'PY'
import json
p='/opt/data/cron/jobs.json'
with open(p) as f:
    data=json.load(f)
for j in data.get('jobs',[]):
    if j.get('name')=='furever-daily-report':
        j['model']='gemini-2.5-flash'
        j['provider']='gemini'
        j['prompt']='按 furever-daily-report skill 生成今日简报。工具调用不要传日期参数。输出只要表格+最多3条观察。'
        print('patched', j['id'], j['model'])
with open(p,'w') as f:
    json.dump(data,f,ensure_ascii=False,indent=2)
PY
export HERMES_HOME=/opt/data
hermes cron list
hermes cron run furever-daily-report
hermes cron tick
