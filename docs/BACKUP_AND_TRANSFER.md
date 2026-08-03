# CoCo 备份与迁移边界

## 1. 是否应该原样全量备份

不应把整个本地目录原样交给接收方。建议同时存在三种不同目的的备份：

| 类型 | 用途 | 内容 | 存放位置 |
|---|---|---|---|
| 安全源码包 | 开发、维护、进入 Git | 源码、lockfile、部署脚本、文档、历史设计 | 公司私有 Git 仓库 |
| 云端运行备份 | 灾难恢复 | VM 数据盘、GCS 对象、镜像版本、资源配置 | 公司 GCP 项目 |
| 个人应急冷备 | 交接过渡期兜底 | 原目录完整快照 | 公司批准的加密磁盘/加密存储，限时保留 |

“全量备份”只适合作为受控、加密、限时的冷备，不能作为日常源码交付物。

## 2. 安全源码包包含

- `apps/hermes`，排除 `node_modules` 和运行缓存。
- `deploy`、`scripts`、`docs`、`plans`。
- 根目录的 package 文件、配置模板、部署/扩展说明。
- Wix 脚本本身可以保留，但原始测试响应 JSON 不进入主代码包。

使用 `scripts/create-handover-package.ps1` 生成。脚本采用白名单，不会复制真实 `.env` 和 key JSON。

## 3. 禁止进入 Git 或普通 ZIP

- `.env`、`.env.test`、`.env.vm`。
- `hermes-deployer-key.json`、任何 `*-key.json`。
- `.mcp.json`（可能包含本地 MCP 配置或凭据）。
- `.claude/settings.local.json` 等个人工具配置。
- `node_modules`。
- 日志、构建输出、临时目录。
- 含真实用户/业务数据的 CSV 和 API 响应样本。

这些文件即便看起来为空，也不要以相同文件名进入仓库；需要示例时创建去值后的 `.example`。

## 4. 云端需要单独交接

源码 ZIP 不包含也不能代替以下资源：

- GCP 项目与 Billing。
- GCE VM、启动 metadata 和 `$HOME/hermes-data` 数据盘。
- Cloud Run `hermes-report` 服务及其 revision 配置。
- Cloud Scheduler `hermes-daily-report`。
- Artifact Registry 两类镜像。
- GCS bucket `furever-dock-hermes-retention`。
- IAM、服务账号及最小权限策略。
- 飞书、Amplitude、Stripe、Gemini/Google AI、GA4 后台权限。

## 5. 密钥迁移原则

密钥不是“备份代码”的一部分。目标状态是：

1. 接收团队拥有对应平台后台权限。
2. 新密钥存入 Secret Manager 或公司密码管理器。
3. Cloud Run/GCE 使用新密钥验证成功。
4. 撤销本地旧 key 和服务账号 JSON。
5. 删除过渡期中间文件。

不要在文档中记录真实密钥值，只记录变量名、用途、所有者、存放位置和最近轮换日期。

## 6. 当前本地审计结论

- 根目录 `.git` 为空，当前目录不是可用 Git 仓库；不能依赖已有版本历史。
- 两个 `node_modules` 合计占绝大多数文件，均可由 lockfile 重建。
- 根目录存在真实环境文件和服务账号 JSON，必须排除并在交接后轮换。
- 多个辅助脚本硬编码 `E:\hermes`、`C:\Users\QQ` 或 `/home/QQ`，不能作为接收方标准入口。
- `apps/hermes` 的 32 项现有自动化测试通过。

## 7. 冷备保留策略

在接收方完成独立部署以前，可以保留一份全量加密冷备。建议：

- 存在公司批准的加密存储，不使用个人网盘。
- 只允许交接负责人和接收技术负责人访问。
- 文件名标注日期和“含密钥”。
- 记录删除日期，建议验收后 30 天删除。
- 删除前确认所有密钥已经轮换，云端数据已经有公司侧备份。
