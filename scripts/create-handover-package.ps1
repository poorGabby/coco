param(
  [string]$OutputRoot = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputRoot) {
  $OutputRoot = Join-Path $projectRoot "handover-output"
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$stage = Join-Path $OutputRoot "coco-source-$stamp"
$zip = "$stage.zip"

New-Item -ItemType Directory -Path $stage -Force | Out-Null

$rootFiles = @(
  ".env.example",
  ".gitignore",
  "package.json",
  "package-lock.json",
  "README.md",
  "HANDOVER.md",
  "HERMES_DEPLOYMENT_GUIDE.md",
  "HERMES_EXPANSION_PLAN.md",
  "COLLEAGUE_DEPLOY_HANDOVER.md",
  "FureverDock_Hermes Agent.md",
  "wix-velo-code.js"
)

foreach ($name in $rootFiles) {
  $source = Join-Path $projectRoot $name
  if (Test-Path -LiteralPath $source) {
    Copy-Item -LiteralPath $source -Destination $stage
  }
}

$dirs = @("apps", "deploy", "docs", "plans", "scripts")
foreach ($name in $dirs) {
  $source = Join-Path $projectRoot $name
  $destination = Join-Path $stage $name
  New-Item -ItemType Directory -Path $destination -Force | Out-Null

  $arguments = @(
    $source,
    $destination,
    "/E",
    "/XD", "node_modules", ".git", ".tmp", "tmp", "handover-output",
    "/XF", ".env", ".env.test", ".env.vm", ".env.production", "*-key.json", "*.log",
    "retention-cache.json", "_fetched-*", "deploy-output.txt", "build-output.txt", "ask-output.txt",
    "/NFL", "/NDL", "/NJH", "/NJS", "/NP"
  )
  & robocopy @arguments | Out-Null
  if ($LASTEXITCODE -ge 8) {
    throw "robocopy failed for $name with exit code $LASTEXITCODE"
  }
}

# Defense in depth: detect current sensitive values even when they were
# accidentally embedded in an otherwise allowed source or document. Remove
# the affected file from the package without ever printing the value.
$sensitiveNames = @(
  "AMPLITUDE_API_KEY", "AMPLITUDE_SECRET_KEY", "GEMINI_API_KEY", "STRIPE_API_KEY",
  "FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_VERIFICATION_TOKEN", "FEISHU_ENCRYPT_KEY",
  "FEISHU_BOT_OPEN_ID", "FEISHU_REPORT_CHAT_ID", "FEISHU_WIKI_INDEX_DOC_TOKEN",
  "FEISHU_COCO_BEHAVIOR_DOC_TOKEN", "FEISHU_COCO_ANALYSIS_DOC_TOKEN", "FEISHU_COCO_SKILL_DOC_TOKEN",
  "COCO_MCP_KEY", "HERMES_CRON_SECRET", "API_SERVER_KEY", "WIX_API_KEY",
  "GOOGLE_SERVICE_ACCOUNT_JSON"
)
$secretValues = @{}
$localEnv = Join-Path $projectRoot ".env"
if (Test-Path -LiteralPath $localEnv) {
  Get-Content -LiteralPath $localEnv | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') {
      $name = $matches[1]
      $value = $matches[2].Trim().Trim('"').Trim("'")
      if ($sensitiveNames -contains $name -and $value.Length -ge 6) {
        $secretValues[$name] = $value
      }
    }
  }
}

$removed = @()
Get-ChildItem -LiteralPath $stage -Recurse -File | ForEach-Object {
  $file = $_
  $content = $null
  try { $content = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction Stop } catch { }
  if ($null -eq $content) { return }
  $matchedNames = @($secretValues.Keys | Where-Object { $content.Contains($secretValues[$_]) })
  if ($matchedNames.Count -gt 0) {
    $removed += "$($file.FullName.Substring($stage.Length + 1))  [$($matchedNames -join ', ')]"
    Remove-Item -LiteralPath $file.FullName -Force
  }
}
if ($removed.Count -gt 0) {
  $removed | Sort-Object | Set-Content -LiteralPath (Join-Path $stage "EXCLUDED_SENSITIVE_FILES.txt") -Encoding utf8
}

$manifestPath = Join-Path $stage "SOURCE_MANIFEST.sha256"
Get-ChildItem -LiteralPath $stage -Recurse -File |
  Where-Object { $_.FullName -ne $manifestPath } |
  Sort-Object FullName |
  ForEach-Object {
    $relative = $_.FullName.Substring($stage.Length + 1)
    $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $relative"
  } | Set-Content -LiteralPath $manifestPath -Encoding utf8

Compress-Archive -LiteralPath $stage -DestinationPath $zip -CompressionLevel Optimal
$zipHash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
$zipHash | Set-Content -LiteralPath "$zip.sha256" -Encoding ascii

Write-Host "Safe source package created:"
Write-Host "  $zip"
Write-Host "SHA-256:"
Write-Host "  $zipHash"
Write-Host ""
Write-Host "Real .env files, key JSON, node_modules, logs, caches and raw data exports were excluded."
