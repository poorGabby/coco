# CoCo Agentic Workflow 升级计划

> 目标：在不推翻现有 Hermes/CoCo 机器人稳定链路的前提下，模仿小 Fur 的「LLM 调度 + Skill 指导 + Tool 执行」架构，把当前固定流程问答逐步升级为受控 Agentic Workflow。
>
> 写作日期：2026-07-13
> 适用项目：`E:\hermes` / `apps/hermes`

---

## 0. 结论先行

当前 CoCo 已具备一部分 Agent 雏形：

- 飞书入口、群聊/私聊、日报推送：`apps/hermes/src/index.ts`
- LLM 调用层：`apps/hermes/src/llm.ts`
- 飞书知识库读取与缓存：`apps/hermes/src/feishu.ts`、`apps/hermes/src/wiki-cache.ts`
- Amplitude 指标执行器雏形：`apps/hermes/src/amplitude-skill.ts`
- 行为手册从飞书文档读取：`apps/hermes/src/ask.ts`
- 对话短期记忆：`apps/hermes/src/conversation.ts`
- 部署与权限蓝图：`HERMES_DEPLOYMENT_GUIDE.md`、`COLLEAGUE_DEPLOY_HANDOVER.md`

但当前架构仍然是「代码固定调度 + LLM 总结」：

```text
用户问题
  -> 代码判断是否数据类
  -> 代码固定拉知识库 / Amplitude
  -> 拼接 Context
  -> Gemini 一次性回答
```

目标架构应逐步变成：

```text
用户问题
  -> LLM 判断意图
  -> LLM 读取匹配 Skill
  -> LLM 选择受控 Tool
  -> 后端执行 Tool 并返回结构化结果
  -> LLM 继续推理或输出最终答案
```

升级不建议一次性开放 `execute_python_code` 或裸数据库查询。第一阶段应做「受控 Agent」：只暴露少量安全工具，所有工具由 TypeScript 后端白名单实现。

---

## 1. 当前资产盘点

### 1.1 可直接复用的代码资产

| 资产 | 文件 | 当前作用 | 升级后角色 |
|---|---|---|---|
| 飞书事件入口 | `apps/hermes/src/index.ts` | 接收飞书消息、回复、日报推送 | 保持入口不变，内部从 `askQuestion` 切到 Agent runner |
| LLM 调用 | `apps/hermes/src/llm.ts` | Gemini `generateContent` 一次性问答 | 增加 tool-calling 循环或新增 `agent-runner.ts` |
| 问答编排 | `apps/hermes/src/ask.ts` | 固定拉 wiki/Amplitude，再交给 Gemini | 第一阶段保留 fallback，新增 Agent 路径灰度 |
| 知识库缓存 | `apps/hermes/src/wiki-cache.ts` | 启动预热、全文关键词搜索 | 封装为 `search_wiki` 工具 |
| 飞书 API | `apps/hermes/src/feishu.ts` | token、消息、wiki/docx/sheet/bitable 读取 | 封装 `send_feishu_message`、`read_feishu_doc` 等工具 |
| Amplitude 指标 | `apps/hermes/src/amplitude-skill.ts` | 语义指标名映射到 Segmentation API | 封装为 `fetch_amplitude_metric` 工具 |
| Amplitude 快照 | `apps/hermes/src/amplitude.ts` | 日报固定指标抓取 | 初期继续服务日报，后期拆成工具 |
| 对话记忆 | `apps/hermes/src/conversation.ts` | chatId 级短期内存 | Agent runner 的 history 输入 |
| 日报生成 | `apps/hermes/src/report.ts`、`apps/hermes/src/card.ts` | 固定日报 Markdown/Card | 封装为 `generate_daily_report` 工具 |
| 环境变量 | `apps/hermes/src/env.ts` | 集中读取 `.env` | 新增 Skill / Agent 开关变量 |

### 1.2 可直接复用的部署资产

