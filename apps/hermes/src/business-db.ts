import { Pool, type QueryResultRow } from "pg";
import { z } from "zod";
import type { Env } from "./env.js";
import { DEFAULT_RESPONSE_MAX_CHARS, serializedResponseChars } from "./bounded-page.js";

const userIdSchema = z.string().uuid();

export const userLookupSchema = z.object({
  identifierType: z.enum(["user_id", "email", "firebase_uid"]),
  identifier: z.string().trim().min(1).max(255),
  responseMaxChars: z.number().int().min(4000).max(50000).optional(),
});

export const assetLookupSchema = z.object({
  userIds: z.array(userIdSchema).min(1).max(20),
  assetTypes: z
    .array(z.enum(["pose_image", "pose_video", "home_image", "reference_image"]))
    .min(1)
    .max(4)
    .optional(),
  limitPerUser: z.number().int().min(1).max(100).optional(),
  offsetPerUser: z.number().int().min(0).optional(),
  responseMaxChars: z.number().int().min(4000).max(50000).optional(),
});

export type BusinessQuery = <T extends QueryResultRow>(
  text: string,
  values?: unknown[],
) => Promise<{ rows: T[] }>;

let pool: Pool | undefined;

function assertDatabaseConfigured(env: Env): void {
  if (!env.businessDbEnabled) throw new Error("Business database tools are disabled");
  if (!env.databaseHost || !env.databaseName || !env.databaseUser || !env.databasePassword) {
    throw new Error("Business database configuration is incomplete");
  }
  if (
    env.databaseHost !== "/cloudsql/furever-dock-prod:us-central1:kitty" &&
    env.databaseHost !== "127.0.0.1" &&
    env.databaseHost !== "localhost"
  ) {
    throw new Error("DATABASE_HOST must be the kitty Unix socket or local Auth Proxy");
  }
  if (env.databaseName !== "kitty" || env.databaseUser !== "epbs_readonly") {
    throw new Error("Business database must use kitty as epbs_readonly");
  }
  if (!Number.isInteger(env.databasePort) || env.databasePort < 1 || env.databasePort > 65_535) {
    throw new Error("DATABASE_PORT is invalid");
  }
}

export function databaseQuery(env: Env): BusinessQuery {
  assertDatabaseConfigured(env);
  pool ??= new Pool({
    host: env.databaseHost,
    port: env.databasePort,
    database: env.databaseName,
    user: env.databaseUser,
    password: env.databasePassword,
    max: 3,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: "coco-hermes",
    options:
      "-c default_transaction_read_only=on -c statement_timeout=5000 -c idle_in_transaction_session_timeout=5000",
  });
  return (text, values) => pool!.query(text, values);
}

const REQUIRED_TABLES = [
  "users",
  "pets",
  "purchases",
  "treat_ledger_entries",
  "pet_generated_poses",
  "pet_generated_videos",
  "pet_generated_home_images",
  "pet_reference_images",
] as const;

export async function getBusinessDatabaseStatus(
  env: Env,
  query: BusinessQuery = databaseQuery(env),
): Promise<unknown> {
  const { rows } = await query<{
    database: string;
    user: string;
    readOnly: string;
    missingTables: string[];
    missingSelectTables: string[];
    writableTables: string[];
  }>(`WITH required(table_name) AS (
    SELECT unnest($1::text[])
  ) SELECT
    current_database() AS database,
    current_user AS "user",
    current_setting('default_transaction_read_only') AS "readOnly",
    ARRAY(SELECT table_name FROM required WHERE to_regclass('public.' || table_name) IS NULL) AS "missingTables",
    ARRAY(SELECT table_name FROM required WHERE to_regclass('public.' || table_name) IS NOT NULL
      AND NOT has_table_privilege(current_user, 'public.' || table_name, 'SELECT')) AS "missingSelectTables",
    ARRAY(SELECT table_name FROM required WHERE to_regclass('public.' || table_name) IS NOT NULL
      AND has_table_privilege(current_user, 'public.' || table_name, 'INSERT,UPDATE,DELETE,TRUNCATE')) AS "writableTables"`,
  [REQUIRED_TABLES]);
  const status = rows[0];
  if (!status) throw new Error("Business database status query returned no rows");
  return {
    ok:
      status.readOnly === "on" &&
      status.missingTables.length === 0 &&
      status.missingSelectTables.length === 0 &&
      status.writableTables.length === 0,
    ...status,
  };
}

