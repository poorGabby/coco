# Plan：CoCo 主动发现 Needs Attention（Admin Incomplete Pets）

> 日期：2026-07-23（2026-07-24 更正：`kitty_readonly` 为 **PostgreSQL 只读账号**，非 Admin）  
> 状态：仍推荐 **路径 A**；数据源改为 **PG 只读查询**（需补齐连接与表口径后才能验证）  
> 关联：`.cursor/rules/coco-agentic-north-star.mdc`、`plans/2026-07-20 CoCo MCP 可插拔数据源与文档读写.md`、`HERMES_EXPANSION_PLAN.md` §1.2  
> 产品入口（人工现状）：https://admin.fureverdock.com/pets/incomplete  
> 受众：工程落地 + mentor 方案评审  

---

## 0. 背景与诉求

运营需定期打开 Admin「Incomplete / Needs Attention」页面人工核查宠物/用户异常。希望 **CoCo 自动发现** 这类对象，并 **主动推送到飞书**，免去人工定时巡检。

借鉴小 fur：**只读查询 + API 隔离 + 环境变量隐式鉴权 + 沙盒执行**。

**核心分歧（请 mentor 拍板）**：推送由谁发起？

| | **路径 A：CoCo 轮询 Admin** | **路径 B：Admin 状态变更 → 触发 CoCo** |
|--|------------------------------|----------------------------------------|
| 一句话 | CoCo 定时问「现在有谁」 | 进入 Needs Attention 时 Admin 主动通知 CoCo |
| 实时性 | 准实时（取决于 cron 间隔） | 近实时（秒～分钟） |

下文给出两条路径的架构、依赖、工具清单与对比，共用能力（MCP 查询、卡片、去重）尽量复用。

---

## 1. 目标 / 非目标

### 目标

1. 与 `/pets/incomplete` **同源**的 Needs Attention 数据可被 CoCo 使用。  
2. **主动推送**飞书 interactive 卡片（含 Admin 深链），免人工巡检。  
3. （可选）聊天问答走同一数据源。  
4. 凭证与生产写权限与 Gateway 隔离；密钥不进聊天、不进 Skill 文档。

### 非目标

- ❌ 浏览器登录爬 `admin.fureverdock.com` 页面。  
- ❌ 仅把 URL 写进资源库/知识库就当作「能实时发现」。  
- ❌ CoCo / Hermes Gateway 直连生产库或持有 Admin 写权限。  
- ❌ 以「运营刷新了 incomplete 页面」作为触发条件（那只是读 UI，会误触且会漏报）。  
- ❌ 开放任意 SQL / 任意 Admin URL 代理。  
- ❌ 本阶段自动在 Admin 里「处理/关闭」工单（只发现 + 通知；写操作另开计划）。

---

## 2. 两条路径架构

### 2.1 路径 A — CoCo 轮询 Admin（Pull）

```text
Admin 生产数据（与 /pets/incomplete 同源）
        │ 只读 GET
        ▼
┌───────────────────────────────────────┐
│  Admin Read API                         │
│  GET …/pets/incomplete（或等价）         │
└───────────────────────────────────────┘
        │ ADMIN_API_*（env，仅 Cloud Run）
        ▼
┌───────────────────────────────────────┐
│  Cloud Run：coco-data MCP               │
│  list_needs_attention_pets              │
└───────────────────────────────────────┘
        │ 定时 cron 拉取
        ▼
┌───────────────────────────────────────┐
│  GCE Hermes                             │
│  cron → diff(seen_ids) → 飞书卡片推送    │
│  聊天亦可调同一 MCP                      │
└───────────────────────────────────────┘
```

与现有 **日报** 同构：取数在 MCP；投递在 GCE cron + 发卡脚本。

### 2.2 路径 B — Admin 状态变更触发 CoCo（Push / Event）

**要点**：触发挂在 **业务写路径**（判定成功、记录进入 Needs Attention 集合），**不是**「有人打开/刷新了 Admin 页面」。

