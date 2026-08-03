/**
 * 自动核查脚本：日报 vs Amplitude 实际值
 * 用法: npx tsx verify-daily.ts [--watch]
 */
import { AmplitudeSkill } from "./src/amplitude-skill.js";
import { amplitudeDateStr } from "./src/amplitude.js";

const API = process.env.AMPLITUDE_API_KEY?.trim();
const SEC = process.env.AMPLITUDE_SECRET_KEY?.trim();
if (!API || !SEC) {
  throw new Error("AMPLITUDE_API_KEY and AMPLITUDE_SECRET_KEY are required");
}
const REPORT_URL = process.env.REPORT_URL || "http://127.0.0.1:8789/hermes/report";
const skill = new AmplitudeSkill(API, SEC);

function parseRow(report: string, pattern: RegExp) {
  const m = report.match(pattern);
  if (!m) return null;
  return { yesterday: m[1].trim(), dayBefore: m[2].trim(), dod: m[3].trim() };
}

async function runCheck() {
  const yesterday = amplitudeDateStr(-1);
  const dayBefore = amplitudeDateStr(-2);
  const startDate = amplitudeDateStr(-7);

  // 1. Amplitude ground truth
  const [dau, newUsers, purchases] = await Promise.all([
    skill.execute({ metricName: "DAU", startDate, endDate: yesterday }),
    skill.execute({ metricName: "New_Users", startDate, endDate: yesterday }),
    skill.execute({ metricName: "Purchase_Completed", startDate, endDate: yesterday, groupByProp: "product", groupByType: "event" }),
  ]);

  const dauY = dau.segments["All"]?.dailyTrend[yesterday] ?? null;
  const dauDb = dau.segments["All"]?.dailyTrend[dayBefore] ?? null;
  const newY = newUsers.segments["All"]?.dailyTrend[yesterday] ?? null;
  const newDb = newUsers.segments["All"]?.dailyTrend[dayBefore] ?? null;
  const pur999Y = purchases.segments["9.99"]?.dailyTrend[yesterday] ?? 0;
  const pur699Y = purchases.segments["6.99"]?.dailyTrend[yesterday] ?? 0;
  const pur999Db = purchases.segments["9.99"]?.dailyTrend[dayBefore] ?? 0;
  const pur699Db = purchases.segments["6.99"]?.dailyTrend[dayBefore] ?? 0;
  const revY = pur999Y * 9.99 + pur699Y * 6.99;
  const revDb = pur999Db * 9.99 + pur699Db * 6.99;

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
    checks.push({ label: "DAU yesterday", bot: dauRow.yesterday, truth: fmt(dauY) });
    checks.push({ label: "DAU dayBefore", bot: dauRow.dayBefore, truth: fmt(dauDb) });
    checks.push({ label: "DAU DoD", bot: dauRow.dod, truth: dauY != null && dauDb != null ? pctFmt(dauY, dauDb) : "N/A" });
  }
  if (newRow) {
    checks.push({ label: "New Users yesterday", bot: newRow.yesterday, truth: fmt(newY) });
    checks.push({ label: "New Users dayBefore", bot: newRow.dayBefore, truth: fmt(newDb) });
    checks.push({ label: "New Users DoD", bot: newRow.dod, truth: newY != null && newDb != null ? pctFmt(newY, newDb) : "N/A" });
  }
  if (revRow) {
    checks.push({ label: "Revenue yesterday", bot: revRow.yesterday, truth: revY.toFixed(2) });
    checks.push({ label: "Revenue DoD", bot: revRow.dod, truth: pctFmt(revY, revDb) });
  }

  const ts = new Date().toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  console.log("\n" + ts + " | Denver yesterday=" + yesterday + "  dayBefore=" + dayBefore);
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
