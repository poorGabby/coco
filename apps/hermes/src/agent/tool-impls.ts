import type { PurchaseProductTable, PurchaseUsersTable } from "../amplitude.js";
import {
  AmplitudeSkill,
  type AmplitudeQueryInput,
  type AmplitudeSkillOutput,
} from "../amplitude-skill.js";

/**
 * 工具层：现有取数函数的薄封装。
 *
 * 所有业务口径（Denver 时区、指标定义、重试/超时）都由被封装的
 * `AmplitudeSkill` 继承，本文件只负责：参数校验、日期区间归一、
 * 把 skill 输出裁剪并汇总成 LLM 友好的结构。全部逻辑可注入依赖后单测，
 * 不打真实网络。
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 单次查询允许的最大跨度（daysBetween 口径，即差值天数）。 */
export const DEFAULT_MAX_RANGE_DAYS = 92;

/** 可注入的取数执行器；默认由 AmplitudeSkill 实现。 */
export type AmplitudeExecutor = (input: AmplitudeQueryInput) => Promise<AmplitudeSkillOutput>;

export interface FetchMetricInput {
  metricName: string;
  /** 起始日 YYYY-MM-DD（美区 America/Denver），可选 */
  startDate?: string;
  /** 结束日 YYYY-MM-DD（美区 America/Denver），可选 */
  endDate?: string;
  /** 按事件属性分组，如 "product"，可选 */
  groupByProp?: string;
}

export interface SeriesSummary {
  segment: string;
  /** 区间内每日之和：同一人多日活跃会被重复计数 */
  sum: number;
  /** 区间内每日值（已裁剪到 [startDate, endDate]） */
  byDate: Record<string, number>;
  /** 整段去重人数（Amplitude periodTotalUniques）；问「一共多少人」看这个 */
  uniqueOverPeriod: number;
}

export interface FetchMetricResult {
  metricName: string;
  startDate: string;
  endDate: string;
  groupBy: string | null;
  /** 所有 series 的 sum 之和 */
  grandSum: number;
  series: SeriesSummary[];
  /** 数据来源描述，便于模型如实引用出处 */
  source: string;
  /** 口径/异常提示（如全 0 疑似日期填错），供模型自我纠偏 */
  notes?: string[];
}

export interface FetchAmplitudeMetricDeps {
  execute: AmplitudeExecutor;
  /** 返回「最近一个完结的 Denver 日」YYYY-MM-DD（默认 amplitudeDateStr(-1)）。 */
  today: () => string;
  maxRangeDays?: number;
}

