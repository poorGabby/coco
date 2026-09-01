# CoCo 系统功能与代码导读

## 1. 系统定位

CoCo 是 Furever Dock 团队的飞书业务数据助手。它把飞书对话、产品数据、支付数据、知识库和 Gemini 连接起来，支持问答、数据查询和日报。

当前代码日期以仓库现状为准。生产资源默认位于 GCP 项目 `furever-dock-hermes-agent`、区域 `us-central1`。

## 2. 两层架构

```text
飞书用户
   │ 私聊 / 群内 @
   ▼
GCE VM: hermes-agent
   ├─ Hermes Agent / 飞书 WebSocket
   ├─ Prompt、Skill、会话和工具调度
   └─ 通过 Bearer COCO_MCP_KEY 调用远程 MCP
                    │
                    ▼
Cloud Run: hermes-report（apps/hermes）
   ├─ Amplitude：DAU、WAU、新用户、购买人数、留存
   ├─ Stripe：真实支付收入
   ├─ 飞书知识库：文档检索
   ├─ Gemini：分析与结构化结果
   ├─ GCS：留存历史缓存
   └─ Cloud Scheduler：每天 09:00 触发日报
```

### GCE 层为什么仍需要本仓库

GCE 运行的是容器镜像。镜像由 `scripts/deploy.sh` 在 Cloud Build 中拉取固定版本的公开 `NousResearch/hermes-agent`，再用本项目的 `deploy/Dockerfile` 加入飞书扩展并构建。`deploy/config.yaml`、Skills、启动和重启脚本都是本项目定制内容。

### Cloud Run 层为什么必须保留源码

`apps/hermes` 是本项目自研代码。线上镜像只能运行，不能替代可维护源代码。指标口径、日报样式、工具参数和数据源发生变化时，都需要修改并重新部署这部分。

## 3. 用户可见功能与代码位置

| 功能 | 当前行为 | 主要代码 |
|---|---|---|
| 飞书私聊问答 | 私聊直接响应 | `apps/hermes/src/index.ts`、`feishu.ts` |
| 群聊问答 | 群内需要 @ 机器人 | `index.ts`、`feishu.ts` |
| 数据自由问答 | Gemini 根据问题调用受控数据工具；失败时回退到旧问答链路 | `agent/agent-runner.ts`、`ask.ts`、`llm.ts` |
| Amplitude 指标 | DAU、WAU、New Users、购买人数、留存等 | `amplitude.ts`、`amplitude-skill.ts`、`daily-charts.ts` |
| 收入查询 | 优先 Stripe 成功入账金额；失败或未配置时用购买人数 × 单价回退 | `stripe.ts`、`report.ts`、`agent/tool-impls.ts` |
| 飞书知识库问答 | 读取指定空间/文档，内存建立全文缓存 | `feishu.ts`、`wiki-cache.ts`、`wiki-lookup.ts` |
| 日报 | 拉取数据、Gemini 分析、生成飞书交互卡片 | `report.ts`、`analyze.ts`、`card.ts` |
| 每日自动推送 | Cloud Scheduler 每天北京时间 09:00 调 `/hermes/daily`，发送到机器人所在群 | `index.ts`、`scripts/deploy-hermes-cloudrun.sh` |
| MCP 数据服务 | 给 GCE Hermes Agent 暴露 4 个业务工具 | `coco-mcp.ts`、`agent/tools.ts` |
| 多轮上下文 | 每个 chat 最多 20 条消息，30 分钟过期 | `conversation.ts` |

## 4. MCP 工具

Cloud Run 的 `/mcp` 使用 `COCO_MCP_KEY` Bearer 鉴权，当前注册：

- `fetch_daily_revenue`：查询收入，优先 Stripe。
- `fetch_amplitude_metric`：查询 DAU、WAU、New Users。
- `fetch_purchase_users`：查询购买去重人数。
- `build_daily_report_card`：生成日报卡片 JSON，不负责发送。

日期默认使用 `America/Denver` 最近完结日。Agent 约束要求一次只查一个指标、数字必须来自工具结果、WoW 基期为 0 时显示 N/A；Retention 主值读取正式 Chart overall/combined，WoW 暂时独立使用最新成熟单日 cohort vs 7 天前同日 cohort。

## 5. Cloud Run HTTP 接口

