import { test } from "node:test";
import assert from "node:assert/strict";
import type { Env } from "./env.js";
import type { ChartSnapshot } from "./amplitude.js";
import { buildDailyCard } from "./card.js";
import { buildReportMarkdown, fetchStandardMetricSnapshots, type DailyPurchaseCounts } from "./report.js";
import { buildAnalysisPrompt, fallbackAnalysis, enforceAnalysisScope } from "./analyze.js";

const env = { amplitudeApiKey: "key", amplitudeSecretKey: "secret" } as Env;

test("report display and analysis share one Stripe revenue snapshot", () => {
  const revenue: ChartSnapshot = {
    chartId: "stripe-charges", title: "Daily Revenue", kind: "timeseries", metricLabel: "USD net revenue",
    yesterday: "2026-09-05", dayBefore: "2026-08-29", yesterdayValue: 454.48,
    dayBeforeValue: 445.57, changePct: 2,
    snapshot: { metricName: "Daily_Revenue", source: "Stripe Charges API" } as ChartSnapshot["snapshot"],
  };
  const purchase = {} as DailyPurchaseCounts;
  const prompt = buildAnalysisPrompt([revenue]);
  assert.match(prompt, /454\.48.*445\.57.*WoW=\+2\.0%/);
  const analysis = fallbackAnalysis([revenue], "");
  assert.equal(analysis.alertCount, 0);
  assert.equal(analysis.watchCount, 0);
  assert.deepEqual(analysis.alerts, []);
  assert.deepEqual(analysis.watches, []);
  assert.match(prompt, /Stripe.*Charge/);
  for (const hypotheses of ["总收入增长而购买人数下降，可能得益于客单价提升", "购买频次可能降低"]) {
    const checked = enforceAnalysisScope({ ...analysis, hypotheses }, [revenue], "");
    assert.doesNotMatch(JSON.stringify(checked), /客单价|购买频次/);
    assert.match(checked.hypotheses, /原因尚未验证/);
  }
  const markdown = buildReportMarkdown([revenue], undefined, "2026-09-05", purchase);
  const card = JSON.stringify(buildDailyCard(analysis, [revenue], "美区 2026/09/05", purchase));
  for (const text of [markdown, card]) {
    assert.match(text, /454\.48.*WoW \+2\.0%/);
    assert.match(text, /Stripe.*Charge/);
    assert.doesNotMatch(text, /Amplitude \+ Stripe/);
    assert.doesNotMatch(text, /<font|核心指标 · \d+ 项/);
  }
});
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

function newUserRetentionResponse(): Response {
  const rows = [
    ["New User Retention"], ["[Amplitude] New User", "user_id is not (none)"],
    ["companion_alive_daily"], ["N-Day Retention"],
    ["Segment", "Start Date", "Users", ...Array.from({ length: 8 }, (_, d) => `Day ${d}`)],
    ...["2026-08-18", "2026-08-16", "2026-08-12", "2026-08-11", "2026-08-09", "2026-08-05"]
      .map(date => ["All Users", date, "100", ...Array.from({ length: 8 }, () => "80")]),
  ];
  const csv = rows.map(row => row.map(cell => `"${cell}"`).join(",")).join("\n");
  return new Response(JSON.stringify({ data: csv }), { status: 200 });
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
    if (url.includes("lthx47q8")) return newUserRetentionResponse();
    if (url.includes("v5i4q52e")) return retentionResponse();
    throw new Error(`unexpected URL ${url}`);
  };

  const snapshots = await fetchStandardMetricSnapshots(env, "2026-08-19");
  assert.equal(snapshots.length, 6);
  const newRetention = snapshots.find(snapshot => snapshot.snapshot?.metricName === "New_User_Retention");
  assert.equal(newRetention?.error, undefined);
  assert.equal(newRetention?.snapshot?.retention?.observationDate, "2026-08-19");
  assert.equal(newRetention?.snapshot?.retention?.points.D1.cohortDate, "2026-08-18");

  const dau = snapshots.find((snapshot) => snapshot.snapshot?.metricName === "DAU");
  assert.match(dau?.error ?? "", /outside Chart coverage .*2026-08-18/);
  assert.equal(dau?.yesterday, "2026-08-19");
  assert.equal(dau?.snapshot?.currentDate, "2026-08-19");
  assert.equal(dau?.snapshot?.completeness, "empty");

  for (const metric of ["New_Users", "Purchase_Users"]) {
    const snapshot = snapshots.find((item) => item.snapshot?.metricName === metric);
    assert.equal(snapshot?.error, undefined, `${metric} should remain available`);
    assert.equal(snapshot?.snapshot?.currentDate, "2026-08-19");
  }
  const revenue = snapshots.find((item) => item.snapshot?.metricName === "Daily_Revenue");
  assert.match(revenue?.error ?? "", /STRIPE_API_KEY/);
  assert.equal(revenue?.snapshot?.source, "Stripe Charges API");

  const markdown = buildReportMarkdown(snapshots, undefined, "2026-08-19");
  assert.match(markdown, /每日简报 · 美区 2026\/08\/19/);
  assert.match(markdown, /Daily Active Users.*错误/);
});

test("日报展示使用数据日期标题和精简 Daily Revenue 文案", () => {
  const revenue = {
    chartId: "stripe-charges",
    title: "Daily Revenue",
    kind: "timeseries",
    metricLabel: "Revenue",
    yesterday: "2026-08-23",
    dayBefore: "2026-08-16",
    yesterdayValue: 359.64,
    dayBeforeValue: 489.22,
    changePct: -26.5,
    comparisonKind: "WoW",
    snapshot: { metricName: "Daily_Revenue", source: "Stripe Charges API" } as ChartSnapshot["snapshot"],
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
