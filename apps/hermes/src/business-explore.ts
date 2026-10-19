import { z } from "zod";
import type { Env } from "./env.js";
import { databaseQuery, type BusinessQuery } from "./business-db.js";
import { buildBoundedPage, DEFAULT_RESPONSE_MAX_CHARS } from "./bounded-page.js";

const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/);
const scalar = z.union([z.string().max(4000), z.number().finite(), z.boolean()]);
const jsonPath = z.array(z.string().min(1).max(200).refine(v => !v.includes('\0'))).min(1).max(12);
export const businessExploreSchema = z.object({
  operation: z.enum(["tables", "schema", "rows", "aggregate", "user_related", "related"]),
  userId: z.string().uuid().optional(),
  rootTable: identifier.optional(),
  rootKey: z.record(identifier, scalar).optional().describe("起点表的完整主键，如 pets 的 {id: UUID}；不接受名称猜测或 SQL"),
  relationDirection: z.enum(["referencing", "referenced"]).optional().describe("referencing 查询引用起点的关联记录；referenced 查询起点引用的父记录，如宠物的主人、模板和流水线"),
  table: identifier.optional().describe("public 下的真实表名，先用 tables/schema 发现；不接受 SQL"),
  columns: z.array(identifier).min(1).max(100).optional(),
  jsonFields: z.array(z.object({column: identifier, path: jsonPath, alias: identifier}).strict()).min(1).max(20).optional(),
  filters: z.array(z.object({ column: identifier,
    jsonPath: jsonPath.optional(),
    operator: z.enum(["eq", "ne", "gt", "gte", "lt", "lte", "in", "contains", "is_null", "not_null", "missing", "exists"]),
    value: z.union([scalar, z.array(scalar).min(1).max(100)]).optional(),
  }).strict()).max(10).optional(),
  orderBy: z.array(z.object({ column: identifier, direction: z.enum(["asc", "desc"]) }).strict()).max(3).optional(),
  groupBy: z.array(identifier).min(1).max(3).optional(),
  jsonGroupBy: z.array(z.object({column: identifier, path: jsonPath, alias: identifier}).strict()).min(1).max(3).optional(),
  metrics: z.array(z.object({ function: z.enum(["count", "count_distinct", "sum", "avg", "min", "max"]),
    column: identifier.optional(), jsonPath: jsonPath.optional(), alias: identifier,
  }).strict()).min(1).max(10).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).max(100000).optional(),
  responseMaxChars: z.number().int().min(4000).max(50000).optional(),
}).strict();

export const BUSINESS_EXPLORE_DESCRIPTION = "直接查询远程 kitty 生产数据库的 public 业务表，不使用硬编码记录。" +
  "tables 列出当前可读表；schema 返回字段、类型、主外键；rows 按真实字段筛选、排序和分页读取；aggregate 支持 count/count_distinct/sum/avg/min/max 及分组。" +
  "任意记录全部信息使用 related：rootTable 为真实表名、rootKey 为完整主键，宠物用 rootTable=pets、rootKey={id:宠物UUID}。先不传 table 查清单，再传 table 逐表分页；分别查 relationDirection=referencing（引用起点）和 referenced（起点引用，如主人/模板），仅沿单一方向走外键，不能把父记录的其他子记录当成此记录。" +
  "用户全部信息必须调用 user_related：userId 为已确认的 kitty UUID；不传 table 返回所有可追溯用户的外键关联表及匹配行数，传 table 返回该表全部字段并分页。逐表读取非空结果，不能只返回基础资料。关联不等于所有权；无外键表和循环关系另行列出待核查。" +
  "先查结构再选表，不猜字段和关联。用户ID作为 filters 的值；需要跨表时依据外键逐表查询，不能把 pet_id 当 user_id。" +
  `每页最多100条，默认25条；完整JSON响应默认不超过${DEFAULT_RESPONSE_MAX_CHARS}字符，可用responseMaxChars在4000～50000间调整。` +
  "响应会按完整行自动缩页，responseSizeLimited=true时按nextOffset续查；单行过大时须减少columns/JSON投影，绝不截断字段。不能把单页当全部。" +
  "rows/aggregate的filters可带jsonPath字符串数组（已发现的对象键/数组索引），仅用于json/jsonb列，精确区分数字、字符串和布尔值；JSON大小比较仅接受数字，contains只匹配JSON字符串。missing/exists检查路径，is_null只匹配明确JSON null，not_null排除缺失和null。rows可用jsonFields[{column,path,alias}]投影子值并返回present/type/value；配合columns选少量普通列，避免整个大JSON超过响应限制。路径来自实际数据，不把JSON里的ID自动认定为外键。" +
  "aggregate可用jsonGroupBy[{column,path,alias}]按JSON子值分组，和groupBy合计最多3维；metrics可加jsonPath。JSON count/count_distinct排除缺失和null并保留类型，sum/avg/min/max只接受JSON数字，遇到其他类型报错而非忽略；需要限定数字时先用JSON数字比较筛选。分组返回value/present/type。" +
  "只读账号、参数化筛选、5秒超时；不支持任意SQL/写入。数据库权限不代表具备权威订阅数据。";

