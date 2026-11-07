# M1 acceptance (L5). Run in PowerShell:  powershell -ExecutionPolicy Bypass -File acceptance\M1.ps1
# كل خطوة بتطبع PASS أو FAIL. النتيجة المطلوبة: كل الخطوات PASS.
$ErrorActionPreference = 'Stop'
$pnpm = Join-Path $env:USERPROFILE '.local\c2c-tools\pnpm.CMD'
if (-not (Test-Path $pnpm)) { $pnpm = 'pnpm' }
$dir = Join-Path $env:TEMP 'factory-m1-acceptance'
$results = @()
function Step($n, $label, [scriptblock]$cmd) {
  Write-Host "`n[$n] $label" -ForegroundColor Cyan
  & $cmd
  $ok = $LASTEXITCODE -eq 0
  $script:results += [pscustomobject]@{ Step = $n; Check = $label; Result = $(if ($ok) { 'PASS' } else { 'FAIL' }) }
  if (-not $ok) { Write-Host "FAIL" -ForegroundColor Red } else { Write-Host "PASS" -ForegroundColor Green }
}

# 1) نسخة Node: لازم تبدأ بـ v24 أو v26
Step 1 'Node version is 24 or 26' { $v = node -v; Write-Host $v; if ($v -match '^v(24|26)\.') { $global:LASTEXITCODE = 0 } else { $global:LASTEXITCODE = 1 } }
# 2) نسخة جديدة من GitHub: لازم تتعمل من غير أخطاء
Step 2 'Fresh clone from GitHub' { if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }; git clone -q https://github.com/ahmedeltataw/factory.git $dir }
Set-Location $dir
# 3) التثبيت لازم يخلص من غير ما يغيّر ملف القفل
Step 3 'Install with frozen lockfile' { & $pnpm install --frozen-lockfile }
# 4) فحص الأنواع: مفيش أخطاء
Step 4 'Typecheck' { & $pnpm typecheck }
# 5) الاختبارات: كلها passed ومفيش failed (حوالي 252 اختبار)
Step 5 'All tests' { & $pnpm test }
# 6) البناء
Step 6 'Build' { & $pnpm build }
# 7) كل ملف منقول من dsh مطابق لبصمته
Step 7 'Manifest: ported files match dsh' { node scripts/check-manifest.mjs }
# 8) مفيش أي حاجة من DeepSeek أو Feishu
Step 8 'No forbidden imports' { node scripts/check-forbidden-imports.mjs }
# 9) كل شرط في كل كارت له دليل نجاح
Step 9 'Every DoD check has passing evidence' { node scripts/check-traceability.mjs --all }

Write-Host "`n===== M1 acceptance =====" -ForegroundColor Yellow
$results | Format-Table -AutoSize
if ($results.Result -contains 'FAIL') { Write-Host 'M1: FAIL' -ForegroundColor Red; exit 1 } else { Write-Host 'M1: PASS' -ForegroundColor Green; exit 0 }
