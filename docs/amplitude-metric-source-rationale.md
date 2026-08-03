# Hermes 日报 · Amplitude 指标拉取详解与理据

> 用途:记录日报每个指标的**精确拉取方式**(API 端点 / 请求参数 / 时区 / 日期窗口)与**采用理据**。
> 生成:2026-07-11。所有数值与参数均经源码逐行核实 + Amplitude 生产 API 实测,非推断。
> 认证:HTTP Basic,`AMPLITUDE_API_KEY:AMPLITUDE_SECRET_KEY`。项目时区:America/Denver(UTC-7)。

---

## 一、总览:两个端点

| 端点 | 覆盖指标 | 说明 |
|---|---|---|
| Segmentation API v2 `/api/2/events/segmentation` | DAU、New Users、WAU、Purchase(→Revenue) | 现算,返回结构化 JSON |
| Chart Export API v3 `/api/3/chart/{id}/csv` | Companion / Purchaser Retention | 读图表算好的 CSV |

代码位置:Segmentation 见 `apps/hermes/src/amplitude-skill.ts`;Retention 见 `apps/hermes/src/amplitude.ts` 的 `fetchChartSnapshotLegacy` / `extractRetention`;编排见 `fetchAllChartSnapshots`。

---

## 二、精确拉取清单(端点 / 参数 / 时区 / 日期窗口)

### 通用请求构造(Segmentation API)
实际发送的查询参数**只有** 4 个 + 1 个防缓存:
- `e` = event JSON,如 `{"event_type":"_active"}`;带分组时 `{"event_type":"purchase_completed","group_by":[{"type":"event","value":"product"}]}`
- `start` = `YYYYMMDD`(无横线)
- `end` = `YYYYMMDD`(无横线)
- `m` = measure(`uniques`)
- `_t` = `Date.now()`(绕开 CDN 缓存)

⚠️ **不发送 `i`(interval)参数**:`i` + `group_by` 会触发 HTTP 400(源码显式注释)。
⚠️ **不发送 `timezone` 参数**:Amplitude 默认按项目时区(Denver)解释 `start/end`,与我们计算日期的时区一致,无需显式传。

日期由 `amplitudeDateStr(offset)` 生成,在 America/Denver 时区下取偏移日。`yesterday=amplitudeDateStr(-1)`、`dayBefore=amplitudeDateStr(-2)`。

---

### 1. DAU
| 项 | 值 |
|---|---|
| 端点 | `GET /api/2/events/segmentation` |
| 事件 (`e`) | `{"event_type":"_active"}` |
| measure (`m`) | `uniques` |
| `start` / `end` | `amplitudeDateStr(-7)` → `amplitudeDateStr(-1)`(近 7 天,Denver) |
| 时区 | America/Denver(项目默认,未显式传) |
| 取值 | `dailyTrend[yesterday]` 单日值;环比 = 昨日 vs 前日 |
| 07-09 实测 | **99** |

### 2. New Users
| 项 | 值 |
|---|---|
| 端点 | `GET /api/2/events/segmentation` |
| 事件 (`e`) | `{"event_type":"_new"}` |
| measure (`m`) | `uniques` |
| `start` / `end` | `amplitudeDateStr(-7)` → `amplitudeDateStr(-1)` |
| 时区 | America/Denver |
| 取值 | `dailyTrend[yesterday]` 单日值;环比 = 昨日 vs 前日 |
| 07-09 实测 | **51** |

### 3. WAU(自然周,week-to-date)
| 项 | 值 |
|---|---|
| 端点 | `GET /api/2/events/segmentation` |
| 事件 (`e`) | `{"event_type":"_active"}` |
| measure (`m`) | `uniques` |
| `start` / `end` | 本周一 `amplitudeWeekMonday(0)` → `yesterday`(= **周内至今**) |
| 上周对比窗口 | `amplitudeWeekMonday(-1)` → `amplitudeDateStr(-8)`(上周一 → 上周同一天) |
| 时区 | America/Denver |
| 取值 | `periodTotalUniques`(整段去重,非日趋势) |
| 07-09 实测 | **234**(周内 4 天;整周图表 ~287-290) |

