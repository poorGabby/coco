import type { Env } from "./env.js";
import { type AmplitudeSkillOutput } from "./amplitude-skill.js";
import {
  DEFAULT_DAILY_CHARTS,
  PURCHASE_PRODUCT_CHART_ID,
  resolveDailyCharts,
  type DailyChartDef,
} from "./daily-charts.js";

const AMPLITUDE_API_BASE = "https://amplitude.com/api/3/chart";
const AMPLITUDE_TZ = "America/Denver";

export type FetchChartOptions = {
  titleOverride?: string;
  segmentPrefer?: RegExp;
};
export type ChartKind = "timeseries" | "retention" | "unknown";
export type ComparisonKind = "WoW";

export type ChartSnapshot = {
  chartId: string;
  title: string;
  kind: ChartKind;
  metricLabel: string;
  /** ISO date YYYY-MM-DD for timeseries rows */
  yesterday: string | null;
  dayBefore: string | null;
  yesterdayValue: number | null;
  dayBeforeValue: number | null;
  changePct: number | null;
  /** All formal core metrics use WoW. Retention changePct is a percentage-point delta. */
  comparisonKind?: ComparisonKind;
  error?: string;
  /** Existing standard data-layer snapshot metadata, when produced by a metric tool. */
  snapshot?: import("./agent/tool-impls.js").DataSnapshotMeta;
};

type ParsedCsv = {
  title: string;
  metricLabel: string;
  kind: ChartKind;
  headers: string[];
  rows: string[][];
};

export function decodeCsvPayload(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    const json = JSON.parse(trimmed) as { data?: string };
    if (!json.data) {
      throw new Error("Amplitude response missing data field");
    }
    return json.data;
  }
  return trimmed;
}

function cleanCell(cell: string): string {
  return cell.replace(/^\t+/, "").replace(/^"|"$/g, "").trim();
}

export function parseCsvRows(csv: string): string[][] {
  return csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const cells: string[] = [];
      let current = "";
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          inQuotes = !inQuotes;
          current += ch;
        } else if (ch === "," && !inQuotes) {
          cells.push(cleanCell(current));
          current = "";
        } else {
          current += ch;
        }
      }
      cells.push(cleanCell(current));
      return cells;
    });
}

function parseDateHeader(header: string): string | null {
  const m = header.match(/^(\d{4}-\d{2}-\d{2})$/);
  return m ? m[1] : null;
}

function parseChartCsv(csv: string): ParsedCsv {
  const rows = parseCsvRows(csv);
  const title = rows.find((r) => r[0] && !r[0].startsWith("Segment"))?.[0] ?? "Unknown Chart";
  const metricLine = rows.find((r) =>
    /^(Uniques|Totals|Average|N-Day Retention|Bracket)$/i.test(r[0]),
  );
  const metricLabel = metricLine?.[0] ?? "Value";

  const headerRow = rows.find((r) => r[0] === "Segment");
  if (!headerRow) {
    return { title, metricLabel, kind: "unknown", headers: [], rows: [] };
  }

  const headers = headerRow.slice(1);
  let dataRows = rows.filter((r) => r[0] === "None" && r.length > 1);
  // Segmented charts may have no "None" row.
  // Fall back to all rows that have numeric-looking values beyond the first column.
  if (dataRows.length === 0) {
    dataRows = rows.filter(
      (r) =>
        r.length > 1 &&
        r[0] &&
        r[0] !== "Segment" &&
        !/^(Uniques|Totals|Average|N-Day Retention|Bracket)$/i.test(r[0]) &&
        r.slice(1).some((cell) => toNumber(cell) != null),
    );
  }

  if (headers.some((h) => parseDateHeader(h))) {
    return { title, metricLabel, kind: "timeseries", headers, rows: dataRows };
  }

  if (headers.includes("Start Date") || title.toLowerCase().includes("retention")) {
    return { title, metricLabel, kind: "retention", headers, rows: dataRows };
  }

  return { title, metricLabel, kind: "unknown", headers, rows: dataRows };
}

