import type { Env } from "./env.js";
import { amplitudeDateStr, decodeCsvPayload, parseCsvRows, toNumber, type ChartSnapshot } from "./amplitude.js";
import {
  BUSINESS_METRIC_DEFINITIONS,
  type CoreBusinessMetric,
} from "./metric-definitions.js";
import {
  DATA_CONTRACT_VERSION,
  addDays,
  type DataSnapshotMeta,
} from "./agent/tool-impls.js";

const CHART_API = "https://amplitude.com/api/3/chart";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RETENTION_DAYS = [1, 3, 7] as const;

export type RetentionKey = "D1" | "D3" | "D7";

export interface StandardChartMetricInput {
  startDate?: string;
  endDate?: string;
}

export interface StandardChartMetricResult {
  metricName: CoreBusinessMetric;
  metricVersion: string;
  chartId: string;
  title: string;
  kind: "timeseries" | "retention";
  valuesByDate?: Record<string, number>;
  retention?: DataSnapshotMeta["retention"];
  snapshot: DataSnapshotMeta;
  chartSnapshot: ChartSnapshot;
}

function clean(value: string | undefined): string {
  return (value ?? "").replace(/^\t+/, "").trim();
}

function chartLabelToDate(label: string): string | null {
  const parsed = new Date(`${label} UTC`);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function dateToChartLabel(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "2-digit",
    year: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

async function fetchChartRows(env: Env, chartId: string): Promise<string[][]> {
  const auth = Buffer.from(`${env.amplitudeApiKey}:${env.amplitudeSecretKey}`).toString("base64");
  const response = await fetch(`${CHART_API}/${chartId}/csv?_t=${Date.now()}`, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      "Cache-Control": "no-cache, no-store",
      Pragma: "no-cache",
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Amplitude Chart ${chartId}: HTTP ${response.status}: ${body.slice(0, 160)}`);
  }
  const raw = await response.text();
  const csv = decodeCsvPayload(raw);
  const rows = parseCsvRows(csv);
  if (!rows.length) throw new Error(`Amplitude Chart ${chartId}: empty CSV`);
  return rows;
}

type RetentionCell = { count: number; outof: number; incomplete: boolean };
type TimeseriesQueryCell = { value: number };
type TimeseriesChartData = {
  series: Array<Array<TimeseriesQueryCell | number>>;
  xValues: string[];
  seriesMeta: Array<{ segmentIndex: number; eventIndex: number }>;
};
type RetentionChartData = {
  series: Array<{
    values: Record<string, RetentionCell[]>;
    dates: string[];
    combined: RetentionCell[];
  }>;
  seriesMeta: Array<{ segmentIndex: number; eventIndex: number }>;
};

async function fetchRetentionChartData(env: Env, chartId: string): Promise<RetentionChartData> {
  const auth = Buffer.from(`${env.amplitudeApiKey}:${env.amplitudeSecretKey}`).toString("base64");
  const response = await fetch(`${CHART_API}/${chartId}/query?_t=${Date.now()}`, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      "Cache-Control": "no-cache, no-store",
      Pragma: "no-cache",
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Amplitude Chart ${chartId}: HTTP ${response.status}: ${body.slice(0, 160)}`);
  }
  const payload = await response.json() as { data?: RetentionChartData };
  const data = payload.data;
  if (
    !data
    || data.series.length !== 1
    || !data.series[0]?.combined
    || data.seriesMeta.length !== 1
    || data.seriesMeta[0]?.segmentIndex !== 0
    || data.seriesMeta[0]?.eventIndex !== 0
  ) {
    throw new Error(`Amplitude Chart ${chartId}: retention JSON structure changed`);
  }
  return data;
}

async function fetchTimeseriesChartData(env: Env, chartId: string): Promise<TimeseriesChartData> {
  const auth = Buffer.from(`${env.amplitudeApiKey}:${env.amplitudeSecretKey}`).toString("base64");
  const response = await fetch(`${CHART_API}/${chartId}/query?_t=${Date.now()}`, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      "Cache-Control": "no-cache, no-store",
      Pragma: "no-cache",
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Amplitude Chart ${chartId}: HTTP ${response.status}: ${body.slice(0, 160)}`);
  }
  const payload = await response.json() as {
    data?: TimeseriesChartData;
    transformationIds?: unknown[];
  };
  const data = payload.data;
  if (
    !data
    || data.series.length !== 1
    || !Array.isArray(data.series[0])
    || !Array.isArray(data.xValues)
    || data.series[0].length !== data.xValues.length
    || data.seriesMeta.length !== 1
    || data.seriesMeta[0]?.segmentIndex !== 0
    || data.seriesMeta[0]?.eventIndex !== 0
  ) {
    throw new Error(`Amplitude Chart ${chartId}: daily timeseries JSON structure changed`);
  }
  if ((payload.transformationIds?.length ?? 0) > 0) {
    throw new Error(`Amplitude Chart ${chartId}: unexpected smoothing/transformation is enabled`);
  }
  return data;
}

function makeSnapshot(opts: {
  metricName: CoreBusinessMetric;
  chartId: string;
  metricVersion: string;
  startDate: string;
  endDate: string;
  fetchedAt: Date;
  checks: string[];
  retention?: DataSnapshotMeta["retention"];
  comparison?: {
    currentDate: string;
    currentValue: number | null;
    comparisonDate: string;
    comparisonValue: number | null;
    wowChange: number | null;
  };
  completeness?: DataSnapshotMeta["completeness"];
  validationStatus?: DataSnapshotMeta["validation"]["status"];
  valueScope?: DataSnapshotMeta["valueScope"];
  wowScope?: DataSnapshotMeta["wowScope"];
}): DataSnapshotMeta {
  const fetchedAt = opts.fetchedAt.toISOString();
  return {
    contractVersion: DATA_CONTRACT_VERSION,
    metricVersion: opts.metricVersion,
    tool: "fetch_standard_chart_metric",
    metric: opts.metricName,
    metricName: opts.metricName,
    chartId: opts.chartId,
    input: {
      metricName: opts.metricName,
      chartId: opts.chartId,
      startDate: opts.startDate,
      endDate: opts.endDate,
      cohortDate: null,
    },
    source: "Amplitude Chart",
    timezone: "America/Denver",
    coverage: { startDate: opts.startDate, endDate: opts.endDate },
    pulledAt: fetchedAt,
    fetchedAt,
    completeness: opts.completeness ?? "complete",
    validation: { status: opts.validationStatus ?? "passed", checks: opts.checks },
    ...(opts.valueScope ? { valueScope: opts.valueScope } : {}),
    ...(opts.wowScope ? { wowScope: opts.wowScope } : {}),
    ...(opts.comparison ?? {}),
    ...(opts.retention?.currentCohort ? {
      currentCohort: opts.retention.currentCohort,
      comparisonCohort: opts.retention.comparisonCohort ?? undefined,
    } : {}),
    ...(opts.retention ? { retention: opts.retention } : {}),
  };
}

function requireDate(value: string | undefined, name: string): void {
  if (value !== undefined && !ISO_DATE.test(value)) {
    throw new Error(`${name} must be YYYY-MM-DD, got ${value}`);
  }
}

function timeseriesRow(metric: CoreBusinessMetric, rows: string[][]): {
  header: string[];
  data: string[];
  multiplier: number;
  expectedMeasure: string;
} {
  const header = rows.find((row) => clean(row[0]) === "Segment");
  if (!header) throw new Error(`${metric}: Chart structure changed (missing Segment header)`);
  const definition = BUSINESS_METRIC_DEFINITIONS[metric];
  const cfg = definition.chartDefinition;
  const expectedMeasure = String(cfg.measure ?? "");
  if (!rows.some((row) => clean(row[0]).toLowerCase() === expectedMeasure.toLowerCase())) {
    throw new Error(`${metric}: Chart measure changed (expected ${expectedMeasure})`);
  }

  const requiredLabel = metric === "DAU"
    ? "All Users"
    : metric === "New_Users"
      ? String(cfg.segmentRow)
      : "None";
  const matches = rows.filter((row) => clean(row[0]) === requiredLabel && row.length === header.length);
  if (matches.length !== 1) {
    throw new Error(`${metric}: expected exactly one segment row '${requiredLabel}', got ${matches.length}`);
  }
  return {
    header,
    data: matches[0],
    multiplier: metric === "Daily_Revenue" ? Number(cfg.unitPriceUsd) : 1,
    expectedMeasure,
  };
}

function parseTimeseries(
  metric: CoreBusinessMetric,
  rows: string[][],
  requestedStart: string,
  requestedEnd: string,
): { valuesByDate: Record<string, number>; coverage: { startDate: string; endDate: string }; checks: string[] } {
  const { header, data, multiplier, expectedMeasure } = timeseriesRow(metric, rows);
  const allValues: Record<string, number> = {};
  for (let i = 1; i < header.length; i++) {
    const date = clean(header[i]);
    if (!ISO_DATE.test(date)) continue;
    const raw = toNumber(data[i]);
    if (raw != null) allValues[date] = Math.round(raw * multiplier * 100) / 100;
  }
  const dates = Object.keys(allValues).sort();
  if (!dates.length) throw new Error(`${metric}: Chart has no dated numeric values`);
  if (requestedStart < dates[0] || requestedEnd > dates[dates.length - 1]) {
    throw new Error(`${metric}: requested ${requestedStart}~${requestedEnd} outside Chart coverage ${dates[0]}~${dates[dates.length - 1]}`);
  }
  const valuesByDate: Record<string, number> = {};
  for (const date of dates) {
    if (date >= requestedStart && date <= requestedEnd) valuesByDate[date] = allValues[date];
  }
  for (let date = requestedStart; date <= requestedEnd; date = addDays(date, 1)) {
    if (valuesByDate[date] == null) throw new Error(`${metric}: Chart is missing ${date}`);
  }
  return {
    valuesByDate,
    coverage: { startDate: requestedStart, endDate: requestedEnd },
    checks: [
      `fixed Chart ID matches ${BUSINESS_METRIC_DEFINITIONS[metric].chartId}`,
      `Chart measure is ${expectedMeasure}`,
      "required segment row is unique",
      "all requested dates are present and numeric",
      ...(metric === "Daily_Revenue" ? ["purchase_completed Event Totals multiplied by fixed $9.99"] : []),
    ],
  };
}

function parseDailyUniquesQuery(
  metric: "DAU" | "New_Users",
  data: TimeseriesChartData,
  requestedStart: string,
  requestedEnd: string,
): { valuesByDate: Record<string, number>; coverage: { startDate: string; endDate: string }; checks: string[] } {
  const definition = BUSINESS_METRIC_DEFINITIONS[metric];
  const cfg = definition.chartDefinition;
  const allValues: Record<string, number> = {};
  for (let index = 0; index < data.xValues.length; index++) {
    const date = data.xValues[index];
    if (!ISO_DATE.test(date)) throw new Error(`${metric}: invalid Chart date ${date}`);
    const cell = data.series[0][index];
    const value = typeof cell === "number" ? cell : cell?.value;
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new Error(`${metric}: ${date} is not an unsmoothed daily unique-user count`);
    }
    allValues[date] = value;
  }
  const dates = Object.keys(allValues).sort();
  if (!dates.length) throw new Error(`${metric}: Chart has no dated numeric values`);
  if (requestedStart < dates[0] || requestedEnd > dates[dates.length - 1]) {
    throw new Error(`${metric}: requested ${requestedStart}~${requestedEnd} outside Chart coverage ${dates[0]}~${dates[dates.length - 1]}`);
  }
  const valuesByDate: Record<string, number> = {};
  for (let date = requestedStart; date <= requestedEnd; date = addDays(date, 1)) {
    const value = allValues[date];
    if (value == null) throw new Error(`${metric}: Chart is missing ${date}`);
    valuesByDate[date] = value;
  }
  return {
    valuesByDate,
    coverage: { startDate: requestedStart, endDate: requestedEnd },
    checks: [
      `fixed Chart ID matches ${definition.chartId}`,
      `Chart event is ${String(cfg.eventLabel)} (${String(cfg.event)})`,
      "Chart measure is Daily Uniques in America/Denver calendar-day intervals",
      "Chart contains one unfiltered and ungrouped segment",
      "Chart query has no smoothing/transformation and all values are integer user counts",
      "all requested completed dates are present and numeric",
    ],
  };
}

type RetentionPoints = NonNullable<DataSnapshotMeta["retention"]>["points"];

function parseCombinedRetention(
  metric: CoreBusinessMetric,
  data: RetentionChartData,
): { points: RetentionPoints; period: { startDate: string; endDate: string } } {
  const series = data.series[0];
  const cells = series.combined;
  const points = {} as RetentionPoints;
  for (const day of RETENTION_DAYS) {
    const key = `D${day}` as RetentionKey;
    // Chart JSON combined row: index 0=overall users, index 1=Day 0, index N+1=Day N.
    const cell = cells[day + 1];
    if (!cell || !Number.isFinite(cell.count) || !Number.isFinite(cell.outof) || cell.outof <= 0) {
      throw new Error(`${metric}: overall combined ${key} is missing`);
    }
    if (cell.incomplete) throw new Error(`${metric}: overall combined ${key} is incomplete`);
    points[key] = {
      numerator: cell.count,
      denominator: cell.outof,
      rate: cell.count / cell.outof,
      currentValue: cell.count / cell.outof,
      mature: true,
      comparisonNumerator: null,
      comparisonDenominator: null,
      comparisonRate: null,
      comparisonValue: null,
      comparisonMature: false,
      wowChange: null,
      wowChangePp: null,
    };
  }
  const dates = series.dates
    .map(chartLabelToDate)
    .filter((date): date is string => date != null)
    .sort();
  if (!dates.length) {
    throw new Error(`${metric}: retention Chart has no dated coverage`);
  }
  return { points, period: { startDate: dates[0], endDate: dates[dates.length - 1] } };
}

function parseRetentionCohortForWow(
  metric: CoreBusinessMetric,
  data: RetentionChartData,
  cohortDate: string,
): RetentionPoints {
  const label = dateToChartLabel(cohortDate);
  const cells = data.series[0].values[label];
  if (!cells) throw new Error(`${metric}: WoW cohort ${cohortDate} is not present in Chart`);
  const points = {} as RetentionPoints;
  for (const day of RETENTION_DAYS) {
    const key = `D${day}` as RetentionKey;
    const cell = cells[day + 1];
    if (!cell || !Number.isFinite(cell.count) || !Number.isFinite(cell.outof) || cell.outof <= 0) {
      throw new Error(`${metric}: WoW cohort ${cohortDate} ${key} is missing`);
    }
    if (cell.incomplete) throw new Error(`${metric}: WoW cohort ${cohortDate} ${key} is immature`);
    points[key] = {
      numerator: cell.count,
      denominator: cell.outof,
      rate: cell.count / cell.outof,
      mature: true,
    };
  }
  return points;
}

function selectRetentionCohortsForWow(
  metric: CoreBusinessMetric,
  data: RetentionChartData,
): { currentCohort: string; comparisonCohort: string; current: RetentionPoints; comparison: RetentionPoints } {
  const candidates = Object.keys(data.series[0].values)
    .map(chartLabelToDate)
    .filter((date): date is string => date != null)
    .sort()
    .reverse();
  let lastError: unknown;
  for (const currentCohort of candidates) {
    const comparisonCohort = addDays(currentCohort, -7);
    try {
      return {
        currentCohort,
        comparisonCohort,
        current: parseRetentionCohortForWow(metric, data, currentCohort),
        comparison: parseRetentionCohortForWow(metric, data, comparisonCohort),
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `${metric}: no mature single-cohort WoW pair has D1/D3/D7${lastError instanceof Error ? ` (${lastError.message})` : ""}`,
  );
}

function parseRetentionJson(
  metric: CoreBusinessMetric,
  data: RetentionChartData,
): { retention: NonNullable<DataSnapshotMeta["retention"]>; checks: string[] } {
  const overall = parseCombinedRetention(metric, data);
  const wow = selectRetentionCohortsForWow(metric, data);
  for (const day of RETENTION_DAYS) {
    const key = `D${day}` as RetentionKey;
    const point = overall.points[key];
    const current = wow.current[key];
    const comparison = wow.comparison[key];
    point.wowCurrentNumerator = current.numerator;
    point.wowCurrentDenominator = current.denominator;
    point.wowCurrentRate = current.rate;
    point.comparisonNumerator = comparison.numerator;
    point.comparisonDenominator = comparison.denominator;
    point.comparisonRate = comparison.rate;
    point.comparisonValue = comparison.rate;
    point.comparisonMature = true;
    point.wowChange = (Number(current.rate) - Number(comparison.rate)) * 100;
    point.wowChangePp = point.wowChange;
  }
  return {
    retention: {
      cohortDate: null,
      scope: "overall-combined",
      valueScope: "overall-combined",
      wowScope: "single-cohort-week-over-week",
      currentPeriod: overall.period,
      comparisonPeriod: null,
      overallComparisonAvailability: "unavailable",
      currentCohort: wow.currentCohort,
      comparisonCohort: wow.comparisonCohort,
      calculation: "n-day",
      points: overall.points,
      maturityRule: "Headline D1/D3/D7 use complete series.combined cells. WoW alone uses the latest single-day cohort pair seven days apart with both sides mature for D1/D3/D7.",
    },
    checks: [
      `fixed Chart ID matches ${BUSINESS_METRIC_DEFINITIONS[metric].chartId}`,
      "retention JSON contains exactly one formal segment series",
      "D1/D3/D7 are read from the Breakdown Table overall series.combined row at indices 2/4/8",
      "current overall combined cells contain complete count and outof values",
      "valueScope is overall-combined",
      "wowScope is single-cohort-week-over-week",
      "single-day cohort values are used only for WoW and never overwrite headline numerator/denominator/rate",
    ],
  };
}

export async function fetchStandardChartMetric(
  env: Env,
  metricName: CoreBusinessMetric,
  input: StandardChartMetricInput = {},
): Promise<StandardChartMetricResult> {
  requireDate(input.startDate, "startDate");
  requireDate(input.endDate, "endDate");
  const definition = BUSINESS_METRIC_DEFINITIONS[metricName];
  if (!definition.chartId) throw new Error(`${metricName}: fixed formal Chart ID is missing`);
  const chartId = definition.chartId;
  const fetchedAt = new Date();
  const isRetention = metricName === "Companion_Retention" || metricName === "Purchaser_Companion_Retention";

  if (isRetention) {
    const data = await fetchRetentionChartData(env, chartId);
    const parsed = parseRetentionJson(metricName, data);
    const currentPeriod = parsed.retention.currentPeriod;
    if (!currentPeriod) throw new Error(`${metricName}: retention overall period is missing`);
    const snapshot = makeSnapshot({
      metricName,
      chartId,
      metricVersion: definition.metricVersion,
      startDate: currentPeriod.startDate,
      endDate: currentPeriod.endDate,
      fetchedAt,
      checks: parsed.checks,
      retention: parsed.retention,
      valueScope: definition.valueScope,
      wowScope: definition.wowScope,
    });
    const currentLabel = RETENTION_DAYS.map((day) => {
      const point = parsed.retention.points[`D${day}` as RetentionKey];
      const pp = point.wowChangePp;
      return `Day ${day}=${(Number(point.rate) * 100).toFixed(2)}% (WoW ${pp != null && pp > 0 ? "+" : ""}${pp?.toFixed(2) ?? "N/A"}pp; ${point.numerator}/${point.denominator})`;
    }).join(", ");
    const d1 = parsed.retention.points.D1;
    const periodLabel = `${currentPeriod.startDate}~${currentPeriod.endDate} overall`;
    return {
      metricName,
      metricVersion: definition.metricVersion,
      chartId,
      title: definition.title,
      kind: "retention",
      retention: parsed.retention,
      snapshot,
      chartSnapshot: {
        chartId,
        title: definition.title,
        kind: "retention",
        metricLabel: "Return On · 24-hour windows",
        yesterday: `${periodLabel} · ${currentLabel}`,
        dayBefore: `${parsed.retention.currentCohort} cohort vs ${parsed.retention.comparisonCohort} cohort`,
        yesterdayValue: d1.rate == null ? null : d1.rate * 100,
        dayBeforeValue: null,
        changePct: d1.wowChangePp ?? null,
        comparisonKind: "WoW",
        snapshot,
      },
    };
  }

  let endDate = input.endDate ?? amplitudeDateStr(-1);
  let dailyUniquesData: TimeseriesChartData | null = null;
  if (metricName === "DAU" || metricName === "New_Users") {
    dailyUniquesData = await fetchTimeseriesChartData(env, chartId);
  }
  const comparisonDate = addDays(endDate, -7);
  const requestedStart = input.startDate ?? comparisonDate;
  // Every daily metric carries its same-weekday comparison in the same Chart response/snapshot.
  const startDate = requestedStart > comparisonDate
    ? comparisonDate
    : requestedStart;
  if (startDate > endDate) throw new Error(`startDate ${startDate} is after endDate ${endDate}`);
  const parsed = metricName === "DAU" || metricName === "New_Users"
    ? parseDailyUniquesQuery(metricName, dailyUniquesData!, startDate, endDate)
    : parseTimeseries(metricName, await fetchChartRows(env, chartId), startDate, endDate);
  const endValue = parsed.valuesByDate[endDate] ?? null;
  const comparisonValue = parsed.valuesByDate[comparisonDate] ?? null;
  const changePct = endValue != null && comparisonValue != null && comparisonValue > 0
    ? ((endValue - comparisonValue) / comparisonValue) * 100
    : null;
  const snapshot = makeSnapshot({
    metricName,
    chartId,
    metricVersion: definition.metricVersion,
    startDate,
    endDate,
    fetchedAt,
    checks: [
      ...parsed.checks,
      "comparison is current date versus the same weekday seven days earlier",
    ],
    comparison: {
      currentDate: endDate,
      currentValue: endValue,
      comparisonDate,
      comparisonValue,
      wowChange: changePct,
    },
  });
  return {
    metricName,
    metricVersion: definition.metricVersion,
    chartId,
    title: definition.title,
    kind: "timeseries",
    valuesByDate: parsed.valuesByDate,
    snapshot,
    chartSnapshot: {
      chartId,
      title: definition.title,
      kind: "timeseries",
      metricLabel: metricName === "Daily_Revenue" ? "Revenue" : "Uniques (daily)",
      yesterday: endDate,
      dayBefore: comparisonDate,
      yesterdayValue: endValue,
      dayBeforeValue: comparisonValue,
      changePct,
      comparisonKind: "WoW",
      snapshot,
    },
  };
}
