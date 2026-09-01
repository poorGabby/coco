import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { loadEnv } from "./env.js";
import { askQuestion } from "./ask.js";
import { runAgentQuestion } from "./agent/agent-runner.js";
import { generateReport, generateDailyReport } from "./report.js";
import {
  messageMentionsBot,
  isDirectMessage,
  parseMessageText,
  replyMessage,
  replyWithCard,
  sendToChat,
  sendCardToChat,
  reactToMessage,
  getTenantAccessToken,
  listBotChats,
  type FeishuMessageEvent,
} from "./feishu.js";
import { handleCocoMcpRequest } from "./coco-mcp.js";
import { ensureWikiCache, wikiCacheStats, searchFulltext } from "./wiki-cache.js";
import { addMessage, getHistory, toGeminiContents, stats as convStats } from "./conversation.js";
import {
  isTakeoverVersionQuery,
  TAKEOVER_VERSION_REPLY,
} from "./takeover-version.js";

const env = loadEnv();
const app = new Hono();

/** CoCo Data MCP（交接文档 mcp_servers 模式）：Bearer 鉴权 + Streamable HTTP */
app.all("/mcp", async (c) => {
  const key = env.cocoMcpKey;
  if (!key) {
    return c.json({ error: "COCO_MCP_KEY not configured" }, 503);
  }
  const auth = c.req.header("authorization") ?? "";
  if (auth !== `Bearer ${key}`) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return handleCocoMcpRequest(env, c.req.raw);
});

app.get("/mcp/health", (c) => c.json({ ok: true, service: "coco-data-mcp" }));

// ── 调试：环形事件缓冲区 ───────────────────────────────────────────
const MAX_EVENTS = 20;
const recentEvents: Array<{
  ts: string;
  raw: string;
  parsed: Record<string, unknown>;
  matched: boolean;
  reason: string;
}> = [];

function pushEvent(
  raw: string,
  parsed: Record<string, unknown>,
  matched: boolean,
  reason: string,
) {
  recentEvents.unshift({ ts: new Date().toISOString(), raw, parsed, matched, reason });
  if (recentEvents.length > MAX_EVENTS) recentEvents.length = MAX_EVENTS;
}

app.get("/debug/events", (c) => {
  return c.json({ count: recentEvents.length, events: recentEvents });
});

app.get("/debug/conversations", (c) => {
  return c.json(convStats());
});

app.get("/debug/wiki", async (c) => {
  const stats = wikiCacheStats();
  const q = c.req.query("q") || "版本更新了几次？";
  const results = searchFulltext(q, 5);

  // 同时调用 buildWikiContext 看完整链路
  const { buildWikiContext } = await import("./ask.js");
  const ctx = await buildWikiContext(env, q);

  return c.json({
    stats,
    searchQuery: q,
    results: results.map(r => ({ doc: r.docTitle, heading: r.heading, score: r.score })),
    buildWikiContext: {
      wikiTextLen: ctx.wikiText.length,
      sourcesCount: ctx.sources?.length ?? 0,
      wikiTextPreview: ctx.wikiText.slice(0, 300),
    },
  });
});

/**
 * 自由问答统一入口：开关开启走受控 Agent（失败自动回退 askQuestion），
 * 关闭则维持现有 askQuestion。返回 answer 文本，调用方负责发送与记忆写入。
 */
