import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResultRow } from "pg";
import type { Env } from "./env.js";
import {
  buildAssetsQuery,
  getBusinessDatabaseStatus,
  getUserAssets,
  lookupBusinessUser,
} from "./business-db.js";
import { buildBoundedPage, DEFAULT_RESPONSE_MAX_CHARS, serializedResponseChars } from "./bounded-page.js";
import { buildToolRegistry, getAgentToolDeclarations } from "./agent/tools.js";

const env = { businessDbEnabled: true } as Env;
const userId = "11111111-1111-4111-8111-111111111111";
const petId = "22222222-2222-4222-8222-222222222222";

test("bounded pages keep complete rows and expose a continuation offset", () => {
  const build = (candidates: Array<{ payload: string }>, responseMaxChars: number) => buildBoundedPage({
    candidates,
    limit: 3,
    offset: 7,
    responseMaxChars,
    oversizedRowHint: "select fewer columns",
    build: (page) => ({ source: "kitty", ...page, notes: ["bounded"] }),
  });
  const page = build([
    { payload: "a".repeat(2200) },
    { payload: "b".repeat(2200) },
    { payload: "c".repeat(2200) },
  ], 4000);
  assert.equal(page.returnedRows, 1);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextOffset, 8);
  assert.equal(page.responseSizeLimited, true);
  assert.equal(page.pageLimitReason, "response_size");
  assert.ok(serializedResponseChars(page) <= 4000);
  assert.throws(() => build([{ payload: "x".repeat(5000) }], 4000), /select fewer columns/);
});

test("business DB tools keep identifiers parameterized, bounded and read-only", async () => {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const query = async <T extends QueryResultRow>(text: string, values?: unknown[]) => {
    calls.push({ text, values });
    if (text.includes("FROM users")) return { rows: [{ userId, email: "a@example.com" }] as unknown as T[] };
    if (text.includes("FROM pets")) return { rows: [{ petId, name: "Mochi" }] as unknown as T[] };
    if (text.includes("FROM purchases")) return { rows: [{ purchaseId: petId, purchaseKind: "treats" }] as unknown as T[] };
    if (text.includes("FROM treat_ledger_entries")) return { rows: [{ entryType: "purchase_credit" }] as unknown as T[] };
    if (text.includes("WITH assets")) return { rows: [{ userId, assetType: "pose_image" }] as unknown as T[] };
    return {
      rows: [{
        database: "kitty",
        user: "epbs_readonly",
        readOnly: "on",
        missingTables: [],
        missingSelectTables: [],
        writableTables: [],
      }] as unknown as T[],
    };
  };

  const injection = "victim@example.com' OR true --";
  const user = await lookupBusinessUser(
    env,
    { identifierType: "email", identifier: injection },
    query,
  ) as Record<string, unknown>;
  assert.equal(user.found, true);
  assert.equal(calls[0].text.includes(injection), false);
  assert.deepEqual(calls[0].values, [injection]);
  assert.equal(JSON.stringify(user).includes("firebase_uid"), false);
  assert.equal("subscription" in user, false);
  assert.match(String(user.coverage), /user_related/);

  const assets = await getUserAssets(
    env,
    { userIds: [userId], assetTypes: ["pose_image"], limitPerUser: 3 },
    query,
  ) as Record<string, unknown>;
  assert.equal(assets.count, 1);
  assert.deepEqual(calls.at(-1)?.values, [[userId], 4, 0]);
  assert.match(buildAssetsQuery(["pose_image"]), /FROM pet_generated_poses/);
  assert.doesNotMatch(buildAssetsQuery(["pose_image"]), /FROM snaps/);
  await assert.rejects(
    () => getUserAssets(env, { userIds: ["42 OR 1=1"] }, query),
    /Invalid UUID/,
  );

  const status = await getBusinessDatabaseStatus(env, query) as Record<string, unknown>;
  assert.equal(status.ok, true);

  const disabledEnv = { businessDbEnabled: false } as Env;
  assert.equal(getAgentToolDeclarations(disabledEnv).some((tool) => tool.name === "lookup_business_user"), false);
  assert.equal("lookup_business_user" in buildToolRegistry(disabledEnv), false);
  assert.equal(getAgentToolDeclarations(env).some((tool) => tool.name === "lookup_business_user"), true);
  assert.equal("lookup_business_user" in buildToolRegistry(env), true);
  await assert.rejects(
    () => getBusinessDatabaseStatus({
      businessDbEnabled: true,
      databaseHost: "34.66.4.237",
      databasePort: 5432,
      databaseName: "kitty",
      databaseUser: "epbs_readonly",
      databasePassword: "test-only",
    } as Env),
    /kitty Unix socket/,
  );
});

