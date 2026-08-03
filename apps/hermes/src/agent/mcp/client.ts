import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Env } from "../../env.js";
import type { ToolDeclaration, ToolRegistry } from "../tools.js";
import {
  buildMcpToolDeclarations,
  buildMcpToolRegistry,
  type McpToolDef,
} from "./registry.js";

/**
 * MCP 客户端接入层。
 *
 * 职责：按配置连接 MCP server → 发现其工具 → 交给 registry 翻译成 Gemini 工具。
 * 一切失败都**静默降级**（跳过该 server），保证问答链路永不因 MCP 挂掉而中断。
 * 仅在 HERMES_MCP_ENABLED 打开时被调用；关闭时行为与现状完全一致。
 */

const CONNECT_TIMEOUT_MS = 8_000;
const CALL_TIMEOUT_MS = 30_000;

export interface McpServerConfig {
  name: string;
  transport: "http" | "sse" | "stdio";
  /** http / sse 用 */
  url?: string;
  headers?: Record<string, string>;
  /** stdio 用 */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface LoadedMcpTools {
  declarations: ToolDeclaration[];
  registry: ToolRegistry;
  /** 关闭所有连接（问答结束后调用）。 */
  close: () => Promise<void>;
  /** 已成功接入的 server 名。 */
  connected: string[];
}

/** 把字符串里的 ${ENV_VAR} 用 process.env 展开（密钥不写死在配置里）。 */
function expandEnvVars<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => process.env[k] ?? "") as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => expandEnvVars(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandEnvVars(v);
    }
    return out as unknown as T;
  }
  return value;
}

/** 从 env.hermesMcpServers（JSON 数组字符串）解析 server 配置；出错返回 []。 */
export function parseMcpServers(env: Env): McpServerConfig[] {
  const raw = env.hermesMcpServers?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn("[mcp] HERMES_MCP_SERVERS is not a JSON array, ignoring");
      return [];
    }
    return parsed
      .filter((s) => s && typeof s.name === "string" && typeof s.transport === "string")
      .map((s) => expandEnvVars(s as McpServerConfig));
  } catch (err) {
    console.warn("[mcp] failed to parse HERMES_MCP_SERVERS:", err);
    return [];
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timeout (${ms}ms)`)), ms)),
  ]);
}

function makeTransport(cfg: McpServerConfig) {
  if (cfg.transport === "stdio") {
    if (!cfg.command) throw new Error(`stdio server '${cfg.name}' missing command`);
    return new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>,
    });
  }
  if (!cfg.url) throw new Error(`${cfg.transport} server '${cfg.name}' missing url`);
  const opts = cfg.headers ? { requestInit: { headers: cfg.headers } } : undefined;
  return cfg.transport === "sse"
    ? new SSEClientTransport(new URL(cfg.url), opts)
    : new StreamableHTTPClientTransport(new URL(cfg.url), opts);
}

interface CompactToolResult {
  text: string;
  isError: boolean;
  structuredContent?: unknown;
}

function compactResult(res: unknown): CompactToolResult {
  const r = (res ?? {}) as {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
    structuredContent?: unknown;
  };
  const text = (r.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
  const out: CompactToolResult = { text, isError: !!r.isError };
  if (r.structuredContent !== undefined) out.structuredContent = r.structuredContent;
  return out;
}

/**
 * 连接所有配置的 MCP server，聚合它们的工具声明与执行 registry。
 * 任一 server 失败都会被跳过（记录日志），不影响其他 server 与本地工具。
 */
export async function loadMcpTools(env: Env): Promise<LoadedMcpTools> {
  const configs = parseMcpServers(env);
  const declarations: ToolDeclaration[] = [];
  const registry: ToolRegistry = {};
  const clients: Client[] = [];
  const connected: string[] = [];

  for (const cfg of configs) {
    let client: Client | null = null;
    try {
      client = new Client({ name: "coco-agent", version: "1.0.0" }, { capabilities: {} });
      const transport = makeTransport(cfg);
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `mcp connect ${cfg.name}`);
      const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `mcp listTools ${cfg.name}`);
      const tools: McpToolDef[] = (listed.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));

      const connectedClient = client;
      const call = async (_server: string, toolName: string, args: Record<string, unknown>) => {
        const res = await withTimeout(
          connectedClient.callTool({ name: toolName, arguments: args }),
          CALL_TIMEOUT_MS,
          `mcp call ${cfg.name}.${toolName}`,
        );
        return compactResult(res);
      };

      declarations.push(...buildMcpToolDeclarations(cfg.name, tools));
      Object.assign(registry, buildMcpToolRegistry(cfg.name, tools, call));
      clients.push(client);
      connected.push(cfg.name);
      console.log(`[mcp] connected '${cfg.name}' (${cfg.transport}) → ${tools.length} tools`);
    } catch (err) {
      console.warn(
        `[mcp] server '${cfg.name}' unavailable, skipping:`,
        err instanceof Error ? err.message : String(err),
      );
      if (client) await client.close().catch(() => {});
    }
  }

  return {
    declarations,
    registry,
    connected,
    close: async () => {
      for (const c of clients) await c.close().catch(() => {});
    },
  };
}
