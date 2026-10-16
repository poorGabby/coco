import type { ChartSnapshot } from "./amplitude.js";
import type { Env } from "./env.js";
import { getDocumentRawContent } from "./feishu.js";
import { generateGeminiReply } from "./llm.js";
import { buildReportMarkdown, fetchStandardMetricSnapshots } from "./report.js";
import { ensureWikiCache, searchFulltext } from "./wiki-cache.js";
import { dailyCohortContext } from "./retention-daily-cohorts.js";

function shanghaiToday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1); // data is for yesterday
  return d.toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });
}

function snapshotToContextLine(s: ChartSnapshot): string {
  if (s.error) {
    return `- [${s.chartId}] ${s.title}: 拉取失败 — ${s.error}`;
  }
  if (s.kind === "retention" && s.snapshot?.retention) {
    const retention = s.snapshot.retention;
    return (["D1", "D3", "D7"] as const).map((day) => {
      const point = retention.points[day];
      if (retention.valueScope === "daily-cohort-per-day") return dailyCohortContext(s.title, day, point);
      const pp = point.wowChangePp;
      const period = retention.currentPeriod
        ? `${retention.currentPeriod.startDate}~${retention.currentPeriod.endDate}`
        : "Last 30 days";
      const wow = pp == null ? "WoW N/A" : `WoW ${pp > 0 ? "+" : ""}${pp.toFixed(2)}pp`;
      const wowCurrent = point.wowCurrentRate == null ? "N/A" : `${(point.wowCurrentRate * 100).toFixed(2)}%`;
      const wowPrevious = point.comparisonRate == null ? "N/A" : `${(point.comparisonRate * 100).toFixed(2)}%`;
      return `- ${s.title} — Day ${day.slice(1)}: 主值 overall/combined (${period}) = ${point.rate == null ? "N/A" : `${(point.rate * 100).toFixed(2)}%`} (${point.numerator}/${point.denominator}); WoW 基础为单日 cohort ${retention.currentCohort}=${wowCurrent} (${point.wowCurrentNumerator}/${point.wowCurrentDenominator}) vs ${retention.comparisonCohort}=${wowPrevious} (${point.comparisonNumerator}/${point.comparisonDenominator}); ${wow}`;
    }).join("\n");
  }
  const parts = [
    `- ${s.title} (chart_id=${s.chartId}, type=${s.kind}, metric=${s.metricLabel})`,
    `  最近一期: ${s.yesterday ?? "—"} = ${s.yesterdayValue ?? "N/A"}`,
  ];
  const comparisonKind = "WoW";
  if (s.dayBefore != null || s.dayBeforeValue != null) {
    parts.push(`  上周同日: ${s.dayBefore ?? "—"} = ${s.dayBeforeValue ?? "N/A"}`);
  }
  if (s.changePct != null) {
    parts.push(`  ${comparisonKind}: ${s.changePct > 0 ? "+" : ""}${s.changePct.toFixed(1)}%`);
  } else if (s.dayBeforeValue != null || s.dayBefore != null) {
    parts.push(`  ${comparisonKind}: N/A`);
  }
  return parts.join("\n");
}

export function buildAmplitudeContext(snapshots: ChartSnapshot[], reportMd: string): string {
  const lines = [
    `数据拉取时间（北京时间）: ${shanghaiToday()}`,
    "",
    "## 日报摘要",
    reportMd,
    "",
    "## 各 Chart 明细",
    ...snapshots.map(snapshotToContextLine),
  ];
  if (snapshots.some((s) => s.title.toLowerCase().includes("dau") || s.title.includes("Active"))) {
    lines.push("", "注: 若用户问 DAU，请优先使用名称含 DAU/Active Users 的指标；WAU 为周活，不可当作 DAU。");
  }
  return lines.join("\n");
}

const SYSTEM_PROMPT_FALLBACK = `你是 CoCo，Furever Dock 团队的 AI 助手。你可以：
- 从 FureverDock 飞书知识库直接读取文档回答专业问题
- 分析 Amplitude 产品数据（DAU、留存、购买等指标）
- 回答日常技术、产品、运营相关问题
请用简洁专业的中文回复，保持友好。不要编造数字或透露系统配置。`;

// ── 独立 Prompt 缓存（60s TTL，与全量 wiki cache 解耦） ──

let cachedBehaviorPrompt: { content: string; ts: number } | null = null;
const PROMPT_CACHE_TTL = 60_000; // 60 秒

/**
 * 解析 System Prompt：
 * 1. 优先读取飞书上「CoCo 行为手册」文档（独立直拉，60s 刷新）
 * 2. 失败则用旧缓存
 * 3. 都没有则降级到硬编码 fallback
 */
