import { test } from "node:test";
import assert from "node:assert/strict";
import type { Env } from "./env.js";
import { exploreAmplitude } from "./amplitude-explore.js";

test("Amplitude exploration preserves scope, distributions, queries and failures", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls: URL[] = [];
  let fail = false, missing = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push(url);
    assert.equal(url.origin, "https://amplitude.com"); assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error");
    if (fail) return new Response("secret must never be echoed", { status: 429 });
    let data: unknown = { series: [[0]], xValues: ["2026-09-05T00:00:00"] };
    if (url.pathname.endsWith("/average")) data = { series: [[missing ? null : 120]], xValues: ["2026-09-05T00:00:00"] };
    if (url.pathname.endsWith("/length")) data = { series: [[0, 10, 30]], xValues: ["0s-3s", "3s-10s", "10s-30s"] };
    if (url.pathname.endsWith("/list")) data = [{ value: "app_opened", totals: 10 }, { value: "app_quit", totals: 0 }, { value: "hidden", hidden: true }];
    return new Response(JSON.stringify({ data }), { status: 200 });
  };
  const env = { amplitudeApiKey: "key", amplitudeSecretKey: "secret" } as Env;
  const dates = { startDate: "2026-09-05", endDate: "2026-09-05" };
  const sessions = await exploreAmplitude(env, { operation: "sessions", ...dates });
  assert.equal(sessions.daily[0].averageSessionSeconds, 120);
  assert.equal(sessions.daily[0].averageSessionsPerUser, 0);
  assert.equal(sessions.distribution[0].sessions, 0);
  assert.equal(sessions.distribution[2].fraction, .75);
  assert.equal(sessions.totalSessionsInDistribution, 40);
  assert.equal(sessions.formalKpi, false);
  assert.match(sessions.notes.join(""), /不是每用户每日使用时长/);
  missing = true;
  assert.equal((await exploreAmplitude(env, { operation: "sessions", ...dates })).daily[0].averageSessionSeconds, null);
  const events = await exploreAmplitude(env, { operation: "events", query: "app", limit: 1 });
  assert.equal(events.total, 2); assert.equal(events.hasMore, true); assert.equal(events.nextOffset, 1);
  assert.equal((await exploreAmplitude(env, { operation: "events", offset: 1 })).items[0].currentWeekTotals, 0);
  const selected = [{ event_type: "app_opened" }, { event_type: "app_quit" }];
  await exploreAmplitude(env, { operation: "funnel", ...dates, events: selected, conversionWindowSeconds: 3600 });
  assert.deepEqual(calls.at(-1)!.searchParams.getAll("e").map(v => JSON.parse(v)), selected);
  assert.equal(calls.at(-1)!.searchParams.get("cs"), "3600");
  await exploreAmplitude(env, { operation: "segmentation", ...dates, events: [selected[0]], measure: "totals", groupBy: "platform" });
  assert.equal(calls.at(-1)!.searchParams.get("m"), "totals"); assert.equal(calls.at(-1)!.searchParams.get("g"), "platform");
  for (const args of [
    { operation: "sessions", groupBy: "country" }, { operation: "sessions", startDate: "2026-02-30" },
    { operation: "sessions", startDate: "2026-01-01", endDate: "2026-09-05" },
    { operation: "sessions", endDate: "2099-01-01" }, { operation: "chart", chartId: "../../secret" },
    { operation: "events", endpoint: "https://evil.test" }, { operation: "funnel", events: [selected[0]] },
    { operation: "segmentation", events: [selected[0]], measure: "histogram" },
  ]) {
    const before = calls.length;
    await assert.rejects(exploreAmplitude(env, args));
    assert.equal(calls.length, before, "Bad queries rejected before network");
  }
  fail = true;
  await assert.rejects(exploreAmplitude(env, { operation: "events" }), err => /429/.test(String(err)) && !/secret must/.test(String(err)));
});

