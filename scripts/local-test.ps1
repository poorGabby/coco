# Hermes 日报服务 — 本地开发与验证
# （Amplitude Chart Export API，不走 MCP / OAuth）

见 `scripts/hermes-dev.ps1`：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/hermes-dev.ps1 install
powershell -ExecutionPolicy Bypass -File scripts/hermes-dev.ps1 test      # 测各 Chart 拉数
powershell -ExecutionPolicy Bypass -File scripts/hermes-dev.ps1 report    # 生成日报 Markdown
powershell -ExecutionPolicy Bypass -File scripts/hermes-dev.ps1 dev       # 启动 HTTP 服务
```

服务代码在 `apps/hermes/`，与 `deploy/` 下的 GCE Gateway 部署无关。