export async function lookupBusinessUser(
  env: Env,
  input: unknown,
  query: BusinessQuery = databaseQuery(env),
): Promise<unknown> {
  const args = userLookupSchema.parse(input);
  const responseMaxChars = args.responseMaxChars ?? DEFAULT_RESPONSE_MAX_CHARS;
  if (args.identifierType === "user_id") userIdSchema.parse(args.identifier);

  const predicates = {
    user_id: "id = $1::uuid",
    email: "lower(email) = lower($1)",
    firebase_uid: "firebase_uid = $1",
  } as const;
  const { rows } = await query<Record<string, unknown>>(`SELECT
    id::text AS "userId", email, display_name AS "displayName", role::text,
    auth_provider AS "authProvider", last_seen_app_version AS "lastSeenAppVersion",
    last_seen_platform AS "lastSeenPlatform", treat_balance AS "treatBalance",
    created_at AS "createdAt", updated_at AS "updatedAt"
  FROM users WHERE ${predicates[args.identifierType]} LIMIT 1`, [args.identifier]);

  const user = rows[0];
  if (!user) return { found: false, identifierType: args.identifierType, responseMaxChars };
  const userId = String(user.userId);
  const [pets, purchases, treatLedger] = await Promise.all([
    query<Record<string, unknown>>(`SELECT
      id::text AS "petId", name, nickname, species::text, sex::text,
      age_years AS "ageYears", breed, is_published AS "isPublished",
      display_image_url AS "displayImageUrl", home_den_image_url AS "homeDenImageUrl",
      created_at AS "createdAt", updated_at AS "updatedAt"
    FROM pets WHERE owner_id = $1::uuid
    ORDER BY display_order, created_at DESC LIMIT 21`, [userId]),
    query<Record<string, unknown>>(`SELECT
      id::text AS "purchaseId", amount_cents AS "amountCents", currency, status::text,
      used_pet_id::text AS "usedPetId", purchased_at AS "purchasedAt", livemode,
      purchase_kind::text AS "purchaseKind", product_key AS "productKey",
      treat_quantity AS "treatQuantity", created_at AS "createdAt"
    FROM purchases WHERE owner_id = $1::uuid
    ORDER BY purchased_at DESC NULLS LAST, created_at DESC LIMIT 21`, [userId]),
    query<Record<string, unknown>>(`SELECT
      entry_type::text AS "entryType", delta, balance_before AS "balanceBefore",
      balance_after AS "balanceAfter", source_type::text AS "sourceType",
      source_label AS "sourceLabel", pet_id::text AS "petId", created_at AS "createdAt"
    FROM treat_ledger_entries WHERE user_id = $1::uuid
    ORDER BY created_at DESC LIMIT 21`, [userId]),
  ]);

  const summaryLimit = 20;
  const sourceCollections = {
    pets: pets.rows,
    purchases: purchases.rows,
    treatLedger: treatLedger.rows,
  };
  const collections = {
    pets: sourceCollections.pets.slice(0, summaryLimit),
    purchases: sourceCollections.purchases.slice(0, summaryLimit),
    treatLedger: sourceCollections.treatLedger.slice(0, summaryLimit),
  };
  type SummaryCollection = keyof typeof collections;
  const collectionNames = Object.keys(collections) as SummaryCollection[];
  let limits: Record<SummaryCollection, number> = {
    pets: collections.pets.length,
    purchases: collections.purchases.length,
    treatLedger: collections.treatLedger.length,
  };
  const buildResponse = () => {
    const summaryCounts = Object.fromEntries(collectionNames.map((name) => [name, {
      returned: limits[name],
      hasMore: sourceCollections[name].length > limits[name],
    }])) as Record<SummaryCollection, { returned: number; hasMore: boolean }>;
    const responseSizeLimited = collectionNames.some((name) => limits[name] < collections[name].length);
    const summaryHasMore = collectionNames.some((name) => summaryCounts[name].hasMore);
    return {
      found: true,
      user,
      pets: collections.pets.slice(0, limits.pets),
      purchases: collections.purchases.slice(0, limits.purchases),
      treatLedger: collections.treatLedger.slice(0, limits.treatLedger),
      responseMaxChars,
      responseSizeLimited,
      pageLimitReason: responseSizeLimited ? "response_size" : summaryHasMore ? "row_limit" : null,
      summaryHasMore,
      summaryCounts,
      coverage: "基础摘要，不是全部用户信息。全部信息须调用 explore_business_database 的 user_related（使用本次 user.userId），读取关联清单及各非空表的全部分页。宠物、购买和 Treats 摘要各最多20条；responseSizeLimited=true 时摘要还会减少完整记录。无实际来源时不要添加订阅栏目。",
    };
  };

  let response = buildResponse();
  while (serializedResponseChars(response) > responseMaxChars) {
    const reducible = collectionNames
      .filter((name) => limits[name] > 0)
      .sort((left, right) => JSON.stringify(collections[right][limits[right] - 1]).length
        - JSON.stringify(collections[left][limits[left] - 1]).length);
    const name = reducible[0];
    if (!name) {
      throw new Error(
        `Business user summary metadata cannot fit responseMaxChars=${responseMaxChars}; use explore_business_database user_related with selected columns`,
      );
    }
    limits = { ...limits, [name]: limits[name] - 1 };
    response = buildResponse();
  }
  return response;
}

