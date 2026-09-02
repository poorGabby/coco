/**
 * 共享业务约束文案（单一事实源）。
 *
 * 这些是原本散落在 analyze.ts / report.ts / ask.ts 里的口径规则，
 * 抽到此处作为 agent system prompt 的注入片段，避免 agentic 路径与
 * 工程管道产生口径漂移。后续阶段 analyze.ts 等可反向 import 这里以彻底去重。
 */

/** 各指标对比口径与基期为 0 的处理（与 analyze.ts 一致）。 */
export const COMPARISON_RULES = `所有核心指标统一使用 WoW。DAU、New Users、Purchase Users、Daily Revenue 比较美区最近完结日与 7 天前同日，并写「较上周同日」。\
New User Retention（Chart lthx47q8，固定读取 All Users segment）与 Purchaser Companion Retention 的主值读取各自正式 Chart /query 的 overall/combined；WoW 暂时独立比较最新成熟单日 cohort 与 7 天前同日 cohort，使用百分点差。必须遵守 valueScope=overall-combined、wowScope=single-cohort-week-over-week，禁止 cohort rate 覆盖主值。\
展示、告警和分析必须复用 snapshot 中的 comparison 日期/cohort、数值和 WoW，不得重新取数或改算。\
当对应基期为 0 时无法计算变化率，一律写 N/A，禁止编造百分比或写「从 0 恢复」。`;

/** 日期口径（与 amplitude.ts / 日报标题一致）。 */
export const DATE_RULES = `数据时区为 America/Dawson（固定 UTC-7）。提及日期一律用「美区 MM-DD」，\
不要换算成北京时间。默认「最近完结日」= Dawson 的昨天。`;

/** 数据诚实性不变量（与治理计划一致）。 */
export const NO_FABRICATION = `只依据工具返回的数据回答，不编造数字。\
只有 null / N/A 代表缺失或不可比；数值 0 是真实的 0，不得当作缺失。`;

/** 跨日 uniques 求和的语义提示，防止误导性汇总。 */
export const UNIQUES_SUM_CAVEAT = `注意：跨多日求和得到的是「每日去重值之和」。\
对活跃类指标（如 DAU）而言，日和 ≠ 区间去重用户数（同一用户多日活跃会被重复计）；\
对 New_Users 等「每人只新增一次」的指标，日和可近似为区间新增总数。`;

/** 组合成一段 agent 可注入的约束说明。 */
export const AGENT_CONSTRAINTS = [DATE_RULES, COMPARISON_RULES, NO_FABRICATION, UNIQUES_SUM_CAVEAT].join("\n");
