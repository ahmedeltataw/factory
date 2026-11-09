# M1 acceptance (L5). Run in PowerShell:  powershell -ExecutionPolicy Bypass -File acceptance\M1.ps1
# كل خطوة بتطبع PASS أو FAIL. النتيجة المطلوبة: كل الخطوات PASS.
param(
  [string]$Source = 'https://github.com/ahmedeltataw/factory.git'
)

$ErrorActionPreference = 'Stop'
$pnpm = Join-Path $env:USERPROFILE '.local\c2c-tools\pnpm.CMD'
if (-not (Test-Path $pnpm)) { $pnpm = 'pnpm' }

# Unique, owned clone destination under TEMP for this run only.
# Never delete, reuse, or automatically clean up a pre-existing path.
$guid = [guid]::NewGuid()
$dest = Join-Path $env:TEMP ("factory-m1-acceptance-" + $guid)
if (Test-Path $dest) {
  Write-Host "Destination already exists and will not be reused: $dest" -ForegroundColor Red
  exit 1
}
Write-Host "Clone destination: $dest"

$results = @()
$script:stepOk = $false
function Step($n, $label, [scriptblock]$cmd) {
  Write-Host "`n[$n] $label" -ForegroundColor Cyan
  # Failure default: assume FAIL until the command's exit code proves success.
  $script:stepOk = $false
  # Run the command and surface its stdout, but never let it leave this
  # function as output (else nonempty stdout reads as truthy on failure).
  $out = & $cmd
  $code = $LASTEXITCODE
  foreach ($line in $out) { Write-Host $line }
  # Explicitly derive success from the command's actual exit code.
  $script:stepOk = $code -eq 0
  $ok = $script:stepOk
  $script:results += [pscustomobject]@{ Step = $n; Check = $label; Result = if ($ok) { 'PASS' } else { 'FAIL' } }
  if ($ok) { Write-Host 'PASS' -ForegroundColor Green } else { Write-Host 'FAIL' -ForegroundColor Red }
  return $ok
}
function Show-Fail {
  Write-Host "`n===== M1 acceptance =====" -ForegroundColor Yellow
  $results | Format-Table -AutoSize
  Write-Host 'M1: FAIL' -ForegroundColor Red
  exit 1
}

# 1) نسخة Node: لازم تبدأ بـ v24 أو v26
if (-not (Step 1 'Node version is 24 or 26' {
  $v = node -v
  $code = $LASTEXITCODE
  Write-Host "Node version: $v"
  if ($code -eq 0 -and $v -match '^v(24|26)\.') { $global:LASTEXITCODE = 0 } else { $global:LASTEXITCODE = 1 }
})) { Show-Fail }

# 2) نسخة جديدة من GitHub: لازم تتعمل من غير أخطاء
# Source is passed as data to git clone, never as shell code. `--` prevents option injection.
if (-not (Step 2 'Fresh clone from GitHub' {
  & git clone -q -- $Source $dest
})) { Show-Fail }

Set-Location $dest

# 3) التثبيت لازم يخلص من غير ما يغيّر ملف القفل
if (-not (Step 3 'Install with frozen lockfile' { & $pnpm install --frozen-lockfile })) { Show-Fail }
# 4) فحص الأنواع: مفيش أخطاء
if (-not (Step 4 'Typecheck' { & $pnpm typecheck })) { Show-Fail }
# 5) الاختبارات: كلها passed ومفيش failed (حوالي 252 اختبار)
if (-not (Step 5 'All tests' { & $pnpm test })) { Show-Fail }
# 6) البناء
if (-not (Step 6 'Build' { & $pnpm build })) { Show-Fail }
# 7) كل ملف منقول من dsh مطابق لبصمته
if (-not (Step 7 'Manifest: ported files match dsh' { node scripts/check-manifest.mjs })) { Show-Fail }
# 8) مفيش أي حاجة من DeepSeek أو Feishu
if (-not (Step 8 'No forbidden imports' { node scripts/check-forbidden-imports.mjs })) { Show-Fail }
# 9) كل شرط في كل كارت له دليل نجاح
if (-not (Step 9 'Every DoD check has passing evidence' { node scripts/check-traceability.mjs --all --require-passing --card-prefix M1- })) { Show-Fail }

Write-Host "`n===== M1 acceptance =====" -ForegroundColor Yellow
$results | Format-Table -AutoSize
if ($results.Result -contains 'FAIL') { Write-Host 'M1: FAIL' -ForegroundColor Red; exit 1 } else { Write-Host 'M1: PASS' -ForegroundColor Green; exit 0 }