/** 导出供单测 */
export { parseChartCsv as parseAmplitudeChartCsv };

export function shanghaiDate(offsetDays = 0): string {
  const now = new Date();
  const shanghai = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  shanghai.setDate(shanghai.getDate() + offsetDays);
  const y = shanghai.getFullYear();
  const m = String(shanghai.getMonth() + 1).padStart(2, "0");
  const d = String(shanghai.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function toNumber(value: string | undefined): number | null {
  if (value == null || value === "" || value === "N/A") return null;
  const cleaned = value.replace(/,/g, "").replace(/%$/, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** 返回 Amplitude 项目时区 (America/Denver, UTC-7) 下偏移后的日期字符串 YYYY-MM-DD。
 *  直接用 Intl.DateTimeFormat 在目标时区下格式化，消除手动偏移假设。 */
export function amplitudeDateStr(offsetDays: number): string {
  const now = new Date();
  const tzDate = new Date(
    now.toLocaleString("en-US", { timeZone: AMPLITUDE_TZ }),
  );
  tzDate.setDate(tzDate.getDate() + offsetDays);
  const y = tzDate.getFullYear();
  const m = String(tzDate.getMonth() + 1).padStart(2, "0");
  const d = String(tzDate.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** WAU 专用：返回 Amplitude 项目时区当前周的周一日期 YYYY-MM-DD。
 *  offsetWeeks: 0=本周, -1=上周。WAU 按自然周计算，而非滚动 7 天。 */
export function amplitudeWeekMonday(offsetWeeks = 0): string {
  const now = new Date();
  const tzDate = new Date(
    now.toLocaleString("en-US", { timeZone: AMPLITUDE_TZ }),
  );
  const dow = tzDate.getDay(); // 0=Sun 1=Mon … 6=Sat
  const daysFromMonday = dow === 0 ? 6 : dow - 1;
  tzDate.setDate(tzDate.getDate() - daysFromMonday + offsetWeeks * 7);
  const y = tzDate.getFullYear();
  const m = String(tzDate.getMonth() + 1).padStart(2, "0");
  const d = String(tzDate.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 将 AmplitudeSkill 日级输出转为下游兼容的 ChartSnapshot[] */
export function skillOutputToSnapshots(
  metricKey: string,
  title: string,
  output: AmplitudeSkillOutput,
  yesterday: string,
  dayBefore: string,
): ChartSnapshot[] {
  return Object.entries(output.segments)
    .filter(([segName]) => segName !== "(none)")
    .map(([segName, segData]) => {
      const yv = segData.dailyTrend[yesterday] ?? null;
      const dv = segData.dailyTrend[dayBefore] ?? null;
      const chartId = Object.keys(output.segments).length > 1
        ? `${metricKey}/${segName}`
        : metricKey;
      return {
        chartId,
        title: Object.keys(output.segments).length > 1
          ? `${title} — ${segName}`
          : title,
        kind: "timeseries",
        metricLabel: `Uniques (daily)`,
        yesterday,
        dayBefore,
        yesterdayValue: yv,
        dayBeforeValue: dv,
        changePct: calcChangePct(yv, dv),
      };
    });
}

function calcChangePct(
  yesterday: number | null,
  dayBefore: number | null,
): number | null {
  if (
    yesterday == null ||
    dayBefore == null ||
    dayBefore === 0
  )
    return null;
  return ((yesterday - dayBefore) / dayBefore) * 100;
}

/** 分段图：优先匹配 prefer；否则用全部数值行（列求和）。导出供单测。 */
export function selectSegmentRows(
  rows: string[][],
  segmentPrefer?: RegExp,
): string[][] {
  const dataRows = rows.filter(
    (r) => r.length > 1 && r[0] && r[0] !== "Overall",
  );
  if (!segmentPrefer) return dataRows;
  const matched = dataRows.filter((r) => segmentPrefer.test(r[0]));
  return matched.length > 0 ? matched : dataRows;
}

/** 从已解析 CSV 提取日级昨/前值（America/Denver 完结日）。导出供单测。 */
export function extractTimeseries(
  parsed: ParsedCsv,
  opts?: { segmentPrefer?: RegExp },
): Pick<
  ChartSnapshot,
  "yesterday" | "dayBefore" | "yesterdayValue" | "dayBeforeValue" | "changePct"
> {
  const dataRows = selectSegmentRows(parsed.rows, opts?.segmentPrefer);

  /** Sum toNumber values across selected segment rows for a given column index */
  function colSum(idx: number): number | null {
    let sum = 0;
    let any = false;
    for (const r of dataRows) {
      const v = toNumber(r[idx]);
      if (v != null) {
        sum += v;
        any = true;
      }
    }
    return any ? sum : null;
  }

  const valuesByDate = new Map<string, number | null>();
  for (let i = 0; i < parsed.headers.length; i++) {
    const date = parseDateHeader(parsed.headers[i]);
    if (date) {
      valuesByDate.set(date, colSum(i + 1));
    }
  }

  // 与日报/Stripe 一致：America/Denver「最近完结日」
  const yesterday = amplitudeDateStr(-1);
  const dayBefore = amplitudeDateStr(-2);
  let yesterdayValue = valuesByDate.get(yesterday) ?? null;
  let dayBeforeValue = valuesByDate.get(dayBefore) ?? null;

  // Weekly / non-daily charts: fall back to last two columns with numeric data
  if (yesterdayValue == null || dayBeforeValue == null) {
    const numericCols: { date: string; value: number }[] = [];
    for (let i = 0; i < parsed.headers.length; i++) {
      const header = parsed.headers[i];
      const date = parseDateHeader(header) ?? header;
      const value = colSum(i + 1);
      if (value != null) {
        numericCols.push({ date, value });
      }
    }
    if (numericCols.length >= 2) {
      const today = amplitudeDateStr(0);
      const lastDate = numericCols[numericCols.length - 1].date;
      const lastDateParsed = new Date(`${lastDate}T12:00:00Z`);
      const todayParsed = new Date(`${today}T12:00:00Z`);
      const daysSinceLast =
        (todayParsed.getTime() - lastDateParsed.getTime()) / 86_400_000;
      const skipLast =
        numericCols.length >= 3 && daysSinceLast >= 0 && daysSinceLast < 7;

      const useCols = skipLast
        ? [
            numericCols[numericCols.length - 2],
            numericCols[numericCols.length - 3],
          ]
        : [
            numericCols[numericCols.length - 1],
            numericCols[numericCols.length - 2],
          ];

      return {
        yesterday: useCols[0].date,
        dayBefore: useCols[1].date,
        yesterdayValue: useCols[0].value,
        dayBeforeValue: useCols[1].value,
        changePct: calcChangePct(useCols[0].value, useCols[1].value),
      };
    }
  }

  return {
    yesterday,
    dayBefore,
    yesterdayValue,
    dayBeforeValue,
    changePct: calcChangePct(yesterdayValue, dayBeforeValue),
  };
}

function extractRetention(
  parsed: ParsedCsv,
  previous?: { yesterday: string; yesterdayValue: number } | null,
): Pick<
  ChartSnapshot,
  "yesterday" | "dayBefore" | "yesterdayValue" | "dayBeforeValue" | "changePct"
> {
  const retainedPctRow = parsed.rows.find((r) =>
    r.some((cell) => cell.replace(/\s/g, "") === "Retained%"),
  );
  if (!retainedPctRow) {
    return {
      yesterday: null, dayBefore: null,
      yesterdayValue: null, dayBeforeValue: null, changePct: null,
    };
  }

  // Detect whether this is bracket retention (Day X-Y) or standard N-Day (Day 1, Day 2, ...)
  function isDayHeader(h: string): boolean {
    return /^(day\s*\d|d\d)/i.test(h);
  }

  // Collect all Day columns with their original header labels
  const dayHeaders: { idx: number; header: string; rawValue: string }[] = [];
  for (let i = 0; i < parsed.headers.length; i++) {
    if (isDayHeader(parsed.headers[i]) && retainedPctRow[i + 1]) {
      dayHeaders.push({
        idx: i,
        header: parsed.headers[i],
        rawValue: retainedPctRow[i + 1],
      });
    }
  }

  if (dayHeaders.length === 0) {
    for (let i = retainedPctRow.length - 1; i >= 1; i--) {
      const v = toNumber(retainedPctRow[i]);
      if (v != null) {
        const db = previous?.yesterdayValue ?? null;
        return {
          yesterday: parsed.headers[i - 1] ?? "Retention",
          dayBefore: previous?.yesterday ?? null,
          yesterdayValue: v,
          dayBeforeValue: db,
          changePct: calcChangePct(v, db),
        };
      }
    }
    return {
      yesterday: null, dayBefore: null,
      yesterdayValue: null, dayBeforeValue: null, changePct: null,
    };
  }

  // Determine if this is a bracket chart (headers like "Day 1-2", "Day 3-6")
  const isBracket = dayHeaders.some((h) => /day\s*\d+\s*-\s*\d+/i.test(h.header));

  // Build display parts using actual column names
  const KEY_DAYS = new Set([1, 3, 7]);
  function dayNumber(h: { header: string }): number | null {
    const m = h.header.match(/day[^\d]*(\d+)/i);
    return m ? Number(m[1]) : null;
  }
  const displayHeaders = isBracket
    ? dayHeaders
    : dayHeaders.filter((h) => {
        const n = dayNumber(h);
        return n != null && n > 0 && KEY_DAYS.has(n);
      });
  const labelParts = displayHeaders.map((h) => {
    const clean = h.header.replace(/\s+/g, "");
    const v = toNumber(h.rawValue);
    return `${clean}=${v != null ? v.toFixed(1) + "%" : "N/A"}`;
  });
  const label = labelParts.join(", ");

  // Primary value retained for legacy chart parsing; formal comparisons are computed by standard snapshots.
  const nonZero = dayHeaders.filter((h) => !/day\s*0/i.test(h.header));
  const primary = nonZero.length > 0 ? nonZero[0] : dayHeaders[0];
  const value = toNumber(primary.rawValue);
  const dbValue = previous?.yesterdayValue ?? null;

  return {
    yesterday: label,
    dayBefore: previous?.yesterday ?? null,
    yesterdayValue: value,
    dayBeforeValue: dbValue,
    changePct: calcChangePct(value, dbValue),
  };
}

export async function fetchChartSnapshotLegacy(
  env: Env,
  chartId: string,
  retentionPrevious?: { yesterday: string; yesterdayValue: number } | null,
  opts?: FetchChartOptions,
): Promise<ChartSnapshot> {
  const auth = Buffer.from(`${env.amplitudeApiKey}:${env.amplitudeSecretKey}`).toString(
    "base64",
  );
  const url = `${AMPLITUDE_API_BASE}/${chartId}/csv`;

  try {
    console.log(`[amplitude] fetching chart ${chartId}`);

    const response = await fetch(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
        "Cache-Control": "no-cache, no-store",
        Pragma: "no-cache",
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${body.slice(0, 200)}`);
    }

    const raw = await response.json();
    const csv = decodeCsvPayload(JSON.stringify(raw));
    const parsed = parseChartCsv(csv);

    if (parsed.kind === "retention") {
      console.log(
        `[amplitude] retention chart ${chartId} (${parsed.title})`,
        "headers=",
        JSON.stringify(parsed.headers.slice(0, 6)),
        "rowCount=",
        parsed.rows.length,
        "rows=",
        JSON.stringify(parsed.rows.slice(0, 3).map((r) => r.slice(0, 6))),
      );
    }

    const base = {
      chartId,
      title: opts?.titleOverride ?? parsed.title,
      kind: parsed.kind,
      metricLabel: parsed.metricLabel,
    };

    if (parsed.kind === "timeseries") {
      return {
        ...base,
        ...extractTimeseries(parsed, { segmentPrefer: opts?.segmentPrefer }),
      };
    }
    if (parsed.kind === "retention") {
      return { ...base, ...extractRetention(parsed, retentionPrevious) };
    }

    return {
      ...base,
      yesterday: null,
      dayBefore: null,
      yesterdayValue: null,
      dayBeforeValue: null,
      changePct: null,
      error: "Unsupported chart format",
    };
  } catch (err) {
    return {
      chartId,
      title: opts?.titleOverride ?? chartId,
      kind: "unknown",
      metricLabel: "",
      yesterday: null,
      dayBefore: null,
      yesterdayValue: null,
      dayBeforeValue: null,
      changePct: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Amplitude 保存图表 xhd4uffg 的完整解析结果：product 分档 × 各日期去重人数。 */
export interface PurchaseProductTable {
  /** CSV 表头里的日期列，如 ["2026-06-10", ..., "2026-07-14"] */
  dates: string[];
  /** product 标签 → { 日期: 去重人数 | null } */
  products: Record<string, Record<string, number | null>>;
}

/** 拉取并解析购买分档图表（xhd4uffg）的整张表。
 *  日报（fetchPurchaseChartCsv）与 Agent 收入工具共用此函数，保证同源不漂移。 */
export async function fetchPurchaseProductTable(env: Env): Promise<PurchaseProductTable> {
  const auth = Buffer.from(`${env.amplitudeApiKey}:${env.amplitudeSecretKey}`).toString("base64");
  const url = `${AMPLITUDE_API_BASE}/${PURCHASE_PRODUCT_CHART_ID}/csv?_t=${Date.now()}`;
  const response = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, "Cache-Control": "no-cache, no-store", Pragma: "no-cache" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const raw = await response.json();
  const csv = decodeCsvPayload(JSON.stringify(raw));
  const rows = parseCsvRows(csv);

  // Header row: ["product","2026-06-10",...,"2026-07-13","2026-07-14"]
  const headerRow = rows.find((r) => r[0] === "product");
  if (!headerRow) throw new Error("Missing product header row in xhd4uffg CSV");
  const dates = headerRow.slice(1);

  const products: Record<string, Record<string, number | null>> = {};
  for (const r of rows) {
    if (!r[0] || r[0] === "product") continue;
    const row: Record<string, number | null> = {};
    dates.forEach((d, i) => (row[d] = toNumber(r[i + 1])));
    products[r[0]] = row;
  }
  return { dates, products };
}

/** Amplitude 保存图表 bh0r0h4o（Purchase Completed — Unique Users）的解析结果：
 *  purchase_completed 无分组的每日去重付费用户数。这是 UI 图表引擎口径，
 *  与日报走的 xhd4uffg（分 product）同属图表家族，数值与 Amplitude 网页一致。 */
export interface PurchaseUsersTable {
  /** CSV 表头里的日期列 */
  dates: string[];
  /** 日期 → 当日去重付费用户数 | null */
  byDate: Record<string, number | null>;
}

/** 拉取并解析 bh0r0h4o（无分组的购买去重人数）。
 *  CSV 结构：表头行以 "Segment" 起，数据行以 "None" 起（无分组段）。 */
export async function fetchPurchaseUsersTable(env: Env): Promise<PurchaseUsersTable> {
  const auth = Buffer.from(`${env.amplitudeApiKey}:${env.amplitudeSecretKey}`).toString("base64");
  const url = `${AMPLITUDE_API_BASE}/bh0r0h4o/csv?_t=${Date.now()}`;
  const response = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, "Cache-Control": "no-cache, no-store", Pragma: "no-cache" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const raw = await response.json();
  const csv = decodeCsvPayload(JSON.stringify(raw));
  const rows = parseCsvRows(csv);

  const headerRow = rows.find((r) => r[0] === "Segment");
  if (!headerRow) throw new Error("Missing Segment header row in bh0r0h4o CSV");
  const dates = headerRow.slice(1);

  // 无分组图表的数据行 segment 名为 "None"
  const dataRow = rows.find((r) => r[0] === "None") ?? rows.find(
    (r) => r !== headerRow && r[0] !== "Segment" && r.slice(1).some((c) => toNumber(c) != null),
  );
  const byDate: Record<string, number | null> = {};
  dates.forEach((d, i) => (byDate[d] = dataRow ? toNumber(dataRow[i + 1]) : null));
  return { dates, byDate };
}

/** Purchase chart CSV (xhd4uffg): group_by=product, returns per-price unique users.
 *  Takes values by matching date columns — yesterday for current, dayBefore for comparison. */
async function fetchPurchaseChartCsv(
  env: Env,
  yesterday: string,
  dayBefore: string,
): Promise<ChartSnapshot[]> {
  const PRODUCT_LABELS = ["9.99", "6.99"];
  try {
    const { products } = await fetchPurchaseProductTable(env);
    return PRODUCT_LABELS.map((label) => {
      const row = products[label];
      const yv = row ? row[yesterday] ?? null : null;
      const dv = row ? row[dayBefore] ?? null : null;
      return {
        chartId: `purchases/${label}`,
        title: `Purchase Completed — ${label}`,
        kind: "timeseries" as const,
        metricLabel: "Uniques (daily)",
        yesterday,
        dayBefore,
        yesterdayValue: yv,
        dayBeforeValue: dv,
        changePct: calcChangePct(yv, dv),
      };
    });
  } catch (err) {
    return PRODUCT_LABELS.map((label) => ({
      chartId: `purchases/${label}`,
      title: `Purchase Completed — ${label}`,
      kind: "unknown" as const,
      metricLabel: "",
      yesterday: null, dayBefore: null,
      yesterdayValue: null, dayBeforeValue: null, changePct: null,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

export async function fetchAllChartSnapshots(
  env: Env,
  retentionPrevious?: Record<string, { yesterday: string; yesterdayValue: number }>,
  options?: { includeMetricCharts?: boolean },
): Promise<ChartSnapshot[]> {
  const results: ChartSnapshot[] = [];
  const yesterday = amplitudeDateStr(-1);
  const dayBefore = amplitudeDateStr(-2);

  // ── 1. Dashboard 对齐：按注册表逐张拉 Chart CSV（写死 id，非 Segmentation）──
  const charts: DailyChartDef[] = resolveDailyCharts(env.amplitudeDailyChartIds)
    .filter((chart) => options?.includeMetricCharts !== false || chart.kind === "retention");
  for (const chart of charts) {
    try {
      const snapshot = await fetchChartSnapshotLegacy(
        env,
        chart.id,
        chart.kind === "retention"
          ? (retentionPrevious?.[chart.id] ?? null)
          : null,
        {
          titleOverride: chart.title,
          segmentPrefer: chart.segmentPrefer,
        },
      );
      // 注册表强制 kind/title（CSV 误判时仍按角色展示）
      results.push({
        ...snapshot,
        title: chart.title,
        kind: snapshot.error ? snapshot.kind : chart.kind,
      });
    } catch (err) {
      results.push({
        chartId: chart.id,
        title: chart.title,
        kind: "unknown",
        metricLabel: "",
        yesterday: null,
        dayBefore: null,
        yesterdayValue: null,
        dayBeforeValue: null,
        changePct: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── 2. Purchase by Product（仅供 Stripe 失败时 deriveRevenue；卡片会滤掉 purchases/*）──
  if (options?.includeMetricCharts === false) return results;
  try {
    results.push(...(await fetchPurchaseChartCsv(env, yesterday, dayBefore)));
  } catch (err) {
    results.push({
      chartId: "purchases",
      title: "Purchase Completed",
      kind: "unknown",
      metricLabel: "",
      yesterday: null,
      dayBefore: null,
      yesterdayValue: null,
      dayBeforeValue: null,
      changePct: null,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return results;
}

/** @deprecated 保留导出供旧调用；日报请用 DEFAULT_DAILY_CHARTS */
export { DEFAULT_DAILY_CHARTS, PURCHASE_PRODUCT_CHART_ID };