| 资产 | 文件 | 用途 |
|---|---|---|
| GCE + Docker 部署蓝图 | `HERMES_DEPLOYMENT_GUIDE.md` | 继续沿用，不需要为 Agent 改基础设施 |
| 同事部署交接 | `COLLEAGUE_DEPLOY_HANDOVER.md` | 只涉及部署权限，不涉及业务编辑权限 |
| Docker / Cloud Build | `deploy/` | 继续复用 |
| 本地测试脚本 | `test-ask.cmd`、`test-report.cmd`、`test-server.cmd` | 加 Agent 后扩展测试 |

### 1.3 已存在但需要治理的业务知识资产

| 资产 | 当前形态 | 问题 | 升级方向 |
|---|---|---|---|
| CoCo 行为手册 | 飞书 doc token，由 `FEISHU_COCO_BEHAVIOR_DOC_TOKEN` 指向 | 是单一大 prompt，不是模块化 Skill | 拆成多份 Skill |
| 知识库内容 | 飞书 Wiki space + 本地缓存 | 是内容检索，不是操作 SOP | 保留为 `search_wiki` 数据源 |
| Amplitude 口径 | 部分在 `amplitude-skill.ts`、`amplitude.ts` 硬编码 | 业务口径变动仍要改代码 | 抽到 `skills/amplitude-analysis.md`，代码只保留注册表和安全校验 |
| 日报格式 | `report.ts`、`card.ts` 硬编码 | 格式调整要改代码 | 抽到 `skills/daily-report-sop.md`，代码保留渲染器 |

---

## 2. 权限模型设计

### 2.1 人员权限分层

| 角色 | 能做什么 | 不能做什么 | 实现方式 |
|---|---|---|---|
| 普通使用者 | 在飞书私聊/群聊提问 | 不能修改行为、工具、密钥 | 飞书群成员权限即可 |
| 业务管理员 | 编辑 Skill 文档，如指标口径、日报 SOP、回答风格 | 不能新增底层工具，不能接触 `.env`/密钥 | 飞书文档编辑权限或 repo PR 权限 |
| 开发者 | 修改工具代码、部署配置、环境变量、权限白名单 | 不应把密钥写入文档或 git | Git + GCP + 飞书开放平台权限 |
| 部署同事 | 按交接文档构建/部署 | 不能改 IAM/提权；不应改业务逻辑 | `hermes-deployer-key.json` 对应 SA，见交接文档 |

### 2.2 机器人运行权限

| 权限/密钥 | 当前依据 | 用途 | Agent 升级要求 |
|---|---|---|---|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | `env.ts`、`feishu.ts` | 获取 tenant token，读写飞书消息、文档 | 继续后端持有，绝不暴露给 LLM |
| 飞书 im scopes | `HERMES_DEPLOYMENT_GUIDE.md` | 收发消息、群信息 | 不变 |
| 飞书 docx/sheet/bitable 权限 | 当前代码已调用 docx/sheet/bitable API | 读取知识库、行为手册、表格 | 需要确认开放平台已开通对应只读 scopes |
| Amplitude API Key/Secret | `env.ts`、`amplitude-skill.ts` | 拉取指标 | 继续后端持有，Tool 只返回瘦身结果 |
| `GEMINI_API_KEY` | `llm.ts` | LLM 推理 | 后续可替换/增加 provider，但不影响工具设计 |
| `HERMES_CRON_SECRET` | `index.ts` | 定时日报鉴权 | 不变 |
| GCP SA key | `COLLEAGUE_DEPLOY_HANDOVER.md`、`hermes-deployer-key.json` | 部署 | 不进入 Agent runtime，不给业务管理员 |

### 2.3 Skill 编辑权限建议

建议先采用飞书文档作为 Skill 源，因为项目已经能读取飞书文档：

- Skill 文档所在知识库/文件夹：只给开发者和少数业务管理员编辑。
- 普通用户：只读或不可见。
- 变更流程：业务管理员改 Skill 文档 -> 机器人 60s 或手动刷新后生效 -> 观察 debug 日志。

如果 Skill 放入 repo：

- 业务管理员通过 PR 修改 Markdown。
- 优点：版本可追溯、可回滚。
- 缺点：非开发者编辑门槛高。

第一阶段建议：关键安全类 Skill 放 repo，业务 SOP 类 Skill 放飞书文档，待稳定后再统一。

---

## 3. 目标架构

### 3.1 分层

