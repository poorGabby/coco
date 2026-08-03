# Plan：Needs Attention（Incomplete Pets）主动发现与推送

> 日期：2026-07-23  
> 关联：小 fur「只读查询 + API 隔离 + 环境变量隐式鉴权 + 沙盒执行」；CoCo 北极星；现有日报 cron / `coco_data` MCP  
> 目标页：https://admin.fureverdock.com/pets/incomplete  
> 状态：方案待排期（Admin API 未就绪）

---

## 0. 一句话目标

让 CoCo **定时自动发现** Admin「Needs Attention / Incomplete Pets」列表中的新增或未处理项，**主动推送到运营群**，替代人工打开 Admin 页面核查。

**非目标**：浏览器登录爬 Admin；把 Admin Cookie/密码写进 Skill/聊天；让 Gateway 直连生产库。

---

## 1. 推荐路径（基于 Hermes Agent）

```text
Admin 生产数据（与 /pets/incomplete 同源）
        │ 只读
        ▼
Admin Read API（新建或从 Admin 后端拆出）
        │ 服务 Token（环境变量）
        ▼
Cloud Run coco-data MCP  ← 扩工具 list_needs_attention_pets
        │ Bearer COCO_MCP_KEY
        ▼
GCE Hermes cron（no-agent 脚本或带 skill 的 agent 任务）
        │ diff 去重
        ▼
飞书群 interactive 卡片（多群可复用 push-daily-card-all 模式）
```

与日报同构：**取数在 MCP，编排/定时在 Hermes，发卡在 VM 脚本**。

---

## 2. 需要的支持（依赖方 / 输入）

### 2.1 Admin / 后端（阻塞项）

| 项 | 说明 |
|----|------|
| 只读列表 API | 与页面同源，例如 `GET /internal/pets/incomplete` 或 `GET /internal/pets/needs-attention` |
| 鉴权方式 | 服务 Token / mTLS / IP 白名单；**禁止**用人登录 Cookie |
| 字段约定 | 见下表「建议 payload」 |
| 深链 | 列表页或单宠详情 URL，便于运营一键跳转 |
| 「已处理」语义 | 项从列表消失的条件（人工处理完？状态变更？），供去重与关闭告警 |

**建议 payload（示例）：**

```json
{
  "items": [
    {
      "id": "pet_xxx",
      "user_id": "usr_xxx",
      "user_label": "邮箱或昵称（可脱敏）",
      "reason": "needs attention 原因文案",
      "status": "incomplete",
      "updated_at": "2026-07-23T08:00:00Z",
      "admin_url": "https://admin.fureverdock.com/pets/..."
    }
  ],
  "generated_at": "..."
}
```

### 2.2 产品 / 运营

| 项 | 说明 |
|----|------|
| 推送群 | 哪些飞书群收告警（可复用日报三群，或单独运营群） |
| 频率 | 建议起步 30～60 分钟；高峰可加密 |
| 告警策略 | 仅「新增」/ 「新增 + 滞留超 N 小时」/ 每日汇总一次 |
| 文案口径 | 卡片标题、原因字段怎么对管理层展示 |

### 2.3 基础设施 / 密钥

| 项 | 说明 |
|----|------|
| `ADMIN_API_BASE` | Admin 只读 API 根地址 |
| `ADMIN_API_KEY`（或等价） | 只写 Cloud Run / Secret Manager，不进 git / 飞书文档 |
| 现有 `COCO_MCP_KEY` | Hermes → MCP 已有 |
| 状态存储 | VM `~/hermes-data/state/needs-attention-seen.json`（或 GCS）做 diff |

### 2.4 不需要的支持

- 不需要改 Hermes 上游内核  
- 不需要给 CoCo 开 Admin 人工账号  
- 不需要把整站 Admin 做成「资源库链接」代替 API  

---

## 3. 提供的工具 / 组件（CoCo 侧交付物）

### 3.1 MCP 工具（扩 `apps/hermes` → Cloud Run `coco-data`）

| 工具名 | 作用 | 调用方 |
|--------|------|--------|
| `list_needs_attention_pets` | 拉取当前 incomplete / needs-attention 列表（只读） | cron 脚本；可选聊天问答 |
| （可选）`get_needs_attention_pet` | 按 id 拉单条详情 | 聊天深挖 |

约束：Zod schema、超时、无写操作；密钥仅服务端 env。

### 3.2 Hermes 定时与推送

| 组件 | 作用 |
|------|------|
| cron job（新建，如 `needs-attention-watch`） | 每 N 分钟跑一次 |
| `deploy/bin/check-needs-attention.sh`（拟） | 调 MCP → diff → 有新增则发卡 |
| `deploy/bin/send-feishu-interactive.sh`（已有） | 发飞书 Card |
| 去重状态文件 | 避免重复刷屏 |

模式优先 **no-agent + 脚本**（与日报一致，稳定、不烧 LLM）；可选第二阶段用 agent + skill 生成自然语言摘要。

### 3.3 Skill / 文档（口径外置）

| 组件 | 作用 |
|------|------|
| Skill：`needs-attention-watch` | 何时告警、推哪些群、字段含义、勿编造未在列表中的用户 |
| 飞书 Wiki（可选） | 运营手册：看到卡片后如何在 Admin 处理 |

### 3.4 聊天能力（可选，非主路径）

运营私聊「现在有哪些 needs attention？」→ 模型调同一 `list_needs_attention_pets`（**单一数据口径**）。

---

## 4. 分阶段验收

| 阶段 | 内容 | 验收 |
|------|------|------|
| A | Admin 只读 API 可用 + 样例 JSON | curl + Token 能拿到与页面一致的条数 |
| B | MCP 工具上线 | Hermes / 本地调 `list_needs_attention_pets` 成功 |
| C | 脚本 + diff + 单群试推 | 人为造一条「新 id」能收到卡片；重复跑不重复推 |
| D | cron 正式 + 多群 | 按约定频率运行；密钥不泄露 |
| E | （可选）聊天同源查询 | 私聊问列表与告警一致 |

---

## 5. 安全对照（小 fur 四件套）

| 原则 | 本方案 |
|------|--------|
| 只读查询 | 仅 list/get；MCP 无 mutate |
| API 隔离 | Gateway 不直连 Admin DB；只打 MCP → Admin Read API |
| 环境变量隐式鉴权 | `ADMIN_*` / `COCO_MCP_KEY` 仅 env |
| 沙盒执行 | 白名单工具 + schema；禁止爬登录页 |

---

## 6. 开放问题（需产品/后端确认）

1. Admin 是否已有 incomplete 列表 API？路径与鉴权？  
2. 「Needs Attention」与「Incomplete」是否同一列表？  
3. 告警要「实时增量」还是「每日汇总 + 紧急增量」？  
4. 推送目标群是否与日报三群相同？  

---

## 7. 下一步

1. 后端确认/提供只读 API 与样例  
2. CoCo 实现 MCP 工具 + 去重推送脚本 + cron  
3. 运营定群与频率后灰度
