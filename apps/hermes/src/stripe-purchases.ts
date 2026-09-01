import https from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { Env } from "./env.js";

export type PurchaseProduct = "secondPet" | "pocket" | "stash" | "bigBag";
export type StripePurchaseDay = {
  date: string;
  users: Record<PurchaseProduct, Set<string>>;
  quantities: Record<PurchaseProduct, number>;
  quantityGtOneLineItems?: number;
  multiProductSessions?: number;
  repeatedUserProductPurchases?: number;
};

const TZ = "America/Denver";
const MAX_PAGES_PER_DAY = 100;
const MAX_CONCURRENT_DAYS = 4;
const emptyUsers = (): Record<PurchaseProduct, Set<string>> => ({
  secondPet: new Set(), pocket: new Set(), stash: new Set(), bigBag: new Set(),
});
const emptyQuantities = (): Record<PurchaseProduct, number> => ({ secondPet: 0, pocket: 0, stash: 0, bigBag: 0 });

function emptyDay(date: string): StripePurchaseDay {
  return {
    date,
    users: emptyUsers(),
    quantities: emptyQuantities(),
    quantityGtOneLineItems: 0,
    multiProductSessions: 0,
    repeatedUserProductPurchases: 0,
  };
}

/** 固化 Stripe 生产商品映射。名称只用于人工核对，不参与归类。 */
export const STRIPE_PRODUCT_MAPPING = {
  secondPet: { name: "Furever Adoption", productId: "prod_UoIsRWnwK1YH9L", priceId: "price_1TogGSJclbiyrOhAU8DPpWgy" },
  pocket: { name: "Pocket Treats", productId: "prod_V1gnbqbKhuOEjS", priceId: "price_1U1dPcJclbiyrOhAw1yS0Il3" },
  stash: { name: "Treat Stash", productId: "prod_V1gnHp89wLi2sQ", priceId: "price_1U1dPZJclbiyrOhAJm2dY3ZW" },
  bigBag: { name: "Big Bag of Treats", productId: "prod_V1gnpe514tgpVL", priceId: "price_1U1dPVJclbiyrOhAagYHDLqU" },
} as const;

type CheckoutSession = {
  id: string; created: number; payment_status: string;
  customer?: string | null;
  customer_details?: { email?: string | null } | null;
  line_items?: { data?: Array<{ quantity?: number; price?: { id?: string; product?: string | { id?: string } } | null }> };
};

