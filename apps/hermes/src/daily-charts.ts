/**
 * 日报指标单一注册表：与 Amplitude Dashboard o6xkdkvf 对齐。
 * 数字一律走 Chart Export CSV（写死 chart id），禁止 Segmentation 算日报。
 * Revenue 不在此表 — 走 Stripe（见 report.ts）。
 */
export type DailyChartRole =
  | "dau"
  | "new_users"
  | "purchase_users"
  | "retention_companion"
  | "retention_purchaser";

export type DailyChartDef = {
  id: string;
  role: DailyChartRole;
  kind: "timeseries" | "retention";
  /** 卡片/Markdown 展示名（写清楚口径） */
  title: string;
  /**
   * 分段图只取匹配行（如 cjwne7be 的「新用户」）。
   * 未匹配时回退为该图全部数值行求和（兼容旧图）。
   */
  segmentPrefer?: RegExp;
};

/** 正式日报默认图表（Dashboard 给 AI 拉数用的表） */
export const DEFAULT_DAILY_CHARTS: readonly DailyChartDef[] = [
  {
    id: "a29etrut",
    role: "dau",
    kind: "timeseries",
    title: "DAU — Daily Active Users",
  },
  {
    id: "cjwne7be",
    role: "new_users",
    kind: "timeseries",
    title: "New Users（新增用户 · 用户增长）",
    // 只要「新用户」行，不要与「老用户」求和
    segmentPrefer: /新用户|new\s*users?/i,
  },
  {
    id: "bh0r0h4o",
    role: "purchase_users",
    kind: "timeseries",
    title: "Purchase Users（购买去重人数 · 完成购买的独立用户，非收入/非订单数）",
  },
  {
    id: "ji5sqoml",
    role: "retention_companion",
    kind: "retention",
    title: "Companion Retention — D1 / D3 / D7",
  },
  {
    id: "5of8047n",
    role: "retention_purchaser",
    kind: "retention",
    title: "Purchaser Companion Retention — D1 / D3 / D7",
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