test("business user summaries stay bounded without truncating record fields", async () => {
  const calls: string[] = [];
  const longValue = "x".repeat(200);
  const query = async <T extends QueryResultRow>(text: string) => {
    calls.push(text);
    if (text.includes("FROM users")) {
      return { rows: [{ userId, email: "bounded@example.com" }] as unknown as T[] };
    }
    const rows = Array.from({ length: 21 }, (_, index) => text.includes("FROM pets")
      ? { petId: `${index}`, displayImageUrl: `${longValue}-${index}` }
      : text.includes("FROM purchases")
        ? { purchaseId: `${index}`, productKey: `${longValue}-${index}` }
        : { entryType: "purchase_credit", sourceLabel: `${longValue}-${index}` });
    return { rows: rows as unknown as T[] };
  };

  const result = await lookupBusinessUser(env, {
    identifierType: "user_id",
    identifier: userId,
    responseMaxChars: 4000,
  }, query) as {
    pets: Array<{ displayImageUrl: string }>;
    purchases: Array<{ productKey: string }>;
    treatLedger: Array<{ sourceLabel: string }>;
    responseSizeLimited: boolean;
    pageLimitReason: string;
    summaryHasMore: boolean;
    summaryCounts: Record<string, { returned: number; hasMore: boolean }>;
  };

  assert.ok(serializedResponseChars(result) <= 4000);
  assert.equal(result.responseSizeLimited, true);
  assert.equal(result.pageLimitReason, "response_size");
  assert.equal(result.summaryHasMore, true);
  assert.ok(result.pets.length + result.purchases.length + result.treatLedger.length < 60);
  for (const pet of result.pets) assert.match(pet.displayImageUrl, /-\d+$/);
  for (const purchase of result.purchases) assert.match(purchase.productKey, /-\d+$/);
  for (const entry of result.treatLedger) assert.match(entry.sourceLabel, /-\d+$/);
  assert.deepEqual(
    Object.fromEntries(Object.entries(result.summaryCounts).map(([name, count]) => [name, count.returned])),
    { pets: result.pets.length, purchases: result.purchases.length, treatLedger: result.treatLedger.length },
  );

  const rowLimited = await lookupBusinessUser(env, {
    identifierType: "user_id",
    identifier: userId,
    responseMaxChars: 50000,
  }, query) as typeof result;
  assert.equal(rowLimited.responseSizeLimited, false);
  assert.equal(rowLimited.pageLimitReason, "row_limit");
  assert.equal(rowLimited.summaryHasMore, true);
  assert.deepEqual(
    [rowLimited.pets.length, rowLimited.purchases.length, rowLimited.treatLedger.length],
    [20, 20, 20],
  );
  for (const sql of calls.filter((text) => !text.includes("FROM users"))) assert.match(sql, /LIMIT 21/);
});

