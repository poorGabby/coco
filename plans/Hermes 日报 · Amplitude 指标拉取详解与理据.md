# Hermes 日报 · Amplitude 指标拉取详解与理据



\> 用途:记录日报每个指标的**精确拉取方式**\(API 端点 / 请求参数 / 时区 / 日期窗口\)与**采用理据**。

> 生成:2026\-07\-11。所有数值与参数均经源码逐行核实 \+ Amplitude 生产 API 实测,非推断。
> 
> 认证:HTTP Basic,`AMPLITUDE_API_KEY:AMPLITUDE_SECRET_KEY`。项目时区:America/Denver\(UTC\-7\)。
> 
> 



---





## **一、总览:两个端点**



|端点|覆盖指标|说明|
|---|---|---|
|Segmentation API v2 `/api/2/events/segmentation`|DAU、New Users、WAU、Purchase\(→Revenue\)|现算,返回结构化 JSON|
|Chart Export API v3 `/api/3/chart/{id}/csv`|Companion / Purchaser Retention|读图表算好的 CSV|



代码位置:Segmentation 见 `apps/hermes/src/amplitude-skill.ts`;Retention 见 `apps/hermes/src/amplitude.ts` 的 `fetchChartSnapshotLegacy` / `extractRetention`;编排见 `fetchAllChartSnapshots`。



---





## **二、精确拉取清单\(端点 / 参数 / 时区 / 日期窗口\)**



### **通用请求构造\(Segmentation API\)**

实际发送的查询参数**只有** 4 个 \+ 1 个防缓存:

- `e` = event JSON,如 `{"event_type":"_active"}`;带分组时 `{"event_type":"purchase_completed","group_by":[{"type":"event","value":"product"}]}`

- `start` = `YYYYMMDD`\(无横线\)

- `end` = `YYYYMMDD`\(无横线\)

- `m` = measure\(`uniques`\)

- `_t` = `Date.now()`\(绕开 CDN 缓存\)