```text
飞书用户
  -> index.ts 接收事件
  -> conversation.ts 注入短期历史
  -> agent-runner.ts 执行 Agent 循环
     -> skill-registry.ts 选择/读取 Skill
     -> tools/*.ts 执行白名单工具
     -> llm.ts 调 Gemini tool calling
  -> feishu.ts 回复消息/卡片
```

### 3.2 Tool 白名单

第一阶段只开放以下工具：

| Tool | 后端实现 | 权限 | 返回给 LLM 的内容 |
|---|---|---|---|
| `read_skill_document` | 新增 `skills.ts` | 读取 repo/飞书 Skill 文档 | Markdown 文本，限制长度 |
| `search_wiki` | 复用 `wiki-cache.ts` | 飞书知识库只读 | top N 文档片段、标题、链接 |
| `fetch_amplitude_metric` | 复用 `AmplitudeSkill` | Amplitude key/secret 后端持有 | 日期、分组、核心数值，不返回原始大 JSON |
| `generate_daily_report` | 复用 `report.ts`/`card.ts` | Amplitude + 飞书发送由后端控制 | 报告摘要或卡片发送结果 |
| `send_feishu_message` | 复用 `feishu.ts` | im 发送权限 | 只允许发送到当前 chatId 或白名单 chatId |

暂不开放：

- `execute_python_code`
- 裸 `terminal`
- 裸数据库 SQL
- 任意 URL fetch
- 任意飞书文档写入

依据：当前项目还没有沙盒、审计和数据库只读账号；直接开放会扩大安全面。

---

## 4. 分阶段实施计划

## Phase 0：冻结基线与开关设计

### 操作

1. 记录当前线上行为：
   - 飞书私聊问答可用。
   - 群聊 @ 可用。
   - `/hermes/daily` 可推送。
   - `/debug/wiki` 可查看知识库缓存。
2. 在 `.env.example` 增加后续开关（实际改代码时执行）：
   - `AGENT_MODE=classic|agent|shadow`
   - `AGENT_MAX_STEPS=5`
   - `AGENT_SKILL_SOURCE=repo|feishu|hybrid`
   - `AGENT_TRACE_ENABLED=1`
3. `classic` 模式保持当前 `askQuestion` 固定流程。
4. `shadow` 模式让 Agent 在后台跑，但不把结果发给用户，只记录差异。
5. `agent` 模式正式由 Agent runner 接管回答。

### 权限

- 只需要开发者 repo 写权限。
- 不需要新增飞书/GCP/Amplitude 权限。

### 依据

- 当前 `index.ts` 已经把所有自由问答集中到 `askQuestion`，适合加开关。
- 当前系统服务真实用户，不能直接替换主链路。

### 验收

- `classic` 行为与当前一致。
- 环境变量未设置时默认 `classic`。

---

## Phase 1：建立 Skill 仓库与 Skill Registry

### 操作

1. 新建目录：
   ```text
   apps/hermes/skills/
   ```
2. 创建首批 Skill：
   ```text
   apps/hermes/skills/
   ├── coco-agent-core.md
   ├── amplitude-analysis.md
   ├── wiki-search.md
   ├── daily-report-sop.md
   ├── feishu-response-style.md
   └── safety-boundaries.md
   ```
3. 新增 `apps/hermes/src/skills.ts`：
   - `listSkills()`
   - `readSkillDocument(skillName)`
   - `selectSkillsByIntent(question)`，第一版用规则匹配，不用 embedding。
4. 把当前 `SYSTEM_PROMPT_FALLBACK` 拆到 `coco-agent-core.md` 和 `feishu-response-style.md`。
5. 把 Amplitude 当前已知规则写入 `amplitude-analysis.md`：
   - DAU/WAU/新用户/购买指标名。
   - 不要把 WAU 当 DAU。
   - 不要直接相加 daily uniques。
   - 使用 `AmplitudeSkill` 已注册指标。
6. 把知识库使用规则写入 `wiki-search.md`：
   - 先搜索知识库。
   - 若结果与问题不相关，应明确说未找到依据。
   - 引用来源标题。

### 权限

- 开发者 repo 写权限。
- 若 Skill 迁移到飞书文档：需要对应飞书文档编辑权限。

