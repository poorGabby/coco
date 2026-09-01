/**
 * 知识库文档全文缓存 + 搜索
 *
 * 方案：用已有的 docx:document:readonly 权限批量拉取 .env 中配置的
 * FEISHU_WIKI_DOC_TOKENS 文档全文，解析 Markdown 后按 ## 段落分节，
 * 用户提问时在全文内容（而非仅标题）中匹配关键词。
 *
 * 等 search:docs:read 权限到位后，可替换为飞书搜索 API。
 */
import type { Env } from "./env.js";
import {
  getDocumentRawContent,
  getDocTitle,
  listAllWikiDocs,
  getSheetContent,
  getBitableContent,
} from "./feishu.js";

// ── 类型 ──────────────────────────────────────────────────────────

export interface WikiSection {
  /** 文档标题 */
  docTitle: string;
  /** 段落标题（最近的 ## heading，无则为文档标题） */
  heading: string;
  /** 段落正文 */
  content: string;
  /** 文档 token（用于构造链接） */
  nodeToken: string;
  /** 空间名称 */
  spaceName: string;
}

export interface SearchResult {
  /** 匹配的段落标题 */
  heading: string;
  /** 所属文档标题 */
  docTitle: string;
  /** 匹配段落内容（截断到合适长度） */
  snippet: string;
  /** 文档链接 */
  url: string;
  /** Wiki node token */
  nodeToken: string;
  /** 空间名称 */
  spaceName: string;
  /** 匹配得分 */
  score: number;
}

// ── 缓存状态 ──────────────────────────────────────────────────────

let sections: WikiSection[] = [];
let lastLoadTime = 0;
let loading = false;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 分钟刷新
let loadedTokenSet = new Set<string>(); // 已加载过的 token，用于检测新增文档

// MCP 知识搜索专用缓存：只允许来自 FEISHU_WIKI_SPACE_IDS 自动枚举的节点，
// 不混入 FEISHU_WIKI_DOC_TOKENS / 索引文档 / extraTokens。
let allowlistedSections: WikiSection[] = [];
let allowlistedCacheKey = "";
let allowlistedLastLoadTime = 0;
let allowlistedLoading: Promise<void> | null = null;

// ── 加载文档 ──────────────────────────────────────────────────────

/** 单篇加载：尝试 docx → sheet → bitable，哪个能读到就用哪个 */
async function loadOneDoc(
  env: Env,
  nodeToken: string,
  spaceName: string,
): Promise<WikiSection[]> {
  // 策略 1: docx（新版文档）
  let [apiTitle, content] = await Promise.all([
    getDocTitle(env, nodeToken).catch(() => ""),
    getDocumentRawContent(env, nodeToken).catch(() => ""),
  ]);

  if (content.trim()) {
    return parseDocxSections(content, apiTitle, nodeToken, spaceName);
  }

  // 策略 2: Sheet
  try {
    const sheet = await getSheetContent(env, nodeToken);
    if (sheet.text.trim()) {
      return [{
        docTitle: sheet.title,
        heading: sheet.title,
        content: sheet.text,
        nodeToken,
        spaceName,
      }];
    }
  } catch {
    // 不是 Sheet，继续尝试
  }

  // 策略 3: Bitable
  try {
    const bitable = await getBitableContent(env, nodeToken);
    if (bitable.text.trim()) {
      return [{
        docTitle: bitable.title,
        heading: bitable.title,
        content: bitable.text,
        nodeToken,
        spaceName,
      }];
    }
  } catch {
    // 也不是 Bitable
  }

  return [];
}

