import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Env } from "./env.js";
import { getGcsToken } from "./cache.js";
import { streamAmplitudeExportHour, uploadTime } from "./amplitude-export.js";

const key = z.string().min(1).max(200);
export const exportRequestSchema = z.object({
  uploadHour: z.string(), endUploadHour: z.string(),
  user: z.string().min(1).max(255).optional(), eventType: key.optional(),
  exportFields: z.array(key).min(1).max(30).optional(),
  eventPropertyKeys: z.array(key).min(1).max(20).optional(),
  userPropertyKeys: z.array(key).min(1).max(20).optional(),
}).strict().superRefine((v, ctx) => {
  try {
    const start = uploadTime(v.uploadHour), end = uploadTime(v.endUploadHour);
    if (end < start || end - start >= 31 * 86400000) throw new Error("Export range must be ordered and at most 31 days");
  } catch (e) { ctx.addIssue({code:"custom", message:(e as Error).message}); }
});
type Request = z.infer<typeof exportRequestSchema>;
type State = { jobId: string; status: "running" | "complete" | "failed"; completedHours: number;
  pages: number; records: number; updatedAt: string; error?: string };
const note = "原始事件按 UTC server_upload_time 上传小时导出，仅当前凭据项目。分页数据来自任务持久结果；complete 只证明指定上传范围扫描完毕，不代表事件发生日完整、去重用户或前台净时长。";

function config(env: Env) {
  const bucket = env.amplitudeExportBucket, job = env.amplitudeExportJob;
  if (!bucket || !/^[a-z0-9][a-z0-9.-]{1,220}[a-z0-9]$/.test(bucket) || !job ||
      !/^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/jobs\/[a-z0-9-]+$/.test(job)) throw new Error("Amplitude offline export is not configured");
  return { bucket, job };
}
async function google(url: string, init: RequestInit = {}) {
  const token = await getGcsToken();
  if (!token) throw new Error("Google runtime identity required for offline export");
  return fetch(url, { ...init, headers:{...init.headers, Authorization:`Bearer ${token}`}, redirect:"error", signal:AbortSignal.timeout(30000) });
}
function objectUrl(env: Env, jobId: string, file: string) {
  return `https://storage.googleapis.com/storage/v1/b/${config(env).bucket}/o/${encodeURIComponent(`amplitude-exports/${jobId}/${file}`)}`;
}
async function read<T>(env: Env, jobId: string, file: string): Promise<T | null> {
  const r = await google(objectUrl(env,jobId,file)+"?alt=media");
  if (r.status === 404) { await r.body?.cancel(); return null; }
  if (!r.ok) { await r.body?.cancel(); throw new Error(`Export storage read failed (${r.status})`); }
  return r.json() as Promise<T>;
}
async function write(env: Env, jobId: string, file: string, data: unknown, createOnly = false) {
  const name = encodeURIComponent(`amplitude-exports/${jobId}/${file}`);
  const r = await google(`https://storage.googleapis.com/upload/storage/v1/b/${config(env).bucket}/o?uploadType=media&name=${name}${createOnly ? '&ifGenerationMatch=0' : ''}`,
    {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(data)});
  await r.body?.cancel();
  if (!r.ok) throw new Error(`Export storage write failed (${r.status})`);
}

export async function startExport(env: Env, raw: unknown) {
  const request = exportRequestSchema.parse(raw), {job} = config(env), jobId = randomUUID();
  await write(env,jobId,"request.json",request,true);
  let rejectedStatus: number | undefined;
  // No automatic retry: a timed-out dispatch may already have created an execution.
  try {
    const r = await google(`https://run.googleapis.com/v2/${job}:run`, {method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({overrides:{containerOverrides:[{env:[{name:"COCO_EXPORT_JOB_ID",value:jobId}]}],taskCount:1}})});
    if (!r.ok) {
      await r.body?.cancel();
      // A server error or timeout may occur after execution was accepted.
      if ([400,401,403,404,405,422,429].includes(r.status)) {
        rejectedStatus=r.status;
        await write(env,jobId,"dispatch.json",{status:"rejected",httpStatus:r.status});
      }
      throw new Error("Export dispatch did not succeed");
    }
    const operation = await r.json() as {name?: string};
    if (!operation.name || !operation.name.startsWith(job.slice(0,job.indexOf('/jobs/'))+'/operations/')) throw new Error("Unexpected export dispatch response");
    await write(env,jobId,"dispatch.json",{operation:operation.name});
    return {jobId,status:"queued",note};
  } catch {
    if(rejectedStatus) return {jobId,status:"rejected",httpStatus:rejectedStatus,note:note+" 调度被拒绝，没有确认执行；修复调度权限或配置后再申请新任务。"};
    return {jobId,status:"dispatch_unconfirmed",note:note+" 调度结果未确认，不要自动重建任务；用 export_status 查询此 jobId。"};
  }
}

