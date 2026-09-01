export type CoreBusinessMetric =
  | "DAU"
  | "New_Users"
  | "Purchase_Users"
  | "New_User_Retention"
  | "Purchaser_Companion_Retention"
  | "Daily_Revenue";

export type BusinessMetricDefinition = {
  chartId: string | null;
  title: string;
  metricVersion: string;
  valueScope?: "overall-combined";
  wowScope?: "single-cohort-week-over-week";
  status: "confirmed" | "unresolved";
  /** UI source-of-truth captured from the approved Amplitude Dashboard screenshots. */
  chartDefinition: Record<string, unknown>;
  reason?: string;
};

/**
 * Amplitude Dashboard Chart 是正式业务指标的数据源与验收基准。
 * 核心指标只能通过固定 Chart ID 的标准函数读取，并在访问或解析失败时 fail closed。
 */
export const BUSINESS_METRIC_DEFINITIONS: Record<CoreBusinessMetric, BusinessMetricDefinition> = {
  DAU: {
    chartId: "ilhu9t17",
    title: "Daily Active Users (DAU) — Calendar Day",
    metricVersion: "dau.amplitude-chart-ilhu9t17.calendar-day.wow.v4",
    status: "confirmed",
    chartDefinition: {
      event: "_active",
      eventLabel: "[Amplitude] Any Active Event",
      measure: "uniques",
      rollingAverageDays: null,
      segment: "None",
      interval: "daily",
      timezone: "America/Denver",
      dateBoundary: "exclude incomplete current day",
      filters: [],
      groupBy: [],
    },
  },
  New_Users: {
    chartId: "1n0bfs5k",
    title: "New Users (Daily)",
    metricVersion: "new-users.amplitude-chart-1n0bfs5k.daily-uniques.wow.v3",
    status: "confirmed",
    chartDefinition: {
      event: "_new",
      eventLabel: "[Amplitude] New User",
      measure: "uniques",
      segment: "None",
      interval: "daily",
      timezone: "America/Denver",
      dateRange: "Last 30 days",
      currentDateBoundary: "latest completed Denver calendar day",
      filters: [],
      groupBy: [],
    },
  },
  Purchase_Users: {
    chartId: "bh0r0h4o",
    title: "Purchase Completed — Unique Users",
    metricVersion: "purchase-users.amplitude-chart-bh0r0h4o.wow.v2",
    status: "confirmed",
    chartDefinition: {
      event: "purchase_completed",
      measure: "uniques",
      segment: "All Users",
      interval: "daily",
      timezone: "America/Denver",
      filters: [],
      groupBy: [],
    },
  },
  New_User_Retention: {
    chartId: "18lt8h9t",
    title: "New User Retention",
    metricVersion: "new-user-retention.amplitude-chart-18lt8h9t.overall-value.cohort-wow.v1",
    valueScope: "overall-combined",
    wowScope: "single-cohort-week-over-week",
    status: "confirmed",
    chartDefinition: {
      startEvent: "_new",
      returnEvent: "companion_alive_daily",
      retentionMethod: "N-day",
      interval: "daily",
      days: [1, 3, 7],
      segment: "All Users",
      timezone: "America/Denver",
      filters: [],
    },
  },
  Purchaser_Companion_Retention: {
    chartId: "5of8047n",
    title: "Purchaser Companion Retention",
    metricVersion: "purchaser-companion-retention.amplitude-chart-5of8047n.overall-value.cohort-wow.v4",
    valueScope: "overall-combined",
    wowScope: "single-cohort-week-over-week",
    status: "confirmed",
    chartDefinition: {
      startEvent: "companion_alive_daily",
      returnEvent: "companion_alive_daily",
      retentionType: "Return On",
      windowCalculation: "24-hour windows",
      days: [1, 3, 7],
      segment: { event: "purchase_completed", operator: ">=", count: 1, window: "Last 365 days" },
      timezone: "America/Denver",
      filters: [],
    },
  },
  Daily_Revenue: {
    chartId: "qycqvc95",
    title: "Daily Revenue",
    metricVersion: "daily-revenue.amplitude-chart-qycqvc95.wow.v2",
    status: "confirmed",
    chartDefinition: {
      event: "purchase_completed",
      measure: "totals",
      formula: "event totals × 9.99 USD",
      unitPriceUsd: 9.99,
      segment: "All Users",
      interval: "daily",
      timezone: "America/Denver",
      filters: [],
      groupBy: [],
    },
  },
};

export function assertBusinessMetricConfirmed(metric: CoreBusinessMetric): void {
  const definition = BUSINESS_METRIC_DEFINITIONS[metric];
  if (definition.status === "confirmed") return;
  throw new Error(
    `${definition.title} 的正式业务定义已记录，但标准函数尚未通过真实数据验收（Chart ${definition.chartId ?? "N/A"}）：${definition.reason}`,
  );
}
