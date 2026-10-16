import { z } from "zod";
import { createHash } from "node:crypto";
import type { Env } from "./env.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const replayId = z.string().min(3).max(500).regex(/^[^/\s]+\/[^/\s]+$/);
const property = z.object({ prop: z.string().min(1).max(200), op: z.enum(["is", "is not", "contains", "does not contain", "greater", "greater or equal", "less", "less or equal"]), values: z.array(z.string().max(200)).min(1).max(20) }).strict();
export const amplitudeExtraFields = {
  cohortId: id.optional(), requestId: id.optional(),
  pageToken: z.string().min(1).max(8000).optional(),
  startTime: z.iso.datetime({ offset: true }).optional(), endTime: z.iso.datetime({ offset: true }).optional(),
  replayIds: z.array(replayId).min(1).max(100).optional(), replayId: replayId.optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
  replaySearch: z.object({
    userFilters: z.array(z.union([property.extend({ type: z.literal("property") }), z.object({ type: z.literal("cohort"), cohortId: id, negated: z.boolean().optional() }).strict()])).max(10).optional(),
    eventFilters: z.array(z.object({ eventType: z.string().min(1).max(200), op: z.enum(["greater or equal", "greater", "less or equal", "less", "is", "is not"]), count: z.number().int().min(0), filters: z.array(property.extend({ type: z.enum(["event", "user"]) })).max(10).optional() }).strict()).max(10).optional(),
    replayFilters: z.array(property.extend({ prop: z.enum(["duration", "sentiment"]) })).max(10).optional(),
    groupBys: z.object({ eventPosition: z.enum(["first", "last"]), properties: z.array(z.object({ type: z.enum(["user", "event"]), value: z.string().min(1).max(200) }).strict()).min(1).max(5) }).strict().optional(),
  }).strict().optional(),
};
export const amplitudeExtraAllowed = {
  cohort_request: ["cohortId", "userPropertyKeys"], cohort_status: ["requestId"], cohort_members: ["requestId", "offset", "limit", "prefixSha256"],
  replays: ["startTime", "endTime", "amplitudeId", "replayIds", "pageToken", "limit", "sortOrder"],
  replay_files: ["replayId", "pageToken", "limit"], replay_search: ["startDate", "endDate", "replaySearch", "limit"],
};

async function boundedText(response: Response, max = 32 * 1024 * 1024): Promise<string> {
  if (!response.body) throw new Error("Amplitude returned no response body");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length;
    if (size > max) throw new Error("Amplitude download exceeds 32 MiB; use an offline cohort export"); chunks.push(value); }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString("utf8");
}
function s3Url(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !/^(?:[a-z0-9.-]+\.)?s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(url.hostname)) throw new Error("Unexpected Amplitude download host");
  return url;
}
// Cohort CSV can contain quoted commas, escaped quotes and embedded newlines. Keep IDs as text.
export function parseCohortCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = "", quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } } else cell += ch; }
    else if (ch === '"' && !cell && !closed) quoted = true;
    else if (ch === "," || ch === "\n" || ch === "\r") {
      row.push(cell); cell = ""; closed = false;
      if (ch !== ",") { if (ch === "\r" && text[i + 1] === "\n") i++; rows.push(row); row = []; }
    } else { if (closed || ch === '"') throw new Error("Malformed cohort CSV"); cell += ch; }
  }
  if (quoted) throw new Error("Truncated cohort CSV");
  if (cell || row.length || closed) { row.push(cell); rows.push(row); }
  return rows;
}