test("asset pages report missing users and empty matches without leaking lookahead rows", async () => {
  const populated = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const empty = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const missing = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const source = [1, 2, 3].map(n => ({ userId: populated, assetId: `asset-${n}`, assetType: "pose_image" }));
  const query = async <T extends QueryResultRow>(text: string, values?: unknown[]) => {
    assert.deepEqual(values?.[0], [populated, empty, missing]);
    if (text.includes("FROM users")) {
      return { rows: [{ userId: populated }, { userId: empty }] as unknown as T[] };
    }
    assert.match(text, /row_num > \$3 AND row_num <= \$3 \+ \$2/);
    assert.match(text, /ORDER BY created_at DESC, id DESC, asset_type/);
    const [, limit, offset] = values as [string[], number, number];
    return { rows: source.slice(offset, offset + limit) as unknown as T[] };
  };
  const input = { userIds: [populated.toUpperCase(), empty, populated, missing], limitPerUser: 2 };
  const first = await getUserAssets(env, input, query);
  assert.deepEqual(first.userIds, [populated, empty, missing]);
  assert.equal(first.count, 2);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextOffset, 2);
  assert.equal(first.requestedLimitPerUser, 2);
  assert.equal(first.responseSizeLimited, false);
  assert.equal(first.pageLimitReason, "row_limit");
  assert.deepEqual(first.perUser.map(u => u.status), ["assets_returned", "no_matching_assets", "user_not_found"]);
  assert.deepEqual(first.perUser.map(u => u.nextOffset), [2, null, null]);
  const last = await getUserAssets(env, { ...input, offsetPerUser: first.nextOffset }, query);
  assert.equal(last.count, 1);
  assert.equal(last.hasMore, false);
  assert.equal(last.nextOffset, null);
  assert.equal(last.perUser[1].status, "page_exhausted");
  assert.deepEqual([...first.assets, ...last.assets].map(a => a.assetId), source.map(a => a.assetId));
  const exhausted = await getUserAssets(env, { ...input, offsetPerUser: 3 }, query);
  assert.equal(exhausted.count, 0);
  assert.equal(exhausted.hasMore, false);
  assert.equal(exhausted.perUser[0].status, "page_exhausted");
  const exactPage = await getUserAssets(env, { ...input, limitPerUser: 3 }, query);
  assert.equal(exactPage.count, 3);
  assert.equal(exactPage.hasMore, false);
  assert.equal(exactPage.nextOffset, null);
  for (const offsetPerUser of [-1, 0.5, "2", Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(() => getUserAssets(env, { ...input, offsetPerUser }, async () => {
      assert.fail("Invalid pages must not query the database");
    }));
  }
});

test("asset pages shrink by complete per-user records to fit the MCP response budget", async () => {
  const populated = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const source = [1, 2, 3].map(n => ({
    userId: populated,
    assetId: `asset-${n}`,
    assetType: "pose_image",
    url: `https://assets.example/${"x".repeat(2200)}-${n}`,
  }));
  const query = async <T extends QueryResultRow>(text: string, values?: unknown[]) => {
    if (text.includes("FROM users")) return { rows: [{ userId: populated }] as unknown as T[] };
    const [, limit, offset] = values as [string[], number, number];
    return { rows: source.slice(offset, offset + limit) as unknown as T[] };
  };
  const first = await getUserAssets(env, {
    userIds: [populated], limitPerUser: 3, responseMaxChars: 4000,
  }, query);
  assert.equal(first.requestedLimitPerUser, 3);
  assert.equal(first.limitPerUser, 1);
  assert.equal(first.count, 1);
  assert.equal(first.responseSizeLimited, true);
  assert.equal(first.pageLimitReason, "response_size");
  assert.equal(first.nextOffset, 1);
  assert.ok(serializedResponseChars(first) <= 4000);
  const second = await getUserAssets(env, {
    userIds: [populated], limitPerUser: 3, offsetPerUser: first.nextOffset, responseMaxChars: 4000,
  }, query);
  assert.equal(second.assets[0].assetId, "asset-2");
  assert.equal(second.nextOffset, 2);

  const oversizedQuery = async <T extends QueryResultRow>(text: string) => ({ rows: (text.includes("FROM users")
    ? [{ userId: populated }]
    : [{ userId: populated, assetId: "large", assetType: "pose_image", url: "x".repeat(5000) }]) as unknown as T[] });
  await assert.rejects(
    () => getUserAssets(env, { userIds: [populated], limitPerUser: 1, responseMaxChars: 4000 }, oversizedQuery),
    /fewer userIds or narrower assetTypes/,
  );
});


