import { test } from "node:test";
import assert from "node:assert/strict";
import type { PurchaseUsersTable } from "../amplitude.js";
import {
  createFetchAmplitudeMetric,
  createFetchStripeRevenue,
  createFetchPurchaseUsers,
  addDays,
  daysBetween,
  type AmplitudeExecutor,
  type StripeRevenueDay,
} from "./tool-impls.js";

const FIXED_TODAY = "2026-07-13"; // 假定最近完结日
const FIXED_NOW = new Date("2026-07-14T12:00:00.000Z");

/** 造一个不联网的 executor：New_Users / All 段，含区间外的 7/05 与 7/13 干扰值。 */
function fakeExecutor(overrides?: Partial<Record<string, Record<string, number>>>): AmplitudeExecutor {
  const dailyTrend: Record<string, number> = {
    "2026-07-05": 100,
    "2026-07-06": 10,
    "2026-07-07": 20,
    "2026-07-08": 30,
    "2026-07-09": 40,
    "2026-07-10": 50,
    "2026-07-11": 60,
    "2026-07-12": 70,
    "2026-07-13": 999,
  };
  const dates = Object.keys(dailyTrend);
  return async () => ({
    dates,
    segments: {
      All: { dailyTrend, periodTotalUniques: 0 },
      ...(overrides
        ? Object.fromEntries(
            Object.entries(overrides).map(([k, v]) => [k, { dailyTrend: v!, periodTotalUniques: 0 }]),
          )
        : {}),
    },
  });
}

test("对显式区间 7/6–7/12 求和，排除区间外日期", async () => {
  const run = createFetchAmplitudeMetric({
    execute: fakeExecutor(),
    today: () => FIXED_TODAY,
    now: () => FIXED_NOW,
  });
  const res = await run({ metricName: "New_Users", startDate: "2026-07-06", endDate: "2026-07-12" });

  assert.equal(res.grandSum, 10 + 20 + 30 + 40 + 50 + 60 + 70); // 280
  const all = res.series.find((s) => s.segment === "All")!;
  assert.equal(all.sum, 280);
  assert.ok(!("2026-07-05" in all.byDate), "应排除区间前一天");
  assert.ok(!("2026-07-13" in all.byDate), "应排除区间后一天");
  assert.equal(res.groupBy, null);
  assert.equal(res.snapshot.contractVersion, "coco-data-contract.v1");
  assert.equal(res.snapshot.metricVersion, "amplitude.New_Users.v1");
  assert.equal(res.snapshot.tool, "fetch_amplitude_metric");
  assert.deepEqual(res.snapshot.coverage, { startDate: "2026-07-06", endDate: "2026-07-12" });
  assert.equal(res.snapshot.pulledAt, FIXED_NOW.toISOString());
  assert.equal(res.snapshot.validation.status, "passed");
});

test("省略日期时默认最近 7 个完结日（endDate=today, start=today-6）", async () => {
  const run = createFetchAmplitudeMetric({ execute: fakeExecutor(), today: () => FIXED_TODAY });
  const res = await run({ metricName: "New_Users" });

  assert.equal(res.endDate, "2026-07-13");
  assert.equal(res.startDate, "2026-07-07");
  // 07-07..07-13 = 20+30+40+50+60+70+999
  assert.equal(res.grandSum, 20 + 30 + 40 + 50 + 60 + 70 + 999);
});

test("按 product 分组产生多段 series", async () => {
  const exec = fakeExecutor({
    "9.99": { "2026-07-12": 14, "2026-07-13": 5 },
    "6.99": { "2026-07-12": 4, "2026-07-13": 3 },
  });
  const run = createFetchAmplitudeMetric({ execute: exec, today: () => FIXED_TODAY });
  const res = await run({
    metricName: "Purchase_Completed",
    startDate: "2026-07-12",
    endDate: "2026-07-12",
    groupByProp: "product",
  });

  assert.equal(res.groupBy, "product");
  const seg999 = res.series.find((s) => s.segment === "9.99")!;
  const seg699 = res.series.find((s) => s.segment === "6.99")!;
  assert.equal(seg999.sum, 14);
  assert.equal(seg699.sum, 4);
});

test("未知指标被拒绝", async () => {
  const run = createFetchAmplitudeMetric({ execute: fakeExecutor(), today: () => FIXED_TODAY });
  await assert.rejects(() => run({ metricName: "Nonexistent_Metric" }), /Unknown metric/);
});

