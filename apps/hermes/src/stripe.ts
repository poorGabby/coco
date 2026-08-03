import https from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { Env } from "./env.js";

/**
 * Stripe 数据源（真实支付流水）。
 *
 * 设计意图：作为可复用的「数据源 Skill」——日报的 Daily Revenue 与自由问答的
 * 收入工具都从这里取数，保证卡片与聊天的收入口径永远一致，不再各算各的。
 *
 * 口径：以 America/Denver 自然日归集 `succeeded && paid` 的 charge，
 * revenue = Σ(amount − amount_refunded)。时区与 Amplitude 日报保持一致。
 */

const STRIPE_TZ = "America/Denver";
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface StripeDailyRevenue {
  /** Denver 自然日 YYYY-MM-DD */
  date: string;
  /** 当日实际入账收入（美元，已扣退款） */
  revenue: number;
  /** 成交笔数（succeeded && paid） */
  count: number;
  /** 按单价分档的成交笔数，key 为 "9.99" / "6.99" 等 */
  byPrice: Record<string, number>;
  /** 当日退款金额（美元） */
  refunded: number;
}

/** 某个 Denver 自然日 00:00 对应的 UTC 秒级时间戳（自动处理 MST/MDT 夏令时）。 */
function denverMidnightUtcSec(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  // 用当天 UTC 12:00 探测 Denver 小时：MDT(UTC-6)→06，MST(UTC-7)→05
  const probe = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const denverHour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: STRIPE_TZ,
      hour12: false,
      hour: "2-digit",
    }).format(probe),
  );
  const offsetHours = 12 - denverHour; // 6 或 7
  return Date.UTC(y, m - 1, d, offsetHours, 0, 0) / 1000;
}

/** 把 UTC 秒级时间戳归集到其所属的 Denver 自然日 YYYY-MM-DD。 */
function denverDateOf(epochSec: number): string {
  // en-CA 输出 YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: STRIPE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(epochSec * 1000));
}

function addDays(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

function resolveProxyUrl(): string | undefined {
  return (
    process.env.HTTPS_PROXY?.trim() ||
    process.env.https_proxy?.trim() ||
    process.env.HTTP_PROXY?.trim() ||
    process.env.http_proxy?.trim() ||
    undefined
  );
}

interface StripeCharge {
  id: string;
  amount: number;
  amount_refunded?: number;
  created: number;
  status: string;
  paid: boolean;
  currency: string;
}

function stripeGet(
  apiKey: string,
  path: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const proxyUrl = resolveProxyUrl();
  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
  return new Promise((resolve, reject) => {
    const req = https.request(
      `https://api.stripe.com${path}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
        agent,
        timeout: 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              json: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Stripe request timeout (30s)")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * 拉取 [startDate, endDate]（含端点，均为 Denver 自然日）逐日的真实收入。
 * 返回 Map<YYYY-MM-DD, StripeDailyRevenue>，区间内每一天都有条目（无数据则为 0）。
 */
export async function fetchStripeRevenueRange(
  env: Env,
  startDate: string,
  endDate: string,
): Promise<Map<string, StripeDailyRevenue>> {
  if (!env.stripeApiKey) {
    throw new Error("STRIPE_API_KEY 未配置");
  }
  const gte = denverMidnightUtcSec(startDate);
  const lt = denverMidnightUtcSec(addDays(endDate, 1));

  // 预置区间内每一天，保证缺数据的日子也返回 0 而不是缺失
  const days = new Map<string, StripeDailyRevenue>();
  for (let d = startDate; d <= endDate; d = addDays(d, 1)) {
    days.set(d, { date: d, revenue: 0, count: 0, byPrice: {}, refunded: 0 });
  }

  let after: string | undefined;
  for (let page = 0; page < 100; page++) {
    const qs =
      `created[gte]=${gte}&created[lt]=${lt}&limit=100` +
      (after ? `&starting_after=${after}` : "");
    const { status, json } = await stripeGet(env.stripeApiKey, `/v1/charges?${qs}`);
    if (status !== 200) {
      const msg = (json?.error as { message?: string } | undefined)?.message ?? JSON.stringify(json);
      throw new Error(`Stripe /v1/charges ${status}: ${msg}`);
    }
    const data = (json.data as StripeCharge[]) ?? [];
    for (const c of data) {
      if (c.status !== "succeeded" || !c.paid) continue;
      const day = denverDateOf(c.created);
      const entry = days.get(day);
      if (!entry) continue; // 落在区间外（分页边界）忽略
      const refunded = c.amount_refunded ?? 0;
      const net = c.amount - refunded;
      entry.revenue = round2(entry.revenue + net / 100);
      entry.refunded = round2(entry.refunded + refunded / 100);
      entry.count += 1;
      const priceLabel = (c.amount / 100).toFixed(2);
      entry.byPrice[priceLabel] = (entry.byPrice[priceLabel] ?? 0) + 1;
    }
    if (!json.has_more) break;
    after = data[data.length - 1]?.id;
    if (!after) break;
  }

  return days;
}

/** 便捷方法：取单个 Denver 自然日的真实收入。 */
export async function fetchStripeDailyRevenue(
  env: Env,
  date: string,
): Promise<StripeDailyRevenue> {
  const map = await fetchStripeRevenueRange(env, date, date);
  return map.get(date) ?? { date, revenue: 0, count: 0, byPrice: {}, refunded: 0 };
}
