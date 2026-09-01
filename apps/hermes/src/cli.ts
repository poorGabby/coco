import { loadEnv } from "./env.js";
import { askQuestion } from "./ask.js";
import { fetchStandardMetricSnapshots, generateReport } from "./report.js";

const cmd = process.argv[2];
const rawArgs = process.argv.slice(3);
const dryRun = rawArgs.includes("--dry-run");
const rest = rawArgs.filter((a) => a !== "--dry-run").join(" ").trim();

async function main() {
  const env = loadEnv();

  if (cmd === "test-amplitude") {
    // Retention diagnostics use the same standard /query path as the report.
    const snapshots = await fetchStandardMetricSnapshots(env);
    for (const s of snapshots) {
      const status = s.error ? `ERROR: ${s.error}` : `${s.yesterdayValue} vs ${s.dayBeforeValue}`;
      console.log(`[${s.chartId}] ${s.title} (${s.kind}) → ${status}`);
    }
    return;
  }

  if (cmd === "report") {
    const report = await generateReport(env);
    console.log(report);
    return;
  }

  if (cmd === "ask") {
    const question = rest || "昨天 DAU 为什么跌了？";
    if (dryRun) process.env.HERMES_ASK_DRY_RUN = "1";
    console.log(`问题: ${question}\n`);
    const result = await askQuestion(env, question);
    console.log(result.answer);
    return;
  }

  console.log("Usage:");
  console.log("  tsx src/cli.ts test-amplitude");
  console.log("  tsx src/cli.ts report");
  console.log('  tsx src/cli.ts ask "昨天 DAU 为什么跌了？"');
  console.log("  tsx src/cli.ts ask --dry-run   # 只拉 Amplitude，不调 Gemini");
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
