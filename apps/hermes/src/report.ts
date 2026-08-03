import type { ChartSnapshot } from "./amplitude.js";
import type { Env } from "./env.js";
import { fetchAllChartSnapshots, amplitudeDateStr } from "./amplitude.js";
import { fetchStripeRevenueRange } from "./stripe.js";
import { analyzeDailySnapshots, type DailyAnalysis } from "./analyze.js";
import { buildDailyCard } from "./card.js";
import { fetchGa4Snapshot } from "./ga4.js";
// Wix 数据接入暂停中 — see memory: [[wix-data-integration-progress]]
// import { fetchWixSnapshot } from "./wix.js";
import {
  loadRetentionCache,
  saveRetentionCache,
  getRetentionPrevious,
  saveRetentionEntry,
} from "./cache.js";
import { resolveDailyCharts } from "./daily-charts.js";

export type { DailyAnalysis } from "./analyze.js";

function retentionChartIds(env: Env): string[] {
  const fromEnv = env.amplitudeRetentionChartIds;
  if (fromEnv.length) return fromEnv;
  return resolveDailyCharts(env.amplitudeDailyChartIds)
    .filter((c) => c.kind === "retention")
    .map((c) => c.id);
}

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
  // 基期为 0（含收入前日 $0）等无法计算 DoD 的情况 → N/A
  return "N/A";
}

/** Price mapping for purchase segments. Purchases come from Segmentation API
 *  with group_by:product → chartId "purchases/9.99", "purchases/6.99".
 *  Revenue = sum(users × price) across all product segments. */
export const REVENUE_PRODUCT_PRICES: Record<string, number> = {
  "9.99": 9.99,
  "6.99": 6.99,
};

/** Derive daily revenue from purchase product segments (pure function).
 *  No HTTP request — purchases data comes from Segmentation API snapshots. */
function deriveRevenueSnapshot(
  purchaseSnapshots: ChartSnapshot[],
): ChartSnapshot | null {
  let totalYesterday = 0;
  let totalDayBefore = 0;
  let hasDataYesterday = false;
  let hasDataDayBefore = false;
  const parts: string[] = [];

  for (const s of purchaseSnapshots) {
    if (s.error) continue;
    // chartId format: "purchases/9.99" → extract segment name
    const segName = s.chartId.split("/")[1];
    const price = REVENUE_PRODUCT_PRICES[segName];
    if (price == null) continue;

    if (s.yesterdayValue != null) {
      totalYesterday += s.yesterdayValue * price;
      hasDataYesterday = true;
    }
    if (s.dayBeforeValue != null) {
      totalDayBefore += s.dayBeforeValue * price;
      hasDataDayBefore = true;
    }

    const u =
      s.yesterdayValue != null
        ? s.yesterdayValue.toLocaleString("en-US")
        : "?";
    parts.push(`${u} × $${price}`);
  }

  if (!hasDataYesterday) return null;

  // $0 is a real value (0 purchases), not "missing data" → show $0.00.
  // Null only when purchase segments entirely failed to fetch.
  const yVal = hasDataYesterday ? Math.round(totalYesterday * 100) / 100 : null;
  const dVal = hasDataDayBefore ? Math.round(totalDayBefore * 100) / 100 : null;
  const changePct =
    hasDataYesterday && hasDataDayBefore && totalDayBefore > 0
      ? ((totalYesterday - totalDayBefore) / totalDayBefore) * 100
      : null;

  const revenueTitle = `Daily Revenue (${parts.sort().reverse().join(" + ")})`;
  console.log(
    "[revenue]",
    revenueTitle,
    `= $${totalYesterday.toFixed(2)} (DoD ${changePct != null ? (changePct > 0 ? "+" : "") + changePct.toFixed(1) + "%" : "N/A"})`,
  );

  return {
    chartId: "derived-revenue",
    title: revenueTitle,
    kind: "timeseries",
    metricLabel: "Revenue ($)",
    yesterday: purchaseSnapshots[0]?.yesterday ?? null,
    dayBefore: purchaseSnapshots[0]?.dayBefore ?? null,
    yesterdayValue: yVal,
    dayBeforeValue: dVal,
    changePct,
  };
}

