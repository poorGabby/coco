/**
 * 自动核查脚本：日报 vs Amplitude 实际值
 * 用法: npx tsx verify-daily.ts [--watch]
 */
import { amplitudeDateStr } from "./src/amplitude.js";
import { loadEnv } from "./src/env.js";
import { fetchStandardChartMetric } from "./src/standard-chart-metrics.js";

const REPORT_URL = process.env.REPORT_URL || "http://127.0.0.1:8789/hermes/report";
const env = loadEnv();

function parseRow(report: string, pattern: RegExp) {
  const m = report.match(pattern);
  if (!m) return null;
  return { current: m[1].trim(), comparison: m[2].trim(), wow: m[3].trim() };
}

async function runCheck() {
  const currentDate = amplitudeDateStr(-1);
  const comparisonDate = amplitudeDateStr(-8);

  // 1. Fixed formal Amplitude Chart snapshots
  const [dau, newUsers, revenue] = await Promise.all([
    fetchStandardChartMetric(env, "DAU", { startDate: comparisonDate, endDate: currentDate }),
    fetchStandardChartMetric(env, "New_Users", { startDate: comparisonDate, endDate: currentDate }),
    fetchStandardChartMetric(env, "Daily_Revenue", { startDate: comparisonDate, endDate: currentDate }),
  ]);

  const dauY = dau.snapshot.currentValue ?? null;
  const dauDb = dau.snapshot.comparisonValue ?? null;
  const newY = newUsers.snapshot.currentValue ?? null;
  const newDb = newUsers.snapshot.comparisonValue ?? null;
  const revY = revenue.snapshot.currentValue ?? null;
  const revDb = revenue.snapshot.comparisonValue ?? null;

  const fmt = (v: number | null) => v != null ? String(v) : "N/A";
  const pctFmt = (curr: number, prev: number) => {
    if (prev === 0) return "N/A";
    return (curr >= prev ? "+" : "") + ((curr - prev) / prev * 100).toFixed(1) + "%";
  };

  // 2. Fetch report
  let report = "";
  try {
    const res = await fetch(REPORT_URL);
    report = await res.text();
  } catch (e: any) {
    console.error("❌ 日报端点不可达:", e.message);
    return false;
  }

  // 3. Check
  const dauRow = parseRow(report, /\| DAU.*? \| ([^|]+) \| ([^|]+) \| ([^|]+)/);
  const newRow = parseRow(report, /\| New Users.*? \| ([^|]+) \| ([^|]+) \| ([^|]+)/);
  const revRow = parseRow(report, /\| Daily Revenue.*? \| ([^|]+) \| ([^|]+) \| ([^|]+)/);

  const checks: Array<{ label: string; bot: string; truth: string }> = [];
  if (dauRow) {
    checks.push({ label: "DAU current", bot: dauRow.current, truth: fmt(dauY) });
    checks.push({ label: "DAU comparison", bot: dauRow.comparison, truth: fmt(dauDb) });
    checks.push({ label: "DAU WoW", bot: dauRow.wow, truth: dauY != null && dauDb != null ? `WoW ${pctFmt(dauY, dauDb)}` : "WoW N/A" });
  }
  if (newRow) {
    checks.push({ label: "New Users current", bot: newRow.current, truth: fmt(newY) });
    checks.push({ label: "New Users comparison", bot: newRow.comparison, truth: fmt(newDb) });
    checks.push({ label: "New Users WoW", bot: newRow.wow, truth: newY != null && newDb != null ? `WoW ${pctFmt(newY, newDb)}` : "WoW N/A" });
  }
  if (revRow) {
    checks.push({ label: "Revenue current", bot: revRow.current, truth: revY?.toFixed(2) ?? "N/A" });
    checks.push({ label: "Revenue WoW", bot: revRow.wow, truth: revY != null && revDb != null ? `WoW ${pctFmt(revY, revDb)}` : "WoW N/A" });
  }

  const ts = new Date().toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  console.log("\n" + ts + " | Dawson current=" + currentDate + "  comparison=" + comparisonDate);
  let pass = 0, fail = 0;
  for (const c of checks) {
    const ok = c.bot === c.truth;
    if (ok) pass++; else fail++;
    console.log((ok ? " ✅" : " ❌") + " " + c.label.padEnd(24) + " 日报=" + (c.bot || "?").padEnd(12) + " API=" + c.truth);
  }
  console.log("   " + pass + "/" + (pass + fail) + " 一致" + (fail > 0 ? " ❌" : " ✅"));
  return fail === 0;
}

async function main() {
  const watch = process.argv.includes("--watch");

  if (watch) {
    console.log("🔁 每 30 秒核查一次 (Ctrl+C 停止)\n");
    while (true) {
      await runCheck();
      await new Promise(r => setTimeout(r, 30_000));
    }
  }

  const ok = await runCheck();
  process.exit(ok ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