### 依据

- 小 Fur 文档中 Skill 是“程序性记忆”。
- 当前 CoCo 行为手册已经从飞书文档读取，说明项目接受“文档驱动行为”的方向。
- 当前业务规则散落在 `ask.ts`、`amplitude.ts`、`amplitude-skill.ts`，适合抽离。

### 验收

- 本地 CLI 能读取某个 Skill：
  ```bash
  npm run ask -- "你能读取 amplitude skill 吗"
  ```
- 读取失败时 fallback 到现有系统 prompt，不影响线上。

---

## Phase 2：封装安全 Tool 层

### 操作

1. 新建目录：
   ```text
   apps/hermes/src/tools/
   ```
2. 新增 `apps/hermes/src/tools/types.ts`：
   - 定义 Tool schema。
   - 定义统一返回格式：
     ```ts
     type ToolResult = {
       ok: boolean;
       summary: string;
       data?: unknown;
       error?: string;
     };
     ```
3. 新增 `read_skill_document`：
   - 调用 `skills.ts`。
   - 限制返回长度，例如 12k chars。
4. 新增 `search_wiki`：
   - 调用 `ensureWikiCache(env)` + `searchFulltext(query, maxResults)`。
   - 返回标题、段落、score、snippet。
   - 不返回整个知识库。
5. 新增 `fetch_amplitude_metric`：
   - 调用 `new AmplitudeSkill(...).execute(...)`。
   - 参数只能使用 `AmplitudeSkill.listMetrics()` 中已注册 metric。
   - 日期必须是 `YYYY-MM-DD` 或 `YYYYMMDD`，工具内部归一化。
   - 返回 `dates`、`segments`、核心数值。
6. 新增 `generate_daily_report`：
   - 调用现有 `generateDailyReport(env)`。
   - 第一阶段只返回“已生成摘要”，不让模型任意改卡片 JSON。
7. 新增受限 `send_feishu_message`：
   - 只能发送到当前触发消息的 `chatId`。
   - 不允许模型传任意 chatId，除非在代码白名单中。

### 权限

- 需要开发者 repo 写权限。
- 不需要新增外部权限。
- 复用现有飞书/Amplitude 环境变量。

### 依据

- 当前工具能力已有，只是被固定流程调用：
  - Amplitude：`amplitude-skill.ts`
  - Wiki：`wiki-cache.ts`
  - Feishu：`feishu.ts`
  - Daily report：`report.ts`
- 小 Fur 的 Tool 层不是让模型直接碰密钥，而是后端代执行。

### 验收

- 单元或 CLI 测试：
  - `read_skill_document("amplitude-analysis")`
  - `search_wiki("版本更新")`
  - `fetch_amplitude_metric("DAU", yesterday-7, yesterday)`
- Tool 返回里没有 API key、secret、`.env` 内容。

---

## Phase 3：实现 Agent Runner

### 操作

1. 新增 `apps/hermes/src/agent-runner.ts`。
2. 新增 `apps/hermes/src/agent-tools.ts`，集中注册 tools schema。
3. 扩展 `llm.ts`：
   - 保留 `generateGeminiReply`。
   - 新增 `generateGeminiWithTools` 或在 `agent-runner.ts` 内直接调用 Gemini tool calling API。
4. Agent runner 逻辑：
   ```text
   messages = system + history + user
   for step in 1..maxSteps:
     call LLM with tools
     if LLM returns tool call:
       validate tool name and args
       execute tool
       append tool result
       continue
     else:
       return final answer
   return fallback failure answer
   ```
5. 每次调用记录 trace：
   - `chatId`
   - question
   - selected skills
   - tool name
   - sanitized args
   - result summary
   - elapsed ms
6. 对 `ask.ts` 加模式开关：
   - `classic`：现有逻辑。
   - `shadow`：现有逻辑回复用户，Agent 后台跑并记录。
   - `agent`：Agent 回复用户，失败则 fallback 到 classic。

### 权限

- 开发者 repo 写权限。
- 如果使用 Gemini 原生 tool calling：不新增 API 权限，只依赖现有 `GEMINI_API_KEY`。
- 如果改用 Vercel AI SDK：需要新增 npm 依赖，需开发者确认依赖策略。

