import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeCsvPayload,
  extractTimeseries,
  parseAmplitudeChartCsv,
} from "./amplitude.js";
import { DEFAULT_DAILY_CHARTS, resolveDailyCharts } from "./daily-charts.js";

const DAILY_NEW_USERS_CSV = `"\tNew Users (Daily)"
"\tDaily new users over the last 30 days."

"\tUniques"
"\t[Amplitude] New User"

"\tSegment","\t2026-07-18","\t2026-07-19","\t2026-07-20","\t2026-07-21"
"\tNone","\t240","\t273","\t280","\t15"
`;

test("resolveDailyCharts: 默认含 America/Dawson 的 New Users 与 Purchase Users 图表", () => {
  const charts = resolveDailyCharts();
  assert.deepEqual(
    charts.map((c) => c.id),
    DEFAULT_DAILY_CHARTS.map((c) => c.id),
  );
  assert.ok(charts.some((c) => c.id === "odptyaey"));
  assert.ok(charts.some((c) => c.id === "7n9n6eez"));
  const newUserRetention = charts.find((c) => c.role === "retention_new_user")!;
  assert.equal(newUserRetention.id, "lthx47q8");
  assert.equal(newUserRetention.title, "New User Retention");
  const dau = charts.find((c) => c.role === "dau")!;
  assert.equal(dau.id, "ilhu9t17");
  assert.equal(dau.title, "Daily Active Users (DAU) — Calendar Day");
  const purchase = charts.find((c) => c.id === "7n9n6eez")!;
  assert.match(purchase.title, /购买去重人数/);
  assert.match(purchase.title, /非收入/);
});

test("extractTimeseries: New Users Dawson chart reads its single Daily Uniques row", () => {
  const parsed = parseAmplitudeChartCsv(DAILY_NEW_USERS_CSV);
  assert.equal(parsed.kind, "timeseries");
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0][0], "None");
  void extractTimeseries(parsed);
  const byDateNew = Object.fromEntries(
    parsed.headers.map((header, index) => [header, Number(parsed.rows[0][index + 1])]),
  );
  assert.equal(byDateNew["2026-07-20"], 280);
  assert.equal(byDateNew["2026-07-19"], 273);
});

test("decodeCsvPayload: JSON wrapper", () => {
  const csv = decodeCsvPayload(JSON.stringify({ data: DAILY_NEW_USERS_CSV }));
  assert.match(csv, /Daily new users/);
});
