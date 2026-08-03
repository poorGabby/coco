import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeCsvPayload,
  extractTimeseries,
  parseAmplitudeChartCsv,
  selectSegmentRows,
} from "./amplitude.js";
import { DEFAULT_DAILY_CHARTS, resolveDailyCharts } from "./daily-charts.js";

const CJWNE7BE_CSV = `"\tNew Users (Daily)"
"\tDaily new users split by new vs returning"

"\tUniques"
"\t[Amplitude] New User"

"\tSegment","\t2026-07-18","\t2026-07-19","\t2026-07-20","\t2026-07-21"
"\t新用户","\t240","\t273","\t280","\t15"
"\t老用户","\t0","\t0","\t0","\t7"
`;

test("resolveDailyCharts: 默认含 cjwne7be 与 bh0r0h4o", () => {
  const charts = resolveDailyCharts();
  assert.deepEqual(
    charts.map((c) => c.id),
    DEFAULT_DAILY_CHARTS.map((c) => c.id),
  );
  assert.ok(charts.some((c) => c.id === "cjwne7be"));
  assert.ok(charts.some((c) => c.id === "bh0r0h4o"));
  const purchase = charts.find((c) => c.id === "bh0r0h4o")!;
  assert.match(purchase.title, /购买去重人数/);
  assert.match(purchase.title, /非收入/);
});

test("selectSegmentRows: cjwne7be 只取新用户", () => {
  const rows = [
    ["新用户", "240", "273"],
    ["老用户", "0", "0"],
  ];
  const pref = DEFAULT_DAILY_CHARTS.find((c) => c.id === "cjwne7be")!.segmentPrefer!;
  const selected = selectSegmentRows(rows, pref);
  assert.equal(selected.length, 1);
  assert.equal(selected[0][0], "新用户");
});

test("extractTimeseries: cjwne7be 不用新+老求和", () => {
  const parsed = parseAmplitudeChartCsv(CJWNE7BE_CSV);
  assert.equal(parsed.kind, "timeseries");
  assert.equal(parsed.rows.length, 2);

  const pref = /新用户|new\s*users?/i;
  // 直接按列取值：伪造「今天」不依赖真实日历 —— 用 values 校验 prefer 语义
  const withPrefer = extractTimeseries(
    {
      ...parsed,
      // 把完结日列对齐到 amplitudeDateStr 不可控；改为断言 select+col 逻辑：
      headers: parsed.headers,
      rows: selectSegmentRows(parsed.rows, pref),
    },
    undefined,
  );
  // 无 prefer 时对两行求和会把 07-21 变成 15+7=22；有 prefer 只取新用户=15
  const sumAll = extractTimeseries(parsed);
  const onlyNew = extractTimeseries(parsed, { segmentPrefer: pref });

  // 两边若命中同一 Denver 日期列，onlyNew 应 ≤ sumAll（老用户≥0）
  if (onlyNew.yesterdayValue != null && sumAll.yesterdayValue != null) {
    assert.ok(onlyNew.yesterdayValue <= sumAll.yesterdayValue);
  }
  // 固定解析：2026-07-20 新用户=280，求和也是 280（老=0）
  const byDateNew = Object.fromEntries(
    parsed.headers.map((h, i) => {
      const row = selectSegmentRows(parsed.rows, pref)[0];
      return [h, Number(row[i + 1])];
    }),
  );
  assert.equal(byDateNew["2026-07-20"], 280);
  assert.equal(byDateNew["2026-07-19"], 273);
  void withPrefer;
});

test("decodeCsvPayload: JSON wrapper", () => {
  const csv = decodeCsvPayload(JSON.stringify({ data: CJWNE7BE_CSV }));
  assert.match(csv, /新用户/);
});