### 依据

- `llm.ts` 当前是最小 HTTP 调用，易于扩展。
- `conversation.ts` 已经支持 Gemini contents[] 历史，可复用。
- 当前项目依赖很少，第一版手写循环更可控。

### 验收

- `shadow` 模式下，同一个问题能看到 classic answer 和 agent trace。
- `AGENT_MAX_STEPS=5` 生效，不会死循环。
- 工具参数非法时，Agent 不崩溃，而是收到可读错误。

---

## Phase 4：把飞书入口切到受控 Agent

### 操作

1. 在 `index.ts` 的自由问答分支保持当前占位 reaction 与 history 逻辑。
2. `askQuestion(env, text, history)` 内部按 `AGENT_MODE` 选择：
   - classic：当前行为。
   - agent：调用 `runAgent`.
3. Agent prompt 必须包含：
   - 不泄露密钥。
   - 必须先读相关 Skill。
   - 数据类问题必须调用 `fetch_amplitude_metric` 或说明缺少工具。
   - 知识库类问题必须调用 `search_wiki`。
   - 不确定时先询问用户或说明待确认。
4. 保留现有 `/debug/wiki`。
5. 新增 `/debug/agent`：
   - 最近 N 次 tool calls。
   - 不显示密钥。
   - 仅本地/受控环境使用。

### 权限

- 开发者 repo 写权限。
- 飞书机器人权限不变。

### 依据

- `index.ts` 已经先返回 200，异步处理用户请求，适合 Agent 较长延迟。
- 现有 reaction 能缓解用户等待感。

### 验收

- 飞书私聊：
  - “昨天 DAU 为什么跌？” -> Agent 读 Amplitude Skill -> 调 Amplitude tool -> 回答。
  - “版本更新了几次？” -> Agent 搜 wiki -> 回答并引用来源。
- 群聊 @ 行为不变。
- Agent 失败时能 fallback 到 classic。

---

## Phase 5：Skill 从 repo 扩展到飞书文档

### 操作

1. 在 `.env.example` 增加：
   - `FEISHU_SKILL_INDEX_DOC_TOKEN=`
   - 或 `FEISHU_SKILL_DOC_TOKENS=`
2. 新增 `skillSource`：
   - repo skill：稳定、安全、随部署。
   - feishu skill：业务管理员可编辑。
3. 建议飞书 Skill 文档结构：
   ```text
   # Skill: amplitude-analysis
   ## Intent
   ## Core Principles
   ## Available Tools
   ## Parameters
   ## Pitfalls
   ## Output Format
   ## Examples
   ```
4. 技能权限：
   - 只有开发者/业务管理员可编辑。
   - 普通用户只读或无权限。
5. 加缓存：
   - 60s-5min TTL。
   - 读取失败使用旧缓存。

### 权限

- 需要飞书文档读取权限。
- 业务管理员需要对应 Skill 文档编辑权限。
- 不需要给业务管理员代码仓库/GCP/密钥权限。

### 依据

- 当前 `ask.ts` 已经通过 `FEISHU_COCO_BEHAVIOR_DOC_TOKEN` 拉行为手册。
- 小 Fur 的核心优势是业务 SOP 可由非开发者维护。

### 验收

- 修改飞书 Skill 文档中的一句规则，缓存过期后 Agent 行为变化。
- 删除/写错 Skill 时，Agent 退回 repo 版本或旧缓存。

---

## Phase 6：日报和复杂工作流 Agent 化

### 操作

1. 把当前日报固定生成逻辑保留为工具 `generate_daily_report`。
2. 创建 `daily-report-sop.md`：
   - 每日指标结构。
   - 指标异常判断。
   - 飞书卡片格式约束。
   - 哪些场景必须说明“不足以下结论”。
3. 新增自然语言触发：
   - 用户说“生成昨天日报” -> Agent 读日报 SOP -> 调 `generate_daily_report` -> 回复/推送。
4. 第二阶段才允许 Agent 影响日报文案。
5. 不建议第一阶段让 Agent 直接生成飞书卡片 JSON，避免格式不稳定。

