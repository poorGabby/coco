import type { Env } from "./env.js";
import { assertFeishuConfigured } from "./env.js";

type TenantTokenResponse = {
  code: number;
  msg: string;
  tenant_access_token?: string;
  expire?: number;
};

let cachedToken: { token: string; expiresAt: number } | null = null;

export async function getTenantAccessToken(env: Env): Promise<string> {
  assertFeishuConfigured(env);
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.token;
  }

  const res = await fetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: env.feishuAppId,
        app_secret: env.feishuAppSecret,
      }),
    },
  );
  const data = (await res.json()) as TenantTokenResponse;
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`Feishu token error: ${data.msg ?? res.status}`);
  }
  cachedToken = {
    token: data.tenant_access_token,
    expiresAt: now + (data.expire ?? 7200) * 1000,
  };
  return cachedToken.token;
}

async function feishuPost(
  env: Env,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const token = await getTenantAccessToken(env);
  const res = await fetch(`https://open.feishu.cn/open-apis${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  const code = (data as { code?: number }).code;
  if (code !== 0) {
    throw new Error(`Feishu API ${path} failed: ${JSON.stringify(data)}`);
  }
  return data;
}

export async function replyMessage(
  env: Env,
  messageId: string,
  text: string,
): Promise<void> {
  await feishuPost(env, `/im/v1/messages/${messageId}/reply`, {
    content: JSON.stringify({ text }),
    msg_type: "text",
  });
}

/** 给消息添加原生表情回复 — 利用缓存的 token 并发请求，无 await 延迟 */
export function reactToMessage(
  env: Env,
  messageId: string,
  emojiType = "MeMeMe",
): void {
  // 使用缓存的 token 立即发送，不等待网络响应
  const token = cachedToken?.token;
  if (!token) {
    // 缓存未命中时异步获取后重试
    getTenantAccessToken(env).then((t) => {
      fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reactions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
      }).catch(() => {});
    }).catch(() => {});
    return;
  }

  // 缓存命中：直接 fire-and-forget
  fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reactions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
  }).catch(() => {});
}

export async function sendToChat(env: Env, chatId: string, text: string): Promise<void> {
  await feishuPost(env, "/im/v1/messages?receive_id_type=chat_id", {
    receive_id: chatId,
    content: JSON.stringify({ text }),
    msg_type: "text",
  });
}

export async function replyWithCard(
  env: Env,
  messageId: string,
  card: Record<string, unknown>,
): Promise<void> {
  await feishuPost(env, `/im/v1/messages/${messageId}/reply`, {
    content: JSON.stringify(card),
    msg_type: "interactive",
  });
}

export async function sendCardToChat(
  env: Env,
  chatId: string,
  card: Record<string, unknown>,
): Promise<void> {
  await feishuPost(env, "/im/v1/messages?receive_id_type=chat_id", {
    receive_id: chatId,
    content: JSON.stringify(card),
    msg_type: "interactive",
  });
}

/** 获取 Bot 当前所在的所有群聊 ID（排除私聊 p2p） */
export async function listBotChats(env: Env): Promise<string[]> {
  const chatIds: string[] = [];
  let pageToken: string | undefined;
  do {
    let path = "/im/v1/chats?page_size=100";
    if (pageToken) path += `&page_token=${pageToken}`;
    const data = (await feishuGet(env, path)) as {
      data?: {
        items?: Array<{ chat_id: string; chat_mode?: string; chat_type?: string }>;
        has_more?: boolean;
        page_token?: string;
      };
    };
    for (const item of data.data?.items ?? []) {
      if (!item.chat_id) continue;
      const mode = (item.chat_mode ?? "").toLowerCase();
      const ctype = (item.chat_type ?? "").toLowerCase();
      if (mode === "p2p" || ctype === "p2p") continue;
      chatIds.push(item.chat_id);
    }
    pageToken = data.data?.has_more ? data.data.page_token : undefined;
  } while (pageToken);
  return chatIds;
}

export function messageMentionsBot(
  event: FeishuMessageEvent,
  botOpenId: string,
): boolean {
  if (!botOpenId) return true;
  const mentions = event.message?.mentions ?? [];
  return mentions.some((m) => m.id?.open_id === botOpenId);
}

export function isDirectMessage(event: FeishuMessageEvent): boolean {
  const chatType = event.message?.chat_type;
  // 飞书标准：p2p = 私聊
  if (chatType === "p2p") return true;
  // 兜底：chat_type 缺失但无 @提及 → 大概率是私聊（群聊 @机器人 必定有 mentions）
  if (!chatType) {
    const mentions = event.message?.mentions;
    if (!mentions || mentions.length === 0) return true;
  }
  return false;
}

export type FeishuMessageEvent = {
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: string;
    content?: string;
    mentions?: Array<{ id?: { open_id?: string } }>;
  };
};

// ── Wiki / 知识库 API ────────────────────────────────────────────

export interface WikiSpace {
  space_id: string;
  name: string;
  description?: string;
}

export interface WikiNode {
  node_token: string;
  obj_type: "doc" | "folder" | "shortcut";
  title: string;
  parent_node_token?: string;
  has_child?: boolean;
}

export interface WikiSearchResult {
  spaceName: string;
  nodeTitle: string;
  content: string;
  nodeToken: string;
}

/** 获取当前应用可访问的知识库空间列表 */
export async function listWikiSpaces(env: Env): Promise<WikiSpace[]> {
  const data = (await feishuGet(
    env,
    "/wiki/v2/spaces?page_size=50",
  )) as {
    data?: { items?: Array<{ space_id: string; name: string; description?: string }> };
  };
  return (data.data?.items ?? []).map((i) => ({
    space_id: i.space_id,
    name: i.name,
    description: i.description,
  }));
}

/** 获取某个空间下的节点列表（按 parent_node_token 可递归） */
export async function listWikiNodes(
  env: Env,
  spaceId: string,
  parentNodeToken?: string,
): Promise<WikiNode[]> {
  let path = `/wiki/v2/spaces/${spaceId}/nodes?page_size=50`;
  if (parentNodeToken) {
    path += `&parent_node_token=${parentNodeToken}`;
  }
  const data = (await feishuGet(env, path)) as {
    data?: {
      items?: Array<{
        node_token: string;
        obj_type: string;
        title: string;
        parent_node_token?: string;
        has_child?: boolean;
      }>;
    };
  };
  return (data.data?.items ?? []).map((i) => ({
    node_token: i.node_token,
    obj_type: i.obj_type as WikiNode["obj_type"],
    title: i.title,
    parent_node_token: i.parent_node_token,
    has_child: i.has_child,
  }));
}

/** 递归获取空间下所有可读文档节点 */
export async function listAllWikiDocs(
  env: Env,
  spaceId: string,
  parentNodeToken?: string,
): Promise<WikiNode[]> {
  const nodes = await listWikiNodes(env, spaceId, parentNodeToken);
  const docs: WikiNode[] = [];
  const readable = new Set(["doc", "docx", "sheet", "bitable"]);
  for (const node of nodes) {
    if (readable.has(node.obj_type)) {
      docs.push(node);
    }
    if (node.has_child) {
      const children = await listAllWikiDocs(env, spaceId, node.node_token);
      docs.push(...children);
    }
  }
  return docs;
}

/** 获取飞书文档的纯文本内容（需要 docx:document:readonly 权限） */
export async function getDocumentRawContent(
  env: Env,
  documentId: string,
): Promise<string> {
  const data = (await feishuGet(
    env,
    `/docx/v1/documents/${documentId}/raw_content`,
  )) as { data?: { content?: string } };
  return data.data?.content ?? "";
}

/**
 * 简单的关键词搜索知识库：
 * 1. 在所有配置的 space 中拉取文档列表
 * 2. 对用户问题做关键词分词，匹配文档标题
 * 3. 获取匹配文档的全文内容
 * 返回按相关度排序的搜索结果（最多 maxResults 条）
 */
export async function searchWiki(
  env: Env,
  query: string,
  spaceIds: string[],
  rootTokens: string[] = [],
  maxResults = 5,
): Promise<WikiSearchResult[]> {
  if (!spaceIds.length) return [];

  // 收集所有文档元信息
  const allDocs: Array<{ spaceId: string; spaceName: string; node: WikiNode }> = [];
  const spaces = await listWikiSpaces(env);

  for (let i = 0; i < spaceIds.length; i++) {
    const spaceId = spaceIds[i];
    const rootToken = rootTokens[i] || undefined;
    try {
      const docs = await listAllWikiDocs(env, spaceId, rootToken);
      const spaceName =
        spaces.find((s) => s.space_id === spaceId)?.name ?? spaceId;
      for (const node of docs) {
        allDocs.push({ spaceId, spaceName, node });
      }
    } catch (err) {
      console.warn(`[wiki] Failed to list docs in space ${spaceId}:`, err);
    }
  }

  // 简单的中文分词 + 英文 lowercase 匹配
  const rawKeywords = query
    .split(/[\s,，。！？?、\n]+/)
    .filter((k) => k.length >= 1)
    .map((k) => k.toLowerCase());

  // 中文查询无空格分隔，对含 CJK 长关键词生成 2-char n-gram
  const keywords = rawKeywords.flatMap((k) => {
    if (k.length <= 2) return [k];
    if (!/[一-鿿]/.test(k)) return [k];
    const ngrams = [k];
    for (let i = 0; i < k.length - 1; i++) {
      ngrams.push(k.slice(i, i + 2));
    }
    return ngrams;
  });

  if (keywords.length === 0) return [];

  // 按匹配关键词数量排序
  const scored = allDocs
    .map((d) => {
      const title = d.node.title.toLowerCase();
      const score = keywords.filter((k) => title.includes(k)).length;
      return { ...d, score };
    })
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);

  // 获取文档内容
  const results: WikiSearchResult[] = [];
  for (const item of scored) {
    try {
      const content = await getDocumentRawContent(env, item.node.node_token);
      if (content.trim()) {
        results.push({
          spaceName: item.spaceName,
          nodeTitle: item.node.title,
          content: content.slice(0, 8000), // 截断，避免 token 溢出
          nodeToken: item.node.node_token,
        });
      }
    } catch (err) {
      console.warn(
        `[wiki] Failed to get content for "${item.node.title}":`,
        err,
      );
    }
  }

  return results;
}

/** 通过 get_node API 获取单个文档的标题 */
export async function getDocTitle(
  env: Env,
  docToken: string,
): Promise<string> {
  try {
    const data = (await feishuGet(
      env,
      `/wiki/v2/spaces/get_node?token=${docToken}`,
    )) as { data?: { node?: { title: string } } };
    return data.data?.node?.title ?? "";
  } catch {
    return "";
  }
}

/** 缓存文档标题，避免每次搜索都全量请求 */
let docTitleCache: Promise<Map<string, string>> | null = null;
const DOC_TITLE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchDocTitles(env: Env, docTokens: string[]): Promise<Map<string, string>> {
  if (docTitleCache) return docTitleCache;

  docTitleCache = (async () => {
    const map = new Map<string, string>();
    const results = await Promise.all(
      docTokens.map(async (dt) => {
        const title = await getDocTitle(env, dt);
        return { dt, title };
      }),
    );
    for (const { dt, title } of results) {
      if (title) map.set(dt, title);
    }
    return map;
  })();

  // 过期重置
  setTimeout(() => { docTitleCache = null; }, DOC_TITLE_CACHE_TTL);

  return docTitleCache;
}

/**
 * 读取索引文档的 blocks，提取所有列表项中的文档 token。
 * 支持飞书自动转换的两种格式：
 *   1. 粘贴链接 → text_element_style.link.url（URL 编码）
 *   2. @文档 → mention_doc.token / mention_doc.url
 * 管理员只需要在索引文档里粘贴/ @文档链接，机器人自动解析。
 */
export async function readDocTokensFromIndex(
  env: Env,
  indexDocToken: string,
): Promise<string[]> {
  const tokenSet = new Set<string>();

  let pageToken: string | undefined;
  do {
    let path = `/docx/v1/documents/${indexDocToken}/blocks?page_size=500`;
    if (pageToken) path += `&page_token=${pageToken}`;

    const data = (await feishuGet(env, path)) as {
      data?: {
        items?: Array<Record<string, unknown>>;
        has_more?: boolean;
        page_token?: string;
      };
    };
    const items = data.data?.items ?? [];
    pageToken = data.data?.page_token;

    for (const block of items) {
      // block_type 12 = 无序列表项
      if ((block as { block_type?: number }).block_type !== 12) continue;

      const bullet = (block as { bullet?: { elements?: Array<Record<string, unknown>> } }).bullet;
      if (!bullet?.elements) continue;

      for (const el of bullet.elements) {
        // 方式 1: mention_doc（@文档）
        const mention = (el as { mention_doc?: { token?: string; url?: string } }).mention_doc;
        if (mention) {
          if (mention.token) tokenSet.add(mention.token);
          // 也尝试从 url 中提取 token 作为后备
          const urlToken = extractTokenFromUrl(mention.url);
          if (urlToken) tokenSet.add(urlToken);
          continue;
        }

        // 方式 2: text_run 中的链接
        const textRun = (el as { text_run?: { text_element_style?: { link?: { url?: string } } } }).text_run;
        if (textRun?.text_element_style?.link?.url) {
          const decoded = decodeURIComponent(textRun.text_element_style.link.url);
          const urlToken = extractTokenFromUrl(decoded);
          if (urlToken) tokenSet.add(urlToken);
        }
      }
    }
  } while (pageToken);

  const tokens = [...tokenSet];
  console.log("[wiki] Index doc: extracted", tokens.length, "unique doc tokens from blocks");
  return tokens;
}

/** 从 URL 中提取 doc token */
function extractTokenFromUrl(url?: string): string | null {
  if (!url) return null;
  // 匹配 /wiki/xxx 或 /docx/xxx
  const match = url.match(/\/(wiki|docx)\/([A-Za-z0-9]+)/);
  return match ? match[2] : null;
}

/** 索引文档 token 缓存 */
let cachedIndexTokens: { tokens: string[]; ts: number } | null = null;
const INDEX_CACHE_TTL = 2 * 60 * 1000; // 2 分钟，管理员刚改几乎立刻生效

export async function getDocTokensFromIndex(env: Env, indexDocToken: string): Promise<string[]> {
  const now = Date.now();
  if (cachedIndexTokens && cachedIndexTokens.ts > now - INDEX_CACHE_TTL) {
    return cachedIndexTokens.tokens;
  }
  const tokens = await readDocTokensFromIndex(env, indexDocToken);
  cachedIndexTokens = { tokens, ts: now };
  return tokens;
}

/** 清除索引文档缓存（调试用） */
export function clearIndexDocCache() {
  cachedIndexTokens = null;
  docTitleCache = null;
}

// ── Sheet / Bitable 读取 ──────────────────────────────────────────

export interface SheetTable {
  title: string;
  rows: string[][];
}

/** 读取电子表格所有子表的完整数据，转为文本 */
export async function getSheetContent(
  env: Env,
  spreadsheetToken: string,
): Promise<{ title: string; text: string }> {
  // 1. 获取表格元信息
  const meta = (await feishuGet(
    env,
    `/sheets/v2/spreadsheets/${spreadsheetToken}/metainfo`,
  )) as { data?: { properties?: { title?: string }; sheets?: Array<{ sheetId: string; title: string; index: number }> } };

  const title = meta.data?.properties?.title ?? spreadsheetToken;
  const sheets = meta.data?.sheets ?? [];

  // 2. 逐个子表读取数据
  const parts: string[] = [`# ${title}`];
  for (const sh of sheets) {
    const sheetId = sh.sheetId;
    if (!sheetId) continue;

    parts.push(`\n## ${sh.title}`);
    try {
      const vData = (await feishuGet(
        env,
        `/sheets/v2/spreadsheets/${spreadsheetToken}/values/${sheetId}?valueRenderOption=ToString&majorDimension=ROWS`,
      )) as { data?: { valueRange?: { values?: string[][] } } };

      const rows = vData.data?.valueRange?.values ?? [];
      if (rows.length === 0) {
        parts.push("(空表)");
        continue;
      }

      // 转成 tab-separated 文本行
      const textRows = rows.map((row) =>
        row.map((cell) => cell ?? "").join("\t"),
      );
      parts.push(...textRows);
    } catch (err) {
      parts.push(`(读取失败: ${err instanceof Error ? err.message : String(err)})`);
    }
  }

  return { title, text: parts.join("\n") };
}

export interface BitableTable {
  name: string;
  fields: string[];
  records: Record<string, unknown>[];
}

/** 读取多维表格所有表的记录，转为文本 */
export async function getBitableContent(
  env: Env,
  appToken: string,
): Promise<{ title: string; text: string }> {
  // 1. 获取应用信息
  const app = (await feishuGet(
    env,
    `/bitable/v1/apps/${appToken}`,
  )) as { data?: { app?: { name: string } } };
  const title = app.data?.app?.name ?? appToken;

  // 2. 列出所有表
  const tblData = (await feishuGet(
    env,
    `/bitable/v1/apps/${appToken}/tables`,
  )) as { data?: { items?: Array<{ table_id: string; name: string }> } };
  const tables = tblData.data?.items ?? [];

  // 3. 逐个表读取字段和记录
  const parts: string[] = [`# ${title}`];
  for (const tbl of tables) {
    parts.push(`\n## ${tbl.name}`);

    try {
      // 获取字段列表
      const fieldData = (await feishuGet(
        env,
        `/bitable/v1/apps/${appToken}/tables/${tbl.table_id}/fields`,
      )) as { data?: { items?: Array<{ field_name: string; type: number }> } };
      const fields = fieldData.data?.items?.map((f) => f.field_name) ?? [];

      // 读取记录（最多 200 条）
      const allRecords: Record<string, unknown>[] = [];
      let pageToken: string | undefined;
      do {
        let path = `/bitable/v1/apps/${appToken}/tables/${tbl.table_id}/records?page_size=200`;
        if (pageToken) path += `&page_token=${pageToken}`;
        const recData = (await feishuGet(env, path)) as {
          data?: { items?: Array<{ fields: Record<string, unknown> }>; has_more?: boolean; page_token?: string };
        };
        allRecords.push(...(recData.data?.items ?? []).map((r) => r.fields));
        pageToken = recData.data?.has_more ? recData.data.page_token : undefined;
      } while (pageToken);

      if (allRecords.length === 0) {
        parts.push("(空表)");
        continue;
      }

      // 转成 TSV 文本（首行是列名）
      const header = fields.join("\t");
      const body = allRecords.map((rec) =>
        fields.map((f) => String(rec[f] ?? "")).join("\t"),
      );
      parts.push(header, ...body);
    } catch (err) {
      parts.push(`(读取失败: ${err instanceof Error ? err.message : String(err)})`);
    }
  }

  return { title, text: parts.join("\n") };
}

/**
 * 基于预配置的文档 token 列表搜索知识库：
 * 1. 拉取所有文档标题（带缓存）
 * 2. 关键词分词匹配标题
 * 3. 获取匹配文档的全文内容
 */
export async function searchWikiByDocs(
  env: Env,
  query: string,
  docTokens: string[],
  maxResults = 5,
): Promise<WikiSearchResult[]> {
  if (!docTokens.length) return [];

  console.log("[wiki] searchWikiByDocs: searching", docTokens.length, "docs for:", query.slice(0, 50));

  // 获取所有文档标题
  const titles = await fetchDocTitles(env, docTokens);
  console.log("[wiki] searchWikiByDocs: loaded", titles.size, "titles");

  // 分词匹配
  const rawKeywords = query
    .split(/[\s,，。！？?、\n]+/)
    .filter((k) => k.length >= 1)
    .map((k) => k.toLowerCase());

  // 中文查询通常无空格分隔，整句无法匹配标题——对含 CJK 的长关键词
  // 额外生成 2-char n-gram（如 "几个产品版本" → "几个" "个产" "产品" "品版" "版本"）
  const keywords = rawKeywords.flatMap((k) => {
    if (k.length <= 2) return [k];
    if (!/[一-鿿]/.test(k)) return [k];
    const ngrams = [k]; // 保留原词（可能匹配英文标题）
    for (let i = 0; i < k.length - 1; i++) {
      ngrams.push(k.slice(i, i + 2));
    }
    return ngrams;
  });

  if (keywords.length === 0) return [];

  console.log("[wiki] searchWikiByDocs: keywords=", keywords.join(", "));

  const scored = Array.from(titles.entries())
    .map(([token, title]) => {
      const lower = title.toLowerCase();
      const score = keywords.filter((k) => lower.includes(k)).length;
      return { token, title, score };
    })
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score);

  // 标题匹配结果太少时，把剩余文档也加上（让 LLM 自己去内容里找答案）
  let candidates = scored.slice(0, maxResults);
  if (candidates.length < 3) {
    const matchedTokens = new Set(candidates.map((c) => c.token));
    const rest = Array.from(titles.entries())
      .filter(([token]) => !matchedTokens.has(token))
      .slice(0, 5 - candidates.length)
      .map(([token, title]) => ({ token, title, score: 0 }));
    candidates = [...candidates, ...rest];
    console.log("[wiki] searchWikiByDocs: title match only", scored.length, "docs, broadened to", candidates.length);
  }

  // 获取文档内容
  const results: WikiSearchResult[] = [];
  for (const item of candidates) {
    try {
      const content = await getDocumentRawContent(env, item.token);
      if (content.trim()) {
        results.push({
          spaceName: "FureverDock Wiki",
          nodeTitle: item.title,
          content: content.slice(0, 8000),
          nodeToken: item.token,
        });
      }
    } catch (err) {
      console.warn(`[wiki] Failed to get content for "${item.title}":`, err);
    }
  }

  return results;
}

// ── 内部工具 ──────────────────────────────────────────────────────

async function feishuGet(env: Env, path: string): Promise<unknown> {
  const token = await getTenantAccessToken(env);
  const res = await fetch(`https://open.feishu.cn/open-apis${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
  const data = await res.json();
  const code = (data as { code?: number }).code;
  if (code !== 0) {
    throw new Error(`Feishu GET ${path} failed: ${JSON.stringify(data)}`);
  }
  return data;
}

export function parseMessageText(content: string | undefined): string {
  if (!content) return "";
  try {
    const parsed = JSON.parse(content) as { text?: string };
    return parsed.text?.replace(/@_\S+/g, "").trim() ?? "";
  } catch {
    return content;
  }
}