test("Realtime and user drilldown validate IDs, paginate and omit private properties", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls: URL[] = [];
  let invalidRealtime = false;
  globalThis.fetch = async input => {
    const url = new URL(String(input)); calls.push(url);
    if (url.pathname === "/api/2/usersearch") return Response.json({ matches: [{ amplitude_id: 123, user_id: "known" }], type: "match_user_or_device_id" });
    if (url.pathname === "/api/2/useractivity") return Response.json({ userData: { user_id: "known", num_events: 2, device_ids: ["private"], properties: { email: "private" } },
      events: [1, 2].map(n => ({ event_type: "app_opened", event_time: n, event_properties: { email: "private" } })) });
    return Response.json({ data: { xValues: ["00:00"], seriesLabels: ["Today", "Yesterday"], series: [[0], invalidRealtime ? [] : [null]] } });
  };
  const env = { amplitudeApiKey: "key", amplitudeSecretKey: "secret" } as Env;
  const found = await exploreAmplitude(env, { operation: "user_search", user: "known" });
  assert.deepEqual(found.matches, [{ amplitudeId: "123", userId: "known" }]);
  assert.equal(found.nextOffset, null);
  const result = await exploreAmplitude(env, { operation: "user_activity", amplitudeId: "123", limit: 1, offset: 2, direction: "earliest" });
  assert.equal(result.events.length, 1); assert.equal(result.nextOffset, 3); assert.equal(result.truncatedToLimit, true);
  assert(!JSON.stringify(result).includes("private"));
  assert.equal(calls.at(-1)!.searchParams.get("direction"), "earliest");
  assert.equal(calls.at(-1)!.searchParams.get("offset"), "2");
  const realtime = await exploreAmplitude(env, { operation: "realtime" });
  assert.deepEqual(realtime.data.series, [[0], [null]]);
  for (const args of [{ operation: "user_activity", amplitudeId: "kitty-uuid" }, { operation: "user_search" },
    { operation: "user_activity", amplitudeId: "123", startDate: "2026-09-01" }, { operation: "realtime", groupBy: "platform" }]) {
    const count = calls.length;
    await assert.rejects(exploreAmplitude(env, args)); assert.equal(calls.length, count);
  }
  invalidRealtime = true;
  await assert.rejects(exploreAmplitude(env, { operation: "realtime" }), /shape changed/);
});


test("Expanded analytics preserve parameters and reject unsupported combinations", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const calls: URL[] = [];
  globalThis.fetch = async input => {
    const u = new URL(String(input)); calls.push(u);
    if (u.pathname === "/api/3/cohorts") return Response.json({ cohorts: [{ id: "cohort1", name: "test", owners: ["private"] }] });
    if (u.pathname.endsWith("/usage")) return Response.json({ rest_download: { limit: 500, usage: 0 } });
    return Response.json({ data: { series: [[0]], xValues: ["2026-09-05"] } });
  };
  const env = { amplitudeApiKey: "key", amplitudeSecretKey: "secret" } as Env;
  const dates = { startDate: "2026-09-05", endDate: "2026-09-05" };
  await exploreAmplitude(env, { operation: "users", ...dates, userMetric: "new" });
  assert.equal(calls.at(-1)!.pathname, "/api/2/users"); assert.equal(calls.at(-1)!.searchParams.get("m"), "new");
  await exploreAmplitude(env, { operation: "revenue_ltv", ...dates, ltvMetric: "arppu" });
  assert.equal(calls.at(-1)!.searchParams.get("m"), "1");
  await exploreAmplitude(env, { operation: "segmentation", ...dates, events: [{ event_type: "a" }, { event_type: "b" }],
    measure: "formula", formula: "UNIQUES(A)/UNIQUES(B)", interval: "hourly", groupBy: "platform", groupBy2: "version" });
  assert.equal(calls.at(-1)!.searchParams.get("i"), "-3600000"); assert.equal(calls.at(-1)!.searchParams.get("g2"), "version");
  assert.equal(JSON.parse(calls.at(-1)!.searchParams.get("e2")!).event_type, "b");
  assert.equal(calls.at(-1)!.searchParams.get("formula"), "UNIQUES(A)/UNIQUES(B)");
  await exploreAmplitude(env, { operation: "sessions", ...dates, sessionBins: { unit: "minutes", min: 0, max: 60, size: 5 } });
  assert.equal(calls.at(-1)!.searchParams.get("timeHistogramConfigBinSize"), "5");
  assert.equal(calls.at(-2)!.searchParams.has("timeHistogramConfigBinSize"), false);
  assert(!JSON.stringify(await exploreAmplitude(env, { operation: "cohorts" })).includes("private"));
  assert.equal((await exploreAmplitude(env, { operation: "cohort_usage" })).data.usage, 0);
  for (const args of [
    { operation: "users", interval: "hourly" }, { operation: "cohorts", startDate: "2026-09-05" },
    { operation: "segmentation", events: [{ event_type: "a" }], formula: "UNIQUES(A)" },
    { operation: "segmentation", events: [{ event_type: "a" }], groupBy2: "version" },
    { operation: "sessions", sessionBins: { unit: "seconds", min: 10, max: 5 } },
    { operation: "funnel", events: [{ event_type: "a" }, { event_type: "b" }], mode: "unordered", conversionWindowSeconds: 3600 },
  ]) {
    const before = calls.length; await assert.rejects(exploreAmplitude(env, args)); assert.equal(calls.length, before);
  }
});

