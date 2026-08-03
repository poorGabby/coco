# FureverDock\_Hermes Agent

**\# Hermes × 飞书 Bot × Amplitude 日报 — 实习生 Brief**

\> **\*\*目标\*\***：搭建一个飞书 Bot【 随便叫个名字】，每天自动从 Amplitude 拉取 Kitty Screen 核心指标，整理成日报发到群里；同时支持群里 \`@【 随便叫个名字】\` 即时查询。

> 
> 
> 

\> 

**\#\# 1\. 你要交付什么**

|交付物|说明|
|---|---|
|`apps/hermes/` 服务|独立 Bun \+ Hono 小服务，负责拉数、生成报告、对接飞书|
|飞书 Bot 联调通过|群里 `@Hermes 日报` 能收到回复|
|定时日报|每天固定时间（默认北京时间 9:00）自动推送到指定群|
|`.env.example`|列出所有环境变量，不含真实密钥|
|简短使用说明|群里怎么用、指标含义、Dashboard 链接|

**\*\*不在 MVP 范围\*\***（可二期做）：

- LLM 自动解读数据

- 飞书交互卡片按钮

- 多群 / 多项目支持

---

**\#\# 2\. 系统长什么样**

```Plain Text
用户 @Hermes          Cloud Scheduler（每天 9:00）
      │                        │
      ▼                        ▼
飞书开放平台 ──事件推送──► Hermes 服务 ◄──定时触发──
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
              Amplitude API         飞书发消息 API
              （拉 Chart 数据）      （reply / sendToChat）
```

**\*\*关键概念\*\***：

\- **\*\*飞书 Bot\*\*** = 用户在群里看到的机器人，负责收消息、发消息

\- **\*\*Hermes 服务\*\*** = 你们写的后端，飞书把用户消息推过来，Hermes 拉 Amplitude 数据后回复

\- **\*\*Amplitude\*\*** = 产品埋点平台，桌面 App 已在往里面打点（如 \`app\_opened\`、\`companion\_alive\_daily\`）

---

**\#\# 3\. 开工前准备清单**

向 mentor 确认/领取以下资源：

\- \[ \] 飞书**\*\*管理员权限\*\***（能创建企业自建应用、审批权限、把 Bot 加进群）

\- \[ \] Amplitude 项目**\*\*只读或编辑\*\***权限

* [ ] GCP 项目访问（部署 Cloud Run \+ Cloud Scheduler，或 mentor 代部署）

* [ ] 本地开发环境：`bun` 已安装，能跑 `kitty-screen` monorepo

**\*\*需要记录的凭证\*\***（全部放 \`apps/hermes/\.env\`，**\*\*不要提交 git\*\***）：

|变量|来源|
|---|---|
|`FEISHU_APP_ID`|飞书开放平台 → 凭证与基础信息|
|`FEISHU_APP_SECRET`|同上|
|`FEISHU_REPORT_CHAT_ID`|联调后从消息事件日志里拿|
|`FEISHU_BOT_OPEN_ID`|同上（@ Bot 时 mentions 里的 open\_id）|
|`AMPLITUDE_API_KEY`|Amplitude → Settings → Projects|
|`AMPLITUDE_SECRET_KEY`|同上（Chart Export API 需要）|
|`AMPLITUDE_CHART_IDS`|Dashboard 里各 Chart 的 ID，逗号分隔|
|`HERMES_CRON_SECRET`|自己生成随机字符串，保护定时接口|

---

**\#\# 4\. 分阶段任务**

**\#\#\# Phase A：Amplitude 侧（半天）**@Gabby Gao

**\*\*目标\*\***：Dashboard 和 Chart 准备好，API 能拉到数。

1. 登录 [Amplitude](https://app.amplitude.com)，新建 Dashboard：`Kitty Daily Metrics`

2. 创建以下 Chart（事件名来自桌面 App 埋点）：

    |    Chart 名称|    事件|    指标类型|
    |---|---|---|
    |    DAU|    `app_opened`|    Uniques（去重用户数）|
    |    陪伴 DAU|    `companion_alive_daily`|    Uniques|
    |    加宠点击|    `pet_add_start`|    Event Totals|
    |    陪伴启动|    `companion_started`|    Event Totals|

3. 记下每个 Chart ID（URL 中 `/chart/12345` 的数字部分）

4. 记下 Dashboard 完整 URL（日报末尾附链接）

5. 复制 API Key \+ Secret Key

**\*\*完成标准\*\***：能在 Amplitude UI 看到昨日数据；Chart ID 列表已交给开发使用。

---

**\#\#\# Phase B：飞书 Bot 侧（半天）**

**\*\*目标\*\***：企业自建应用创建完成，Bot 能加进群。

**\#\#\#\# Step B1：创建应用**@Gabby Gao

1\. 打开 \[飞书开放平台\]\(https://open\.feishu\.cn/app\) → **\*\*创建企业自建应用\*\***

2. 名称建议：`Hermes`；上传 Bot 头像

3\. **\*\*添加应用能力\*\*** → 选择 **\*\*机器人\*\***

**\#\#\#\# Step B2：申请权限（必做）**

在 **\*\*权限管理\*\*** 申请并开通：

- `im:message` — 获取与发送单聊、群组消息

- `im:message:send_as_bot` — 以 Bot 身份发消息

- `im:chat:readonly` — 读取群信息（可选）

申请后 **\*\*创建版本 → 发布\*\***，等管理员审批（若你是管理员可直接通过）。

**\#\#\#\# Step B3：机器人页面要配什么？**

你截图里的 **\*\*「机器人」\*\*** 页，MVP 阶段 **\*\*大部分不用动\*\***：

|配置项|MVP 是否需要|说明|
|---|---|---|
|如何开始使用|❌ 跳过|可选 landing 页，不影响功能|
|消息卡片回调|❌ 跳过|二期做交互按钮再用|
|机器人自定义菜单|❌ 跳过|二期优化体验再用|

**\*\*真正要配的是另外两个 Tab\*\***（不在机器人页）：

|Tab|要做什么|
|---|---|

\| **\*\*事件与回调\*\*** \| 填 Hermes 服务的 HTTPS 地址 \+ 订阅 \`im\.message\.receive\_v1\`（接收群消息） \|

\| **\*\*权限管理\*\*** \| 开通上文列出的 im 权限 \|

**\#\#\#\# Step B4：Bot 进群**

1. 选定目标群（如 `#产品数据`）

