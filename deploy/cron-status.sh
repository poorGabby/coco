#!/usr/bin/env bash
python3 - <<'PY'
import json
d=json.load(open('/opt/data/cron/jobs.json'))
j=d['jobs'][0]
print('status=', j.get('last_status'))
print('error=', j.get('last_error'))
print('model=', j.get('model'))
print('last_run=', j.get('last_run_at'))
print('deliver=', j.get('deliver'))
PY
