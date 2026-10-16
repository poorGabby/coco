import type { ChartSnapshot, PurchaseUsersTable } from "../amplitude.js";
import {
  AmplitudeSkill,
  type AmplitudeQueryInput,
  type AmplitudeSkillOutput,
} from "../amplitude-skill.js";

/**
 * 工具层：现有取数函数的薄封装。
 *
 * 所有业务口径（America/Dawson 固定 UTC-7 时区、指标定义、重试/超时）都由被封装的
 * `AmplitudeSkill` 继承，本文件只负责：参数校验、日期区间归一、
 * 把 skill 输出裁剪并汇总成 LLM 友好的结构。全部逻辑可注入依赖后单测，
 * 不打真实网络。
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 单次查询允许的最大跨度（daysBetween 口径，即差值天数）。 */
export const DEFAULT_MAX_RANGE_DAYS = 92;
export const DATA_CONTRACT_VERSION = "coco-data-contract.v1";

/** 可注入的取数执行器；默认由 AmplitudeSkill 实现。 */
export type AmplitudeExecutor = (input: AmplitudeQueryInput) => Promise<AmplitudeSkillOutput>;

export type DataCompleteness = "complete" | "partial" | "empty";
export type DataValidationStatus = "passed" | "warning";

export interface DataSnapshotMeta {
  /** Stable contract version for the shape and semantics of this tool output. */
  contractVersion: string;
  /** Metric definition version; bump when the business definition changes. */
  metricVersion: string;
  /** Stable tool/script name that produced this snapshot. */
  tool: string;
  /** User-facing metric name, after alias resolution. */
  metric: string;
  /** Canonical metric name (explicit alias retained alongside legacy `metric`). */
  metricName: string;
  /** Fixed formal Amplitude Chart ID, when the source is a saved Chart. */
  chartId: string | null;
  /** Normalized input actually used by the query, never the raw LLM text. */
  input: Record<string, unknown>;
  /** Data source and fixed query definition. */
  source: string;
  timezone: "America/Dawson";
  coverage: { startDate: string; endDate: string };
  pulledAt: string;
  /** ISO fetch time (explicit alias retained alongside legacy `pulledAt`). */
  fetchedAt: string;
  completeness: DataCompleteness;
  validation: { status: DataValidationStatus; checks: string[] };
  /** Daily metric comparison fields; all values come from the same Chart response. */
  currentDate?: string;
  currentValue?: number | null;
  comparisonDate?: string;
  comparisonValue?: number | null;
  wowChange?: number | null;
  /** Explicit Retention value/comparison semantics. */
  valueScope?: "overall-combined" | "daily-cohort-per-day";
  wowScope?: "single-cohort-week-over-week";
  /** Legacy retention cohort fields. Formal overall/combined retention leaves these unset. */
  currentCohort?: string;
  comparisonCohort?: string;
  /** Retention-only audit fields. Null values are explicit when the business definition is unresolved. */
  retention?: {
    cohortDate: string | null;
    /** Formal Breakdown Table scope. */
    scope?: "overall-combined" | "daily-cohort-per-day";
    currentPeriod?: { startDate: string; endDate: string } | null;
    comparisonPeriod?: { startDate: string; endDate: string } | null;
    /** Availability of a future previous-overall comparison, independent of cohort WoW. */
    overallComparisonAvailability?: "available" | "unavailable";
    valueScope?: "overall-combined" | "daily-cohort-per-day";
    wowScope?: "single-cohort-week-over-week";
    currentCohort?: string | null;
    comparisonCohort?: string | null;
    observationDate?: string;
    comparisonObservationDate?: string;
    calculation: "n-day" | "rolling" | "bracket" | "unresolved";
    points: Record<"D1" | "D3" | "D7", {
      numerator: number | null;
      denominator: number | null;
      rate: number | null;
      currentValue?: number | null;
      mature: boolean;
      cohortDate?: string;
      comparisonCohortDate?: string;
      observationDate?: string;
      comparisonObservationDate?: string;
      /** WoW-only current cohort fields; never used as the headline value. */
      wowCurrentNumerator?: number | null;
      wowCurrentDenominator?: number | null;
      wowCurrentRate?: number | null;
      comparisonNumerator?: number | null;
      comparisonDenominator?: number | null;
      comparisonRate?: number | null;
      comparisonValue?: number | null;
      comparisonMature?: boolean;
      wowChange?: number | null;
      wowChangePp?: number | null;
    }>;
    maturityRule: string;
  };
}

