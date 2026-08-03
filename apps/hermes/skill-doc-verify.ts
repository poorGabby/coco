import { loadEnv } from "./src/env.js";
import { getDocumentRawContent } from "./src/feishu.js";
import { resolveSkillDoc } from "./src/agent/skill-doc.js";

/**
 * 验证「文档驱动」是否奏效：
 * 1. 直接从飞书拉《CoCo 数据口径 Skill》原文（绕过缓存，看当前真身）；
 * 2. 走 resolveSkillDoc（agent 实际注入 system prompt 的那条链路）确认一致；
 * 3. 探测「主动取数」关键词是否已进入文档。
 */
const env = loadEnv();
const token = env.feishuCocoSkillDocToken;
console.log(`[verify] skillDocToken=${token || "(未配置)"} proxy=${process.env.HTTPS_PROXY ?? "none"}`);

const raw = await getDocumentRawContent(env, token);
console.log("\n===== 飞书《CoCo 数据口径 Skill》原文（raw_content）=====\n");
console.log(raw);

const injected = await resolveSkillDoc(env);
console.log("\n===== resolveSkillDoc（agent 实际注入的口径）=====\n");
console.log(injected);

const hasProactive = /主动取数|主动取值|主动拉数|proactive/i.test(raw);
console.log(`\n[verify] 文档中是否已包含「主动取数」策略: ${hasProactive ? "是 ✅" : "否 ❌（尚未写入）"}`);
