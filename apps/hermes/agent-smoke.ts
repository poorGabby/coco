import { runAgentQuestion } from "./src/agent/agent-runner.js";
import { loadEnv } from "./src/env.js";

/**
 * 受控 Agent 冒烟测试：直接调 runAgentQuestion，打印回答 + 工具调用轨迹。
 * 用法：
 *   npx tsx agent-smoke.ts                 # 跑默认黄金问题集
 *   npx tsx agent-smoke.ts "你的问题"      # 跑单个问题
 */
const DEFAULTS = [
  "7/6–7/12 new users 一共多少人",
  "最近一天的 DAU 是多少？WoW 怎么样？",
  "版本更新了几次？",
];

const arg = process.argv.slice(2).join(" ").trim();
const questions = arg ? [arg] : DEFAULTS;

const env = loadEnv();
console.log(
  `[smoke] model=${env.geminiModel} agentFlag=${env.hermesAgentEnabled} proxy=${process.env.HTTPS_PROXY ?? "none"}`,
);

for (const q of questions) {
  console.log("\n" + "=".repeat(60));
  console.log("Q:", q);
  const t0 = Date.now();
  try {
    const res = await runAgentQuestion(env, q);
    console.log(`[steps=${res.steps} elapsed=${Date.now() - t0}ms]`);
    if (res.toolCalls.length === 0) {
      console.log("  (no tool calls)");
    }
    for (const c of res.toolCalls) {
      console.log(
        `  tool ${c.name}(${JSON.stringify(c.args)}) -> ${c.ok ? "ok" : "ERR: " + c.error}`,
      );
    }
    if (res.wikiSources?.length) {
      console.log("  wikiSources:", res.wikiSources.map((s) => s.title).join(" | "));
    }
    console.log("A:", res.answer);
  } catch (err) {
    console.error("FAILED:", err instanceof Error ? err.message : String(err));
  }
}
