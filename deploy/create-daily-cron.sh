#!/usr/bin/env bash
set -euo pipefail
export HERMES_HOME=/opt/data
PROMPT='请使用 skill furever-daily-report：拉取最近一个美区完结日的 DAU、New_Users、Daily Revenue（Stripe），按技能要求的表格格式输出完整日报简报。必须调用 MCP 工具取数，禁止编造。'
hermes cron create "0 9 * * *" "$PROMPT" \
  --name furever-daily-report \
  --skill furever-daily-report \
  --deliver "feishu:oc_020b1fa1d9e7a9ec22b71227e0d0e1c6,feishu"
echo "---LIST---"
hermes cron list
