# Plan: CoCo Prompt 架构修复

## Context

当前 CoCo（Hermes 问答助手）存在"只读稿不分析"的问题。根因是 prompt 架构给了模型错误的角色定位。

### 当前完整 System Prompt

来源：[ask.ts:52-56](e:\hermes\apps\hermes\src\ask.ts#L52-L56)

```typescript
const SYSTEM_PROMPT = `你是 CoCo，Furever Dock 团队的 AI 助手。你可以：
- 从 FureverDock 飞书知识库直接读取文档回答专业问题
- 分析 Amplitude 产品数据（DAU、留存、购买等指标）
- 回答日常技术、产品、运营相关问题
请用简洁专业的中文回复，保持友好。不要编造数字或透露系统配置。`;
```

**问题**：只有"助理" title + 能力清单，没有思考方法论、回答风格、禁止行为。"简洁专业"太模糊 → 模型默认走向"安全地复读文档"。

### 当前完整 User Prompt 构建逻辑

来源：[ask.ts:127-142](e:\hermes\apps\hermes\src\ask.ts#L127-L142)

```typescript
// 3. 构建 prompt
let userPrompt: string;
if (hasWiki) {
  userPrompt = [
    `以下是知识库文档中与用户问题相关的内容：\n\n${wikiResult.wikiText}`,
    `\n用户问题：${trimmed}\n\n请根据上面知识库文档的内容直接回答用户问题。`,
  ].join("\n\n");
} else if (dataContext) {
  userPrompt = [
    `以下是产品数据：\n\n${dataContext}`,
    `\n用户问题：${trimmed}\n\n请结合上述数据回答。若问为什么涨跌，从环比和相关指标综合分析。`,
  ].join("\n\n");
} else {
  // 闲聊/通用问题
  userPrompt = trimmed;
}
```

**问题**：
- **"直接回答"四个字是灾难级指令** — 等于告诉模型「文档写什么你说什么，不要发挥」，这是"只读稿不分析"的直接原因
- **wiki 和 data 走 if/else 互斥** — 三者（知识库 + 数据 + 闲聊）永远不同时出现。但真正的分析需要关联，例如「文档显示 1.3.0 在 7 月 1 日上线，数据显示 DAU 同日暴涨 100%，很可能相关」—— CoCo 因架构设计做不到

### 当前 Data Analysis System Prompt（日报分析专用）

来源：[analyze.ts:27-36](e:\hermes\apps\hermes\src\analyze.ts#L27-L36)

```typescript
const ANALYSIS_SYSTEM_PROMPT = `你是 Furever Dock 内部数据分析助手 CoCo。
你收到的数据是从 Amplitude Chart Export API 实时拉取的产品指标。请输出严格 JSON。

规则：
1. 只根据提供的数据分析，不编造。
2. "Wow" = 昨日 vs 前日环比。
3. 告警判定：Wow 跌幅 >15% 或 关键指标（收入/转化/留存）显著走弱 → Alert；次重要指标走弱但未达告警线 → Watch。
4. 正向变动也可标记（如「正向异常」）。
5. 深度分析需引用具体数据、关联指标交叉验证。
6. 中文输出，日期用北京时间。`;
```

这个 prompt 相对好一些（有明确的规则和输出格式），但同样缺乏角色方法论和回答风格。

### 搜索片段截断

来源：[wiki-cache.ts:333](e:\hermes\apps\hermes\src\wiki-cache.ts#L333)

```typescript
snippet: section.content.slice(0, 2000), // 截断避免 token 溢出
```

2000 字符一刀切，长文档段落被拦腰截断，模型看到的是碎片而非完整文档结构。

### 四层根因总结

| 层 | 问题 | 文件位置 |
|----|------|----------|
| System Prompt | 有 title 无职责，没有思考方法论 | [ask.ts:52-56](e:\hermes\apps\hermes\src\ask.ts#L52-L56) |
| User Prompt | "直接回答" = 禁止分析 | [ask.ts:132](e:\hermes\apps\hermes\src\ask.ts#L132) |
| 上下文隔离 | wiki / data / 闲聊三者互斥 | [ask.ts:129-142](e:\hermes\apps\hermes\src\ask.ts#L129-L142) |
| 内容截断 | 2000 字符一刀切 | [wiki-cache.ts:333](e:\hermes\apps\hermes\src\wiki-cache.ts#L333) |

---

## 方案 A：知识库文档承载 Prompt（推荐）

### 思路

在 FureverDock 飞书知识库空间里建一篇「CoCo 行为手册」文档，内容定义 CoCo 的人设、思考方法论、回答风格、禁止行为。代码层面做**一处改动**：启动时 / 每次请求时从 wiki cache 中提取这篇文档的内容，注入 System Prompt。

### 代码改动（仅改 [ask.ts](e:\hermes\apps\hermes\src\ask.ts)）

1. 新增函数 `getBehaviorManual()`：从 `wiki-cache.ts` 导出的 `sections` 数组中，按标题匹配「CoCo 行为手册」
2. 将匹配到的 `content` 拼接到 `SYSTEM_PROMPT` 后面（找不到则降级使用现有硬编码 Prompt）
3. 可选优化：在 `buildWikiContext()` 中将行为手册文档从搜索结果中排除（避免重复注入）

改动量预估：约 20-30 行。

### 飞书文档内容

在知识库中创建「CoCo 行为手册」，内容例如：

```markdown
# CoCo 行为手册

## 你是谁
你是 CoCo，Furever Dock 团队的 AI 分析助手。你不是文档检索工具——
你是能理解业务、连接信息、给出判断的分析师。

## 怎么思考
收到任何问题时，按以下顺序处理：
1. 理解意图：用户真正想知道什么？
2. 提取事实：从知识库和数据中找到相关依据
3. 交叉关联：多份文档之间、数据和文档之间能否互相印证？
4. 给出判断：不只复述，要加上分析和判断
5. 承认边界：信息不够就明确说缺什么

## 回答风格
- 像同事聊天，不用「您」
- 先给结论，再给依据
- 每条回复 3 段以内
- 不确定时加 emoji（🤔 📊 📝 ✅）

## 禁止行为
- 不要逐字复读文档
- 不要堆砌数字表格
- 不要说「根据知识库文档」
- 不知道就说不知道
```

### 方案 A 优缺点

| 优点 | 缺点 |
|------|------|
| ✅ 非开发者可在飞书上直接编辑，30 分钟内自动生效（wiki cache TTL） | ❌ 仍需一次初始部署来改代码 |
| ✅ Prompt 版本历史天然保留（飞书文档编辑历史） | ❌ 依赖 wiki cache 预热成功，首次启动可能短暂降级 |
| ✅ 可以随时 AB 测试不同人设 | ❌ 行为手册内容受 2000 字符截断影响（如超过需特殊处理） |
| ✅ 后续不需要重新部署 | |

---

## 方案 B：直接改硬编码 Prompt

### 思路

修改 [ask.ts](e:\hermes\apps\hermes\src\ask.ts) 中的 `SYSTEM_PROMPT` 和 user prompt 构建逻辑，把 CoCo 从"复读助理"改成"分析师"。同时修复 wiki + data 互斥的问题。

### 代码改动（改 [ask.ts](e:\hermes\apps\hermes\src\ask.ts)）

**改动 1：重写 System Prompt（第 52-56 行）**

```typescript
const SYSTEM_PROMPT = `你是 CoCo，Furever Dock 团队的 AI 分析助手。你不是文档检索工具——
你是能理解业务、连接信息、给出判断的分析师。

思考方法：
1. 理解意图：用户真正想知道什么？
2. 提取事实：从知识库和数据中找到相关依据
3. 交叉关联：多份文档之间、数据和文档之间能否互相印证？
4. 给出判断：不只复述，要加上你的分析
5. 承认边界：信息不够就说缺什么

回答风格：
- 像同事聊天，不用「您」
- 先给结论，再给依据
- 每条回复 3 段以内

禁止：
- 不要逐字复读文档
- 不要堆砌数字表格
- 不要说「根据知识库文档」
- 不知道就说不知道`;
```

**改动 2：修复 user prompt 中的"直接回答"指令（第 132 行）**

```typescript
// 改前：
`请根据上面知识库文档的内容直接回答用户问题。`

// 改后：
`请提取上述文档中的关键事实，结合你的理解分析并回答用户问题。如果数据和文档能互相印证，请指出关联。`
```

**改动 3：合并 wiki + data 上下文（第 128-142 行）**

```typescript
// 改前：if (hasWiki) { ... } else if (dataContext) { ... } else { ... }
// 改后：wiki 和 data 可以同时存在

const contextParts: string[] = [];
if (hasWiki) {
  contextParts.push(`📝 知识库相关内容：\n\n${wikiResult.wikiText}`);
}
if (dataContext) {
  contextParts.push(`📊 产品数据：\n\n${dataContext}`);
}

let userPrompt: string;
if (contextParts.length > 0) {
  userPrompt = [
    ...contextParts,
    `\n用户问题：${trimmed}`,
    `\n请综合以上所有信息，提取关键事实、交叉验证、给出你的分析和判断。`,
  ].join("\n\n---\n\n");
} else {
  userPrompt = trimmed;
}
```

改动量预估：约 40-50 行。

### 方案 B 优缺点

| 优点 | 缺点 |
|------|------|
| ✅ 不需要依赖知识库文档存在 | ❌ **每次调整 prompt 都要重新部署**（改代码 → 构建镜像 → 推送 → 重启容器） |
| ✅ 逻辑更简单，不依赖 wiki cache | ❌ 非开发者完全无法调整 CoCo 行为 |
| ✅ 可以同时修好 wiki+data 互斥问题 | ❌ Prompt 迭代慢，依赖开发排期 |
| | ❌ 没有版本历史（除非 git log 看） |

---

## 对比总结

| 维度 | 方案 A | 方案 B |
|------|--------|--------|
| 初始改动量 | ~30 行 | ~50 行 |
| 后续 Prompt 调整 | 飞书编辑，30 分钟生效 | 重新部署 |
| 谁可以调 Prompt | 任何有知识库权限的人 | 只有开发者 |
| AB 测试 | 简单（飞书历史版本回滚） | 需 git revert + 部署 |
| 可靠性 | 依赖 wiki cache 预热 | 无外部依赖 |
| 同时修互斥问题 | 可以（顺带） | 可以（本方案已包含） |

**推荐方案 A**：一次代码部署后，prompt 调优完全自主可控。

---

## 需要修改的文件

| 文件 | 改动内容 |
|------|----------|
| [ask.ts](e:\hermes\apps\hermes\src\ask.ts) | 方案 A：新增 `getBehaviorManual()` + 注入 System Prompt；方案 B：重写 `SYSTEM_PROMPT` + 改 user prompt + 合并 wiki/data |
| [wiki-cache.ts](e:\hermes\apps\hermes\src\wiki-cache.ts) | 仅方案 A 可能需要：导出 sections 供外部读取（当前 `sections` 是模块私有变量） |

## 验证方式

1. 部署后 @CoCo 问「1.3.0 版本什么时候上线的？DAU 有什么变化？」
2. 期望回复：
   - 不出现「根据知识库文档」字样
   - 先给结论（如"1.3.0 于 7 月 1 日上线，DAU 同日上涨 100%，很可能相关"）
   - 不逐字复读文档，用自己的话总结
   - 3 段以内
3. 方案 A 额外验证：在飞书编辑行为手册改一条规则 → 30 分钟后测试 → 确认生效