import { zipSync, strToU8, gzipSync } from "fflate";

test('Offline export persists bounded pages, honors backpressure and rejects duplicate workers and uncommitted pages', async t => {
  const {startExport,runExportWorker,exportStatus,exportPage}=await import('./amplitude-export-jobs.js');
  const {streamAmplitudeExportHour}=await import('./amplitude-export.js');
  const old=process.env.CLOUD_RUN_JOB;process.env.CLOUD_RUN_JOB='test';t.after(()=>{if(old===undefined)delete process.env.CLOUD_RUN_JOB;else process.env.CLOUD_RUN_JOB=old;});
  const cloudEnv={amplitudeApiKey:'test',amplitudeSecretKey:'test',amplitudeExportBucket:'test-bucket',amplitudeExportJob:'projects/test-project/locations/us-central1/jobs/export'} as Env;
  const objects=new Map<string,unknown>();
  const rows=Array.from({length:1500},(_,i)=>JSON.stringify({event_type:'test',event_id:i,user_id:'test-user'})).join('\n');
  let archive=zipSync({'part1.json.gz':gzipSync(strToU8(rows)),'part2.json':strToU8(rows)});
  let dispatchStatus=200,dispatchThrows=false,operationDone=false,statusHttp=200,dispatchCalls=0;
  t.mock.method(globalThis,'fetch',async (raw: string | URL | Request,init?:RequestInit)=>{
    const url=new URL(String(raw));
    if(url.hostname==='metadata.google.internal')return Response.json({access_token:'test-token',expires_in:3600});
    if(url.hostname==='amplitude.com')return new Response(archive);
    if(url.hostname==='run.googleapis.com'){
      if(init?.method==='POST'){
        dispatchCalls++;
        if(dispatchThrows)throw new Error('private network error');
        if(dispatchStatus!==200)return new Response('private upstream body',{status:dispatchStatus});
      }else if(statusHttp!==200)return new Response('private status body',{status:statusHttp});
      return Response.json({name:'projects/test-project/locations/us-central1/operations/test',done:operationDone});
    }
    assert.equal(url.hostname,'storage.googleapis.com');
    const name=url.searchParams.get('name') ?? decodeURIComponent(url.pathname.split('/o/')[1]);
    if(init?.method==='POST'){
      if(url.searchParams.get('ifGenerationMatch')==='0' && objects.has(name))return new Response('',{status:412});
      objects.set(name,JSON.parse(String(init.body)));return Response.json({});
    }
    return objects.has(name)?Response.json(objects.get(name)):new Response('',{status:404});
  });
  let active=0,maxActive=0,total=0;
  const direct=await streamAmplitudeExportHour(cloudEnv,{uploadHour:'20260901T00',exportFields:['event_id']},async page=>{
    active++;maxActive=Math.max(maxActive,active);assert(page.length<=100);assert(JSON.stringify(page).length<=55000);
    await new Promise(r=>setTimeout(r,1));for(const event of page){assert.equal(event.event_id,total%1500);total++;}active--;
  });
  assert.equal(maxActive,1);assert.equal(total,3000);assert.equal(direct.status,'ok');
  const job=await startExport(cloudEnv,{uploadHour:'20260901T00',endUploadHour:'20260901T01',exportFields:['event_id']});
  assert.equal(job.status,'queued');await runExportWorker(cloudEnv,job.jobId);
  const status=await exportStatus(cloudEnv,job.jobId);assert.equal(status.status,'complete');assert('records' in status && 'completedHours' in status);assert.equal(status.records,6000);assert.equal(status.completedHours,2);
  let count=0,page=0;
  for(;;){const result=await exportPage(cloudEnv,job.jobId,page);assert.equal(result.rangeComplete,true);count+=result.events.length;if(result.nextPage===null)break;page=result.nextPage;}
  assert.equal(count,6000);
  await assert.rejects(()=>runExportWorker(cloudEnv,job.jobId),/412/);
  await assert.rejects(()=>exportPage(cloudEnv,job.jobId,page+1),/not committed/);
  archive=strToU8('broken archive');
  const failed=await startExport(cloudEnv,{uploadHour:'20260901T00',endUploadHour:'20260901T00'});
  await assert.rejects(()=>runExportWorker(cloudEnv,failed.jobId));
  assert.equal((await exportStatus(cloudEnv,failed.jobId)).status,'failed');
  await assert.rejects(()=>exportPage(cloudEnv,failed.jobId,0),/not committed/);
  const before=objects.size;
  await assert.rejects(()=>startExport(cloudEnv,{uploadHour:'20260902T00',endUploadHour:'20260901T00'}));
  assert.equal(objects.size,before);
  const request={uploadHour:'20260901T00',endUploadHour:'20260901T00'};
  for(const code of [400,401,403,404,429]){
    dispatchStatus=code;const prior=dispatchCalls;
    const rejected=await startExport(cloudEnv,request);assert.equal(rejected.status,'rejected');assert.equal(rejected.httpStatus,code);
    const saved=await exportStatus(cloudEnv,rejected.jobId);assert.equal(saved.status,'rejected');assert.equal(saved.httpStatus,code);
    assert.equal(dispatchCalls,prior+1);assert(!JSON.stringify(saved).includes('private'));
  }
  dispatchStatus=503;
  const uncertain=await startExport(cloudEnv,request);assert.equal(uncertain.status,'dispatch_unconfirmed');
  assert.equal((await exportStatus(cloudEnv,uncertain.jobId)).status,'dispatch_unconfirmed');
  dispatchStatus=200;dispatchThrows=true;
  assert.equal((await startExport(cloudEnv,request)).status,'dispatch_unconfirmed');dispatchThrows=false;
  const pending=await startExport(cloudEnv,request);assert.equal((await exportStatus(cloudEnv,pending.jobId)).status,'queued');
  statusHttp=503;await assert.rejects(()=>exportStatus(cloudEnv,pending.jobId),/status unavailable/);statusHttp=200;
  operationDone=true;assert.equal((await exportStatus(cloudEnv,pending.jobId)).status,'failed');
});