const ASSET_QUERIES = {
  pose_image: `SELECT p.owner_id AS user_id, a.pet_id, a.id, 'pose_image' AS asset_type,
    a.result_url AS url, 'available'::text AS status, a.created_at, a.updated_at,
    jsonb_build_object('slot', a.slot, 'poseNumber', a.pose_number, 'version', a.version) AS metadata
    FROM pet_generated_poses a JOIN pets p ON p.id = a.pet_id
    WHERE p.owner_id = ANY($1::uuid[]) AND COALESCE(a.result_url, '') <> ''`,
  pose_video: `SELECT p.owner_id AS user_id, a.pet_id, a.id, 'pose_video' AS asset_type,
    a.result_url AS url, 'available'::text AS status, a.created_at, a.updated_at,
    jsonb_build_object('slot', a.slot, 'startPoseNumber', a.start_pose_number,
      'endPoseNumber', a.end_pose_number, 'version', a.version) AS metadata
    FROM pet_generated_videos a JOIN pets p ON p.id = a.pet_id
    WHERE p.owner_id = ANY($1::uuid[]) AND COALESCE(a.result_url, '') <> ''`,
  home_image: `SELECT p.owner_id AS user_id, a.pet_id, a.id, 'home_image' AS asset_type,
    a.result_url AS url, 'available'::text AS status, a.created_at, a.updated_at,
    jsonb_build_object('slot', a.slot, 'version', a.version) AS metadata
    FROM pet_generated_home_images a JOIN pets p ON p.id = a.pet_id
    WHERE p.owner_id = ANY($1::uuid[]) AND COALESCE(a.result_url, '') <> ''`,
  reference_image: `SELECT p.owner_id AS user_id, a.pet_id, a.id, 'reference_image' AS asset_type,
    a.download_url AS url, a.status::text, a.created_at, a.updated_at,
    jsonb_build_object('identityAnchor', a.is_identity_anchor, 'orderIndex', a.order_index,
      'mimeType', a.mime_type, 'sizeBytes', a.size_bytes) AS metadata
    FROM pet_reference_images a JOIN pets p ON p.id = a.pet_id
    WHERE p.owner_id = ANY($1::uuid[]) AND COALESCE(a.download_url, '') <> ''`,
} as const;