function get(apiKey: string, path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  return new Promise((resolve, reject) => {
    const req = https.request(`https://api.stripe.com${path}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      agent: proxy ? new HttpsProxyAgent(proxy) : undefined,
      timeout: 30_000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk as Buffer));
      res.on("end", () => { try { resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (e) { reject(e); } });
    });
    req.on("timeout", () => req.destroy(new Error("Stripe request timeout (30s)")));
    req.on("error", reject); req.end();
  });
}

function productOf(priceId: string | undefined, productId: string | undefined): PurchaseProduct | null {
  for (const [kind, mapping] of Object.entries(STRIPE_PRODUCT_MAPPING) as Array<[PurchaseProduct, (typeof STRIPE_PRODUCT_MAPPING)[PurchaseProduct]]>) {
    if (mapping.priceId === priceId && mapping.productId === productId) return kind;
  }
  return null;
}

/** Stripe 商品购买用户：只读取已支付 Checkout Session 的 line item ID。 */
export async function fetchStripePurchaseRange(env: Env, startDate: string, endDate: string): Promise<Map<string, StripePurchaseDay>> {
  if (!env.stripeApiKey) throw new Error("STRIPE_API_KEY 未配置");
  const dates: string[] = [];
  for (let d = startDate; d <= endDate; d = addDays(d, 1)) dates.push(d);

  // Stripe cursors are sequential within a query. Splitting by Denver day lets
  // the eight-day report window make progress in parallel without changing the
  // paid-session or product classification rules.
  const days = new Map<string, StripePurchaseDay>();
  for (let index = 0; index < dates.length; index += MAX_CONCURRENT_DAYS) {
    const batch = dates.slice(index, index + MAX_CONCURRENT_DAYS);
    const fetched = await Promise.all(batch.map((date) => fetchStripePurchaseDay(env, date)));
    for (const day of fetched) days.set(day.date, day);
  }
  return days;
}

async function fetchStripePurchaseDay(env: Env, date: string): Promise<StripePurchaseDay> {
  const day = emptyDay(date);
  const gte = denverMidnightUtcSec(date);
  const lt = denverMidnightUtcSec(addDays(date, 1));
  let after: string | undefined;

  for (let page = 0; page < MAX_PAGES_PER_DAY; page++) {
    const query = `/v1/checkout/sessions?limit=100&created[gte]=${gte}&created[lt]=${lt}&expand[]=data.line_items${after ? `&starting_after=${after}` : ""}`;
    const { status, json } = await get(env.stripeApiKey, query);
    if (status !== 200) throw new Error(`Stripe /v1/checkout/sessions ${status}`);
    const sessions = json.data as CheckoutSession[] ?? [];
    console.log(`[stripe] purchase sessions ${date}: page ${page + 1}, ${sessions.length} items, has_more=${Boolean(json.has_more)}`);

    for (const session of sessions) {
      if (session.payment_status !== "paid") continue;
      const recognizedProducts = new Set<PurchaseProduct>();
      for (const lineItem of session.line_items?.data ?? []) {
        const price = lineItem.price;
        const productId = typeof price?.product === "string" ? price.product : price?.product?.id;
        const product = productOf(price?.id, productId);
        if (!product) continue;
        recognizedProducts.add(product);
        const user = session.customer || session.customer_details?.email?.trim().toLowerCase();
        const quantity = Number.isInteger(lineItem.quantity) && (lineItem.quantity ?? 0) > 0 ? lineItem.quantity! : 1;
        if (quantity > 1) day.quantityGtOneLineItems = (day.quantityGtOneLineItems ?? 0) + 1;
        day.quantities[product] += quantity;
        if (user) {
          if (day.users[product].has(user)) day.repeatedUserProductPurchases = (day.repeatedUserProductPurchases ?? 0) + 1;
          day.users[product].add(user);
        }
      }
      if (recognizedProducts.size > 1) day.multiProductSessions = (day.multiProductSessions ?? 0) + 1;
    }
    if (!json.has_more || sessions.length === 0) break;
    after = sessions[sessions.length - 1]?.id;
    if (!after) break;
  }

  return day;
}

function addDays(date: string, delta: number): string { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + delta); return d.toISOString().slice(0, 10); }
function denverMidnightUtcSec(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d, 12));
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour12: false, hour: "2-digit" }).format(probe));
  return Date.UTC(y, m - 1, d, 12 - hour) / 1000;
}

export function stripePurchaseCounts(day: StripePurchaseDay | undefined) {
  const users = day?.users ?? emptyUsers();
  const treats = new Set([...users.pocket, ...users.stash, ...users.bigBag]);
  const quantities = day?.quantities ?? emptyQuantities();
  return { total: new Set([...users.secondPet, ...treats]).size, secondPet: users.secondPet.size, treats: treats.size, pocket: users.pocket.size, stash: users.stash.size, bigBag: users.bigBag.size, secondPetQuantity: quantities.secondPet, pocketQuantity: quantities.pocket, stashQuantity: quantities.stash, bigBagQuantity: quantities.bigBag };
}

export function stripePurchaseRevenue(day: StripePurchaseDay | undefined): number {
  const q = day?.quantities ?? emptyQuantities();
  return Math.round((q.secondPet * 6.99 + q.pocket * 1.99 + q.stash * 4.99 + q.bigBag * 9.99) * 100) / 100;
}

export type StripePurchaseMetric = "second_pet" | "treats" | "pocket" | "stash" | "big_bag";
export async function fetchStripePurchaseMetric(env: Env, metric: StripePurchaseMetric, date: string) {
  const map = await fetchStripePurchaseRange(env, addDays(date, -7), date);
  const current = stripePurchaseCounts(map.get(date));
  const previous = stripePurchaseCounts(map.get(addDays(date, -7)));
  const key = metric === "second_pet" ? "secondPet" : metric === "big_bag" ? "bigBag" : metric;
  const value = current[key];
  const previousValue = previous[key];
  return { metric, date, value, comparisonDate: addDays(date, -7), comparisonValue: previousValue, wowPct: previousValue === 0 ? null : Math.round(((value - previousValue) / previousValue) * 1000) / 10 };
}
