---
name: furever-daily-report
description: Push Furever Dock official Feishu interactive daily card (collapsible alerts/watches) via MCP build + VM send.
version: 3.0.0
author: Furever Dock
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [FureverDock, CoCo, daily-report, Feishu-card]
---

# Furever Dock 数据日报（飞书 interactive 卡片）

目标：发出**真正的飞书卡片**（蓝头、可折叠核心指标/警报/关注/假设），不是 Markdown 长文。

## 主路径（必须）

1. 目标会话：
   - **定时任务默认**：机器人已加入的**全部飞书群**（自动发现，不含私聊）
   - 手动指定：`bash /opt/data/bin/push-daily-card-all.sh <chat_id> [chat_id...]`
2. 在终端执行（定时 cron 已配置为）：

```bash
bash /opt/data/scripts/push-furever-daily-card.sh
```

等价于：

```bash
bash /opt/data/bin/push-daily-card-all.sh --all-groups
```

3. 成功后，**只回复一句**：已向所在群发送飞书 interactive 日报卡片（含可折叠警报/关注）。  
   **禁止**再粘贴 Markdown 日报正文冒充卡片。

## 失败降级

若脚本失败，简短说明错误；可用 MCP 工具逐个取数后输出精简 Markdown 表（DAU / New Users / Purchase Users / Revenue + DoD），并注明「卡片发送失败，以下为降级文本」。

## 禁止

- 禁止用长 Markdown「假装卡片视图」
- 禁止传 startDate/endDate 给取数工具（除非用户明确历史区间）
- 禁止从 Cloud Run 直接发飞书消息（发卡只走 VM 脚本）
