/**
 * CoCo 业务数据 MCP Server（Streamable HTTP）。
 *
 * 按交接文档模式：Hermes Gateway 通过 config.yaml mcp_servers 远程调用本端点，
 * 工具实现复用 agent/tools.ts 的 buildToolRegistry（Stripe / Amplitude 同源）。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Env } from "./env.js";
import { buildToolRegistry } from "./agent/tools.js";
import { generateDailyReport } from "./report.js";

function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true as const,
  };
}

/** 每个请求新建 server（stateless），避免会话状态泄漏。 */
export function createCocoMcpServer(env: Env): McpServer {
  const registry = buildToolRegistry(env);
  const server = new McpServer({ name: "coco-data", version: "1.0.0" });

  server.registerTool(
    "fetch_daily_revenue",
    {
      description:
        "计算 Daily Revenue（营收）。优先 Stripe 真实支付流水。" +
        "时区 America/Denver。默认最近完结日——除非用户明确给历史区间，否则不要传 startDate/endDate。" +
        "一次只查收入；问收入必须用本工具。",
      inputSchema: {
        startDate: z.string().optional().describe("起始日 YYYY-MM-DD（美区）。默认勿传"),
        endDate: z.string().optional().describe("结束日 YYYY-MM-DD（美区）。默认勿传；若晚于完结日会自动 clamp"),
      },
    },
    async (args) => {
      try {
        return textResult(await registry.fetch_daily_revenue(args as Record<string, unknown>));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "fetch_amplitude_metric",
    {
      description:
        "拉取 Amplitude 分日指标 DAU / WAU / New_Users。时区 America/Denver。" +
        "默认最近完结日——不要传日期，除非用户明确给区间。一次只传一个 metricName。" +
        "不负责购买人数或收入。",
      inputSchema: {
        metricName: z.enum(["DAU", "WAU", "New_Users"]).describe("指标名（一次一个）"),
        startDate: z.string().optional().describe("起始日 YYYY-MM-DD（美区）。默认勿传"),
        endDate: z.string().optional().describe("结束日 YYYY-MM-DD（美区）。默认勿传"),
        groupByProp: z.string().optional().describe('按事件属性分组，如 "product"'),
      },
    },
    async (args) => {
      try {
        return textResult(await registry.fetch_amplitude_metric(args as Record<string, unknown>));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "fetch_purchase_users",
    {
      description:
        "购买去重人数。问「多少人购买」用本工具。默认最近完结日，不要传日期（除非用户明确给区间）。",
      inputSchema: {
        startDate: z.string().optional().describe("起始日 YYYY-MM-DD（美区）。默认勿传"),
        endDate: z.string().optional().describe("结束日 YYYY-MM-DD（美区）。默认勿传"),
      },
    },
    async (args) => {
      try {
        return textResult(await registry.fetch_purchase_users(args as Record<string, unknown>));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  /**
   * 只生成飞书 Card JSON 2.0（可折叠警报/关注），不负责发送。
   * 发送必须由 GCE Hermes VM 用正式 FEISHU_* 凭证完成（交接：Cloud Run 不做发消息入口）。
   */
  server.registerTool(
    "build_daily_report_card",
    {
      description:
        "生成 Furever Dock 正式日报的飞书 interactive Card JSON 2.0（蓝头、可折叠核心指标/警报/关注/假设）。" +
        "本工具只返回 JSON，不发送消息。要「卡片视图」时必须先调本工具，再由 VM 发送脚本发出；" +
        "禁止用 Markdown 长文冒充卡片。",
      inputSchema: {},
    },
    async () => {
      try {
        const card = await generateDailyReport(env);
        const header = card.header as
          | { title?: { content?: string }; subtitle?: { content?: string } }
          | undefined;
        return textResult({
          ok: true,
          card,
          title: header?.title?.content ?? null,
          subtitle: header?.subtitle?.content ?? null,
          note: "Card JSON only — send via VM script send-feishu-interactive.sh with chat_id",
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}

/** 处理一条 MCP HTTP 请求（Web Standard Request → Response）。 */
export async function handleCocoMcpRequest(env: Env, request: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport();
  const server = createCocoMcpServer(env);
  await server.connect(transport);
  return transport.handleRequest(request);
}
