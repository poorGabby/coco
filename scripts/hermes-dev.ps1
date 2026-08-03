# Hermes daily report - local test helper
# Usage:
#   powershell -ExecutionPolicy Bypass -File "e:\hermes\scripts\hermes-dev.ps1" -Action test
param(
    [ValidateSet("install", "test", "report", "ask", "dev", "daily")]
    [string]$Action = "report"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
$AppDir = Join-Path $Root "apps\hermes"

$nodeDir = "$env:ProgramFiles\nodejs"
if (Test-Path $nodeDir) {
    $env:Path = "$nodeDir;$env:Path"
}

Write-Host "==> Hermes dev: action=$Action"
Write-Host "    root=$Root"
Write-Host "    app =$AppDir"

if (-not (Test-Path $AppDir)) {
    Write-Host "ERROR: app dir not found: $AppDir" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path "$Root\.env")) {
    Write-Host "ERROR: .env not found: $Root\.env" -ForegroundColor Red
    exit 1
}

Set-Location $AppDir

if (-not (Test-Path "node_modules")) {
    Write-Host "==> npm install (first run)..."
    npm install
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if ($Action -eq "install") {
    npm install
}
elseif ($Action -eq "test") {
    Write-Host "==> Amplitude chart fetch test..."
    npm run test:amplitude
}
elseif ($Action -eq "report") {
    Write-Host "==> Generate daily report..."
    npm run report
}
elseif ($Action -eq "ask") {
    $q = $args -join " "
    if (-not $q) { $q = "昨天 DAU 为什么跌了？" }
    Write-Host "==> Ask: $q"
    npm run ask -- $q
}
elseif ($Action -eq "dev") {
    Write-Host "==> Server: http://127.0.0.1:8787/hermes/report"
    npm run dev
}
elseif ($Action -eq "daily") {
    $secret = (Get-Content "$Root\.env" | Where-Object { $_ -match '^HERMES_CRON_SECRET=' }) -replace '^HERMES_CRON_SECRET=',''
    if (-not $secret) {
        Write-Host "ERROR: set HERMES_CRON_SECRET in .env" -ForegroundColor Red
        exit 1
    }
    Invoke-RestMethod -Uri "http://127.0.0.1:8787/hermes/daily" -Method POST -Headers @{ "X-Cron-Secret" = $secret }
}

if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: command failed (exit $LASTEXITCODE)" -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host "==> Done ($Action)" -ForegroundColor Green
