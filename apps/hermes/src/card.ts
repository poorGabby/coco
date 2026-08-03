import type { ChartSnapshot } from "./amplitude.js";
import type { DailyAnalysis } from "./analyze.js";

function formatNumber(value: number | null): string {
  if (value == null) return "—";
  if (Number.isInteger(value)) return value.toLocaleString("en-US");
  return value.toFixed(2);
}

function formatPct(value: number | null): string {
  if (value != null) {
    const sign = value > 0 ? "+" : "";
    return `${sign}${value.toFixed(1)}%`;
  }
  // 基期为 0（含收入前日 $0）等无法计算 DoD 的情况 → N/A
  return "N/A";
}

function snapshotLine(s: ChartSnapshot): string {
  if (s.error) {
    return `• **${s.title}**: ⚠️ 拉取失败`;
  }
  const val = s.kind === "retention" && s.yesterday ? s.yesterday : formatNumber(s.yesterdayValue);
  return `• **${s.title}**: ${val}  (DoD ${formatPct(s.changePct)})`;
}

function buildMetricsMarkdown(snapshots: ChartSnapshot[]): string {
  const lines = snapshots.map(snapshotLine);
  const errorCount = snapshots.filter((s) => s.error).length;
  if (errorCount > 0) {
    lines.push("", `⚠️ ${errorCount} 项指标拉取失败，请检查 Amplitude 配置。`);
  }
  return lines.join("\n");
}

// ── 飞书卡片 JSON 2.0 组件 helper ──

type Card = Record<string, unknown>;

function mkCollapsible(title: string, expanded: boolean, elements: Card[]): Card {
  return {
    tag: "collapsible_panel",
    expanded,
    header: {
      title: { tag: "plain_text", content: title },
    },
    elements,
  };
}

function mkMarkdown(content: string): Card {
  return { tag: "markdown", content };
}

function mkDivider(): Card {
  return { tag: "hr" };
}

function mkFooter(content: string): Card {
  return { tag: "markdown", content: `<font color='grey'>${content}</font>` };
}

/** 构建飞书卡片 JSON 2.0 */
export function buildDailyCard(
  analysis: DailyAnalysis,
  snapshots: ChartSnapshot[],
  dateLabel: string,
): Card {
  const bodyElements: Card[] = [];

  // ── 概要 ──
  bodyElements.push(mkMarkdown(analysis.summary));
  bodyElements.push(mkDivider());

  // ── 核心指标（可折叠面板，默认展开） ──
  bodyElements.push(
    mkCollapsible(
      `📊 核心指标 · ${snapshots.filter((s) => !s.error).length} 项`,
      true,
      [mkMarkdown(buildMetricsMarkdown(snapshots))],
    ),
  );

  // ── 警报详情（可折叠，有告警时默认展开） ──
  if (analysis.alerts.length > 0) {
    const alertBlocks: Card[] = [];
    for (const a of analysis.alerts) {
      alertBlocks.push(
        mkMarkdown(
          `**${a.title}**\n概要：${a.summary}\n\n${a.deepAnalysis}`,
        ),
      );
      alertBlocks.push(mkDivider());
    }
    alertBlocks.pop(); // 去掉最后一个多余的分割线
    bodyElements.push(
      mkCollapsible(`🔴 警报详情 · ${analysis.alertCount} 项`, true, alertBlocks),
    );
  }

  // ── 关注项（可折叠，默认收起） ──
  if (analysis.watches.length > 0) {
    const watchBlocks: Card[] = [];
    for (const w of analysis.watches) {
      watchBlocks.push(
        mkMarkdown(`**🟡 ${w.title}**: ${w.value}\n${w.analysis}`),
      );
    }
    bodyElements.push(
      mkCollapsible(`🟡 关注项 · ${analysis.watchCount} 项`, false, watchBlocks),
    );
  }

  // ── 分析假设 & 下一步（可折叠，默认收起） ──
  bodyElements.push(
    mkCollapsible("💡 分析假设 & 下一步", false, [
      mkMarkdown(analysis.hypotheses),
    ]),
  );

  // ── 底部 ──
  bodyElements.push(mkDivider());
  bodyElements.push(
    mkFooter(`📎 Amplitude Dashboard  ·  ${dateLabel}  ·  CoCo 自动生成`),
  );

  return {
    schema: "2.0",
    config: {
      width_mode: "fill",
      enable_forward: true,
    },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: `📊 Furever Dock 每日简报 · ${dateLabel}`,
      },
      subtitle: {
        tag: "plain_text",
        content:
          analysis.alertCount > 0
            ? `🔴 ${analysis.alertCount} 个警报  🟡 ${analysis.watchCount} 个关注`
            : `🟡 ${analysis.watchCount} 个关注`,
      },
    },
    body: {
      direction: "vertical",
      elements: bodyElements,
    },
  };
}
