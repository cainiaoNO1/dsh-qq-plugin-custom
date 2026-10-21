# 手工合并冲突后，重新生成某个文件的补丁
#
# 用法:
#   .\tools\regen-patch.ps1 -File lib\runtime.js
#   .\tools\regen-patch.ps1 -File lib\runtime.js -BaseVersion 1.0.6
#
# 前提：build\ 里已经是"上游 + 手工合并后的正确内容"
param(
  [Parameter(Mandatory=$true)]
  [string]$File,
  [string]$BaseVersion = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$build = Join-Path $root "build"

if (-not (Test-Path $build)) { throw "找不到 build\ —— 先跑 .\tools\upgrade.ps1" }

# 自动推断基线版本：取 upstream\ 下最新的目录
if ($BaseVersion -eq "") {
  $dirs = Get-ChildItem (Join-Path $root "upstream") -Directory | Sort-Object Name -Descending
  if ($dirs.Count -eq 0) { throw "upstream\ 下没有基线版本" }
  $BaseVersion = $dirs[0].Name
  Write-Host "使用基线: $BaseVersion" -ForegroundColor DarkGray
}

$rel = $File -replace '\\','/'
$base = Join-Path $root "upstream\$BaseVersion"
$a = (Join-Path $base ($rel -replace '/','\'))
$b = (Join-Path $build ($rel -replace '/','\'))

if (-not (Test-Path $a)) { throw "基线里没有这个文件: $a" }
if (-not (Test-Path $b)) { throw "build 里没有这个文件: $b" }

# 文件名映射（与 apply.ps1 的编号一致）
$nameMap = @{
  'lib/runtime.js'       = '01-runtime.patch'
  'lib/router.js'        = '02-router.patch'
  'lib/stream-frame.js'  = '03-stream-frame.patch'
  'lib/settings.js'      = '04-settings.patch'
  'lib/state.js'         = '05-state.patch'
  'lib/session-index.js' = '06-session-index.patch'
  'client.js'            = '07-client.patch'
}
$patchName = $nameMap[$rel]
if ($null -eq $patchName) { throw "不认识这个文件（不在映射表里）: $rel" }

$aUrl = $a -replace '\\','/'
$bUrl = $b -replace '\\','/'
$out = git diff --no-index --no-color --unified=3 -- "$aUrl" "$bUrl" 2>&1
$body = ($out -join "`n") -replace "`r`n", "`n"
$body = $body -replace "(?m)^diff --git .*$", "diff --git a/$rel b/$rel"
$body = $body -replace "(?m)^--- .*$", "--- a/$rel"
$body = $body -replace "(?m)^\+\+\+ .*$", "+++ b/$rel"

$header = "# 基线: dsh-qq-plugin@$BaseVersion`n"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $root "patches\$patchName"), $header + $body + "`n", $utf8NoBom)

Write-Host "已重新生成 patches\$patchName" -ForegroundColor Green
Write-Host "基线: $BaseVersion"
Write-Host ""
Write-Host "验证一下：" -ForegroundColor Cyan
Write-Host "  .\tools\apply.ps1 -BaseVersion $BaseVersion"
Write-Host "  .\tools\test.ps1"