2. 群设置 → 群机器人 → 添加 → 选 Hermes

3. 确认 Bot 在成员列表里

**\*\*完成标准\*\***：应用已发布；Bot 已在目标群；App ID / App Secret 已记录。

---

**\#\#\# Phase C：Hermes 服务开发（1\.5–2 天）**@郝晓语

**\*\*目标\*\***：本地跑通 \`@Hermes\` 回复。

**\#\#\#\# 目录结构**

```Plain Text
apps/hermes/
├── src/
│   ├── index.ts       # HTTP 入口：/feishu/events、/hermes/daily
│   ├── feishu.ts      # Token、reply、sendToChat
│   ├── amplitude.ts   # 按 Chart ID 拉数据
│   ├── report.ts      # 拼日报 Markdown / 卡片
│   └── env.ts         # 环境变量校验
├── package.json
├── .env.example
└── Dockerfile         # Phase D 部署用
```

在根 `package.json` 增加：`"hermes:dev": "bun --filter=@kitty/hermes run dev"`

**\#\#\#\# 核心接口**

**\*\*1\. \`POST /feishu/events\`\*\*** — 飞书事件推送

```Plain Text
收到请求
  ├─ type === "url_verification" → 返回 { challenge }
  └─ event_type === "im.message.receive_v1"
       ├─ 未 @ Bot → 忽略
       ├─ 已 @ Bot → 立即返回 200
       └─ 异步：拉 Amplitude → 生成 report → feishu.reply()
```

> ⚠️ 必须先返回 200 再异步处理，否则飞书 3 秒超时会重试。
> 
> 

**\*\*2\. \`POST /hermes/daily\`\*\*** — 定时日报

```Plain Text
校验 Header: X-Cron-Secret
  → generateReport(yesterday)
  → feishu.sendToChat(FEISHU_REPORT_CHAT_ID, report)
```

**\#\#\#\# 本地联调**

```Bash

```

**\# 终端 1：启动 Hermes**

bun run hermes:dev          \# 默认 PORT=8787

**\# 终端 2：暴露公网（飞书事件订阅需要 HTTPS）**

ngrok http 8787

```Plain Text

```

把 ngrok 的 HTTPS URL 填到飞书 **\*\*事件与回调 → 请求地址\*\***：

```Plain Text
https://xxxx.ngrok.io/feishu/events
```

保存后飞书会发 challenge 验证；通过后订阅 `im.message.receive_v1`。

在群里发 `@Hermes 测试`，从 Hermes 日志里抄：

- `chat_id` → `FEISHU_REPORT_CHAT_ID`

- Bot 的 `open_id` → `FEISHU_BOT_OPEN_ID`

**\*\*完成标准\*\***：\`@Hermes 日报\` 收到包含昨日指标的消息。

---

**\#\#\# Phase D：部署 \+ 定时（半天）**

**\*\*目标\*\***：去掉 ngrok，每天自动推送。

1\. 写 \`Dockerfile\`，部署到 **\*\*Cloud Run\*\***，拿到固定 HTTPS 域名

2. 把飞书事件订阅 URL 从 ngrok 改成 Cloud Run 地址

3\. 环境变量放进 **\*\*Secret Manager\*\***（或 Cloud Run 环境变量）

4\. 创建 **\*\*Cloud Scheduler\*\*** 任务：

- Cron：`0 1 * * *`（UTC 1:00 = 北京时间 9:00，可按需调整）

- 方法：`POST https://hermes-xxx.run.app/hermes/daily`

- Header：`X-Cron-Secret: <你的 secret>`

5. 手动触发一次 Scheduler，确认群里收到日报

**\*\*完成标准\*\***：不依赖本地/ngrok；Scheduler 手动运行成功。

---

**\#\# 5\. 日报内容模板**

MVP 用纯文本或简单 Markdown 即可：

```Markdown
📊 FureverDock 数据日报 · 2026-06-23
| 指标 | 昨日 | 前日 | 环比 |
|------|------|------|------|
| DAU | 1,234 | 1,180 | +4.6% |
| 陪伴 DAU | 890 | 850 | +4.7% |
| 加宠点击 | 45 | 52 | -13.5% |
| 陪伴启动 | 312 | 298 | +4.7% |
📎 Dashboard: https://app.amplitude.com/analytics/.../dashboard/...
```

**\*\*Amplitude 数据读取注意\*\***（写 \`amplitude\.ts\` 时必读）：

\- **\*\*Uniques（DAU）\*\***：用 \`overallSeries\`，不要把每日 uniques 相加（用户会重复）

\- **\*\*比率类（pct\_dau）\*\***：用 \`timeSeriesAverage\`，不要用 \`overallSeries\` 当 headline

---





