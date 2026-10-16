import type { ChartSnapshot } from "./amplitude.js";
import type { DailyPurchaseCounts } from "./report.js";

/** Report-only composition; never relabel the formal Amplitude tool snapshot. */
export function reportRevenue(revenue?: ChartSnapshot, purchase?: DailyPurchaseCounts & { stripeRevenue: number; stripePreviousRevenue: number }): ChartSnapshot {
  const complete = revenue && !revenue.error && revenue.yesterdayValue != null && purchase
    && Number.isFinite(purchase.stripeRevenue) && Number.isFinite(purchase.stripePreviousRevenue);
  const current = complete ? Math.round((revenue.yesterdayValue! + purchase.stripeRevenue) * 100) / 100 : null;
  const previous = complete && revenue.dayBeforeValue != null
    ? Math.round((revenue.dayBeforeValue + purchase.stripePreviousRevenue) * 100) / 100 : null;
  return {
    chartId: "report-revenue.amplitude-stripe.v1",
    title: "Daily Revenue（Amplitude + Stripe 合计）",
    kind: "timeseries",
    metricLabel: "USD；日报合计，不是仅 Amplitude 的收入查询工具",
    yesterday: revenue?.yesterday ?? null,
    dayBefore: revenue?.dayBefore ?? null,
    yesterdayValue: current,
    dayBeforeValue: previous,
    changePct: current == null || previous == null || previous === 0 ? null
      : Math.round(((current - previous) / previous) * 1000) / 10,
    comparisonKind: "WoW",
    ...(current == null ? { error: "日报合计收入缺少 Amplitude 或 Stripe 数据，不能用单一来源替代" } : {}),
  };
}

export function reportAnalysisSnapshots(snapshots: ChartSnapshot[], purchase?: DailyPurchaseCounts & { stripeRevenue: number; stripePreviousRevenue: number }): ChartSnapshot[] {
  return snapshots.map(s => s.snapshot?.metricName === "Daily_Revenue" ? reportRevenue(s, purchase) : s);
}
