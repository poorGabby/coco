import { z } from "zod";
import type { Env } from "./env.js";
import { stripeGet } from "./stripe.js";
import { reportMidnightUtcSec, REPORT_TIME_ZONE } from "./report-timezone.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => { const d = new Date(v + "T00:00:00Z"); return Number.isFinite(+d) && d.toISOString().slice(0,10) === v; });
const id = z.string().regex(/^[A-Za-z0-9_]{1,255}$/);
export const stripeExploreSchema = z.object({
  operation: z.enum(["list", "retrieve", "paying_users"]),
  resource: z.enum(["charges", "customers", "payment_intents", "refunds", "invoices", "subscriptions", "products", "prices", "subscription_items", "invoice_lines", "checkout_sessions", "checkout_line_items"]).optional(),
  id: id.optional(), customer: id.optional(), email: z.string().email().max(512).optional(),
  charge: id.optional(), paymentIntent: id.optional(),
  subscription: id.optional(), invoice: id.optional(), checkoutSession: id.optional(),
  startDate: date.optional(), endDate: date.optional(),
  startingAfter: id.optional(), limit: z.number().int().min(1).max(100).optional(),
}).strict();
export const STRIPE_EXPLORE_DESCRIPTION = "直接只读查询当前配置的 Stripe 生产账号。list/retrieve 支持 charges/customers/payment_intents/refunds/invoices/subscriptions/products/prices；必须指定resource，retrieve需id。list按startingAfter续页，不能把一页当全部；customers可按email精确查询，支付相关资源可按customer查，refunds可按charge/paymentIntent查。" +
  "paying_users 不传日期则扫描全部历史至本次查询开始，按succeeded、paid、captured且amount_captured>0的真实Charge计算累计付费Customer ID去重数；退款仍保留在曾付费中，同时给出尚有净付款的Customer去重数。另外返回支付邮箱去重数（billing_details.email优先、receipt_email回退，去空白并转小写），是邮箱数量而非自然人数。缺失customer的成功交易单独计数，不能冒充精确自然人数/kitty用户数，也不能把每日人数相加。任一页失败或扫描超限不输出伪造总数。" +
  "还支持 checkout_sessions 列表/详情，可按customer/paymentIntent/subscription筛选；subscription_items列表必传subscription，详情传id；invoice_lines列表必传invoice；checkout_line_items列表必传checkoutSession。三个行项目资源独立分页，不接受日期筛选，不能把父对象嵌套的第一页当全部。invoice_lines和checkout_line_items仅支持list。" +
  "日期按America/Dawson含首尾，按对象created归属；无日期为全部历史。只返回来源实际记录，不用Amplitude或数据库推断Stripe结果。嵌套列表has_more须另外续查；私密支付凭证已剔除。正式收入仍用fetch_daily_revenue。";

