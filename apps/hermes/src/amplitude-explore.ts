import { z } from "zod";
import type { Env } from "./env.js";
import { reportDateStr, REPORT_TIME_ZONE } from "./report-timezone.js";
import { daysBetween } from "./agent/tool-impls.js";
import { amplitudeExtraFields, amplitudeExtraAllowed, queryAmplitudeExtra } from "./amplitude-extra.js";
import { queryAmplitudeExport } from "./amplitude-export.js";
import { startExport, exportStatus, exportPage } from "./amplitude-export-jobs.js";

// Official Dashboard REST / Taxonomy APIs; separate from the fixed KPI contracts.
const BASE = "https://amplitude.com";
const name = z.string().trim().min(1).max(200);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => {
  const d = new Date(s + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}, "Invalid calendar date");
const filter = z.object({
  subprop_type: z.enum(["event", "user"]), subprop_key: name,
  subprop_op: z.enum(["is", "is not", "contains", "does not contain", "less", "less or equal", "greater", "greater or equal", "set is", "set is not"]),
  subprop_value: z.array(z.string().max(200)).min(1).max(20),
}).strict();
const event = z.object({ event_type: name, filters: z.array(filter).max(5).optional(),
  group_by: z.array(z.object({ type: z.enum(["event", "user"]), value: name }).strict()).max(1).optional(),
}).strict();

export const amplitudeExploreSchema = z.object({
  ...amplitudeExtraFields,
  operation: z.enum(["events", "event_properties", "user_properties", "sessions", "segmentation", "funnel", "composition", "retention", "chart", "realtime", "user_search", "user_activity", "users", "revenue_ltv", "cohorts", "cohort_usage", "export_events", "cohort_request", "cohort_status", "cohort_members", "replays", "replay_files", "replay_search", "export_start", "export_status", "export_page"]),
  exportJobId: z.string().uuid().optional(),
  page: z.number().int().min(0).max(10000000).optional(),
  uploadHour: z.string().regex(/^\d{8}T\d{2}$/).optional(),
  endUploadHour: z.string().regex(/^\d{8}T\d{2}$/).optional(),
  prefixSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  exportFields: z.array(name).min(1).max(30).optional(),
  userMetric: z.enum(["active", "new"]).optional(),
  ltvMetric: z.enum(["arpu", "arppu", "revenue", "paying_users"]).optional(),
  userType: z.enum(["any", "active", "new"]).optional(),
  groupBy2: name.optional(),
  formula: z.string().trim().min(1).max(1000).optional().describe("Amplitude 公式，仅转交上游，例如 UNIQUES(A)/UNIQUES(B)；不在本地执行"),
  rollingWindow: z.number().int().min(1).max(365).optional(),
  rollingAverage: z.number().int().min(1).max(365).optional(),
  sessionBins: z.object({ unit: z.enum(["seconds", "minutes", "hours"]), min: z.number().min(0), max: z.number().positive(), size: z.number().positive().optional() }).strict().optional(),
  user: z.string().trim().min(1).max(255).optional().describe("user_search 的用户ID/设备ID/Amplitude ID；匹配结果不证明与 kitty 身份相同"),
  amplitudeId: z.string().regex(/^\d{1,20}$/).optional().describe("user_activity 必须使用 user_search 返回的 Amplitude ID，不使用 kitty UUID"),
  direction: z.enum(["earliest", "latest"]).optional(),
  eventPropertyKeys: z.array(name).min(1).max(20).optional().describe("user_activity 需读取的事件属性名，先查字典；缺失不等于0"),
  userPropertyKeys: z.array(name).min(1).max(20).optional().describe("user_activity 需读取的用户属性名，使用原始键，不加gp:；按需选择"),
  startDate: date.optional(), endDate: date.optional(),
  query: z.string().max(100).optional().describe("目录搜索词；留空列出全部可见项，再分页"),
  offset: z.number().int().min(0).max(2000000).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  eventType: name.optional().describe("event_properties 的事件名；先查 events"),
  events: z.array(event).min(1).max(5).optional(),
  measure: z.enum(["uniques", "totals", "average", "pct_dau", "sums", "value_avg", "histogram", "formula"]).optional(),
  groupBy: name.optional().describe("用户属性，如 platform、version、country 或已发现的 gp:自定义属性"),
  segments: z.array(z.object({ prop: name, op: z.enum(["is", "is not", "contains", "does not contain", "less", "greater", "set is", "set is not"]), values: z.array(z.string().max(200)).min(1).max(20) }).strict()).max(5).optional(),
  interval: z.enum(["five_minutes", "hourly", "daily", "weekly", "monthly"]).optional(),
  mode: z.enum(["ordered", "unordered", "sequential"]).optional(),
  conversionWindowSeconds: z.number().int().min(1).max(2592000).optional(),
  chartId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
}).strict();