### 4. Purchase → Revenue
| 项 | 值 |
|---|---|
| 端点 | `GET /api/2/events/segmentation` |
| 事件 (`e`) | `{"event_type":"purchase_completed","group_by":[{"type":"event","value":"product"}]}` |
| measure (`m`) | `uniques` |
| `start` / `end` | `amplitudeDateStr(-7)` → `amplitudeDateStr(-1)` |
| 时区 | America/Denver |
| 取值 | 按 product 分段(9.99 / 6.99),取各段昨日人数 |
| Revenue 派生 | 本地纯函数:`9.99×人数 + 6.99×人数`(`report.ts` 的 `deriveRevenueSnapshot`) |
| 07-09 实测 | 9.99×2 + 6.99×1 = **$26.97** ✅ 与图表一致 |

### 5. Retention(Companion / Purchaser)
| 项 | 值 |
|---|---|
| 端点 | `GET /api/3/chart/{id}/csv` |
| Chart ID | Companion `ji5sqoml`、Purchaser `1pzj77uk`(env `AMPLITUDE_RETENTION_CHART_IDS`) |
| 图表类型 | N-Day Retention(UTC-7) |
| 读取 | CSV 的 "Overall Retained %" 行(Amplitude 动态分母,逐日缩小) |
| 展示天数 | **D1 / D3 / D7**(`KEY_DAYS={1,3,7}`,2026-07-11 从 {1,3,7,14,30} 收窄) |
| 环比 | 与昨日运行时缓存值对比(`retention-cache.json` @ GCS,>48h 失效) |
| 07-09 实测 | Companion `D1=26.0% D3=21.0% D7=16.2%`;Purchaser `D1=46.7% D3=44.4% D7=43.5%` |

---

## 三、Segmentation API 现算为何合理(理据)

**3.1 用的是 Amplitude 官方标准定义。** `_active` / `_new` 是平台内置的全局特殊事件(Any Active Event / New User),不掺任何人工过滤或分段。以它算 DAU/新增 = 直接采用 Amplitude 官方口径,比 UI 里可能被随手改过的图表更"标准"。

**3.2 时区一致,且实测无边界污染。** start/end 用 Denver 时区算,Amplitude 也按项目 Denver 时区解释——一致,无偏移。实测证伪"UTC 边界把 07-10 漏进 07-09":

```
DAU 07-09:  end=07-09 → 99  | end=07-10 → 99  | end=07-15 → 99   (纹丝不动)
dailyTrend: ... "07-08":88, "07-09":99, "07-10":107   (每日独立按日期存)
```

**3.3 不传 `i` 是必需且正确的。** Purchase 需 group_by,传 i 会 400;DAU/New 取单日值、WAU 取整段去重,本就不需要 interval。

**3.4 可复现、可审计、稳定。** 口径写在代码(`METRIC_REGISTRY`)进 git;历史每日值稳定(§3.2);收入本地派生透明,已核对 $26.97。

---

## 四、两种方案利弊对比

| 维度 | Segmentation API 现算(当前 ✅推荐) | Chart CSV 导出 |
|---|---|---|
| 定义来源 | Amplitude 官方 `_active`/`_new` 标准 | UI 人工搭建(可能含过滤/自定义) |
| 与 UI 图表一致性 | ❌ DAU/New 差 ~5、WAU 差 ~56 | ✅ 逐格一致 |
| 可审计/防漂移 | ✅ 代码+git,集中注册表 | ⚠️ UI 改动静默传导,无版本记录 |
| 稳定性/耦合 | ✅ 无外部耦合,历史值稳定 | ⚠️ 图表被改 → 数字跟着变 |
| 时区正确性 | ✅ Denver,实测无偏移 | ⚠️ `extractTimeseries` 用北京时间选列,是真 bug,切换须先修 |
| 解析健壮性 | ✅ 结构化 JSON | ⚠️ CSV 格式多变(N-Day/Bracket、`product`/`Segment` 表头、分段行) |
| 未完结数据 | ✅ 按日期精确取昨日 | ⚠️ 末列常是未完结今日/本周,需排除 |
| 肉眼对账友好 | ⚠️ 需解释为何 ≠ 图表 | ✅ 打开 Amplitude 即可核对 |

---

## 五、差异根因(明确)

- **DAU/New Users 高约 5**:Segmentation 用官方 `_active`/`_new`;对比图表(`a29etrut`)用另一套事件/过滤。同天、同时区、历史稳定,唯一区别是查询口径。实测:Segmentation 99 vs 图表 94。
- **WAU 低约 56**:机器人 = 本周一→昨日的 **week-to-date**(现 4 天);图表 = **整周**(~287-290)。窗口天数不同。