async function answerFreeform(
  question: string,
  history?: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }>,
): Promise<string> {
  if (env.hermesAgentEnabled) {
    try {
      const res = await runAgentQuestion(env, question, history);
      console.log(
        `[agent] steps=${res.steps} tools=${res.toolCalls.map((t) => `${t.name}${t.ok ? "" : "!"}`).join(",") || "none"}`,
      );
      return res.answer;
    } catch (err) {
      console.warn(
        "[agent] failed, falling back to askQuestion:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  const res = await askQuestion(env, question, history);
  return res.answer;
}

app.get("/health", (c) => c.json({ ok: true }));

/** 自由问答：Amplitude API 拉数 + Gemini 解读（无需飞书 / MCP） */
app.post("/hermes/ask", async (c) => {
  const body = await c.req.json<{ question?: string }>().catch(() => ({ question: undefined }));
  const question = body.question?.trim();
  if (!question) {
    return c.json({ error: "question is required" }, 400);
  }
  if (isTakeoverVersionQuery(question)) {
    return c.json({ ok: true, question, answer: TAKEOVER_VERSION_REPLY });
  }
  try {
    const answer = await answerFreeform(question);
    return c.json({ ok: true, question, answer });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("ask error:", message);
    return c.json({ ok: false, error: message }, 500);
  }
});

/** 本地预览日报，无需飞书 */
app.get("/hermes/report", async (c) => {
  const report = await generateReport(env);
  return c.text(report);
});

/** 飞书群事件：群内 @机器人 → 在同群 reply；定时日报 → 发到 FEISHU_REPORT_CHAT_ID 群 */
app.post("/feishu/events", async (c) => {
  // 先读原始文本再解析，方便在 Cloud Run 日志里排查飞书推送格式
  const raw = await c.req.text().catch(() => "");
  console.log("Feishu callback raw body:", raw.slice(0, 500));

  const parsed: Record<string, unknown> & {
    challenge?: string;
    schema?: string;
    header?: { event_type?: string };
    event?: FeishuMessageEvent & { type?: string };
  } = {};

  if (raw) {
    try {
      Object.assign(parsed, JSON.parse(raw));
    } catch {
      console.error("Feishu callback body is not valid JSON");
      pushEvent(raw, {}, false, "invalid-json");
      return c.json({ ok: false, error: "invalid json" }, 400);
    }
  }

  // 飞书 URL 验证：收到 challenge 时原样返回
  if (parsed.challenge) {
    console.log("Feishu URL verification challenge received:", parsed.challenge.slice(0, 20) + "...");
    pushEvent(raw, parsed, false, "challenge");
    return c.json({ challenge: parsed.challenge });
  }

  // 兼容 V1 和 V2 事件格式
  const eventType =
    parsed.header?.event_type ??    // V2: header.event_type
    parsed.event?.type ??           // V1: event.type
    "";

  if (eventType !== "im.message.receive_v1") {
    const reason = `event_type=${eventType || "missing"}`;
    console.log(`[feishu] Ignored: ${reason}`);
    pushEvent(raw, parsed, false, reason);
    return c.json({ ok: true });
  }

  const event = parsed.event;
  const messageId = event?.message?.message_id;
  const chatId = event?.message?.chat_id;

  if (!messageId || !chatId) {
    const reason = `no_id: messageId=${messageId ?? "missing"}, chatId=${chatId ?? "missing"}`;
    console.log(`[feishu] ${reason}`);
    pushEvent(raw, parsed, false, reason);
    return c.json({ ok: true });
  }

  // 🖐️ 第一时间举手回应，在 return 200 之前就发出请求
  reactToMessage(env, messageId);

  const isDM = isDirectMessage(event);
  const isMentioned = messageMentionsBot(event, env.feishuBotOpenId);
  console.log(
    `[feishu] chat_type=${event?.message?.chat_type ?? "missing"}, isDM=${isDM}, ` +
      `mentionsCount=${event?.message?.mentions?.length ?? 0}, ` +
      `isMentioned=${isMentioned}, chatId=${chatId.slice(0, 12)}...`,
  );

  // 群聊必须 @机器人，私聊直接回复
  if (!isDM && !isMentioned) {
    pushEvent(raw, parsed as Record<string, unknown>, false, "group-no-mention");
    return c.json({ ok: true });
  }

  pushEvent(raw, parsed as Record<string, unknown>, true, isDM ? "dm" : "group-mentioned");

  // 先返回 200，避免飞书 3 秒超时重试
  void (async () => {
    try {

      const text = parseMessageText(event.message?.content);
      const chatLabel = isDM ? `DM:${chatId}` : `group:${chatId}`;
      console.log(`[feishu] ${chatLabel} user query:`, text.slice(0, 100));

      // 存入对话记忆
      if (text) {
        addMessage(chatId, "user", text);
      }

      // 接管验收口令：不调用模型或数据源，确保回复可稳定识别。
      if (isTakeoverVersionQuery(text)) {
        await replyMessage(env, messageId, TAKEOVER_VERSION_REPLY);
        addMessage(chatId, "model", TAKEOVER_VERSION_REPLY);
        return;
      }

      // 私聊也支持「日报」；群内同样走交互式卡片
      const wantsDailyReport = /日报|report/i.test(text) && !/为什么|为何|怎么|分析|吗/i.test(text);

      if (wantsDailyReport) {
        const formatErr = (err: unknown): string => {
          if (!(err instanceof Error)) return String(err);
          const cause =
            err.cause instanceof Error
              ? ` (${err.cause.message})`
              : err.cause
                ? ` (${String(err.cause)})`
                : "";
          return `${err.message}${cause}`;
        };
        let card: Record<string, unknown>;
        try {
          card = await generateDailyReport(env);
        } catch (err) {
          console.error("Daily report failed:", formatErr(err));
          try {
            await replyMessage(env, messageId, `日报生成失败：${formatErr(err)}`);
          } catch (inner) {
            console.error("Failed to send error reply:", inner);
          }
          return;
        }
        try {
          await replyWithCard(env, messageId, card);
        } catch (err) {
          console.error("Daily report send failed:", formatErr(err));
          try {
            await replyMessage(
              env,
              messageId,
              `日报已生成但发送失败：${formatErr(err)}`,
            );
          } catch (inner) {
            console.error("Failed to send error reply:", inner);
          }
        }
      } else {
        // 获取对话历史（Gemini 原生 contents[] 格式）
        const history = toGeminiContents(getHistory(chatId));

        // 自由问答：开关开启走受控 Agent（失败自动回退），否则维持现有 askQuestion
        const answer = await answerFreeform(
          text || "请给出最新数据摘要",
          history.length > 0 ? history : undefined,
        );

        await replyMessage(env, messageId, answer);

        // 存入助手回复
        addMessage(chatId, "model", answer);
      }
    } catch (err) {
      console.error("Feishu async handler error:", err);
      try {
        await replyMessage(
          env,
          messageId,
          `拉取数据失败：${err instanceof Error ? err.message : String(err)}`,
        );
      } catch (inner) {
        console.error("Feishu error reply failed:", inner);
      }
    }
  })();

  return c.json({ ok: true });
});

/** 定时日报：每天 9:00 由 Scheduler 触发，发给 Bot 所在的所有群 */
app.post("/hermes/daily", async (c) => {
  const secret = c.req.header("X-Cron-Secret");
  if (!env.hermesCronSecret || secret !== env.hermesCronSecret) {
    return c.text("Unauthorized", 401);
  }

  // 自动发现 Bot 所在的所有群
  let chatIds: string[];
  try {
    chatIds = await listBotChats(env);
    console.log(`[daily] Found ${chatIds.length} chats`);
  } catch (err) {
    console.warn("[daily] Failed to list chats, falling back to env:", err);
    chatIds = env.feishuReportChatId ? [env.feishuReportChatId] : [];
  }

  if (!chatIds.length) {
    return c.text("No chat targets found", 500);
  }

  const card = await generateDailyReport(env);
  let sent = 0;
  for (const chatId of chatIds) {
    try {
      await sendCardToChat(env, chatId, card);
      sent++;
    } catch (err) {
      console.warn(`[daily] Failed to send to ${chatId}:`, err instanceof Error ? err.message : String(err));
    }
  }

  return c.json({ ok: true, sent, total: chatIds.length });
});

const port = env.port;
console.log(`Hermes report service listening on http://127.0.0.1:${port}`);
console.log(`  GET  /hermes/report   — 预览日报`);
console.log(`  POST /hermes/ask      — 自由问答（JSON: {"question":"..."}）`);
console.log(`  POST /hermes/daily    — 定时推送（Header: X-Cron-Secret）`);
console.log(`  ALL  /mcp             — CoCo Data MCP（Bearer COCO_MCP_KEY）`);
console.log(`  POST /feishu/events   — 飞书事件回调`);

// 启动时预热：飞书 token + 知识库缓存，确保首个请求的 reaction 和搜索都是瞬时
void (async () => {
  const t0 = Date.now();
  try {
    await Promise.all([
      getTenantAccessToken(env),   // 预缓存 token，reaction 瞬时发送
      ensureWikiCache(env),         // 预缓存知识库，搜索零延迟
    ]);
    console.log(`[startup] All caches warmed in ${Date.now() - t0}ms`);
  } catch (err) {
    console.warn("[startup] Warmup failed, will lazy-load:", err);
  }
})();

serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });
