/**
 * 飞书知识库调试脚本
 *
 * 用法：
 *   npx tsx src/wiki-lookup.ts <token>       反查节点所属 space_id
 *   npx tsx src/wiki-lookup.ts tree <spaceId> [parentToken]
 *                                             列出空间/文件夹下的节点树
 *   npx tsx src/wiki-lookup.ts spaces         列出所有可访问空间
 */
import { loadEnv } from "./env.js";

const cmd = process.argv[2] || "help";
const arg2 = process.argv[3] || "";

async function getToken(env: ReturnType<typeof loadEnv>): Promise<string> {
  const tokenRes = await fetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: env.feishuAppId,
        app_secret: env.feishuAppSecret,
      }),
    },
  );
  const tokenData = (await tokenRes.json()) as {
    code: number;
    tenant_access_token?: string;
    msg?: string;
  };
  if (tokenData.code !== 0 || !tokenData.tenant_access_token) {
    throw new Error(`Token error: ${JSON.stringify(tokenData)}`);
  }
  return tokenData.tenant_access_token;
}

async function loadToken(): Promise<{ env: ReturnType<typeof loadEnv>; token: string }> {
  const env = loadEnv();
  const token = await getToken(env);
  console.log("✅ tenant_access_token ok\n");
  return { env, token };
}

// ── lookup ────────────────────────────────────────────────────────

async function lookupNode(token: string, input: string) {
  const res = await fetch(
    `https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=${input}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data = (await res.json()) as {
    code: number;
    msg?: string;
    data?: {
      node?: {
        space_id: string;
        obj_type: string;
        title: string;
        node_token: string;
        parent_node_token?: string;
        has_child?: boolean;
      };
    };
  };

  if (data.code !== 0 || !data.data?.node) {
    console.error("❌ API error:", JSON.stringify(data, null, 2));
    return;
  }

  const node = data.data.node;
  console.log(`📄 标题:      ${node.title}`);
  console.log(`📁 类型:      ${node.obj_type}`);
  console.log(`🔑 node_token: ${node.node_token}`);
  console.log(`🔑 parent:     ${node.parent_node_token || "(none — root)"}`);
  console.log(`📦 space_id:   ${node.space_id}`);
  console.log(`📂 has_child:  ${node.has_child ?? "unknown"}`);
  console.log("");
  console.log("👉 将以下配置添加到 .env：");
  console.log(`FEISHU_WIKI_SPACE_IDS=${node.space_id}`);
  if (node.obj_type === "folder") {
    console.log(`FEISHU_WIKI_ROOT_TOKENS=${node.node_token}`);
    console.log(`   （仅搜索此文件夹下的内容）`);
  }
}

// ── tree ───────────────────────────────────────────────────────────

async function listTree(token: string, spaceId: string, parentToken?: string, indent = 0) {
  let path = `/wiki/v2/spaces/${spaceId}/nodes?page_size=50`;
  if (parentToken) path += `&parent_node_token=${parentToken}`;

  const res = await fetch(
    `https://open.feishu.cn/open-apis${path}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data = (await res.json()) as {
    code: number;
    msg?: string;
    data?: {
      items?: Array<{
        node_token: string;
        obj_type: string;
        title: string;
        has_child?: boolean;
      }>;
      has_more?: boolean;
      page_token?: string;
    };
  };

  if (data.code !== 0) {
    console.error(`${" ".repeat(indent)}❌ ${JSON.stringify(data)}`);
    return;
  }

  const items = data.data?.items ?? [];
  for (const item of items) {
    const icon = item.obj_type === "folder"
      ? "📁"
      : item.obj_type === "doc"
        ? "📄"
        : "🔗";
    const child = item.has_child ? " (...)" : "";
    console.log(`${" ".repeat(indent)}${icon} ${item.title}${child}`);
    console.log(`${" ".repeat(indent)}   token: ${item.node_token}`);
  }

  // 如果还有更多页，提示
  if (data.data?.has_more) {
    console.log(`${" ".repeat(indent)}⚠️  还有更多节点，未全部显示`);
  }
}

// ── spaces ─────────────────────────────────────────────────────────

async function listSpaces(token: string) {
  const spacesRes = await fetch(
    "https://open.feishu.cn/open-apis/wiki/v2/spaces?page_size=20",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const spacesData = (await spacesRes.json()) as {
    data?: { items?: Array<{ space_id: string; name: string; description?: string }> };
  };
  const items = spacesData.data?.items ?? [];
  for (const s of items) {
    console.log(`📦 ${s.space_id}  ${s.name}`);
    if (s.description) console.log(`   ${s.description}`);
  }
  if (!items.length) console.log("（无可访问的空间）");
}

// ── main ───────────────────────────────────────────────────────────

async function main() {
  if (cmd === "spaces") {
    const { token } = await loadToken();
    await listSpaces(token);
    return;
  }

  if (cmd === "tree") {
    if (!arg2) {
      console.log("用法: npx tsx src/wiki-lookup.ts tree <spaceId> [parentNodeToken]");
      process.exit(1);
    }
    const { token } = await loadToken();
    const parent = process.argv[4] || undefined;
    console.log(`列出节点树 (space=${arg2}, parent=${parent || "root"})\n`);
    await listTree(token, arg2, parent);
    return;
  }

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log("用法:");
    console.log("  npx tsx src/wiki-lookup.ts <token>        反查节点所属 space_id");
    console.log("  npx tsx src/wiki-lookup.ts tree <spaceId>  列出空间根节点");
    console.log("  npx tsx src/wiki-lookup.ts tree <spaceId> <parentToken>  列出子节点");
    console.log("  npx tsx src/wiki-lookup.ts spaces           列出所有可访问空间");
    return;
  }

  // 默认：lookup
  const { env, token } = await loadToken();
  await lookupNode(token, cmd);
  console.log("\n--- 所有可访问的知识库空间 ---");
  await listSpaces(token);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
