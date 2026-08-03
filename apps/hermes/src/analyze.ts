import type { ChartSnapshot } from "./amplitude.js";
import type { Env } from "./env.js";
import { getDocumentRawContent } from "./feishu.js";
import { generateGeminiJson } from "./llm.js";

export type AlertItem = {
  title: string;
  value: string;
  summary: string;
  deepAnalysis: string;
};

export type WatchItem = {
  title: string;
  value: string;
  analysis: string;
};

export type DailyAnalysis = {
  alertCount: number;
  watchCount: number;
  summary: string;
  alerts: AlertItem[];
  watches: WatchItem[];
  hypotheses: string;
};

const ANALYSIS_SYSTEM_PROMPT_FALLBACK = `你是 Furever Dock 内部数据分析助手 CoCo。
你收到的数据是从 Amplitude Chart Export API 实时拉取的产品指标。请输出严格 JSON。

规则：
1. 只根据提供的数据分析，不编造。
2. 本日报所有变化均采用 DoD（Day-over-Day）：美区数据覆盖日 vs 再前一自然日。对外输出一律写「DoD」。若输入字段仍命名为 wow_change / Wow，语义按 DoD Change 理解；禁止出现 Week-over-Week / WoW / 周环比。展示格式示例：DAU — Daily Active Users: 208  (DoD +147.6%)。
3. 告警判定：DoD 跌幅 >15% 或 关键指标（收入/转化/留存）显著走弱 → Alert；次重要指标走弱但未达告警线 → Watch。
4. 正向变动也可标记（如「正向异常」）。
5. 深度分析需引用具体数据、关联指标交叉验证。
6. 中文输出。提及任何日期时，一律使用「美区 MM-DD」格式（例：美区 07-11），日期数值取自指标数据标注的美区（America/Denver）日期（与日报标题一致）。**禁止使用「昨日」「前日」「当日」「今天」等相对时间词**——包括描述环比对比对象时，也必须写成具体的「美区 MM-DD」，例如写「美区 07-11 从美区 07-10 的 2 笔降至 0」，而非「从前日的 2 笔降至 0」。不要换算成北京时间——中国读者会把「昨日」直觉理解为北京时间，造成日期误读。
7. **DoD=0.0% ≠ 数据缺失。** 留存等指标两日数值恰好相同，DoD 就是 0.0%，如实写「DoD 持平」，**禁止说「数据缺失」「无法环比」**——只有 DoD 显示 N/A 或 — 时才代表无法比较或缺失。
8. **基期为 0 → DoD = N/A。** 当再前一自然日为 0 时分母为 0，无法计算 DoD。此时 DoD 一律写 N/A，禁止编造百分比，也禁止写「从 0 恢复」「从 $0 增长至…」。语义：因基期（再前一自然日）为 0，无法计算 DoD。绝对量照常展示；当日真实值为 0 仍写 0，不得改成 N/A。`;

// ── 独立 Prompt 缓存（60s TTL，与全量 wiki cache 解耦） ──

let cachedAnalysisPrompt: { content: string; ts: number } | null = null;
const PROMPT_CACHE_TTL = 60_000; // 60 秒

/**
 * 解析日报分析 System Prompt：
 * 1. 优先读取飞书上「CoCo 日报分析规范」文档（独立直拉，60s 刷新）
 * 2. 失败则用旧缓存
 * 3. 都没有则降级到硬编码 fallback
 */
async function resolveAnalysisPrompt(env: Env): Promise<string> {
  const docToken = env.feishuCocoAnalysisDocToken;
  if (!docToken) return ANALYSIS_SYSTEM_PROMPT_FALLBACK;

  const now = Date.now();
  if (cachedAnalysisPrompt && (now - cachedAnalysisPrompt.ts) < PROMPT_CACHE_TTL) {
    return cachedAnalysisPrompt.content;
  }

  try {
    // 5 秒超时，避免飞书 API 卡住阻塞日报生成
    const content = await Promise.race([
      getDocumentRawContent(env, docToken),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("Feishu doc fetch timeout (5s)")), 5_000),
      ),
    ]);
    if (content.trim()) {
      cachedAnalysisPrompt = { content: content.trim(), ts: now };
      console.log("[analyze] Analysis spec refreshed from Feishu doc");
      return content.trim();
    }
  } catch (err) {
    console.warn("[analyze] Failed to fetch analysis spec:", err);
  }

  // 降级链：旧缓存 → 硬编码 fallback
  if (cachedAnalysisPrompt) return cachedAnalysisPrompt.content;
  return ANALYSIS_SYSTEM_PROMPT_FALLBACK;
}

function snapshotToLine(s: ChartSnapshot): string {
  if (s.error) {
    return `- [${s.chartId}] ${s.title}: 拉取失败 — ${s.error}`;
  }
  // DoD：正常有值→百分比；基期为 0（含收入前日 $0）→ N/A（无法计算，不是"数据缺失"）
  const pct =
    s.changePct != null
      ? `${s.changePct > 0 ? "+" : ""}${s.changePct.toFixed(1)}%`
      : "N/A";
  // timeseries 的 yesterday/dayBefore 是美区(America/Denver)日期字符串(如 "2026-07-11")；
  // 带上明确日期锚点，避免 LLM 自行推断日期导致与标题错位。
  const yDate = s.kind === "timeseries" && s.yesterday ? `(美区 ${s.yesterday})` : "";
  const dDate = s.kind === "timeseries" && s.dayBefore ? `(美区 ${s.dayBefore})` : "";
  return (
    `- ${s.title} (${s.metricLabel}): 昨日${yDate}=${s.yesterdayValue ?? "N/A"} ` +
    `前日${dDate}=${s.dayBeforeValue ?? "N/A"} DoD=${pct}`
  );
}