test("非法日期格式被拒绝", async () => {
  const run = createFetchAmplitudeMetric({ execute: fakeExecutor(), today: () => FIXED_TODAY });
  await assert.rejects(
    () => run({ metricName: "New_Users", startDate: "2026/07/06", endDate: "2026-07-12" }),
    /startDate must be YYYY-MM-DD/,
  );
});

test("start 晚于 end 被拒绝", async () => {
  const run = createFetchAmplitudeMetric({ execute: fakeExecutor(), today: () => FIXED_TODAY });
  await assert.rejects(
    () => run({ metricName: "New_Users", startDate: "2026-07-12", endDate: "2026-07-06" }),
    /is after endDate/,
  );
});

test("endDate 晚于最近完结日时自动 clamp 并记 notes", async () => {
  const run = createFetchAmplitudeMetric({ execute: fakeExecutor(), today: () => FIXED_TODAY });
  const res = await run({ metricName: "New_Users", endDate: "2026-07-14" });
  assert.equal(res.endDate, FIXED_TODAY);
  assert.ok(res.notes?.some((n) => n.includes("自动改为")));
  assert.equal(res.snapshot.validation.status, "warning");
  assert.equal(res.snapshot.input.endDate, FIXED_TODAY);
});

test("超过最大区间被拒绝", async () => {
  const run = createFetchAmplitudeMetric({
    execute: fakeExecutor(),
    today: () => FIXED_TODAY,
    maxRangeDays: 7,
  });
  await assert.rejects(
    () => run({ metricName: "New_Users", startDate: "2026-06-01", endDate: "2026-07-13" }),
    /exceeds max/,
  );
});

test("日期算术 helper", () => {
  assert.equal(addDays("2026-07-13", -6), "2026-07-07");
  assert.equal(addDays("2026-07-31", 1), "2026-08-01");
  assert.equal(daysBetween("2026-07-06", "2026-07-12"), 6);
});

// ── fetch_daily_revenue（Stripe）────────────────────────────────────

function fakeStripeRange(): (s: string, e: string) => Promise<Map<string, StripeRevenueDay>> {
  const all: Record<string, StripeRevenueDay> = {
    "2026-07-11": { date: "2026-07-11", revenue: 19.98, count: 2, byPrice: { "9.99": 2 }, refunded: 0 },
    "2026-07-06": { date: "2026-07-06", revenue: 19.98, count: 2, byPrice: { "9.99": 2 }, refunded: 0 },
    "2026-07-12": { date: "2026-07-12", revenue: 39.96, count: 4, byPrice: { "9.99": 4 }, refunded: 0 },
    "2026-07-13": { date: "2026-07-13", revenue: 167.82, count: 15, byPrice: { "9.99": 14, "6.99": 1 }, refunded: 0 },
  };
  return async (start, end) => {
    const m = new Map<string, StripeRevenueDay>();
    for (let d = start; d <= end; d = addDays(d, 1)) {
      m.set(d, all[d] ?? { date: d, revenue: 0, count: 0, byPrice: {}, refunded: 0 });
    }
    return m;
  };
}

test("fetchStripeRevenue: 默认单日 + 收入 WoW", async () => {
  const run = createFetchStripeRevenue({
    fetchRange: fakeStripeRange(),
    today: () => "2026-07-13",
    now: () => FIXED_NOW,
  });
  const res = await run({});
  assert.equal(res.endDate, "2026-07-13");
  assert.equal(res.totalRevenue, 167.82);
  // 07-06=19.98 → WoW = (167.82-19.98)/19.98 = 739.9%
  assert.equal(res.wowPct, 739.9);
  assert.match(res.source, /Stripe/);
  assert.deepEqual(res.perDay[0].byProduct, {}, "Stripe charge count must not be mislabeled as unique users");
  assert.equal(res.perDay[0].chargeCount, 15);
  assert.equal(res.perDay[0].grossRevenue, 167.82);
  assert.equal(res.snapshot.metricVersion, "daily-revenue.stripe-charge-date-net.v2");
  assert.equal(res.snapshot.currentValue, 167.82);
  assert.equal(res.snapshot.comparisonValue, 19.98);
  assert.equal(res.snapshot.completeness, "complete");
  assert.equal(res.chartSnapshot?.yesterdayValue, 167.82);
  assert.equal(res.chartSnapshot?.dayBeforeValue, 19.98);
});