```text
Admin 业务逻辑：某宠物/用户进入 Needs Attention
        │ 出站事件（webhook / Pub/Sub）
        ▼
┌───────────────────────────────────────┐
│  受控入站入口（推荐 Cloud Run）          │
│  POST /hooks/needs-attention            │
│  · 签名校验（HMAC / 共享密钥）           │
│  · 幂等（event_id / pet_id）             │
│  · 可选：再拉一次详情做补全              │
└───────────────────────────────────────┘
        │ 建卡 + 发飞书（或通知 GCE 脚本）
        ▼
   飞书运营群（卡片 + 深链）

（可选兜底）低频 cron 全量对账，防事件丢失
```

与小 fur 隔离原则一致：Gateway 仍不持有 Admin 库权限；是 **Admin → 调用你们的受控 webhook**，密钥在服务端互验。

### 2.3 路径对比（供 mentor 评审）

| 维度 | 路径 A：轮询 Pull | 路径 B：事件 Push |
|------|-------------------|-------------------|
| **实时性** | 受 cron 限制（如 30～60 min） | 状态变更后秒～分钟级 |
| **空跑 / 成本** | 多数周期无新数据仍要拉全量 | 仅有变化时工作 |
| **Admin / 后端改造** | **低**：提供只读列表 API 即可 | **中高**：在进入列表处埋点发事件 + 契约 |
| **CoCo / Hermes 改造** | **低**：MCP + cron（照搬日报模式） | **中**：新增入站 webhook、验签、幂等；推送逻辑可复用 |
| **可靠性** | 简单；依赖 API 可用性 | 需重试、死信、签名；建议加低频对账 |
| **漏报风险** | 间隔内延迟，不丢（下次扫到） | 若 webhook 失败可能漏 → 需兜底轮询或重试队列 |
| **误报 / 刷屏** | 靠 CoCo 侧 `seen_ids` diff | 靠 event 幂等 + 同一套 seen/去重 |
| **「刷新页面就通知」** | 不涉及 | **明确不做**（应用写路径事件） |
| **上线速度** | 快（Admin API 就绪后 数天） | 取决于 Admin 能否排期埋点 |
| **长期形态** | 可作 MVP / 长期兜底 | 更贴「免人工巡检」的产品体验 |
| **安全面** | CoCo 出站持只读 Token | Admin 出站调 webhook；需防伪造（签名 + 可选 IP 允许列表） |

**建议决策框架**：

1. **若 Admin 短期难改写路径** → 先上 **路径 A**，尽快减负人工巡检。  
2. **若可排期埋点** → 目标态用 **路径 B**，保留 **低频路径 A 作对账兜底**（混合）。  
3. **卡片、深链、MCP 列表查询、Skill 口径** 两条路径共用，避免推倒重来。

### 2.4 2026-07-24 凭证更正 → PostgreSQL 只读 → **仍推荐路径 A**

> **更正**：技术部提供的 `kitty_readonly` **不是** Admin/Clerk 账号，而是 **Furever Dock PostgreSQL 数据库只读用户**。此前按 Admin 登录探测的结论作废；密码仅存密钥通道，**不写入本计划、不入库**。

| 项 | 结论 |
|----|------|
| 凭证类型 | PostgreSQL role：`kitty_readonly`（名称强烈暗示 **SELECT-only**） |
| 与 Needs Attention 的关系 | Admin 页 `/pets/incomplete` 的数据最终来自业务库；**若该 role 能 SELECT 到支撑该页的表/视图**，则 CoCo 可不经 Admin UI，直接查库 |
| 本仓库现状 | **无** `DATABASE_URL` / host / dbname / schema 文档；**无法在此刻实际连库验证** |
| 与路径 A | **高度匹配**：Cloud Run MCP 内用 `pg` 只读连接池拉列表 → cron 推送（对标 `HERMES_EXPANSION_PLAN.md` 的 bi_readonly 思路） |
| 与路径 B | 该账号**不能**代替 webhook；路径 B 仍要 Admin/后端埋点 |

