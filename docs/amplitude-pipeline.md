# Hermes Amplitude 数据管线

> 面向其他 AI 审计/改进的设计文档。只记关键决策和已知脆弱点。

## 1. 数据源

**Amplitude Chart Export API v3**

```
GET https://amplitude.com/api/3/chart/{chart_id}/csv
Authorization: Basic base64(apiKey:secretKey)
```

响应格式：JSON wrapper `{"data": "<csv string>"}`，直接返回 CSV 文本则无 wrapper。

## 2. Chart 清单（当前 6+1 个）

| Chart ID | 指标 | 类型 | 粒度 | 备注 |
|----------|------|------|------|------|
| `a29etrut` | DAU | timeseries | 日 | 单行 "None" |
| `z9j6r8us` | WAU | timeseries | **周** | 需要跳过未完结周 |
| `cjwne7be` | New Users | timeseries | 日 | ⚠️ 分段图表：新用户/老用户两行，求和 |
| `ji5sqoml` | Companion Retention | retention (N-Day) | 日 | D1/D3/D7/D14/D30 |
| `xhd4uffg` | Purchase Completed | timeseries (分段) | 日 | ⚠️ 独立处理：不通过通用 parser，`deriveRevenueSnapshot` 独占总收入计算 |
| `1pzj77uk` | Purchaser Companion Retention | retention (N-Day) | 日 | D1/D3/D7/D14/D30 |
| *(derived)* | Daily Revenue | 计算值 | 日 | `xhd4uffg` 独立拉取，9.99/6.99 分段 × 人数求和 |

**配置入口**: `AMPLITUDE_CHART_IDS` 环境变量，逗号分隔。

## 3. 数据管线全流程

```
配置 (env)
  │
  ├─ fetchAllChartSnapshots()          ← 批处理，每批 3 个，间隔 500ms
  │   └─ fetchChartSnapshot(chartId)   ← 单 chart HTTP GET
  │       ├─ decodeCsvPayload()        ← 解 JSON wrapper
  │       ├─ parseCsvRows()            ← 手工 CSV 解析（引号安全）
  │       └─ parseChartCsv()           ← 分类为 timeseries/retention/unknown
  │           ├─ extractTimeseries()   ← 日期列匹配 + 周图 fallback
  │           └─ extractRetention()    ← N-Day / Bracket 分支
  │
  ├─ deriveRevenueSnapshot()           ← 独立二次拉取 xhd4uffg
  │
  ├─ buildReportMarkdown()             ← 纯文本日报（GET /hermes/report）
  │
  └─ generateDailyReport()             ← 飞书卡片日报
      ├─ analyzeDailySnapshots()       ← Gemini LLM 分析
      │   ├─ resolveAnalysisPrompt()   ← Prompt 来源：飞书文档 > 缓存 > 硬编码
      │   └─ fallbackAnalysis()        ← Gemini 不可用时的规则引擎
      └─ buildDailyCard()              ← 飞书卡片 JSON 2.0
```

## 4. CSV 解析决策树

### 4.1 Chart 分类 (`parseChartCsv`)

1. 找标题行（首列非空且不以 "Segment" 开头）
2. 找指标行（匹配 `Uniques|Totals|Average|N-Day Retention|Bracket`）
3. 找 header 行（首列 = `"Segment"`）
4. **数据行判定**：
   - 优先取 `"None"` 行（单 segment 图表）
   - **兜底**：如果没有 `"None"` 行（分段图表），取所有含数值的非 meta 行
5. 类型判定：
   - headers 含 `YYYY-MM-DD` → `timeseries`
   - headers 含 `Start Date` 或 title 含 `retention` → `retention`
   - 其他 → `unknown`（会标记 error）

### 4.2 Timeseries 取值 (`extractTimeseries`)

**关键决策：多行求和 (colSum)**

分段图表的 `"新用户"` 和 `"老用户"` 两行按列求和后作为该日指标值。单行图表的行为不变。

**Yesterday / DayBefore 定位**:
1. 精确匹配北京时间 yesterday = `shanghaiDate(-1)`、dayBefore = `shanghaiDate(-2)` 对应的 header
2. **周图 fallback**：取最近两列数值，跳过未完结周（header 日期距今天 < 7 天 且总列数 ≥ 3）

**脆弱点**：
- 依赖 Amplitude chart 时间列格式严格为 `YYYY-MM-DD`
- 周图的"跳过未完结周期"逻辑基于启发式阈值（7 天），不是从 Amplitude metadata 获取

### 4.3 Retention 取值 (`extractRetention`)

**关键决策：N-Day vs Bracket 自动检测**

- 找 `"Retained %"` 行
- 扫描所有 `Day X` 列头
- 如果列头含 `Day X-Y` 模式 → Bracket（全量展示）
- 否则 → N-Day（只展示 D1/D3/D7/D14/D30 里程碑）

