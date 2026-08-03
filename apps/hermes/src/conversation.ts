/**
 * 对话记忆模块 — 纯内存 Map，按 chatId 存储最近 N 轮对话。
 *
 * 设计：
 * - Gemini API 原生支持多轮对话（contents[] 数组），所以我们存储
 *   user/model 交替的消息轮次，直接拼进 API 请求的 contents 参数。
 * - 30 分钟无活动自动过期；进程重启 / Cloud Run 缩容后数据丢失（预期内）。
 * - 所有 Map 操作为同步，Node.js 单线程无竞态。
 */

/** 单条对话消息，role 使用 Gemini API 原生约定 */
export interface ConversationMessage {
  role: "user" | "model";
  content: string;
}

interface ConversationStore {
  messages: ConversationMessage[];
  lastActivity: number;
}

// ── 配置 ──
const MAX_MESSAGES = 20; // 10 轮 user+model 交替
const TTL_MS = 30 * 60 * 1000; // 30 分钟
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const CONTENT_MAX_LEN = 2000;

// ── 存储 ──
const store = new Map<string, ConversationStore>();

/** 追加一条消息。超出上限时自动删除最旧的一对（2 条）。 */
export function addMessage(
  chatId: string,
  role: ConversationMessage["role"],
  content: string,
): void {
  let entry = store.get(chatId);
  if (!entry) {
    entry = { messages: [], lastActivity: Date.now() };
    store.set(chatId, entry);
  }
  entry.lastActivity = Date.now();

  const truncated =
    content.length > CONTENT_MAX_LEN
      ? content.slice(0, CONTENT_MAX_LEN) + "..."
      : content;

  entry.messages.push({ role, content: truncated });

  // 超过上限：删最旧的一对
  while (entry.messages.length > MAX_MESSAGES) {
    entry.messages.splice(0, 2);
  }
}

/**
 * 获取最近 N 轮对话历史。
 * 过期返回空数组（同时清理该 chat 的存储）。
 * @param maxTurns 最大返回轮数（每轮 = user + model 各一条），默认 5
 */
export function getHistory(
  chatId: string,
  maxTurns = 5,
): ConversationMessage[] {
  const entry = store.get(chatId);
  if (!entry) return [];

  if (Date.now() - entry.lastActivity > TTL_MS) {
    store.delete(chatId);
    return [];
  }

  const count = maxTurns * 2;
  return entry.messages.slice(-count);
}

/**
 * 将对话历史转换为 Gemini API 的 contents[] 格式。
 */
export function toGeminiContents(
  history: ConversationMessage[],
): Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> {
  return history.map((m) => ({ role: m.role, parts: [{ text: m.content }] }));
}

/** 清理所有过期对话。由定时器触发。 */
export function evictStaleConversations(): void {
  const now = Date.now();
  for (const [chatId, entry] of store) {
    if (now - entry.lastActivity > TTL_MS) {
      store.delete(chatId);
    }
  }
}

/** 清空全部记忆（调试用） */
export function clearAll(): void {
  store.clear();
}

/** 调试统计 */
export function stats(): { chats: number; messages: number } {
  let messages = 0;
  for (const entry of store.values()) {
    messages += entry.messages.length;
  }
  return { chats: store.size, messages };
}

// ── 定时清理 ──
const cleanupTimer = setInterval(evictStaleConversations, CLEANUP_INTERVAL_MS);
if (cleanupTimer.unref) cleanupTimer.unref();