function buildAnalysisPrompt(snapshots: ChartSnapshot[]): string {
  // 从第一个 timeseries snapshot 取实际数据覆盖的美区(America/Denver)日期
  const ts = snapshots.find(s => s.kind === "timeseries" && s.yesterday && !s.error);
  const dataDateMst = ts?.yesterday?.slice(5) ?? ""; // "07-09"

  const lines = [`数据覆盖日期: 美区 ${dataDateMst}（America/Denver 时区，随夏令时偏移）。分析中提及任何日期（含环比对比对象）时，一律使用「美区 MM-DD」格式（例：美区 ${dataDateMst} 从美区 07-10 的 X 降至 Y），日期取自各指标行标注的美区日期。禁止使用「昨日」「前日」「当日」等相对词，也不要换算成北京时间——中国读者会把「昨日」误读为北京时间。`, "", "## 指标清单", ""];
  for (const s of snapshots) {
    lines.push(snapshotToLine(s));
  }

  lines.push(
    "",
    "---",
    "",
    "请输出如下 JSON 结构（严格 JSON，不要加 markdown 代码块）：",
    "",
    "```",
    JSON.stringify(
      {
        alertCount: 0,
        watchCount: 0,
        summary:
          "200-300字概要，覆盖：整体健康状况、核心亮点/问题、关键风险。用数据说话。",
        alerts: [
          {
            title: "指标名 — 数值（DoD 环比）",
            value: "DoD 变化数值",
            summary: "一句话概要（50字内）",
            deepAnalysis:
              "深度分析（150-300字）：交叉引用相关指标解释原因、关联影响、可能根因。",
          },
        ],
        watches: [
          {
            title: "指标名",
            value: "DoD 变化",
            analysis: "50-100字简要分析",
          },
        ],
        hypotheses:
          "150-250字：基于以上数据的综合判断 + 建议下一步行动/排查方向。",
      },
      null,
      2,
    ),
    "```",
    "",
    "要求：",
    "- alertCount 和 watchCount 必须与实际 alerts / watches 数组长度一致",
    "- 至少 1 个 alert，至多 3 个；至多 6 个 watch",
    "- 每个 alert 的 deepAnalysis 必须引用具体数字、做交叉指标关联分析",
    "- summary 要有高度概括，不堆砌数字",
    "- 变化一律写 DoD，禁止 Wow / Week-over-Week；展示如「DAU: 208 (DoD +147.6%)」",
    "- 若 DoD=N/A（常见于基期为 0），说明因基期为 0 无法计算 DoD，禁止写「从 0 恢复」",
    "- 若某项数据缺失（N/A），直接在对应指标上如实说明",
    "- 只分析提供的指标，不要说「需查看XX图表」之类的话",
  );

  return lines.join("\n");
}

function fallbackAnalysis(
  snapshots: ChartSnapshot[],
  reportMarkdown: string,
): DailyAnalysis {
  const errors = snapshots.filter((s) => s.error);
  const valid = snapshots.filter((s) => !s.error);
  const alerts: AlertItem[] = [];
  const watches: WatchItem[] = [];

  for (const s of valid) {
    if (s.changePct != null && s.changePct < -15) {
      alerts.push({
        title: `${s.title} — ${s.yesterdayValue ?? "N/A"}（DoD ${s.changePct.toFixed(1)}%）`,
        value: "见表格",
        summary: `${s.title} DoD 显著下降 ${Math.abs(s.changePct).toFixed(1)}%。`,
        deepAnalysis: `该指标从 ${s.dayBeforeValue ?? "N/A"} 降至 ${s.yesterdayValue ?? "N/A"}，降幅 ${Math.abs(s.changePct).toFixed(1)}%。建议重点关注该指标后续趋势。`,
      });
    } else if (s.changePct != null && s.changePct < -5) {
      watches.push({
        title: s.title,
        value: `DoD ${s.changePct.toFixed(1)}%`,
        analysis: `${s.title} 从 ${s.dayBeforeValue ?? "N/A"} 降至 ${s.yesterdayValue ?? "N/A"}，降幅 ${Math.abs(s.changePct).toFixed(1)}%，暂未触发告警但需关注。`,
      });
    }
  }

  return {
    alertCount: alerts.length || 1,
    watchCount: watches.length || 1,
    summary: `本日共拉取 ${valid.length} 项指标${errors.length ? `，${errors.length} 项失败` : ""}。${alerts.length > 0 ? `其中 ${alerts.length} 项触发告警。` : "所有指标正常。"}详细数据请见下方指标清单。`,
    alerts:
      alerts.length > 0
        ? alerts
        : [
            {
              title: "无显著告警",
              value: "",
              summary: "所有指标波动在正常范围内。",
              deepAnalysis: "本日各指标 DoD 变动均未触发告警阈值（-15%），整体表现稳定。",
            },
          ],
    watches,
    hypotheses: "（Gemini 分析暂不可用，以上为 fallback 规则判定，仅供参考。）",
  };
}

export async function analyzeDailySnapshots(
  env: Env,
  snapshots: ChartSnapshot[],
  reportMarkdown: string,
): Promise<DailyAnalysis> {
  const userPrompt = buildAnalysisPrompt(snapshots);

  try {
    const systemPrompt = await resolveAnalysisPrompt(env);
    return await generateGeminiJson<DailyAnalysis>(env, systemPrompt, userPrompt);
  } catch (err) {
    console.error("Gemini analysis failed, using fallback:", err instanceof Error ? err.message : String(err));
    // fallback：用规则判断告警
    return fallbackAnalysis(snapshots, reportMarkdown);
  }
}
