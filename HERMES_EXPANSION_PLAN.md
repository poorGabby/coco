# Hermes 能力扩展规划

> 本文档借鉴 patpet 项目的多源数据接入 + 用户反馈 SOP 体系，为 FureverDock 的 Hermes 机器人规划可实现的扩展方向。
>
> patpet 的核心思路是：**文本聚类 + 数据库事实核查 + 结构化研判** 的闭环，而非简单"总结文本"。
>
> 本文档标注了每个方向的：所需数据/权限、可行性、操作概览、预计工作量。

---

## 0. 当前状态速览

| 维度 | 已实现 | 已编码但暂停 | 缺失 |
|------|--------|-------------|------|
| 产品分析 | Amplitude 8 项指标 | GA4、Wix | — |
| 知识库 | 飞书 Wiki 19 篇（关键词匹配） | — | 语义搜索 |
| AI 引擎 | Gemini 2.5 Flash（日报分析 + 问答） | — | — |
| 消息入口 | 飞书群 @bot + 私聊 + 定时推送 | — | 其他平台 |
| 用户反馈 | — | — | 全部缺失 |
| 业务数据 | — | — | 全部缺失 |
| 订阅/收入 | Amplitude 推导收入（$9.99 x 购买人数） | — | RevenueCat |
| 代码库 | — | — | 未接入 |

---

## 1. 数据源扩展方向

### 1.1 🔴 Gmail — 用户反馈邮件

**对标 patpet**：多渠道反馈聚合的第一步，邮件是最常见的反馈渠道之一。

**所需数据 / 权限：**

