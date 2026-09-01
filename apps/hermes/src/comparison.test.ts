import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChartSnapshot } from "./amplitude.js";
import type { DataSnapshotMeta } from "./agent/tool-impls.js";
import { buildAnalysisPrompt, fallbackAnalysis } from "./analyze.js";
import { buildDailyCard } from "./card.js";
import { buildReportMarkdown } from "./report.js";

const dau: ChartSnapshot = {
  chartId: "ilhu9t17",
  title: "Daily Active Users (DAU) — Calendar Day",
  kind: "timeseries",
  metricLabel: "Uniques (daily)",
  yesterday: "2026-08-17",
  dayBefore: "2026-08-10",
  yesterdayValue: 12_100,
  dayBeforeValue: 10_000,
  changePct: 21,
  comparisonKind: "WoW",
};

const newUsers: ChartSnapshot = {
  chartId: "1n0bfs5k",
  title: "New Users",
  kind: "timeseries",
  metricLabel: "Uniques (daily)",
  yesterday: "2026-08-17",
  dayBefore: "2026-08-10",
  yesterdayValue: 80,
  dayBeforeValue: 100,
  changePct: -20,
  comparisonKind: "WoW",
};

const retention: ChartSnapshot = {
  chartId: "18lt8h9t",
  title: "New User Retention",
  kind: "retention",
  metricLabel: "Return On · 24-hour windows",
  yesterday: "2026-08-09",
  dayBefore: "2026-08-02",
  yesterdayValue: 56.9,
  dayBeforeValue: 52.1,
  changePct: 4.8,
  comparisonKind: "WoW",
  snapshot: {
    retention: {
      cohortDate: null,
      scope: "overall-combined",
      valueScope: "overall-combined",
      wowScope: "single-cohort-week-over-week",
      currentPeriod: { startDate: "2026-07-11", endDate: "2026-08-09" },
      comparisonPeriod: null,
      overallComparisonAvailability: "unavailable",
      currentCohort: "2026-08-09",
      comparisonCohort: "2026-08-02",
      calculation: "n-day",
      maturityRule: "both mature",
      points: {
        D1: { numerator: 569, denominator: 1000, rate: 0.569, mature: true, wowCurrentNumerator: 600, wowCurrentDenominator: 1000, wowCurrentRate: 0.6, comparisonNumerator: 521, comparisonDenominator: 1000, comparisonRate: 0.521, comparisonMature: true, wowChangePp: 7.9 },
        D3: { numerator: 500, denominator: 1000, rate: 0.5, mature: true, wowCurrentNumerator: 550, wowCurrentDenominator: 1000, wowCurrentRate: 0.55, comparisonNumerator: 510, comparisonDenominator: 1000, comparisonRate: 0.51, comparisonMature: true, wowChangePp: 4 },
        D7: { numerator: 300, denominator: 1000, rate: 0.3, mature: true, wowCurrentNumerator: 400, wowCurrentDenominator: 1000, wowCurrentRate: 0.4, comparisonNumerator: 500, comparisonDenominator: 1000, comparisonRate: 0.5, comparisonMature: true, wowChangePp: -10 },
      },
    },
  } as DataSnapshotMeta,
};

test("all daily metrics display and analyze WoW", () => {
  const report = buildReportMarkdown([dau, newUsers]);
  assert.match(report, /Daily Active Users \(DAU\) — Calendar Day \| 12,100 \| 10,000 \| WoW \+21\.0%/);
  assert.match(report, /New Users \| 80 \| 100 \| WoW -20\.0%/);

  const prompt = buildAnalysisPrompt([dau, newUsers]);
  assert.match(prompt, /上周同日\(美区 2026-08-10\)=10000 WoW=\+21\.0%/);
  assert.match(prompt, /New Users[^\n]*WoW=-20\.0%/);

  const card = JSON.stringify(buildDailyCard({
    alertCount: 0,
    watchCount: 0,
    summary: "ok",
    alerts: [],
    watches: [],
    hypotheses: "ok",
  }, [dau, newUsers], "2026-08-17"));
  assert.match(card, /Daily Active Users \(DAU\) — Calendar Day[^]*WoW \+21\.0%/);
  assert.match(card, /New Users[^]*WoW -20\.0%/);
});

test("fallback alerts use each snapshot comparison semantic", () => {
  const fallingDau = { ...dau, yesterdayValue: 8_000, changePct: -20 };
  const analysis = fallbackAnalysis([fallingDau, newUsers], "");
  assert.match(JSON.stringify(analysis.alerts), /WoW -20\.0%/);
  assert.match(JSON.stringify(analysis.alerts), /较上周同日/);
  assert.equal((JSON.stringify(analysis.alerts).match(/WoW -20\.0%/g) ?? []).length, 2);
});

test("retention renders overall/combined headline values with separate single-cohort WoW", () => {
  const report = buildReportMarkdown([retention]);
  assert.match(report, /• New User Retention — Day 1: 56\.9% \(WoW \+7\.9pp\)/);
  assert.match(report, /• New User Retention — Day 7: 30\.0% \(WoW -10\.0pp\)/);
  assert.doesNotMatch(report, /D1 \/ D3 \/ D7|Day 1 D1/);

  const card = JSON.stringify(buildDailyCard({ alertCount: 0, watchCount: 0, summary: "ok", alerts: [], watches: [], hypotheses: "ok" }, [retention], "2026-08-09"));
  assert.match(card, /New User Retention — Day 1[^]*56\.9%[^]*WoW \+7\.9pp/);
  assert.doesNotMatch(card, /D1 \/ D3 \/ D7|Day 1 D1/);

  const prompt = buildAnalysisPrompt([retention]);
  assert.match(prompt, /主值 overall\/combined/);
  assert.match(prompt, /WoW 单日 cohort 基础/);
  assert.match(prompt, /WoW=\+7\.90pp/);

  const purchaserRetention = { ...retention, title: "Purchaser Companion Retention" };
  const purchaserReport = buildReportMarkdown([purchaserRetention]);
  assert.match(purchaserReport, /Purchaser Companion Retention — Day 1/);
  assert.match(purchaserReport, /Purchaser Companion Retention — Day 3/);
  assert.match(purchaserReport, /Purchaser Companion Retention — Day 7/);
  assert.doesNotMatch(purchaserReport, /D1 \/ D3 \/ D7|Day [137] D[137]/);
});
