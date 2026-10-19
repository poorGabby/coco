import { reportDateStr } from "./report-timezone.js";
import { addDays, DATA_CONTRACT_VERSION, type DataSnapshotMeta } from "./agent/tool-impls.js";
import { BUSINESS_METRIC_DEFINITIONS } from "./metric-definitions.js";
import type { StandardChartMetricResult } from "./standard-chart-metrics.js";

const DAYS = [1, 3, 7] as const;
type Point = NonNullable<DataSnapshotMeta["retention"]>["points"]["D1"];

export function dailyCohortContext(title: string, day: "D1" | "D3" | "D7", point: Point): string {
  const pct = (value: number | null | undefined) => value == null ? "N/A" : `${(value * 100).toFixed(2)}%`;
  const pp = point.wowChangePp;
  const wow = pp == null ? "N/A" : `${pp > 0 ? "+" : ""}${pp.toFixed(2)}pp`;
  return `- ${title} — Day ${day.slice(1)}（有 User ID）：美区 ${point.cohortDate} 新用户 → 美区 ${point.observationDate} 回访=${pct(point.rate)} (${point.numerator}/${point.denominator}); 上周美区 ${point.comparisonCohortDate} → 美区 ${point.comparisonObservationDate}=${pct(point.comparisonRate)} (${point.comparisonNumerator}/${point.comparisonDenominator}); WoW=${wow}；主值为独立单日 cohort，非 overall。`;
}

function dateOf(value: string): string | null {
  const raw = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const dt = new Date(`${raw}T00:00:00Z`);
    return Number.isFinite(dt.getTime()) && dt.toISOString().slice(0, 10) === raw ? raw : null;
  }
  if (!/^[A-Za-z]{3} \d{1,2}, \d{4}$/.test(raw)) return null;
  const dt = new Date(`${raw} UTC`);
  return Number.isFinite(dt.getTime()) ? dt.toISOString().slice(0, 10) : null;
}