export interface FetchMetricInput {
  metricName: string;
  /** 起始日 YYYY-MM-DD（美区 America/Dawson），可选 */
  startDate?: string;
  /** 结束日 YYYY-MM-DD（美区 America/Dawson），可选 */
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
  snapshot: DataSnapshotMeta;
}

export interface FetchAmplitudeMetricDeps {
  execute: AmplitudeExecutor;
  /** 返回「最近一个完结的 Dawson 日」YYYY-MM-DD（默认 amplitudeDateStr(-1)）。 */
  today: () => string;
  now?: () => Date;
  maxRangeDays?: number;
}

function buildSnapshotMeta(opts: {
  tool: string;
  metric: string;
  metricVersion: string;
  input: Record<string, unknown>;
  source: string;
  startDate: string;
  endDate: string;
  pulledAt: Date;
  completeness: DataCompleteness;
  checks: string[];
  notes: string[];
}): DataSnapshotMeta {
  return {
    contractVersion: DATA_CONTRACT_VERSION,
    metricVersion: opts.metricVersion,
    tool: opts.tool,
    metric: opts.metric,
    metricName: opts.metric,
    chartId: null,
    input: opts.input,
    source: opts.source,
    timezone: "America/Dawson",
    coverage: { startDate: opts.startDate, endDate: opts.endDate },
    pulledAt: opts.pulledAt.toISOString(),
    fetchedAt: opts.pulledAt.toISOString(),
    completeness: opts.completeness,
    validation: {
      status: opts.notes.length ? "warning" : "passed",
      checks: opts.checks,
    },
  };
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

    const source = `Amplitude 产品分析（segmentation API），指标 ${input.metricName}，时区 America/Dawson`;
    return {
      metricName: input.metricName,
      startDate,
      endDate,
      groupBy: input.groupByProp ?? null,
      grandSum,
      series,
      source,
      notes: notes.length ? notes : undefined,
      snapshot: buildSnapshotMeta({
        tool: "fetch_amplitude_metric",
        metric: input.metricName,
        metricVersion: `amplitude.${input.metricName}.v1`,
        input: { metricName: input.metricName, startDate, endDate, groupByProp: input.groupByProp ?? null },
        source,
        startDate,
        endDate,
        pulledAt: deps.now?.() ?? new Date(),
        completeness: grandSum === 0 ? "empty" : "complete",
        checks: [
          "metric is registered",
          "date range is normalized to completed Dawson days",
          "range length is within maxRangeDays",
        ],
        notes,
      }),
    };
  };
}

// ── fetch_daily_revenue：统一收入结果结构 ──────────────────────────────

export interface RevenueDay {
  date: string;
  /** 各产品档：去重人数与该档收入 */
  byProduct: Record<string, { users: number; revenue: number }>;
  revenue: number;
  /** Stripe 口径下为成功且已支付的 Charge 笔数。 */
  chargeCount?: number;
  /** Stripe 口径下为这些 Charge 当前累计退款金额。 */
  refunded?: number;
  /** Stripe 口径下为扣退款前金额。 */
  grossRevenue?: number;
}

export interface FetchRevenueResult {
  startDate: string;
  endDate: string;
  prices: Record<string, number>;
  perDay: RevenueDay[];
  totalRevenue: number;
  /** endDate vs 7 天前同日的收入 WoW（%）；基期为 0 或缺失时为 null（=N/A） */
  wowPct: number | null;
  source: string;
  notes?: string[];
  snapshot: DataSnapshotMeta;
  /** 日报、卡片与 Gemini 共用的同一份收入快照。 */
  chartSnapshot?: ChartSnapshot;
}