type Column = { name: string; type: string; category: string };
type ForeignKey = { name: string; definition: string; columns: string[]; referencedTable: string; referencedSchema: string; referencedColumns: string[] };
type Table = { name: string; columns: Column[]; primaryKey: string[]; foreignKeys: ForeignKey[] };
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;

export async function exploreBusinessDatabase(env: Env, raw: unknown, query: BusinessQuery = databaseQuery(env)) {
  const input = businessExploreSchema.parse(raw);
  const allowed: Record<z.infer<typeof businessExploreSchema>["operation"], string[]> = {
    tables: [], schema: ["table"], rows: ["table", "columns", "jsonFields", "filters", "orderBy", "limit", "offset", "responseMaxChars"],
    aggregate: ["table", "filters", "groupBy", "jsonGroupBy", "metrics", "limit", "offset", "responseMaxChars"],
    user_related: ["userId", "table", "columns", "limit", "offset", "responseMaxChars"],
    related: ["rootTable", "rootKey", "relationDirection", "table", "columns", "limit", "offset", "responseMaxChars"],
  };
  for (const key of Object.keys(input)) if (key !== "operation" && !allowed[input.operation].includes(key)) throw new Error(`${input.operation} does not support ${key}`);
  if (!["tables", "user_related", "related"].includes(input.operation) && !input.table) throw new Error("table is required; discover tables first");
  if (input.operation === "user_related" && !input.userId) throw new Error("user_related requires a verified kitty userId");
  // Read live metadata every call: schema changes and grants cannot leave a stale allowlist.
  const { rows: tables } = await query<Table>(`SELECT c.relname AS name,
    (SELECT json_agg(json_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
      'category',t.typcategory,'nullable',NOT a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
      FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
    COALESCE((SELECT json_agg(a.attname ORDER BY k.ord) FROM pg_constraint p,
      unnest(p.conkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.num
      WHERE p.conrelid=c.oid AND p.contype='p'),'[]') AS "primaryKey",
    COALESCE((SELECT json_agg(json_build_object('name',f.conname,'definition',pg_get_constraintdef(f.oid),
      'referencedTable',(SELECT relname FROM pg_class WHERE oid=f.confrelid),
      'referencedSchema',(SELECT nspname FROM pg_namespace WHERE oid=(SELECT relnamespace FROM pg_class WHERE oid=f.confrelid)),
      'columns',(SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(f.conkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=f.conrelid AND a.attnum=k.num),
      'referencedColumns',(SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(f.confkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=f.confrelid AND a.attnum=k.num)))
      FROM pg_constraint f WHERE f.conrelid=c.oid AND f.contype='f'),'[]') AS "foreignKeys"
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND has_schema_privilege(n.oid,'USAGE')
      AND has_table_privilege(c.oid,'SELECT') AND ($1::text IS NULL OR c.relname=$1)
    ORDER BY c.relname`, [["user_related", "related"].includes(input.operation) ? null : input.table ?? null]);
  const base = { source: "kitty PostgreSQL", readOnly: true, schema: "public", fetchedAt: new Date().toISOString(), query: input };
  if (input.operation === "tables") return { ...base, tables: tables.map(t => ({ name: t.name, columnCount: t.columns.length, primaryKey: t.primaryKey })), count: tables.length };
  if (input.operation === "user_related" || input.operation === "related") {
    const byName = new Map(tables.map(t => [t.name, t]));
    const rootName = input.operation === "user_related" ? "users" : input.rootTable;
    const rootKey = input.operation === "user_related" ? { id: input.userId! } : input.rootKey;
    const root = rootName ? byName.get(rootName) : undefined;
    if (!root || !rootKey || !root.primaryKey.length || Object.keys(rootKey).length !== root.primaryKey.length || !root.primaryKey.every(k => Object.hasOwn(rootKey, k))) throw new Error("Provide a readable rootTable and its complete primary key in rootKey");
    const values = root.primaryKey.map(k => rootKey[k]);
    const rootWhere = (alias: string) => root.primaryKey.map((k,i) => `${alias}.${quote(k)}=$${i+1}`).join(" AND ");
    const found = (await query(`SELECT 1 FROM public.${quote(root.name)} r WHERE ${rootWhere("r")}`, values)).rows.length > 0;
    if (!found) return { ...base, found: false };
    const direction = input.relationDirection ?? "referencing";
    const edges = (tableName: string): ForeignKey[] => direction === "referencing" ? byName.get(tableName)?.foreignKeys ?? [] :
      tables.flatMap(t => t.foreignKeys.filter(f => f.referencedSchema === "public" && f.referencedTable === tableName).map(f => ({ ...f,
        columns: f.referencedColumns, referencedTable: t.name, referencedColumns: f.columns })));
    // Follow real outbound foreign keys only. Never scan unrelated rows for a coincidental UUID.
    const paths = (name: string, visited: string[] = []): ForeignKey[][] => {
      if (name === root.name) return [[], ...edges(name).filter(f => f.referencedTable === name && f.referencedSchema === "public").map(f => [f])];
      if (visited.includes(name)) return [];
      const result: ForeignKey[][] = [];
      for (const fk of edges(name)) {
        if (fk.referencedSchema !== "public" || !byName.has(fk.referencedTable)) continue;
        if (!fk.columns.length || fk.columns.length !== fk.referencedColumns.length) throw new Error("Foreign key metadata is incomplete");
        for (const tail of paths(fk.referencedTable, [...visited, name])) {
          result.push([fk, ...tail]);
          if (result.length > 256) throw new Error("More than 256 relation paths; inspect schema and query explicitly");
        }
      }
      return result;
    };
    const related = tables.map(t => ({ table: t, paths: paths(t.name) }));
    const predicate = (routes: ForeignKey[][]) => routes.map(route => {
      if (!route.length) return rootWhere("t0");
      let sql = "", close = "";
      route.forEach((fk, i) => {
        sql += `EXISTS (SELECT 1 FROM public.${quote(fk.referencedTable)} t${i + 1} WHERE ` +
          fk.columns.map((c, n) => `t${i}.${quote(c)}=t${i + 1}.${quote(fk.referencedColumns[n])}`).join(" AND ") + " AND ";
        close += ")";
      });
      return sql + rootWhere(`t${route.length}`) + close;
    }).map(p => `(${p})`).join(" OR ");
    const relationMeaning = direction === "referencing" ? "这些记录的外键直接或间接指向起点记录（另含起点自身）" : "起点记录的外键直接或间接指向这些记录（另含起点自身）";
    const pathDetails = (tableName: string, route: ForeignKey[]) => {
      const hops = route.map((f,i) => {
        const from = { table: i ? route[i-1].referencedTable : tableName, columns: f.columns, role: i ? `中间记录${i}` : "匹配记录" };
        const to = { table: f.referencedTable, columns: f.referencedColumns, role: i === route.length - 1 ? "起点记录" : `中间记录${i+1}` };
        // Always describe the declared FK direction, even when traversal ran backwards.
        const [child,parent] = direction === "referenced" ? [to,from] : [from,to];
        return { constraint: f.name, fromTable: child.table, fromColumns: child.columns, fromRole: child.role,
          toTable: parent.table, toColumns: parent.columns, toRole: parent.role,
          statement: `${child.role} ${child.table}.${child.columns.join("+")} 引用 ${parent.role} ${parent.table}.${parent.columns.join("+")}` };
      });
      return { kind: route.length ? "foreign_key" : "root_record", direction, meaning: relationMeaning, hops,
        relationshipStatement: hops.length ? hops.map(h => h.statement).join("；") : "匹配记录就是本次查询的起点记录自身",
        interpretation: "statement按数据库声明的外键方向表达；即使同表也要保留起点/匹配角色，不反转关系或猜测业务身份" };
    };
    const notes = ["按当前 public 可读表的无环外键路径关联，包含所有权、引用或作者关系，不能都称为用户拥有。起点自引用只展开一层（如宠物模板）；更深自引用、无外键/JSON内关联和其他 schema 不自动推断。", "逐表实时查询，不是跨表快照；未查完分页或存在失败时不得称全部信息。没有实际订阅来源时省略订阅栏目。", "同一行可能匹配多条关系路径，各路径行数不能相加作为表总行数。描述关系时使用relationMeaning、matchedRelations和真实字段，不猜测角色。"];
    if (!input.table) {
      if (input.columns || input.limit !== undefined || input.offset !== undefined) throw new Error("Inventory does not accept columns/limit/offset without table");
      const inventory = [];
      for (const r of related.filter(r => r.paths.length)) {
        const relationPaths = r.paths.map(path => path.map(f => f.name));
        try {
          const counts = r.paths.map((path,i) => `count(*) FILTER (WHERE ${predicate([path])})::text AS "path_${i}"`);
          const { rows } = await query(`SELECT count(*)::text AS count, ${counts.join(",")} FROM public.${quote(r.table.name)} t0 WHERE ${predicate(r.paths)}`, values);
          const matchedRelations = r.paths.flatMap((path,i) => Number(rows[0][`path_${i}`]) > 0 ? [{ ...pathDetails(r.table.name,path), count: String(rows[0][`path_${i}`]) }] : []);
          inventory.push({ table: r.table.name, count: String(rows[0].count), matchedRelations, status: "queried" });
        } catch (e) { inventory.push({ table: r.table.name, count: null, relationPaths, status: "failed", errorCode: String((e as {code?: string}).code ?? "unknown") }); }
      }
      return { ...base, found: true, relationDirection: direction, relationMeaning, inventory, inventoryComplete: inventory.every(r => r.status === "queried"),
        unlinkedTables: related.filter(r => !r.paths.length).map(r => r.table.name),
        selfReferences: tables.flatMap(t => t.foreignKeys.filter(f => f.referencedTable === t.name).map(f => ({ table: t.name, constraint: f.name }))), notes };
    }
    const r = related.find(r => r.table.name === input.table);
    if (!r?.paths.length) throw new Error("No verified acyclic foreign-key path between this table and the root");
    if (!r.table.primaryKey.length) throw new Error("Primary key required for stable pagination");
    const fields = input.columns ?? r.table.columns.map(c => c.name);
    for (const c of fields) if (!r.table.columns.some(f => f.name === c)) throw new Error(`Unknown column: ${c}`);
    const limit = input.limit ?? 25, offset = input.offset ?? 0;
    const { rows } = await query(`SELECT ${fields.map(c => `t0.${quote(c)}`).join(",")} FROM public.${quote(input.table)} t0 WHERE ${predicate(r.paths)} ORDER BY ${r.table.primaryKey.map(c => `t0.${quote(c)}`).join(",")} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, limit + 1, offset]);
    return buildBoundedPage({
      candidates: rows,
      limit,
      offset,
      responseMaxChars: input.responseMaxChars,
      oversizedRowHint: "select fewer columns or project smaller JSON fields",
      build: (page) => ({ ...base, found: true, relationDirection: direction, relationMeaning, ...page, notes }),
    });
  }
  const table = tables.find(t => t.name === input.table);
  if (!table) throw new Error("Table does not exist or is not readable in public");
  if (input.operation === "schema") return { ...base, ...table };
  const col = (name: string) => { const c = table.columns.find(c => c.name === name); if (!c) throw new Error(`Unknown column: ${name}`); return c; };
  const values: unknown[] = [];
  const param = (v: unknown) => { values.push(v); return `$${values.length}`; };
  const jsonExpression = (column: string, path: string[]) => {
    if (!['json','jsonb'].includes(col(column).type)) throw new Error('JSON path requires a json/jsonb column');
    return `(${quote(column)}::jsonb #> ${param(path)}::text[])`;
  };
  const conditions = (input.filters ?? []).map(f => {
    col(f.column); const key = quote(f.column);
    if (f.jsonPath) {
      const expr = jsonExpression(f.column, f.jsonPath);
      if (f.operator === 'missing' || f.operator === 'exists' || f.operator === 'is_null' || f.operator === 'not_null') {
        if (f.value !== undefined) throw new Error('JSON presence/null filters do not accept value');
        return f.operator === 'missing' ? `${expr} IS NULL` : f.operator === 'exists' ? `${expr} IS NOT NULL` :
          f.operator === 'is_null' ? `${expr} = 'null'::jsonb` : `(${expr} IS NOT NULL AND ${expr} <> 'null'::jsonb)`;
      }
      if (f.value === undefined) throw new Error('JSON filter value is required');
      const jsonParam = (v: unknown) => `${param(JSON.stringify(v))}::jsonb`;
      if (f.operator === 'in') {
        if (!Array.isArray(f.value)) throw new Error('in requires an array');
        return `${expr} IN (${f.value.map(jsonParam).join(',')})`;
      }
      if (Array.isArray(f.value)) throw new Error('JSON comparison requires a scalar');
      if (f.operator === 'contains') {
        if (typeof f.value !== 'string') throw new Error('contains requires text');
        return `(jsonb_typeof(${expr})='string' AND strpos(${expr} #>> '{}',${param(f.value)}) > 0)`;
      }
      if (f.operator === 'eq' || f.operator === 'ne') return `${expr} ${f.operator === 'eq' ? '=' : '<>'} ${jsonParam(f.value)}`;
      if (typeof f.value !== 'number') throw new Error('JSON ordered comparison requires a numeric value');
      return `(jsonb_typeof(${expr})='number' AND ${expr} ${{gt:'>',gte:'>=',lt:'<',lte:'<='}[f.operator]} ${jsonParam(f.value)})`;
    }
    if (f.operator === 'missing' || f.operator === 'exists') throw new Error('missing/exists require jsonPath');
    if (f.operator === "is_null" || f.operator === "not_null") {
      if (f.value !== undefined) throw new Error("Null filters do not accept value");
      return `${key} IS ${f.operator === "not_null" ? "NOT " : ""}NULL`;
    }
    if (f.value === undefined) throw new Error("Filter value is required");
    if (f.operator === "in") {
      if (!Array.isArray(f.value)) throw new Error("in requires an array");
      return `${key} IN (${f.value.map(param).join(",")})`;
    }
    if (Array.isArray(f.value)) throw new Error("This filter requires a scalar");
    if (f.operator === "contains") {
      if (typeof f.value !== "string") throw new Error("contains requires text");
      return `strpos(${key}::text,${param(f.value)}) > 0`;
    }
    return `${key} ${{ eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }[f.operator]} ${param(f.value)}`;
  });
  let fields: string[], groups: string[] = [], order: string[];
  if (input.operation === "rows") {
    const selected = input.columns ?? table.columns.map(c => c.name);
    fields = selected.map(name => { col(name); return quote(name); });
    const names = new Set(selected);
    for (const item of input.jsonFields ?? []) {
      if (names.has(item.alias)) throw new Error('JSON field aliases must be unique and distinct from selected columns');
      names.add(item.alias);
      const expr = jsonExpression(item.column, item.path);
      fields.push(`jsonb_build_object('value',${expr},'present',${expr} IS NOT NULL,'type',jsonb_typeof(${expr})) AS ${quote(item.alias)}`);
    }
    const requested = input.orderBy ?? [];
    order = requested.map(o => { col(o.column); return `${quote(o.column)} ${o.direction.toUpperCase()}`; });
    // Primary-key tie breakers make pagination deterministic for an unchanged table.
    order.push(...table.primaryKey.filter(k => !requested.some(o => o.column === k)).map(quote));
    if (!order.length) throw new Error("Table has no primary key; supply orderBy for pagination");
  } else {
    if (!input.metrics?.length) throw new Error("aggregate requires metrics");
    groups = (input.groupBy ?? []).map(name => { col(name); return quote(name); });
    if (groups.length + (input.jsonGroupBy?.length ?? 0) > 3) throw new Error("At most 3 grouping dimensions are supported");
    const aliases = [...input.metrics.map(m => m.alias), ...(input.groupBy ?? []), ...(input.jsonGroupBy ?? []).map(g => g.alias)];
    if (new Set(aliases).size !== aliases.length) throw new Error("Metric aliases must be unique and distinct from group columns");
    fields = [...groups];
    for (const g of input.jsonGroupBy ?? []) {
      const expr = jsonExpression(g.column, g.path);
      groups.push(expr);
      fields.push(`jsonb_build_object('value',${expr},'present',${expr} IS NOT NULL,'type',jsonb_typeof(${expr})) AS ${quote(g.alias)}`);
    }
    fields.push(...input.metrics.map(m => {
      if (!m.column && m.function !== "count") throw new Error(`${m.function} requires column`);
      const c = m.column ? col(m.column) : undefined;
      let expression = m.column ? quote(m.column) : "*";
      if (m.jsonPath) {
        if (!m.column) throw new Error("JSON metric requires column");
        const expr = jsonExpression(m.column, m.jsonPath);
        expression = ["count", "count_distinct"].includes(m.function) ? `NULLIF(${expr},'null'::jsonb)` :
          // Fail on mixed types instead of silently dropping rows or converting numeric strings.
          `(CASE WHEN ${expr} IS NULL OR ${expr}='null'::jsonb THEN NULL WHEN jsonb_typeof(${expr})='number' THEN (${expr} #>> '{}')::numeric ELSE ((${expr} #>> '{}') || ' is not a JSON number')::numeric END)`;
      } else if (["sum", "avg"].includes(m.function) && c?.category !== "N") throw new Error("sum/avg requires a numeric column");
      return `${m.function === "count_distinct" ? "count(DISTINCT " : m.function + "("}${expression}) AS ${quote(m.alias)}`;
    }));
    order = groups;
  }
  const limit = input.limit ?? 25, offset = input.offset ?? 0;
  const sql = `SELECT ${fields.join(",")} FROM public.${quote(table.name)}` +
    (conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "") +
    (groups.length ? ` GROUP BY ${groups.join(",")}` : "") + (order.length ? ` ORDER BY ${order.join(",")}` : "") +
    ` LIMIT ${param(limit + 1)} OFFSET ${param(offset)}`;
  let rows: Record<string, unknown>[];
  try { ({ rows } = await query(sql, values)); }
  catch (error) { throw new Error(`kitty query failed (${String((error as { code?: string }).code ?? "unknown")}); check field types, filters or reduce query scope`); }
  return buildBoundedPage({
    candidates: rows,
    limit,
    offset,
    responseMaxChars: input.responseMaxChars,
    oversizedRowHint: "select fewer columns, project smaller JSON fields, or reduce grouping dimensions",
    build: (page) => ({ ...base, table: table.name, ...page, limit, offset,
      notes: ["实时只读查询；分页期间新增、修改、删除可能影响 offset。不是跨页快照或全库备份。无 column 的 count 指匹配行数；指定 column/path 的 count 排除空值，count_distinct 才对指定字段去重。JSON 分组区分缺失、null、数字、字符串等类型；JSON 指标排除缺失与 null，sum/avg/min/max 遇到非数字则整次查询报错，不静默丢弃或转换数字字符串。"] }),
  });
}