export async function exportStatus(env: Env, id: string) {
  const jobId = z.string().uuid().parse(id);
  const request = await read<Request>(env,jobId,"request.json");
  if (!request) throw new Error("Export job not found");
  const state = await read<State>(env,jobId,"state.json");
  if (state?.status === "complete" || state?.status === "failed") return {...state,request,note};
  const dispatch = await read<{operation?:string;status?:string;httpStatus?:number}>(env,jobId,"dispatch.json");
  if (dispatch) {
    if(dispatch.status==='rejected')return {jobId,status:"rejected",httpStatus:dispatch.httpStatus,request,note};
    const prefix = config(env).job.split('/jobs/')[0]+'/operations/';
    if (!dispatch.operation?.startsWith(prefix) || !/^[a-zA-Z0-9/_-]+$/.test(dispatch.operation)) throw new Error("Invalid stored export operation");
    const r = await google(`https://run.googleapis.com/v2/${dispatch.operation}`);
    if (!r.ok) { await r.body?.cancel(); throw new Error(`Export execution status unavailable (${r.status})`); }
    const operation = await r.json() as {done?: boolean; error?: unknown};
    if (operation.done) {
      const latest = await read<State>(env,jobId,"state.json");
      if(latest?.status==='complete' || latest?.status==='failed')return {...latest,request,note};
      return {...latest,jobId,status:"failed",request,note,error:"Execution ended without a complete result manifest"};
    }
  }
  return {...state,jobId,status:state?.status ?? (dispatch ? "queued" : "dispatch_unconfirmed"),request,note};
}

export async function exportPage(env: Env, id: string, page: number) {
  const jobId = z.string().uuid().parse(id);
  z.number().int().min(0).max(10000000).parse(page);
  const state = await read<State>(env,jobId,"state.json");
  if (!state || page >= state.pages) throw new Error("Export page is not committed; query export_status first");
  const data = await read<{uploadHour:string;events:Record<string,unknown>[]}>(env,jobId,`pages/${page}.json`);
  if (!data) throw new Error("Committed export page is missing");
  return {...data,jobId,page,nextPage:page+1 < state.pages ? page+1 : null,rangeComplete:state.status==='complete',committedPages:state.pages,note};
}

export async function runExportWorker(env: Env, id: string) {
  const jobId = z.string().uuid().parse(id);
  if(!env.amplitudeApiKey || !env.amplitudeSecretKey)throw new Error('Amplitude credentials required');
  const request = exportRequestSchema.parse(await read(env,jobId,"request.json"));
  // Create-only lease prevents duplicate executions from publishing interleaved pages.
  await write(env,jobId,"worker.json",{startedAt:new Date().toISOString()},true);
  const state: State = {jobId,status:"running",completedHours:0,pages:0,records:0,updatedAt:new Date().toISOString()};
  const save = () => { state.updatedAt=new Date().toISOString(); return write(env,jobId,"state.json",state); };
  await save();
  try {
    for(let hour=uploadTime(request.uploadHour);hour<=uploadTime(request.endUploadHour);hour+=3600000) {
      const uploadHour=new Date(hour).toISOString().slice(0,13).replaceAll('-','');
      let nextPage=state.pages;
      const {endUploadHour, ...filters}=request;
      const result=await streamAmplitudeExportHour(env,{...filters,uploadHour},async events=>{
        await write(env,jobId,`pages/${nextPage}.json`,{uploadHour,events});nextPage++;
      });
      // Publish pages only after the entire hour passes ZIP/JSON validation.
      state.pages=nextPage;state.completedHours++;
      state.records+=result.status==='ok' ? result.matchedRecordsScanned : 0;
      await save();
    }
    state.status='complete';await save();
  } catch {
    state.status='failed';state.error='Export failed; only committed hours are readable. Upstream, format or storage failure; no full-range total.';
    await save();throw new Error(state.error);
  }
}
