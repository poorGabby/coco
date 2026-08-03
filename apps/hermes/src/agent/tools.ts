import { AmplitudeSkill } from "../amplitude-skill.js";
import { amplitudeDateStr, fetchPurchaseProductTable, fetchPurchaseUsersTable } from "../amplitude.js";
import type { Env } from "../env.js";
import { REVENUE_PRODUCT_PRICES } from "../report.js";
import { fetchStripeRevenueRange } from "../stripe.js";
import {
  createFetchAmplitudeMetric,
  createFetchDailyRevenue,
  createFetchPurchaseUsers,
  createFetchStripeRevenue,
  type FetchMetricInput,
  type FetchPurchaseUsersInput,
  type FetchRevenueInput,
} from "./tool-impls.js";

/**
 * LLM 可见的工具声明，使用 Gemini function-declaration 的
 * OpenAPI 子集 schema。密钥等永远不进入声明，只在后端 registry 执行时注入。
 */
export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** 工具名 → 后端执行函数（Phase 2 的 runner 从此消费）。 */
export type ToolRegistry = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;

export const AMPLITUDE_METRIC_TOOL: ToolDeclaration = {
  name: "fetch_amplitude_metric",
  description:
    "拉取 Amplitude 分日指标（DAU / WAU / New_Users）的【去重用户数】，来自 Segmentation API，" +
    "支持任意日期区间与按事件属性分组。时区 America/Denver。不传日期默认取最近 7 个完结日；endDate 不能晚于最近完结日。" +
    "返回每分组的每日值、每日之和(sum)与整段去重人数(uniqueOverPeriod)。问「一共多少人」用 uniqueOverPeriod。" +
    "【重要】本工具不负责购买/付费相关指标：问「多少人购买/购买成功数/付费用户数」用 fetch_purchase_users，问「收入/营收」用 fetch_daily_revenue。",
  parameters: {
    type: "object",
    properties: {
      metricName: {
        type: "string",
        enum: ["DAU", "WAU", "New_Users"],
        description: "指标名（必填）",
      },
      startDate: { type: "string", description: "起始日 YYYY-MM-DD（美区），可选" },
      endDate: { type: "string", description: "结束日 YYYY-MM-DD（美区），可选" },
      groupByProp: { type: "string", description: '按事件属性分组，如 "product"，可选' },
    },
    required: ["metricName"],
  },
};

export const DAILY_REVENUE_TOOL: ToolDeclaration = {
  name: "fetch_daily_revenue",
  description:
    "计算 Daily Revenue（营收）。数据来自与【日报同源】的收入来源：优先 Stripe 真实支付流水" +
    "（succeeded 入账金额、已扣退款），未配置 Stripe 时回退 Amplitude 保存图表 xhd4uffg 的分档人数×单价。" +
    "时区 America/Denver。默认取最近一个完结日，可传日期区间。返回逐日收入明细、总收入 totalRevenue、收入 DoD(dodPct)。" +
    "【重要】凡是问「收入 / 营收 / revenue / 赚了多少钱 / GMV」一律用本工具，" +
    "不要用 fetch_amplitude_metric 的购买人数自行乘单价（口径不同，会算错）。",
  parameters: {
    type: "object",
    properties: {
      startDate: { type: "string", description: "起始日 YYYY-MM-DD（美区），可选" },
      endDate: { type: "string", description: "结束日 YYYY-MM-DD（美区），可选" },
    },
    required: [],
  },
};

export const PURCHASE_USERS_TOOL: ToolDeclaration = {
  name: "fetch_purchase_users",
  description:
    "拉取「购买去重人数」（完成购买 purchase_completed 的去重付费用户数）。数据来自 Amplitude 保存图表 bh0r0h4o" +
    "（Purchase Completed — Unique Users，无分组），与 Amplitude 网页图表、日报走的 xhd4uffg 同属【图表引擎口径】，" +
    "数值与网页 UI 一致。时区 America/Denver。默认取最近一个完结日，可传日期区间；返回逐日去重人数、DoD。" +
    "【重要】凡问「多少人购买 / 购买成功数 / 付费用户数 / 有多少人付费」一律用本工具，不要用 fetch_amplitude_metric" +
    "（Segmentation API 口径偏低、与 UI 不符）。注意：这是【人数】，不是订单数，也不能乘单价估收入（收入用 fetch_daily_revenue）。" +
    "本图表只覆盖最近约 30 天。",
  parameters: {
    type: "object",
    properties: {
      startDate: { type: "string", description: "起始日 YYYY-MM-DD（美区），可选" },
      endDate: { type: "string", description: "结束日 YYYY-MM-DD（美区），可选" },
    },
    required: [],
  },
};

/** 当前受控工具白名单声明。 */
export const AGENT_TOOL_DECLARATIONS: ToolDeclaration[] = [
  AMPLITUDE_METRIC_TOOL,
  PURCHASE_USERS_TOOL,
  DAILY_REVENUE_TOOL,
];

/**
 * 构建工具执行注册表：把声明映射到注入了 env 的后端实现。
 * `today` 语义 = 最近一个完结的 Denver 日 = amplitudeDateStr(-1)，与日报口径一致。
 */
export function buildToolRegistry(env: Env): ToolRegistry {
  const runFetchAmplitudeMetric = createFetchAmplitudeMetric({
    execute: (input) =>
      new AmplitudeSkill(env.amplitudeApiKey, env.amplitudeSecretKey).execute(input),
    today: () => amplitudeDateStr(-1),
  });

  // 收入首选 Stripe 真实流水（与日报同源）；未配置密钥时回退 Amplitude 口径。
  const runFetchDailyRevenue = env.stripeApiKey
    ? createFetchStripeRevenue({
        fetchRange: (startDate, endDate) => fetchStripeRevenueRange(env, startDate, endDate),
        today: () => amplitudeDateStr(-1),
      })
    : createFetchDailyRevenue({
        fetchTable: () => fetchPurchaseProductTable(env),
        prices: REVENUE_PRODUCT_PRICES,
        today: () => amplitudeDateStr(-1),
      });

  const runFetchPurchaseUsers = createFetchPurchaseUsers({
    fetchTable: () => fetchPurchaseUsersTable(env),
    today: () => amplitudeDateStr(-1),
  });

  return {
    fetch_amplitude_metric: (args) => runFetchAmplitudeMetric(args as unknown as FetchMetricInput),
    fetch_purchase_users: (args) =>
      runFetchPurchaseUsers(args as unknown as FetchPurchaseUsersInput),
    fetch_daily_revenue: (args) => runFetchDailyRevenue(args as unknown as FetchRevenueInput),
  };
}
