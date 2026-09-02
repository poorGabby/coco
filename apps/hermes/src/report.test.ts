import { test } from "node:test";
import assert from "node:assert/strict";
import type { Env } from "./env.js";
import type { ChartSnapshot } from "./amplitude.js";
import { buildDailyCard } from "./card.js";
import { buildReportMarkdown, fetchStandardMetricSnapshots, type DailyPurchaseCounts } from "./report.js";

const env = { amplitudeApiKey: "key", amplitudeSecretKey: "secret" } as Env;
const dates = [
  "2026-08-12", "2026-08-13", "2026-08-14", "2026-08-15",
  "2026-08-16", "2026-08-17", "2026-08-18", "2026-08-19",
];

function csvResponse(title: string, measure: string, segment: string): Response {
  const header = ["\tSegment", ...dates.map((date) => `\t${date}`)];
  const values = [`\t${segment}`, ...dates.map((_, index) => String(100 + index))];
  const csv = [
    `"\t${title}"`,
    `"\t${measure}"`,
    header.map((cell) => `"${cell}"`).join(","),
    values.map((cell) => `"${cell}"`).join(","),
  ].join("\n");
  return new Response(JSON.stringify({ data: csv }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function retentionResponse(): Response {
  const cells = Array.from({ length: 9 }, () => ({
    count: 80,
    outof: 100,
    incomplete: false,
  }));
  return new Response(JSON.stringify({
    data: {
      series: [{
        dates: ["Aug 04, 2026", "Aug 11, 2026"],
        values: {
          "Aug 04, 2026": cells,
          "Aug 11, 2026": cells,
        },
        combined: cells,
      }],
      seriesMeta: [{ segmentIndex: 0, eventIndex: 0 }],
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function dailyUniquesQueryResponse(values: number[], queryDates = dates): Response {
  return new Response(JSON.stringify({
    data: {
      series: [values.map((value) => ({ setId: "", value }))],
      xValues: queryDates,
      seriesMeta: [{ segmentIndex: 0, eventIndex: 0 }],
    },
    transformationIds: [],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("a stale DAU fails independently without moving the report off its Dawson calendar date", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("ilhu9t17")) {
      return new Response(JSON.stringify({
        data: {
          series: [[110, 111, 112, 113, 114, 115, 116, 120].map((value) => ({ value }))],
          xValues: [
            "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14",
            "2026-08-15", "2026-08-16", "2026-08-17", "2026-08-18",
          ],
          seriesMeta: [{ segmentIndex: 0, eventIndex: 0 }],
        },
        transformationIds: [],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("odptyaey")) return dailyUniquesQueryResponse(dates.map((_, index) => 100 + index));
    if (url.includes("7n9n6eez")) return csvResponse("Purchase Users", "Uniques", "All Users");
    if (url.includes("xqmzi8cs")) return csvResponse("Daily Revenue", "Totals", "All Users");
    if (url.includes("lthx47q8") || url.includes("v5i4q52e")) return retentionResponse();
    throw new Error(`unexpected URL ${url}`);
  };

  const snapshots = await fetchStandardMetricSnapshots(env, "2026-08-19");
  assert.equal(snapshots.length, 6);

  const dau = snapshots.find((snapshot) => snapshot.snapshot?.metricName === "DAU");
  assert.match(dau?.error ?? "", /outside Chart coverage .*2026-08-18/);
  assert.equal(dau?.yesterday, "2026-08-19");
  assert.equal(dau?.snapshot?.currentDate, "2026-08-19");
  assert.equal(dau?.snapshot?.completeness, "empty");

  for (const metric of ["New_Users", "Purchase_Users", "Daily_Revenue"]) {
    const snapshot = snapshots.find((item) => item.snapshot?.metricName === metric);
    assert.equal(snapshot?.error, undefined, `${metric} should remain available`);
    assert.equal(snapshot?.snapshot?.currentDate, "2026-08-19");
  }

  const markdown = buildReportMarkdown(snapshots, undefined, "2026-08-19");
  assert.match(markdown, /每日简报 · 美区 2026\/08\/19/);
  assert.match(markdown, /Daily Active Users.*错误/);
});

test("日报展示使用数据日期标题和精简 Daily Revenue 文案", () => {
  const revenue = {
    chartId: "xqmzi8cs",
    title: "Daily Revenue",
    kind: "timeseries",
    metricLabel: "Revenue",
    yesterday: "2026-08-23",
    dayBefore: "2026-08-16",
    yesterdayValue: 359.64,
    dayBeforeValue: 489.22,
    changePct: -26.5,
    comparisonKind: "WoW",
    snapshot: { metricName: "Daily_Revenue" } as ChartSnapshot["snapshot"],
  } satisfies ChartSnapshot;
  const purchase = {
    secondPet: 0,
    treats: 5,
    pocket: 4,
    stash: 0,
    bigBag: 1,
    secondPetQuantity: 0,
    pocketQuantity: 0,
    stashQuantity: 0,
    bigBagQuantity: 0,
    secondPetWow: null,
    treatsWow: null,
    pocketWow: null,
    stashWow: null,
    bigBagWow: null,
    stripeRevenue: 0,
    stripePreviousRevenue: 0,
  } satisfies DailyPurchaseCounts;
  const markdown = buildReportMarkdown([revenue], undefined, "2026-08-23", purchase);
  assert.match(markdown, /📊 Furever Dock 每日简报 · 美区 2026\/08\/23/);
  assert.match(markdown, /• Daily Revenue: \$359\.64 \(WoW -26\.5%\)/);
  assert.doesNotMatch(markdown, /purchase_completed|Revenue \(\$\)|\$9\.99/);

  const card = buildDailyCard(
    { alertCount: 0, watchCount: 0, summary: "summary", alerts: [], watches: [], hypotheses: "hypotheses" },
    [revenue],
    "美区 2026/08/23",
    purchase,
  );
  const cardText = JSON.stringify(card);
  assert.match(cardText, /Furever Dock 每日简报 · 美区 2026\/08\/23/);
  assert.match(cardText, /Daily Revenue:\*\* \$359\.64/);
  assert.doesNotMatch(cardText, /purchase_completed × \$9\.99|Revenue \(\$\)/);
});
