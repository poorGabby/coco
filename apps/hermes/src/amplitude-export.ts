import { createHash } from "node:crypto";
import { createGunzip, type Gunzip } from "node:zlib";
import { finished } from "node:stream/promises";
import { Unzip, UnzipInflate } from "fflate";
import type { Env } from "./env.js";

export type ExportInput = { uploadHour?: string; endUploadHour?: string; prefixSha256?: string; user?: string; eventType?: string;
  exportFields?: string[]; eventPropertyKeys?: string[]; userPropertyKeys?: string[]; offset?: number; limit?: number };
type Input = ExportInput;

export function uploadTime(hour?: string) {
  if (!hour || !/^\d{8}T\d{2}$/.test(hour)) throw new Error("export_events requires uploadHour YYYYMMDDTHH in UTC");
  const iso = `${hour.slice(0,4)}-${hour.slice(4,6)}-${hour.slice(6,8)}T${hour.slice(9)}:00:00Z`;
  const time = new Date(iso);
  if (!Number.isFinite(time.getTime()) || time.toISOString().slice(0,13) + ":00:00Z" !== iso || time.getTime() > Date.now() - 3 * 3600000) throw new Error("Upload hour must be valid and ended at least 2 hours ago");
  return time.getTime();
}

export async function queryAmplitudeExport(env: Env, input: Input) {
  const start = uploadTime(input.uploadHour);
  if (!input.endUploadHour) return querySingleHour(env, input);
  const end = uploadTime(input.endUploadHour);
  if (end < start || end - start >= 31 * 86400000) throw new Error("Upload range must be ordered and at most 31 days");
  // Process one hour/page per call; continuation avoids holding a connection for an entire range.
  const page = await querySingleHour(env, input);
  const sameHour = page.status === 'ok' && page.hasMore;
  const nextHour = new Date(start + 3600000).toISOString().slice(0,13).replaceAll('-','').replace(':','');
  return { ...page, endUploadHour: input.endUploadHour, rangeExhausted: !sameHour && start === end,
    nextQuery: sameHour ? { ...input, operation: 'export_events', offset: page.nextOffset, prefixSha256: page.prefixSha256 } :
      start < end ? { ...input, operation: 'export_events', uploadHour: nextHour, offset: 0, prefixSha256: undefined } : null,
    rangeNote: '每次仅处理一个上传小时的一页；使用 nextQuery 原样续查直到 null。范围内全部响应与分页收齐前不得声称完整；不是事件发生日快照，不在此推断用户去重或净时长。' };
}

// The worker supplies a backpressured sink; ordinary MCP calls retain their original limits.
export async function streamAmplitudeExportHour(env: Env, input: Input, sink: (events: Record<string, unknown>[]) => Promise<void>) {
  uploadTime(input.uploadHour);
  if (input.offset || input.prefixSha256 || input.endUploadHour) throw new Error("Batch hour must start at offset zero without a range");
  return querySingleHour(env, input, sink);
}

