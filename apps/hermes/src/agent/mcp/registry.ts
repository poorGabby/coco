import type { ToolDeclaration, ToolRegistry } from "../tools.js";

/**
 * MCP → Gemini 的纯翻译层（无网络，可单测）。
 *
 * 设计意图（对齐北极星）：MCP server 暴露的工具在这里被转成与本地工具
 * 完全同构的 ToolDeclaration / ToolRegistry 条目，合并进 buildToolRegistry
 * 后对模型无差别。新增数据源 = 注册 server，不改内核。
 */

/** MCP server 通过 listTools 返回的工具定义（只取我们需要的字段）。 */
export interface McpToolDef {
  name: string;
  description?: string;
  /** JSON Schema（MCP 的 inputSchema）；会被裁剪成 Gemini 的 OpenAPI 子集。 */
  inputSchema?: unknown;
}

/** 后端真正调用 MCP 工具的执行器。serverName + 原始 toolName 用于路由。 */
export type McpCallFn = (
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

const NAME_SAFE = /[^a-zA-Z0-9_.-]/g;
const MAX_NAME_LEN = 63;

function sanitizeSegment(s: string): string {
  return s.replace(NAME_SAFE, "_");
}

/** 生成带命名空间的 Gemini 工具名：mcp__<server>__<tool>，并裁剪到合法长度。 */
export function mcpToolFullName(serverName: string, toolName: string): string {
  const full = `mcp__${sanitizeSegment(serverName)}__${sanitizeSegment(toolName)}`;
  return full.length <= MAX_NAME_LEN ? full : full.slice(0, MAX_NAME_LEN);
}

/** Gemini function parameters 支持的 OpenAPI 子集字段。 */
const ALLOWED_SCHEMA_KEYS = new Set([
  "type",
  "description",
  "enum",
  "items",
  "properties",
  "required",
  "format",
  "nullable",
]);

/** 递归裁剪 JSON Schema → Gemini 可接受的子集；丢弃 $schema/additionalProperties/title 等。 */
export function sanitizeSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }
  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(src)) {
    if (!ALLOWED_SCHEMA_KEYS.has(key)) continue;

    if (key === "type") {
      // JSON Schema 允许 type 为数组（如 ["string","null"]）；Gemini 要单个字符串。
      if (Array.isArray(val)) {
        const nonNull = val.find((t) => t !== "null");
        out.type = typeof nonNull === "string" ? nonNull : "string";
        if (val.includes("null")) out.nullable = true;
      } else if (typeof val === "string") {
        out.type = val;
      }
    } else if (key === "properties" && val && typeof val === "object") {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(val as Record<string, unknown>)) {
        props[pk] = sanitizeSchema(pv);
      }
      out.properties = props;
    } else if (key === "items") {
      out.items = sanitizeSchema(val);
    } else {
      out[key] = val;
    }
  }

  if (!out.type) out.type = "object";
  if (out.type === "object" && !out.properties) out.properties = {};
  return out;
}

/** 把某个 server 的 MCP 工具转成 Gemini 工具声明（名字带命名空间，schema 已裁剪）。 */
export function buildMcpToolDeclarations(
  serverName: string,
  tools: McpToolDef[],
): ToolDeclaration[] {
  return tools.map((t) => ({
    name: mcpToolFullName(serverName, t.name),
    description: `[MCP:${serverName}] ${t.description ?? t.name}`.slice(0, 1024),
    parameters: sanitizeSchema(t.inputSchema),
  }));
}

/**
 * 生成 registry：Gemini 工具名 → 执行函数。执行时用**原始** toolName 路由到 server，
 * 因此即使工具名被 sanitize/截断，也能正确回调 MCP。
 */
export function buildMcpToolRegistry(
  serverName: string,
  tools: McpToolDef[],
  call: McpCallFn,
): ToolRegistry {
  const reg: ToolRegistry = {};
  for (const t of tools) {
    const fullName = mcpToolFullName(serverName, t.name);
    const originalName = t.name;
    reg[fullName] = (args) => call(serverName, originalName, args);
  }
  return reg;
}