export function buildAssetsQuery(assetTypes: Array<keyof typeof ASSET_QUERIES>): string {
  const union = [...new Set(assetTypes)].map((type) => ASSET_QUERIES[type]).join("\nUNION ALL\n");
  return `WITH assets AS (${union}), ranked AS (
    SELECT *, row_number() OVER (PARTITION BY user_id ORDER BY created_at DESC, id DESC, asset_type) AS row_num
    FROM assets
  ) SELECT user_id::text AS "userId", pet_id::text AS "petId", id::text AS "assetId",
    asset_type AS "assetType", url, status, created_at AS "createdAt", updated_at AS "updatedAt", metadata
  FROM ranked WHERE row_num > $3 AND row_num <= $3 + $2
  ORDER BY user_id, created_at DESC, id DESC, asset_type`;
}

export async function getUserAssets(
  env: Env,
  input: unknown,
  query: BusinessQuery = databaseQuery(env),
) {
  const args = assetLookupSchema.parse(input);
  const assetTypes = args.assetTypes ?? [
    "pose_image",
    "pose_video",
    "home_image",
    "reference_image",
  ];
  const requestedLimitPerUser = args.limitPerUser ?? 25;
  const offsetPerUser = args.offsetPerUser ?? 0;
  const responseMaxChars = args.responseMaxChars ?? DEFAULT_RESPONSE_MAX_CHARS;
  if (!Number.isSafeInteger(offsetPerUser + requestedLimitPerUser + 1)) throw new Error("Asset page offset is too large");
  const userIds = [...new Set(args.userIds.map((id) => id.toLowerCase()))];
  const [users, { rows }] = await Promise.all([
    query<{ userId: string }>('SELECT id::text AS "userId" FROM users WHERE id = ANY($1::uuid[])', [userIds]),
    query<Record<string, unknown>>(buildAssetsQuery(assetTypes), [userIds, requestedLimitPerUser + 1, offsetPerUser]),
  ]);
  const foundUsers = new Set(users.rows.map((user) => user.userId));
  const buildResponse = (limitPerUser: number) => {
    const assets: Record<string, unknown>[] = [];
    const perUser = userIds.map((userId) => {
      const found = foundUsers.has(userId);
      const page = found ? rows.filter((row) => row.userId === userId) : [];
      const hasMore = page.length > limitPerUser;
      const returned = page.slice(0, limitPerUser);
      assets.push(...returned);
      return {
        userId, found, count: returned.length, hasMore,
        nextOffset: hasMore ? offsetPerUser + limitPerUser : null,
        status: !found ? "user_not_found" : returned.length ? "assets_returned"
          : offsetPerUser === 0 ? "no_matching_assets" : "page_exhausted",
      };
    });
    const hasMore = perUser.some((user) => user.hasMore);
    const responseSizeLimited = limitPerUser < requestedLimitPerUser;
    return {
      userIds,
      assetTypes,
      requestedLimitPerUser,
      limitPerUser,
      offsetPerUser,
      responseMaxChars,
      responseSizeLimited,
      pageLimitReason: responseSizeLimited ? "response_size" : hasMore ? "row_limit" : null,
      hasMore,
      nextOffset: hasMore ? offsetPerUser + limitPerUser : null,
      perUser,
      count: assets.length,
      assets,
      paginationNote: "Keep userIds and assetTypes unchanged when continuing. Concurrent asset changes can shift offset pages; this is not a frozen full export.",
    };
  };

  let response = buildResponse(requestedLimitPerUser);
  while (response.limitPerUser > 1 && serializedResponseChars(response) > responseMaxChars) {
    response = buildResponse(response.limitPerUser - 1);
  }
  if (serializedResponseChars(response) > responseMaxChars) {
    throw new Error(
      `Asset response cannot fit responseMaxChars=${responseMaxChars}; query fewer userIds or narrower assetTypes`,
    );
  }
  // ponytail: offset pages reuse the existing ranking; use snapshot/keyset export if concurrent edits must be isolated.
  return response;
}