⚠️ **\*\*不发送 \`i\`\(interval\)参数\*\***:\`i\` \+ \`group\_by\` 会触发 HTTP 400\(源码显式注释\)。

⚠️ **\*\*不发送 \`timezone\` 参数\*\***:Amplitude 默认按项目时区\(Denver\)解释 \`start/end\`,与我们计算日期的时区一致,无需显式传。



日期由 `amplitudeDateStr(offset)` 生成,在 America/Denver 时区下取偏移日。`yesterday=amplitudeDateStr(-1)`、`dayBefore=amplitudeDateStr(-2)`。



**\-\-\-**



### **1\. DAU**

|项|值|
|---|---|
|端点|`GET /api/2/events/segmentation`|
|事件 \(`e`\)|`{"event_type":"_active"}`|
|measure \(`m`\)|`uniques`|
|`start` / `end`|`amplitudeDateStr(-7)` → `amplitudeDateStr(-1)`\(近 7 天,Denver\)|
|时区|America/Denver\(项目默认,未显式传\)|
|取值|`dailyTrend[yesterday]` 单日值;环比 = 昨日 vs 前日|

- 07\-09 实测：

    - coco： **99** 

    - Dashboard：94



### **2\. New Users**

|项|值|
|---|---|
|端点|`GET /api/2/events/segmentation`|
|事件 \(`e`\)|`{"event_type":"_new"}`|
|measure \(`m`\)|`uniques`|
|`start` / `end`|`amplitudeDateStr(-7)` → `amplitudeDateStr(-1)`|
|时区|America/Denver|
|取值|`dailyTrend[yesterday]` 单日值;环比 = 昨日 vs 前日|

- 07\-09 实测 ：

    - coco： **51**

    - Amplitude：46



### **3\. WAU\(自然周,week\-to\-date\)**

|项|值|
|---|---|
|端点|`GET /api/2/events/segmentation`|
|事件 \(`e`\)|`{"event_type":"_active"}`|
|measure \(`m`\)|`uniques`|

\| \`start\` / \`end\` \| 本周一 \`amplitudeWeekMonday\(0\)\` → \`yesterday\`\(= **周内至今**\) \|

\| 上周对比窗口 \| `amplitudeWeekMonday(-1)` → `amplitudeDateStr(-8)`\(上周一 → 上周同一天\) \|

\| 时区 \| America/Denver \|

\| 取值 \| `periodTotalUniques`\(整段去重,非日趋势\) \|

\| 07\-09 实测 \| **234**\(周内 4 天;整周图表 \~287\-290\) \|

- 07\-09 实测 ：

    - coco： **234**

    - Amplitude：290



### **4\. Purchase → Revenue**

|项|值|
|---|---|
|端点|`GET /api/2/events/segmentation`|
|事件 \(`e`\)|`{"event_type":"purchase_completed","group_by":[{"type":"event","value":"product"}]}`|
|measure \(`m`\)|`uniques`|
|`start` / `end`|`amplitudeDateStr(-7)` → `amplitudeDateStr(-1)`|
|时区|America/Denver|
|取值|按 product 分段\(9\.99 / 6\.99\),取各段昨日人数|
|Revenue 派生|本地纯函数:`9.99×人数 + 6.99×人数`\(`report.ts` 的 `deriveRevenueSnapshot`\)|

\| 07\-09 实测 \| 9\.99×2 \+ 6\.99×1 = **$26\.97** ✅ 与图表一致 \|



### **5\. Retention\(Companion / Purchaser\)**

|项|值|
|---|---|
|端点|`GET /api/3/chart/{id}/csv`|
|Chart ID|Companion `ji5sqoml`、Purchaser `1pzj77uk`\(env `AMPLITUDE_RETENTION_CHART_IDS`\)|
|图表类型|N\-Day Retention\(UTC\-7\)|
|读取|CSV 的 "Overall Retained %" 行\(Amplitude 动态分母,逐日缩小\)|

\| 展示天数 \| **D1 / D3 / D7**\(\`KEY\_DAYS=\{1,3,7\}\`,2026\-07\-11 从 \{1,3,7,14,30\} 收窄\) \|

\| 环比 \| 与昨日运行时缓存值对比\(`retention-cache.json` @ GCS,\>48h 失效\) \|

\| 07\-09 实测 \| Companion `D1=26.0% D3=21.0% D7=16.2%`;Purchaser `D1=46.7% D3=44.4% D7=43.5%` \|

![image\.png](图片和附件/image.png)

**\-\-\-**



## **三、Segmentation API 现算为何合理\(理据\)**



**3\.1 用的是 Amplitude 官方标准定义。** \`\_active\` / \`\_new\` 是平台内置的全局特殊事件\(Any Active Event / New User\),不掺任何人工过滤或分段。以它算 DAU/新增 = 直接采用 Amplitude 官方口径,比 UI 里可能被随手改过的图表更"标准"。



**3\.2 时区一致,且实测无边界污染。** start/end 用 Denver 时区算,Amplitude 也按项目 Denver 时区解释——一致,无偏移。实测证伪"UTC 边界把 07\-10 漏进 07\-09":



```Plain Text
DAU 07-09:  end=07-09 → 99  | end=07-10 → 99  | end=07-15 → 99   (纹丝不动)
dailyTrend: ... "07-08":88, "07-09":99, "07-10":107   (每日独立按日期存)
```



**\*\*3\.3 不传 \`i\` 是必需且正确的。\*\*** Purchase 需 group\_by,传 i 会 400;DAU/New 取单日值、WAU 取整段去重,本就不需要 interval。



**3\.4 可复现、可审计、稳定。** 口径写在代码\(\`METRIC\_REGISTRY\`\)进 git;历史每日值稳定\(§3\.2\);收入本地派生透明,已核对 $26\.97。



**\-\-\-**



## **四、两种方案利弊对比**



|维度|Segmentation API 现算\(当前 ✅推荐\)|Chart CSV 导出|
|---|---|---|
|定义来源|Amplitude 官方 `_active`/`_new` 标准|UI 人工搭建\(可能含过滤/自定义\)|
|与 UI 图表一致性|❌ DAU/New 差 \~5、WAU 差 \~56|✅ 逐格一致|
|可审计/防漂移|✅ 代码\+git,集中注册表|⚠️ UI 改动静默传导,无版本记录|
|稳定性/耦合|✅ 无外部耦合,历史值稳定|⚠️ 图表被改 → 数字跟着变|
|时区正确性|✅ Denver,实测无偏移|⚠️ `extractTimeseries` 用北京时间选列,是真 bug,切换须先修|
|解析健壮性|✅ 结构化 JSON|⚠️ CSV 格式多变\(N\-Day/Bracket、`product`/`Segment` 表头、分段行\)|
|未完结数据|✅ 按日期精确取昨日|⚠️ 末列常是未完结今日/本周,需排除|
|肉眼对账友好|⚠️ 需解释为何 ≠ 图表|✅ 打开 Amplitude 即可核对|



**\-\-\-**



## **五、差异根因\(明确\)**



\- **DAU/New Users 高约 5**:Segmentation 用官方 \`\_active\`/\`\_new\`;对比图表\(\`a29etrut\`\)用另一套事件/过滤。同天、同时区、历史稳定,唯一区别是查询口径。实测:Segmentation 99 vs 图表 94。

\- **WAU 低约 56**:机器人 = 本周一→昨日的 **week\-to\-date**\(现 4 天\);图表 = **整周**\(\~287\-290\)。窗口天数不同。



\> 均**非**时区、UTC 边界或 \`i\` 参数所致——这些假设已逐条实测排除。



**\-\-\-**



## **六、为何推荐 Segmentation API**



1\. **定义更权威**:官方标准指标,不受某张图表的人为配置影响。

2\. **可审计、防漂移**:口径进 git,不随 UI 静默变化。

3\. **稳定性经实证**:历史每日值独立稳定\(§3\.2\)。

4\. **健壮性高**:结构化 JSON,避开 CSV 脆弱与时区 bug。

5\. **差异可解释、可接受**:图表非"更正确",只是"另一种口径";收入两法完全一致\($26\.97\),证明底层事件数据无问题,差异纯在聚合定义。



**反向条件**:仅当团队明确要求"日报必须与 Amplitude UI 图表逐格一致、以图表为唯一事实来源"时,才值得切回 Chart CSV\(须先修时区/分段/表头三处\)。在此之前维持现状更稳健。



**\-\-\-**



## **七、Retention 例外:为何唯独它走 Chart CSV**



前六节的结论\(推荐 Segmentation API\)只适用于 DAU / New Users / WAU / Purchase 四项。**\*\*Retention\(Companion / Purchaser\)是唯一例外,走 Chart Export API v3\(\`/api/3/chart/\{id\}/csv\`\),而非 Segmentation。\*\*** 这是有意为之,原因如下:



**7\.1 留存计算本身复杂,不宜自己现算。**

留存率 = 「Day 0 触发起始事件的用户,在第 N 天回访目标事件的比例」。它涉及:

- 逐 cohort\(按 Day 0 日期分组\)追踪;

\- 每个 Day N 的**动态分母**——只统计"距今已满 N 天"的 cohort\(如 D7 只纳入 ≥7 天前的 cohort\),分母逐日缩小;

- 起始事件 ≠ 回访事件的跨事件关联\(Purchaser:`purchase_completed` → `companion_alive_daily`\)。

Segmentation API 不直接产出这种矩阵。若自己用原始事件现算,要重建整套 cohort \+ 动态分母逻辑,复杂且易错。Amplitude 的 Retention 图表已经把这套算好,直接读其 "Overall Retained %" 行,采用的正是**官方标准的动态分母定义**。



**7\.2 这与"推荐 Segmentation"并不矛盾。**

推荐 Segmentation 的核心理由是"用 Amplitude 官方标准定义、可审计、稳定"。Retention 走 Chart 恰恰是**同一原则的延伸**——留存的官方标准定义就封装在图表里,读图表 = 采用官方口径。两者共同的取向都是:**优先采用 Amplitude 的权威定义,而非自搭口径。** 区别只在于该定义的载体:简单指标在 Segmentation 的内置事件\(\`\_active\`/\`\_new\`\),复杂指标\(留存\)在 Chart。



**7\.3 例外的代价与已知注意点。**

- Retention 因此继承了 Chart CSV 的解析复杂度\(N\-Day vs Bracket 格式、表头识别\),这部分逻辑集中在 `extractRetention`,已针对两种格式做了兼容。

- 环比依赖运行时缓存\(`retention-cache.json` @ GCS,\>48h 失效\),而非同一份 CSV 内的历史列——因为图表的动态分母使"前一日的同一指标"无法从当日 CSV 直接取得。

\- 展示裁剪为 **D1 / D3 / D7**\(\`KEY\_DAYS=\{1,3,7\}\`\),与图表标题口径一致;小样本下高阶留存\(D14/D30\)噪声大,已移除。



**7\.4 一句话。**

> 简单计数指标\(DAU/新增/活跃/购买\)→ Segmentation 现算,用官方内置事件;
> 
> 复杂聚合指标\(留存\)→ 读 Chart,用官方封装好的留存定义。
> 
> 两者统一遵循"采用 Amplitude 权威定义"的原则,Retention 只是该原则在复杂指标上的落地形式。
> 
> 



**\-\-\-**



## **附录:实测证据\(2026\-07\-11,Amplitude 生产 API\)**



|指标|Segmentation\(机器人\)|Chart\(UI\)|结论|
|---|---|---|---|
|DAU 07\-09|99|94 \(`a29etrut`\)|口径差 5|
|New Users 07\-09|51|46 \(`cjwne7be` 新用户行\)|口径差 5|
|WAU|234\(4 天 week\-to\-date\)|287\-290\(整周 `z9j6r8us`\)|窗口不同|
|Revenue 07\-09|$26\.97|$26\.97 \(`xhd4uffg`\)|✅ 一致|
|end 参数敏感性|end=07\-09/10/15 → 07\-09 恒 99|—|证伪 UTC 边界理论|



# 主要改动1: 更新Purchaser Companion Retention指标start\_event

## 发现的问题

- coco算出来的数字和 Amplitude Dashboard 上的数字差很多，以7/9（UTC\-7）时间为例：

|Purchaser Companion Retention指标|coco|Dashboard|
|---|---|---|
|D1|46\.7%|66\.67%|
|D3|44\.4%|59\.26%|
|D7|43\.5%|52\.0%|

## 原因

- 差距这么大，根本原因是**机器人用了错误的 Start Event**

- 什么是 Start Event？

- Retention 的计算逻辑是：

> **D0（起始事件）** 发生后，用户在第 N 天有没有再触发 **Return Event（回访事件）**
> 
> 



- 机器人原来的设置：

    - **D0（Start Event）**：`purchase_completed`（用户购买的那一天）

    - **Return Event**：`companion_alive_daily`（companion 存活检测）

> 这个设置有一个根本性的问题：**用户购买当天不一定会触发 ****`companion_alive_daily`**。
> 
> 



- 举个例子：

    - 用户 A 在 6/20 购买了产品（触发 `purchase_completed`）

    - 但 6/20 当天他没有打开 App，所以没有触发 `companion_alive_daily`

    - 结果：这个用户的 D0 被计入分母，但 Day 0 没有回访记录

    - 导致 **Day 0 = 80%**（不是 100%），整体 Retention 系统性偏低

        

## 正确的设置应该是什么？

> **我们真正想问的问题是："购买过产品的用户，他们的 companion 留存率如何？"**
> 
> 



- 正确的做法：

> 这样 Day 0 = **100%**（因为 D0 本身就是 companion 活跃的那天），分母更干净，数字更准确。
> 
> 

- **D0（Start Event）**：`companion_alive_daily`（用户当天有使用 companion）

- **Return Event**：`companion_alive_daily`（次日/D3/D7 还有没有使用）

- **Segment 筛选**：只看曾经触发过 `purchase_completed` 的用户

    

、



## 改动方案

> **旧口径用"购买那天"作为起点，但购买当天不一定有 companion 活跃，导致分母不干净、数字偏低。新口径改为"companion 活跃那天"作为起点，只筛选购买过的用户，Day 0 = 100%，数字更准确。代码上只需要把 Segmentation API 现算改为读 Dashboard 图表 ****`5of8047n`**** 的 CSV 即可**
> 
> 



1. **第一步：更新 ****`AMPLITUDE_RETENTION_CHART_IDS`**** 环境变量**



```Plain Text
# 旧
COMPANION_RETENTION_CHART_ID=ji5sqoml
PURCHASER_RETENTION_CHART_ID=（旧的，用 Segmentation API 现算）

