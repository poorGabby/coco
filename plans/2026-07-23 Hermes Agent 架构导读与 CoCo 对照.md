# Hermes Agent 架构导读（初学者）与 CoCo 对照

> 日期：2026-07-23  
> 上游：https://github.com/NousResearch/hermes-agent  
> 文档：https://hermes-agent.nousresearch.com/docs/  
> 用途：弄懂 Hermes 思维与架构，并映射到本仓库 CoCo（Furever Dock）落地

---

## 0. 用一句话抓住 Hermes

**Hermes Agent =「常驻的 Agent 操作系统」**：  
入口（CLI / 飞书等）→ **同一个大脑（AIAgent 循环）** → 调工具 / MCP / Skill → 可定时（cron）→ 可记住（session/memory）。

它不是「写死几个 if 的聊天机器人」，而是：**模型负责判断做什么，运行时负责安全地执行工具并送回消息**。

---

## 1. 心智模型（带走的思维）

### 1.1 三层分离

| 层 | 干什么 | 类比 |
|----|--------|------|
| **入口层 Gateway / CLI** | 收用户消息、鉴权、选会话、把回复送回平台 | 前台接待 |
| **编排层 AIAgent** | 组 prompt、调 LLM、看要不要 tool_call、循环直到说完 | 项目经理 |
| **能力层 Tools / MCP / Skills / Cron** | 真正做事：跑命令、查 API、按手册行动、定时任务 | 专科外包 |

**思维要点**：加业务能力时，优先加「能力层」（MCP/Skill/cron），少改「编排层」和「入口层」。

### 1.2 「模型选型」vs「能力插件」

- 换 Gemini / GPT → 改 provider/model，不动业务。  
- 加 Stripe / Admin 数据 → 加 **MCP 工具** 或 Skill，不动飞书适配器。

### 1.3 对话 vs 定时是两条入口、同一个 Agent

```text
飞书消息 ──┐
           ├──► AIAgent.run_conversation()
cron 到期 ─┘         │
                     ├── tool_calls → MCP / terminal / …
                     └── 最终回复 → 投递到飞书 / local / …
```

日报、Needs Attention 告警：走 **cron**；日常问答：走 **Gateway**。

### 1.4 Skill ≠ 代码能力

- **Skill**：给模型看的「操作手册」（何时调什么工具、口径、禁止事项）。  
- **Tool/MCP**：真能执行的函数。  
Skill  alone 不能登录 Admin；Tool alone 缺少「何时用」会乱用。

### 1.5 安全默认：沙盒 + 密钥外置

- 危险命令要审批；DM 有 pairing/白名单。  
- 密钥在 `.env`，不进 Skill、不进聊天。  
- MCP 可插拔：挂了才有能力，卸了就降级。

---

## 2. 官方架构图（简化）

```text
┌─────────────── Entry Points ───────────────┐
│  CLI    Gateway(飞书/TG/…)    API Server   │
│  Cron   ACP(编辑器)           Batch        │
└──────────────────┬─────────────────────────┘
                   ▼
┌─────────────── AIAgent ────────────────────┐
│  Prompt Builder │ Provider 解析 │ Tool 调度 │
│  上下文压缩     │ chat/Anthropic…│ 70+ tools│
└────────┬───────────────────────┬───────────┘
         ▼                       ▼
   Session (SQLite)        Tool Backends
                           Terminal / Browser / Web
                           MCP（动态）/ File / …
```

核心文件（上游概念，不必背路径）：

- `run_agent.py` — AIAgent 对话循环  
- `gateway/run.py` — 消息网关  
- `tools/registry.py` — 工具注册  
- `tools/mcp_tool.py` — MCP 客户端  
- `cron/` — 调度  

---

## 3. 子系统深入浅出

### 3.1 Gateway（你们最依赖）

- 长驻进程，挂多个 **platform adapter**（含 Feishu）。  
- 飞书 WebSocket：无需公网回调 URL（所以 CoCo 用 **GCE VM**，不用 Cloud Run 跑 Gateway）。  
- 收到消息 → 鉴权 → 会话 → `AIAgent` → 回写飞书。

### 3.2 Agent Loop（大脑）

1. 拼 system prompt（身份 + 工具说明 + skills + 记忆）  
2. 调 LLM  
3. 若返回 `tool_calls` → 执行工具 → 把结果塞回对话 → 再调 LLM  
4. 直到产出最终自然语言回复  