import { exploreBusinessDatabase } from "./business-explore.js";

test("Generic kitty queries discover live schema and bind values without executable SQL", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const query = async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values });
    return { rows: sql.includes("FROM pg_class") ? [{ name: "users", columns: [
      { name: "id", type: "uuid", category: "U" }, { name: "treat_balance", type: "integer", category: "N" },
    ], primaryKey: ["id"], foreignKeys: [] }] : [{ id: "first" }, { id: "next" }] };
  };
  const env = {} as Env;
  const run = (args: unknown) => exploreBusinessDatabase(env, args, query as any);
  const page = await run({ operation: "rows", table: "users", columns: ["id"], limit: 1,
    filters: [{ column: "id", operator: "eq", value: "'; DELETE FROM users; --" }] });
  assert.equal((page as any).hasMore, true); assert.equal((page as any).nextOffset, 1);
  assert(!calls.at(-1)!.sql.includes("DELETE")); assert(calls.at(-1)!.sql.includes('"id" = $1'));
  assert.deepEqual(calls.at(-1)!.values, ["'; DELETE FROM users; --", 2, 0]);
  await run({ operation: "aggregate", table: "users", metrics: [{ function: "sum", column: "treat_balance", alias: "total" }] });
  assert(calls.at(-1)!.sql.includes('sum("treat_balance") AS "total"'));
  for (const args of [
    { operation: "rows", table: "users;drop" }, { operation: "rows", table: "unknown" },
    { operation: "rows", table: "users", columns: ["missing"] }, { operation: "tables", filters: [] },
    { operation: "rows", table: "users", filters: [{ column: "id", operator: "in", value: "x" }] },
    { operation: "aggregate", table: "users", metrics: [{ function: "avg", column: "id", alias: "n" }] },
    { operation: "aggregate", table: "users", groupBy: ["id"], metrics: [{ function: "count", alias: "id" }] },
  ]) {
    const before = calls.filter(c => !c.sql.includes("FROM pg_class")).length;
    await assert.rejects(run(args));
    assert.equal(calls.filter(c => !c.sql.includes("FROM pg_class")).length, before);
  }
});

 test("user relation inventory follows live foreign keys, deduplicates rows and omits unlinked tables", async () => {
  const { exploreBusinessDatabase } = await import('./business-explore.js');
  const fk=(name:string,parent:string,column:string)=>({name,definition:'',columns:[column],referencedTable:parent,referencedSchema:'public',referencedColumns:['id']});
  const table=(name:string,foreignKeys:any[]=[])=>({name,columns:[{name:'id',type:'uuid',category:'U'}],primaryKey:['id'],foreignKeys});
  const metadata=[table('users'),table('pets',[fk('owner','users','owner_id'),fk('self','pets','source_template_id')]),table('images',[fk('pet','pets','pet_id')]),table('global')];
  let calls=0;
  const query=async <T extends QueryResultRow>(sql:string,values?:unknown[])=>{
    calls++;
    if(sql.includes('SELECT c.relname'))return {rows:metadata as unknown as T[]};
    assert.equal(values?.[0],userId); assert(!sql.includes(userId));
    if(sql.startsWith('SELECT 1 FROM'))return {rows:[{id:userId}] as unknown as T[]};
    if(sql.includes('count(*)'))return {rows:[{count:'2',path_0:'2'}] as unknown as T[]};
    assert.match(sql,/EXISTS .*public\."pets".*EXISTS .*public\."users"/);
    assert.match(sql,/LIMIT \$2 OFFSET \$3/);
    return {rows:[{id:'first'},{id:'lookahead'}] as unknown as T[]};
  };
  const inventory:any=await exploreBusinessDatabase(env,{operation:'user_related',userId},query);
  assert.equal(inventory.inventory.length,3);assert.equal(inventory.inventory[1].matchedRelations[0].count,'2');assert.match(inventory.inventory[1].matchedRelations[0].relationshipStatement,/匹配记录.*引用.*起点记录/);assert.match(inventory.relationMeaning,/指向起点/);assert.deepEqual(inventory.unlinkedTables,['global']);assert.equal(inventory.selfReferences.length,1);
  const page:any=await exploreBusinessDatabase(env,{operation:'user_related',userId,table:'images',limit:1},query);
  assert.equal(page.rows.length,1);assert.equal(page.nextOffset,1);assert.equal(page.responseMaxChars,DEFAULT_RESPONSE_MAX_CHARS);assert.equal(page.responseSizeLimited,false);assert.equal(page.pageLimitReason,'row_limit');assert(!JSON.stringify(page).includes('lookahead'));
  const before=calls;await assert.rejects(exploreBusinessDatabase(env,{operation:'user_related',userId:'bad'},query));assert.equal(calls,before);
  await assert.rejects(exploreBusinessDatabase(env,{operation:'user_related',userId,table:'global'},query),/No verified/);
 });

