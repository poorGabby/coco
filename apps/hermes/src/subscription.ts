import { z } from "zod";
import type { Env } from "./env.js";

const goUserId = z.string().regex(/^[1-9]\d{0,19}$/).refine(
  (id) => BigInt(id) <= 18_446_744_073_709_551_615n,
  "Go user ID exceeds uint64",
);
export const subscriptionInputSchema = z.object({ goUserId });
export const SUBSCRIPTION_DESCRIPTION =
  "按已确认的 Go 后台数字用户 ID 查询订阅状态、到期时间和套餐。ID 必须以字符串传入。" +
  "不能传 kitty UUID，不能按邮箱猜测两套用户的映射。hasAccess=null 表示未知；" +
  "取消续费不等于立即失去权益，必须结合到期时间。结果为 Go 后台存储状态，不是 RevenueCat 实时查询。";

const userSchema = z.object({
  id: goUserId,
  subscription_status: z.string().min(1),
  subscription_expires_at: z.string().datetime({ offset: true }).nullish(),
  subscription_product_id: z.string().optional(),
  subscription_provider: z.string().optional(),
  plan_tier: z.string(),
  updated_at: z.string().datetime({ offset: true }),
});

export function subscriptionConfigured(env: Env): boolean {
  return !!(env.goBackendOrigin && env.goBackendBearerToken);
}

export async function lookupSubscription(env: Env, input: unknown) {
  const { goUserId: id } = subscriptionInputSchema.parse(input);
  if (!subscriptionConfigured(env)) throw new Error("Go subscription source is not configured");
  const origin = new URL(env.goBackendOrigin!);
  if (origin.protocol !== "https:" || origin.username || origin.password ||
      origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("Go backend must be a verified HTTPS origin without credentials or a path");
  }
  const source = new URL(`/api/admin/v1/users/${id}`, origin).href;
  let body: unknown;
  try {
    const signal = AbortSignal.timeout(15_000);
    const headers: Record<string, string> = { Authorization: `Bearer ${env.goBackendBearerToken}` };
    if (env.goBackendIamAudience) {
      const audience = new URL(env.goBackendIamAudience);
      if (audience.protocol !== "https:" || audience.username || audience.password ||
          audience.pathname !== "/" || audience.search || audience.hash) throw new Error("Invalid IAM audience");
      const metadata = new URL("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity");
      metadata.searchParams.set("audience", env.goBackendIamAudience);
      metadata.searchParams.set("format", "full");
      const identity = await fetch(metadata.href, {
        method: "GET", headers: { "Metadata-Flavor": "Google" }, redirect: "error", signal,
      });
      if (!identity.ok) throw new Error("IAM identity unavailable");
      const token = (await identity.text()).trim();
      if (token.length > 16_384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
        throw new Error("Invalid IAM identity response");
      }
      headers["X-Serverless-Authorization"] = `Bearer ${token}`;
    }
    const response = await fetch(source, {
      method: "GET",
      headers,
      redirect: "error",
      signal,
    });
    if (!response.ok) throw new Error("HTTP failure");
    // Go Snowflake IDs exceed JS safe integers. Node 22 preserves the JSON token here.
    body = JSON.parse(await response.text(), (key, value, context?: { source?: string }) =>
      key === "id" && typeof value === "number" ? context?.source : value);
  } catch {
    throw new Error("Go subscription request failed; check connectivity, authentication and response format");
  }
  const envelope = z.object({ code: z.number().int(), data: z.unknown() }).safeParse(body);
  if (!envelope.success) throw new Error("Invalid Go subscription response");
  if (envelope.data.code === 10004) {
    return { found: false, goUserId: id, hasAccess: null, source, checkedAt: new Date().toISOString() };
  }
  if (envelope.data.code !== 0) throw new Error(`Go backend rejected subscription query (code ${envelope.data.code})`);
  const parsed = userSchema.safeParse(envelope.data.data);
  if (!parsed.success || parsed.data.id !== id) throw new Error("Invalid or mismatched Go subscription user");
  const user = parsed.data;
  const checkedAt = new Date();
  const accessStates = ["trialing", "active", "cancelled", "in_grace_period", "in_billing_retry"];
  const noAccessStates = ["none", "paused", "expired", "incomplete"];
  // Mirrors entity.User.HasActiveSubscription at Go ref 1b67d49; unknown stays unknown.
  const hasAccess = accessStates.includes(user.subscription_status)
    ? !user.subscription_expires_at || checkedAt.getTime() <= Date.parse(user.subscription_expires_at)
    : noAccessStates.includes(user.subscription_status) ? false : null;
  return {
    found: true,
    goUserId: id,
    status: user.subscription_status,
    hasAccess,
    expiresAt: user.subscription_expires_at ?? null,
    productId: user.subscription_product_id ?? null,
    provider: user.subscription_provider ?? null,
    planTier: user.plan_tier,
    sourceUpdatedAt: user.updated_at,
    checkedAt: checkedAt.toISOString(),
    source,
    accessRuleRef: "Simon--yang/go-furever@1b67d49a714757a9d1a972fc62fbfd5ee429e36b:internal/domain/entity/user.go",
    note: "Go backend stored state; kitty identity mapping is not verified. Not a live RevenueCat check.",
  };
}