**这就是 agentic**：意图由模型选工具，不是 `if (消息.includes("收入"))`。

### 3.3 Tools / Toolsets

- 内置：终端、文件、网页、浏览器、代码沙盒、委派子 agent 等。  
- 按 toolset 开关，避免一次塞太多工具干扰模型。

### 3.4 MCP（业务扩展主通道）

- Hermes 当 **MCP Client**：连接你配置的 server，把对方 tools 合成可调工具。  
- 你们：`config.yaml` → `mcp_servers.coco_data` → Cloud Run `/mcp`。  
- **思维**：业务数据尽量 MCP 化，Gateway 保持瘦。

### 3.5 Skills

- 符合 agentskills.io；可 `/skills` 浏览。  
- CoCo：`furever-daily-report`、行为/分析口径 skill。  
- cron 可 `--skill` 挂手册；也可 **no-agent + script** 更稳（你们日报现状）。

### 3.6 Cron

- 一等公民任务：到期 →（可选）跑 agent 或 **纯脚本** → deliver 到飞书/local。  
- 适合：日报、Needs Attention 巡检、备份提醒。

### 3.7 Memory / Session

- SQLite + FTS5：跨会话检索。  
- 学习环：从经验沉淀 skill / 记忆（上游卖点）；企业场景要控「写什么进记忆」，敏感数据勿持久化。

---

## 4. 与 CoCo 项目如何结合（对照表）

| Hermes 概念 | CoCo 落地 |
|-------------|-----------|
| Gateway + Feishu adapter | GCE `hermes-agent` 容器，WebSocket，生产 App |
| AIAgent + system_prompt | `deploy/config.yaml` 里 CoCo 身份与取数规则 |
| MCP Client | `mcp_servers.coco_data` → Cloud Run |
| MCP Server（业务） | `apps/hermes`：`coco-mcp.ts`（Stripe/Amplitude/建卡） |
| Skills | `deploy/skills/*`、飞书 Skill 文档 |
| Cron | 日报 `push-furever-daily-card.sh`；规划中的 needs-attention cron |
| 终端工具 | 发卡脚本、运维命令（受审批/沙盒约束） |
| 密钥 | VM `~/hermes-data/.env`、Cloud Run env |
| 不该进 Hermes 核心的 | Admin 业务库、Stripe 密钥逻辑 → 放 MCP |

### 你们仓库里的「双层」

```text
┌─ Hermes Agent（上游运行时，GCE）──── 对话 / cron / 飞书
│
└─ apps/hermes（自研 MCP 后端，Cloud Run）─ 取数 / 建卡
```

过渡期合理：**内核用上游，业务数据用自研 MCP**。北极星：新能力继续挂 MCP/Skill，不写关键词分支。

---

## 5. 常见误区

| 误区 | 正解 |
|------|------|
| 「列个资源库 URL，Hermes 就能读 Admin」 | 要 MCP/工具；文档只解决「怎么解释」 |
| 「全塞进 system_prompt」 | prompt 膨胀且难维护；口径放 Skill，取数放 MCP |
| 「Cron 必须让 LLM 算数」 | 关键路径可 no-agent 脚本（日报已验证） |
| 「Gateway 放 Cloud Run」 | 长连接不适合；用 GCE |
| 「改业务就要 fork Hermes」 | 优先 MCP + config + skill |

---

## 6. 自学路径（官方推荐顺序压缩版）

1. 本页心智模型 + 对照表  
2. [Architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture)  
3. [MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)  
4. [Cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)  
5. [Skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)  
6. 对照本仓库：`deploy/config.yaml`、`plans/2026-07-21 CoCo 改造成 Hermes Agent GCE 架构.md`、`HERMES_DEPLOYMENT_GUIDE.md`

---

## 7. 和 Needs Attention 方案的关系

Needs Attention 主动推送 = 典型 Hermes 扩展：

1. Admin 只读 API（业务侧）  
2. MCP 工具 `list_needs_attention_pets`（能力层）  
3. Cron + 去重脚本 + 飞书卡（入口/定时层）  
4. Skill 写口径（手册层）  

详见：`plans/2026-07-23 Needs Attention 主动推送.md`。