test('related supports pet parents and composite primary keys without mixing sibling records', async () => {
 const {exploreBusinessDatabase}=await import('./business-explore.js');
 const col=(name:string)=>({name,type:'text',category:'S'});
 const tables=[{name:'users',columns:[col('id')],primaryKey:['id'],foreignKeys:[]},{name:'pets',columns:[col('species'),col('id'),col('owner_id')],primaryKey:['species','id'],foreignKeys:[{name:'owner',definition:'',columns:['owner_id'],referencedTable:'users',referencedSchema:'public',referencedColumns:['id']}]}];
 const query=async<T extends QueryResultRow>(sql:string,values?:unknown[])=>{
  if(sql.includes('SELECT c.relname'))return {rows:tables as unknown as T[]};
  assert.deepEqual(values?.slice(0,2),['dog','pet-id']);
  if(sql.startsWith('SELECT 1'))return {rows:[{}] as unknown as T[]};
  assert(sql.includes('t0."id"=t1."owner_id"'));assert(sql.includes('t1."species"=$1 AND t1."id"=$2'));assert(sql.includes('LIMIT $3 OFFSET $4'));
  return {rows:[{id:'owner'}] as unknown as T[]};
 };
 const r:any=await exploreBusinessDatabase(env,{operation:'related',rootTable:'pets',rootKey:{species:'dog',id:'pet-id'},relationDirection:'referenced',table:'users'},query);
 assert.equal(r.rows[0].id,'owner');
 await assert.rejects(exploreBusinessDatabase(env,{operation:'related',rootTable:'pets',rootKey:{id:'pet-id'}},query),/complete primary key/);
});

