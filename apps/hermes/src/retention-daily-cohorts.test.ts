import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNewUserRetentionFromCsv } from "./retention-daily-cohorts.js";
import { addDays } from "./agent/tool-impls.js";
import { fetchStandardChartMetric } from "./standard-chart-metrics.js";
import { buildAnalysisPrompt, fallbackAnalysis } from "./analyze.js";
import { buildAmplitudeContext } from "./ask.js";
import { buildReportMarkdown } from "./report.js";
import { buildDailyCard } from "./card.js";
import type { Env } from "./env.js";

const options = { fetchedAt: new Date("2026-10-16T16:00:00Z") };
function fixture(): string[][] {
  const rows = [
    ["New User Retention"],
    ["[Amplitude] New User", 'user_id is not "(none)"'],
    ["companion_alive_daily"], ["N-Day Retention"], [],
    ["Segment", "Start Date", "Users", ...Array.from({ length: 8 }, (_, d) => `Day ${d}`)],
    ["All Users", "Overall", "Retained %", "99%", "99%", "99%", "99%", "99%", "99%", "99%", "99%"],
  ];
  for (let i = 0; i < 29; i++) {
    rows.push(["All Users", addDays("2026-09-16", i), "100", ...Array.from({ length: 8 }, (_, d) => String(80 - i - d))]);
  }
  const set = (date: string, day: number, n: number, total = 100) => {
    const row = rows.find(r => r[1] === date)!;
    row[2] = String(total); row[3 + day] = String(n);
  };
  set("2026-10-14", 1, 60); set("2026-10-07", 1, 50);
  set("2026-10-12", 3, 40); set("2026-10-05", 3, 35);
  set("2026-10-08", 7, 20); set("2026-10-01", 7, 30);
  rows.push(["No_India", "2026-10-14", "100", "99", "99", "99", "99", "99", "99", "99", "99"]);
  return rows;
}

test("daily retention selects each Day N cohort independently and shifts its WoW by seven days", () => {
  const result = buildNewUserRetentionFromCsv(fixture(), "2026-10-15", options);
  const retention = result.retention!;
  assert.equal(result.snapshot.valueScope, "daily-cohort-per-day");
  assert.equal(result.snapshot.completeness, "complete");
  assert.equal(retention.currentCohort, null, "there is no single shared D7-aged cohort");
  for (const [day, cohortDate, previousDate, rate, previousRate] of [
    ["D1", "2026-10-14", "2026-10-07", 0.6, 0.5],
    ["D3", "2026-10-12", "2026-10-05", 0.4, 0.35],
    ["D7", "2026-10-08", "2026-10-01", 0.2, 0.3],
  ] as const) {
    const p = retention.points[day];
    assert.equal(p.cohortDate, cohortDate);
    assert.equal(p.comparisonCohortDate, previousDate);
    assert.equal(p.observationDate, "2026-10-15");
    assert.equal(p.comparisonObservationDate, "2026-10-08");
    assert.equal(p.rate, rate);
    assert.equal(p.comparisonRate, previousRate);
    assert.equal(p.wowChangePp, (rate - previousRate) * 100);
  }
});

test("missing identity filter is rejected rather than silently counting anonymous users", () => {
  const rows = fixture(); rows[1] = ["[Amplitude] New User"];
  assert.throws(() => buildNewUserRetentionFromCsv(rows, "2026-10-15", options), /missing user_id/);
});

test("missing latest cohort or Day N count never falls back to older available data", () => {
  const rows = fixture().filter(r => r[1] !== "2026-10-14");
  assert.throws(() => buildNewUserRetentionFromCsv(rows, "2026-10-15", options), /cohort 2026-10-14 is missing/);
  const incomplete = fixture(); incomplete.find(r => r[1] === "2026-10-12")![6] = "";
  assert.throws(() => buildNewUserRetentionFromCsv(incomplete, "2026-10-15", options), /D3 count is missing/);
});

test("Dawson day must be fully finished; Beijing calendar yesterday is not sufficient", () => {
  assert.throws(() => buildNewUserRetentionFromCsv(fixture(), "2026-10-15", {
    fetchedAt: new Date("2026-10-16T04:00:00Z"),
  }), /not a completed Dawson day \(latest 2026-10-14\)/);
  assert.throws(() => buildNewUserRetentionFromCsv(fixture(), "2026-02-30", options), /not a completed/);
});

