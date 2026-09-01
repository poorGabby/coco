import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

config({ path: resolve(here, "../../../.env") });
config({ path: resolve(here, "../.env") });

export type Env = {
  port: number;
  amplitudeApiKey: string;
  amplitudeSecretKey: string;
  amplitudeRetentionChartIds: string[];
  /** 覆盖日报 Chart 注册表；空则用 daily-charts DEFAULT_DAILY_CHARTS */
  amplitudeDailyChartIds: string;
  amplitudeDashboardUrl: string;
  feishuAppId: string;
  feishuAppSecret: string;
  feishuReportChatId: string;
  feishuBotOpenId: string;
  feishuWikiSpaceIds: string[];
  feishuWikiRootTokens: string[];
  feishuWikiDocTokens: string[];
  feishuWikiIndexDocToken: string;
  hermesCronSecret: string;
  geminiApiKey: string;
  geminiModel: string;
  wixSiteUrl: string;
  wixSiteId: string;
  wixApiKey: string;
  googleServiceAccountJson: string;
  ga4PropertyId: string;
  feishuCocoBehaviorDocToken: string;
  feishuCocoAnalysisDocToken: string;
  /** 受控 Agent 的「数据口径 Skill」飞书文档（未配置则回退 constraints.ts） */
  feishuCocoSkillDocToken: string;
  /** 受控 Agentic 自由问答开关（默认关闭，关掉即退回现有 askQuestion） */
  hermesAgentEnabled: boolean;
  /** Stripe 密钥（保留给非核心支付诊断；正式 Daily Revenue 不使用 Stripe）。 */
  stripeApiKey: string;
  /** MCP 可插拔数据源开关（默认关闭，关掉即完全等价于现状，不加载任何 MCP） */
  hermesMcpEnabled: boolean;
  /** MCP server 配置（JSON 数组字符串），仅在 hermesMcpEnabled 时生效 */
  hermesMcpServers: string;
  /** CoCo Data MCP 的 Bearer 密钥（Hermes Gateway 调用 /mcp 时校验；空=拒绝访问） */
  cocoMcpKey: string;
};

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, fallback = ""): string {
  return process.env[name]?.trim() ?? fallback;
}

export function loadEnv(): Env {
  return {
    port: Number(process.env.PORT ?? optionalEnv("PORT", "8787")),
    amplitudeApiKey: requireEnv("AMPLITUDE_API_KEY"),
    amplitudeSecretKey: requireEnv("AMPLITUDE_SECRET_KEY"),
    amplitudeRetentionChartIds: optionalEnv("AMPLITUDE_RETENTION_CHART_IDS")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
    /** 日报图表 id 列表（覆盖 daily-charts 默认注册表）；空=用 DEFAULT_DAILY_CHARTS */
    amplitudeDailyChartIds: optionalEnv("AMPLITUDE_DAILY_CHART_IDS"),
    amplitudeDashboardUrl: optionalEnv(
      "AMPLITUDE_DASHBOARD_URL",
      "https://app.amplitude.com/analytics/lollapaloozalab/dashboard/o6xkdkvf",
    ),
    feishuAppId: optionalEnv("FEISHU_APP_ID"),
    feishuAppSecret: optionalEnv("FEISHU_APP_SECRET"),
    feishuReportChatId: optionalEnv("FEISHU_REPORT_CHAT_ID"),
    feishuBotOpenId: optionalEnv("FEISHU_BOT_OPEN_ID"),
    feishuWikiSpaceIds: optionalEnv("FEISHU_WIKI_SPACE_IDS")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
    feishuWikiRootTokens: optionalEnv("FEISHU_WIKI_ROOT_TOKENS")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    feishuWikiDocTokens: optionalEnv("FEISHU_WIKI_DOC_TOKENS")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    feishuWikiIndexDocToken: optionalEnv("FEISHU_WIKI_INDEX_DOC_TOKEN"),
    hermesCronSecret: optionalEnv("HERMES_CRON_SECRET"),
    geminiApiKey: requireEnv("GEMINI_API_KEY"),
    geminiModel: optionalEnv("GEMINI_MODEL", "gemini-2.5-flash"),
    wixSiteUrl: optionalEnv("WIX_SITE_URL"),
    wixSiteId: optionalEnv("WIX_SITE_ID"),
    wixApiKey: optionalEnv("WIX_API_KEY"),
    googleServiceAccountJson: optionalEnv("GOOGLE_SERVICE_ACCOUNT_JSON"),
    ga4PropertyId: optionalEnv("GA4_PROPERTY_ID"),
    feishuCocoBehaviorDocToken: optionalEnv("FEISHU_COCO_BEHAVIOR_DOC_TOKEN"),
    feishuCocoAnalysisDocToken: optionalEnv("FEISHU_COCO_ANALYSIS_DOC_TOKEN"),
    feishuCocoSkillDocToken: optionalEnv("FEISHU_COCO_SKILL_DOC_TOKEN"),
    hermesAgentEnabled: ["1", "true", "yes", "on"].includes(
      optionalEnv("HERMES_AGENT_ENABLED").toLowerCase(),
    ),
    stripeApiKey: optionalEnv("STRIPE_API_KEY"),
    hermesMcpEnabled: ["1", "true", "yes", "on"].includes(
      optionalEnv("HERMES_MCP_ENABLED").toLowerCase(),
    ),
    hermesMcpServers: optionalEnv("HERMES_MCP_SERVERS"),
    cocoMcpKey: optionalEnv("COCO_MCP_KEY"),
  };
}

export function assertFeishuConfigured(env: Env): void {
  if (!env.feishuAppId || !env.feishuAppSecret) {
    throw new Error("FEISHU_APP_ID and FEISHU_APP_SECRET are required for Feishu integration");
  }
}
