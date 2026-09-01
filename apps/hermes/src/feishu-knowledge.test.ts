import assert from "node:assert/strict";
import { test } from "node:test";
import type { Env } from "./env.js";
import {
  FEISHU_DOCUMENT_MAX_CHARS,
  readFeishuDocument,
  searchFeishuKnowledge,
} from "./feishu-knowledge.js";
import { AGENT_TOOL_DECLARATIONS, buildToolRegistry } from "./agent/tools.js";

const env = {
  feishuAppId: "cli_test",
  feishuAppSecret: "secret_test",
  feishuWikiSpaceIds: ["allowed-space"],
} as Env;

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("知识工具使用固定 Wiki cache，读取二次校验并截断正文", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
  let rawReadCount = 0;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ url, body });
    if (url.includes("tenant_access_token/internal")) {
      return json({ code: 0, tenant_access_token: "tenant-test", expire: 7200 });
    }
    if (url.includes("/wiki/v2/spaces/allowed-space/nodes?page_size=50")) {
      return json({
        code: 0,
        data: {
          items: [
            {
              node_token: "wikiAllowed1",
              obj_type: "docx",
              title: "Furever Dock 产品定位",
              has_child: false,
            },
          ],
        },
      });
    }
    if (url.includes("/wiki/v2/spaces/get_node?token=wikiAllowed1")) {
      return json({
        code: 0,
        data: {
          node: {
            space_id: "allowed-space",
            node_token: "wikiAllowed1",
            obj_token: "docxAllowed1",
            obj_type: "docx",
            title: "Furever Dock 产品定位",
          },
        },
      });
    }
    if (url.includes("/wiki/v2/spaces/get_node?token=wikiDenied1")) {
      return json({
        code: 0,
        data: {
          node: {
            space_id: "other-space",
            node_token: "wikiDenied1",
            obj_token: "docxDenied1",
            obj_type: "docx",
            title: "Private",
          },
        },
      });
    }
    if (url.includes("/docx/v1/documents/docxAllowed1/raw_content")) {
      rawReadCount += 1;
      return json({
        code: 0,
        data: { content: `密码：should-not-leak\n${"文".repeat(FEISHU_DOCUMENT_MAX_CHARS + 5)}` },
      });
    }
    if (url.includes("/docx/v1/documents/wikiAllowed1/raw_content")) {
      rawReadCount += 1;
      return json({
        code: 0,
        data: { content: "Furever Dock 产品定位 当前产品的定位与未来发展方向。" },
      });
    }
    if (url.includes("/docx/v1/documents/docxDenied1/raw_content")) {
      rawReadCount += 1;
      throw new Error("denied document content must never be requested");
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const names = new Set(AGENT_TOOL_DECLARATIONS.map((tool) => tool.name));
  assert.ok(names.has("search_feishu_knowledge"));
  assert.ok(names.has("read_feishu_document"));
  const registry = buildToolRegistry(env);
  assert.equal(typeof registry.search_feishu_knowledge, "function");
  assert.equal(typeof registry.read_feishu_document, "function");

  const results = await searchFeishuKnowledge(env, "Dock 产品定位");
  assert.deepEqual(results, [{
    title: "Furever Dock 产品定位",
    token: "wikiAllowed1",
    type: "wiki",
    url: "https://jcnreneadm7i.feishu.cn/wiki/wikiAllowed1",
    snippet: "Furever Dock 产品定位 当前产品的定位与未来发展方向。",
    relevance: 1,
    selectionOnly: true,
  }]);
  const searchCall = calls.find((call) => call.url.endsWith("/search/v2/doc_wiki/search"));
  assert.equal(searchCall, undefined, "固定 Wiki 搜索不得依赖 Search v2");

  const document = await readFeishuDocument(env, results[0].token);
  assert.equal(document.title, "Furever Dock 产品定位");
  assert.equal(document.content.length, FEISHU_DOCUMENT_MAX_CHARS);
  assert.ok(document.contentLength > FEISHU_DOCUMENT_MAX_CHARS);
  assert.equal(document.truncated, true);
  assert.equal(document.untrustedContent, true);
  assert.deepEqual(document.citation, {
    title: "Furever Dock 产品定位",
    url: "https://jcnreneadm7i.feishu.cn/wiki/wikiAllowed1",
  });
  assert.equal(document.evidenceRole, "detail");
  assert.deepEqual(document.possibleFollowUpQueries, []);
  assert.match(document.answeringGuidance, /check every requested dimension/);
  assert.doesNotMatch(document.content, /should-not-leak/);
  assert.match(document.content, /密码：\[REDACTED\]/);
  assert.equal(rawReadCount, 2, "一次用于 cache，一次用于正式 read");

  await assert.rejects(
    () => readFeishuDocument(env, "wikiDenied1"),
    /outside FEISHU_WIKI_SPACE_IDS allowlist/,
  );
  assert.equal(rawReadCount, 2, "allowlist 校验必须发生在正文读取之前");
});

test("空 allowlist、超长 query 和非法 token 均 fail closed", async () => {
  const noSpaces = { ...env, feishuWikiSpaceIds: [] } as Env;
  await assert.rejects(() => searchFeishuKnowledge(noSpaces, "Dock"), /FEISHU_WIKI_SPACE_IDS/);
  await assert.rejects(
    () => searchFeishuKnowledge(env, "长".repeat(31)),
    /at most 30 characters/,
  );
  await assert.rejects(() => readFeishuDocument(env, "../bad"), /Invalid Feishu/);
});