export const AMPLITUDE_EXPLORE_DESCRIPTION = "在已授权 Amplitude 项目内只读探索数据，不局限于日报固定指标。" +
  "events 搜索/分页可见事件及本周次数；event_properties/user_properties 查询属性字典；sessions 一次查询每日平均会话时长（秒）、人均会话数和区间会话时长分布（会话数，不是用户数）。" +
  "segmentation 按真实事件统计次数/人数/人均次数/数值属性均值、求和及直方图，支持分组、筛选、日期；funnel 为2至5个事件的转化漏斗；composition 按用户属性看分布；retention 为探索性新用户/活跃用户留存；chart 按已知图表ID读取保存结果。" +
  "先发现真实事件/属性，再查询，禁止猜测事件名。默认最近完结日，单次最多31天，可按时间续查但不可相加去重人数或直接平均日均值。" +
  "realtime 返回最近两天的5分钟活跃序列，不能相加为DAU；user_search 按给定标识定位用户；user_activity 用已确认Amplitude ID分页查看事件时间线，最多100条，默认基础字段，可用eventPropertyKeys/userPropertyKeys选择已发现的属性。" +
  "users 查询活跃/新增用户的分日分组结果；revenue_ltv 查询新用户 cohort 的ARPU/ARPPU/收入/付费人数，不是日报总收入或订阅状态。cohorts 列出可发现cohort及ID供segments筛选；cohort_usage 查询下载配额。" +
  "segmentation 支持最多双事件、公式、groupBy2、小时/5分钟粒度和滚动窗口；sessions 可用sessionBins指定分桶。" +
  "export_events 按明确UTC上传小时uploadHour读取原始事件，可加endUploadHour查询最多31日上传范围，每次一小时的一页，原样使用nextQuery续查到null。可按user(精确业务user_id)/eventType筛选、exportFields与属性键选择字段，按prefixSha256分页，续页不得改变筛选或字段；不能当作事件发生日完整导出。超出体积限制须离线处理。" +
  "大范围原始事件用export_start（必填uploadHour/endUploadHour，可用同样的用户/事件/字段筛选）创建私有离线任务；用返回的jobId作为exportJobId调用export_status，再用export_page的page从0逐页读取。结果持久化，不公开链接；任务未complete、页面未收齐时不称完整。dispatch_unconfirmed时查原jobId，不重复创建。" +
  "cohort_request/status/members 按请求ID异步下载成员与指定用户属性，成员CSV按哈希分页；cohort目录size不代表实际成员数。replays按UTC时间/Amplitude ID分页查录像，replay_files取得已发现录像的短期文件链接，replay_search按明确日期、事件/用户/录像属性筛选并保留截断标记，不支持有序漏斗搜索。" +
  "正式DAU/收入/正式留存仍使用固定指标工具；探索结果不能替换正式口径。没有参数支持的能力需说明，不能用已有指标冒充。";

type Input = z.infer<typeof amplitudeExploreSchema>;
type Json = Record<string, any>;

async function get(env: Env, path: string, params = new URLSearchParams()): Promise<Json> {
  const url = new URL(path, BASE);
  url.search = params.toString();
  const response = await fetch(url, { method: "GET", redirect: "error",
    headers: { Authorization: `Basic ${Buffer.from(`${env.amplitudeApiKey}:${env.amplitudeSecretKey}`).toString("base64")}` },
    signal: AbortSignal.timeout(45000),
  });
  // Never return upstream error bodies, which may echo auth or user properties.
  if (!response.ok) throw new Error(`Amplitude ${path}: HTTP ${response.status}${response.status === 429 ? "，请稍后重试或缩小区间" : ""}`);
  const result = await response.json() as Json;
  // These two documented endpoints may return their payload without a data envelope.
  if (result && result.data == null && ["/api/2/usersearch", "/api/2/useractivity", "/api/3/cohorts", "/api/3/cohorts/usage"].includes(path)) result.data = { ...result };
  if (!result || result.error || result.success === false || result.data == null) throw new Error(`Amplitude ${path}: invalid or failed response`);
  return result;
}

