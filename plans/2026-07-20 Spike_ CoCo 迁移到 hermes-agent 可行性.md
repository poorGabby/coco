# Spike：CoCo 迁移/借力 NousResearch/hermes-agent 可行性评估

> 日期：2026-07-20 · 方式：读源码契约(未做完整本地安装) · 关联：`.cursor/rules/coco-agentic-north-star.mdc`

## 背景

用户当初下载 `NousResearch/hermes-agent`，本意是让 CoCo **基于它构建**。但现仓库
`e:\hermes`（TypeScript / Cloud Run / 飞书）与 hermes-agent（Python 框架）**零代码关系**，
只共用了 "Hermes" 这个代号。本 spike 评估"把 CoCo 迁到 / 借力 hermes-agent"是否成立，
生死线 = **飞书能否接入**。

## 结论（TL;DR）

**可行，且比预期容易。生死线是绿灯。**

1. ✅ **飞书原生支持**：hermes-agent 自带成熟的 `plugins/platforms/feishu/` 插件
   （`adapter.py` 238KB + `feishu_comment.py` + `feishu_meeting_invite.py` + `plugin.yaml`），
   还附带 `dingtalk`、`wecom`（企业微信）。**我们不用自己写飞书适配器。**
   （初判"无飞书"是错的——只看了核心 `gateway/platforms/`，飞书在 `plugins/platforms/`。）
2. ✅ **插件模型零核心改动**：社区平台 = `~/.hermes/plugins/<name>/`（`plugin.yaml` + `adapter.py`
   继承 `BasePlatformAdapter`），插件系统自动接管配置/鉴权/**cron 投递**/发送路由/状态。
3. ✅ **日报 = skill + cron**：hermes-agent 有完整 cron 调度（`cron/scheduler.py`，支持
   `deliver=<platform>` 投递到飞书）和 skills 系统。CoCo 的"每天 9 点日报"是它的原生示例场景。
4. ✅ **白拿的能力**：MCP 集成、跨会话记忆/用户建模、多模型（provider 无关）、子代理并行、40+ 工具。
   —— 我们手写的 MCP Phase A、自研 cron、口径文档，很大程度会被它开箱即用的能力取代。

## 关键洞察：用 MCP 复用我们已有的 TS 代码（不用重写）

CoCo 的领域价值（Amplitude/Stripe 取数 + DoD/口径 + 日报组装）现在是 TypeScript。
**不必重写成 Python**——把它们包成一个 **MCP server**（我们刚做完 MCP client，反向做 server 很对称），
hermes-agent 作为"大脑 + 飞书网关"通过 MCP 调用它。这样：

- 我们已上线的 `stripe.ts` / `amplitude*.ts` / 收入口径 全部复用，零重写；
- hermes-agent 提供飞书、记忆、skills、多模型、cron；
- 符合北极星：新能力 = 注册 MCP server / skill，不改内核。

```
飞书 ──(hermes-agent feishu 插件)──► hermes-agent（大脑/记忆/skills/cron）
                                          │  MCP client
                                          ▼
                          CoCo-data MCP server（我们现有 TS 代码：Amplitude/Stripe/口径）
```

## 迁移路径（分阶段，不推倒现网）

- **S0 现状保护**：现网 TS CoCo（Cloud Run）继续服务，迁移全程不下线。
- **S1 装机验证（真正的"能跑"证据）**：小 VM（$5 VPS 即可，hermes-agent 就是为此设计）
  安装 hermes-agent，用**测试飞书应用**启用 feishu 插件，跑通一条来回消息。
  → 验证飞书插件的 env/回调方式（事件回调 vs 长连接、是否需公网 URL）。
- **S2 数据能力 MCP 化**：把现有 TS 取数/收入/口径包成 CoCo-data MCP server，hermes-agent 接入。
- **S3 日报 skill + cron**：写 `furever-daily-report` skill，cron `deliver=feishu` 每天 9:00（北京时间）。
- **S4 灰度切换**：测试群先用 hermes-agent 版；稳定后把生产飞书应用回调切过去，旧 Cloud Run 退役。

## 仍需确认的真实变量（S1 要落地的）

- **运行形态**：hermes-agent 要**常驻进程**（VM/VPS），与 Cloud Run 无状态请求模型不同——需要一台 VM。
  （这也顺带解决了之前 Cloud Run CPU 节流那类问题。）
- **飞书插件契约细节**：`plugin.yaml` 的 env 变量、回调/长连接方式、是否要公网 callback URL
  （S1 装机后 5 分钟即可确认）。
- **记忆/多租户/权限**：hermes-agent 的鉴权（allowlist、DM pairing）与企业多群使用方式。
- **成本/运维**：一台常驻 VM 的成本与运维，对比当前 Cloud Run 近乎零闲置成本。

## 建议的下一步（S1）

给我一台可 SSH 的小 Linux VM（或同意本地起一个），我：
1. 装 hermes-agent，启用 feishu 插件 + 一个测试飞书应用，跑通来回消息；
2. 读 `plugins/platforms/feishu/plugin.yaml` 确认所需配置；
3. 出一份"S1 结果 + S2 MCP server 接口设计"。

> 一句话：**你的记忆没错——CoCo 确实可以基于 hermes 构建，而且飞书是现成的。** 现在的自研代码不会浪费，
> 通过"包成 MCP server"被复用；hermes-agent 负责它擅长的通用 agent 基建。
