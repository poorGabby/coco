# CoCo 交接入口

本文是交接双方的统一入口。经理先看本页；接收开发人员再阅读文末链接的技术文档。

## 一句话结论

CoCo 不是“只有一台机器”，而是运行在 GCP 上的两层系统：GCE 上的 Hermes Agent 负责飞书对话，Cloud Run 上的自研 `apps/hermes` 负责数据、日报和 MCP 工具。机器可以继续运行已有镜像，但源代码、配置和部署脚本是后续恢复、修复和迭代所必需的。

## 当前交接状态

- [x] 飞书应用所有权已转移。
- [ ] 源码进入公司私有 Git 仓库。
- [ ] GCP 项目和 Billing 权限交给接收团队。
- [ ] 第三方平台后台权限完成转移。
- [ ] 密钥迁移到 Secret Manager 并轮换旧值。
- [ ] 接收方独立完成一次测试、部署、回滚和日报验收。
- [ ] 验收后撤销原交接人的个人权限和本地服务账号密钥。

## 交付物分三层

1. **源码包**：可以进入公司私有 Git 仓库，不含真实密钥和生成文件。
2. **云资源与运行数据**：通过 GCP IAM、VM 磁盘、GCS 和平台后台转移，不放入 Git。
3. **敏感信息**：通过 Secret Manager 或公司密码管理器交接，禁止通过聊天、邮件或源码压缩包发送。

不要把整个 `E:\hermes` 原样发送给接收方。原目录包含真实 `.env`、服务账号 JSON、本机依赖、日志和历史测试数据。

## 接收方建议阅读顺序

1. [系统功能与代码导读](docs/COCO_SYSTEM_GUIDE.md)
2. [备份与迁移边界](docs/BACKUP_AND_TRANSFER.md)
3. [运维与故障处理](docs/OPERATIONS_RUNBOOK.md)
4. [接收验收清单](docs/RECEIVER_ACCEPTANCE.md)

## 经理需要推动的事项

- 指定代码仓库所属的公司组织，以及至少两名维护者。
- 指定 GCP 项目、Billing、飞书、Amplitude、Stripe 和 Gemini 的业务负责人。
- 确认密钥不能由个人长期保管。
- 安排接收方在原交接人在场时独立完成一次生产部署演练。
- 验收通过前，不删除本机资料、不撤销现有权限、不重建线上资源。

## 源码安全打包

在 PowerShell 中运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\create-handover-package.ps1
```

脚本会在 `handover-output` 中生成源码 ZIP、文件清单和 SHA-256 校验值。生成后仍应先由开发人员抽查，再上传公司私有仓库。