| 项目 | 详情 |
|------|------|
| API | Gmail API (https://www.googleapis.com/gmail/v1/users/me/) |
| 认证方式 | 方案 A：OAuth 2.0 Desktop flow → refresh token 存 .env；方案 B：Google Workspace Service Account + 域级委派（如 @fureverdock.com 是企业邮箱） |
| Scope | https://www.googleapis.com/auth/gmail.readonly（只读）或 gmail.modify（可打标签） |
| 搜索查询 | from:feedback@fureverdock.com is:unread 或 subject:(feedback OR support OR bug) |
| 成本 | Gmail API 免费，100 万次/天配额 |

**操作概览：**

```
Phase 1 — MCP 快速验证（今天就能做）
├── 安装 gmcp: npx gmcp auth → npx gmcp start
├── 配置到 .mcp.json
├── 在 Claude Code 中手动测试：搜索、读取、分类邮件
└── 验证：分析 10 封 feedback 邮件，看分类准确度

Phase 2 — 集成到 Hermes（2-4h）
├── 新建 apps/hermes/src/gmail.ts
│   ├── 复用 ga4.ts 的 JWT 认证逻辑（换 scope）
│   ├── listFeedbackEmails(query, days)
│   └── getEmailContent(messageId) → {from, subject, body, date}
├── 新建 apps/hermes/src/feedback.ts（反馈分析引擎）
│   ├── classifyFeedback(emails) → Gemini JSON 模式
│   │   输出：[{category, sentiment, priority, summary, suggested_action}]
│   ├── 分类体系：Bug / Feature Request / Praise / Complaint / Billing
│   ├── 优先级：P1(阻断) / P2(严重) / P3(体验) / P4(建议)
│   └── 可选：自动打 Gmail 标签（Feedback/Processed）
├── 修改 apps/hermes/src/report.ts
│   └── generateDailyReport() 中并行拉取 feedback
├── 修改 apps/hermes/src/card.ts
│   └── 新增 "📬 用户反馈" 可折叠面板
└── .env 新增变量
    ├── GMAIL_FEEDBACK_QUERY="subject:(feedback OR bug OR support)"
    └── GMAIL_REFRESH_TOKEN=...
```

**输出格式（对标 patpet SOP）：**

每条 feedback 输出不是摘要，而是结构化事实：

```
User Info:   user_xxx / email / device
Phenomenon:  用户描述的客观现象
Backend Facts:  数据查证结果（如 "snaps 表中该用户 24h 内上传 3 张，其中 1 张含多宠"）
Category:    AI生成异常 / 支付 / Bug / 建议
Priority:    P1-P4
CS Mitigation:  客服安抚话术建议
```

---

### 1.2 🟠 PostgreSQL — 业务数据库只读接入

**对标 patpet**：这是 patpet 反馈分析体系的核心——"后端事实交叉验证"完全依赖数据库查询。
FureverDock 用的是什么数据库？托管在哪？（PostgreSQL / MySQL / Supabase / 其他）
**所需数据 / 权限：**

| 项目 | 详情 |
|------|------|
| 数据库类型 | 取决于 FureverDock 实际使用的数据库（PostgreSQL / MySQL / MongoDB） |
| 连接方式 | 创建 bi_readonly 只读用户，限制 SELECT 权限 |
| 网络 | 需要在 Hermes 服务所在 VPC 内可访问数据库（或通过 Cloud SQL Proxy） |
| 关键表（推测） | users（用户信息）、pets（宠物信息）、snaps（抓拍记录）、transactions（交易/积分流水）、feedback（如有内置反馈表）、subscriptions（订阅状态） |
| 安全要求 | 只读账号、最小权限原则、连接走内网/VPN、密码存 Secret Manager |

**操作概览：**

```
Phase 1 — 确认数据库（0.5h）
├── 确认 FureverDock 使用的数据库类型和托管位置
├── 确认是否有现成的只读副本或只读账号
└── 确认关键表结构和字段

Phase 2 — 建立连接（1-2h）
├── DBA 创建 bi_readonly 账号，授权 SELECT
├── Hermes .env 新增 DATABASE_URL
├── 新建 apps/hermes/src/db.ts
│   └── 使用数据库 driver（pg / mysql2 / mongodb）建立连接池
└── 在 Cloud Run 配置 VPC Connector 或 Cloud SQL Proxy

Phase 3 — 事实核查模块（2-3h）
├── 新建 apps/hermes/src/factcheck.ts
│   ├── lookupUser(userId) → 用户基本信息 + 注册时间 + 订阅状态
│   ├── lookupSnaps(userId, dateRange) → 抓拍记录（数量、质量、prompt 版本）
│   ├── lookupTransactions(userId) → 积分/代币流水
│   └── lookupFeedback(userId) → 历史反馈记录（去重、关联）
└── 集成到 /hermes/ask 的问答流程中
    → 用户问 "user_123 为什么生成失败？"
    → 自动查 snaps 表 → 发现源图不符合要求 → 给出具体原因
```

**关键原则（对标 patpet SOP）：**

> "针对具体的客诉，直接查询底层数据，还原'案发现场'，而不是仅依赖用户文字描述。"

---

### 1.3 🟠 RevenueCat — 订阅与收入数据

**对标 patpet**：patpet 通过 RevenueCat MCP 精准提取订阅、内购、MRR、试用转化率、退款状态。

**所需数据 / 权限：**

| 项目 | 详情 |
|------|------|
| 前提 | 确认 FureverDock 是否使用 RevenueCat 管理订阅 |
| API | RevenueCat REST API (https://api.revenuecat.com/v2/) |
| 认证 | API Key（只读密钥 RCH_ 开头，从 RevenueCat Dashboard → API Keys 获取） |
| MCP | RevenueCat 官方 MCP Server 可用 |
| 关键数据 | MRR、订阅数、试用转化率、退款率、流失率、各 SKU 收入 |

**操作概览：**

```
Phase 1 — 确认 + 获取 Key（0.5h）
├── 确认 FureverDock 是否使用 RevenueCat
├── 如是：RevenueCat Dashboard → Project Settings → API Keys → 生成只读 Key
└── 如否：跳过此方向，或考虑直接查数据库中的订阅表

Phase 2 — MCP 配置（15min）
├── .mcp.json 新增 RevenueCat MCP server
└── 在 Claude Code 中手动测试查询 MRR、订阅数

Phase 3 — 集成到日报（1-2h）
├── 新建 apps/hermes/src/revenuecat.ts
│   ├── fetchMRR() → 当前 MRR + 环比
│   ├── fetchSubscriptions() → 活跃订阅数 + 新订阅 + 流失
│   └── fetchTrialConversion() → 试用转化率
├── 修改 report.ts：将 RevenueCat 数据替换/补充当前的推导收入
└── 修改 card.ts：新增 "💰 订阅收入" 面板
```

**value**: 当前收入是 `Purchase Completed × $9.99` 推导，不够精确。RevenueCat 能给出真实的计费数据（含退款、试用、各档位收入）。


---

### 1.4 🟡 Typeform / Survey 数据接入

**对标 patpet**：patpet 通过 Typeform 问卷收集用户反馈，脚本自动拉取、对齐用户 ID。

**所需数据 / 权限：**

| 项目 | 详情 |
|------|------|
| 前提 | FureverDock 是否使用 Typeform（或其他问卷工具如 Google Forms） |
| API | Typeform API (https://api.typeform.com/) |
| 认证 | Personal Access Token（Typeform Dashboard → Settings → Personal Tokens） |

**操作概览（如使用 Typeform）：**

```
新建 apps/hermes/src/surveys.ts
├── listResponses(formId, since, until)
├── alignUserId() — 将问卷中的短 ID 映射到数据库 18 位 User ID
└── 加入反馈聚合 pipeline
```

---

### 1.5 🟢 本地代码库接入

**对标 patpet**：patpet 的工作区挂载了 `patpet-app-swift` iOS 源码、后端脚本等，AI 可以直接在代码库中搜索、分析、定位 Bug 根因。

**操作概览：**

```
方式 A：直接在 Claude Code 中操作（已有）
├── 打开 FureverDock 代码库目录
├── AI 可以搜索代码库定位 Bug 根因
└── 例如："用户在 feedback 说 crash on login → 搜索 login 相关代码 → 定位到异常处理缺失"

方式 B：集成到 Hermes 问答（高级）
├── 在 /hermes/ask 中检测到 Bug 相关提问
├── 自动 grep 代码库中相关文件
├── 将代码上下文送入 Gemini 分析
└── 回答中包含 "可能根因：LoginView.swift L128 缺少 error handling"
```

> ⚠️ 方式 B 需要 Hermes 能访问代码库（挂载 volume 或 clone 到 Cloud Run）。

---

## 2. 反馈分析体系设计（对标 patpet SOP）

### 2.1 分析流水线

```
                    ┌──────────────────────────────────────────────┐
                    │            反馈聚合层 (Feedback Ingestion)      │
                    │                                              │
  Gmail ──────────▶│  fetchFeedbackEmails()                        │
  App Store ─────▶│  fetchAppStoreReviews()                       │
  Typeform ──────▶│  fetchSurveyResponses()                       │
  DB feedback表 ─▶│  fetchDbFeedback()                            │
                    │                                              │
                    └──────────────────┬───────────────────────────┘
                                       │ 统一格式：{source, userId, timestamp, raw_text, device?, version?}
                                       ▼
                    ┌──────────────────────────────────────────────┐
                    │            去重 & 对齐层 (Dedup & Align)        │
                    │                                              │
                    │  • 用户 ID 对齐（短 ID → DB 长 ID）              │
                    │  • 时间戳硬过滤（避免历史数据污染）                │
                    │  • 同用户多渠道反馈去重（邮件 + review 同一件事）    │
                    │                                              │
                    └──────────────────┬───────────────────────────┘
                                       ▼
                    ┌──────────────────────────────────────────────┐
                    │            AI 分类 & 定级 (Classify & Triage)   │
                    │                                              │
                    │  Gemini JSON 模式：                            │
                    │  {                                           │
                    │    category: "AI生成异常" | "支付" | "Bug" |    │
                    │               "功能建议" | "投诉" | "其他",      │
                    │    sentiment: "positive" | "neutral" | "negative",│
                    │    priority: "P1" | "P2" | "P3" | "P4",      │
                    │    summary: "一句话描述",                       │
                    │    cluster_key: "同类问题的聚类标签"             │
                    │  }                                           │
                    │                                              │
                    └──────────────────┬───────────────────────────┘
                                       ▼
                    ┌──────────────────────────────────────────────┐
                    │          事实核查层 (Backend Fact-Checking)      │
                    │                                              │
                    │  P1/P2 反馈自动触发数据库查询：                    │
                    │  • AI 产出失败 → 查 snaps 表（源图质量、prompt 配置）│
                    │  • 交易异常 → 查 transactions 表（流水对账）       │
                    │  • 转化问题 → 查 Amplitude 事件（用户路径还原）     │
                    │  • 订阅问题 → 查 RevenueCat（订阅状态）          │
                    │                                              │
                    └──────────────────┬───────────────────────────┘
                                       ▼
                    ┌──────────────────────────────────────────────┐
                    │           结构化输出层 (Structured Output)       │
                    │                                              │
                    │  日报卡片 — "📬 用户反馈" 面板：                  │
                    │    • 本日 N 条新反馈，M 条 P1                   │
                    │    • 按 category 分组统计                      │
                    │    • P1 反馈详情 + 后端事实核查结果               │
                    │                                              │
                    │  飞书周报文档 — 自动写入 Bitable：               │
                    │    • Case 视觉聚类表（AI 质量问题的 before/after） │
                    │    • 趋势图（本周 vs 上周反馈量/类型对比）         │
                    │                                              │
                    │  研发工单 — 精简格式：                           │
                    │    • User Info                                │
                    │    • Phenomenon                               │
                    │    • Backend Facts                            │
                    │    • Dev Actions                              │
                    │    • CS Mitigation                            │
                    │                                              │
                    └──────────────────────────────────────────────┘
```

### 2.2 分类体系

```
Category Tree:

📱 AI 生成异常
├── VisionKit 识别问题（多宠、杂物、光线）
├── 大模型输出异常（畸形、空白、超时）
└── Prompt 不符合预期

💰 支付 & 订阅
├── 支付失败（渠道/网络/风控）
├── 订阅状态不同步（已付费但未解锁）
├── 退款/争议
└── 定价/套餐问题

🐛 功能 Bug
├── Crash / 闪退
├── Live Activity 中断
├── 推送通知问题
└── UI 异常/卡死

💡 功能建议
├── 新特性请求
├── 改进建议
└── 竞品对比

😡 投诉 & 其他
├── 客服投诉
├── 内容投诉
└── 账号/数据问题
```

### 2.3 优先级定级规则

| 级别 | 条件 | 响应 |
|------|------|------|
| **P1 — 阻断** | Crash、支付完全不可用、数据丢失 | 实时告警推送 + 日报标红 |
| **P2 — 严重** | 核心功能不可用（如 AI 生成全部失败）、高频客诉（日 >5 条同类） | 日报告警面板 |
| **P3 — 体验** | 有 workaround 的 Bug、偶发问题 | 日报关注面板 |
| **P4 — 建议** | 功能建议、体验优化 | 周报汇总 |

---

## 3. 原能力增强

### 3.1 知识库 — Embedding 语义搜索

**问题**：当前 wiki 搜索是 n-gram 关键词匹配，命中率低（如"收入为什么跌了"无法匹配"Revenue drop analysis"）。

**操作概览：**

```
新建 apps/hermes/src/embeddings.ts
├── 使用 Gemini Embedding API (text-embedding-004)
├── 对 19 篇 Wiki 文档预计算 embedding 向量
├── 存储在本地 JSON 文件或简单的向量缓存中
├── 查询时：query → embedding → cosine similarity → top-3
└── 语义匹配远超关键词（中英文、同义词、概念关联）

成本：~$0.000025/1k tokens，20 篇文档约 $0.002/次索引
```

### 3.2 主动告警

**问题**：指标异常要到第二天 9:00 才知道。

**操作概览：**

```
新增 GET /hermes/check 端点
├── 拉取 DAU、Purchases、Crash 等关键指标
├── 同比/环比跌超阈值？
├── 是 → 飞书群推送告警卡片

Cloud Scheduler 每 2 小时触发
└── 告警冷却：同一指标 6h 内不重复告警
```

### 3.3 恢复 GA4

**问题**：代码完整但缺权限。

**操作：** SA 管理员在 GA4 Admin → Property Access Management → 添加 service account email → Viewer → 取消 `report.ts` 中的注释。

---

## 4. 📁 新增文件清单

```
apps/hermes/src/
├── gmail.ts           # Gmail API 客户端（认证 + 拉取邮件）
├── feedback.ts        # 反馈分析引擎（去重 + 分类 + 定级）
├── factcheck.ts       # 数据库事实核查（查 snaps/transactions 等）
├── db.ts              # 数据库连接池
├── app-reviews.ts     # App Store / Google Play Review 拉取
├── revenuecat.ts      # RevenueCat API 客户端
├── surveys.ts         # Typeform 问卷拉取
├── embeddings.ts      # Wiki 语义搜索（向量索引）
├── check.ts           # 主动告警端点

.env 新增变量：
├── GMAIL_REFRESH_TOKEN=...
├── GMAIL_FEEDBACK_QUERY=subject:(feedback OR bug)
├── DATABASE_URL=postgresql://bi_readonly:xxx@host:5432/furever
├── REVENUECAT_API_KEY=RCH_...
├── REVENUECAT_PROJECT_ID=...
├── APP_STORE_APP_ID=...
├── GOOGLE_PLAY_PACKAGE_NAME=...
└── TYPEFORM_TOKEN=...
```

---

## 5. 实施路线图

```
Week 1 ─ 🔴 快速验证
├── Day 1-2: Gmail MCP 配置 + 手动测试
├── Day 3-4: 新增 src/gmail.ts + src/feedback.ts
└── Day 5:   反馈分析结果接入日报卡片

Week 2 ─ 🟠 核心数据源
├── Day 1-2: 确认数据库类型 + 建立只读连接（src/db.ts）
├── Day 3-4: 事实核查模块（src/factcheck.ts）
├── Day 5:   恢复 GA4（30min）+ RevenueCat 确认

Week 3 ─ 🟡 扩展覆盖
├── Day 1-2: App Store Review 监控（src/app-reviews.ts）
├── Day 3:   RevenueCat 集成（如适用）
├── Day 4-5: 语义搜索升级（src/embeddings.ts）

Week 4 ─ 🟢 运营增强
├── Day 1-2: 主动告警端点（/hermes/check + Scheduler）
├── Day 3-4: 飞书周报自动写入 Bitable
└── Day 5:   多平台测试 + 文档完善
```

---

## 6. 依赖与阻塞

| 方向 | 阻塞点 | 需要谁 | 预计解决时间 |
|------|--------|--------|-------------|
| Gmail | 无（OAuth 自助） | 你自己 | 今天 |
| 数据库 | 需确认 DB 类型 + 建只读账号 | DBA / 后端 | 1-2 天 |
| GA4 | SA 权限 | SA 管理员 | 30 分钟 |
| RevenueCat | 需确认是否使用 | PM / 后端 | 即答 |
| Typeform | 需确认是否使用 | PM / 运营 | 即答 |
| App Store | 需确认 App ID | PM | 即答 |

---

> *最后更新：2026-07-07*
