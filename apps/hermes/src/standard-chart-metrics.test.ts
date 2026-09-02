import { test } from "node:test";
import assert from "node:assert/strict";
import type { Env } from "./env.js";
import { fetchStandardChartMetric } from "./standard-chart-metrics.js";

const env = { amplitudeApiKey: "key", amplitudeSecretKey: "secret" } as Env;

function csvResponse(csv: string): Response {
  return new Response(JSON.stringify({ data: csv }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("Chart standard functions parse fixed timeseries rows and revenue formula", async (t) => {
  const originalFetch = globalThis.fetch;
  let dauFetchCount = 0;
  let newUsersFetchCount = 0;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("ilhu9t17")) {
      dauFetchCount += 1;
      assert.match(url, /\/ilhu9t17\/query\?/);
      return new Response(JSON.stringify({
        data: {
          series: [[11200, 11500, 11900, 12200, 12600, 13137, 13595, 14208].map((value) => ({ setId: "", value }))],
          xValues: ["2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14", "2026-08-15", "2026-08-16", "2026-08-17"],
          seriesMeta: [{ segmentIndex: 0, eventIndex: 0 }],
        },
        transformationIds: [],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("odptyaey")) {
      newUsersFetchCount += 1;
      assert.match(url, /\/odptyaey\/query\?/);
      return new Response(JSON.stringify({
        data: {
          series: [[690, 1414, 1465, 1322, 722, 627, 869, 1139].map((value) => ({ setId: "", value }))],
          xValues: ["2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08", "2026-08-09", "2026-08-10", "2026-08-11"],
          seriesMeta: [{ segmentIndex: 0, eventIndex: 0 }],
        },
        transformationIds: [],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("xqmzi8cs")) {
      return csvResponse([
        '"\tDaily Revenue (purchase_completed × $9.99)"',
        '"\tTotals"',
        '"\tSegment","\t2026-08-10","\t2026-08-11","\t2026-08-12","\t2026-08-13","\t2026-08-14","\t2026-08-15","\t2026-08-16","\t2026-08-17"',
        '"\tAll Users","30","31","32","33","34","53","49","41"',
      ].join("\n"));
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const dau = await fetchStandardChartMetric(env, "DAU", {
    startDate: "2026-08-16", endDate: "2026-08-17",
  });
  assert.equal(dau.valuesByDate?.["2026-08-17"], 14208);
  assert.equal(dau.snapshot.chartId, "ilhu9t17");
  assert.equal(dau.title, "Daily Active Users (DAU) — Calendar Day");
  assert.equal(dau.snapshot.source, "Amplitude Chart");
  assert.equal(dau.chartSnapshot.comparisonKind, "WoW");
  assert.equal(dau.chartSnapshot.dayBefore, "2026-08-10");
  assert.equal(dau.chartSnapshot.dayBeforeValue, 11200);
  assert.equal(dau.snapshot.currentDate, "2026-08-17");
  assert.equal(dau.snapshot.currentValue, 14208);
  assert.equal(dau.snapshot.comparisonDate, "2026-08-10");
  assert.equal(dau.snapshot.comparisonValue, 11200);
  assert.equal(dau.snapshot.wowChange, (14208 - 11200) / 11200 * 100);
  assert.equal(dauFetchCount, 1, "DAU current and WoW comparison must reuse one Chart pull");

  const newUsers = await fetchStandardChartMetric(env, "New_Users", {
    startDate: "2026-08-10", endDate: "2026-08-11",
  });
  assert.equal(newUsers.snapshot.chartId, "odptyaey");
  assert.equal(newUsers.snapshot.metricVersion, "new-users.amplitude-chart-odptyaey.daily-uniques.wow.v4");
  assert.equal(newUsers.snapshot.currentDate, "2026-08-11");
  assert.equal(newUsers.snapshot.currentValue, 1139);
  assert.equal(newUsers.snapshot.comparisonDate, "2026-08-04");
  assert.equal(newUsers.snapshot.comparisonValue, 690);
  assert.equal(newUsers.snapshot.wowChange, (1139 - 690) / 690 * 100);
  assert.equal(newUsersFetchCount, 1, "New Users current and WoW comparison must reuse one Chart /query response");

  const revenue = await fetchStandardChartMetric(env, "Daily_Revenue", {
    startDate: "2026-08-16", endDate: "2026-08-17",
  });
  assert.equal(revenue.valuesByDate?.["2026-08-17"], 409.59);
  assert.equal(revenue.chartSnapshot.comparisonKind, "WoW");
  assert.equal(revenue.chartSnapshot.dayBefore, "2026-08-10");
  assert.equal(revenue.snapshot.comparisonValue, 299.7);
  assert.match(revenue.snapshot.metricVersion, /xqmzi8cs/);
});

test("Chart requests retry a transient 429 and still use the formal saved Chart", async (t) => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response('{"error":"rate limited"}', {
        status: 429,
        headers: { "retry-after": "0", "content-type": "application/json" },
      });
    }
    return csvResponse([
      '"\tDaily Revenue (purchase_completed × $9.99)"',
      '"\tTotals"',
      '"\tSegment","\t2026-08-10","\t2026-08-11","\t2026-08-12","\t2026-08-13","\t2026-08-14","\t2026-08-15","\t2026-08-16","\t2026-08-17"',
      '"\tAll Users","30","31","32","33","34","35","36","41"',
    ].join("\n"));
  };

  const result = await fetchStandardChartMetric(env, "Daily_Revenue", {
    startDate: "2026-08-17",
    endDate: "2026-08-17",
  });
  assert.equal(attempts, 2);
  assert.equal(result.snapshot.currentValue, 409.59);
});

test("Retention standard function returns exact overall/combined Chart JSON numerator/outof/rate", async (t) => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input) => {
    requestedUrls.push(String(input));
    return new Response(JSON.stringify({
    data: {
      series: [{
        dates: ["Aug 02, 2026", "Aug 09, 2026"],
        values: {
          "Aug 02, 2026": [
            { count: 9000, outof: 9000, incomplete: false },
            { count: 9000, outof: 9000, incomplete: false },
            { count: 6300, outof: 9000, incomplete: false },
            { count: 6200, outof: 9000, incomplete: false },
            { count: 6100, outof: 9000, incomplete: false },
            { count: 6000, outof: 9000, incomplete: false },
            { count: 5900, outof: 9000, incomplete: false },
            { count: 5800, outof: 9000, incomplete: false },
            { count: 5700, outof: 9000, incomplete: false },
          ],
          "Aug 09, 2026": [
            { count: 10156, outof: 10156, incomplete: false },
            { count: 10156, outof: 10156, incomplete: false },
            { count: 7951, outof: 10156, incomplete: false },
            { count: 7622, outof: 10156, incomplete: false },
            { count: 7499, outof: 10156, incomplete: false },
            { count: 6607, outof: 10156, incomplete: false },
            { count: 3497, outof: 10156, incomplete: false },
            { count: 3404, outof: 10156, incomplete: false },
            { count: 6819, outof: 10156, incomplete: false },
          ],
        },
        combined: [
          { count: 40541, outof: 40541, incomplete: false },
          { count: 40541, outof: 40541, incomplete: false },
          { count: 20815, outof: 39430, incomplete: false },
          {},
          { count: 18282, outof: 35320, incomplete: false },
          {}, {}, {},
          { count: 14169, outof: 30389, incomplete: false },
        ],
      }, {
        dates: [],
        values: {},
        combined: [{ count: 1, outof: 1, incomplete: false }],
      }],
      seriesMeta: [
        { segmentIndex: 0, eventIndex: 0 },
        { segmentIndex: 1, eventIndex: 0 },
      ],
    },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const result = await fetchStandardChartMetric(env, "New_User_Retention");
  assert.equal(requestedUrls.length, 1);
  assert.match(requestedUrls[0], /amplitude\.com\/api\/3\/chart\/lthx47q8\/query/);
  assert.deepEqual(result.retention?.points.D3, {
    numerator: 18282,
    denominator: 35320,
    rate: 18282 / 35320,
    currentValue: 18282 / 35320,
    mature: true,
    wowCurrentNumerator: 7499,
    wowCurrentDenominator: 10156,
    wowCurrentRate: 7499 / 10156,
    comparisonNumerator: 6100,
    comparisonDenominator: 9000,
    comparisonRate: 6100 / 9000,
    comparisonValue: 6100 / 9000,
    comparisonMature: true,
    wowChange: ((7499 / 10156) - (6100 / 9000)) * 100,
    wowChangePp: ((7499 / 10156) - (6100 / 9000)) * 100,
  });
  assert.equal(result.snapshot.retention?.scope, "overall-combined");
  assert.deepEqual(result.snapshot.retention?.currentPeriod, {
    startDate: "2026-08-02",
    endDate: "2026-08-09",
  });
  assert.equal(result.snapshot.valueScope, "overall-combined");
  assert.equal(result.snapshot.wowScope, "single-cohort-week-over-week");
  assert.equal(result.snapshot.retention?.valueScope, "overall-combined");
  assert.equal(result.snapshot.retention?.wowScope, "single-cohort-week-over-week");
  assert.equal(result.snapshot.retention?.overallComparisonAvailability, "unavailable");
  assert.equal(result.snapshot.retention?.currentCohort, "2026-08-09");
  assert.equal(result.snapshot.retention?.comparisonCohort, "2026-08-02");
  assert.equal(result.snapshot.completeness, "complete");
  assert.equal(result.snapshot.validation.status, "passed");
  assert.equal(result.chartSnapshot.changePct, ((7951 / 10156) - (6300 / 9000)) * 100);
  assert.match(result.chartSnapshot.dayBefore ?? "", /2026-08-09 cohort vs 2026-08-02 cohort/);
  assert.equal(result.chartSnapshot.comparisonKind, "WoW");
});

test("Retention fails closed when the saved Chart contains multiple return events", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const series = {
    dates: [],
    values: {},
    combined: [{ count: 1, outof: 1, incomplete: false }],
  };
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: {
      series: [series, series],
      seriesMeta: [
        { segmentIndex: 0, eventIndex: 0 },
        { segmentIndex: 0, eventIndex: 1 },
      ],
    },
  }), { status: 200, headers: { "content-type": "application/json" } });

  await assert.rejects(
    () => fetchStandardChartMetric(env, "New_User_Retention"),
    /retention JSON structure changed/,
  );
});

test("Chart structure changes fail closed", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => csvResponse('"unexpected","shape"');
  await assert.rejects(
    () => fetchStandardChartMetric(env, "Purchase_Users", {
      startDate: "2026-08-16", endDate: "2026-08-17",
    }),
    /structure changed/,
  );
});

test("Calendar-day DAU fails closed if the formal Chart enables smoothing", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: {
      series: [[{ value: 100 }, { value: 110 }]],
      xValues: ["2026-08-10", "2026-08-17"],
      seriesMeta: [{ segmentIndex: 0, eventIndex: 0 }],
    },
    transformationIds: ["rolling-average"],
  }), { status: 200, headers: { "content-type": "application/json" } });

  await assert.rejects(
    () => fetchStandardChartMetric(env, "DAU", { startDate: "2026-08-10", endDate: "2026-08-17" }),
    /unexpected smoothing\/transformation/,
  );
});

