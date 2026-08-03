# 修复飞书「返回数据不是合法的JSON格式」— 开放 Cloud Run 公网访问 + 预热
# 用法（PowerShell）:
#   cd E:\hermes
#   .\scripts\fix-feishu-callback.ps1

$ErrorActionPreference = "Stop"
$Project = "furever-dock-hermes-agent"
$Region = "us-central1"
$Service = "hermes-report"
$BaseUrl = "https://hermes-report-47392968747.us-central1.run.app"

Write-Host "==> 1. 开放 Cloud Run 公网访问 (allUsers invoker)..."
gcloud run services add-iam-policy-binding $Service `
  --project=$Project `
  --region=$Region `
  --member="allUsers" `
  --role="roles/run.invoker"

Write-Host ""
Write-Host "==> 2. 预热 /health ..."
try {
  $health = Invoke-RestMethod -Uri "$BaseUrl/health" -Method Get -TimeoutSec 30
  Write-Host "    health: $($health | ConvertTo-Json -Compress)"
} catch {
  Write-Warning "    /health 失败: $($_.Exception.Message)"
  Write-Host "    若仍 403，可能是组织策略禁止公网 Cloud Run，需 GCP 管理员放行。"
}

Write-Host ""
Write-Host "==> 3. 模拟飞书 url_verification ..."
$body = @{
  type      = "url_verification"
  challenge = "test-challenge-12345"
  token     = ""
} | ConvertTo-Json

try {
  $resp = Invoke-RestMethod -Uri "$BaseUrl/feishu/events" -Method Post `
    -ContentType "application/json; charset=utf-8" -Body $body -TimeoutSec 10
  Write-Host "    响应: $($resp | ConvertTo-Json -Compress)"
  if ($resp.challenge -eq "test-challenge-12345") {
    Write-Host "    OK — 飞书回调校验应可通过。"
  } else {
    Write-Warning "    challenge 未原样返回，请检查服务日志。"
  }
} catch {
  Write-Warning "    /feishu/events 失败: $($_.Exception.Message)"
}

Write-Host ""
Write-Host "==> 4. 飞书后台检查清单:"
Write-Host "    - 事件订阅方式: 将事件发送至开发者服务器 (HTTP)"
Write-Host "    - 请求地址: $BaseUrl/feishu/events"
Write-Host "    - 若开启了 Encrypt Key: 把密钥填到 .env 的 FEISHU_ENCRYPT_KEY 并重新部署"
Write-Host "    - 订阅事件: im.message.receive_v1"