# 新
COMPANION_RETENTION_CHART_ID=ji5sqoml
PURCHASER_RETENTION_CHART_ID=5of8047n   ← 新增这个
```



2. **第二步：删除 Segmentation API 现算 Purchaser Retention 的代码**



找到类似这样的代码：

```TypeScript
// 旧：用 Segmentation API 现算
const purchaserRetention = await fetchRetentionFromSegmentation({
  startEvent: "purchase_completed",
  returnEvent: "companion_alive_daily",
  ...
})
```



改为和 Companion Retention 一样，走 Chart Export API：

```TypeScript
// 新：直接读图表 CSV
const purchaserRetention = await fetchChartSnapshotLegacy("5of8047n")
const result = extractRetention(purchaserRetention, KEY_DAYS) // KEY_DAYS = {1, 3, 7}
```



3. **第三步：验证**

- 改完后对比一下机器人输出和 Dashboard 数字是否一致：

    - 日期【时区：7/9（UTC\-7）】

|指标|改后机器人|Dashboard|
|---|---|---|
|D1|应该 ≈ 66\.67%|66\.67%|
|D3|应该 ≈ 59\.26%|59\.26%|
|D7|应该 ≈ 52\.0%|52\.0%|





# 主要改动2: 日报暂时移除 WAU

> 结论：Coco 日报暂不展示 WAU，改放至周报
> 
> 

## 问题

- 以 7/9（UTC\-7）为例，机器人 WAU 与 Dashboard 相差 56 人

- 约占 WAU 的 20%，差异较大

## 原因

- 差距来自周起始日不一致：

    - 机器人：从\*\*周一（7/7）\*\*开始统计

    - Dashboard：从\*\*周日（7/6）\*\*开始统计，多算了一天

- 为什么不直接修复，而是先移除？

    - **WAU 本身不适合放在日报里，原因如下：**

    1. 变化太慢 — WAU 是 7 天滚动累计，每天只加一天、减一天，波动很小，无法反映"今天发生了什么"

    2. 周中数据不可比 — 周三看到的 WAU 只有 3 天数据，和周末的 7 天数据完全不在同一量级，容易误判趋势

    3. DAU 已经足够 — 当日活跃用户数 DAU 更直接、更准确，能替代 WAU 在日报中的作用

    

    - **WAU 适合放在哪里**

    1. 周报：每周一次，完整 7 天与上周同期对比，趋势清晰

    2. 配合 DAU/WAU 粘性分析：判断用户回访习惯，适合周维度复盘







# 其余部分误差

- 原因是

    - 查询时间点不同导致的数据延迟，不是口径问题，不需要修改

    - 目前 Furever Dock 还处于早期阶段，用户量较小，误差率波动会比较大（5%\-10%），等用户量稳定增长后再评估是否需要对



