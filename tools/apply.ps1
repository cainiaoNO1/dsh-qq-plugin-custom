# 把补丁应用到指定目录（默认 upstream/<基线版本>）
#
# 用法:
#   .\tools\apply.ps1                      # 应用到 upstream/1.0.3，输出到 build/
#   .\tools\apply.ps1 -Target C:\some\dir  # 应用到指定目录
#   .\tools\apply.ps1 -Skip 09,11          # 跳过指定编号的补丁
param(
  [string]$BaseVersion = "1.0.3",
  [string]$Target = "",
  [int[]]$Skip = @(),
  [switch]$InPlace
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

# ---- 定位目标目录 ----
if ($Target -eq "") {
  $src = Join-Path $root "upstream\$BaseVersion"
  if (-not (Test-Path $src)) { throw "找不到上游基线: $src" }
  $Target = Join-Path $root "build"
  if (Test-Path $Target) { Remove-Item $Target -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $Target | Out-Null
  Copy-Item "$src\*" $Target -Recurse -Force
  Write-Host "已复制上游 $BaseVersion 到 build\" -ForegroundColor Cyan
} elseif (-not $InPlace) {
  throw "指定了 -Target 时请加 -InPlace 确认原地修改"
}

if (-not (Test-Path (Join-Path $Target "package.json"))) {
  throw "目标目录不像 dsh-qq-plugin: $Target"
}

# ---- 应用补丁 ----
Push-Location $Target
try {
  # 关键：禁用行尾转换。否则 Windows 上 apply 出来的文件是 CRLF，
  # 与上游逐字节不同，后续校验全部"看起来冲突"。
  #
  # 用环境变量而不是 `git config`：build\ 不是 git 仓库，
  # `git config` 会以 "fatal: not in a git directory" 失败并中断脚本。
  $env:GIT_CONFIG_COUNT = "1"
  $env:GIT_CONFIG_KEY_0 = "core.autocrlf"
  $env:GIT_CONFIG_VALUE_0 = "false"

  $patches = Get-ChildItem (Join-Path $root "patches\*.patch") | Sort-Object Name
  $applied = 0
  $failed = @()

  foreach ($p in $patches) {
    $num = [int]($p.Name -split '-')[0]
    if ($Skip -contains $num) {
      Write-Host "SKIP $($p.Name)" -ForegroundColor DarkGray
      continue
    }

    $check = git apply --check $p.FullName 2>&1
    if ($LASTEXITCODE -ne 0) {
      Write-Host "FAIL $($p.Name)" -ForegroundColor Red
      $failed += $p.Name
      continue
    }
    git apply $p.FullName
    if ($LASTEXITCODE -eq 0) {
      Write-Host "OK   $($p.Name)" -ForegroundColor Green
      $applied++
    } else {
      $failed += $p.Name
    }
  }

  # ---- 新增文件 ----
  $newFile = Join-Path $root "patches\08-plain-text.new.js"
  if (Test-Path $newFile) {
    Copy-Item $newFile (Join-Path $Target "lib\plain-text.js") -Force
    Write-Host "OK   plain-text.js（新增文件）" -ForegroundColor Green
  }
} finally {
  Pop-Location
}

Write-Host ""
if ($failed.Count -eq 0) {
  Write-Host "全部补丁应用成功（$applied 个）" -ForegroundColor Green
  Write-Host "输出目录: $Target"
} else {
  Write-Host "有 $($failed.Count) 个补丁冲突:" -ForegroundColor Yellow
  $failed | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
  Write-Host ""
  Write-Host "这些需要手工合并。详见 docs/UPGRADE.md 第三节。" -ForegroundColor Yellow
  exit 1
}
