# 上游更新后：拉新版 → 尝试套用补丁 → 报告冲突
#
# 用法:
#   .\tools\upgrade.ps1 -NewVersion 1.0.6
#   .\tools\upgrade.ps1 -NewVersion 1.0.6 -FromGit https://github.com/xcisxc29/dsh-qq-plugin
param(
  [Parameter(Mandatory=$true)]
  [string]$NewVersion,
  [string]$FromGit = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$upDir = Join-Path $root "upstream\$NewVersion"

# ---- 1. 拉取新版 ----
if (Test-Path $upDir) {
  Write-Host "上游 $NewVersion 已存在，跳过下载" -ForegroundColor DarkGray
} else {
  Write-Host "拉取 dsh-qq-plugin@$NewVersion ..." -ForegroundColor Cyan
  $tmp = Join-Path $env:TEMP "upstream-pull-$NewVersion"
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null

  Push-Location $tmp
  try {
    if ($FromGit -ne "") {
      git clone --depth 1 --branch $NewVersion $FromGit src 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) {
        git clone --depth 1 $FromGit src 2>&1 | Out-Null
      }
      New-Item -ItemType Directory -Force -Path $upDir | Out-Null
      Copy-Item "$tmp\src\*" $upDir -Recurse -Force -Exclude ".git"
    } else {
      npm pack "dsh-qq-plugin@$NewVersion" --silent 2>&1 | Out-Null
      $tgz = Get-ChildItem "$tmp\*.tgz" | Select-Object -First 1
      if ($null -eq $tgz) { throw "npm pack 失败，检查版本号 $NewVersion 是否存在" }
      tar -xzf $tgz.FullName
      New-Item -ItemType Directory -Force -Path $upDir | Out-Null
      Copy-Item "$tmp\package\*" $upDir -Recurse -Force
    }
  } finally {
    Pop-Location
  }
  Write-Host "已保存到 upstream\$NewVersion" -ForegroundColor Green
}

# ---- 2. 在副本上尝试套用 ----
$trial = Join-Path $root "build"
if (Test-Path $trial) { Remove-Item $trial -Recurse -Force }
Copy-Item $upDir $trial -Recurse -Force

Push-Location $trial
try {
  git init --quiet 2>$null
  git config core.autocrlf false 2>$null
  git config core.eol lf 2>$null

  $ok = @()
  $conflict = @()
  foreach ($p in (Get-ChildItem (Join-Path $root "patches\*.patch") | Sort-Object Name)) {
    $chk = git apply --check $p.FullName 2>&1
    if ($LASTEXITCODE -eq 0) {
      git apply $p.FullName
      $ok += $p.Name
      Write-Host "OK   $($p.Name)" -ForegroundColor Green
    } else {
      $conflict += $p
      Write-Host "冲突 $($p.Name)" -ForegroundColor Yellow
    }
  }
  Copy-Item (Join-Path $root "patches\08-plain-text.new.js") "$trial\lib\plain-text.js" -Force -ErrorAction SilentlyContinue
} finally {
  Pop-Location
}

# ---- 3. 报告 ----
Write-Host ""
Write-Host "===== 结果 =====" -ForegroundColor Cyan
Write-Host "干净应用: $($ok.Count) 个"

if ($conflict.Count -eq 0) {
  Write-Host "全部补丁应用成功。" -ForegroundColor Green
  Write-Host ""
  Write-Host "下一步："
  Write-Host "  1. .\tools\test.ps1"
  Write-Host "  2. .\tools\deploy.ps1"
  Write-Host "  3. 重启 dsh web"
  Write-Host "  4. 更新 docs\CHANGES.md 里的基线版本号"
} else {
  Write-Host ""
  Write-Host "需要手工处理 $($conflict.Count) 个补丁:" -ForegroundColor Yellow
  $conflictDir = Join-Path $root "conflicts"
  New-Item -ItemType Directory -Force -Path $conflictDir | Out-Null
  foreach ($c in $conflict) {
    Write-Host "  $($c.Name)" -ForegroundColor Yellow
    Copy-Item $c.FullName (Join-Path $conflictDir $c.Name) -Force
  }
  Write-Host ""
  Write-Host "冲突补丁已复制到 conflicts\"
  Write-Host "处理办法见 docs\UPGRADE.md 第三节。"
  Write-Host ""
  Write-Host "提示：冲突通常意味着上游改了同一个函数。"
  Write-Host "      打开 build\ 里对应文件，手工把改造逻辑重新加进去，"
  Write-Host "      然后跑 .\tools\regen-patch.ps1 -File lib\runtime.js 重新生成补丁。"
}