> 均**非**时区、UTC 边界或 `i` 参数所致——这些假设已逐条实测排除。

---

## 六、为何推荐 Segmentation API

1. **定义更权威**:官方标准指标,不受某张图表的人为配置影响。
2. **可审计、防漂移**:口径进 git,不随 UI 静默变化。
3. **稳定性经实证**:历史每日值独立稳定(§3.2)。
4. **健壮性高**:结构化 JSON,避开 CSV 脆弱与时区 bug。
5. **差异可解释、可接受**:图表非"更正确",只是"另一种口径";收入两法完全一致($26.97),证明底层事件数据无问题,差异纯在聚合定义。

**反向条件**:仅当团队明确要求"日报必须与 Amplitude UI 图表逐格一致、以图表为唯一事实来源"时,才值得切回 Chart CSV(须先修时区/分段/表头三处)。在此之前维持现状更稳健。

---

## 七、Retention 例外:为何唯独它走 Chart CSV

前六节的结论(推荐 Segmentation API)只适用于 DAU / New Users / WAU / Purchase 四项。**Retention(Companion / Purchaser)是唯一例外,走 Chart Export API v3(`/api/3/chart/{id}/csv`),而非 Segmentation。** 这是有意为之,原因如下:

**7.1 留存计算本身复杂,不宜自己现算。**
留存率 = 「Day 0 触发起始事件的用户,在第 N 天回访目标事件的比例」。它涉及:
- 逐 cohort(按 Day 0 日期分组)追踪;
- 每个 Day N 的**动态分母**——只统计"距今已满 N 天"的 cohort(如 D7 只纳入 ≥7 天前的 cohort),分母逐日缩小;
- 起始事件 ≠ 回访事件的跨事件关联(Purchaser:`purchase_completed` → `companion_alive_daily`)。

Segmentation API 不直接产出这种矩阵。若自己用原始事件现算,要重建整套 cohort + 动态分母逻辑,复杂且易错。Amplitude 的 Retention 图表已经把这套算好,直接读其 "Overall Retained %" 行,采用的正是**官方标准的动态分母定义**。

**7.2 这与"推荐 Segmentation"并不矛盾。**
推荐 Segmentation 的核心理由是"用 Amplitude 官方标准定义、可审计、稳定"。Retention 走 Chart 恰恰是**同一原则的延伸**——留存的官方标准定义就封装在图表里,读图表 = 采用官方口径。两者共同的取向都是:**优先采用 Amplitude 的权威定义,而非自搭口径。** 区别只在于该定义的载体:简单指标在 Segmentation 的内置事件(`_active`/`_new`),复杂指标(留存)在 Chart。

**7.3 例外的代价与已知注意点。**
- Retention 因此继承了 Chart CSV 的解析复杂度(N-Day vs Bracket 格式、表头识别),这部分逻辑集中在 `extractRetention`,已针对两种格式做了兼容。
- 环比依赖运行时缓存(`retention-cache.json` @ GCS,>48h 失效),而非同一份 CSV 内的历史列——因为图表的动态分母使"前一日的同一指标"无法从当日 CSV 直接取得。
- 展示裁剪为 **D1 / D3 / D7**(`KEY_DAYS={1,3,7}`),与图表标题口径一致;小样本下高阶留存(D14/D30)噪声大,已移除。

**7.4 一句话。**
> 简单计数指标(DAU/新增/活跃/购买)→ Segmentation 现算,用官方内置事件;
> 复杂聚合指标(留存)→ 读 Chart,用官方封装好的留存定义。
> 两者统一遵循"采用 Amplitude 权威定义"的原则,Retention 只是该原则在复杂指标上的落地形式。

---

## 附录:实测证据(2026-07-11,Amplitude 生产 API)

| 指标 | Segmentation(机器人) | Chart(UI) | 结论 |
|---|---|---|---|
| DAU 07-09 | 99 | 94 (`a29etrut`) | 口径差 5 |
| New Users 07-09 | 51 | 46 (`cjwne7be` 新用户行) | 口径差 5 |
| WAU | 234(4 天 week-to-date) | 287-290(整周 `z9j6r8us`) | 窗口不同 |
| Revenue 07-09 | $26.97 | $26.97 (`xhd4uffg`) | ✅ 一致 |
| end 参数敏感性 | end=07-09/10/15 → 07-09 恒 99 | — | 证伪 UTC 边界理论 |
