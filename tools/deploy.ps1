# 把当前仓库的自用改造版代码部署到 DSH 插件目录
#
# 用法:
#   .\tools\deploy.ps1                # 部署到插件目录
#   .\tools\deploy.ps1 -DryRun        # 仅预览会改哪些文件
param(
  [string]$Profile = "web",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$srcRoot = $root

$dest = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile\node_modules\dsh-qq-plugin"
if (-not (Test-Path $dest)) {
  throw "找不到插件目录: $dest"
}

Write-Host "源:      $srcRoot"
Write-Host "目标:    $dest"
Write-Host ""

# ---- 先备份 ----
$backup = Join-Path $env:USERPROFILE ".dsh\dsh-qq-plugin-patch-backup"
New-Item -ItemType Directory -Force -Path $backup | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

foreach ($f in @("client.js","lib\runtime.js","lib\router.js","lib\stream-frame.js",
                 "lib\settings.js","lib\state.js","lib\session-index.js","lib\plain-text.js")) {
  $src = Join-Path $srcRoot ($f -replace '/','\')
  $dst = Join-Path $dest ($f -replace '/','\')
  if (-not (Test-Path $src)) { Write-Host "跳过（源缺失）: $f" -ForegroundColor DarkGray; continue }

  if ($DryRun) {
    $same = (Test-Path $dst) -and ((Get-FileHash $src).Hash -eq (Get-FileHash $dst).Hash)
    Write-Host "$(if ($same) { '相同' } else { '将更新' })  $f"
    continue
  }

  # 备份现有文件（带时间戳）
  if (Test-Path $dst) {
    $bak = Join-Path $backup ("$($stamp)-" + ($f -replace '[\\/]','-') + ".bak")
    Copy-Item $dst $bak -Force
  }
  Copy-Item $src $dst -Force
  Write-Host "已更新 $f" -ForegroundColor Green
}
  Write-Host "已更新 $f" -ForegroundColor Green
}

if ($DryRun) {
  Write-Host ""
  Write-Host "（这是 DryRun，什么都没改）" -ForegroundColor Yellow
  exit 0
}

Write-Host ""
Write-Host "部署完成。备份在: $backup" -ForegroundColor Cyan
Write-Host ""
Write-Host "下一步：重启 dsh web 让改动生效。" -ForegroundColor Yellow
Write-Host "  Get-NetTCPConnection -LocalPort 3080 -State Listen |"
Write-Host "    ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force }"