**Day-over-Day 对比**：
- 同一个 retention chart 每次返回的是**今天每个 cohort 的 N-Day 值**，不是昨天的值
- 因此 DoD 对比通过 **cache** 实现：存下昨天的 D1 值（等），今天用昨天的作为 dayBefore
- 若某天 cache 丢失，retention 的 DoD 显示为 N/A —— 这是设计行为，不是 bug

## 5. Revenue 独立管线 (`deriveRevenueSnapshot`)

**为什么独立**：`xhd4uffg` 有两个 price segment（$9.99 / $6.99），通用 parser 无法正确处理产品价格分段。需要独立拉取、独立求和。

**逻辑**：
```
for each segment row (product = "9.99" | "6.99"):
    yesterdayRevenue += users_yesterday × price
    dayBeforeRevenue  += users_dayBefore × price
total = sum of both
```

**Display**: title 格式 `Daily Revenue (N × $9.99 + M × $6.99)`，价格降序排列。

**配置耦合**：`REVENUE_PRODUCT_PRICES` 和 `REVENUE_CHART_ID` 硬编码在 report.ts 中。新增价格点需要改代码。

**脆弱点**：
- 该 chart 的 header 列名是 `"product"` 而非 `"Segment"`，需要单独匹配
- 重复拉取导致此 chart HTTP 请求两次（一次进通用 pipeline，一次 deriveRevenueSnapshot 独立拉取）— 前者在结果中被过滤掉

## 6. 时区处理

| 概念 | 值 |
|------|-----|
| Amplitude 项目时区 | `America/Denver` (MST, UTC-7) |
| 日报显示时区 | MST (UTC-7) |
| 数据列日期 | Amplitude header 中的 `YYYY-MM-DD` (MST 日) |
| "昨天"定义 | `shanghaiDate(-1)` — 上海时间的昨天日期 |
| MST 日完结判断 | 北京时间次日 15:00 |
| 未完结标注 | "（数据未完结）" |

**注意**：这就是为什么 "昨天" 的北京日期 = Amplitude 列的 MST 日期 + 1 天（MST 0:00 = 北京 15:00，所以同日期的 MST 列从北京时间 15:00 开始有数据）。

## 7. 分析层

### Gemini 主路径
- System prompt 优先读飞书「CoCo 日报分析规范」文档（60s TTL 缓存，5s 超时）
- 降级链：飞书文档 → 旧缓存 → 硬编码 fallback
- 输出严格 JSON → `DailyAnalysis` 类型

### Fallback 规则引擎
- 当日 `changePct < -15%` → Alert
- 当日 `-15% ≤ changePct < -5%` → Watch
- 只有阈值判定，不包含交叉分析

## 8. 并发控制

```typescript
// 每次并发 3 个，间隔 500ms
for (let i = 0; i < ids.length; i += 3) {
  await Promise.all(batch.map(fetch));
  await sleep(500);
}
```

设计为**最小可行防 429**。峰值并发 3，6 个 chart 分 2 批完成。没有指数退避或重试逻辑。

## 9. 已知脆弱点一览

| # | 位置 | 问题 | 影响 |
|---|------|------|------|
| 1 | `extractTimeseries` fallback | 周图跳过未完结周期的阈值硬编码为 7 天 | 无法适配非 7 天的聚合周期 |
| 2 | `deriveRevenueSnapshot` | 价格分段硬编码，同一 chart 请求两次 | 新增价格点需改代码；浪费一次 HTTP 请求 |
| 3 | `parseChartCsv` 数据行判定 | 分段图表回退逻辑依赖 "有数值的 cell" | 全 0 的分段会被误过滤 |
| 4 | `fetchAllChartSnapshots` | 无重试机制 | 偶发 HTTP 429 时该 batch 全部失败 |
| 5 | `extractRetention` | 缓存 48h 过期，cache miss 时 DoD 为 N/A | 超过 2 天不跑日报，retention DoD 全部显示 0% |
| 6 | 时区 | Amplitude 内部时间处理不依赖 UTC offset 而是硬编码 +15:00 | Amplitude 项目改时区（如改到 UTC-8）会导致截数时间偏差 |
| 7 | `CHART_TITLE_OVERRIDES` | 空对象，依赖 Amplitude chart 名称 | chart 改名后日报标题随之变化 |
| 8 | `buildAnalysisPrompt` | 要求"至少 1 个 alert"，但全部指标正常时模型可能虚构 alert | fallback 在无异常时会生成"无显著告警"的 placeholder |

## 10. 关键文件索引

| 文件 | 职责 |
|------|------|
| `src/amplitude.ts` | API 调用、CSV 解析、snapshot 提取 |
| `src/report.ts` | 管线编排、revenue 计算、Markdown/飞书日报 |
| `src/analyze.ts` | LLM 分析 prompt、fallback 规则 |
| `src/card.ts` | 飞书卡片 JSON 构建 |
| `src/cache.ts` | Retention DoD 对比缓存（GCS/本地文件） |
| `src/env.ts` | 环境变量加载与校验 |
| `.env` | 本地密钥与配置 |
| `deploy/env-vars.yaml` | Cloud Run 配置 |