test("Calendar-day DAU fails closed instead of selecting an older available date", async (t) => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({
      data: {
        series: [[11000, 11100, 11200, 11300, 11400, 11500, 11600, 12000].map((value) => ({ value }))],
        xValues: ["2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14", "2026-08-15", "2026-08-16", "2026-08-17", "2026-08-18"],
        seriesMeta: [{ segmentIndex: 0, eventIndex: 0 }],
      },
      transformationIds: [],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  await assert.rejects(
    () => fetchStandardChartMetric(env, "DAU", { endDate: "2026-08-19" }),
    /outside Chart coverage .*2026-08-18/,
  );
  assert.equal(fetchCount, 1);
});

test("Retention fails closed when an overall/combined requested day is incomplete", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const matureCells = Array.from({ length: 9 }, () => ({ count: 80, outof: 100, incomplete: false }));
  const immatureCombined = matureCells.map((cell) => ({ ...cell }));
  immatureCombined[8] = { count: 0, outof: 100, incomplete: true };
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: {
      series: [{
        dates: ["Aug 02, 2026", "Aug 09, 2026"],
        values: {
          "Aug 02, 2026": matureCells,
          "Aug 09, 2026": matureCells,
        },
        combined: immatureCombined,
      }],
      seriesMeta: [{ segmentIndex: 0, eventIndex: 0 }],
    },
  }), { status: 200, headers: { "content-type": "application/json" } });

  await assert.rejects(
    () => fetchStandardChartMetric(env, "New_User_Retention"),
    /overall combined D7 is incomplete/,
  );
});