| 方法和路径 | 用途 | 当前鉴权 |
|---|---|---|
| `GET /health` | 服务健康检查 | 无 |
| `ALL /mcp` | CoCo MCP | Bearer `COCO_MCP_KEY` |
| `GET /mcp/health` | MCP 健康检查 | 无 |
| `POST /hermes/ask` | HTTP 问答 | 当前无 |
| `GET /hermes/report` | 日报文本预览 | 当前无 |
| `POST /hermes/daily` | 定时日报 | `X-Cron-Secret` |
| `POST /feishu/events` | 飞书事件回调兼容入口 | 当前无应用签名校验 |
| `/debug/*` | 事件、对话、知识库调试 | 当前无 |

生产部署使用 `--allow-unauthenticated`。`/debug/*`、`/hermes/ask` 和 `/hermes/report` 的无鉴权暴露是现阶段安全债务，交接后应优先关闭、限制 IAM 或增加管理员鉴权。

## 6. 数据与状态

- GCE 持久数据目录：VM 的 `$HOME/hermes-data`，挂载到容器 `/opt/data`。
- 留存缓存：Cloud Run 环境通过固定 GCS bucket `furever-dock-hermes-retention` 保存；本地回退为 JSON 文件。
- Cloud Run 对话历史：仅内存，实例重启或缩容后丢失。
- 飞书知识库缓存：仅内存，30 分钟刷新，实例重启后重新加载。
- Artifact Registry：保存 GCE gateway 和 Cloud Run hermes-report 镜像。

固定 GCS bucket 名应在后续改成环境变量，便于迁移新项目。

## 7. 目录说明

| 路径 | 作用 | 是否必须保留 |
|---|---|---|
| `apps/hermes/src` | 自研 Cloud Run 数据服务 | 必须 |
| `apps/hermes/package*.json` | Node 依赖及锁定版本 | 必须 |
| `apps/hermes/Dockerfile` | Cloud Run 镜像 | 必须 |
| `deploy/Dockerfile` | 定制 GCE Hermes 镜像 | 必须 |
| `deploy/config.yaml` | Agent、飞书、MCP 配置 | 必须；检查其中不得出现明文密钥 |
| `deploy/prompts`、`deploy/skills` | CoCo 行为与业务规则 | 必须 |
| `scripts/deploy*.sh` | 两层服务部署入口 | 必须 |
| `deploy/startup.sh`、`vm-restart.sh` | VM 自愈和更新 | 必须 |
| `docs`、`plans` | 当前说明和历史设计依据 | 建议保留 |
| `node_modules` | 本机安装产物，可由 lockfile 重建 | 不迁移 |
| `.env*` | 真实密钥或环境差异 | 模板保留，真实文件不进 Git |
| `*-key.json` | 服务账号私钥 | 禁止进 Git |
| `amplitude-csv`、`wix-test*.json` | 历史导出/测试数据 | 单独归档，非运行必需 |
| `debug-*`、一次性修复脚本 | 排障历史 | 可保留参考，但不能作为标准操作入口 |

## 8. 标准开发入口

要求 Node.js 22。进入 `apps/hermes`：

```powershell
npm ci
npm run test:agent
npm run dev
```

本地运行需要安全获取 `.env`，不要从 Git 下载真实密钥。常用命令：

```powershell
npm run report
npm run ask -- "昨天 DAU 如何？"
npm run test:amplitude
```

## 9. 标准部署入口

- Cloud Run 数据服务：`bash scripts/deploy-hermes-cloudrun.sh`
- GCE Agent 完整构建和更新：`bash scripts/deploy.sh`
- 只更新 GCE：`bash scripts/deploy.sh update-only`

部署前必须先确认当前 GCP project，避免把生产镜像部署到错误项目。当前脚本仍从本地 `.env` 注入环境变量；迁移到 Secret Manager 后，应同步改造部署脚本。

## 10. 后续迭代常见位置

- 增加/调整日报指标：`daily-charts.ts`、`amplitude.ts`、`report.ts`。
- 修改收入口径：`stripe.ts`、`report.ts`。
- 增加 Agent 工具：先改 `agent/tools.ts` 和 `tool-impls.ts`，再决定是否在 `coco-mcp.ts` 暴露。
- 修改日报视觉和文案：`card.ts`、`analyze.ts`。
- 修改知识库范围和检索：`wiki-cache.ts`、`feishu.ts`。
- 修改 CoCo 人设/规则：`deploy/config.yaml`、`deploy/prompts`、`deploy/skills`。
- 修改飞书响应逻辑：区分 GCE WebSocket 主链路与 Cloud Run 兼容回调，避免重复回复。

任何指标口径变更都应同时更新测试和本文档，并让业务负责人确认。
