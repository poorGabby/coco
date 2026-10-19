import type { Env } from "./env.js";
import { amplitudeDateStr, type ChartSnapshot } from "./amplitude.js";
import { analyzeDailySnapshots, type DailyAnalysis } from "./analyze.js";
import { buildDailyCard } from "./card.js";
import { fetchGa4Snapshot } from "./ga4.js";
// Wix 数据接入暂停中 — see memory: [[wix-data-integration-progress]]
// import { fetchWixSnapshot } from "./wix.js";
import { buildToolRegistry } from "./agent/tools.js";
import {
  BUSINESS_METRIC_DEFINITIONS,
  type CoreBusinessMetric,
} from "./metric-definitions.js";
import type { StandardChartMetricResult } from "./standard-chart-metrics.js";
import { addDays, type FetchRevenueResult } from "./agent/tool-impls.js";
import { fetchStripePurchaseComparison, stripePurchaseCounts } from "./stripe-purchases.js";

export type { DailyAnalysis } from "./analyze.js";

function formatNumber(value: number | null): string {
  if (value == null) return "—";
  if (Number.isInteger(value)) return value.toLocaleString("en-US");
  return value.toFixed(2);
}

function formatPct(value: number | null): string {
  if (value != null) {
    const sign = value > 0 ? "+" : "";
    return `${sign}${value.toFixed(1)}%`;
  }
  // 对应基期为 0 等无法计算 WoW 的情况 → N/A
  return "N/A";
}

export type DailyPurchaseCounts = Omit<ReturnType<typeof stripePurchaseCounts>, "total"> & {
  secondPetWow: number | null;
  treatsWow: number | null;
  pocketWow: number | null;
  stashWow: number | null;
  bigBagWow: number | null;
};

function formatPurchasers(firstPurchase: ChartSnapshot | undefined, purchase?: DailyPurchaseCounts): string {
  const first = `${formatNumber(firstPurchase?.yesterdayValue ?? null)} (${formatPct(firstPurchase?.changePct ?? null)})`;
  if (!purchase) return `• Purchasers — First Purchase ${first} | Second Adoption — (N/A) | Treats — (N/A): Pocket — / Stash — / Big Bag —`;
  return `• Purchasers — First Purchase ${first} | Second Adoption ${purchase.secondPet} (${formatPct(purchase.secondPetWow)}) | Treats ${purchase.treats} (${formatPct(purchase.treatsWow)}): Pocket ${purchase.pocket} / Stash ${purchase.stash} / Big Bag ${purchase.bigBag}`;
}

function snapshotByMetric(snapshots: ChartSnapshot[], metric: string): ChartSnapshot | undefined {
  return snapshots.find((s) => s.snapshot?.metricName === metric);
}

function purchaseWow(current: number, previous: number): number | null {
  return previous === 0 ? null : Math.round(((current - previous) / previous) * 1000) / 10;
}

function formatRevenue(revenue: ChartSnapshot | undefined): string {
  if (revenue?.yesterdayValue == null) {
    return `• Daily Revenue: $— (WoW N/A)`;
  }
  return `• Daily Revenue: $${revenue.yesterdayValue.toFixed(2)} (WoW ${formatPct(revenue.changePct)})`;
}

async function fetchDailyPurchaseCounts(env: Env, reportDate: string): Promise<DailyPurchaseCounts | undefined> {
  try {
    const data = await fetchStripePurchaseComparison(env, reportDate);
    const current = stripePurchaseCounts(data.get(reportDate));
    const previous = stripePurchaseCounts(data.get(addDays(reportDate, -7)));
    const { total: _currentTotal, ...currentCounts } = current;
    return { ...currentCounts, secondPetWow: purchaseWow(current.secondPet, previous.secondPet), treatsWow: purchaseWow(current.treats, previous.treats), pocketWow: purchaseWow(current.pocket, previous.pocket), stashWow: purchaseWow(current.stash, previous.stash), bigBagWow: purchaseWow(current.bigBag, previous.bigBag) };
  } catch (err) {
    console.warn("[report] Stripe purchase metrics unavailable:", err instanceof Error ? err.message : err);
    return undefined;
  }
}

function reportDateLabel(reportDate: string): string {
  return reportDate.replaceAll("-", "/");
}

/**
 * 日报核心指标唯一入口：与 Agent 问答使用同一个 ToolRegistry、同一套标准函数。
 * 每个指标在本次日报中只调用一次，随后所有比较/分析/卡片均复用这些快照。
 */