function quality(result: Json): string[] {
  const warnings: string[] = [];
  for (const key of ["realtimeDataMissing", "timedOutRealtimeData", "missedCacheAndNotComputed", "prunedResult", "hitChunkGroupByLimit"]) {
    if (result[key]) warnings.push(`Amplitude 标记 ${key}=true，结果可能不完整`);
  }
  if (typeof result.minSampleRate === "number" && result.minSampleRate < 1) warnings.push(`结果采样率 ${result.minSampleRate}`);
  return warnings;
}

function matrix(data: Json): { labels: string[]; values: Array<number | null> } {
  if (!Array.isArray(data.xValues) || !data.xValues.every((x: unknown) => typeof x === "string") ||
      !Array.isArray(data.series) || data.series.length !== 1 || !Array.isArray(data.series[0]) || data.series[0].length !== data.xValues.length ||
      !data.series[0].every((v: unknown) => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0))) {
    throw new Error("Amplitude session response shape changed; cannot infer values");
  }
  return { labels: data.xValues, values: data.series[0] };
}

export async function exploreAmplitude(env: Env, raw: unknown): Promise<Json> {
  const input = amplitudeExploreSchema.parse(raw);
  const op = input.operation;
  const allowed: Record<Input["operation"], string[]> = {
    ...amplitudeExtraAllowed,
    events: ["query", "offset", "limit"], event_properties: ["query", "offset", "limit", "eventType"], user_properties: ["query", "offset", "limit"],
    sessions: ["startDate", "endDate", "sessionBins"],
    segmentation: ["startDate", "endDate", "events", "measure", "groupBy", "segments", "interval", "limit", "groupBy2", "formula", "rollingWindow", "rollingAverage", "userType"],
    funnel: ["startDate", "endDate", "events", "groupBy", "segments", "mode", "conversionWindowSeconds", "limit", "interval", "userType"],
    composition: ["startDate", "endDate", "groupBy"], retention: ["startDate", "endDate", "events", "groupBy", "segments", "interval"],
    chart: ["chartId"],
    realtime: [], user_search: ["user", "offset", "limit"], user_activity: ["amplitudeId", "offset", "limit", "direction", "eventPropertyKeys", "userPropertyKeys"],
    users: ["startDate", "endDate", "userMetric", "groupBy", "segments", "interval"],
    revenue_ltv: ["startDate", "endDate", "ltvMetric", "groupBy", "segments", "interval"],
    cohorts: ["query", "offset", "limit"], cohort_usage: [],
    export_events: ["uploadHour", "endUploadHour", "prefixSha256", "user", "eventType", "exportFields", "eventPropertyKeys", "userPropertyKeys", "offset", "limit"],
    export_start: ["uploadHour", "endUploadHour", "user", "eventType", "exportFields", "eventPropertyKeys", "userPropertyKeys"],
    export_status: ["exportJobId"], export_page: ["exportJobId", "page"],
  };
  for (const key of Object.keys(input)) if (key !== "operation" && !allowed[op].includes(key)) throw new Error(`${op} does not support ${key}; do not silently drop filters`);
  const base = { source: "Amplitude", scope: "configured API-key project only", operation: op, fetchedAt: new Date().toISOString(), query: input, formalKpi: false };
  if (op === 'export_start') { const {operation,...request}=input; return {...base,...await startExport(env,request)}; }
  if (op === 'export_status') { if(!input.exportJobId)throw new Error('exportJobId is required');return {...base,...await exportStatus(env,input.exportJobId)}; }
  if (op === 'export_page') { if(!input.exportJobId || input.page===undefined)throw new Error('exportJobId and page are required');return {...base,...await exportPage(env,input.exportJobId,input.page)}; }
  if (Object.hasOwn(amplitudeExtraAllowed, op)) return { ...base, ...await queryAmplitudeExtra(env, input) };
  if (op === "export_events") return { ...base, ...await queryAmplitudeExport(env, input) };
  if (op === "cohorts" || op === "cohort_usage") {
    const endpoint = op === "cohorts" ? "/api/3/cohorts" : "/api/3/cohorts/usage";
    const { data } = await get(env, endpoint);
    if (op === "cohort_usage") {
      if (!data.rest_download || typeof data.rest_download.usage !== "number" || typeof data.rest_download.limit !== "number") throw new Error("Cohort usage response shape changed");
      return { ...base, endpoint, data: data.rest_download };
    }
    if (!Array.isArray(data.cohorts)) throw new Error("Cohorts response shape changed");
    const rows = data.cohorts.filter((v: Json) => !input.query || `${v.name ?? ""} ${v.description ?? ""}`.toLowerCase().includes(input.query.toLowerCase()))
      .map((v: Json) => ({ id: v.id, name: v.name, description: v.description, size: v.size, archived: v.archived, lastComputed: v.lastComputed }));
    const offset = input.offset ?? 0, limit = input.limit ?? 25;
    return { ...base, endpoint, items: rows.slice(offset, offset + limit), total: rows.length, offset,
      nextOffset: offset + limit < rows.length ? offset + limit : null,
      notes: ["仅可发现cohort目录；size以lastComputed为准，不是本次重新计算。使用segments中userdata_cohort与此ID筛选；不等于已下载成员。"] };
  }
  if (op === "realtime") {
    const endpoint = "/api/2/realtime", result = await get(env, endpoint), data = result.data;
    if (!Array.isArray(data.xValues) || !data.xValues.every((v: unknown) => typeof v === "string") ||
        !Array.isArray(data.seriesLabels) || !data.seriesLabels.every((v: unknown) => typeof v === "string") ||
        !Array.isArray(data.series) || data.series.length !== data.seriesLabels.length ||
        !data.series.every((series: unknown) => Array.isArray(series) && series.length === data.xValues.length &&
          series.every(v => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0)))) {
      throw new Error("Amplitude realtime response shape changed");
    }
    return { ...base, endpoint, data, warnings: quality(result), timezone: "Amplitude project setting",
      notes: ["上游最近两天的5分钟活跃序列，Today/Yesterday 按项目时区解释，具体时区未核验。不是完结日DAU，不能相加为日或区间去重人数；null不是0。"] };
  }
  if (op === "user_search" || op === "user_activity") {
    const id = op === "user_search" ? input.user : input.amplitudeId;
    if (!id) throw new Error(`${op} requires ${op === "user_search" ? "user" : "amplitudeId from a verified match"}`);
    const endpoint = op === "user_search" ? "/api/2/usersearch" : "/api/2/useractivity";
    const offset = input.offset ?? 0, limit = input.limit ?? 25;
    const params = new URLSearchParams({ user: id });
    if (op === "user_activity") {
      params.set("offset", String(offset)); params.set("limit", String(limit)); params.set("direction", input.direction ?? "latest");
    }
    const result = await get(env, endpoint, params), data = result.data;
    if (op === "user_search") {
      if (!Array.isArray(data.matches) || !data.matches.every((v: Json) => v &&
          ((typeof v.amplitude_id === "number" && Number.isSafeInteger(v.amplitude_id) && v.amplitude_id >= 0) ||
           (typeof v.amplitude_id === "string" && /^\d{1,20}$/.test(v.amplitude_id))))) throw new Error("Amplitude user search response shape changed");
      return { ...base, endpoint, matchType: data.type, offset, limit, totalReturnedByUpstream: data.matches.length,
        matches: data.matches.slice(offset, offset + limit).map((v: Json) => ({ amplitudeId: String(v.amplitude_id), userId: v.user_id ?? null })),
        nextOffset: offset + limit < data.matches.length ? offset + limit : null,
        warnings: quality(result), notes: ["可能是前缀或设备ID匹配，确认用户后再查轨迹；不自动关联 kitty UUID。分页针对本次上游匹配结果，不证明覆盖全部用户。"] };
    }
    if (!Array.isArray(data.events) || !data.events.every((v: unknown) => v && typeof v === "object" && !Array.isArray(v)) ||
        !data.userData || typeof data.userData !== "object" || Array.isArray(data.userData)) throw new Error("Amplitude user activity response shape changed");
    const pick = (row: Json, keys: string[]) => Object.fromEntries(keys.filter(k => row[k] !== undefined).map(k => [k, row[k]]));
    const properties = (value: unknown, keys: string[]) => {
      const obj = value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
      return { values: Object.fromEntries(keys.filter(k => Object.hasOwn(obj, k)).map(k => [k, obj[k]])), missingKeys: keys.filter(k => !Object.hasOwn(obj, k)) };
    };
    const events = data.events.slice(0, limit).map((v: Json) => ({
      ...pick(v, ["event_type", "event_time", "client_event_time", "server_received_time", "session_id", "platform", "os", "version"]),
      ...(input.eventPropertyKeys ? { selectedEventProperties: properties(v.event_properties, input.eventPropertyKeys) } : {}),
    }));
    const output = { ...base, endpoint, amplitudeId: id, offset, limit, direction: input.direction ?? "latest", events,
      userSummary: pick(data.userData, ["user_id", "canonical_amplitude_id", "num_events", "num_sessions", "first_used", "last_used"]),
      ...(input.userPropertyKeys ? { selectedUserProperties: properties(data.userData.properties, input.userPropertyKeys) } : {}),
      nextOffset: events.length === limit ? offset + events.length : null, hasMorePossible: events.length === limit,
      upstreamReturnedEvents: data.events.length, truncatedToLimit: data.events.length > limit,
      warnings: quality(result), notes: ["默认基础时间线，仅返回显式选择的自定义属性，missingKeys不是0或字段不存在的证明；不是全量原始事件导出。上游可为保留完整会话超额返回，本工具仍按limit截断，可能切开会话。offset分页期间新事件到达可能造成重复或漏项；有下一页不保证仍有结果。事件跨度不是前台净时长。"] };
    if (JSON.stringify(output).length > 60000) throw new Error("User activity exceeds 60000 characters; choose fewer properties or a lower limit");
    return output;
  }
  if (["events", "event_properties", "user_properties"].includes(op)) {
    if (op === "event_properties" && !input.eventType) throw new Error("event_properties requires eventType from events discovery");
    const path = op === "events" ? "/api/2/events/list" : `/api/2/taxonomy/${op === "event_properties" ? "event-property" : "user-property"}`;
    const params = new URLSearchParams();
    if (input.eventType) params.set("event_type", input.eventType);
    const result = await get(env, path, params);
    if (!Array.isArray(result.data)) throw new Error("Amplitude dictionary response shape changed");
    const rows = result.data.filter((v: Json) => !v.deleted && !v.hidden && !v.is_hidden).map((v: Json) => ({
      name: v.value ?? v.event_property ?? v.user_property, display: v.display, description: v.description, type: v.type,
      currentWeekTotals: v.totals, inactive: v.non_active, classifications: v.classifications,
    })).filter((v: Json) => !input.query || `${v.name} ${v.display ?? ""} ${v.description ?? ""}`.toLowerCase().includes(input.query.toLowerCase()));
    const offset = input.offset ?? 0, limit = input.limit ?? 50;
    return { ...base, endpoint: path, items: rows.slice(offset, offset + limit), total: rows.length, offset,
      hasMore: offset + limit < rows.length, nextOffset: offset + limit < rows.length ? offset + limit : null,
      notes: ["仅当前凭据项目的可见目录；事件本周次数不是指定历史日次数。属性定义不等于已上报。"] };
  }
  if (op === "chart") {
    if (!input.chartId) throw new Error("chart requires a verified chartId or user-provided chart URL ID");
    const path = `/api/3/chart/${input.chartId}/csv`;
    const result = await get(env, path);
    const text = typeof result.data === "string" ? result.data : JSON.stringify(result.data);
    if (text.length > 60000) throw new Error("Saved chart result exceeds 60000 characters; narrow the saved chart before querying");
    return { ...base, endpoint: path, chartId: input.chartId, data: text, warnings: quality(result), notes: ["使用该图表保存的日期、筛选与时区；不可将请求日期强加给图表结果。"] };
  }
  const endDate = input.endDate ?? reportDateStr(-1), startDate = input.startDate ?? endDate;
  if (startDate > endDate || daysBetween(startDate, endDate) > 30 || endDate > reportDateStr(-1)) throw new Error("Date range must be complete, ordered and at most 31 days");
  if (["five_minutes", "hourly"].includes(input.interval ?? "")) {
    if (!["segmentation", "funnel"].includes(op)) throw new Error(`${op} does not support subdaily intervals`);
    if (daysBetween(startDate, endDate) > (input.interval === "hourly" ? 6 : 1)) throw new Error("Subdaily interval exceeds the upstream date limit");
  }
  const params = new URLSearchParams({ start: startDate.replaceAll("-", ""), end: endDate.replaceAll("-", "") });
  const notes = ["探索查询按 Amplitude 项目时区执行；API 不回传时区，默认日期按 America/Dawson 计算，不能声称覆盖项目设置。", "探索结果不替换正式固定图表；缺失不是0，日去重之和不是区间去重，日平均值不可直接平均为区间均值。"];
  const dated = { ...base, startDate, endDate, timezone: "Amplitude project setting", defaultDateTimezone: REPORT_TIME_ZONE, notes };
  if (op === "sessions") {
    if (input.sessionBins) {
      const b = input.sessionBins, seconds = { seconds: 1, minutes: 60, hours: 3600 }[b.unit];
      if (b.min >= b.max || b.max * seconds > 86400 || (b.size && (b.size > b.max - b.min || (b.max - b.min) / b.size > 100))) throw new Error("Invalid session bins: ordered, at most 1 day and 100 bins");
    }
    const responses: Json[] = [];
    // Sequential to respect the project's shared concurrent query budget.
    for (const suffix of ["average", "peruser", "length"]) {
      const p = new URLSearchParams(params);
      if (suffix === "length" && input.sessionBins) {
        const b = input.sessionBins;
        p.set("timeHistogramConfigBinTimeUnit", b.unit); p.set("timeHistogramConfigBinMin", String(b.min)); p.set("timeHistogramConfigBinMax", String(b.max));
        if (b.size) p.set("timeHistogramConfigBinSize", String(b.size));
      }
      responses.push(await get(env, `/api/2/sessions/${suffix}`, p));
    }
    const [avg, peruser, histogram] = responses.map(r => matrix(r.data));
    if (JSON.stringify(avg.labels) !== JSON.stringify(peruser.labels)) throw new Error("Session daily series dates do not align");
    const total = histogram.values.every(v => v != null) ? histogram.values.reduce<number>((a, b) => a + b!, 0) : null;
    return { ...dated, endpoints: ["/api/2/sessions/average", "/api/2/sessions/peruser", "/api/2/sessions/length"],
      daily: avg.labels.map((label, i) => ({ date: label.slice(0, 10), averageSessionSeconds: avg.values[i], averageSessionsPerUser: peruser.values[i] })),
      distribution: histogram.labels.map((bucket, i) => ({ bucket, sessions: histogram.values[i], fraction: total && histogram.values[i] != null ? histogram.values[i]! / total : null })),
      totalSessionsInDistribution: total, warnings: responses.flatMap(quality),
      notes: [...notes, "平均时长分母是会话，分布计数也是会话，不是每用户每日使用时长/用户分布。会话定义来自项目配置；长会话可能含后台驻留，不可声称是真实前台交互时长。不能从分桶伪造精确中位数或P90。"] };
  }
  if (input.groupBy) params.set(op === "composition" ? "p" : "g", input.groupBy);
  if (input.segments) params.set("s", JSON.stringify(input.segments));
  if (input.interval) params.set("i", String({ five_minutes: -300000, hourly: -3600000, daily: 1, weekly: 7, monthly: 30 }[input.interval]));
  if (input.limit) params.set("limit", String(input.limit));
  let path: string;
  if (op === "users" || op === "revenue_ltv") {
    path = op === "users" ? "/api/2/users" : "/api/2/revenue/ltv";
    params.set("m", op === "users" ? input.userMetric ?? "active" : String({ arpu: 0, arppu: 1, revenue: 2, paying_users: 3 }[input.ltvMetric ?? "arpu"]));
    params.set("i", params.get("i") ?? "1");
    if (op === "revenue_ltv") notes.push("LTV以新增cohort和Amplitude收入事件为口径，不是当日总收入、不含额外Stripe补充，不证明支付/订阅权益；缺少收入埋点会影响结果。");
  } else if (op === "composition") {
    if (!input.groupBy) throw new Error("composition requires groupBy from the user-property dictionary");
    path = "/api/2/composition";
  } else {
    const events = input.events ?? [];
    if (!events.length) throw new Error(`${op} requires events from discovery`);
    if (op === "segmentation") {
      if (events.length > 2) throw new Error("segmentation accepts up to two events per call");
      if ((input.measure === "formula") !== Boolean(input.formula)) throw new Error("formula and measure=formula must be supplied together");
      if (input.groupBy2 && !input.groupBy) throw new Error("groupBy2 requires groupBy");
      if (input.userType === "new") throw new Error("segmentation userType supports any/active only");
      if (input.rollingWindow && input.rollingAverage) throw new Error("Choose rollingWindow or rollingAverage");
      if ((input.rollingWindow || input.rollingAverage) && ["hourly", "five_minutes"].includes(input.interval ?? "")) throw new Error("Rolling queries require day/week/month intervals");
      if (["sums", "value_avg", "histogram"].includes(input.measure ?? "") && !events[0].group_by?.length) throw new Error("Property metrics require event.group_by naming the numeric property");
      params.set("e", JSON.stringify(events[0])); params.set("m", input.measure ?? "uniques"); params.set("i", params.get("i") ?? "1");
      if (events[1]) params.set("e2", JSON.stringify(events[1]));
      if (input.groupBy2) params.set("g2", input.groupBy2);
      if (input.formula) params.set("formula", input.formula);
      if (input.userType) params.set("n", input.userType);
      if (input.rollingWindow) params.set("rollingWindow", String(input.rollingWindow));
      if (input.rollingAverage) params.set("rollingAverage", String(input.rollingAverage));
      path = "/api/2/events/segmentation";
    } else if (op === "funnel") {
      if (input.userType === "any") throw new Error("funnel userType supports new/active only");
      if (input.userType) params.set("n", input.userType);
      if (input.mode === "unordered" && (input.conversionWindowSeconds ?? 86400) % 86400 !== 0) throw new Error("unordered funnel rounds windows down to whole days; specify an exact whole-day window");
      if (events.length < 2) throw new Error("funnel needs 2 to 5 events");
      if (events.some(e => e.group_by)) throw new Error("funnel grouping must use groupBy, not per-event group_by");
      for (const e of events) params.append("e", JSON.stringify(e));
      params.set("mode", input.mode ?? "ordered"); params.set("cs", String(input.conversionWindowSeconds ?? 86400));
      path = "/api/2/funnels";
    } else {
      if (events.length !== 2 || !["_new", "_active"].includes(events[0].event_type) || !["_all", "_active"].includes(events[1].event_type)) throw new Error("Exploratory retention supports _new/_active to _all/_active; formal retention uses its fixed Chart tool");
      if (events.some(e => e.group_by)) throw new Error("retention grouping must use groupBy");
      // Omit rm: the documented default is N-day; this project's API rejects the literal "n-day".
      params.set("se", JSON.stringify(events[0])); params.set("re", JSON.stringify(events[1])); params.set("i", params.get("i") ?? "1");
      path = "/api/2/retention";
    }
  }
  const result = await get(env, path, params);
  if (JSON.stringify(result.data).length > 60000) throw new Error("Amplitude result exceeds 60000 characters; narrow date range or group count");
  return { ...dated, endpoint: path, effectiveParameters: { ...Object.fromEntries(params), ...(params.getAll("e").length > 1 ? { e: params.getAll("e") } : {}) },
    data: result.data, warnings: quality(result),
    notes: [...notes, "漏斗 cumulativeRaw 为各步人数，比例分母见 cumulative/stepByStep；漏斗后续转化可能尚未成熟。留存 incomplete=true 的点不得当作成熟留存。"] };
}