export interface FetchRevenueInput {
  startDate?: string;
  endDate?: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ── fetch_daily_revenue：Stripe 支付流水，与日报同源 ──────────────────

/** 单日 Stripe 收入（与 src/stripe.ts 的 StripeDailyRevenue 结构一致，避免循环依赖故此处重声明）。 */
export interface StripeRevenueDay {
  date: string;
  revenue: number;
  count: number;
  byPrice: Record<string, number>;
  refunded: number;
}

export interface FetchStripeRevenueDeps {
  /** 拉取 [startDate,endDate]（含端点，Dawson 自然日）逐日真实收入。 */
  fetchRange: (startDate: string, endDate: string) => Promise<Map<string, StripeRevenueDay>>;
  /** 最近一个完结的 Dawson 日 YYYY-MM-DD */
  today: () => string;
  now?: () => Date;
  maxRangeDays?: number;
}

/**
 * 工厂：基于 Stripe 真实支付流水的唯一收入工具。
 * 日报、卡片、分析和自由问答都消费同一个 FetchRevenueResult / chartSnapshot。
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

    // WoW 需要 endDate 之前 7 天，故扩展查询窗口
    const map = await deps.fetchRange(addDays(startDate, -7), endDate);
    const perDay: RevenueDay[] = [];
    for (let d = startDate; d <= endDate; d = addDays(d, 1)) {
      const day = map.get(d);
      perDay.push({
        date: d,
        byProduct: {},
        revenue: round2(day?.revenue ?? 0),
        chargeCount: day?.count ?? 0,
        refunded: round2(day?.refunded ?? 0),
        grossRevenue: round2((day?.revenue ?? 0) + (day?.refunded ?? 0)),
      });
    }
    const totalRevenue = round2(perDay.reduce((acc, d) => acc + d.revenue, 0));

    const revEnd = map.get(endDate)?.revenue ?? 0;
    const revPrev = map.get(addDays(endDate, -7))?.revenue;
    const wowPct =
      revPrev != null && revPrev > 0
        ? Math.round(((revEnd - revPrev) / revPrev) * 1000) / 10
        : null;

    const notes: string[] = [...resolved.notes];
    if (totalRevenue === 0) {
      notes.push(`Stripe 在 ${startDate}~${endDate} 无成交入账，请核对日期/年份是否正确。`);
    }

    const comparisonDate = addDays(endDate, -7);
    const source =
      "Stripe Charges API（succeeded && paid，USD；按 Charge 创建日归属，amount - amount_refunded），America/Dawson";
    const snapshot: DataSnapshotMeta = {
      ...buildSnapshotMeta({
        tool: "fetch_daily_revenue",
        metric: "Daily_Revenue",
        metricVersion: "daily-revenue.stripe-charge-date-net.v2",
        input: { startDate, endDate },
        source,
        startDate,
        endDate,
        pulledAt: deps.now?.() ?? new Date(),
        completeness: "complete",
        checks: [
          "date range is normalized to completed Dawson days",
          "range length is within maxRangeDays",
          "Stripe revenue is sourced from succeeded paid USD charges",
          "refunds are deducted from the originating charge amount",
        ],
        notes,
      }),
      currentDate: endDate,
      currentValue: revEnd,
      comparisonDate,
      comparisonValue: revPrev ?? null,
      wowChange: wowPct,
    };
    return {
      startDate,
      endDate,
      prices: {},
      perDay,
      totalRevenue,
      wowPct,
      source,
      notes: notes.length ? notes : undefined,
      snapshot,
      chartSnapshot: {
        chartId: "stripe-charges",
        title: "Daily Revenue",
        kind: "timeseries",
        metricLabel: "USD net revenue",
        yesterday: endDate,
        dayBefore: comparisonDate,
        yesterdayValue: revEnd,
        dayBeforeValue: revPrev ?? null,
        changePct: wowPct,
        comparisonKind: "WoW",
        snapshot,
      },
    };
  };
}

// ── fetch_purchase_users：购买去重人数，与 UI/日报同源（chart 7n9n6eez）────

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
  /** endDate vs 7 天前同日的 WoW（%）；基期为 0/缺失时为 null(=N/A) */
  wowPct: number | null;
  source: string;
  notes?: string[];
  snapshot: DataSnapshotMeta;
}