type Json = Record<string, any>;
export async function exploreStripe(env: Env, raw: unknown, get = stripeGet): Promise<Json> {
  const input = stripeExploreSchema.parse(raw);
  if (!env.stripeApiKey) throw new Error("STRIPE_API_KEY 未配置");
  const resource = input.operation === "paying_users" ? "charges" : input.resource;
  if (!resource) throw new Error("resource is required");
  const child = ["subscription_items", "invoice_lines", "checkout_line_items"].includes(resource);
  if (input.operation === "retrieve" && ["invoice_lines", "checkout_line_items"].includes(resource)) throw new Error(`${resource} supports list only`);
  const allowed = input.operation === "paying_users" ? ["operation", "startDate", "endDate"] : input.operation === "retrieve" ? ["operation", "resource", "id"] : child ?
    ["operation", "resource", "limit", "startingAfter", resource === "subscription_items" ? "subscription" : resource === "invoice_lines" ? "invoice" : "checkoutSession"] : resource === "checkout_sessions" ?
    ["operation", "resource", "limit", "startingAfter", "startDate", "endDate", "customer", "paymentIntent", "subscription"] :
    ["operation", "resource", "limit", "startingAfter", "startDate", "endDate", ...(["charges","payment_intents","invoices","subscriptions"].includes(resource) ? ["customer"] : []), ...(resource === "customers" ? ["email"] : []), ...(resource === "refunds" ? ["charge","paymentIntent"] : []), ...(resource === "charges" ? ["paymentIntent"] : [])];
  for (const k of Object.keys(input)) if (!allowed.includes(k)) throw new Error(`${input.operation}/${resource} does not support ${k}`);
  if (input.operation === "retrieve" && !input.id) throw new Error("retrieve requires id");
  if (input.operation === "list" && child && !(resource === "subscription_items" ? input.subscription : resource === "invoice_lines" ? input.invoice : input.checkoutSession)) throw new Error(`${resource} requires its parent identifier`);
  if (input.startDate && input.endDate && input.startDate > input.endDate) throw new Error("startDate must not exceed endDate");
  const fetchedAt = new Date().toISOString(), cutoff = Math.floor(Date.now()/1000), params = new URLSearchParams();
  if (input.startDate) params.set("created[gte]", String(reportMidnightUtcSec(input.startDate)));
  if (input.endDate) params.set("created[lt]", String(reportMidnightUtcSec(input.endDate) + 86400));
  if (input.operation === "paying_users") params.set("created[lt]", String(Math.min(cutoff, Number(params.get("created[lt]") ?? cutoff))));
  const request = async (p: URLSearchParams) => {
    const path = resource === "checkout_sessions" ? "checkout/sessions" : resource === "invoice_lines" ? `invoices/${input.invoice}/lines` : resource === "checkout_line_items" ? `checkout/sessions/${input.checkoutSession}/line_items` : resource;
    const { status, json } = await get(env.stripeApiKey, `/v1/${path}${input.operation === "retrieve" ? "/" + input.id : "?" + p}`);
    if (status !== 200 || json.error) throw new Error(`Stripe ${resource}: HTTP ${status}`);
    return json as Json;
  };
  const base = { source: "Stripe API", scope: "configured account", fetchedAt, timezone: REPORT_TIME_ZONE, query: input };
  if (input.operation === "paying_users") {
    params.set("limit", "100");
    const customers = new Set<string>(), netCustomers = new Set<string>(), paymentEmails = new Set<string>();
    let scanned = 0, successful = 0, missingCustomer = 0, fullyRefunded = 0, disputed = 0, missingEmail = 0, emailConflicts = 0;
    const deadline = Date.now() + 150000;
    for (let page = 0; page < 2000; page++) {
      if (Date.now() > deadline) throw new Error("Stripe historical scan exceeded150 seconds; no complete total. Narrow dates or use offline scan; never sum period user counts");
      const r = await request(params);
      if (!Array.isArray(r.data) || typeof r.has_more !== "boolean") throw new Error("Invalid Stripe charge page");
      for (const c of r.data) {
        scanned++;
        if (c.livemode !== true) throw new Error("Stripe test-mode data cannot be used for production metrics");
        if (c.status !== "succeeded" || c.paid !== true || c.captured !== true) continue;
        if (!Number.isSafeInteger(c.amount_captured) || !Number.isSafeInteger(c.amount_refunded) || c.amount_captured < 0 || c.amount_refunded < 0 || c.amount_refunded > c.amount_captured) throw new Error("Invalid Stripe captured/refunded amount");
        if (c.amount_captured === 0) continue;
        const email = (v: unknown) => typeof v === "string" && z.email().safeParse(v.trim()).success ? v.trim().toLowerCase() : null;
        const billingEmail = email(c.billing_details?.email), receiptEmail = email(c.receipt_email);
        if (billingEmail && receiptEmail && billingEmail !== receiptEmail) emailConflicts++;
        const paymentEmail = billingEmail ?? receiptEmail; if (paymentEmail) paymentEmails.add(paymentEmail); else missingEmail++;
        successful++; if (c.disputed) disputed++; if (c.amount_captured === c.amount_refunded) fullyRefunded++;
        if (typeof c.customer === "string" && c.customer.startsWith("cus_")) { customers.add(c.customer); if (c.amount_captured > c.amount_refunded) netCustomers.add(c.customer); }
        else if (c.customer == null) missingCustomer++; else throw new Error("Unexpected Stripe customer identifier");
      }
      if (!r.has_more) return { ...base, scanComplete: true, chargeCreatedBeforeUtc: new Date(Number(params.get("created[lt]"))*1000).toISOString(), scannedCharges: scanned, successfulCapturedCharges: successful,
        uniquePayingCustomers: customers.size, uniquePayingEmailAddresses: paymentEmails.size, successfulChargesWithoutEmail: missingEmail, conflictingEmailCharges: emailConflicts, uniqueCustomersWithNetPayment: netCustomers.size, successfulChargesWithoutCustomer: missingCustomer,
        fullyRefundedCharges: fullyRefunded, disputedSuccessfulCharges: disputed, pages: page + 1,
        notes: ["支付邮箱去重数取billing_details.email，缺失时取receipt_email，去首尾空白并转小写；冲突取billing并单列次数。邮箱不是自然人或kitty用户，不能与Customer去重数相加。", "累计曾付费按Stripe Customer ID去重，包含后来退款或争议的真实成功扣款；无customer交易不计入去重人数。一个自然人可能有多个Customer，不能称kitty用户数。", "净付款人数按至少一笔扣款尚未全额退款计算，争议不自动扣除。跨币种只数人，不汇总金额。截止时刻固定，但扫描期间退款等变化仍可能影响结果。"] };
      const after = r.data.at(-1)?.id;
      if (typeof after !== "string" || after === params.get("starting_after")) throw new Error("Stripe returned an invalid continuation cursor");
      params.set("starting_after", after);
    }
    throw new Error("Stripe historical scan exceeded2000 pages; no complete total");
  }
  if (input.operation === "list") {
    params.set("limit", String(input.limit ?? 25));
    if (resource === "subscriptions") params.set("status", "all");
    for (const [k,v] of Object.entries({customer:input.customer,email:input.email,charge:input.charge,payment_intent:input.paymentIntent,subscription:input.subscription,starting_after:input.startingAfter})) if(v) params.set(k,v);
  }
  const data = await request(params);
  if (input.operation === "list" && (!Array.isArray(data.data) || typeof data.has_more !== "boolean" || (data.has_more && !data.data.at(-1)?.id))) throw new Error("Invalid Stripe list response");
  const clean = (v: any): any => Array.isArray(v) ? v.map(clean) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => (k === "number" && v.object === "invoice") || (!/secret|token|cvc|fingerprint/i.test(k) && !/^(?:number|account_number|routing_number)$/i.test(k))).map(([k,x]) => [k,clean(x)])) : v;
  const output = clean(data);
  if (JSON.stringify(output).length > 60000) throw new Error("Stripe result too large; lower limit");
  return { ...base, data: output, nextStartingAfter: data.has_more ? data.data.at(-1).id : null, notes: ["直接读取Stripe对象；只代表此账号，不推断kitty身份或未接入渠道。退款/订阅来自Stripe真实记录，仅用户询问时展示。嵌套列表可能仍有has_more；支付凭证字段已剔除。"] };
}