export async function queryAmplitudeExtra(env: Env, input: Record<string, any>): Promise<Record<string, any>> {
  const op = input.operation, params = new URLSearchParams(); let path: string, body: unknown;
  if (op === "cohort_request") {
    if (!input.cohortId) throw new Error("cohort_request requires cohortId from cohorts discovery");
    path = `/api/5/cohorts/request/${input.cohortId}`; params.set("props", input.userPropertyKeys ? "1" : "0");
    for (const key of input.userPropertyKeys ?? []) params.append("propKeys", key);
  } else if (op === "cohort_status" || op === "cohort_members") {
    if (!input.requestId) throw new Error(`${op} requires requestId from cohort_request`);
    path = op === "cohort_status" ? `/api/5/cohorts/request-status/${input.requestId}` : `/api/5/cohorts/request/${input.requestId}/file`;
    if (op === "cohort_members" && input.offset && !input.prefixSha256) throw new Error("Continuation requires prefixSha256 from the same requestId");
  } else if (op === "replays" || op === "replay_files") {
    path = `/api/1/session-replays${op === "replay_files" ? "/files" : ""}`;
    if (op === "replay_files") { if (!input.replayId) throw new Error("replay_files requires replayId from replays"); params.set("replay_id", input.replayId); params.set("version", "3"); }
    if (input.replayIds && (input.amplitudeId || input.pageToken || input.limit)) throw new Error("replayIds cannot be combined with amplitudeId/pageToken/limit");
    if (input.startTime && input.endTime && Date.parse(input.startTime) > Date.parse(input.endTime)) throw new Error("startTime must not exceed endTime");
    for (const [key, param] of Object.entries({ startTime: "start_time", endTime: "end_time", amplitudeId: "amplitude_id", pageToken: "page_token", sortOrder: "sort_order" })) if (input[key]) params.set(param, input[key]);
    for (const value of input.replayIds ?? []) params.append("replay_id", value);
    if (!input.replayIds) params.set("page_size", String(input.limit ?? 25));
  } else {
    if (!input.startDate || !input.endDate || input.startDate > input.endDate || Date.parse(input.endDate) - Date.parse(input.startDate) > 30 * 86400000) throw new Error("replay_search requires explicit startDate/endDate spanning at most31 days");
    path = "/api/1/replay-search"; body = { start: input.startDate.replaceAll("-", ""), end: input.endDate.replaceAll("-", ""), ...input.replaySearch, limit: input.limit ?? 10 };
  }
  const url = new URL(path, "https://amplitude.com"); url.search = params.toString();
  let response = await fetch(url, { method: body ? "POST" : "GET", redirect: "manual", signal: AbortSignal.timeout(45000),
    headers: { Authorization: `Basic ${Buffer.from(`${env.amplitudeApiKey}:${env.amplitudeSecretKey}`).toString("base64")}`, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (op === "cohort_members" && response.status === 302) {
    const location = response.headers.get("location"); if (!location) throw new Error("Missing cohort download location");
    await response.body?.cancel();
    response = await fetch(s3Url(location), { redirect: "error", signal: AbortSignal.timeout(45000) }); // Never forward Basic credentials to S3.
  }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Amplitude ${op}: HTTP ${response.status}`); }
  const text = await boundedText(response);
  if (op === "cohort_members") {
    if (response.status !== 200) return { endpoint: path, status: "not_ready", members: null };
    const hash = createHash("sha256").update(text).digest("hex");
    if (input.prefixSha256 && input.prefixSha256 !== hash) throw new Error("Cohort file changed; restart pagination");
    const [columns, ...rows] = parseCohortCsv(text.replace(/^\uFEFF/, ""));
    if (!columns?.includes("amplitude_id") || new Set(columns).size !== columns.length || rows.some(r => r.length !== columns.length)) throw new Error("Unexpected cohort CSV schema");
    const offset = input.offset ?? 0, limit = input.limit ?? 25;
    const members = rows.slice(offset, offset + limit).map(r => Object.fromEntries(columns.map((c,i) => [c,r[i]])));
    if (JSON.stringify(members).length > 60000) throw new Error("Cohort page too large; lower limit");
    return { endpoint: path, status: "ready", columns, members, totalRows: rows.length, prefixSha256: hash, nextOffset: offset + limit < rows.length ? offset + limit : null,
      notes: ["成员为本次异步导出的快照，目录 size 可能过期。ID保持字符串；未跨平台映射身份。续页保持 requestId。"] };
  }
  const data = JSON.parse(text);
  if (!data || data.error || data.success === false) throw new Error("Amplitude returned a failed response");
  if (op === "cohort_request" && (typeof data.request_id !== "string" || typeof data.cohort_id !== "string")) throw new Error("Invalid cohort request response");
  if (op === "cohort_status" && !["JOB INPROGRESS", "JOB COMPLETED"].includes(data.async_status)) throw new Error("Unknown cohort job status");
  if (op === "replays" && (!Array.isArray(data.session_replays) || data.session_replays.some((r: any) => typeof r.replay_id !== "string" || (typeof r.amplitude_id === "number" && !Number.isSafeInteger(r.amplitude_id))))) throw new Error("Invalid replay list response");
  if (op === "replay_files") { if (!Array.isArray(data.files) || !data.files.every((v: unknown) => typeof v === "string")) throw new Error("Invalid replay files response"); data.files.forEach(s3Url); }
  if (["replays", "replay_files"].includes(op) && data.next_page_token !== null && typeof data.next_page_token !== "string") throw new Error("Invalid replay cursor");
  if (op === "replay_search" && (!Array.isArray(data.data) || !data.metadata || typeof data.metadata.pre_filter_capped !== "boolean")) throw new Error("Invalid replay search response");
  if (text.length > 60000) throw new Error("Amplitude response exceeds60000 characters; lower limit");
  return { endpoint: path, data, notes: [op.startsWith("cohort") ? "异步下载：只请求一次，保存 request_id，状态完成后再下载。请求会消耗下载配额。" : "仅项目已采集且仍保留的录像；空列表不代表用户未使用应用。游标保持原样和同一筛选/排序。文件URL15分钟有效，仅含本页，不能称已播放录像或前台净时长。搜索无分页且初筛最多1000会话，保留metadata说明截断。"] };
}