/** 纯函数：日期 +n 天（UTC midnight 计算，避免时区漂移）。 */
export function addDays(dateISO: string, n: number): string {
  const [y, m, d] = dateISO.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** 纯函数：b - a 的天数差（不含端点，即 daysBetween(a, a) === 0）。 */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/**
 * 归一化查询区间：endDate 若晚于最近完结日则 clamp（不抛错），
 * 避免 LLM 把「今天/未完结日」传进来后工具报错 → Hermes MCP 熔断。
 */
export function resolveCompletedRange(opts: {
  startDate?: string;
  endDate?: string;
  lastCompleted: string;
  /** 未传 startDate 时相对 endDate 回退的天数（默认 0 = 单日） */
  defaultStartOffsetDays?: number;
}): { startDate: string; endDate: string; notes: string[] } {
  const notes: string[] = [];
  let endDate = opts.endDate ?? opts.lastCompleted;
  if (endDate > opts.lastCompleted) {
    notes.push(
      `请求 endDate ${endDate} 晚于最近完结日，已自动改为美区完结日 ${opts.lastCompleted}（未完结日无完整数据）。`,
    );
    endDate = opts.lastCompleted;
  }
  const offset = opts.defaultStartOffsetDays ?? 0;
  let startDate = opts.startDate ?? addDays(endDate, -offset);
  if (startDate > endDate) {
    throw new Error(`startDate ${startDate} is after endDate ${endDate}`);
  }
  if (startDate > opts.lastCompleted) {
    notes.push(
      `请求 startDate ${startDate} 晚于最近完结日，已改为 ${opts.lastCompleted}。`,
    );
    startDate = opts.lastCompleted;
  }
  return { startDate, endDate, notes };
}

/**
 * 工厂：注入依赖后返回可调用的 `fetch_amplitude_metric` 实现。
 * 校验失败一律 throw（错误信息可回灌给 LLM）。
 */
export function createFetchAmplitudeMetric(deps: FetchAmplitudeMetricDeps) {
  const maxRangeDays = deps.maxRangeDays ?? DEFAULT_MAX_RANGE_DAYS;

  return async function fetchAmplitudeMetric(input: FetchMetricInput): Promise<FetchMetricResult> {
    if (!AmplitudeSkill.isRegistered(input.metricName)) {
      throw new Error(
        `Unknown metric: ${input.metricName}. Available: ${AmplitudeSkill.listMetrics().join(", ")}`,
      );
    }

    if (input.startDate !== undefined && !ISO_DATE.test(input.startDate)) {
      throw new Error(`startDate must be YYYY-MM-DD, got: ${input.startDate}`);
    }
    if (input.endDate !== undefined && !ISO_DATE.test(input.endDate)) {
      throw new Error(`endDate must be YYYY-MM-DD, got: ${input.endDate}`);
    }

    const lastCompleted = deps.today();
    // 不传 startDate 时默认最近 7 个完结日（endDate 及其前 6 天）。
    const resolved = resolveCompletedRange({
      startDate: input.startDate,
      endDate: input.endDate,
      lastCompleted,
      defaultStartOffsetDays: 6,
    });
    const { startDate, endDate } = resolved;

    const span = daysBetween(startDate, endDate);
    if (span > maxRangeDays) {
      throw new Error(`date range ${span}d exceeds max ${maxRangeDays}d`);
    }

    const output = await deps.execute({
      metricName: input.metricName,
      startDate,
      endDate,
      groupByProp: input.groupByProp,
      groupByType: input.groupByProp ? "event" : undefined,
    });

    const series = summarizeSegments(output, startDate, endDate);
    const grandSum = series.reduce((acc, s) => acc + s.sum, 0);

    const notes: string[] = [...resolved.notes];
    if (grandSum === 0) {
      notes.push(
        `区间 ${startDate}~${endDate} 内所有取值为 0，很可能是日期区间/年份填错（例如误用了往年）。` +
          `请核对年份后重试，不要直接把 0 当作结论回答。`,
      );
    }

    return {
      metricName: input.metricName,
      startDate,
      endDate,
      groupBy: input.groupByProp ?? null,
      grandSum,
      series,
      source: `Amplitude 产品分析（segmentation API），指标 ${input.metricName}，时区 America/Denver`,
      notes: notes.length ? notes : undefined,
    };
  };
}

// ── fetch_daily_revenue：与日报同源的收入工具（chart xhd4uffg）──────────

export interface RevenueDay {
  date: string;
  /** 各产品档：去重人数与该档收入 */
  byProduct: Record<string, { users: number; revenue: number }>;
  revenue: number;
}

export interface FetchRevenueResult {
  startDate: string;
  endDate: string;
  prices: Record<string, number>;
  perDay: RevenueDay[];
  totalRevenue: number;
  /** endDate vs 前一自然日的收入 DoD（%）；基期为 0 或缺失时为 null（=N/A） */
  dodPct: number | null;
  source: string;
  notes?: string[];
}

export interface FetchRevenueInput {
  startDate?: string;
  endDate?: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** 纯函数：按区间逐日计算收入 = Σ 单价×分档人数。 */
export function computeRevenue(
  table: PurchaseProductTable,
  prices: Record<string, number>,
  startDate: string,
  endDate: string,
): RevenueDay[] {
  const dates = table.dates.filter((d) => d >= startDate && d <= endDate).sort();
  return dates.map((date) => {
    const byProduct: Record<string, { users: number; revenue: number }> = {};
    let revenue = 0;
    for (const [product, price] of Object.entries(prices)) {
      const users = table.products[product]?.[date] ?? 0;
      const rev = round2(users * price);
      byProduct[product] = { users, revenue: rev };
      revenue += rev;
    }
    return { date, byProduct, revenue: round2(revenue) };
  });
}

/** 纯函数：某一天的总收入；该日不在表内返回 null。 */
export function revenueForDate(
  table: PurchaseProductTable,
  prices: Record<string, number>,
  date: string,
): number | null {
  if (!table.dates.includes(date)) return null;
  let rev = 0;
  for (const [product, price] of Object.entries(prices)) {
    rev += (table.products[product]?.[date] ?? 0) * price;
  }
  return round2(rev);
}

export interface FetchDailyRevenueDeps {
  fetchTable: () => Promise<PurchaseProductTable>;
  prices: Record<string, number>;
  /** 最近一个完结的 Denver 日 YYYY-MM-DD */
  today: () => string;
  maxRangeDays?: number;
}

/**
 * 工厂：与日报同源的收入工具。数据取自保存图表 xhd4uffg（purchase_completed
 * 按 product 分档去重），收入 = Σ 单价×人数——与 report.ts 的口径一致。
 */
export function createFetchDailyRevenue(deps: FetchDailyRevenueDeps) {
  const maxRangeDays = deps.maxRangeDays ?? DEFAULT_MAX_RANGE_DAYS;

  return async function fetchDailyRevenue(input: FetchRevenueInput): Promise<FetchRevenueResult> {
    if (input.startDate !== undefined && !ISO_DATE.test(input.startDate)) {
      throw new Error(`startDate must be YYYY-MM-DD, got: ${input.startDate}`);
    }
    if (input.endDate !== undefined && !ISO_DATE.test(input.endDate)) {
      throw new Error(`endDate must be YYYY-MM-DD, got: ${input.endDate}`);
    }

    const lastCompleted = deps.today();
    const resolved = resolveCompletedRange({
      startDate: input.startDate,
      endDate: input.endDate,
      lastCompleted,
      defaultStartOffsetDays: 0,
    });
    const { startDate, endDate } = resolved;
    const span = daysBetween(startDate, endDate);
    if (span > maxRangeDays) {
      throw new Error(`date range ${span}d exceeds max ${maxRangeDays}d`);
    }

    const table = await deps.fetchTable();
    const perDay = computeRevenue(table, deps.prices, startDate, endDate);
    const totalRevenue = round2(perDay.reduce((acc, d) => acc + d.revenue, 0));

    // DoD：endDate vs 前一自然日（取全表，不受请求区间限制）；基期 0/缺失 → null
    const revEnd = revenueForDate(table, deps.prices, endDate);
    const revPrev = revenueForDate(table, deps.prices, addDays(endDate, -1));
    const dodPct =
      revEnd != null && revPrev != null && revPrev > 0
        ? Math.round(((revEnd - revPrev) / revPrev) * 1000) / 10
        : null;

    const notes: string[] = [...resolved.notes];
    if (perDay.length === 0) {
      notes.push(`图表中没有 ${startDate}~${endDate} 的数据列，请核对日期/年份是否正确。`);
    }
    const priceStr = Object.entries(deps.prices)
      .map(([label, v]) => `$${v}×${label}人数`)
      .join(" + ");

    return {
      startDate,
      endDate,
      prices: deps.prices,
      perDay,
      totalRevenue,
      dodPct,
      source: `Amplitude 保存图表 xhd4uffg（purchase_completed 按 product 分档去重人数），Daily Revenue = ${priceStr}，与日报同源，时区 America/Denver`,
      notes: notes.length ? notes : undefined,
    };
  };
}

// ── fetch_daily_revenue（Stripe 版）：真实支付流水，与日报同源 ──────────

/** 单日 Stripe 收入（与 src/stripe.ts 的 StripeDailyRevenue 结构一致，避免循环依赖故此处重声明）。 */
export interface StripeRevenueDay {
  date: string;
  revenue: number;
  count: number;
  byPrice: Record<string, number>;
  refunded: number;
}

export interface FetchStripeRevenueDeps {
  /** 拉取 [startDate,endDate]（含端点，Denver 自然日）逐日真实收入。 */
  fetchRange: (startDate: string, endDate: string) => Promise<Map<string, StripeRevenueDay>>;
  /** 最近一个完结的 Denver 日 YYYY-MM-DD */
  today: () => string;
  maxRangeDays?: number;
}

/**
 * 工厂：基于 Stripe 真实支付流水的收入工具。返回结构与 Amplitude 版
 * createFetchDailyRevenue 完全一致（FetchRevenueResult），使二者可无缝互换，
 * 从而让日报卡片与自由问答的收入口径保持唯一来源。
 */
export function createFetchStripeRevenue(deps: FetchStripeRevenueDeps) {
  const maxRangeDays = deps.maxRangeDays ?? DEFAULT_MAX_RANGE_DAYS;

  return async function fetchStripeRevenue(input: FetchRevenueInput): Promise<FetchRevenueResult> {
    if (input.startDate !== undefined && !ISO_DATE.test(input.startDate)) {
      throw new Error(`startDate must be YYYY-MM-DD, got: ${input.startDate}`);
    }
    if (input.endDate !== undefined && !ISO_DATE.test(input.endDate)) {
      throw new Error(`endDate must be YYYY-MM-DD, got: ${input.endDate}`);
    }
    const lastCompleted = deps.today();
    const resolved = resolveCompletedRange({
      startDate: input.startDate,
      endDate: input.endDate,
      lastCompleted,
      defaultStartOffsetDays: 0,
    });
    const { startDate, endDate } = resolved;
    const span = daysBetween(startDate, endDate);
    if (span > maxRangeDays) {
      throw new Error(`date range ${span}d exceeds max ${maxRangeDays}d`);
    }

    // DoD 需要 endDate 前一日，故多取一天
    const map = await deps.fetchRange(addDays(startDate, -1), endDate);
    const perDay: RevenueDay[] = [];
    for (let d = startDate; d <= endDate; d = addDays(d, 1)) {
      const day = map.get(d);
      const byProduct: Record<string, { users: number; revenue: number }> = {};
      if (day) {
        for (const [price, n] of Object.entries(day.byPrice)) {
          byProduct[price] = { users: n, revenue: round2(n * Number(price)) };
        }
      }
      perDay.push({ date: d, byProduct, revenue: round2(day?.revenue ?? 0) });
    }
    const totalRevenue = round2(perDay.reduce((acc, d) => acc + d.revenue, 0));

    const revEnd = map.get(endDate)?.revenue ?? 0;
    const revPrev = map.get(addDays(endDate, -1))?.revenue;
    const dodPct =
      revPrev != null && revPrev > 0
        ? Math.round(((revEnd - revPrev) / revPrev) * 1000) / 10
        : null;

    const notes: string[] = [...resolved.notes];
    if (totalRevenue === 0) {
      notes.push(`Stripe 在 ${startDate}~${endDate} 无成交入账，请核对日期/年份是否正确。`);
    }

    return {
      startDate,
      endDate,
      prices: {},
      perDay,
      totalRevenue,
      dodPct,
      source:
        "Stripe 真实支付流水（succeeded 入账金额，已扣退款），按 America/Denver 自然日归集，与日报 Daily Revenue 同源",
      notes: notes.length ? notes : undefined,
    };
  };
}

// ── fetch_purchase_users：购买去重人数，与 UI/日报同源（chart bh0r0h4o）────

export interface PurchaseUsersDay {
  date: string;
  /** 当日去重付费用户数；该日缺失为 null */
  users: number | null;
}

export interface FetchPurchaseUsersResult {
  startDate: string;
  endDate: string;
  perDay: PurchaseUsersDay[];
  /** 区间内每日去重人数之和（跨日会重复计同一人，问单日时即当日值） */
  sumOfDaily: number;
  /** endDate vs 前一自然日的 DoD（%）；基期为 0/缺失时为 null(=N/A) */
  dodPct: number | null;
  source: string;
  notes?: string[];
}

export interface FetchPurchaseUsersInput {
  startDate?: string;
  endDate?: string;
}

export interface FetchPurchaseUsersDeps {
  fetchTable: () => Promise<PurchaseUsersTable>;
  /** 最近一个完结的 Denver 日 YYYY-MM-DD */
  today: () => string;
  maxRangeDays?: number;
}

/**
 * 工厂：购买去重人数工具。数据取自保存图表 bh0r0h4o（purchase_completed 无分组
 * 去重付费用户），与 Amplitude 网页图表、日报走的 xhd4uffg 同属图表引擎口径，
 * 数值与 UI 一致（≠ Segmentation API，后者口径偏低）。
 */
export function createFetchPurchaseUsers(deps: FetchPurchaseUsersDeps) {
  const maxRangeDays = deps.maxRangeDays ?? DEFAULT_MAX_RANGE_DAYS;

  return async function fetchPurchaseUsers(
    input: FetchPurchaseUsersInput,
  ): Promise<FetchPurchaseUsersResult> {
    if (input.startDate !== undefined && !ISO_DATE.test(input.startDate)) {
      throw new Error(`startDate must be YYYY-MM-DD, got: ${input.startDate}`);
    }
    if (input.endDate !== undefined && !ISO_DATE.test(input.endDate)) {
      throw new Error(`endDate must be YYYY-MM-DD, got: ${input.endDate}`);
    }

    const lastCompleted = deps.today();
    const resolved = resolveCompletedRange({
      startDate: input.startDate,
      endDate: input.endDate,
      lastCompleted,
      defaultStartOffsetDays: 0,
    });
    const { startDate, endDate } = resolved;
    const span = daysBetween(startDate, endDate);
    if (span > maxRangeDays) {
      throw new Error(`date range ${span}d exceeds max ${maxRangeDays}d`);
    }

    const table = await deps.fetchTable();
    const inWindow = table.dates.filter((d) => d >= startDate && d <= endDate).sort();
    const perDay: PurchaseUsersDay[] = inWindow.map((date) => ({
      date,
      users: table.byDate[date] ?? null,
    }));
    const sumOfDaily = perDay.reduce((acc, d) => acc + (d.users ?? 0), 0);

    const endVal = table.dates.includes(endDate) ? table.byDate[endDate] : null;
    const prevDate = addDays(endDate, -1);
    const prevVal = table.dates.includes(prevDate) ? table.byDate[prevDate] : null;
    const dodPct =
      endVal != null && prevVal != null && prevVal > 0
        ? Math.round(((endVal - prevVal) / prevVal) * 1000) / 10
        : null;

    const notes: string[] = [...resolved.notes];
    // bh0r0h4o 是 Last-30-Days 滚动图表；请求区间超出图表覆盖时会缺列。
    const missing = [];
    for (let d = startDate; d <= endDate; d = addDays(d, 1)) {
      if (!table.dates.includes(d)) missing.push(d);
    }
    if (missing.length) {
      notes.push(
        `图表 bh0r0h4o 只覆盖最近约 30 天，缺少日期列：${missing.join(", ")}。` +
          `更早的历史购买人数本图表无法提供。`,
      );
    }
    if (span > 0) {
      notes.push(
        `sumOfDaily 是逐日去重人数之和，跨日会把同一人重复计数；如需「整段去重人数」本图表无法直接给出。`,
      );
    }

    return {
      startDate,
      endDate,
      perDay,
      sumOfDaily,
      dodPct,
      source:
        "Amplitude 保存图表 bh0r0h4o（Purchase Completed — Unique Users，purchase_completed 无分组去重），" +
        "与 Amplitude 网页图表 / 日报（xhd4uffg）同属图表引擎口径，时区 America/Denver",
      notes: notes.length ? notes : undefined,
    };
  };
}

/** 纯函数：把 skill 输出按区间裁剪，区分「每日之和」与「整段去重」。 */
export function summarizeSegments(
  output: AmplitudeSkillOutput,
  startDate: string,
  endDate: string,
): SeriesSummary[] {
  // ISO 日期串可直接做字典序比较
  const inRange = (d: string) => d >= startDate && d <= endDate;
  return Object.entries(output.segments).map(([segment, seg]) => {
    const byDate: Record<string, number> = {};
    let sum = 0;
    for (const [date, val] of Object.entries(seg.dailyTrend)) {
      if (inRange(date)) {
        byDate[date] = val;
        sum += val;
      }
    }
    return { segment, sum, byDate, uniqueOverPeriod: seg.periodTotalUniques };
  });
}
