/**
 * 受控 Agent 运行器。
 *
 * 职责（与计划「防割裂」一致）：
 * - system prompt = ask.ts 的行为手册解析（飞书优先）+ constraints.ts 的口径约束 + 工具说明；
 * - 知识库上下文复用 ask.ts 的 buildWikiContext（内存全文检索，保留出处）；
 * - Amplitude 数据改为按需工具调用（fetch_amplitude_metric / fetch_purchase_users /
 *   fetch_daily_revenue），修复「只读飞书不结合数据」；
 * - 有界循环与回退交由 llm.ts 的 generateWithTools 处理，超限抛错由 index.ts 回退 askQuestion。
 *
 * 已由 index.ts 在 `HERMES_AGENT_ENABLED` 开关下调用（关掉即回退 askQuestion）。
 */
import { amplitudeDateStr } from "../amplitude.js";
import { buildWikiContext, resolveSystemPrompt, type AskResult } from "../ask.js";
import type { Env } from "../env.js";
import { generateWithTools } from "../llm.js";
import { loadMcpTools, type LoadedMcpTools } from "./mcp/client.js";
import { resolveSkillDoc } from "./skill-doc.js";
import { AGENT_TOOL_DECLARATIONS, buildToolRegistry } from "./tools.js";

/** 默认最多 5 步工具循环，防止失控。 */
export const AGENT_MAX_STEPS = 5;

export interface AgentAnswer {
  question: string;
  answer: string;
  steps: number;
  toolCalls: Array<{ name: string; args: Record<string, unknown>; ok: boolean; error?: string }>;
  wikiSources?: AskResult["wikiSources"];
}

/**
 * 运行受控 Agent 回答一个自由问题。
 * 与 askQuestion 的返回结构保持兼容（question/answer/wikiSources），
 * 便于 Phase 3 在 index.ts 里无缝替换/回退。
 */
export async function runAgentQuestion(
  env: Env,
  question: string,
  history?: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }>,
): Promise<AgentAnswer> {
  const trimmed = question.trim();
  if (!trimmed) throw new Error("question is required");

  const [baseManual, skillDoc, wiki] = await Promise.all([
    resolveSystemPrompt(env),
    resolveSkillDoc(env),
    buildWikiContext(env, trimmed),
  ]);

  const denverToday = amplitudeDateStr(0);
  const denverLastCompleted = amplitudeDateStr(-1);
  const currentYear = denverToday.slice(0, 4);

  const systemPrompt = [
    baseManual,
    "",
    "## 当前时间（用于解析相对 / 不完整日期）",
    `今天（美区 America/Denver）是 ${denverToday}，最近一个完结日是 ${denverLastCompleted}，当前年份是 ${currentYear}。`,
    `用户只给出月/日（如 7/6、7月6日）时，一律按当前年份 ${currentYear} 补全；除非用户明确写出其他年份，禁止使用往年日期。`,
    "多轮对话中若用户追问「每天/明细/来源」等，应沿用上一轮的指标与日期区间，不要擅自改成默认区间。",
    "",
    "## 数据与口径约束",
    skillDoc,
    "",
    "## 工具使用",
    "涉及 Amplitude 数据时必须调用工具获取真实数据后再作答，禁止凭空编造数字。" +
      "传日期必须带完整年份（YYYY-MM-DD）。若工具返回 notes 提示或数值全为 0，多半是日期/年份填错，" +
      "应改用正确日期重试，绝不能直接把 0 当结论。知识库 / 产品说明类问题优先参考下方 Knowledge Base。",
    "",
    "## 工具选择（先判断问题语义，再选对工具/指标；选错会给出错误结论）",
    "- 新增用户 / 新增 / 拉新 / new users → fetch_amplitude_metric(metricName=New_Users)",
    "- 活跃用户 / 日活 / DAU → fetch_amplitude_metric(DAU)；周活 / WAU → WAU",
    "- 多少人购买 / 购买用户数 / 付费用户数 / 购买成功数 / 有多少人付费 → fetch_purchase_users（去重付费人数，与网页 UI/日报同源）",
    "- 收入 / 营收 / revenue / 赚了多少钱 / GMV → fetch_daily_revenue（与日报同源，按单价×分档人数）",
    "  · 三者口径不同、不可混用：fetch_purchase_users 给「完成购买的去重人数」（图表 bh0r0h4o，与 UI 一致）；",
    "    fetch_daily_revenue 给「按 product 分档换算的金额」（图表 xhd4uffg）；两者都属图表引擎口径，与 UI/日报对得上。",
    "    绝不能用 fetch_amplitude_metric 查购买人数（Segmentation API 口径偏低、与 UI 不符），也不能用人数乘单价估收入。",
    "",
    "## 回答要求",
    "- 指标数值只能来自工具（fetch_amplitude_metric / fetch_purchase_users / fetch_daily_revenue）的返回；严禁把 Knowledge Base 里的任何数字当作指标数值。",
    "- 指标类问题：除总数外给出每日（或分组）明细，并说明数据来源（取工具返回的 source：Amplitude、指标名、日期区间、时区 America/Denver）。",
    "- 恰当时主动给出 DoD（最近完结日 vs 前一日；基期为 0 写 N/A）。",
    "- 回答要具体、有分析感，用简洁专业的中文，不要只丢一个孤零零的数字。",
  ].join("\n");

  const hasWiki = !!(wiki.wikiText && wiki.sources?.length);
  const userPrompt = [
    "# Context",
    "",
    ...(hasWiki ? [`## Knowledge Base\n\n${wiki.wikiText}`, ""] : []),
    "## User Question",
    "",
    trimmed,
    "",
    "以上 Knowledge Base 为可参考资料，可能相关也可能无关；需要 Amplitude 数据时请调用工具。",
  ].join("\n");

  // MCP 可插拔数据源（默认关；关闭时下面两行完全等价于现状，不加载任何 MCP）。
  // 任何 MCP 失败都降级为「仅本地工具」，绝不阻断问答。
  let mcp: LoadedMcpTools | null = null;
  if (env.hermesMcpEnabled) {
    try {
      mcp = await loadMcpTools(env);
      if (mcp.connected.length) {
        console.log(`[agent] MCP tools merged from: ${mcp.connected.join(", ")}`);
      }
    } catch (err) {
      console.warn("[agent] MCP load failed, continuing with local tools only:", err);
      mcp = null;
    }
  }

  const tools = mcp ? [...AGENT_TOOL_DECLARATIONS, ...mcp.declarations] : AGENT_TOOL_DECLARATIONS;
  const registry = mcp
    ? { ...buildToolRegistry(env), ...mcp.registry }
    : buildToolRegistry(env);

  try {
    const result = await generateWithTools(env, {
      systemPrompt,
      userPrompt,
      history,
      tools,
      registry,
      maxSteps: AGENT_MAX_STEPS,
    });

    return {
      question: trimmed,
      answer: result.text,
      steps: result.steps,
      toolCalls: result.toolCalls.map((c) => ({ name: c.name, args: c.args, ok: c.ok, error: c.error })),
      wikiSources: wiki.sources?.length ? wiki.sources : undefined,
    };
  } finally {
    if (mcp) await mcp.close();
  }
}