#### 现在能不能通过数据库拿到对应数据？

| 判断 | 说明 |
|------|------|
| **概念上：能（路径 A 的优选数据源）** | 只读 PG + 固定 SQL/视图，比爬 Admin、比用人机 Clerk 会话更稳、更符合小 fur「只读 + 密钥在 env」 |
| **当下：还不能验证 / 还不能用** | 仅有用户名密码，**缺少**：①主机/端口/库名/SSL；②Cloud Run/GCE **网络是否可达**（Cloud SQL / 私网 / IP allowlist）；③该 role 的 **实际 GRANT**（能否读 pets/users 等相关表）；④**与页面同源的 SQL/视图定义**（incomplete 可能是多表条件或应用层计算，不是一张现成表） |

**阻塞清单（向技术部要齐后即可实测）：**

1. 连接串要素：`host` / `port` / `dbname` / `sslmode`（或完整只读 `DATABASE_URL`）  
2. 网络：是否需 VPC / Cloud SQL Auth Proxy / 白名单本项目出口 IP  
3. 权限：`\du` / `information_schema.role_table_grants` 证明仅 SELECT；列出可读 schema  
4. 口径：给出与 Admin「Needs attention」**等价**的 SQL 或 DB view 名（强烈建议后端维护 `pets_needs_attention` 视图，避免 CoCo 猜条件）

**推荐（给 mentor）**：

1. **主路径仍选 A（轮询）**，取数实现改为 **`kitty_readonly` → PostgreSQL`**（MCP 内固定查询），而不是 Admin HTTP。  
2. Admin `GET /api/admin/pets/incomplete` 可作对照金标准，联调时对条数；不必给 CoCo Clerk 账号。  
3. 路径 B 仍作二期（更实时），与 DB 账号并行不冲突；上线 B 后可用低频 PG 轮询做对账。

---

## 3. 需要外部提供的支持（按路径）

### 3.1 两条路径共用 / 路径 A 数据源（PostgreSQL）

| # | 需要提供 | 说明 |
|---|----------|------|
| D1 | **连接信息** | host/port/dbname/ssl，或只读 `DATABASE_URL`（密钥通道注入，禁止入库） |
| D2 | **网络开通** | Cloud Run（及如需 GCE）可达；Cloud SQL Proxy / VPC / IP allowlist |
| D3 | **GRANT 说明** | 确认 `kitty_readonly` 仅 SELECT；可读哪些 schema/表 |
| D4 | **与页面同源的查询** | SQL 或 view：等价于 Admin Needs attention / incomplete 列表 |
| D5 | **字段字典** | id、用户、宠物、原因、更新时间等；卡片与 diff 用 |
| A3 | **Admin 深链** | 列表 `/pets/incomplete`；详情 `/pets/$id`（给人点开，不给机器人爬页） |
| A5 | **判定口径文档** | 写入飞书 Skill |

**对照（非必须给 CoCo）**：Admin 前端仍走 `GET /api/admin/pets/incomplete`；可用于人工对账条数。

**当前状态**：仅有 DB 用户名；**D1～D4 未齐 → 现在还不能从库拉到 Needs Attention 数据。**

### 3.2 仅路径 A 额外需要

| # | 需要提供 | 说明 |
|---|----------|------|
| A7 | （可选）增量：`updated_at > :since` | 降低全量成本 |
| P2 | 扫描频率、工作时段 | 运营确认 |

### 3.3 仅路径 B 额外需要

| # | 需要提供 | 说明 |
|---|----------|------|
| B1 | **出站事件契约** | 何时发：进入列表 / 离开列表 / 字段变更；payload 字段；`event_id` |
| B2 | **投递方式** | HTTPS webhook 目标 URL（由 CoCo 侧提供）或 GCP Pub/Sub topic |
| B3 | **签名密钥协商** | 如 `NEEDS_ATTENTION_WEBHOOK_SECRET`；轮换方式 |
| B4 | **重试策略** | Admin 侧失败重试次数 / 退避；是否保证 at-least-once |
| B5 | **埋点位置确认** | 必须是业务判定写路径，不是前端 page view / 刷新 |

### 3.4 产品 / 运营（共用）

| # | 需要提供 | 说明 |
|---|----------|------|
| P1 | 推送目标群 chat_id | 日报群或独立告警群 |
| P3 | 告警策略 | 仅新增？超时未处理是否二次提醒？ |
| P4 | 卡片必显字段 | |
| P5 | 静默/免打扰 / 是否 @ 人 | |

### 3.5 基础设施（共用 + B 增量）

| # | 需要提供 | 说明 |
|---|----------|------|
| I1 | `DATABASE_URL`（或拆分变量）进 Cloud Run Secret | 使用 `kitty_readonly` |
| I2 | Cloud Run → PG 网络打通 | |
| I3 | 飞书正式应用已在目标群 | 已具备 |
| I4（仅 B） | 公网可达的 webhook URL + 密钥 | |

### 3.6 明确不需要 / 不建议的

- ❌ 爬 Admin HTML / 用 Clerk 人机账号给机器人登录  
- ❌ 生产库 **读写** 账号给 CoCo；Gateway 进程内直连库（密钥应只在 MCP/Cloud Run）  
- ❌ 把 DB 密码写进飞书 Skill / 聊天 / Git  
- ❌ CoCo 侧开放任意 SQL（只允许白名单查询 / 固定 view）

### 3.7 路径 A 在本项目中的用法（连接齐备之后）

```text
Secret Manager / Cloud Run env
  DATABASE_URL=postgresql://kitty_readonly:***@HOST:5432/DBNAME?sslmode=require