test("missing comparison preserves the current value but marks only its WoW unavailable", () => {
  const rows = fixture().filter(r => r[1] !== "2026-10-01");
  const result = buildNewUserRetentionFromCsv(rows, "2026-10-15", options);
  assert.equal(result.retention?.points.D7.rate, 0.2);
  assert.equal(result.retention?.points.D7.wowChangePp, null);
  assert.equal(result.snapshot.completeness, "partial");
});

test("zero users are N/A while a zero comparison rate still yields a valid pp change", () => {
  const rows = fixture(); const comparison = rows.find(r => r[1] === "2026-10-07")!;
  comparison[4] = "0";
  let result = buildNewUserRetentionFromCsv(rows, "2026-10-15", options);
  assert.equal(result.retention?.points.D1.wowChangePp, 60);
  const current = rows.find(r => r[1] === "2026-10-14")!; current[2] = "0"; current[4] = "0";
  result = buildNewUserRetentionFromCsv(rows, "2026-10-15", options);
  assert.equal(result.retention?.points.D1.rate, null);
  assert.equal(result.retention?.points.D1.wowChangePp, null);
});

test("duplicate cohorts, invalid counts and changed retention methods fail closed", () => {
  const rows = fixture(); rows.push([...rows.find(r => r[1] === "2026-10-14")!]);
  assert.throws(() => buildNewUserRetentionFromCsv(rows, "2026-10-15", options), /duplicate cohort/);
  const invalid = fixture(); invalid.find(r => r[1] === "2026-10-14")![4] = "101";
  assert.throws(() => buildNewUserRetentionFromCsv(invalid, "2026-10-15", options), /exceeds cohort users/);
  const method = fixture(); method[3] = ["Return On or After"];
  assert.throws(() => buildNewUserRetentionFromCsv(method, "2026-10-15", options), /expected N-Day/);
});

test("report and card metrics show only rates and WoW while internal contexts retain cohort dates", () => {
  const s = buildNewUserRetentionFromCsv(fixture(), "2026-10-15", options).chartSnapshot;
  const originalSnapshot = JSON.stringify(s.snapshot);
  const markdown = buildReportMarkdown([s], undefined, "2026-10-15");
  const prompt = buildAnalysisPrompt([s]);
  const context = buildAmplitudeContext([s], markdown);
  const analysis = fallbackAnalysis([s], markdown);
  const card = buildDailyCard(analysis, [s], "美区 2026/10/15") as { body: { elements: Array<{ tag: string; elements?: unknown[] }> } };
  const metricsPanel = card.body.elements.find(element => element.tag === "collapsible_panel");
  const cardMetrics = JSON.stringify(metricsPanel?.elements);
  for (const text of [prompt, context]) {
    assert.match(text, /2026-10-14/); assert.match(text, /2026-10-12/); assert.match(text, /2026-10-08/);
    assert.match(text, /2026-10-01/); assert.match(text, /WoW/);
    assert.doesNotMatch(text, /DoD|主值为 Last 30 days overall/);
  }
  assert.match(markdown, /Day 1: 60\.0% \(WoW \+10\.0pp\)/);
  assert.match(markdown, /Day 7: 20\.0% \(WoW -10\.0pp\)/);
  for (const text of [markdown, cardMetrics]) {
    assert.doesNotMatch(text, /2026-10-14|2026-10-12|2026-10-08|2026-10-01/);
    assert.doesNotMatch(text, /有 User ID 新用户|回访；上周|→/);
    assert.match(text, /60\.0%.*WoW \+10\.0pp/);
    assert.match(text, /20\.0%.*WoW -10\.0pp/);
  }
  assert.equal(JSON.stringify(s.snapshot), originalSnapshot, "formatting must not mutate source metadata");
  assert.match(prompt, /有 User ID/);
});

test("standard function reads saved Chart filtered CSV and honours the report observation date", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const urls: string[] = [];
  globalThis.fetch = async input => {
    urls.push(String(input));
    const csv = fixture().map(row => row.map(cell => `"${cell.replaceAll('"', '""')}"`).join(",")).join("\n");
    return new Response(JSON.stringify({ data: csv }), { status: 200 });
  };
  const result = await fetchStandardChartMetric({ amplitudeApiKey: "test", amplitudeSecretKey: "test" } as Env,
    "New_User_Retention", { endDate: "2026-10-14" });
  assert.equal(urls.length, 1);
  assert.match(urls[0], /\/lthx47q8\/csv\?/);
  assert.equal(result.retention?.points.D1.cohortDate, "2026-10-13");
  assert.equal(result.retention?.points.D7.cohortDate, "2026-10-07");
});