test("fetchStripeRevenue: 区间求和", async () => {
  const run = createFetchStripeRevenue({ fetchRange: fakeStripeRange(), today: () => "2026-07-13" });
  const res = await run({ startDate: "2026-07-11", endDate: "2026-07-13" });
  assert.equal(res.totalRevenue, 227.76);
  assert.equal(res.perDay.length, 3);
});

test("fetchStripeRevenue: endDate 晚于完结日时 clamp", async () => {
  const run = createFetchStripeRevenue({ fetchRange: fakeStripeRange(), today: () => "2026-07-13" });
  const res = await run({ endDate: "2026-07-14" });
  assert.equal(res.endDate, "2026-07-13");
  assert.ok(res.notes?.some((n) => n.includes("自动改为")));
});

test("fetchStripeRevenue: 成功读取的零收入日仍是完整数据", async () => {
  const run = createFetchStripeRevenue({ fetchRange: fakeStripeRange(), today: () => "2026-07-21" });
  const res = await run({});
  assert.equal(res.totalRevenue, 0);
  assert.equal(res.snapshot.currentValue, 0);
  assert.equal(res.snapshot.completeness, "complete");
  assert.equal(res.wowPct, null);
  assert.ok(res.notes?.some((note) => note.includes("无成交入账")));
});

// ── fetch_purchase_users（chart 7n9n6eez 同源）────────────────────────

const fakeUsersTable: PurchaseUsersTable = {
  dates: ["2026-07-05", "2026-07-06", "2026-07-11", "2026-07-12", "2026-07-13"],
  byDate: { "2026-07-05": 0, "2026-07-06": 5, "2026-07-11": 0, "2026-07-12": 4, "2026-07-13": 15 },
};

test("fetchPurchaseUsers: 默认单日 + WoW", async () => {
  const run = createFetchPurchaseUsers({
    fetchTable: async () => fakeUsersTable,
    today: () => "2026-07-13",
    now: () => FIXED_NOW,
  });
  const res = await run({});
  assert.equal(res.endDate, "2026-07-13");
  assert.equal(res.perDay.length, 1);
  assert.equal(res.perDay[0].users, 15);
  assert.equal(res.sumOfDaily, 15);
  assert.equal(res.wowPct, 200); // (15-5)/5
  assert.equal(res.snapshot.metricVersion, "purchase_users.amplitude-chart-7n9n6eez.v2");
  assert.equal(res.snapshot.completeness, "complete");
});

test("fetchPurchaseUsers: 上周同日为 0 → WoW 为 N/A(null)", async () => {
  const run = createFetchPurchaseUsers({
    fetchTable: async () => fakeUsersTable,
    today: () => "2026-07-13",
  });
  const res = await run({ endDate: "2026-07-12" }); // 上周同日 07-05 = 0
  assert.equal(res.perDay[0].users, 4);
  assert.equal(res.wowPct, null);
});

test("fetchPurchaseUsers: 区间求和 + 跨日提示", async () => {
  const run = createFetchPurchaseUsers({
    fetchTable: async () => fakeUsersTable,
    today: () => "2026-07-13",
  });
  const res = await run({ startDate: "2026-07-11", endDate: "2026-07-13" });
  assert.equal(res.sumOfDaily, 19); // 0+4+15
  assert.ok(res.notes?.some((n) => n.includes("重复计数")));
});

test("fetchPurchaseUsers: 窗口外日期给出缺列提示", async () => {
  const run = createFetchPurchaseUsers({
    fetchTable: async () => fakeUsersTable,
    today: () => "2026-07-13",
  });
  const res = await run({ startDate: "2026-07-09", endDate: "2026-07-13" });
  assert.ok(res.notes?.some((n) => n.includes("7n9n6eez") && n.includes("2026-07-09")));
  assert.equal(res.snapshot.completeness, "partial");
  assert.equal(res.snapshot.validation.status, "warning");
});

test("fetchPurchaseUsers: endDate 晚于完结日时 clamp", async () => {
  const run = createFetchPurchaseUsers({
    fetchTable: async () => fakeUsersTable,
    today: () => "2026-07-13",
  });
  const res = await run({ endDate: "2026-07-14" });
  assert.equal(res.endDate, "2026-07-13");
  assert.ok(res.notes?.some((n) => n.includes("自动改为")));
});