export async function fetchStandardMetricSnapshots(
  env: Env,
  reportDate = amplitudeDateStr(-1),
): Promise<ChartSnapshot[]> {
  const registry = buildToolRegistry(env);
  const metrics: CoreBusinessMetric[] = [
    "DAU",
    "New_Users",
    "Purchase_Users",
    "Daily_Revenue",
    "New_User_Retention",
    "Purchaser_Companion_Retention",
  ];
  // Report date is a calendar invariant, not a property of any one metric's freshness.
  // A stale/unavailable metric fails closed independently and cannot move the whole report back.
  const currentDate = reportDate;
  const comparisonDate = addDays(currentDate, -7);
  const jobs = [
    () => registry.fetch_amplitude_metric({ metricName: "DAU", startDate: comparisonDate, endDate: currentDate }),
    () => registry.fetch_amplitude_metric({ metricName: "New_Users", startDate: comparisonDate, endDate: currentDate }),
    () => registry.fetch_purchase_users({ startDate: comparisonDate, endDate: currentDate }),
    () => registry.fetch_daily_revenue({ startDate: comparisonDate, endDate: currentDate }),
    () => registry.fetch_retention_metric({ metricName: "New_User_Retention", endDate: currentDate }),
    () => registry.fetch_retention_metric({ metricName: "Purchaser_Companion_Retention" }),
  ];
  // The saved Chart API can reject bursts below the documented project-wide ceiling.
  // Use batches of two and let transient 429/5xx responses back off in the data layer.
  const calls: PromiseSettledResult<unknown>[] = [];
  for (let index = 0; index < jobs.length; index += 2) {
    calls.push(...await Promise.allSettled(jobs.slice(index, index + 2).map((job) => job())));
  }

  const unresolvedSnapshot = (
    metric: CoreBusinessMetric,
    error: unknown,
    kind: "timeseries" | "retention" = "timeseries",
  ): ChartSnapshot => {
    const definition = BUSINESS_METRIC_DEFINITIONS[metric];
    const message = error instanceof Error ? error.message : String(error);
    return {
      chartId: definition.chartId ?? `standard/${metric}`,
      title: definition.title,
      kind,
      metricLabel: kind === "retention" ? "N-Day Retention" : metric === "Daily_Revenue" ? "Revenue" : "Uniques (daily)",
      yesterday: currentDate,
      dayBefore: comparisonDate,
      yesterdayValue: null,
      dayBeforeValue: null,
      changePct: null,
      comparisonKind: "WoW",
      error: message,
      snapshot: {
        contractVersion: "coco-data-contract.v1",
        metricVersion: definition.metricVersion,
        tool: kind === "retention" ? "fetch_retention_metric" : "fetch_standard_metric",
        metric,
        metricName: metric,
        chartId: definition.chartId,
        input: { startDate: comparisonDate, endDate: currentDate, chartId: definition.chartId },
        source: metric === "Daily_Revenue" ? "Stripe Charges API" : "Amplitude Chart",
        timezone: "America/Dawson",
        coverage: { startDate: comparisonDate, endDate: currentDate },
        pulledAt: new Date().toISOString(),
        fetchedAt: new Date().toISOString(),
        completeness: "empty",
        validation: { status: "warning", checks: [message] },
        ...(!metric.includes("Retention") ? {
          currentDate,
          currentValue: null,
          comparisonDate,
          comparisonValue: null,
          wowChange: null,
        } : {}),
        ...(kind === "retention" ? {
          currentCohort: undefined,
          comparisonCohort: undefined,
          retention: {
            cohortDate: null,
            currentCohort: null,
            comparisonCohort: null,
            calculation: "unresolved" as const,
            points: {
              D1: { numerator: null, denominator: null, rate: null, mature: false },
              D3: { numerator: null, denominator: null, rate: null, mature: false },
              D7: { numerator: null, denominator: null, rate: null, mature: false },
            },
            maturityRule: "Chart fetch/parse failed; no fallback is permitted.",
          },
        } : {}),
      },
    };
  };

  return calls.map((call, index) => {
    const metric = metrics[index];
    if (call.status === "rejected") {
      const kind = metric.includes("Retention") ? "retention" : "timeseries";
      return unresolvedSnapshot(metric, call.reason, kind);
    }
    if (metric === "Daily_Revenue") {
      const result = call.value as FetchRevenueResult;
      return result.chartSnapshot ?? unresolvedSnapshot(metric, "Stripe revenue result is missing chartSnapshot");
    }
    return (call.value as StandardChartMetricResult).chartSnapshot;
  });
}