test('JSON queries bind paths and typed values, preserve null presence, and reject invalid types before SQL', async () => {
 const {exploreBusinessDatabase}=await import('./business-explore.js');
 const calls:{sql:string,values?:unknown[]}[]=[];
 const query=async<T extends QueryResultRow>(sql:string,values?:unknown[])=>{
  if(sql.includes('SELECT c.relname'))return {rows:[{name:'records',columns:[{name:'id',type:'text',category:'S'},{name:'payload',type:'jsonb',category:'U'}],primaryKey:['id'],foreignKeys:[]}] as unknown as T[]};
  calls.push({sql,values});return {rows:[] as T[]};
 };
 const args={operation:'rows',table:'records',columns:['id']};
 const path=['unsafe\"; DELETE FROM records; --','0'];
 await exploreBusinessDatabase(env,{...args,filters:[{column:'payload',jsonPath:path,operator:'eq',value:3}],jsonFields:[{column:'payload',path:['a'],alias:'value_a'}]},query);
 const first=calls.at(-1)!;assert(!first.sql.includes('DELETE'));assert.deepEqual(first.values?.slice(0,3),[path,'3',['a']]);
 assert.match(first.sql,/jsonb_build_object\('value'/);assert.match(first.sql,/'present'.*IS NOT NULL/);
 await exploreBusinessDatabase(env,{...args,filters:[{column:'payload',jsonPath:['a'],operator:'eq',value:'3'}]},query);assert.equal(calls.at(-1)!.values?.[1],'"3"');
 await exploreBusinessDatabase(env,{...args,filters:[{column:'payload',jsonPath:['a'],operator:'in',value:[3,'3',true]}]},query);assert.deepEqual(calls.at(-1)!.values?.slice(1,4),['3','"3"','true']);
 await exploreBusinessDatabase(env,{...args,filters:[{column:'payload',jsonPath:['a'],operator:'contains',value:'quote\'_%'}]},query);assert.match(calls.at(-1)!.sql,/jsonb_typeof.*='string' AND strpos/);assert(!calls.at(-1)!.sql.includes('quote'));assert.equal(calls.at(-1)!.values?.[1],"quote'_%");
 for(const [operator,expected] of [['missing','IS NULL'],['exists','IS NOT NULL'],['is_null',"= 'null'::jsonb"],['not_null',"<> 'null'::jsonb"]]){
  await exploreBusinessDatabase(env,{...args,filters:[{column:'payload',jsonPath:['a'],operator}]},query);assert(calls.at(-1)!.sql.includes(expected));
 }
 await exploreBusinessDatabase(env,{operation:'aggregate',table:'records',filters:[{column:'payload',jsonPath:['n'],operator:'gt',value:2}],metrics:[{function:'count',alias:'n'}]},query);assert(calls.at(-1)!.sql.includes("jsonb_typeof("));
 const aggregate={operation:'aggregate',table:'records',jsonGroupBy:[{column:'payload',path,alias:'kind'}],metrics:[{function:'sum',column:'payload',jsonPath:['n'],alias:'total'},{function:'count_distinct',column:'payload',jsonPath:['n'],alias:'unique'}]};
 await exploreBusinessDatabase(env,aggregate,query);
 const grouped=calls.at(-1)!;assert(!grouped.sql.includes('DELETE'));assert.deepEqual(grouped.values?.slice(0,3),[path,['n'],['n']]);
 assert.match(grouped.sql,/GROUP BY .*#> \$1::text\[\]/);assert.match(grouped.sql,/count\(DISTINCT NULLIF/);assert.match(grouped.sql,/CASE WHEN.*jsonb_typeof.*='number'.*ELSE.*is not a JSON number/);
 for(const input of [
  {...aggregate,jsonGroupBy:[{column:'payload',path:['a'],alias:'total'}]},
  {...aggregate,groupBy:['id','payload','id']},
  {...aggregate,metrics:[{function:'count',jsonPath:['a'],alias:'n'}]},
  {...aggregate,jsonGroupBy:[{column:'id',path:['a'],alias:'kind'}]},
  {...aggregate,metrics:[{function:'sum',column:'id',jsonPath:['a'],alias:'n'}]},
 ]){const before=calls.length;await assert.rejects(exploreBusinessDatabase(env,input,query));assert.equal(calls.length,before);}
 for(const input of [
  {...args,filters:[{column:'id',jsonPath:['a'],operator:'eq',value:1}]},
  {...args,filters:[{column:'payload',jsonPath:['a'],operator:'gt',value:'2'}]},
  {...args,filters:[{column:'payload',operator:'missing'}]},
  {...args,jsonFields:[{column:'payload',path:['a'],alias:'id'}]},
  {...args,filters:[{column:'payload',jsonPath:['a'],operator:'is_null',value:0}]},
 ]){const before=calls.length;await assert.rejects(exploreBusinessDatabase(env,input,query));assert.equal(calls.length,before);}
});
