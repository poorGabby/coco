import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mcpToolFullName,
  sanitizeSchema,
  buildMcpToolDeclarations,
  buildMcpToolRegistry,
  type McpToolDef,
} from "./registry.js";

test("mcpToolFullName: 命名空间 + 非法字符净化 + 截断", () => {
  assert.equal(mcpToolFullName("notion", "search"), "mcp__notion__search");
  assert.equal(mcpToolFullName("my server", "do:it"), "mcp__my_server__do_it");
  const long = mcpToolFullName("s".repeat(80), "t".repeat(80));
  assert.ok(long.length <= 63);
});

test("sanitizeSchema: 丢弃不支持的字段，保留 OpenAPI 子集", () => {
  const out = sanitizeSchema({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    title: "X",
    properties: {
      q: { type: "string", description: "query", minLength: 1 },
    },
    required: ["q"],
  });
  assert.equal(out.type, "object");
  assert.deepEqual(out.required, ["q"]);
  assert.equal((out as any).$schema, undefined);
  assert.equal((out as any).additionalProperties, undefined);
  assert.equal((out as any).title, undefined);
  const q = (out.properties as any).q;
  assert.equal(q.type, "string");
  assert.equal(q.description, "query");
  assert.equal(q.minLength, undefined); // 不在白名单
});

test("sanitizeSchema: type 数组 → 单类型 + nullable", () => {
  const out = sanitizeSchema({ type: ["string", "null"] });
  assert.equal(out.type, "string");
  assert.equal(out.nullable, true);
});

test("sanitizeSchema: 空/非对象 → 默认 object", () => {
  assert.deepEqual(sanitizeSchema(undefined), { type: "object", properties: {} });
  assert.deepEqual(sanitizeSchema("nope"), { type: "object", properties: {} });
});

const TOOLS: McpToolDef[] = [
  { name: "search", description: "Search docs", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
  { name: "create-page", inputSchema: undefined },
];

test("buildMcpToolDeclarations: 名字带命名空间，描述带来源前缀", () => {
  const decls = buildMcpToolDeclarations("notion", TOOLS);
  assert.equal(decls.length, 2);
  assert.equal(decls[0].name, "mcp__notion__search");
  assert.match(decls[0].description, /\[MCP:notion\]/);
  assert.equal((decls[1].parameters as any).type, "object");
});

test("buildMcpToolRegistry: 用原始 toolName 路由，即使名字被净化", async () => {
  const calls: Array<{ server: string; tool: string; args: unknown }> = [];
  const reg = buildMcpToolRegistry("notion", TOOLS, async (server, tool, args) => {
    calls.push({ server, tool, args });
    return { ok: true };
  });
  await reg["mcp__notion__create-page"]({ title: "hi" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].server, "notion");
  assert.equal(calls[0].tool, "create-page"); // 原始名，非净化名
  assert.deepEqual(calls[0].args, { title: "hi" });
});
