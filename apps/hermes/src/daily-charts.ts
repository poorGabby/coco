/**
 * 日报指标单一注册表：与 Amplitude Dashboard o6xkdkvf 对齐。
 * Chart ID 固定；正式日报由标准工具按指标选择 /query 或 CSV，Retention 必须走 /query。
 * Revenue 不在此表 — 走 Stripe（见 report.ts）。
 */
export type DailyChartRole =
  | "dau"
  | "new_users"
  | "purchase_users"
  | "retention_new_user"
  | "retention_purchaser";

export type DailyChartDef = {
  id: string;
  role: DailyChartRole;
  kind: "timeseries" | "retention";
  /** 卡片/Markdown 展示名（写清楚口径） */
  title: string;
  /** 分段图只取匹配行；未匹配时回退为该图全部数值行求和（兼容旧图）。 */
  segmentPrefer?: RegExp;
};

/** 正式日报默认图表（Dashboard 给 AI 拉数用的表） */
export const DEFAULT_DAILY_CHARTS: readonly DailyChartDef[] = [
  {
    id: "ilhu9t17",
    role: "dau",
    kind: "timeseries",
    title: "Daily Active Users (DAU) — Calendar Day",
  },
  {
    id: "1n0bfs5k",
    role: "new_users",
    kind: "timeseries",
    title: "New Users (Daily)（每日新增用户 · Daily Uniques）",
  },
  {
    id: "bh0r0h4o",
    role: "purchase_users",
    kind: "timeseries",
    title: "Purchase Users（购买去重人数 · 完成购买的独立用户，非收入/非订单数）",
  },
  {
    id: "18lt8h9t",
    role: "retention_new_user",
    kind: "retention",
    title: "New User Retention",
  },
  {
    id: "5of8047n",
    role: "retention_purchaser",
    kind: "retention",
    title: "Purchaser Companion Retention",
  },
] as const;

/** Stripe 失败时回退用的分档购买图（不进卡片正文） */
export const PURCHASE_PRODUCT_CHART_ID = "xhd4uffg";

export const DEFAULT_DASHBOARD_URL =
  "https://app.amplitude.com/analytics/lollapaloozalab/dashboard/o6xkdkvf";

/** 解析 env 覆盖：`id` 或 `id:role` 逗号分隔；缺省用 DEFAULT_DAILY_CHARTS */
export function resolveDailyCharts(envIds?: string): DailyChartDef[] {
  const raw = (envIds ?? "").trim();
  if (!raw) return [...DEFAULT_DAILY_CHARTS];

  const byId = new Map(DEFAULT_DAILY_CHARTS.map((c) => [c.id, c]));
  const out: DailyChartDef[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (!id) continue;
    const known = byId.get(id);
    if (known) {
      out.push(known);
    } else {
      out.push({
        id,
        role: "dau",
        kind: id.match(/retent/i) ? "retention" : "timeseries",
        title: id,
      });
    }
  }
  return out.length ? out : [...DEFAULT_DAILY_CHARTS];
}