test("Raw exports use UTC upload hours, bind archive pagination and preserve missing data", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const row = { event_type: "open", user_id: "user-a", event_time: "2026-09-04", event_properties: { duration: 0, private: "omit" } };
  const archive = zipSync({ "events.json.gz": gzipSync(strToU8(JSON.stringify(row) + "\n" + JSON.stringify(row))) });
  let status = 200, calls = 0;
  globalThis.fetch = async input => { calls++; const u = new URL(String(input));
    assert.equal(u.searchParams.get("start"), "20260905T00"); assert.equal(u.searchParams.get("end"), "20260905T00");
    return new Response(status === 200 ? archive : "upstream private error", { status });
  };
  const env = { amplitudeApiKey: "key", amplitudeSecretKey: "secret" } as Env;
  const args = { operation: "export_events", uploadHour: "20260905T00", limit: 1, user: "user-a", eventPropertyKeys: ["duration", "missing"] };
  const first = await exploreAmplitude(env, args);
  assert.equal(first.scannedRecordCount, 2); assert.equal(first.nextOffset, 1);
  assert.equal(first.events[0].selectedEventProperties.values.duration, 0);
  assert.deepEqual(first.events[0].selectedEventProperties.missingKeys, ["missing"]);
  assert(!JSON.stringify(first.events).includes("private"));
  const next = await exploreAmplitude(env, { ...args, offset: 1, prefixSha256: first.prefixSha256 });
  assert.equal(next.nextOffset, null);
  await assert.rejects(exploreAmplitude(env, { ...args, offset: 1, prefixSha256: first.prefixSha256, exportFields: ['event_type'] }), /prefix changed/);
  await assert.rejects(exploreAmplitude(env, { ...args, offset: 1, prefixSha256: "0".repeat(64) }), /prefix changed/);
  for (const bad of [{ ...args, uploadHour: "20260230T00" }, { ...args, offset: 1 }, { ...args, startDate: "2026-09-05" }]) {
    const before = calls; await assert.rejects(exploreAmplitude(env, bad)); assert.equal(calls, before);
  }
  status = 404; assert.equal((await exploreAmplitude(env, args)).status, "no_data_for_upload_hour");
  await assert.rejects(exploreAmplitude(env,{...args,offset:1,prefixSha256:first.prefixSha256}),/prefix disappeared/);
  status = 403; await assert.rejects(exploreAmplitude(env, args), err => /403/.test(String(err)) && !/private error/.test(String(err)));
});