Cloud Run coco-data MCP
  list_needs_attention_pets
    → pg 连接池（只读）
    → 执行固定 SQL / SELECT * FROM <needs_attention_view>
    → 返回结构化 JSON（禁止模型拼 SQL）

GCE Hermes cron
  → 调 MCP → diff seen_ids → 飞书卡片（深链仍指向 Admin 页）
```

---

## 4. CoCo / Hermes 侧将提供的工具与组件

### 4.1 共用

| 组件 | 职责 |
|------|------|
| MCP **`list_needs_attention_pets`** | 只读列表；聊天 + 对账 |
| （可选）**`get_needs_attention_pet`** | 单条详情 |
| **`build_needs_attention_card`** | 飞书 Card JSON 2.0 |
| **发卡脚本** | 复用/扩展现有 interactive 发送 |
| **去重状态** | `seen_ids` / `event_id` 幂等存储 |
| **飞书 Skill** | 口径、深链、推送策略说明 |

### 4.2 仅路径 A

| 组件 | 职责 |
|------|------|
| Hermes cron + `push-needs-attention.sh` | 定时拉 MCP → diff → 推送 |
| 开关 `NEEDS_ATTENTION_PUSH_ENABLED` | 可 pause |

### 4.3 仅路径 B

| 组件 | 职责 |
|------|------|
| **`POST /hooks/needs-attention`**（Cloud Run） | 验签 → 幂等 → 建卡 → 发飞书 |
| （可选）低频 cron 对账 | 防丢事件 |
| 审计日志 | event_id、pet_id、推送结果 |

### 4.4 明确不提供

- 通用浏览器打开 Admin  
- 本阶段 Admin 写操作工具  

---

## 5. 分阶段实施（按选定路径裁剪）

### Phase 0 — 对齐依赖 + 路径决策（阻塞）

- [ ] Mentor / 后端拍板：**A / B / A 先上再混 B**  
- [ ] 交付 A1～A6（B 另加 B1～B5）  
- [ ] 运营确认 P1、P3～P5（及 A 的 P2）  
- [ ] curl 打通只读 API（B 另加 webhook 联调）  

### Phase 1 — 共用能力：MCP 只读 + 卡片骨架

- [ ] `list_needs_attention_pets` + 单测  
- [ ] 私聊可查列表（与页面条数对齐）  
- [ ] 卡片模板与深链  

### Phase 2a — 若选路径 A：cron 主动推送

- [ ] diff + cron + 多群推送  
- [ ] 验收：新增只推一次、重复扫描不刷屏  

### Phase 2b — 若选路径 B：webhook 主动推送

- [ ] 入站验签 + 幂等 + 推送  
- [ ] Admin 侧埋点联调  
- [ ] （建议）低频对账 cron  
- [ ] 验收：写入进入列表 → 飞书收到；重复投递不双发  

### Phase 3 — 治理

- [ ] 免打扰、审计、开关、Skill 上线  

---

## 6. 卡片与告警策略（草案）

**标题示例**：`⚠️ Needs Attention · N 条待处理`（或单条实时：`⚠️ 新增 Needs Attention`）

**正文**：原因 / 用户 / 宠物 / 时间 / [打开 Admin]

| 策略项 | 路径 A | 路径 B |
|--------|--------|--------|
| 默认推送时机 | 扫描发现 **新 id** | 收到 **entered** 事件 |
| 防刷屏 | `seen_ids` | `event_id` + `seen_ids` |
| 超时催办（可选） | cron 发现同 id 超 N 小时 | 定时对账或 Admin 发 `still_open` 事件 |

---

## 7. 安全与回退

| 风险 | 路径 A | 路径 B |
|------|--------|--------|
| 密钥 | 只读 Token 仅 Cloud Run | 另加 webhook 签名密钥 |
| 伪造请求 | 出站场景风险低 | 必须 HMAC/签名；可加来源限制 |
| 刷屏 | pause cron / 关开关 | 关 webhook 消费开关 + 幂等 |
| 漏报 | 拉长间隔会延迟 | 事件失败漏报 → 对账兜底 |
| 口径漂移 | 页面与 API 同步 | 事件字段与列表 API 同步 |

回退：pause cron / 停用 webhook 路由；聊天只读查询可保留。

---

## 8. 验收标准

**共用**

1. 私聊查询列表与 incomplete 页关键字段/条数一致（允许说明延迟）。  
2. 卡片深链可打开 Admin。  
3. 关开关后不再主动推送。  

**路径 A 追加**

4. 新条目在约定扫描周期内推送；未离开列表前不因 cron 重复刷屏。  

**路径 B 追加**

5. 业务侧写入进入 Needs Attention 后，约定时间内飞书收到推送（不依赖有人打开页面）。  
6. 同一 `event_id` 重放不导致双发。  

---

## 9. 决策摘要（给 mentor）

| 问题 | 结论 / 待拍板 |
|------|----------------|
| 能否只靠资源库？ | **否**；无法实时发现 |
| 能否爬 Admin 页？ | **否** |
| 路径 A | CoCo **轮询**只读 API → cron 推送；Admin 改动小、上线快、有延迟 |
| 路径 B | Admin **写路径事件** → webhook 触发 CoCo 推送；更实时，需后端埋点（**不是页面刷新**） |
| **基于 `kitty_readonly` 的推荐** | **路径 A**；取数用 **PostgreSQL 只读**，不是 Admin 登录 |
| 现在能否从 DB 取到 Needs Attention？ | **概念上可以；当前还不能**——缺 host/库名/网络/GRANT/同源 SQL |
| Admin HTTP | 前端仍有 `/api/admin/pets/incomplete`，可作对账，非 CoCo 主数据源 |
| 当前阻塞 | **D1～D4**（连接 + 网络 + 权限 + 口径 SQL/视图） |

---

## 10. 开放问题（请 mentor / 相关方拍板）

1. **是否同意主路径先走 A（PG 轮询），B 作二期？**（工程侧推荐：是）  
2. 请提供只读库 **连接信息 + 网络开通 + GRANT 范围**  
3. 请提供与 Admin Needs attention **等价的 SQL 或 view**  
4. 推送群：日报多群 vs 独立告警群？  
5. 扫描间隔、夜间是否推送、是否要「超时未处理二次提醒」？  
6. （二期）若选 B：写路径埋点排期与 webhook / Pub/Sub？  
