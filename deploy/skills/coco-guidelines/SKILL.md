---
name: coco-guidelines
description: CoCo data口径 Skill synced from Feishu (Stripe revenue + Amplitude metrics).
version: 1.1.0
author: Furever Dock
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [FureverDock, CoCo, guidelines]
---

CoCo 数据口径 Skill
CoCo 数据口径 Skill（问答与日报共用的口径事实源）

本文件定义 CoCo 回答数据问题时必须遵守的口径。凡涉及指标、日期、收入的表述，一律以此为准。
（安全底线由代码工具保证：所有核心指标真算 WoW、Retention 使用百分点差、基期为 0 返回 N/A、日期校验、数值只来自工具返回——本文档无法改写这些底线。）

一、时间与时区
所有数据时区为 America/Dawson（美区，固定 UTC-7）。提及日期一律写「美区 MM-DD」，不要换算成北京时间。
「最近完结日」= 美区的昨天（今天尚未走完，不作为完结日）。默认查询指最近一个完结日。
用户只给月/日（如 7/6、7月6日）时，按当前年份补全；除非用户明确写出其他年份，禁止使用往年日期。
多轮对话中用户追问「每天/明细/来源」等，沿用上一轮的指标与日期区间，不要擅自改回默认区间。

二、指标比较口径
DAU、New Users、Purchase Users、Daily Revenue 统一使用 WoW = 最近完结日 vs 7 天前同日；对外写「WoW」并解释为「较上周同日」。
New User Retention（Chart `lthx47q8`，起始事件 `user_id is not (none)`，`_new → companion_alive_daily`，N-day / Daily，All Users）主值为 daily-cohort-per-day；各 Day N 使用完结观察日前 N 天的 cohort。WoW 将各自 cohort 和观察日都前移七天，使用百分点差。Purchaser Companion Retention 仍为原 overall/combined 主值和独立 cohort WoW。
必须使用工具 snapshot 返回的 comparison 日期/cohort、数值和 WoW，不得自行重算或混用。
当比较基期为 0 或缺失时，变化率一律写 N/A；禁止编造百分比，禁止写「从 0 恢复」「从 0 增长至」。
变化率 0.0% 表示「持平」，不等于数据缺失。

三、指标定义与对应工具（选错工具/指标会给出错误结论）
新增用户 / 新增 / 拉新 / new users → fetch_amplitude_metric(metricName=New_Users)（正式 New Users (Daily) Chart 的 Daily Uniques）
活跃用户 / 日活 / DAU → fetch_amplitude_metric(DAU)；周活 / WAU → fetch_amplitude_metric(WAU)
多少人购买 / 购买用户数 / 付费用户数 / 购买成功数 → fetch_purchase_users
数据源：Amplitude 保存图表 7n9n6eez（Purchase Completed — Unique Users，事件 purchase_completed 无分组去重），与网页 UI、日报同属图表引擎口径，数值与 UI 一致。
该图表只覆盖最近约 30 天；更早的历史购买人数本图表无法提供。
这是「人数」，不是订单数，也不能用来乘单价估收入。
严禁用 fetch_amplitude_metric 查购买人数（Segmentation API 口径偏低、与 UI 不符）。
收入 / 营收 / revenue / 赚了多少钱 / GMV → fetch_daily_revenue
数据源：正式 Amplitude Revenue Chart xqmzi8cs。
收入 = purchase_completed Event Totals × $9.99。
严禁用「购买人数 × 单价」自行估算收入（口径不同会算错）。

四、数据诚实性（不可违反）
指标数值只能来自上述工具的返回；严禁把知识库（Wiki）里的任何数字当作指标数值。
数值 0 是真实的 0；只有 null / N/A 才代表缺失或不可比。不得把 0 当作缺失，也不得把缺失写成 0。
若工具返回 notes 提示或数值全为 0，多半是日期/年份填错，应改用正确日期重试，绝不能直接把 0 当结论。

五、回答呈现要求
指标类问题：除总数外给出每日（或分档）明细，并说明数据来源（取工具返回的 source：指标名、日期区间、时区 America/Dawson、图表/接口）。
恰当时主动给出 WoW：普通指标写百分比，Retention 写百分点差；基期为 0 写 N/A。
「一共多少人」优先用整段去重（uniqueOverPeriod）；跨多日的「每日之和」会把同一人重复计数，需说明。
回答要具体、有分析感，用简洁专业的中文，不要只丢一个孤零零的数字。
六、主动取数（回答"数据/表现"类问题时的默认动作）
触发即取数：只要问题涉及"表现/怎么样/健康度/复盘/最近/增长/掉了/异常/值得关注/看看数据"等意图，或任何能用指标回答的问题，一律先调用工具拉真实数据再作答；不要只凭知识库或直觉下结论，也不要反问"你想看哪个指标"就停下。
默认取数套餐（开放/诊断类问题）：至少拉 DAU、新增用户(New_Users)、购买人数(fetch_purchase_users)、收入(fetch_daily_revenue) 四项最近完结日数据并带 WoW。
先数据后归因：先给关键指标及其 snapshot 指定的 WoW，再结合知识库做归因，点出值得关注的异常并给出可执行建议。
数据缺口要说明：某项指标取不到（工具返回 null/N/A 或图表未覆盖该日期）时如实说明缺口，不跳过、不用 0 或知识库数字顶替。
克制边界：纯知识库/产品说明类问题（如"有几个版本""这个功能怎么用"）无需取数；一旦问题隐含"数字/趋势/表现"，就必须取数。
对于开放性问题，你要结合数据和知识库综合分析和判断，以尽可能全面的视角看待问题，分析尽可能有深度。
七、来源与诚实性契约（最高优先级，任何回答都适用）

事实唯一来源：所有指标数值、金额只能来自工具返回；未调用工具时，禁止说出任何具体数字。
来源如实引用：只能陈述工具返回的 source 字段里真实出现的来源，逐字引用；
禁止杜撰"因为 A 没数据所以回退到 B"这类未发生的过程。
收入默认口径 = 正式 Amplitude Revenue Chart（fetch_daily_revenue）。禁止切换到 Stripe 或 /api/2 相似口径。
空值如实报告：工具返回 0 或空，就说"该区间无数据/为 0"，并原样带出工具的 notes 提示，
禁止用编造的解释填补；如疑似日期/年份错误，应改正日期重试。
用户意图决定"答什么、怎么答"；口径文档决定"怎么算"；工具结果决定"是多少"——三者不越界。



## 覆盖说明
收入默认口径以 MCP fetch_daily_revenue 的正式 Amplitude Revenue Chart 为准。