test('Export ranges continue within and across upload hours, preserve exact large IDs and reject invalid ranges before HTTP', async t => {
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});
  let calls=0;
  const archive=zipSync({'events.json':strToU8('{"event_type":"a","amplitude_id":9007199254740993}\n{"event_type":"b","amplitude_id":9007199254740995}\n')});
  globalThis.fetch=async input=>{calls++;const hour=new URL(String(input)).searchParams.get('start');return hour==='20260905T01'?new Response(null,{status:404}):new Response(archive)};
  const env={amplitudeApiKey:'key',amplitudeSecretKey:'secret'} as Env;
  const args={operation:'export_events',uploadHour:'20260905T00',endUploadHour:'20260905T01',limit:1,exportFields:['event_type','amplitude_id']};
  const first=await exploreAmplitude(env,args);assert.equal(first.events[0].amplitude_id,'9007199254740993');assert.equal(first.rangeExhausted,false);
  assert.equal(first.nextQuery.uploadHour,args.uploadHour);assert.equal(first.nextQuery.offset,1);
  const second=await exploreAmplitude(env,first.nextQuery);assert.equal(second.events[0].amplitude_id,'9007199254740995');
  assert.equal(second.nextQuery.uploadHour,args.endUploadHour);assert.equal(second.nextQuery.offset,0);assert.equal(second.nextQuery.prefixSha256,undefined);
  const last=await exploreAmplitude(env,second.nextQuery);assert.equal(last.status,'no_data_for_upload_hour');assert.equal(last.rangeExhausted,true);assert.equal(last.nextQuery,null);
  const before=calls;
  for(const endUploadHour of ['20260904T23','20260999T01','20261205T00'])await assert.rejects(exploreAmplitude(env,{...args,endUploadHour}));
  assert.equal(calls,before);
});

test('Cohort and replay queries preserve cursors, parse CSV safely and reject mixed filters', async t => {
  const { parseCohortCsv } = await import('./amplitude-extra.js');
  assert.deepEqual(parseCohortCsv('"a","b"\r\n"123","a,b\n""c"""\r\n'),[['a','b'],['123','a,b\n"c"']]);
  assert.throws(()=>parseCohortCsv('"open'),/Truncated/);
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});
  const env={amplitudeApiKey:'key',amplitudeSecretKey:'secret'} as Env;
  const urls:URL[]=[];
  globalThis.fetch=async (u,init)=>{const url=new URL(String(u));urls.push(url);
    if(url.hostname.endsWith('.amazonaws.com')){assert.equal(init?.headers,undefined);return new Response('"amplitude_id","user_id"\n"9007199254740993","u1"\n"2","u2"\n')}
    if(url.pathname.endsWith('/file'))return new Response(null,{status:302,headers:{location:'https://bucket.s3.amazonaws.com/cohort'}});
    if(url.pathname.includes('request-status'))return Response.json({request_id:'r',cohort_id:'c',async_status:'JOB COMPLETED'});
    if(url.pathname.includes('/cohorts/request/'))return Response.json({request_id:'r',cohort_id:'c'},{status:202});
    if(url.pathname.endsWith('replay-search')){assert.equal(init?.method,'POST');return Response.json({data:[],metadata:{pre_filter_capped:true}})}
    if(url.pathname.endsWith('/files'))return Response.json({files:[],next_page_token:null});
    return Response.json({session_replays:[],next_page_token:'opaque+/='});
  };
  await exploreAmplitude(env,{operation:'cohort_request',cohortId:'c',userPropertyKeys:['version']});assert.deepEqual(urls.at(-1)?.searchParams.getAll('propKeys'),['version']);
  await exploreAmplitude(env,{operation:'cohort_status',requestId:'r'});
  const page=await exploreAmplitude(env,{operation:'cohort_members',requestId:'r',limit:1});assert.equal(page.members[0].amplitude_id,'9007199254740993');assert.equal(page.nextOffset,1);
  const next=await exploreAmplitude(env,{operation:'cohort_members',requestId:'r',limit:1,offset:1,prefixSha256:page.prefixSha256});assert.equal(next.nextOffset,null);
  await assert.rejects(exploreAmplitude(env,{operation:'cohort_members',requestId:'r',offset:1,prefixSha256:'0'.repeat(64)}),/changed/);
  const replay=await exploreAmplitude(env,{operation:'replays',pageToken:'opaque+/=',sortOrder:'desc'});assert.equal(replay.data.next_page_token,'opaque+/=');assert.equal(urls.at(-1)?.searchParams.get('page_token'),'opaque+/=');
  await exploreAmplitude(env,{operation:'replay_files',replayId:'device/session'});
  assert.equal((await exploreAmplitude(env,{operation:'replay_search',startDate:'2026-09-01',endDate:'2026-09-03'})).data.metadata.pre_filter_capped,true);
  const before=urls.length;
  await assert.rejects(exploreAmplitude(env,{operation:'replays',replayIds:['d/s'],amplitudeId:'1'}));assert.equal(urls.length,before);
  globalThis.fetch=async()=>new Response(null,{status:302,headers:{location:'https://example.com/stolen'}});
  await assert.rejects(exploreAmplitude(env,{operation:'cohort_members',requestId:'r'}),/Unexpected/);
});