### 权限

- 复用现有 `/hermes/daily` 与 `HERMES_CRON_SECRET`。
- 不新增外部权限。

### 依据

- 当前日报已经是核心生产能力，风险高，应先工具化而不是重写。

### 验收

- 定时日报行为不变。
- 手动问“发日报”时，Agent 能调用日报工具。

---

## Phase 7：观测、评测与安全加固

### 操作

1. 新增 `apps/hermes/src/agent-trace.ts`：
   - 内存 ring buffer。
   - 后续可落盘到 `hermes-data`。
2. 建立评测集：
   ```text
   docs/evals/agentic-workflow-cases.md
   ```
   覆盖：
   - 数据问题。
   - 知识库问题。
   - 混合问题。
   - prompt 注入。
   - 要求泄露密钥。
   - 模糊问题。
3. 新增 CLI：
   - `npm run ask -- "..."` 保持。
   - 可新增 `npm run eval:agent`。
4. 安全规则：
   - 工具白名单。
   - 最大步数。
   - 最大返回长度。
   - 不允许模型构造任意 URL。
   - 不允许模型指定任意 chatId。
   - 不允许模型访问 `.env`。

### 权限

- 开发者 repo 写权限。
- 不需要新外部权限。

### 依据

- Agent 架构可维护性的关键不是 prompt，而是 trace + eval。
- `HERMES_DEPLOYMENT_GUIDE.md` 已指出系统 prompt 是软约束，真正兜底靠最小权限。

### 验收

- 每次 Agent 回复可追溯“读了什么 Skill，调了什么 Tool”。
- prompt 注入测试不能泄露密钥或执行未授权工具。

---

## Phase 8：高级能力，延后实施

以下能力接近小 Fur 成熟形态，但不应作为第一阶段目标。

### 8.1 飞书文档写入

可能工具：

- `create_feishu_doc`
- `append_feishu_doc_blocks`
- `add_feishu_comment`

前置条件：

- 确认飞书开放平台写文档权限。
- 明确目标文档/文件夹白名单。
- 建立失败回滚或草稿机制。

风险：

- 模型生成 block JSON 不稳定。
- 写错文档影响团队资料。

### 8.2 数据库只读查询

可能工具：

- `lookup_user`
- `lookup_transactions`
- `lookup_generation_failures`

前置条件：

- 确认 FureverDock 实际数据库类型。
- 建只读账号。
- 明确允许查询的表和字段。
- 绝不开放裸 SQL，必须封装固定查询。

风险：

- PII/用户隐私。
- 数据库负载。
- 网络连通与凭据管理。

### 8.3 代码沙盒

可能工具：

- `execute_python_code`

前置条件：

- Docker/E2B/Modal 沙盒。
- 无网络或受控网络。
- 文件系统隔离。
- 超时/内存限制。

风险：

- 最高。没有沙盒前禁止开放。

---

## 5. 推荐时间线

### Week 1：受控 Agent MVP

- Day 1：Phase 0 开关 + Phase 1 repo Skill。
- Day 2：Phase 2 三个核心工具：`read_skill_document`、`search_wiki`、`fetch_amplitude_metric`。
- Day 3：Phase 3 Agent runner。
- Day 4：shadow 模式接入 `/hermes/ask`。
- Day 5：评测 20 个常见问题，修 Skill 和工具描述。

### Week 2：飞书灰度与业务可编辑

- Day 1：Agent 模式只对开发者 chatId 开启。
- Day 2：增加 `/debug/agent`。
- Day 3：飞书 Skill 文档源。
- Day 4：业务管理员编辑权限试运行。
- Day 5：总结失败案例，补 Pitfalls。

### Week 3：日报工具化与稳定化

- Day 1-2：`generate_daily_report` 工具接入 Agent。
- Day 3：日报 SOP Skill。
- Day 4：Agent 日报灰度。
- Day 5：决定是否扩大到全员。

### Week 4+：高级工具

- 飞书文档写入。
- RevenueCat / DB / Gmail 等新数据源。
- 沙盒。
- LangSmith/Helicone 等外部 tracing。

---

## 6. 待确认清单

以下内容目前无法从仓库中确定，不应猜测。