export function buildReportMarkdown(
  snapshots: ChartSnapshot[],
  dashboardUrl?: string,
  reportDate = amplitudeDateStr(-1),
  purchase?: DailyPurchaseCounts,
): string {
  const lines: string[] = [
    `📊 Furever Dock 每日简报 · 美区 ${reportDateLabel(reportDate)}`,
    "",
  ];

  const purchasers = snapshotByMetric(snapshots, "Purchase_Users");
  const revenue = snapshotByMetric(snapshots, "Daily_Revenue");
  if (purchasers || purchase) lines.push(formatPurchasers(purchasers, purchase));
  if (revenue) {
    lines.push(formatRevenue(revenue));
    lines.push("收入口径：Stripe 成功且已支付的 USD Charge，按 Charge 创建日归属并扣除该 Charge 已退款金额；时区 America/Dawson。");
  }

  for (const s of snapshots) {
    if (s.snapshot?.metricName === "Purchase_Users" || s.snapshot?.metricName === "Daily_Revenue") continue;
    if (s.error) {
      lines.push(`| ${s.title} | 错误 | — | ${s.error.slice(0, 40)} |`);
      continue;
    }
    const label = s.title.replace(/\s+/g, " ").trim();
    if (s.kind === "retention" && s.snapshot?.retention) {
      const retention = s.snapshot.retention;
      for (const day of ["D1", "D3", "D7"] as const) {
        const point = retention.points[day];
        const current = point.rate == null ? "—" : `${(point.rate * 100).toFixed(1)}%`;
        const pp = point.wowChangePp;
        const wow = pp == null ? "WoW N/A" : `WoW ${pp > 0 ? "+" : ""}${pp.toFixed(1)}pp`;
        lines.push(`• ${label} — Day ${day.slice(1)}: ${current} (${wow})`);
      }
      continue;
    }
    const yCell = formatNumber(s.yesterdayValue);
    const dCell = formatNumber(s.dayBeforeValue);
    lines.push(
      `| ${label} | ${yCell} | ${dCell} | WoW ${formatPct(s.changePct)} |`,
    );
  }

  if (dashboardUrl) {
    lines.push("", `📎 Dashboard: ${dashboardUrl}`);
  }

  const warnings = snapshots.filter((s) => s.error);
  if (warnings.length) {
    lines.push("", "⚠️ 部分指标拉取失败，请检查对应数据源配置或权限。");
  }

  return lines.join("\n");
}

export async function generateReport(env: Env): Promise<string> {
  const reportDate = amplitudeDateStr(-1);
  const standardSnapshots = await fetchStandardMetricSnapshots(env, reportDate);
  // GA4 暂停 — [[ga4-data-integration-progress]]
  // const ga4Snapshot = await fetchGa4Snapshot(env.googleServiceAccountJson, env.ga4PropertyId);
  const purchase = await fetchDailyPurchaseCounts(env, reportDate);
  return buildReportMarkdown(standardSnapshots, env.amplitudeDashboardUrl || undefined, reportDate, purchase);
}

/** 生成带 Gemini 分析的飞书卡片日报（fetch → analyze → buildCard） */
export async function generateDailyReport(env: Env): Promise<Record<string, unknown>> {
  const reportDate = amplitudeDateStr(-1);
  const standardSnapshots = await fetchStandardMetricSnapshots(env, reportDate);
  // Wix 暂停 — [[wix-data-integration-progress]]
  // GA4 暂停 — [[ga4-data-integration-progress]]
  // const ga4Snapshot = await fetchGa4Snapshot(env.googleServiceAccountJson, env.ga4PropertyId);
  const allSnapshots = standardSnapshots;
  const purchase = await fetchDailyPurchaseCounts(env, reportDate);
  const reportMd = buildReportMarkdown(allSnapshots, env.amplitudeDashboardUrl || undefined, reportDate, purchase);
  const analysis = await analyzeDailySnapshots(env, allSnapshots, reportMd);
  const dateLabel = `美区 ${reportDateLabel(reportDate)}`;
  return buildDailyCard(analysis, allSnapshots, dateLabel, purchase);
}
