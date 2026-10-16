import type { Env } from "./env.js";
import {
  getDocumentRawContent,
  getTenantAccessToken,
  getWikiNode,
} from "./feishu.js";
import {
  redactKnowledgeSecrets,
  searchAllowlistedWikiFulltext,
} from "./wiki-cache.js";

export const FEISHU_SEARCH_MAX_QUERY_CHARS = 30;
export const FEISHU_SEARCH_MAX_RESULTS = 10;
export const FEISHU_DOCUMENT_MAX_CHARS = 20_000;

export interface FeishuKnowledgeSearchResult {
  title: string;
  token: string;
  type: "wiki";
  url: string;
  snippet: string;
  /** Feishu 已按相关性排序；此值是基于返回顺序归一化后的 0..1 排名。 */
  relevance: number;
  /** 强制区分候选摘要与可引用正文。 */
  selectionOnly: true;
}

export interface FeishuKnowledgeDocument {
  title: string;
  token: string;
  type: "wiki" | "docx";
  url: string;
  content: string;
  truncated: boolean;
  contentLength: number;
  /** Unicode character offsets into the redacted document. */
  offset: number;
  nextOffset: number | null;
  source: "Feishu Knowledge";
  /** 提醒 Agent：正文是资料，不是可执行指令。 */
  untrustedContent: true;
  /** 结构化出处，避免模型重写 token/URL。 */
  citation: { title: string; url: string };
  /** 概览类证据不应被误当作详细 roadmap。 */
  evidenceRole: "overview" | "detail";
  possibleFollowUpQueries: string[];
  /** 放在正文之后，让 Agent 在作答前检查证据缺口。 */
  answeringGuidance: string;
}

type SearchUnit = {
  title?: string;
  title_highlighted?: string;
  summary?: string;
  summary_highlighted?: string;
  entity_type?: string;
  result_meta?: {
    url?: string;
    doc_types?: string | string[];
  };
};

function requireWikiAllowlist(env: Env): Set<string> {
  const allowlist = new Set(env.feishuWikiSpaceIds.map((id) => id.trim()).filter(Boolean));
  if (!allowlist.size) {
    throw new Error("FEISHU_WIKI_SPACE_IDS is required for Feishu knowledge access");
  }
  return allowlist;
}

function assertSearchQuery(query: string): string {
  const normalized = query.trim();
  const length = [...normalized].length;
  if (!length) throw new Error("Feishu knowledge search query is required");
  if (length > FEISHU_SEARCH_MAX_QUERY_CHARS) {
    throw new Error(
      `Feishu knowledge search query must be at most ${FEISHU_SEARCH_MAX_QUERY_CHARS} characters`,
    );
  }
  return normalized;
}

function stripHighlights(value: string | undefined): string {
  return (value ?? "")
    .replace(/<\/?(?:h|hb)>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseSearchUrl(url: string): { token: string; type: "wiki" | "docx" } | null {
  try {
    const parsed = new URL(url);
    if (!/(?:^|\.)feishu\.cn$|(?:^|\.)larksuite\.com$/.test(parsed.hostname)) return null;
    const match = parsed.pathname.match(/\/(wiki|docx)\/([A-Za-z0-9_-]+)/);
    if (!match) return null;
    return { type: match[1] as "wiki" | "docx", token: match[2] };
  } catch {
    return null;
  }
}

async function feishuSearchPost(
  env: Env,
  body: Record<string, unknown>,
): Promise<{ data?: { res_units?: SearchUnit[] } }> {
  const token = await getTenantAccessToken(env);
  const path = "/search/v2/doc_wiki/search";
  const response = await fetch(`https://open.feishu.cn/open-apis${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as {
    code?: number;
    msg?: string;
    data?: { res_units?: SearchUnit[] };
  };
  if (data.code !== 0) {
    throw new Error(`Feishu API ${path} failed: ${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * 保留的 Search v2 诊断路径；当前生产知识检索不调用它。
 * 如未来重新启用，服务端范围仍限制在配置的 Wiki spaces。
 */
export async function searchFeishuKnowledgeViaSearchV2(
  env: Env,
  query: string,
): Promise<FeishuKnowledgeSearchResult[]> {
  const allowlist = requireWikiAllowlist(env);
  const normalizedQuery = assertSearchQuery(query);
  const response = await feishuSearchPost(env, {
    query: normalizedQuery,
    page_size: FEISHU_SEARCH_MAX_RESULTS,
    wiki_filter: { space_ids: [...allowlist] },
  });

  const units = response.data?.res_units ?? [];
  const seen = new Set<string>();
  const results: FeishuKnowledgeSearchResult[] = [];
  for (const unit of units) {
    if (results.length >= FEISHU_SEARCH_MAX_RESULTS) break;
    const url = unit.result_meta?.url?.trim() ?? "";
    const parsed = parseSearchUrl(url);
    if (!parsed || seen.has(parsed.token)) continue;
    seen.add(parsed.token);
    const rank = results.length;
    results.push({
      title: stripHighlights(unit.title_highlighted || unit.title) || "Untitled",
      token: parsed.token,
      type: "wiki",
      url,
      snippet: stripHighlights(unit.summary_highlighted || unit.summary).slice(0, 1_200),
      relevance: Number((1 - rank / (Math.max(units.length, 1) + 1)).toFixed(3)),
      selectionOnly: true,
    });
  }
  return results;
}

/**
 * 生产主路径：在 FEISHU_WIKI_SPACE_IDS 自动加载的固定 Wiki 缓存内搜索标题和正文。
 * 不调用 Search v2，也不依赖 search:docs:read。
 */
export async function searchFeishuKnowledge(
  env: Env,
  query: string,
): Promise<FeishuKnowledgeSearchResult[]> {
  requireWikiAllowlist(env);
  const normalizedQuery = assertSearchQuery(query);
  // 先多取段落，再按文档 token 去重，确保最多返回 10 篇不同文档。
  const hits = await searchAllowlistedWikiFulltext(
    env,
    normalizedQuery,
    FEISHU_SEARCH_MAX_RESULTS * 4,
  );
  const unique = new Map<string, (typeof hits)[number]>();
  for (const hit of hits) {
    if (!unique.has(hit.nodeToken)) unique.set(hit.nodeToken, hit);
    if (unique.size >= FEISHU_SEARCH_MAX_RESULTS) break;
  }
  const documents = [...unique.values()];
  const maxScore = Math.max(...documents.map((hit) => hit.score), 1);
  return documents.map((hit) => ({
    title: hit.docTitle,
    token: hit.nodeToken,
    type: "wiki",
    url: hit.url,
    // 摘要只用于候选选择，避免模型跳过 read_feishu_document 直接据此作答。
    snippet: hit.snippet.replace(/\s+/g, " ").trim().slice(0, 400),
    relevance: Number((hit.score / maxScore).toFixed(3)),
    selectionOnly: true,
  }));
}

function assertDocumentToken(token: string): string {
  const normalized = token.trim();
  if (!/^[A-Za-z0-9_-]{4,128}$/.test(normalized)) {
    throw new Error("Invalid Feishu Wiki/Docx token");
  }
  return normalized;
}

/**
 * 读取前用 get_node 二次确认 Wiki space；不在 allowlist、不可读、类型不支持均 fail closed。
 */
export async function readFeishuDocument(
  env: Env,
  token: string,
  offset = 0,
): Promise<FeishuKnowledgeDocument> {
  const allowlist = requireWikiAllowlist(env);
  const normalizedToken = assertDocumentToken(token);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("Feishu document offset must be a non-negative safe integer");
  }
  const node = await getWikiNode(env, normalizedToken);
  if (!allowlist.has(node.space_id)) {
    throw new Error("Feishu document is outside FEISHU_WIKI_SPACE_IDS allowlist");
  }
  if (node.obj_type !== "docx" && node.obj_type !== "doc") {
    throw new Error(`Unsupported Feishu knowledge document type: ${node.obj_type}`);
  }

  const rawContent = await getDocumentRawContent(env, node.obj_token || node.node_token);
  if (!rawContent.trim()) throw new Error("Feishu document has no readable text content");
  const content = redactKnowledgeSecrets(rawContent);
  const characters = [...content];
  if (offset >= characters.length) throw new Error("Feishu document offset is outside the document");
  const end = Math.min(offset + FEISHU_DOCUMENT_MAX_CHARS, characters.length);
  const truncated = end < characters.length;
  const limited = characters.slice(offset, end).join("");
  const title = node.title || "Untitled";
  const evidenceRole = /\b(?:hub|overview)\b|概览|总览/i.test(title) ? "overview" : "detail";
  const possibleFollowUpQueries = evidenceRole === "overview"
    ? ["Dock PRD", "Dock roadmap", "Dock version update"]
    : [];
  return {
    title,
    token: node.node_token,
    type: "wiki",
    url: `https://jcnreneadm7i.feishu.cn/wiki/${node.node_token}`,
    content: limited,
    truncated,
    contentLength: characters.length,
    offset,
    nextOffset: truncated ? end : null,
    source: "Feishu Knowledge",
    untrustedContent: true,
    citation: {
      title,
      url: `https://jcnreneadm7i.feishu.cn/wiki/${node.node_token}`,
    },
    evidenceRole,
    possibleFollowUpQueries,
    answeringGuidance: evidenceRole === "overview"
      ? "This is overview evidence. It can support positioning and high-level vision, but it is not " +
        "sufficient by itself for a request asking for detailed product roadmap or future plans. " +
        "Use possibleFollowUpQueries and complementary search candidates to fill those evidence gaps, " +
        "or explicitly state what cannot be confirmed. Cite exact citation.title and citation.url values."
      : "Use this body as one evidence source. Before answering, check every requested dimension. " +
        "If it does not support a requested dimension, continue searching/reading until evidence is " +
        "sufficient or state the gap. Cite exact citation.title and citation.url values.",
  };
}
