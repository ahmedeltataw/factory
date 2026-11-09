# M2 acceptance (L5). Run in PowerShell:  powershell -ExecutionPolicy Bypass -File acceptance\M2.ps1
# كل خطوة بتطبع PASS أو FAIL. النتيجة المطلوبة: كل الخطوات PASS.
param(
  [string]$Source = 'https://github.com/ahmedeltataw/factory.git'
)

$origConsoleEncoding = $null
$script:holderProcess = $null
$script:overallFailed = $false
$script:failureReason = $null
$results = @()
$script:stepOk = $false
$dest = $null
$stateDir = $null
$origLocation = $null
$releaseMarker = $null

function Remove-AcceptanceTempDir([string]$dir) {
  if ([string]::IsNullOrWhiteSpace($dir)) { return }
  if (-not (Test-Path -LiteralPath $dir)) { return }
  $expectedBase = Join-Path $env:TEMP 'factory-m2-acceptance'
  $fullExpected = [System.IO.Path]::GetFullPath($expectedBase).TrimEnd([char[]]@('\', '/'))
  $fullDir = [System.IO.Path]::GetFullPath($dir).TrimEnd([char[]]@('\', '/'))
  if ($fullDir -ne $fullExpected -and -not $fullDir.StartsWith($fullExpected + '\', [System.StringComparison]::OrdinalIgnoreCase) -and -not $fullDir.StartsWith($fullExpected + '/', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Safety error: refused to delete path outside ${expectedBase}: $dir"
  }

  $timeoutSec = 10
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ((Test-Path -LiteralPath $dir) -and $sw.Elapsed.TotalSeconds -lt $timeoutSec) {
    try {
      Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction Stop
    } catch {
      Start-Sleep -Milliseconds 200
    }
  }
  [void]$sw.Stop()

  if (Test-Path -LiteralPath $dir) {
    throw "Cleanup error: failed to remove temporary directory within timeout: $dir"
  }
}

function Stop-HolderProcess {
  if ($null -eq $script:holderProcess) { return }

  # Signal release-marker fallback in case the holder process is awaiting it
  if ($releaseMarker -and -not (Test-Path -LiteralPath $releaseMarker)) {
    try { Set-Content -LiteralPath $releaseMarker -Value 'release' -ErrorAction SilentlyContinue } catch {}
  }

  $timeoutSec = 5
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while (-not $script:holderProcess.HasExited -and $sw.Elapsed.TotalSeconds -lt $timeoutSec) {
    Start-Sleep -Milliseconds 100
  }
  [void]$sw.Stop()

  # Bounded termination retries
  $retries = 5
  while (-not $script:holderProcess.HasExited -and $retries -gt 0) {
    try {
      $script:holderProcess.Kill()
    } catch {
    }
    [void]$script:holderProcess.WaitForExit(1000)
    $retries--
  }

  # Verify exit before proceeding
  $isStillRunning = $false
  try {
    if (-not $script:holderProcess.HasExited) {
      $isStillRunning = $true
    }
  } catch {
    try {
      $p = Get-Process -Id $script:holderProcess.Id -ErrorAction SilentlyContinue
      if ($null -ne $p -and -not $p.HasExited) {
        $isStillRunning = $true
      }
    } catch {
    }
  }

  if ($isStillRunning) {
    throw "Process cleanup error: holder process (PID $($script:holderProcess.Id)) could not be confirmed terminated"
  }
}

function Step($n, $label, [scriptblock]$cmd) {
  Write-Host "`n[$n] $label" -ForegroundColor Cyan
  # Failure default: assume FAIL until the command's exit code proves success.
  $script:stepOk = $false
  try {
    # Run the command and surface its stdout, but never let it leave this
    # function as output (else nonempty stdout reads as truthy on failure).
    $out = & $cmd
    $code = $LASTEXITCODE
    foreach ($line in $out) { Write-Host $line }
    # Explicitly derive success from the command's actual exit code.
    $script:stepOk = $code -eq 0
  } catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    $script:stepOk = $false
  }
  $ok = $script:stepOk
  $script:results += [pscustomobject]@{ Step = $n; Check = $label; Result = if ($ok) { 'PASS' } else { 'FAIL' } }
  if ($ok) { Write-Host 'PASS' -ForegroundColor Green } else { Write-Host 'FAIL' -ForegroundColor Red }
  if (-not $ok) {
    $script:overallFailed = $true
  }
  return $ok
}

try {
  $origConsoleEncoding = [Console]::OutputEncoding
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8

  $ErrorActionPreference = 'Stop'

  if ([string]::IsNullOrWhiteSpace($env:TEMP)) {
    throw 'TEMP environment variable is not set'
  }

  $origLocation = $PWD.Path
  $dest = Join-Path $env:TEMP 'factory-m2-acceptance'
  $stateDir = Join-Path $dest 'temp-state'
  $releaseMarker = Join-Path $stateDir 'lease.release'

  $pnpm = if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
    Join-Path $env:USERPROFILE '.local\c2c-tools\pnpm.CMD'
  } else { 'pnpm' }
  if (-not (Test-Path $pnpm)) { $pnpm = 'pnpm' }

  # Clean up any stale directory from a previous aborted run within %TEMP%\factory-m2-acceptance only
  try {
    Remove-AcceptanceTempDir $dest
  } catch {
    Write-Host "Warning during pre-run cleanup: $_"
  }

  Write-Host "Clone destination: $dest"

  # 1) نسخة Node: لازم تبدأ بـ v24 أو v26
  if (-not (Step 1 'Node version is 24 or 26' {
    $v = node -v
    $code = $LASTEXITCODE
    Write-Host "Node version: $v"
    if ($code -eq 0 -and $v -match '^v(24|26)\.') { $global:LASTEXITCODE = 0 } else { $global:LASTEXITCODE = 1 }
  })) { throw 'Step 1 failed' }

  # 2) نسخة جديدة من GitHub: لازم تتعمل من غير أخطاء
  # Source is passed as data to git clone, never as shell code. `--` prevents option injection.
  if (-not (Step 2 'Fresh clone from GitHub' {
    & git clone -q -- $Source $dest
  })) { throw 'Step 2 failed' }

  Set-Location $dest

  # 3) التثبيت لازم يخلص من غير ما يغيّر ملف القفل
  if (-not (Step 3 'Install with frozen lockfile' { & $pnpm install --frozen-lockfile })) { throw 'Step 3 failed' }
  # 4) فحص الأنواع: مفيش أخطاء
  if (-not (Step 4 'Typecheck' { & $pnpm typecheck })) { throw 'Step 4 failed' }
  # 5) الاختبارات: كلها passed ومفيش failed
  if (-not (Step 5 'All tests' { & $pnpm test })) { throw 'Step 5 failed' }
  # 6) البناء
  if (-not (Step 6 'Build' { & $pnpm build })) { throw 'Step 6 failed' }
  # 7) كل ملف منقول من dsh مطابق لبصمته
  if (-not (Step 7 'Manifest: ported files match dsh' { node scripts/check-manifest.mjs })) { throw 'Step 7 failed' }
  # 8) مفيش أي حاجة من DeepSeek أو Feishu
  if (-not (Step 8 'No forbidden imports' { node scripts/check-forbidden-imports.mjs })) { throw 'Step 8 failed' }
  # 9) كل شرط في كل كارت له دليل نجاح
  if (-not (Step 9 'Every DoD check has passing evidence' { node scripts/check-traceability.mjs --all --require-passing })) { throw 'Step 9 failed' }

  $heldMarker = Join-Path $stateDir 'lease.held'

  $holderOutLog = Join-Path $stateDir 'holder.out.log'
  $holderErrLog = Join-Path $stateDir 'holder.err.log'
  $holderScript = Join-Path $stateDir 'holder.mjs'
  $acquireScript = Join-Path $stateDir 'acquire-second.mjs'

  $utf8NoBom = New-Object System.Text.UTF8Encoding $false

  # Pass paths via environment variables; keep generated JavaScript static
  $env:FACTORY_REPO = $dest
  $env:FACTORY_STATE = $stateDir
  $env:FACTORY_DB = Join-Path $stateDir 'state.sqlite'
  $env:FACTORY_HELD = $heldMarker
  $env:FACTORY_RELEASE = $releaseMarker

  $holderCode = @'
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const repo = process.env.FACTORY_REPO;
const stateDir = process.env.FACTORY_STATE;
const dbPath = process.env.FACTORY_DB;
const heldMarker = process.env.FACTORY_HELD;
const releaseMarker = process.env.FACTORY_RELEASE;

const storeUrl = pathToFileURL(join(repo, 'supervisor', 'src', 'app', 'store.ts')).href;
const leaseUrl = pathToFileURL(join(repo, 'supervisor', 'src', 'app', 'supervisor-lease.ts')).href;

const { openStore } = await import(storeUrl);
const { acquireSupervisor } = await import(leaseUrl);

const db = openStore(dbPath);
const handle = acquireSupervisor(db, stateDir, { nowMs: Date.now(), staleAfterMs: 300000 });
fs.writeFileSync(heldMarker, 'held');

while (!fs.existsSync(releaseMarker)) {
  await sleep(100);
}

handle.release(Date.now());
db.close();
process.exit(0);
'@

  $acquireCode = @'
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const repo = process.env.FACTORY_REPO;
const stateDir = process.env.FACTORY_STATE;
const dbPath = process.env.FACTORY_DB;

const storeUrl = pathToFileURL(join(repo, 'supervisor', 'src', 'app', 'store.ts')).href;
const leaseUrl = pathToFileURL(join(repo, 'supervisor', 'src', 'app', 'supervisor-lease.ts')).href;

const { openStore } = await import(storeUrl);
const { acquireSupervisor } = await import(leaseUrl);

const db = openStore(dbPath);
acquireSupervisor(db, stateDir, { nowMs: Date.now(), staleAfterMs: 300000 });
db.close();
'@

  # 10) فحص الحالة مع قاعدة بيانات مفقودة: لازم يفشل مع كود 1 ورسالة بالعربي
  if (-not (Step 10 'Status on missing database exits 1 with Arabic error' {
    $ErrorActionPreference = 'Continue'
    if (-not (Test-Path -LiteralPath $stateDir)) {
      New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    }
    $raw = node lib/factory.mjs status --state-dir "$stateDir" 2>&1
    $code = $LASTEXITCODE
    $res = $raw | ForEach-Object { "$_" }
    foreach ($line in $res) { Write-Host $line }
    $resText = ($res -join "`n")
    if ($code -eq 1 -and ($resText -match '[\u0600-\u06FF]')) {
      $global:LASTEXITCODE = 0
    } else {
      $global:LASTEXITCODE = 1
    }
  })) { throw 'Step 10 failed' }

  # 11) تشغيل المشرف في الخلفية وحجز الملكية عبر API
  if (-not (Step 11 'Start supervisor in background and acquire lease' {
    $ErrorActionPreference = 'Continue'
    if (Test-Path -LiteralPath $heldMarker) { Remove-Item -LiteralPath $heldMarker -Force }
    if (Test-Path -LiteralPath $releaseMarker) { Remove-Item -LiteralPath $releaseMarker -Force }

    [System.IO.File]::WriteAllText($holderScript, $holderCode, $utf8NoBom)

    $script:holderProcess = Start-Process -FilePath 'node' `
      -ArgumentList "`"$holderScript`"" `
      -RedirectStandardOutput $holderOutLog `
      -RedirectStandardError $holderErrLog `
      -PassThru `
      -NoNewWindow
    $null = $script:holderProcess.Handle

    $timeoutSeconds = 30
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while (-not (Test-Path -LiteralPath $heldMarker) -and $sw.Elapsed.TotalSeconds -lt $timeoutSeconds) {
      if ($script:holderProcess.HasExited) { break }
      Start-Sleep -Milliseconds 100
    }
    [void]$sw.Stop()

    if (Test-Path -LiteralPath $heldMarker) {
      Write-Host "Supervisor lease acquired and held (PID $($script:holderProcess.Id))"
      $global:LASTEXITCODE = 0
    } else {
      Write-Host 'Supervisor holder process failed to acquire lease within timeout' -ForegroundColor Red
      if (Test-Path -LiteralPath $holderOutLog) {
        Get-Content -LiteralPath $holderOutLog | ForEach-Object { Write-Host $_ }
      }
      if (Test-Path -LiteralPath $holderErrLog) {
        Get-Content -LiteralPath $holderErrLog | ForEach-Object { Write-Host $_ }
      }
      $global:LASTEXITCODE = 1
    }
  })) { throw 'Step 11 failed' }

  # 12) فحص الحالة بالعربي والمشرف قيد التشغيل: لازم يُظهر الملكية نشطة
  if (-not (Step 12 'Status shows active lease in Arabic view' {
    $ErrorActionPreference = 'Continue'
    $raw = node lib/factory.mjs status --state-dir "$stateDir" 2>&1
    $code = $LASTEXITCODE
    $res = $raw | ForEach-Object { "$_" }
    foreach ($line in $res) { Write-Host $line }
    $leaseLines = @($res | Where-Object { $_ -cmatch '^الملكية:' })
    $arabicValid = ($leaseLines.Count -eq 1) -and ($leaseLines[0] -match '(^|, )الحالة=نشط(,|$|\s)')
    if ($code -eq 0 -and $arabicValid) {
      $global:LASTEXITCODE = 0
    } else {
      $global:LASTEXITCODE = 1
    }
  })) { throw 'Step 12 failed' }

  # 13) فحص الحالة بصيغة JSON والمشرف قيد التشغيل: لازم تكون الحالة active
  if (-not (Step 13 'Status shows active lease in JSON view' {
    $ErrorActionPreference = 'Continue'
    $raw = node lib/factory.mjs status --state-dir "$stateDir" --json 2>&1
    $code = $LASTEXITCODE
    $res = $raw | ForEach-Object { "$_" }
    foreach ($line in $res) { Write-Host $line }
    $resText = ($res -join "`n")
    $jsonValid = $false
    try {
      $parsed = $resText | ConvertFrom-Json
      if ($parsed -is [System.Management.Automation.PSCustomObject] -and
          $null -ne $parsed.lease -and
          $parsed.lease -is [System.Management.Automation.PSCustomObject] -and
          $parsed.lease.state -is [string] -and
          ($parsed.lease.state -ceq 'active')) {
        $jsonValid = $true
      }
    } catch {
      $jsonValid = $false
    }
    if ($code -eq 0 -and $jsonValid) {
      $global:LASTEXITCODE = 0
    } else {
      $global:LASTEXITCODE = 1
    }
  })) { throw 'Step 13 failed' }

  # 14) محاولة حجز ثانية من عملية تانية: لازم تفشل لأن قفل نظام التشغيل محجوز
  if (-not (Step 14 'Second acquireSupervisor is refused due to OS lock' {
    $ErrorActionPreference = 'Continue'
    [System.IO.File]::WriteAllText($acquireScript, $acquireCode, $utf8NoBom)

    $raw = node "$acquireScript" 2>&1
    $code = $LASTEXITCODE
    $res = $raw | ForEach-Object { "$_" }
    foreach ($line in $res) { Write-Host $line }
    $resText = ($res -join "`n")
    if ($code -ne 0 -and ($resText -match 'supervisor: OS lock is held by another process')) {
      $global:LASTEXITCODE = 0
    } else {
      $global:LASTEXITCODE = 1
    }
  })) { throw 'Step 14 failed' }

  # 15) تحرير الملكية عبر المشرف الأصلي وفحص الحالة بعد التحرير
  if (-not (Step 15 'Release lease via holder process and verify released status' {
    $ErrorActionPreference = 'Continue'
    # Signal the background holder process to release the lease and exit
    Set-Content -LiteralPath $releaseMarker -Value 'release'

    # Wait for the holder process to exit 0
    $exited = $script:holderProcess.WaitForExit(30000)

    if (-not $exited -or -not $script:holderProcess.HasExited) {
      Write-Host 'Holder process did not exit within timeout' -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }

    if ($script:holderProcess.ExitCode -ne 0) {
      Write-Host "Holder process exited with code $($script:holderProcess.ExitCode)" -ForegroundColor Red
      if (Test-Path -LiteralPath $holderOutLog) {
        Get-Content -LiteralPath $holderOutLog | ForEach-Object { Write-Host $_ }
      }
      if (Test-Path -LiteralPath $holderErrLog) {
        Get-Content -LiteralPath $holderErrLog | ForEach-Object { Write-Host $_ }
      }
      $global:LASTEXITCODE = 1
      return
    }

    # Verify status now reports the released label مُحرَّر
    $raw = node lib/factory.mjs status --state-dir "$stateDir" 2>&1
    $code = $LASTEXITCODE
    $res = $raw | ForEach-Object { "$_" }
    foreach ($line in $res) { Write-Host $line }
    $leaseLines = @($res | Where-Object { $_ -cmatch '^الملكية:' })
    $arabicValid = ($leaseLines.Count -eq 1) -and ($leaseLines[0] -match '(^|, )الحالة=مُحرَّر(,|$|\s)')
    if ($code -eq 0 -and $arabicValid) {
      $global:LASTEXITCODE = 0
    } else {
      $global:LASTEXITCODE = 1
    }
  })) { throw 'Step 15 failed' }

} catch {
  $script:overallFailed = $true
  if ($null -eq $script:failureReason) {
    $script:failureReason = $_.Exception.Message
  }
}

# --- Cleanup phase (checked and bounded) ---
try {
  Stop-HolderProcess
} catch {
  $script:overallFailed = $true
  if ($null -eq $script:failureReason) {
    $script:failureReason = $_.Exception.Message
  }
}

try {
  if ($dest -and $origLocation -and $PWD.Path.StartsWith($dest, [System.StringComparison]::OrdinalIgnoreCase)) {
    Set-Location $origLocation
  }
  if ($stateDir) { Remove-AcceptanceTempDir $stateDir }
  if ($dest) { Remove-AcceptanceTempDir $dest }
} catch {
  $script:overallFailed = $true
  if ($null -eq $script:failureReason) {
    $script:failureReason = $_.Exception.Message
  }
}

# Verify removal of acceptance folder; failure to clean up fails acceptance
try {
  if ($dest -and (Test-Path -LiteralPath $dest)) {
    $script:overallFailed = $true
    if ($null -eq $script:failureReason) {
      $script:failureReason = "Acceptance directory still exists after cleanup: $dest"
    }
  }
} catch {
  $script:overallFailed = $true
  if ($null -eq $script:failureReason) {
    $script:failureReason = "Failed to verify removal of acceptance directory: $_"
  }
}

# Restore environment variables
try {
  Remove-Item env:FACTORY_REPO, env:FACTORY_STATE, env:FACTORY_DB, env:FACTORY_HELD, env:FACTORY_RELEASE -ErrorAction SilentlyContinue
} catch {
}

# Restore console output encoding
try {
  if ($origConsoleEncoding) {
    [Console]::OutputEncoding = $origConsoleEncoding
  }
} catch {
}

# --- Centralized final verdict ---
try {
  Write-Host "`n===== M2 acceptance =====" -ForegroundColor Yellow
  $results | Format-Table -AutoSize
  if ($script:overallFailed -or ($results.Result -contains 'FAIL') -or ($results.Count -lt 15)) {
    if ($script:failureReason -and -not $script:failureReason.StartsWith('Step ')) {
      Write-Host "Failure details: $script:failureReason" -ForegroundColor Red
    }
    Write-Host 'M2: FAIL' -ForegroundColor Red
    exit 1
  } else {
    Write-Host 'M2: PASS' -ForegroundColor Green
    exit 0
  }
} catch {
  Write-Host 'M2: FAIL' -ForegroundColor Red
  exit 1
}