### 6.1 LLM 与 SDK

- 是否继续使用 Gemini HTTP 手写调用，还是引入 Vercel AI SDK / LangChain？
- 当前 Gemini 模型是否支持项目所需 tool calling 稳定性？
- 是否计划切换 DeepSeek/OpenAI/Claude？
- 是否接受新增 npm 依赖：`zod`、`jsonrepair`、`openai` 或 AI SDK？

### 6.2 Skill 存放位置

- Skill 最终放 repo、飞书文档，还是 hybrid？
- 哪些同事有 Skill 编辑权限？
- Skill 文档是否需要审批/版本记录？
- 飞书 Skill 文档是否已有目标文件夹？

### 6.3 飞书权限

- 当前飞书应用是否已开通并发布以下权限：
  - docx read raw content
  - docx blocks read
  - sheets read
  - bitable read
  - message send/reply/reaction
- 如果后续写文档，是否允许开写权限？
- 机器人是否应能向所有群发消息，还是只允许当前会话？

### 6.4 Amplitude 业务口径

- DAU 当前是否仍应使用 `_active`？
- WAU 是否需要专门的周粒度 API，而不是日级 `_active`？
- `purchase_completed` 是否代表真实收入，还是只能代表购买事件？
- 当前 `METRIC_REGISTRY` 需要哪些新增指标？

### 6.5 部署与安全

- `hermes-deployer-key.json` 是否应从工作区移除并轮换？它是长期私钥，不应进入仓库。
- 线上实际运行的是 `apps/hermes` 自写 Hono 服务，还是 `HERMES_DEPLOYMENT_GUIDE.md` 中的上游 Hermes Gateway？
- 当前生产环境是否仍用 Cloud Run，还是已迁移到 GCE VM？
- 是否允许将 agent traces 落盘到 `hermes-data`？

### 6.6 数据源扩展

- FureverDock 是否使用 RevenueCat？
- 是否有生产数据库只读账号？
- 是否有 Gmail/客服反馈渠道要接入？
- 是否需要 App Store / Google Play reviews？

---

## 7. 成功标准

### MVP 成功标准

- 用户问知识库问题时，Agent 会调用 `search_wiki`，并引用来源。
- 用户问数据问题时，Agent 会先读 `amplitude-analysis`，再调用 `fetch_amplitude_metric`。
- Tool 参数错误不会导致服务崩溃。
- Agent 失败时 fallback 到 classic。
- 普通用户不能通过提示词让机器人泄露 `.env` 或调用未授权工具。

### 业务成功标准

- 业务管理员能通过修改 Skill 改变回答口径，无需改 TypeScript。
- 开发者仍控制所有底层工具和密钥。
- 问答质量提升可通过 eval cases 复现，而不是靠感觉。

### 不做为第一阶段成功标准

- 模型能任意写代码执行。
- 模型能任意查数据库。
- 模型能任意写飞书文档。
- 完全替代现有日报代码。

---

## 8. 最小可行文件清单

第一轮实现预计新增：

```text
apps/hermes/skills/
├── coco-agent-core.md
├── amplitude-analysis.md
├── wiki-search.md
├── daily-report-sop.md
├── feishu-response-style.md
└── safety-boundaries.md

apps/hermes/src/
├── agent-runner.ts
├── agent-tools.ts
├── agent-trace.ts
├── skills.ts
└── tools/
    ├── types.ts
    ├── read-skill.ts
    ├── search-wiki.ts
    ├── fetch-amplitude.ts
    ├── daily-report.ts
    └── send-feishu.ts
```

第一轮预计修改：

```text
apps/hermes/src/ask.ts
apps/hermes/src/llm.ts
apps/hermes/src/env.ts
apps/hermes/package.json（仅在确认新增依赖后）
.env.example
```

---

## 9. 实施原则

1. 先受控工具，后自由工具。
2. 先 shadow，后灰度，再全量。
3. 业务规则进 Skill，安全边界留代码。
4. LLM 不接触密钥。
5. Tool 返回瘦身结果，不返回原始大 JSON。
6. 所有 Agent 行为可追踪。
7. 任何不确定业务口径都列为待确认，不让模型猜。