/** 首选：从 Stripe 真实支付流水构建 Daily Revenue 快照（与 Amplitude 收入口径互斥）。
 *  口径 = America/Denver 自然日的 succeeded 入账金额（已扣退款），比「去重人数×单价」更准。
 *  Stripe 未配置或拉取失败时返回 null，由调用方回退到 deriveRevenueSnapshot。 */
async function buildStripeRevenueSnapshot(
  env: Env,
  yesterday: string,
  dayBefore: string,
): Promise<ChartSnapshot | null> {
  if (!env.stripeApiKey) return null;
  try {
    const map = await fetchStripeRevenueRange(env, dayBefore, yesterday);
    const y = map.get(yesterday);
    if (!y) return null;
    const d = map.get(dayBefore);
    const yVal = Math.round(y.revenue * 100) / 100;
    const dVal = d ? Math.round(d.revenue * 100) / 100 : null;
    const changePct =
      dVal != null && dVal > 0 ? ((yVal - dVal) / dVal) * 100 : null;
    const parts = Object.entries(y.byPrice)
      .sort((a, b) => Number(b[0]) - Number(a[0]))
      .map(([price, n]) => `${n} × $${price}`);
    const revenueTitle = parts.length
      ? `Daily Revenue (${parts.join(" + ")})`
      : "Daily Revenue";
    console.log(
      "[revenue] Stripe",
      revenueTitle,
      `= $${yVal.toFixed(2)} (DoD ${changePct != null ? (changePct > 0 ? "+" : "") + changePct.toFixed(1) + "%" : "N/A"})`,
    );
    return {
      chartId: "stripe-revenue",
      title: revenueTitle,
      kind: "timeseries",
      metricLabel: "Revenue ($)",
      yesterday,
      dayBefore,
      yesterdayValue: yVal,
      dayBeforeValue: dVal,
      changePct,
    };
  } catch (err) {
    console.warn(
      "[revenue] Stripe fetch failed, falling back to Amplitude-derived revenue:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

function reportDateLabel(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1); // data is for yesterday
  return d.toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function reportDateFullLabel(): string {
  const d = new Date();
  return d.toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
}

/** 实时解析 America/Denver 当前的时区标注，如 "(夏令时/MDT)"。
 *  季节、缩写全部动态获取，随夏令时自动切换，绝不硬编码。 */
function denverTzLabel(): string {
  const now = new Date();
  // 缩写（MST/MDT）直接问 Intl
  const abbr = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver", timeZoneName: "short",
  }).formatToParts(now).find(p => p.type === "timeZoneName")?.value ?? "";
  // MDT = 夏令时，MST = 冬令时
  const season = abbr === "MDT" ? "夏令时" : "冬令时";
  return `(${season}/${abbr})`;
}

/** 日报标题的数据覆盖标注，格式：
 *  "美区 07-11 (夏令时/MDT)"
 *  数据时区 = America/Denver，时区标注由 denverTzLabel() 实时解析，随夏令时自动切换。
 *  取数逻辑（amplitudeDateStr(-1)）恒为 Denver 已完结的自然日，故不再标注截数时间/未完结警告。 */
function amplitudeCoverageLabel(snapshots: ChartSnapshot[]): string {
  const ts = snapshots.find(s => s.kind === "timeseries" && s.yesterday && !s.error);
  const ampDate = ts?.yesterday; // "2026-07-11"
  if (!ampDate) return "";

  const mmdd = ampDate.slice(5); // "07-11"
  return `美区 ${mmdd} ${denverTzLabel()}`;
}

export function buildReportMarkdown(
  snapshots: ChartSnapshot[],
  dashboardUrl?: string,
): string {
  const lines: string[] = [
    `📊 FureverDock 数据日报 · ${reportDateLabel()}`,
    "",
    "| 指标 | 昨日 | 前日 | DoD |",
    "|------|------|------|-----|",
  ];

  for (const s of snapshots) {
    if (s.error) {
      lines.push(`| ${s.title} | 错误 | — | ${s.error.slice(0, 40)} |`);
      continue;
    }
    const label = s.title.replace(/\s+/g, " ").trim();
    // Retention charts show the full bracket label (e.g. "Day0=84.6%, Day1-2=66.7%")
    // instead of just the numeric value
    const yCell = s.kind === "retention" && s.yesterday ? s.yesterday : formatNumber(s.yesterdayValue);
    const dCell = s.kind === "retention" && s.dayBefore ? s.dayBefore : formatNumber(s.dayBeforeValue);
    lines.push(
      `| ${label} | ${yCell} | ${dCell} | ${formatPct(s.changePct)} |`,
    );
  }

  if (dashboardUrl) {
    lines.push("", `📎 Dashboard: ${dashboardUrl}`);
  }

  const warnings = snapshots.filter((s) => s.error);
  if (warnings.length) {
    lines.push("", "⚠️ 部分指标拉取失败，请检查 Amplitude 配置或权限。");
  }

  return lines.join("\n");
}

export async function generateReport(env: Env): Promise<string> {
  const cache = await loadRetentionCache();
  const retentionPrev: Record<string, { yesterday: string; yesterdayValue: number }> = {};
  for (const chartId of retentionChartIds(env)) {
    const prev = getRetentionPrevious(cache, chartId);
    if (prev) retentionPrev[chartId] = prev;
  }
  const rawSnapshots = await fetchAllChartSnapshots(env, retentionPrev);
  // GA4 暂停 — [[ga4-data-integration-progress]]
  // const ga4Snapshot = await fetchGa4Snapshot(env.googleServiceAccountJson, env.ga4PropertyId);
  const snapshots0 = [...rawSnapshots].filter(Boolean) as ChartSnapshot[];
  for (const s of snapshots0) {
    if (s.kind === "retention" && !s.error && s.yesterdayValue != null && s.yesterday != null) {
      saveRetentionEntry(cache, s.chartId, s.yesterday, s.yesterdayValue);
    }
  }
  await saveRetentionCache(cache);
  // Split purchase product segments for revenue derivation, then merge back
  const purchases = snapshots0.filter((s) => s.chartId.startsWith("purchases/"));
  const nonPurchases = snapshots0.filter(
    (s) => !s.chartId.startsWith("purchases/") && s.chartId !== "qycqvc95",
  );
  const revenue =
    (await buildStripeRevenueSnapshot(env, amplitudeDateStr(-1), amplitudeDateStr(-2))) ??
    deriveRevenueSnapshot(purchases);
  if (revenue) nonPurchases.push(revenue);
  return buildReportMarkdown(nonPurchases, env.amplitudeDashboardUrl || undefined);
}

/** 生成带 Gemini 分析的飞书卡片日报（fetch → analyze → buildCard） */
export async function generateDailyReport(env: Env): Promise<Record<string, unknown>> {
  const cache = await loadRetentionCache();
  const retentionPrev: Record<string, { yesterday: string; yesterdayValue: number }> = {};
  for (const chartId of retentionChartIds(env)) {
    const prev = getRetentionPrevious(cache, chartId);
    if (prev) retentionPrev[chartId] = prev;
  }
  const amplitudeSnapshots = await fetchAllChartSnapshots(env, retentionPrev);
  // Wix 暂停 — [[wix-data-integration-progress]]
  // GA4 暂停 — [[ga4-data-integration-progress]]
  // const ga4Snapshot = await fetchGa4Snapshot(env.googleServiceAccountJson, env.ga4PropertyId);
  const allSnapshots = [...amplitudeSnapshots].filter(Boolean) as ChartSnapshot[];
  // Save today's retention values for tomorrow's comparison
  for (const s of allSnapshots) {
    if (s.kind === "retention" && !s.error && s.yesterdayValue != null && s.yesterday != null) {
      saveRetentionEntry(cache, s.chartId, s.yesterday, s.yesterdayValue);
    }
  }
  await saveRetentionCache(cache);
  // Split purchase product segments for revenue derivation, then merge back
  const purchases = allSnapshots.filter((s) => s.chartId.startsWith("purchases/"));
  const nonPurchases = allSnapshots.filter(
    (s) => !s.chartId.startsWith("purchases/") && s.chartId !== "qycqvc95",
  );
  const revenue =
    (await buildStripeRevenueSnapshot(env, amplitudeDateStr(-1), amplitudeDateStr(-2))) ??
    deriveRevenueSnapshot(purchases);
  if (revenue) nonPurchases.push(revenue);
  const reportMd = buildReportMarkdown(nonPurchases, env.amplitudeDashboardUrl || undefined);
  const analysis = await analyzeDailySnapshots(env, nonPurchases, reportMd);
  const dateLabel = `${reportDateFullLabel()} · ${amplitudeCoverageLabel(nonPurchases)}`;
  return buildDailyCard(analysis, nonPurchases, dateLabel);
}