async function querySingleHour(env: Env, input: Input, sink?: (events: Record<string, unknown>[]) => Promise<void>) {
  const hour = input.uploadHour!;
  const offset = input.offset ?? 0, limit = input.limit ?? 25;
  if (offset > 0 && !input.prefixSha256) throw new Error("Export pagination requires the previous prefixSha256 to detect changes in preceding matched records");
  const endpoint = "/api/2/export", query = new URLSearchParams({ start: hour, end: hour });
  const response = await fetch(`https://amplitude.com${endpoint}?${query}`, { method: "GET", redirect: "error",
    headers: { Authorization: `Basic ${Buffer.from(`${env.amplitudeApiKey}:${env.amplitudeSecretKey}`).toString("base64")}` },
    signal: AbortSignal.timeout(sink ? 3600000 : 120000) });
  const base = { source: "Amplitude Export API", endpoint, uploadHour: hour, timezone: "UTC", formalKpi: false, fetchedAt: new Date().toISOString(),
    notes: ["范围是server_upload_time上传小时，不是事件发生日；迟到事件、跨日会话、重复事件与身份合并均未在此重算。",
      "仅当前凭据项目。返回原始记录而非去重用户/净使用时长；跨小时不能直接求完整业务指标。分页须保持筛选和字段不变并传prefixSha256，前序匹配记录变化需重新开始；有下一页时本次未扫描完整小时，不返回全小时总数。"] };
  if (response.status === 404) {
    await response.body?.cancel();
    if (offset > 0) throw new Error("Export prefix disappeared; restart pagination from offset 0");
    return { ...base, status: "no_data_for_upload_hour" as const, events: [], nextOffset: null };
  }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Amplitude export: HTTP ${response.status}`); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Export response has no body");
  const started = Date.now();
  let compressed = 0, expanded = 0, records = 0, matches = 0;
  const fields = input.exportFields ?? ["event_type", "event_time", "server_upload_time", "user_id", "amplitude_id", "session_id"];
  const prefixHash = createHash("sha256").update(JSON.stringify({hour, user: input.user, eventType: input.eventType, fields,
    eventPropertyKeys: input.eventPropertyKeys, userPropertyKeys: input.userPropertyKeys}) + '\n'), pageComplete = new Error("page complete");
  let hasMore = false, cursorVerified = offset === 0;
  type Entry = { name: string; decoder: TextDecoder; tail: string;
    ended: boolean; gzip?: Gunzip; error?: Error; pending?: Promise<void> };
  const entries: Entry[] = [];
  let queue: Array<{ entry: Entry; bytes: Uint8Array; final: boolean }> = [];
  let queuedBytes = 0;
  const events: Record<string, unknown>[] = [];
  const selected = (value: unknown, keys: string[]) => {
    const obj = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    return { values: Object.fromEntries(keys.filter(k => Object.hasOwn(obj,k)).map(k => [k,obj[k]])), missingKeys: keys.filter(k => !Object.hasOwn(obj,k)) };
  };
  function consumeLine(line: string) {
    if (!line.trim()) return;
    if (line.length > 2 * 1024 * 1024) throw new Error("Export event exceeds 2 MiB");
    if (++records > (sink ? 100000000 : 2000000)) throw new Error("Export hour exceeds record limit");
    let row: Record<string, unknown>;
    try { row = JSON.parse(line, (key, value, context?: {source?: string}) =>
      ["amplitude_id", "session_id", "event_id"].includes(key) && typeof value === "number" && !Number.isSafeInteger(value)
        ? context?.source ?? (() => { throw new Error('Exact identifier parsing requires Node 22'); })() : value); }
    catch { throw new Error("Export contains invalid JSON or unsupported identifiers; no partial counts returned"); }
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Invalid export event shape");
    if (input.user !== undefined && row.user_id !== input.user) return;
    if (input.eventType !== undefined && row.event_type !== input.eventType) return;
    matches++;
    if (matches <= offset) {
      prefixHash.update(line).update("\n");
      if (matches === offset) {
        if (prefixHash.copy().digest("hex") !== input.prefixSha256) throw new Error("Export prefix changed; restart pagination from offset 0");
        cursorVerified = true;
      }
      return;
    }
    if (!sink && events.length >= limit) { hasMore = true; throw pageComplete; }
    prefixHash.update(line).update("\n");
    for (const key of ["amplitude_id", "session_id", "event_id"]) if (fields.includes(key) && typeof row[key] === "number" && !Number.isSafeInteger(row[key])) throw new Error("Export identifier exceeds safe integer range; cannot return a rounded ID");
    const event = selected(row, fields);
    events.push({ ...event.values, missingFields: event.missingKeys,
      ...(input.eventPropertyKeys ? { selectedEventProperties: selected(row.event_properties,input.eventPropertyKeys) } : {}),
      ...(input.userPropertyKeys ? { selectedUserProperties: selected(row.user_properties,input.userPropertyKeys) } : {}),
    });
  }
  function consume(entry: Entry, bytes: Uint8Array, final = false) {
    expanded += bytes.length;
    if (expanded > (sink ? 128 : 1) * 1024 * 1024 * 1024) throw new Error("Export hour exceeds expanded size limit");
    const text = entry.tail + entry.decoder.decode(bytes, { stream: !final });
    let start = 0, end: number;
    while ((end = text.indexOf("\n", start)) >= 0) { consumeLine(text.slice(start,end)); start = end + 1; }
    entry.tail = text.slice(start);
    if (entry.tail.length > 2 * 1024 * 1024) throw new Error("Export event exceeds 2 MiB");
    if (final) { consumeLine(entry.tail); entry.tail = ""; entry.ended = true; }
  }
  let sinkTail: Promise<void> = Promise.resolve();
  function flushEvents(): Promise<void> {
    if (!sink || !events.length) return sinkTail;
    const pending = events.splice(0);
    sinkTail = sinkTail.then(async () => {
      let page: Record<string, unknown>[] = [], chars = 2;
      for (const event of pending) {
        const size = JSON.stringify(event).length + 1;
        if (size > 55000) throw new Error("Export event projection exceeds page size; select fewer fields");
        if (page.length === 100 || chars + size > 55000) { await sink(page); page = []; chars = 2; }
        page.push(event); chars += size;
      }
      if (page.length) await sink(page);
    });
    return sinkTail;
  }
  const unzip = new Unzip(file => {
    if (file.name.endsWith("/")) return;
    if (entries.length >= (sink ? 4096 : 256) || entries.some(e => e.name === file.name)) throw new Error("Invalid or oversized export file directory");
    const entry: Entry = { name: file.name, decoder: new TextDecoder("utf-8", { fatal: true }), tail: "", ended: false };
    entries.push(entry);
    if (file.name.endsWith(".gz")) {
      entry.gzip = createGunzip();
      entry.gzip.on("error", e => { entry.error = e; });
      entry.gzip.on("data", bytes => {
        try {
          consume(entry,bytes);
          if (sink) {
            entry.gzip!.pause();
            entry.pending = flushEvents().then(() => { entry.gzip!.resume(); }, e => { entry.error = e; entry.gzip!.destroy(e); });
          }
        } catch (e) { entry.error = e as Error; entry.gzip!.destroy(e as Error); }
      });
    }
    file.ondata = (error,bytes,final) => {
      if (error) throw new Error("Invalid export ZIP stream");
      queuedBytes += bytes.length;
      if (queuedBytes > 32 * 1024 * 1024) throw new Error("Export ZIP chunk expansion exceeds memory limit");
      queue.push({ entry, bytes, final });
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  async function drain() {
    // Process ZIP chunks in archive order, including gzip flushes, so offset ordering is stable.
    for (const { entry, bytes, final } of queue) {
      if (entry.gzip) {
        if (entry.error) throw entry.error;
        await new Promise<void>((resolve,reject) => entry.gzip!.write(bytes, e => e ? reject(e) : resolve()));
        await entry.pending;
        if (final) { entry.gzip.end(); await finished(entry.gzip); consume(entry,new Uint8Array(),true); }
        if (entry.error) throw entry.error;
      } else consume(entry,bytes,final);
      await flushEvents();
    }
    queue = []; queuedBytes = 0;
  }
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      compressed += value.length;
      if (compressed > (sink ? 4096 : 128) * 1024 * 1024) throw new Error("Export hour exceeds compressed size limit");
      for (let i=0;i<value.length;i+=16384) {
        if (Date.now()-started > (sink ? 3600000 : 120000)) throw new Error("Export processing timed out; no complete counts returned");
        unzip.push(value.subarray(i,i+16384)); await drain();
      }
    }
    unzip.push(new Uint8Array(),true); await drain();
  } catch (error) { if (error !== pageComplete) throw error; } finally {
    await reader.cancel();
    for (const entry of entries) entry.gzip?.destroy();
  }
  if (!hasMore && (!entries.length || entries.some(e => !e.ended))) throw new Error("Export archive has missing or unfinished files");
  if (!cursorVerified) throw new Error("Export prefix disappeared; restart pagination from offset 0");
  const prefixSha256 = prefixHash.digest("hex");
  if (JSON.stringify(events).length > 60000) throw new Error("Export page exceeds 60000 characters; choose fewer fields or lower limit");
  return { ...base, status: "ok" as const, prefixSha256, scannedRecordCount: records, matchedRecordsScanned: matches, scanComplete: !hasMore, compressedBytes: compressed, expandedBytes: expanded,
    events, offset, limit, hasMore, nextOffset: hasMore ? offset + events.length : null,
    filters: { user: input.user, eventType: input.eventType }, exportFields: fields };
}
