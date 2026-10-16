import https from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { Env } from "./env.js";
import { reportDateOfEpochSec, reportMidnightUtcSec } from "./report-timezone.js";

/**
 * Stripe 数据源（真实支付流水）。
 *
 * 设计意图：作为可复用的「数据源 Skill」——日报的 Daily Revenue 与自由问答的
 * 收入工具都从这里取数，保证卡片与聊天的收入口径永远一致，不再各算各的。
 *
 * 口径：以 America/Dawson（固定 UTC-7）自然日归集 `succeeded && paid` 的 charge，
 * revenue = Σ(amount − amount_refunded)。退款归属于原始 Charge 创建日；
 * 历史日期可能随该 Charge 后续退款而变化。时区与日报保持一致。
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface StripeDailyRevenue {
  /** Dawson 自然日 YYYY-MM-DD */
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

/** 某个 Dawson 自然日 00:00 对应的 UTC 秒级时间戳（固定 UTC-7）。 */
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

export interface StripeCharge {
  id: string;
  amount: number;
  amount_refunded?: number;
  created: number;
  status: string;
  paid: boolean;
  currency: string;
  livemode: boolean;
}

/** 将单笔 Stripe Charge 安全归入已预置的 Dawson 日桶。 */
export function applyStripeCharge(
  days: Map<string, StripeDailyRevenue>,
  charge: StripeCharge,
): void {
  if (charge.status !== "succeeded" || !charge.paid) return;
  if (!charge.livemode) {
    throw new Error("Stripe test-mode charge cannot be included in production Daily Revenue");
  }
  if (charge.currency.toLowerCase() !== "usd") {
    throw new Error(`Stripe Daily Revenue is USD-only; received ${charge.currency}`);
  }
  const refunded = charge.amount_refunded ?? 0;
  if (!Number.isInteger(charge.amount) || !Number.isInteger(refunded) || charge.amount < 0 || refunded < 0 || refunded > charge.amount) {
    throw new Error("Stripe charge contains an invalid amount or refund amount");
  }
  const day = reportDateOfEpochSec(charge.created);
  const entry = days.get(day);
  if (!entry) return;
  const net = charge.amount - refunded;
  entry.revenue = round2(entry.revenue + net / 100);
  entry.refunded = round2(entry.refunded + refunded / 100);
  entry.count += 1;
  const priceLabel = (charge.amount / 100).toFixed(2);
  entry.byPrice[priceLabel] = (entry.byPrice[priceLabel] ?? 0) + 1;
}

export function stripeGet(
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
        let size = 0;
        res.on("data", (c) => { size += c.length; if (size > 16 * 1024 * 1024) { req.destroy(new Error("Stripe response exceeds 16 MiB")); return; } chunks.push(c as Buffer); });
        res.on("error", reject);
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
    // Socket timeouts do not cover a stalled proxy/DNS connection; bound wall time too.
    const deadline = setTimeout(() => req.destroy(new Error("Stripe request deadline (30s)")), 30_000);
    req.on("close", () => clearTimeout(deadline));
    req.on("error", reject);
    req.end();
  });
}

/**
 * 拉取 [startDate, endDate]（含端点，均为 Dawson 自然日）逐日的真实收入。
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
  const gte = reportMidnightUtcSec(startDate);
  const lt = reportMidnightUtcSec(addDays(endDate, 1));

  // 预置区间内每一天，保证缺数据的日子也返回 0 而不是缺失
  const days = new Map<string, StripeDailyRevenue>();
  for (let d = startDate; d <= endDate; d = addDays(d, 1)) {
    days.set(d, { date: d, revenue: 0, count: 0, byPrice: {}, refunded: 0 });
  }

  let after: string | undefined;
  let paginationComplete = false;
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
      applyStripeCharge(days, c);
    }
    if (!json.has_more) {
      paginationComplete = true;
      break;
    }
    after = data[data.length - 1]?.id;
    if (!after) throw new Error("Stripe pagination returned has_more without a continuation id");
  }
  if (!paginationComplete) throw new Error("Stripe charge query exceeded the 100-page safety limit");

  return days;
}

/** 便捷方法：取单个 Dawson 自然日的真实收入。 */
export async function fetchStripeDailyRevenue(
  env: Env,
  date: string,
): Promise<StripeDailyRevenue> {
  const map = await fetchStripeRevenueRange(env, date, date);
  return map.get(date) ?? { date, revenue: 0, count: 0, byPrice: {}, refunded: 0 };
}
