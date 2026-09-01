# CoCo AI 交接说明

你现在负责维护 CoCo 项目。请先阅读本文件，再阅读 `README.md`、`HANDOVER.md`、`docs/COCO_SYSTEM_GUIDE.md`、`docs/OPERATIONS_RUNBOOK.md` 和 `docs/RECEIVER_ACCEPTANCE.md`。

## 生产环境

- GCP project：`furever-dock-hermes-agent`
- Cloud Run service：`hermes-report`
- Cloud Run region：`us-central1`
- GCE VM：`hermes-agent`
- GCE zone：`us-central1-a`
- Cloud Scheduler：`hermes-daily-report`
- Cloud Run URL：从 `gcloud run services describe hermes-report --region=us-central1` 获取，不要自行猜测

## 系统职责

- GCE Hermes Agent：负责飞书对话和 Agent 主链路。
- Cloud Run `hermes-report`：负责日报、数据查询和 MCP。
- Amplitude：DAU、New Users、First Purchase、Retention。
- Stripe：Second Adoption、Treats 及相关购买收入。

## 工作规则

1. 先检查当前状态，再执行修改。
2. 不要擅自修改指标口径、日期计算、WoW、snapshot、数据源或 Revenue 逻辑。
3. 不要部署、删除、重启、修改 GCE、Scheduler、IAM 或 Secret，除非用户明确确认。
4. 不要输出 API key、token、密码或 service account JSON 内容。
5. 修改代码后运行 TypeScript 和完整测试。
6. 生产操作前先报告计划、目标和风险。

## 本地初始化

```bash
cd ~/coco
npm ci
cd apps/hermes
npm ci
npm run test:agent
```

`.env` 只能从公司的密码管理器或 Secret Manager 获取。不要把 `.env` 提交到 Git。

## 常用检查

```bash
gcloud config set project furever-dock-hermes-agent
gcloud run services describe hermes-report --region=us-central1
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="hermes-report"' --limit=50
curl https://hermes-report-rnxa3esnpq-uc.a.run.app/health
curl https://hermes-report-rnxa3esnpq-uc.a.run.app/mcp/health
```

日报预览：

```bash
curl https://hermes-report-rnxa3esnpq-uc.a.run.app/hermes/report
```

## Cloud Run 部署

只有用户明确确认部署时才执行：

```bash
cd ~/coco
export GCP_PROJECT_ID=furever-dock-hermes-agent
export SKIP_SCHEDULER_UPDATE=1
bash scripts/deploy-hermes-cloudrun.sh
```

部署后确认 latestReadyRevision、100% traffic、`/health`、`/mcp/health` 和日报预览。除非用户明确要求，不要运行 GCE 部署脚本，也不要更新 Scheduler。

## 安全交接

本 ZIP 不包含真实 `.env` 或 GCP 私钥。请通过公司密码管理器或 Secret Manager 获取配置，并优先使用同事自己的公司 GCP 账号。交接完成后轮换曾出现在原电脑上的密钥。
