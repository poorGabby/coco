# Hermes Furever Dock — Windows 部署入口
# 用法: powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
param(
    [ValidateSet("infra", "deploy", "logs", "status")]
    [string]$Action = "deploy"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
Set-Location $Root

$GcloudCandidates = @(
    "$env:ProgramFiles\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd",
    "${env:ProgramFiles(x86)}\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd",
    "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
)
$Gcloud = $GcloudCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
$Bash = "C:\Program Files\Git\bin\bash.exe"

function Require-Gcloud {
    if (-not $Gcloud) {
        Write-Host "未找到 gcloud。请先安装 Google Cloud SDK 并完成登录:" -ForegroundColor Yellow
        Write-Host "  winget install Google.CloudSDK"
        Write-Host "  gcloud auth login"
        Write-Host "  gcloud auth application-default login"
        exit 1
    }
    $env:Path = "$(Split-Path $Gcloud -Parent);$env:Path"
}

function Invoke-VmSsh {
    param([string]$Command)
    $KeyFile = Join-Path $Root "hermes-deployer-key.json"
    if (Test-Path $KeyFile) {
        & $Gcloud auth activate-service-account --key-file=$KeyFile | Out-Null
    }
    & $Gcloud compute ssh hermes-agent --zone=us-central1-a --command=$Command
}
function Require-Env {
    if (-not (Test-Path "$Root\.env")) {
        Write-Host "缺少 .env。请复制模板并填写密钥:" -ForegroundColor Yellow
        Write-Host "  copy .env.example .env"
        exit 1
    }
    $content = Get-Content "$Root\.env" -Raw
    foreach ($key in @("FEISHU_APP_ID", "FEISHU_APP_SECRET", "GEMINI_API_KEY", "API_SERVER_KEY")) {
        if ($content -notmatch "(?m)^${key}=.+$" -or $content -match "(?m)^${key}=\s*$") {
            Write-Host "请在 .env 中填写: $key" -ForegroundColor Yellow
            exit 1
        }
    }
}

if (-not (Test-Path $Bash)) {
    Write-Host "需要 Git Bash 来运行部署脚本: $Bash" -ForegroundColor Red
    exit 1
}

$env:GCP_PROJECT_ID = if ($env:GCP_PROJECT_ID) { $env:GCP_PROJECT_ID } else { "furever-dock-hermes-agent" }
Write-Host "GCP 项目: $env:GCP_PROJECT_ID"

switch ($Action) {
    "infra" {
        Require-Gcloud
        Require-Env
        & $Bash deploy/setup-gce.sh
    }
    "deploy" {
        Require-Gcloud
        Require-Env
        & $Bash scripts/deploy.sh
    }
    "logs" {
        Require-Gcloud
        Invoke-VmSsh "sudo docker logs --tail 80 furever-dock-hermes-agent"
    }
    "status" {
        Require-Gcloud
        Invoke-VmSsh "sudo docker ps -a --filter name=furever-dock-hermes-agent"
    }
}
