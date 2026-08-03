import https from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { Env } from "./env.js";

type FunctionCall = { name: string; args?: Record<string, unknown>; id?: string };
type FunctionResponse = { name: string; id?: string; response: Record<string, unknown> };
type ContentPart = {
  text?: string;
  thought?: boolean;
  functionCall?: FunctionCall;
  functionResponse?: FunctionResponse;
};

type GenerateContentResponse = {
  candidates?: Array<{
    content?: { role?: string; parts?: ContentPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: {
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
  error?: { message?: string };
};

function resolveProxyUrl(): string | undefined {
  return (
    process.env.HTTPS_PROXY?.trim() ||
    process.env.https_proxy?.trim() ||
    process.env.HTTP_PROXY?.trim() ||
    process.env.http_proxy?.trim() ||
    undefined
  );
}

function httpsPostJson(url: string, body: unknown): Promise<GenerateContentResponse> {
  const proxyUrl = resolveProxyUrl();
  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: 120_000,
        agent,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            const data = JSON.parse(text) as GenerateContentResponse;
            if (res.statusCode && res.statusCode >= 400) {
              reject(
                new Error(
                  `Gemini API error ${res.statusCode}: ${data.error?.message ?? text.slice(0, 300)}`,
                ),
              );
              return;
            }
            resolve(data);
          } catch {
            reject(new Error(`Invalid Gemini response: ${text.slice(0, 300)}`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Gemini request timeout (120s)")));
    req.on("error", (err) => {
      const proxyHint = proxyUrl
        ? `（当前代理: ${proxyUrl}）`
        : "（未设置 HTTPS_PROXY；Node/终端不会自动走 VPN 系统代理）";
      reject(new Error(`${err.message} ${proxyHint}`));
    });
    req.write(payload);
    req.end();
  });
}

function extractAnswerText(data: GenerateContentResponse): string {
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text ?? "")
    .join("");
}

export async function generateGeminiReply(
  env: Env,
  systemPrompt: string,
  userPrompt: string,
  history?: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }>,
): Promise<string> {
  const apiKey = env.geminiApiKey;
  const model = env.geminiModel;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const data = await httpsPostJson(url, {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [
      ...(history ?? []),
      { role: "user" as const, parts: [{ text: userPrompt }] },
    ],
    generationConfig: {
      temperature: 0.3,
      // 2.5 系列 thinking tokens 也计入 maxOutputTokens；关闭 thinking 避免正文被截断
      maxOutputTokens: 4096,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const finishReason = data.candidates?.[0]?.finishReason ?? "UNKNOWN";
  const text = extractAnswerText(data).trim();

  if (!text) {
    const thoughts = data.usageMetadata?.thoughtsTokenCount ?? 0;
    const output = data.usageMetadata?.candidatesTokenCount ?? 0;
    throw new Error(
      `Gemini returned empty text (finishReason=${finishReason}, outputTokens=${output}, thoughtTokens=${thoughts})`,
    );
  }

  if (finishReason === "MAX_TOKENS") {
    return `${text}\n\n（回答因 token 上限被截断，可缩短问题或联系管理员调高 maxOutputTokens）`;
  }

  return text;
}

// ── 工具增强生成（Gemini function calling）──────────────────────────────
// 供受控 Agent 使用；不改动上面的 generateGeminiReply / Json 行为。

/** LLM 可见的工具声明（Gemini function-declaration 的 OpenAPI 子集）。 */
export interface ToolDeclarationInput {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** 单次工具调用记录（用于可观测性与回退判断）。 */
export interface AgentToolCall {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface GenerateWithToolsResult {
  text: string;
  toolCalls: AgentToolCall[];
  steps: number;
}

export interface GenerateWithToolsOptions {
  systemPrompt: string;
  userPrompt: string;
  history?: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }>;
  tools: ToolDeclarationInput[];
  /** 工具名 → 后端执行函数；返回值会被 JSON 序列化回灌给模型。 */
  registry: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  maxSteps?: number;
}

/**
 * 有界 function-calling 循环：模型自行决定是否调用白名单工具，
 * 后端执行并把结果回灌，直到模型给出自然语言回答或达到步数上限。
 *
 * 达到步数上限仍无最终回答时抛错，调用方（Phase 3 的 index.ts）据此回退到 askQuestion。
 */
export async function generateWithTools(
  env: Env,
  opts: GenerateWithToolsOptions,
): Promise<GenerateWithToolsResult> {
  const model = env.geminiModel;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.geminiApiKey}`;
  const maxSteps = opts.maxSteps ?? 5;
  const requestTools = [{ functionDeclarations: opts.tools }];

  const contents: Array<{ role: "user" | "model"; parts: ContentPart[] }> = [
    ...(opts.history ?? []).map((h) => ({ role: h.role, parts: h.parts as ContentPart[] })),
    { role: "user", parts: [{ text: opts.userPrompt }] },
  ];
  const toolCalls: AgentToolCall[] = [];

  for (let step = 1; step <= maxSteps; step++) {
    const data = await httpsPostJson(url, {
      systemInstruction: { parts: [{ text: opts.systemPrompt }] },
      contents,
      tools: requestTools,
      generationConfig: {
        // 工具路径用低温，降低指标误选 / 数值臆测的随机性
        temperature: 0.1,
        maxOutputTokens: 4096,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const calls = parts
      .map((p) => p.functionCall)
      .filter((c): c is FunctionCall => !!c && !!c.name);

    if (calls.length === 0) {
      const finishReason = candidate?.finishReason ?? "UNKNOWN";
      const text = extractAnswerText(data).trim();
      if (!text) {
        throw new Error(
          `Gemini(tools) returned empty text (finishReason=${finishReason}, step=${step})`,
        );
      }
      if (finishReason === "MAX_TOKENS") {
        return {
          text: `${text}\n\n（回答因 token 上限被截断，可缩短问题或联系管理员调高 maxOutputTokens）`,
          toolCalls,
          steps: step,
        };
      }
      return { text, toolCalls, steps: step };
    }

    // 保留模型这一轮的原始 content（含 functionCall），以便与 functionResponse 关联
    contents.push({ role: "model", parts });

    const responseParts: ContentPart[] = [];
    for (const call of calls) {
      const args = (call.args ?? {}) as Record<string, unknown>;
      const impl = opts.registry[call.name];
      let response: Record<string, unknown>;
      if (!impl) {
        const error = `unknown tool: ${call.name}`;
        toolCalls.push({ name: call.name, args, ok: false, error });
        response = { error };
      } else {
        try {
          const result = await impl(args);
          toolCalls.push({ name: call.name, args, ok: true, result });
          response = { result };
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          toolCalls.push({ name: call.name, args, ok: false, error });
          response = { error };
        }
      }
      responseParts.push({ functionResponse: { name: call.name, id: call.id, response } });
    }
    contents.push({ role: "user", parts: responseParts });
  }

  throw new Error(`agent exceeded maxSteps=${maxSteps} without a final answer`);
}

/** 调用 Gemini 并约束输出为 JSON，返回类型安全的解析结果 */
export async function generateGeminiJson<T>(
  env: Env,
  systemPrompt: string,
  userPrompt: string,
): Promise<T> {
  const apiKey = env.geminiApiKey;
  const model = env.geminiModel;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const data = await httpsPostJson(url, {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingBudget: 0 },
      responseMimeType: "application/json",
    },
  });

  const finishReason = data.candidates?.[0]?.finishReason ?? "UNKNOWN";
  const text = extractAnswerText(data).trim();

  if (!text) {
    throw new Error(
      `Gemini JSON returned empty (finishReason=${finishReason})`,
    );
  }

  // 去掉可能的 markdown 代码块包裹
  const json = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  try {
    return JSON.parse(json) as T;
  } catch {
    throw new Error(
      `Gemini JSON parse failed (finishReason=${finishReason}). Raw: ${text.slice(0, 300)}`,
    );
  }
}