/** 将 docx 全文按 ## 标题拆分段落 */
function parseDocxSections(
  content: string,
  apiTitle: string,
  nodeToken: string,
  spaceName: string,
): WikiSection[] {
  let docTitle = apiTitle;
  if (!docTitle) {
    const h1Match = /^#\s+(.+)/m.exec(content);
    if (h1Match) docTitle = h1Match[1];
  }
  if (!docTitle) docTitle = nodeToken;

  const lines = content.split("\n");
  const out: WikiSection[] = [];

  let currentHeading = docTitle;
  let currentLines: string[] = [];

  for (const line of lines) {
    const h2 = /^##\s+(.+)/.exec(line);
    const h1 = /^#\s+(.+)/.exec(line);

    if (h2 || h1) {
      const body = currentLines.join("\n").trim();
      if (body) {
        out.push({ docTitle, heading: currentHeading, content: body, nodeToken, spaceName });
      }
      currentHeading = (h2 ?? h1)![1];
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  const body = currentLines.join("\n").trim();
  if (body) {
    out.push({ docTitle, heading: currentHeading, content: body, nodeToken, spaceName });
  }

  return out;
}

/** 加载文档全文：优先用空间 API 自动发现，fallback 到硬编码 + 索引文档 */
async function loadAllDocs(env: Env, extraTokens: string[] = []): Promise<WikiSection[]> {
  let allTokens = extraTokens;
  // 硬编码 token 作为兜底（索引文档清空时确保至少有基础文档）
  if (env.feishuWikiDocTokens.length > 0) {
    allTokens.push(...env.feishuWikiDocTokens);
  }

  const start = Date.now();

  // 优先：空间 API 自动发现（不需要索引文档）
  if (env.feishuWikiSpaceIds.length > 0) {
    for (const spaceId of env.feishuWikiSpaceIds) {
      try {
        const docs = await listAllWikiDocs(env, spaceId);
        for (const doc of docs) {
          if (!allTokens.includes(doc.node_token)) {
            allTokens.push(doc.node_token);
          }
        }
        console.log(`[wiki-cache] Space ${spaceId}: auto-discovered ${docs.length} docs`);
      } catch (err) {
        console.warn(`[wiki-cache] Failed to list docs in space ${spaceId}:`, err);
      }
    }
  }

  if (!allTokens.length) return [];

  console.log(`[wiki-cache] Loading ${allTokens.length} docs...`);
  // 去重
  allTokens = [...new Set(allTokens)];

  // 并发拉取（每批 5 篇，避免飞书 API 限流）
  const BATCH = 5;
  const results: WikiSection[][] = [];

  for (let i = 0; i < allTokens.length; i += BATCH) {
    const batch = allTokens.slice(i, i + BATCH);
    const batchResults = await Promise.all(
      batch.map((token) =>
        loadOneDoc(env, token, "FureverDock Wiki").catch((err) => {
          console.warn(`[wiki-cache] Failed to load doc ${token.slice(0, 12)}...:`, err);
          return [] as WikiSection[];
        }),
      ),
    );
    results.push(...batchResults);
  }

  const all = results.flat();
  const elapsed = Date.now() - start;
  console.log(`[wiki-cache] Loaded ${all.length} sections from ${allTokens.length} docs in ${elapsed}ms`);
  return all;
}

// ── 公开 API ──────────────────────────────────────────────────────

/** 确保缓存已加载（幂等，首次触发加载，后续用缓存）
 *  @param extraTokens 额外要加载的文档 token（如从索引文档动态解析的） */
export async function ensureWikiCache(env: Env, extraTokens: string[] = []): Promise<void> {
  const now = Date.now();
  const allTokens = [...env.feishuWikiDocTokens, ...extraTokens];
  const hasNewTokens = allTokens.some((t) => !loadedTokenSet.has(t));
  const cacheExpired = sections.length === 0 || now - lastLoadTime >= CACHE_TTL_MS;

  // 缓存有效、无新 token、未过期 → 直接返回
  if (!cacheExpired && !hasNewTokens) return;

  // 等待正在进行的加载
  if (loading) {
    while (loading) await new Promise((r) => setTimeout(r, 200));
    // 重新检查：加载完成后可能已包含所需 token
    if (!allTokens.some((t) => !loadedTokenSet.has(t))) return;
  }

  loading = true;
  try {
    sections = await loadAllDocs(env, extraTokens);
    for (const t of allTokens) loadedTokenSet.add(t);
    lastLoadTime = now;
  } finally {
    loading = false;
  }
}

/** 强制重新加载（debug 用） */
export async function refreshWikiCache(env: Env): Promise<void> {
  loading = false;
  sections = [];
  loadedTokenSet = new Set();
  await ensureWikiCache(env);
}

/**
 * 加载固定 Wiki allowlist。任一 space 无法枚举时直接失败，绝不扩大到其他来源。
 * 正文仍复用现有 loadOneDoc 与 30 分钟缓存策略。
 */
async function ensureAllowlistedWikiCache(env: Env): Promise<void> {
  const spaceIds = [...new Set(env.feishuWikiSpaceIds.map((id) => id.trim()).filter(Boolean))];
  if (!spaceIds.length) {
    throw new Error("FEISHU_WIKI_SPACE_IDS is required for fixed Wiki search");
  }
  const cacheKey = [...spaceIds].sort().join(",");
  const now = Date.now();
  if (
    allowlistedCacheKey === cacheKey &&
    allowlistedSections.length > 0 &&
    now - allowlistedLastLoadTime < CACHE_TTL_MS
  ) {
    return;
  }
  if (allowlistedLoading) {
    await allowlistedLoading;
    if (allowlistedCacheKey === cacheKey && allowlistedSections.length > 0) return;
  }

  allowlistedLoading = (async () => {
    const discovered: Array<{ token: string; spaceName: string }> = [];
    for (const spaceId of spaceIds) {
      // 不 catch：空间不可访问时 fail closed，避免静默返回不完整/不同范围的数据。
      const docs = await listAllWikiDocs(env, spaceId);
      for (const doc of docs) {
        discovered.push({ token: doc.node_token, spaceName: `Wiki ${spaceId}` });
      }
    }
    const unique = [...new Map(discovered.map((item) => [item.token, item])).values()];
    if (!unique.length) throw new Error("No readable documents found in FEISHU_WIKI_SPACE_IDS");

    const loaded: WikiSection[][] = [];
    const batchSize = 5;
    for (let i = 0; i < unique.length; i += batchSize) {
      const batch = unique.slice(i, i + batchSize);
      loaded.push(...await Promise.all(
        batch.map((item) => loadOneDoc(env, item.token, item.spaceName)),
      ));
    }
    const nextSections = loaded.flat();
    if (!nextSections.length) {
      throw new Error("Documents in FEISHU_WIKI_SPACE_IDS have no readable cached content");
    }
    // 完整加载成功后再原子替换，失败时不污染上一份缓存。
    allowlistedSections = nextSections;
    allowlistedCacheKey = cacheKey;
    allowlistedLastLoadTime = Date.now();
    console.log(
      `[wiki-cache] Fixed allowlist: loaded ${nextSections.length} sections from ${unique.length} docs`,
    );
  })();
  try {
    await allowlistedLoading;
  } finally {
    allowlistedLoading = null;
  }
}

/** 获取缓存统计 */
export function wikiCacheStats(): { sections: number; docs: number; ageMs: number } {
  const docTokens = new Set(sections.map((s) => s.nodeToken));
  return {
    sections: sections.length,
    docs: docTokens.size,
    ageMs: sections.length ? Date.now() - lastLoadTime : 0,
  };
}

// ── 搜索 ──────────────────────────────────────────────────────────

/**
 * 中文分词：对含 CJK 字符的字符串生成 2-char n-gram
 * 同时保留英文/数字 token
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();

  // 提取英文/数字词
  const latinWords = lower.match(/[a-z0-9]+/g) ?? [];
  tokens.push(...latinWords);

  // 对每个 CJK 连续段生成 bigram
  const cjkSegments = lower.match(/[一-鿿㐀-䶿]+/g) ?? [];
  for (const seg of cjkSegments) {
    // 完整词
    if (seg.length >= 2) tokens.push(seg);
    // 2-char n-gram
    for (let i = 0; i < seg.length - 1; i++) {
      tokens.push(seg.slice(i, i + 2));
    }
  }

  return [...new Set(tokens)];
}

/** 工具输出层兜底脱敏；保留字段名和上下文，但不把凭据值交给模型。 */
export function redactKnowledgeSecrets(text: string): string {
  return text.replace(
    /((?:密码|password|api[_ -]?key|app[_ -]?secret|access[_ -]?token)\s*[：:=]\s*)([^\s,，;；\n]+)/gi,
    "$1[REDACTED]",
  );
}

/** 全文搜索：在所有文档段落中匹配关键词 */
export function searchFulltext(
  query: string,
  maxResults = 10,
): SearchResult[] {
  return searchSections(sections, query, maxResults);
}

function searchSections(
  sourceSections: WikiSection[],
  query: string,
  maxResults: number,
): SearchResult[] {
  if (!query.trim() || !sourceSections.length) return [];

  const keywords = tokenize(query);
  if (!keywords.length) return [];

  // 对每个段落打分：关键词在 heading + content 中的命中次数
  const scored = sourceSections.map((sec) => {
    const searchText = (sec.docTitle + " " + sec.heading + " " + sec.content).toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      let idx = -1;
      while ((idx = searchText.indexOf(kw, idx + 1)) !== -1) {
        score++;
      }
      // 标题命中权重 ×3
      if (sec.heading.toLowerCase().includes(kw)) score += 2;
    }
    return { section: sec, score };
  });

  // 过滤掉 0 分，按分数降序
  const hits = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  // 同一文档最多保留 4 个段落
  const seen = new Map<string, number>();
  const deduped: typeof hits = [];
  for (const hit of hits) {
    const count = seen.get(hit.section.nodeToken) ?? 0;
    if (count < 4) {
      deduped.push(hit);
      seen.set(hit.section.nodeToken, count + 1);
    }
  }

  // 截断到 maxResults
  const top = deduped.slice(0, maxResults);

  return top.map(({ section, score }) => ({
    heading: section.heading,
    docTitle: section.docTitle,
    snippet: redactKnowledgeSecrets(section.content),
    url: `https://jcnreneadm7i.feishu.cn/wiki/${section.nodeToken}`,
    nodeToken: section.nodeToken,
    spaceName: section.spaceName,
    score,
  }));
}

/** 标题 + 正文搜索，仅覆盖 FEISHU_WIKI_SPACE_IDS 自动发现的固定文档。 */
export async function searchAllowlistedWikiFulltext(
  env: Env,
  query: string,
  maxResults = 10,
): Promise<SearchResult[]> {
  await ensureAllowlistedWikiCache(env);
  return searchSections(allowlistedSections, query, maxResults);
}