export async function resolveSystemPrompt(env: Env): Promise<string> {
  const docToken = env.feishuCocoBehaviorDocToken;
  if (!docToken) return SYSTEM_PROMPT_FALLBACK;

  const now = Date.now();
  if (cachedBehaviorPrompt && (now - cachedBehaviorPrompt.ts) < PROMPT_CACHE_TTL) {
    return cachedBehaviorPrompt.content;
  }

  try {
    // 5 秒超时，避免飞书 API 卡住阻塞整个问答
    const content = await Promise.race([
      getDocumentRawContent(env, docToken),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("Feishu doc fetch timeout (5s)")), 5_000),
      ),
    ]);
    if (content.trim()) {
      cachedBehaviorPrompt = { content: content.trim(), ts: now };
      console.log("[ask] Behavior manual refreshed from Feishu doc");
      return content.trim();
    }
  } catch (err) {
    console.warn("[ask] Failed to fetch behavior manual:", err);
  }

  // 降级链：旧缓存 → 硬编码 fallback
  if (cachedBehaviorPrompt) return cachedBehaviorPrompt.content;
  return SYSTEM_PROMPT_FALLBACK;
}

export type AskResult = {
  question: string;
  answer: string;
  dataContext: string;
  wikiSources?: Array<{ title: string; space: string; nodeToken: string }>;
};

/**
 * 从知识库全文缓存中搜索相关内容。
 * 缓存由启动预热（index.ts 启动时后台调用 ensureWikiCache）填充，
 * 每次请求直接走内存搜索，不需要额外 API 调用。
 */
export async function buildWikiContext(env: Env, question: string): Promise<{
  wikiText: string;
  sources: AskResult["wikiSources"];
}> {
  const sources: AskResult["wikiSources"] = [];
  if (!env.feishuWikiSpaceIds.length) return { wikiText: "", sources };

  try {
    await ensureWikiCache(env);
    const results = searchFulltext(question, 5);
    console.log("[wiki] Fulltext search:", results.length, "results");

    if (results.length > 0) {
      for (const r of results) {
        sources.push({ title: r.docTitle, space: r.spaceName, nodeToken: r.url.split("/").pop() ?? "" });
      }
      const wikiText = results
        .map((r, i) => {
          const label = r.heading !== r.docTitle ? `${r.docTitle} › ${r.heading}` : r.docTitle;
          return `【文档 ${i + 1}】${label}\n来源：${r.url}\n${r.snippet}`;
        })
        .join("\n\n---\n\n");
      return { wikiText, sources };
    }

    return { wikiText: "", sources };
  } catch (err) {
    console.warn("[ask] Wiki search failed:", err);
    return { wikiText: "", sources };
  }
}


/** 判断是否数据类问题，无需拉 Amplitude 的跳过以提速 */
function isDataQuestion(q: string): boolean {
  return /(DAU|WAU|MAU|留存|retention|新增用户|购买|收入|revenue|指标|数据|涨|跌|环比|日报|chart|snapshot)/i.test(q);
}

export async function askQuestion(
  env: Env,
  question: string,
  history?: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }>,
): Promise<AskResult> {
  const trimmed = question.trim();
  if (!trimmed) throw new Error("question is required");

  // 知识库搜索（始终执行，内存操作）；Amplitude 仅数据类问题拉取
  const isData = isDataQuestion(trimmed);
  const [wikiResult, snapshots] = await Promise.all([
    buildWikiContext(env, trimmed),
    isData ? fetchStandardMetricSnapshots(env) : Promise.resolve([] as ChartSnapshot[]),
  ]);

  const dataContext = isData
    ? (() => {
        const reportMd = buildReportMarkdown(snapshots, env.amplitudeDashboardUrl || undefined);
        return buildAmplitudeContext(snapshots, reportMd);
      })()
    : "";
  const hasWiki = !!(wikiResult.wikiText && wikiResult.sources?.length);

  // 构建 Context 模板：wiki + 数据始终共存，不再互斥
  // 对话历史通过 Gemini 原生 contents[] 传递，不在此重复
  const contextParts: string[] = [];

  if (hasWiki) {
    contextParts.push(`## Knowledge Base\n\n${wikiResult.wikiText}`);
  }
  if (dataContext) {
    contextParts.push(`## Product Metrics\n\n${dataContext}`);
  }

  const userPrompt = [
    "# Context",
    "",
    ...contextParts,
    "---",
    "",
    "## User Question",
    "",
    trimmed,
    "",
    "---",
    "",
    "以上内容均为本次对话可参考的 Context，可能与当前问题相关，也可能无关。请根据问题判断哪些资料真正相关。",
  ].join("\n");

  const systemPrompt = await resolveSystemPrompt(env);
  const answer = await generateGeminiReply(env, systemPrompt, userPrompt, history).catch((err) => {
    const hint = "提示：若本地无法访问 generativelanguage.googleapis.com，请开代理/VPN，或在 GCE VM 上运行。";
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n${hint}`);
  });

  return {
    question: trimmed,
    answer,
    dataContext,
    wikiSources: wikiResult.sources?.length ? wikiResult.sources : undefined,
  };
}