export interface FetchPurchaseUsersInput {
  startDate?: string;
  endDate?: string;
}

export interface FetchPurchaseUsersDeps {
  fetchTable?: () => Promise<PurchaseUsersTable>;
  execute?: AmplitudeExecutor;
  /** 最近一个完结的 Dawson 日 YYYY-MM-DD */
  today: () => string;
  now?: () => Date;
  maxRangeDays?: number;
}

/**
 * 工厂：购买去重人数工具。生产路径使用标准 Amplitude metric executor；
 * fetchTable 仅保留给旧单测/兼容调用，不作为生产日报或问答口径。
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

    let perDay: PurchaseUsersDay[];
    let missing: string[] = [];
    let fallbackTable: PurchaseUsersTable | undefined;
    let comparisonValue: number | null = null;
    if (deps.execute) {
      const output = await deps.execute({
        metricName: "Purchase_Completed",
        startDate: addDays(startDate, -7),
        endDate,
      });
      const segment = output.segments["(none)"] ?? output.segments["All"] ?? Object.values(output.segments)[0];
      comparisonValue = segment?.dailyTrend[addDays(endDate, -7)] ?? null;
      perDay = [];
      for (let d = startDate; d <= endDate; d = addDays(d, 1)) {
        perDay.push({ date: d, users: segment?.dailyTrend[d] ?? null });
        if (segment?.dailyTrend[d] == null) missing.push(d);
      }
    } else {
      if (!deps.fetchTable) throw new Error("fetchTable or execute is required");
      const table = await deps.fetchTable();
      fallbackTable = table;
      const comparisonDate = addDays(endDate, -7);
      comparisonValue = table.dates.includes(comparisonDate) ? table.byDate[comparisonDate] : null;
      const inWindow = table.dates.filter((d) => d >= startDate && d <= endDate).sort();
      perDay = inWindow.map((date) => ({ date, users: table.byDate[date] ?? null }));
      for (let d = startDate; d <= endDate; d = addDays(d, 1)) {
        if (!table.dates.includes(d)) missing.push(d);
      }
    }
    const sumOfDaily = perDay.reduce((acc, d) => acc + (d.users ?? 0), 0);

    const endVal = fallbackTable
      ? (fallbackTable.dates.includes(endDate) ? fallbackTable.byDate[endDate] : null)
      : perDay.find((d) => d.date === endDate)?.users ?? null;
    const wowPct =
      endVal != null && comparisonValue != null && comparisonValue > 0
        ? Math.round(((endVal - comparisonValue) / comparisonValue) * 1000) / 10
        : null;

    const notes: string[] = [...resolved.notes];
    if (missing.length) {
      notes.push(
        `${deps.execute ? "缺少日期数据列" : "图表 7n9n6eez 缺少日期列"}：${missing.join(", ")}。`,
      );
    }
    if (span > 0) {
      notes.push(
        `sumOfDaily 是逐日去重人数之和，跨日会把同一人重复计数；如需「整段去重人数」本图表无法直接给出。`,
      );
    }

    const source = deps.execute
      ? "Amplitude Segmentation API（purchase_completed 无分组 uniques），时区 America/Dawson"
      : "Amplitude 保存图表 7n9n6eez（兼容路径），时区 America/Dawson";
    return {
      startDate,
      endDate,
      perDay,
      sumOfDaily,
      wowPct,
      source,
      notes: notes.length ? notes : undefined,
      snapshot: buildSnapshotMeta({
        tool: "fetch_purchase_users",
        metric: "Purchase_Users",
        metricVersion: deps.execute
          ? "purchase_users.amplitude-purchase_completed.v2"
          : "purchase_users.amplitude-chart-7n9n6eez.v2",
        input: { startDate, endDate },
        source,
        startDate,
        endDate,
        pulledAt: deps.now?.() ?? new Date(),
        completeness: missing.length ? "partial" : sumOfDaily === 0 ? "empty" : "complete",
        checks: [
          "date range is normalized to completed Dawson days",
          "range length is within maxRangeDays",
          "missing dates are reported instead of substituted",
        ],
        notes,
      }),
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
