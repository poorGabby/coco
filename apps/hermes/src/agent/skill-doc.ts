import type { Env } from "../env.js";
import { getDocumentRawContent } from "../feishu.js";
import { AGENT_CONSTRAINTS } from "./constraints.js";

/**
 * 「数据口径 Skill」解析器（Phase 5）。
 *
 * 分层理念：Soul（行为手册）/ Skill（本文件解析的口径文档）/ Tools（代码 + 不变量）。
 * 这里只负责把口径的「表述/政策」从飞书取来注入 system prompt；
 * 真正的安全不变量（真算 WoW、基期 0→null/N/A、日期校验、数值只来自工具）
 * 始终由工具与代码保证，飞书文档改不了这些底线。
 *
 * 解析链（与 ask.ts 的 resolveSystemPrompt 一致）：
 * 飞书文档（5s 超时）→ 60s 缓存 → 旧缓存 → constraints.ts 硬编码回退。
 * 未配置 FEISHU_COCO_SKILL_DOC_TOKEN 时逐字节等同于今天（直接用 constraints.ts）。
 */

let cached: { content: string; ts: number } | null = null;
const CACHE_TTL = 60_000;

export async function resolveSkillDoc(env: Env): Promise<string> {
  const docToken = env.feishuCocoSkillDocToken;
  if (!docToken) return AGENT_CONSTRAINTS;

  const now = Date.now();
  if (cached && now - cached.ts < CACHE_TTL) {
    return cached.content;
  }

  try {
    const content = await Promise.race([
      getDocumentRawContent(env, docToken),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("Feishu skill doc fetch timeout (5s)")), 5_000),
      ),
    ]);
    if (content.trim()) {
      cached = { content: content.trim(), ts: now };
      console.log("[agent] Skill doc（数据口径）refreshed from Feishu");
      return cached.content;
    }
  } catch (err) {
    console.warn("[agent] Failed to fetch skill doc:", err);
  }

  // 降级链：旧缓存 → 硬编码回退
  if (cached) return cached.content;
  return AGENT_CONSTRAINTS;
}
