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
 * 每个核心指标都必须使用这里声明的数据源与业务定义，并在访问或解析失败时 fail closed。
 * 行为指标使用固定 Amplitude Chart；Daily Revenue 使用 Stripe 支付事实。
 */
export const BUSINESS_METRIC_DEFINITIONS: Record<CoreBusinessMetric, BusinessMetricDefinition> = {
  DAU: {
    chartId: "ilhu9t17",
    title: "Daily Active Users (DAU) — Calendar Day",
    metricVersion: "dau.amplitude-chart-ilhu9t17.calendar-day.wow.v5",
    status: "confirmed",
    chartDefinition: {
      event: "_active",
      eventLabel: "[Amplitude] Any Active Event",
      measure: "uniques",
      rollingAverageDays: null,
      segment: "All Users",
      interval: "daily",
      timezone: "America/Dawson",
      dateBoundary: "exclude incomplete current day",
      filters: [],
      groupBy: [],
    },
  },
  New_Users: {
    chartId: "odptyaey",
    title: "New Users (Daily)",
    metricVersion: "new-users.amplitude-chart-odptyaey.daily-uniques.wow.v4",
    status: "confirmed",
    chartDefinition: {
      event: "_new",
      eventLabel: "[Amplitude] New User",
      measure: "uniques",
      segment: "All Users",
      interval: "daily",
      timezone: "America/Dawson",
      dateRange: "Last 30 days",
      currentDateBoundary: "latest completed Dawson calendar day",
      filters: [],
      groupBy: [],
    },
  },
  Purchase_Users: {
    chartId: "7n9n6eez",
    title: "Purchase Completed — Unique Users",
    metricVersion: "purchase-users.amplitude-chart-7n9n6eez.wow.v3",
    status: "confirmed",
    chartDefinition: {
      event: "purchase_completed",
      measure: "uniques",
      segment: "All Users",
      interval: "daily",
      timezone: "America/Dawson",
      filters: [],
      groupBy: [],
    },
  },
  New_User_Retention: {
    chartId: "lthx47q8",
    title: "New User Retention",
    metricVersion: "new-user-retention.amplitude-chart-lthx47q8.overall-value.cohort-wow.v3",
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
      timezone: "America/Dawson",
      filters: [],
    },
  },
  Purchaser_Companion_Retention: {
    chartId: "v5i4q52e",
    title: "Purchaser Companion Retention",
    metricVersion: "purchaser-companion-retention.amplitude-chart-v5i4q52e.overall-value.cohort-wow.v5",
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
      timezone: "America/Dawson",
      filters: [],
    },
  },
  Daily_Revenue: {
    chartId: null,
    title: "Daily Revenue",
    metricVersion: "daily-revenue.stripe-charge-date-net.v2",
    status: "confirmed",
    chartDefinition: {
      source: "Stripe Charges API",
      object: "charge",
      filters: { status: "succeeded", paid: true, currency: "usd", livemode: true },
      formula: "sum(amount - amount_refunded)",
      dateAttribution: "charge created date",
      timezone: "America/Dawson",
      comparison: "same completed calendar day seven days earlier",
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
