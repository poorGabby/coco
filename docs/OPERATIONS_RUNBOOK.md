# CoCo 运维手册

本文给接收开发人员使用。所有生产操作先确认 GCP project、region 和目标服务。

## 1. 日常健康检查

检查 Cloud Run：

```bash
gcloud run services describe hermes-report --region=us-central1
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="hermes-report"' --limit=50
```

检查 GCE 和容器：

```bash
gcloud compute instances describe hermes-agent --zone=us-central1-a
gcloud compute ssh hermes-agent --zone=us-central1-a --command='sudo docker ps; sudo docker logs --tail 100 furever-dock-hermes-agent'
```

业务验收：

1. 飞书私聊询问一个无需数据的问题。
2. 群内 @CoCo 询问最近完结日 DAU。
3. 检查回答日期是否标为美区完结日，数字是否来自工具。
4. 手动触发一次日报到测试群，不直接在全员群验证新版本。

## 2. 本地验证

```powershell
cd apps/hermes
npm ci
npm run test:agent
```

测试通过不代表外部 API 可用；Amplitude、Stripe、飞书和 Gemini 还需要使用测试凭据做集成验证。

## 3. 部署 Cloud Run

当前入口：

```bash
export GCP_PROJECT_ID=furever-dock-hermes-agent
bash scripts/deploy-hermes-cloudrun.sh
```

部署后检查：

- `/health` 返回 `{"ok":true}`。
- `/mcp/health` 返回 MCP 服务正常。
- GCE 调用 `/mcp` 未出现 401/503。
- 日报测试成功后再观察第二天 09:00 Scheduler 结果。

## 4. 部署 GCE Agent

完整构建并更新：

```bash
bash scripts/deploy.sh
```

只使用已有 `:latest` 更新 VM：

```bash
bash scripts/deploy.sh update-only
```

上游 Hermes 默认固定为 `v2026.5.29.2`。升级上游前，要重新核对 `deploy/Dockerfile` 的 `--extra feishu` 定制并在测试群验收。

## 5. 回滚原则

- Cloud Run：把流量切回上一个健康 revision。
- GCE：Artifact Registry 应保留带时间戳的镜像 tag；将目标镜像明确改为已知健康 tag 后重启。
- `config.yaml`：VM 更新脚本保留最近 5 份备份，可恢复上一份配置。

当前 GCE 脚本日常拉取 `:latest`，回滚步骤还不够自动化。接收后建议增加显式 `IMAGE_TAG` 参数，禁止生产仅依赖可变 `latest`。

## 6. 常见故障定位

### 飞书完全不回复

依次检查：GCE VM 是否运行、容器是否运行、飞书 WebSocket 日志、飞书应用权限和凭据。不要先修改 Cloud Run，因为飞书对话入口主要在 GCE。

### 能聊天但查不到数据

检查 Cloud Run 是否健康、GCE 到 `/mcp` 是否连通、两边 `COCO_MCP_KEY` 是否一致、Amplitude/Stripe 凭据是否有效。

### 日报没有推送

检查 Cloud Scheduler 最近执行结果、`HERMES_CRON_SECRET`、Cloud Run 日志、机器人所在群列表和飞书发消息权限。

### 收入与业务后台不一致

确认 Stripe 是否启用。当前优先使用 Stripe 成功入账并扣除退款的口径；Stripe 不可用时会回退到 Amplitude 购买人数 × `report.ts` 中的固定单价。

### 留存 WoW 异常

New User Retention 新口径候选：检查 `lthx47q8` CSV 元数据含起始事件 `user_id is not (none)`，All Users 对应的单日 cohort 行有 Users 和 Day N 完整数值。以已完结观察日 R 为锚，D1/D3/D7 分别读取 R−1/R−3/R−7 的 cohort，WoW 各自比较七天前的对应 cohort。缺失或未完结时不回退到更早日期。正式图表筛选和候选代码均需发布后才代表线上切换。Purchaser Companion Retention 继续核对 `/query` 的 `series.combined` 完整 `count/outof` 和既有独立 cohort WoW。

## 7. 变更纪律

- 任何生产变更先在测试群验证。
- 指标口径变更必须由业务负责人确认。
- 不在日志、Issue、PR 或聊天中粘贴密钥。
- 部署前运行自动化测试，部署后完成健康检查。
- 修改 Prompt/Skill 也视为生产行为变更，需要评审和版本记录。
- 不使用 `deploy/debug-*` 或一次性 fix 脚本作为日常标准流程。

## 8. 已知技术债务

- Cloud Run 允许匿名访问，多个调试/问答接口无鉴权。
- 飞书事件兼容入口尚未完成严格签名验证。
- Cloud Run 通过普通环境变量接收密钥，尚未接 Secret Manager。
- GCS bucket 名硬编码。
- 若 GCE 与 Cloud Run 同时接收同一飞书事件，存在重复回复风险，应明确唯一主入口。
- 多个历史脚本包含个人路径。
- Cloud Run 会话和知识库缓存仅在内存中。
## 2026-10-16 New User Retention release baseline

- Production source was recovered from successful Cloud Build `ac6a7929-a307-4cff-9ebd-d8d417c10126` in `us-central1`, matching the image of `hermes-report-user-summary-0914` (`sha256:b3cde2fbc0b8ed430aa763a86239890c06daad85f6c635894eef585d118e3a00`). The older handover clone must not be deployed directly.
- The retention change is merged on that production baseline. Existing Stripe net revenue, database tools, user summaries, export pagination, callback authorization and single-chat delivery are preserved. Purchaser retention is unchanged.
- New User Retention uses `_new` with `user_id is not (none)`, `companion_alive_daily`, strict calendar N-day retention in America/Dawson. For completed observation day R, D1/D3/D7 select R-1/R-3/R-7 independently. WoW moves both dates back seven days and reports percentage-point changes.
- Full merged regression suite: 91 tests passed; TypeScript passed. This is not by itself proof of deployment or actual message delivery.
- Deployment identity is the existing `hermes-deployer-20260917` service account, used through the isolated local configuration documented by the handover. Never publish authentication directories or keys. GitHub push is not automatic Cloud Run deployment.
- Release procedure: save the matching Amplitude starting-event filter, verify real CSV through the parser, build a versioned image, create a no-traffic candidate preserving all current configuration, verify health and read-only report, then switch traffic. Preserve `hermes-report-user-summary-0914` for rollback. Do not change Scheduler, IAM, Secrets, or the GCE market-video module for this release.
- Real preview files and aggregate business data remain local and are excluded from this public repository.

