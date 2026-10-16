import type { ChartSnapshot } from "./amplitude.js";
import type { Env } from "./env.js";
import { getDocumentRawContent } from "./feishu.js";
import { generateGeminiJson } from "./llm.js";
import { dailyCohortContext } from "./retention-daily-cohorts.js";

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
2. 所有核心指标统一采用 WoW。普通日指标比较当前美区数据日与 7 天前同日。New User Retention 仅有 User ID 的新用户，以完结观察日减 1/3/7 天分别选取 D1/D3/D7 单日 cohort，WoW 将该 cohort 和观察日都前移七天，使用百分点（pp）。Purchaser Companion Retention 保留 overall/combined 主值及独立 cohort WoW。
3. 告警判定必须复用 snapshot 的 WoW。普通指标跌幅 >15% 或 Retention 下降超过 15pp，或关键指标显著走弱 → Alert；次重要指标走弱但未达告警线 → Watch。
4. 正向变动也可标记（如「正向异常」）。
5. 深度分析需引用具体数据、关联指标交叉验证。
6. 中文输出。提及日期时使用「美区 MM-DD」，日期来自 America/Dawson（固定 UTC-7）。New User Retention 写明各点 cohort 日期、回访观察日和上周对应日期；Purchaser Companion Retention 主值仍为 overall。不要换算成北京时间。
7. **变化率 0.0%/0.0pp ≠ 数据缺失。** 按 WoW 口径如实写「持平」；只有 N/A 或 — 才代表无法比较或缺失。
8. **普通指标比较基期为 0 → 百分比变化率 N/A。** 留存率按百分点差比较，零留存率且用户分母大于零时仍有效；分母为零或数据缺失才为 N/A。绝对量照常展示，当前真实值为 0 仍写 0。`;

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
  if (s.kind === "retention") {
    const retention = s.snapshot?.retention;
    if (!retention) return `- ${s.title} (${s.metricLabel}): N/A`;
    return (["D1", "D3", "D7"] as const).map((day) => {
      const point = retention.points[day];
      if (retention.valueScope === "daily-cohort-per-day") return dailyCohortContext(s.title, day, point);
      const currentRate = point.rate == null ? "N/A" : `${(point.rate * 100).toFixed(2)}%`;
      const wowCurrentRate = point.wowCurrentRate == null ? "N/A" : `${(point.wowCurrentRate * 100).toFixed(2)}%`;
      const comparisonRate = point.comparisonRate == null ? "N/A" : `${(point.comparisonRate * 100).toFixed(2)}%`;
      const pp = point.wowChangePp;
      const currentPeriod = retention.currentPeriod
        ? `${retention.currentPeriod.startDate}~${retention.currentPeriod.endDate}`
        : "Last 30 days";
      const wow = pp == null ? "N/A" : `${pp > 0 ? "+" : ""}${pp.toFixed(2)}pp`;
      return `- ${s.title} — Day ${day.slice(1)}: 主值 overall/combined(美区 ${currentPeriod})=${currentRate} (${point.numerator}/${point.denominator}); WoW 单日 cohort 基础：美区 ${retention.currentCohort}=${wowCurrentRate} (${point.wowCurrentNumerator}/${point.wowCurrentDenominator}) vs 美区 ${retention.comparisonCohort}=${comparisonRate} (${point.comparisonNumerator}/${point.comparisonDenominator}); WoW=${wow}`;
    }).join("\n");
  }
  const comparisonKind = "WoW";
  // 正常有值→百分比；上周同日基期为 0 → N/A（无法计算，不是"数据缺失"）
  const pct =
    s.changePct != null
      ? `${s.changePct > 0 ? "+" : ""}${s.changePct.toFixed(1)}%`
      : "N/A";
  // timeseries 的 yesterday/dayBefore 是美区(America/Dawson)日期字符串(如 "2026-07-11")；
  // 带上明确日期锚点，避免 LLM 自行推断日期导致与标题错位。
  const yDate = s.kind === "timeseries" && s.yesterday ? `(美区 ${s.yesterday})` : "";
  const dDate = s.kind === "timeseries" && s.dayBefore ? `(美区 ${s.dayBefore})` : "";
  const comparisonLabel = "上周同日";
  return (
    `- ${s.title} (${s.metricLabel}): 当前${yDate}=${s.yesterdayValue ?? "N/A"} ` +
    `${comparisonLabel}${dDate}=${s.dayBeforeValue ?? "N/A"} ${comparisonKind}=${pct}`
  );
}

export function buildAnalysisPrompt(snapshots: ChartSnapshot[]): string {
  // 从第一个 timeseries snapshot 取实际数据覆盖的美区(America/Dawson)日期
  const ts = snapshots.find(s => s.kind === "timeseries" && s.yesterday && !s.error);
  const dataDateMst = ts?.yesterday?.slice(5) ?? ""; // "07-09"

  const observationDate = ts?.yesterday ?? snapshots.find(s => s.snapshot?.retention?.observationDate)?.snapshot?.retention?.observationDate;
  const lines = [`数据覆盖日期: 美区 ${observationDate?.slice(5) ?? dataDateMst}（America/Dawson，全年固定 UTC-7）。所有涨跌较上周同日。New User Retention 只计有 User ID 新用户，主值为各 Day N 独立单日 cohort，WoW 将该 cohort 和观察日都前移七天；Purchaser Companion Retention 仍为 overall 主值及独立 cohort WoW。日期复用 snapshot，不换算成北京时间。`, "", "## 指标清单", ""];
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
            title: "指标名 — 数值（WoW；Retention 使用 pp）",
            value: "对应比较口径的变化数值",
            summary: "一句话概要（50字内）",
            deepAnalysis:
              "深度分析（150-300字）：交叉引用相关指标解释原因、关联影响、可能根因。",
          },
        ],
        watches: [
          {
            title: "指标名",
            value: "WoW 变化",
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
    "- 日报收入来自 Stripe 成功且已支付的 USD Charge，并扣除该 Charge 已退款金额；Purchase Completed / First Purchase 仍是 Amplitude 用户行为口径，不能与 Stripe Charge 笔数混作同一分母。没有同口径去重购买人数时，不分析客单价或 ARPPU；仅建议先核对相同渠道、时间及去重口径的数据。",
    "- alertCount 和 watchCount 必须与实际 alerts / watches 数组长度一致",
    "- 至多 3 个 alert、6 个 watch；没有达到条件的异常时返回空数组，禁止为了凑数量制造告警",
    "- 每个 alert 的 deepAnalysis 必须引用具体数字、做交叉指标关联分析",
    "- summary 要有高度概括，不堆砌数字",
    "- 所有核心指标一律写 WoW；普通指标解释为较上周同日；New User Retention / Purchaser Companion Retention 必须说明主值来自各自正式 Chart 的 overall/combined，而 WoW 来自最新成熟单日 cohort vs 7 天前同日 cohort 的 pp 变化",
    "- 若变化率=N/A（常见于基期为 0），说明因比较基期为 0 无法计算，禁止写「从 0 恢复」",
    "- 若某项数据缺失（N/A），直接在对应指标上如实说明",
    "- 只分析提供的指标，不要说「需查看XX图表」之类的话",
  );

  return lines.join("\n");
}

export function fallbackAnalysis(
  snapshots: ChartSnapshot[],
  reportMarkdown: string,
): DailyAnalysis {
  const errors = snapshots.filter((s) => s.error);
  const valid = snapshots.filter((s) => !s.error);
  const alerts: AlertItem[] = [];
  const watches: WatchItem[] = [];

  for (const s of valid) {
    if (s.kind === "retention" && s.snapshot?.retention) {
      const retention = s.snapshot.retention;
      for (const day of ["D1", "D3", "D7"] as const) {
        const point = retention.points[day];
        const pp = point.wowChangePp;
        if (pp == null) continue;
        const title = `${s.title} — Day ${day.slice(1)}`;
        const detail = retention.valueScope === "daily-cohort-per-day"
          ? dailyCohortContext(s.title, day, point)
          : `${title} 主值为 Last 30 days overall ${(Number(point.rate) * 100).toFixed(2)}%；WoW 单日 cohort 从 ${(Number(point.comparisonRate) * 100).toFixed(2)}% 变为 ${(Number(point.wowCurrentRate) * 100).toFixed(2)}%，变化 ${pp.toFixed(2)}pp。`;
        if (pp < -15) {
          alerts.push({
            title: `${title} — ${(Number(point.rate) * 100).toFixed(2)}%（WoW ${pp.toFixed(2)}pp）`,
            value: "见表格",
            summary: `${title} WoW 显著下降 ${Math.abs(pp).toFixed(2)}pp。`,
            deepAnalysis: `${detail}建议关注后续同口径留存。`,
          });
        } else if (pp < -5) {
          watches.push({
            title,
            value: `WoW ${pp.toFixed(2)}pp`,
            analysis: `${detail}暂未触发告警但需关注。`,
          });
        }
      }
      continue;
    }
    const comparisonKind = "WoW";
    const comparisonLabel = "较上周同日";
    if (s.changePct != null && s.changePct < -15) {
      alerts.push({
        title: `${s.title} — ${s.yesterdayValue ?? "N/A"}（${comparisonKind} ${s.changePct.toFixed(1)}%）`,
        value: "见表格",
        summary: `${s.title} ${comparisonKind} 显著下降 ${Math.abs(s.changePct).toFixed(1)}%。`,
        deepAnalysis: `该指标${comparisonLabel}从 ${s.dayBeforeValue ?? "N/A"} 降至 ${s.yesterdayValue ?? "N/A"}，${comparisonKind} 降幅 ${Math.abs(s.changePct).toFixed(1)}%。建议重点关注该指标后续趋势。`,
      });
    } else if (s.changePct != null && s.changePct < -5) {
      watches.push({
        title: s.title,
        value: `${comparisonKind} ${s.changePct.toFixed(1)}%`,
        analysis: `${s.title}${comparisonLabel}从 ${s.dayBeforeValue ?? "N/A"} 降至 ${s.yesterdayValue ?? "N/A"}，${comparisonKind} 降幅 ${Math.abs(s.changePct).toFixed(1)}%，暂未触发告警但需关注。`,
      });
    }
  }

  return {
    alertCount: alerts.length,
    watchCount: watches.length,
    summary: `本日共拉取 ${valid.length} 项指标${errors.length ? `，${errors.length} 项失败` : ""}。${alerts.length > 0 ? `其中 ${alerts.length} 项触发告警。` : "可比较指标未触发告警阈值。"}详细数据请见下方指标清单。`,
    alerts,
    watches,
    hypotheses: "以上按可比较指标和阈值列出变化。原因尚未验证，需先核对相同渠道、时间范围及去重口径的数据。",
  };
}

export function enforceAnalysisScope(analysis: DailyAnalysis, snapshots: ChartSnapshot[], reportMarkdown: string): DailyAnalysis {
  // No matching order/frequency/ARPPU denominator is provided to this report.
  // Reject the entire narrative rather than attempting to edit a generated financial claim.
  if (/客单价|购买频[次率]|ARPPU|average\s+order\s+value|purchase\s+frequency/i.test(JSON.stringify(analysis))) {
    return fallbackAnalysis(snapshots, reportMarkdown);
  }
  return { ...analysis, alertCount: analysis.alerts.length, watchCount: analysis.watches.length };
}

export async function analyzeDailySnapshots(
  env: Env,
  snapshots: ChartSnapshot[],
  reportMarkdown: string,
): Promise<DailyAnalysis> {
  const userPrompt = buildAnalysisPrompt(snapshots);

  try {
    const systemPrompt = [
      await resolveAnalysisPrompt(env),
      "",
      "## Runtime comparison contract（优先级高于文档中的旧比较规则）",
      "所有普通核心指标必须使用 snapshot 中的 WoW：当前数据日与 7 天前同日比较，并解释为‘较上周同日’。",
      "New User Retention 主值必须使用 snapshot 的 daily-cohort-per-day rate（有 User ID，D1/D3/D7 各自的单日 cohort）。WoW 使用各 point 的 comparisonCohortDate、comparisonObservationDate 和 wowChangePp，不得改成共用一批 cohort、overall 或 DoD。Purchaser Companion Retention 保留 overall/combined 主值及原有独立 cohort WoW。",
      "告警、关注项、摘要和正文必须复用各 snapshot 已计算好的 WoW，不得自行重算。",
      "日报 Daily Revenue 直接使用 Stripe snapshot：成功且已支付的 USD Charge，按 Charge 创建日归属并扣除该 Charge 已退款金额。必须复用 snapshot 数值和 WoW，不得用 Amplitude 购买事件或固定单价重新估算。Stripe 拉取失败时收入未知。没有符合阈值的异常时 alerts/watches 必须为空数组。",
    ].join("\n");
    const analysis = await generateGeminiJson<DailyAnalysis>(env, systemPrompt, userPrompt);
    return enforceAnalysisScope(analysis, snapshots, reportMarkdown);
  } catch (err) {
    console.error("Gemini analysis failed, using fallback:", err instanceof Error ? err.message : String(err));
    // fallback：用规则判断告警
    return fallbackAnalysis(snapshots, reportMarkdown);
  }
}