function integer(value: string | undefined, label: string): number {
  const raw = (value ?? "").replaceAll(",", "").trim();
  if (!/^\d+$/.test(raw)) throw new Error(`New_User_Retention: ${label} is missing or is not an integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new Error(`New_User_Retention: ${label} exceeds safe integer range`);
  return parsed;
}

/** Parse the saved Chart CSV, whose cohort rows expose exact Users and Day N counts.
 * The metadata must prove the identity restriction before any result can be used.
 * This path is shared by the report, Agent, and the unpublished-query preview.
 */
export function buildNewUserRetentionFromCsv(
  inputRows: string[][],
  observationDate: string,
  options: { fetchedAt?: Date; lastCompletedDate?: string; sourceUrl?: string; preview?: boolean } = {},
): StandardChartMetricResult {
  const rows = inputRows.map(row => row.map(cell => String(cell ?? "").replace(/^\t+/, "").trim()));
  const fetchedAt = options.fetchedAt ?? new Date();
  const lastCompleted = options.lastCompletedDate ?? reportDateStr(-1, fetchedAt);
  if (!dateOf(observationDate) || observationDate > lastCompleted) {
    throw new Error(`New_User_Retention: observation date ${observationDate} is not a completed Dawson day (latest ${lastCompleted})`);
  }
  const headerIndex = rows.findIndex(row => row[0] === "Segment" && row.includes("Start Date"));
  if (headerIndex < 0) throw new Error("New_User_Retention: missing cohort CSV header");
  const metadata = rows.slice(0, headerIndex);
  const startMetadata = metadata.filter(row => row.some(cell => cell.includes("[Amplitude] New User")));
  const identity = /(?:\[Amplitude\]\s*)?user[_ ]id\s+is not\s+["']*\(none\)["']*/i;
  if (startMetadata.length !== 1 || !identity.test(startMetadata[0].join(" "))) {
    throw new Error("New_User_Retention: saved Chart start event is missing user_id is not (none); refusing unfiltered data");
  }
  if (!metadata.some(row => row.some(cell => /^N-Day Retention$/i.test(cell)))) {
    throw new Error("New_User_Retention: expected N-Day Retention");
  }
  const returnRows = metadata.filter(row => row[0] === "companion_alive_daily");
  if (returnRows.length !== 1) throw new Error("New_User_Retention: expected one companion_alive_daily return event");
  const header = rows[headerIndex];
  const usersColumn = header.indexOf("Users");
  if (usersColumn < 0) throw new Error("New_User_Retention: cohort Users column is missing");
  const cohorts = new Map<string, string[]>();
  for (const row of rows.slice(headerIndex + 1)) {
    if (row[0] !== "All Users") continue;
    const date = dateOf(row[1] ?? "");
    if (!date) continue; // Overall rows and comparison segments are not daily cohorts.
    if (cohorts.has(date)) throw new Error(`New_User_Retention: duplicate cohort ${date}`);
    cohorts.set(date, row);
  }
  const cellFor = (date: string, day: number): { numerator: number; denominator: number; rate: number | null } => {
    const row = cohorts.get(date);
    if (!row) throw new Error(`New_User_Retention: D${day} cohort ${date} is missing; no older-date fallback`);
    const col = header.indexOf(`Day ${day}`);
    if (col < 0) throw new Error(`New_User_Retention: Day ${day} column is missing`);
    const numerator = integer(row[col], `${date} D${day} count`);
    const denominator = integer(row[usersColumn], `${date} cohort users`);
    if (numerator > denominator) throw new Error(`New_User_Retention: ${date} D${day} count exceeds cohort users`);
    return { numerator, denominator, rate: denominator === 0 ? null : numerator / denominator };
  };
  const comparisonObservationDate = addDays(observationDate, -7);
  const points = {} as NonNullable<DataSnapshotMeta["retention"]>["points"];
  const checks = [
    "start-event metadata proves user_id is not (none)",
    "start event is New User; return event is companion_alive_daily; N-Day Retention",
    "All Users daily cohort rows only; overall and No_India are excluded",
    "observation date is a completed America/Dawson calendar day",
    "D1/D3/D7 each use observationDate minus their own day offset",
    "each WoW comparison shifts both cohort and observation date exactly seven days earlier",
    "exact integer retained/users counts; zero users are N/A; missing current cells do not roll back to older cohorts",
  ];
  for (const day of DAYS) {
    const cohortDate = addDays(observationDate, -day);
    const comparisonCohortDate = addDays(cohortDate, -7);
    const current = cellFor(cohortDate, day);
    let previous: ReturnType<typeof cellFor> | null = null;
    try { previous = cellFor(comparisonCohortDate, day); }
    catch (error) { checks.push(error instanceof Error ? error.message : String(error)); }
    const change = current.rate != null && previous?.rate != null ? (current.rate - previous.rate) * 100 : null;
    const point: Point = {
      ...current, currentValue: current.rate, mature: true,
      cohortDate, comparisonCohortDate, observationDate, comparisonObservationDate,
      wowCurrentNumerator: current.numerator, wowCurrentDenominator: current.denominator, wowCurrentRate: current.rate,
      comparisonNumerator: previous?.numerator ?? null, comparisonDenominator: previous?.denominator ?? null,
      comparisonRate: previous?.rate ?? null, comparisonValue: previous?.rate ?? null,
      comparisonMature: previous != null, wowChange: change, wowChangePp: change,
    };
    points[`D${day}` as const] = point;
  }
  const definition = BUSINESS_METRIC_DEFINITIONS.New_User_Retention;
  const retention: NonNullable<DataSnapshotMeta["retention"]> = {
    cohortDate: null, currentCohort: null, comparisonCohort: null,
    scope: "daily-cohort-per-day", valueScope: "daily-cohort-per-day", wowScope: "single-cohort-week-over-week",
    observationDate, comparisonObservationDate,
    currentPeriod: { startDate: observationDate, endDate: observationDate },
    comparisonPeriod: { startDate: comparisonObservationDate, endDate: comparisonObservationDate },
    calculation: "n-day", points,
    maturityRule: "Each Day N uses the cohort observationDate-N and its exact calendar Day N count. Both observation days are complete; no shared D7-aged cohort or overall substitution.",
  };
  const complete = DAYS.every(day => points[`D${day}`].rate != null && points[`D${day}`].comparisonRate != null);
  const sourceUrl = options.sourceUrl ?? `https://app.amplitude.com/analytics/lollapaloozalab/chart/${definition.chartId}`;
  const snapshot: DataSnapshotMeta = {
    contractVersion: DATA_CONTRACT_VERSION, metricVersion: definition.metricVersion,
    tool: "fetch_standard_chart_metric", metric: "New_User_Retention", metricName: "New_User_Retention",
    chartId: options.preview ? null : definition.chartId,
    input: { observationDate, comparisonObservationDate, timezone: "America/Dawson", userIdFilter: "user_id is not (none)", sourceUrl, preview: options.preview ?? false },
    source: options.preview ? "Amplitude unpublished candidate query" : "Amplitude Chart CSV",
    timezone: "America/Dawson", coverage: { startDate: addDays(observationDate, -14), endDate: observationDate },
    pulledAt: fetchedAt.toISOString(), fetchedAt: fetchedAt.toISOString(),
    completeness: complete ? "complete" : "partial", validation: { status: complete ? "passed" : "warning", checks },
    valueScope: "daily-cohort-per-day", wowScope: "single-cohort-week-over-week", retention,
  };
  return {
    metricName: "New_User_Retention", metricVersion: definition.metricVersion, chartId: definition.chartId!,
    title: definition.title, kind: "retention", retention, snapshot,
    chartSnapshot: {
      chartId: definition.chartId!, title: definition.title, kind: "retention", metricLabel: "User ID only · N-Day · calendar days",
      yesterday: observationDate, dayBefore: comparisonObservationDate,
      yesterdayValue: points.D1.rate == null ? null : points.D1.rate * 100,
      dayBeforeValue: points.D1.comparisonRate == null ? null : points.D1.comparisonRate * 100,
      changePct: points.D1.wowChangePp ?? null, comparisonKind: "WoW", snapshot,
    },
  };
}
