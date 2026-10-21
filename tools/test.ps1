# 跑全部自测（441 项）
param([switch]$Quiet)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$testDir = Join-Path $root "tests"

if (-not (Test-Path $testDir)) { throw "找不到测试目录: $testDir" }

$tests = Get-ChildItem "$testDir\verify-*.mjs" | Sort-Object Name
if ($tests.Count -eq 0) { throw "测试目录里没有 verify-*.mjs" }

$totalPass = 0
$totalFail = 0
$failedSuites = @()

foreach ($t in $tests) {
  $out = & node $t.FullName 2>&1
  $last = ($out | Select-Object -Last 1)
  if ($last -match '通过 (\d+) / 失败 (\d+)') {
    $totalPass += [int]$Matches[1]
    $totalFail += [int]$Matches[2]
    if ([int]$Matches[2] -gt 0) { $failedSuites += $t.Name }
  } else {
    $failedSuites += $t.Name
    $last = "执行异常"
  }
  if (-not $Quiet) {
    Write-Host ("{0,-34} {1}" -f $t.Name, $last)
  }
}

Write-Host ""
if ($totalFail -eq 0 -and $failedSuites.Count -eq 0) {
  Write-Host "全部通过：$totalPass 项 / $($tests.Count) 个套件" -ForegroundColor Green
  exit 0
} else {
  Write-Host "有失败：通过 $totalPass / 失败 $totalFail" -ForegroundColor Red
  $failedSuites | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
  exit 1
}
