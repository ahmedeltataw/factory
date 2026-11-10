# M3 acceptance (L5). Run in PowerShell:  powershell -ExecutionPolicy Bypass -File acceptance\M3.ps1
# كل خطوة بتطبع PASS أو FAIL. النتيجة المطلوبة: كل الخطوات PASS.
param(
  [string]$Source = 'https://github.com/ahmedeltataw/factory.git'
)

$origConsoleEncoding = $null
$script:overallFailed = $false
$script:failureReason = $null
$results = @()
$script:stepOk = $false
$script:startedProcesses = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$script:trackedWorkerNonces = [System.Collections.Generic.List[string]]::new()
$script:baseSha = $null
$script:taskId1 = $null
$script:taskId2 = $null
$script:taskId3 = $null
$script:worker1Pid = $null
$script:worker1GrandchildPid = $null
$script:worker1Nonce = $null
$script:worker3Pid = $null
$script:worker3GrandchildPid = $null
$script:sup1Process = $null

$acceptanceNonce = [guid]::NewGuid().ToString('N')
$acceptanceBase = $null
$dest = $null
$tempRepo = $null
$stateDir = $null
$logsDir = $null
$helpersDir = $null
$origLocation = $null
$verifyEvidenceScript = $null

function Remove-AcceptanceTempDir([string]$dir) {
  if ([string]::IsNullOrWhiteSpace($dir)) { return }
  if (-not (Test-Path -LiteralPath $dir)) { return }
  $expectedBase = Join-Path $env:TEMP 'factory-m3-acceptance'
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

function Stop-AllAcceptanceProcesses {
  # 1. Stop all explicitly tracked processes started via Start-Process
  foreach ($proc in $script:startedProcesses) {
    if ($null -eq $proc) { continue }
    try {
      if (-not $proc.HasExited) {
        $proc.Kill()
        [void]$proc.WaitForExit(3000)
      }
    } catch {
      # Process might have already exited
    }
  }

  # 2. Stop any remaining processes whose command line contains our acceptance nonce or worker nonces
  try {
    $allProcs = @(Get-CimInstance Win32_Process -Property ProcessId, CommandLine -ErrorAction SilentlyContinue)
    foreach ($p in $allProcs) {
      if ($null -eq $p -or $p.ProcessId -eq $PID) { continue }
      $cmd = $p.CommandLine
      if ([string]::IsNullOrWhiteSpace($cmd)) { continue }

      $isOurs = $false
      if ($cmd.IndexOf($acceptanceNonce, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        $isOurs = $true
      }
      if (-not $isOurs) {
        foreach ($workerNonce in $script:trackedWorkerNonces) {
          if (-not [string]::IsNullOrWhiteSpace($workerNonce) -and $cmd.IndexOf($workerNonce, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            $isOurs = $true
            break
          }
        }
      }

      if ($isOurs) {
        try {
          Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        } catch {}
      }
    }
  } catch {}

  # Verify started processes are dead
  foreach ($proc in $script:startedProcesses) {
    if ($null -eq $proc) { continue }
    try {
      if (-not $proc.HasExited) {
        throw "Process cleanup error: process PID $($proc.Id) could not be confirmed terminated"
      }
    } catch [System.InvalidOperationException] {
      # Already exited
    }
  }
}

function Cleanup-TaskWorktrees {
  if ([string]::IsNullOrWhiteSpace($tempRepo) -or -not (Test-Path -LiteralPath $tempRepo)) { return }
  if ([string]::IsNullOrWhiteSpace($stateDir) -or -not (Test-Path -LiteralPath $stateDir)) { return }
  $wtBase = Join-Path $stateDir 'worktrees'
  if (Test-Path -LiteralPath $wtBase) {
    try {
      $dirs = Get-ChildItem -LiteralPath $wtBase -Directory -ErrorAction SilentlyContinue
      foreach ($d in $dirs) {
        try {
          & git -C $tempRepo worktree remove --force $d.FullName 2>$null
        } catch {}
      }
    } catch {}
  }
  try {
    & git -C $tempRepo worktree prune 2>$null
  } catch {}
}

function Step($n, $label, [scriptblock]$cmd) {
  Write-Host "`n[$n] $label" -ForegroundColor Cyan
  $script:stepOk = $false
  try {
    $out = & $cmd
    $code = $LASTEXITCODE
    foreach ($line in $out) { Write-Host $line }
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
  $acceptanceBase = Join-Path $env:TEMP 'factory-m3-acceptance'
  $dest = Join-Path $acceptanceBase 'factory'
  $tempRepo = Join-Path $acceptanceBase 'demo-repo'
  $stateDir = Join-Path $acceptanceBase "state-$acceptanceNonce"
  $logsDir = Join-Path $acceptanceBase 'logs'
  $helpersDir = Join-Path $acceptanceBase 'helpers'

  $pnpm = if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
    Join-Path $env:USERPROFILE '.local\c2c-tools\pnpm.CMD'
  } else { 'pnpm' }
  if (-not (Test-Path $pnpm)) { $pnpm = 'pnpm' }

  # Clean up any stale directory from a previous aborted run within %TEMP%\factory-m3-acceptance only
  try {
    Remove-AcceptanceTempDir $acceptanceBase
  } catch {
    Write-Host "Warning during pre-run cleanup: $_"
  }

  New-Item -ItemType Directory -Path $acceptanceBase -Force | Out-Null
  New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
  New-Item -ItemType Directory -Path $helpersDir -Force | Out-Null

  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  $verifyEvidenceScript = Join-Path $helpersDir 'verify-evidence.mjs'

  $verifyEvidenceCode = @'
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const wtDir = process.env.FACTORY_WT_DIR;
const headSha = process.env.FACTORY_HEAD_SHA;
const filesJsonStr = process.env.FACTORY_FILES_JSON;

if (!wtDir || !headSha || !filesJsonStr) {
  process.stderr.write('Missing required environment variables\n');
  process.exit(1);
}

try {
  execFileSync('git', ['cat-file', '-e', headSha], { cwd: wtDir, stdio: 'ignore' });
} catch (e) {
  process.stderr.write(`git cat-file -e failed for ${headSha}\n`);
  process.exit(1);
}

let files;
try {
  files = JSON.parse(filesJsonStr);
} catch (e) {
  process.stderr.write('Invalid JSON in FACTORY_FILES_JSON\n');
  process.exit(1);
}

if (!Array.isArray(files)) {
  files = [files];
}

if (files.length === 0) {
  process.stderr.write('Files array is empty\n');
  process.exit(1);
}

for (const file of files) {
  if (!file || typeof file.path !== 'string' || typeof file.sha256 !== 'string') {
    process.stderr.write('Invalid file entry in files\n');
    process.exit(1);
  }
  let bytes;
  try {
    bytes = execFileSync('git', ['show', `${headSha}:${file.path}`], {
      cwd: wtDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    process.stderr.write(`git show failed for ${file.path}\n`);
    process.exit(1);
  }
  const normalized = bytes.toString('utf8').replace(/\r\n/g, '\n');
  const computedHash = createHash('sha256').update(normalized, 'utf8').digest('hex');
  if (computedHash !== file.sha256) {
    process.stderr.write(`Hash mismatch for ${file.path}: expected ${file.sha256}, got ${computedHash}\n`);
    process.exit(1);
  }
}

process.stdout.write('Evidence verified\n');
process.exit(0);
'@
  [System.IO.File]::WriteAllText($verifyEvidenceScript, $verifyEvidenceCode, $utf8NoBom)

  Write-Host "Clone destination: $dest"

  # 1) Node version: 24 or 26
  if (-not (Step 1 'Node version is 24 or 26' {
    $v = node -v
    $code = $LASTEXITCODE
    Write-Host "Node version: $v"
    if ($code -eq 0 -and $v -match '^v(24|26)\.') { $global:LASTEXITCODE = 0 } else { $global:LASTEXITCODE = 1 }
  })) { throw 'Step 1 failed' }

  # 2) Fresh clone from GitHub
  if (-not (Step 2 'Fresh clone from GitHub' {
    & git clone -q -- $Source $dest
  })) { throw 'Step 2 failed' }

  Set-Location $dest

  # 3) Install with frozen lockfile
  if (-not (Step 3 'Install with frozen lockfile' { & $pnpm install --frozen-lockfile })) { throw 'Step 3 failed' }
  # 4) Typecheck
  if (-not (Step 4 'Typecheck' { & $pnpm typecheck })) { throw 'Step 4 failed' }
  # 5) All tests
  if (-not (Step 5 'All tests' { & $pnpm test })) { throw 'Step 5 failed' }
  # 6) Build
  if (-not (Step 6 'Build' { & $pnpm build })) { throw 'Step 6 failed' }
  # 7) Manifest check
  if (-not (Step 7 'Manifest: ported files match dsh' { node scripts/check-manifest.mjs })) { throw 'Step 7 failed' }
  # 8) No forbidden imports
  if (-not (Step 8 'No forbidden imports' { node scripts/check-forbidden-imports.mjs })) { throw 'Step 8 failed' }
  # 9) Traceability check
  if (-not (Step 9 'Every DoD check has passing evidence' { node scripts/check-traceability.mjs --all --require-passing })) { throw 'Step 9 failed' }

  # 10) Init factory project with fresh git repository
  if (-not (Step 10 'Init factory project with fresh git repository' {
    $ErrorActionPreference = 'Continue'
    if (Test-Path -LiteralPath $tempRepo) { Remove-Item -LiteralPath $tempRepo -Recurse -Force }
    New-Item -ItemType Directory -Path $tempRepo -Force | Out-Null
    & git -C $tempRepo init -q 2>&1 | Out-Null
    & git -C $tempRepo checkout -B main -q 2>&1 | Out-Null
    & git -C $tempRepo config user.name "M3 Acceptance" 2>&1 | Out-Null
    & git -C $tempRepo config user.email "acceptance@factory.local" 2>&1 | Out-Null
    & git -C $tempRepo commit --allow-empty -m "Initial commit" -q 2>&1 | Out-Null
    $baseSha = (& git -C $tempRepo rev-parse HEAD).Trim()
    $script:baseSha = $baseSha
    Write-Host "Demo repository initialized at $tempRepo with baseSha $baseSha"

    if (-not (Test-Path -LiteralPath $stateDir)) {
      New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    }

    $raw = node lib/factory.mjs init --state-dir "$stateDir" --repo "$tempRepo" 2>&1
    $code = $LASTEXITCODE
    $res = $raw | ForEach-Object { "$_" }
    foreach ($line in $res) { Write-Host $line }
    $resText = ($res -join "`n")
    if ($code -eq 0 -and ($resText -match '[\u0600-\u06FF]')) {
      $global:LASTEXITCODE = 0
    } else {
      $global:LASTEXITCODE = 1
    }
  })) { throw 'Step 10 failed' }

  $script:taskId1 = [guid]::NewGuid().ToString().ToLowerInvariant()
  # 11) Task create twice with the same --command-id -> duplicate
  if (-not (Step 11 'Task create twice with same command ID reports duplicate' {
    $ErrorActionPreference = 'Continue'
    $tId = $script:taskId1

    $raw1 = node lib/factory.mjs task create --state-dir "$stateDir" --title "M3 Demo Task 1" --command-id $tId 2>&1
    $code1 = $LASTEXITCODE
    $res1 = $raw1 | ForEach-Object { "$_" }
    foreach ($line in $res1) { Write-Host $line }
    $createdValid = ($code1 -eq 0) -and ($res1.Count -ge 1) -and ($res1[0] -match "^created $tId$")

    $raw2 = node lib/factory.mjs task create --state-dir "$stateDir" --title "M3 Demo Task 1" --command-id $tId 2>&1
    $code2 = $LASTEXITCODE
    $res2 = $raw2 | ForEach-Object { "$_" }
    foreach ($line in $res2) { Write-Host $line }
    $dupValid = ($code2 -eq 0) -and ($res2.Count -ge 1) -and ($res2[0] -match "^duplicate $tId$")

    if ($createdValid -and $dupValid) {
      $global:LASTEXITCODE = 0
    } else {
      $global:LASTEXITCODE = 1
    }
  })) { throw 'Step 11 failed' }

  $script:worker1Pid = $null
  $script:worker1GrandchildPid = $null
  $script:worker1Nonce = $null

  # 12) Supervisor in background with long FAKE_SLEEP_MS, poll status --json until worker running
  if (-not (Step 12 'Start supervisor in background and poll status until worker running' {
    $ErrorActionPreference = 'Continue'
    $sup1Out = Join-Path $logsDir 'sup1.out.log'
    $sup1Err = Join-Path $logsDir 'sup1.err.log'

    $env:FAKE_SLEEP_MS = '60000'
    $sup1 = Start-Process -FilePath 'node' `
      -ArgumentList "lib/factory.mjs start --state-dir `"$stateDir`" --stale-after-ms 2000 --heartbeat-ms 500" `
      -RedirectStandardOutput $sup1Out `
      -RedirectStandardError $sup1Err `
      -PassThru `
      -NoNewWindow
    $null = $sup1.Handle
    $script:startedProcesses.Add($sup1)
    $script:sup1Process = $sup1
    Remove-Item env:FAKE_SLEEP_MS -ErrorAction SilentlyContinue

    $timeoutSec = 30
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $workerRunning = $false

    while ($sw.Elapsed.TotalSeconds -lt $timeoutSec) {
      if ($sup1.HasExited) {
        Write-Host "Supervisor unexpectedly exited prematurely with code $($sup1.ExitCode)" -ForegroundColor Red
        break
      }

      $statusRaw = node lib/factory.mjs status --state-dir "$stateDir" --json 2>&1
      if ($LASTEXITCODE -eq 0) {
        try {
          $statusText = ($statusRaw | ForEach-Object { "$_" }) -join "`n"
          $parsed = $statusText | ConvertFrom-Json
          if ($null -ne $parsed.tasks -and $parsed.tasks.Count -ge 1) {
            $task = @($parsed.tasks | Where-Object { $_.id -eq $script:taskId1 })[0]
            if ($null -ne $task -and $task.status -eq 'progress' -and $task.attempts.Count -ge 1) {
              $att = $task.attempts[0]
              if ($att.status -eq 'running' -and $null -ne $att.worker -and $att.worker.state -eq 'running' -and $att.worker.pid -gt 0) {
                $script:worker1Pid = $att.worker.pid
                $workerRunning = $true
                break
              }
            }
          }
        } catch {}
      }
      Start-Sleep -Milliseconds 200
    }
    [void]$sw.Stop()

    if (-not $workerRunning) {
      Write-Host "Timeout waiting for worker to reach running state" -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }

    # Harvest worker.json to find grandchild PID and worker nonce
    $runsDir = Join-Path $stateDir 'runs'
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $foundJson = $false
    while ($sw.Elapsed.TotalSeconds -lt 10) {
      if (Test-Path -LiteralPath $runsDir) {
        $workerJsonFiles = @(Get-ChildItem -LiteralPath $runsDir -Filter 'worker.json' -Recurse -ErrorAction SilentlyContinue)
        foreach ($wf in $workerJsonFiles) {
          try {
            $rawContent = Get-Content -LiteralPath $wf.FullName -Raw
            $wJson = $rawContent | ConvertFrom-Json
            if ($null -ne $wJson -and $wJson.pid -eq $script:worker1Pid -and $null -ne $wJson.grandchildPid) {
              $script:worker1GrandchildPid = $wJson.grandchildPid
              $script:worker1Nonce = $wJson.nonce
              if (-not [string]::IsNullOrWhiteSpace($wJson.nonce)) {
                $script:trackedWorkerNonces.Add($wJson.nonce)
              }
              $foundJson = $true
              break
            }
          } catch {}
        }
      }
      if ($foundJson) { break }
      Start-Sleep -Milliseconds 100
    }
    [void]$sw.Stop()

    Write-Host "Worker running: PID=$($script:worker1Pid), Grandchild=$($script:worker1GrandchildPid), Nonce=$($script:worker1Nonce)"
    if ($foundJson -and $null -ne $script:worker1Pid -and $null -ne $script:worker1GrandchildPid) {
      $global:LASTEXITCODE = 0
    } else {
      $global:LASTEXITCODE = 1
    }
  })) { throw 'Step 12 failed' }

  # 13) Stop the Supervisor only and assert the executor pid from worker.json is alive
  if (-not (Step 13 'Stop supervisor and assert orphaned executor and grandchild are alive' {
    $ErrorActionPreference = 'Continue'
    if ($null -ne $script:sup1Process -and -not $script:sup1Process.HasExited) {
      $script:sup1Process.Kill()
      [void]$script:sup1Process.WaitForExit(5000)
    }

    $supDead = $script:sup1Process.HasExited
    if (-not $supDead) {
      Write-Host "Supervisor process failed to stop" -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }

    $executorProc = Get-Process -Id $script:worker1Pid -ErrorAction SilentlyContinue
    $executorAlive = ($null -ne $executorProc) -and (-not $executorProc.HasExited)

    $grandchildProc = Get-Process -Id $script:worker1GrandchildPid -ErrorAction SilentlyContinue
    $grandchildAlive = ($null -ne $grandchildProc) -and (-not $grandchildProc.HasExited)

    Write-Host "Supervisor dead: $supDead; Executor alive: $executorAlive; Grandchild alive: $grandchildAlive"
    if ($supDead -and $executorAlive -and $grandchildAlive) {
      $global:LASTEXITCODE = 0
    } else {
      $global:LASTEXITCODE = 1
    }
  })) { throw 'Step 13 failed' }

  # 14) Restart with --takeover from status after the short stale window and --exit-when-idle
  if (-not (Step 14 'Restart supervisor with takeover after stale window and exit-when-idle' {
    $ErrorActionPreference = 'Continue'
    $statusRaw = node lib/factory.mjs status --state-dir "$stateDir" --json 2>&1
    if ($LASTEXITCODE -ne 0) {
      Write-Host "Failed to query status for takeover evidence" -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }

    $statusText = ($statusRaw | ForEach-Object { "$_" }) -join "`n"
    $parsed = $statusText | ConvertFrom-Json
    $takeover = $parsed.lease.takeover
    $heartbeatMs = $parsed.lease.heartbeatMs
    Write-Host "Lease takeover evidence: $takeover (Heartbeat: $heartbeatMs)"

    if ([string]::IsNullOrWhiteSpace($takeover) -or -not ($takeover -match '^[A-Za-z0-9._-]+:\d+:\d+$')) {
      Write-Host "Invalid lease takeover evidence format: $takeover" -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }

    # Wait for the 2000ms stale window + 500ms margin
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $staleDeadline = $heartbeatMs + 2000 + 500
    $waitMs = $staleDeadline - $nowMs
    if ($waitMs -gt 0) {
      Write-Host "Waiting $waitMs ms for lease to become stale..."
      Start-Sleep -Milliseconds $waitMs
    }

    $supRestartOut = Join-Path $logsDir 'sup-restart1.out.log'
    $supRestartErr = Join-Path $logsDir 'sup-restart1.err.log'

    $supRestart = Start-Process -FilePath 'node' `
      -ArgumentList "lib/factory.mjs start --state-dir `"$stateDir`" --takeover $takeover --exit-when-idle --stale-after-ms 2000 --heartbeat-ms 500" `
      -RedirectStandardOutput $supRestartOut `
      -RedirectStandardError $supRestartErr `
      -PassThru `
      -NoNewWindow
    $null = $supRestart.Handle
    $script:startedProcesses.Add($supRestart)

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while (-not $supRestart.HasExited -and $sw.Elapsed.TotalSeconds -lt 60) {
      Start-Sleep -Milliseconds 200
    }
    [void]$sw.Stop()

    Write-Host "Restarted supervisor exited: $($supRestart.HasExited); ExitCode: $($supRestart.ExitCode)"
    if ($supRestart.HasExited -and $supRestart.ExitCode -eq 0) {
      $global:LASTEXITCODE = 0
    } else {
      if (Test-Path -LiteralPath $supRestartErr) {
        Get-Content -LiteralPath $supRestartErr | ForEach-Object { Write-Host "ERR: $_" -ForegroundColor Red }
      }
      $global:LASTEXITCODE = 1
    }
  })) { throw 'Step 14 failed' }

  # 15) Assert executor and grandchild gone, one task done, attempts interrupted+succeeded, evidence, commit
  if (-not (Step 15 'Takeover completes task done, interrupted+succeeded attempts, evidence and commit' {
    $ErrorActionPreference = 'Continue'
    $pExec = Get-Process -Id $script:worker1Pid -ErrorAction SilentlyContinue
    $pGrand = Get-Process -Id $script:worker1GrandchildPid -ErrorAction SilentlyContinue
    $execGone = ($null -eq $pExec -or $pExec.HasExited)
    $grandGone = ($null -eq $pGrand -or $pGrand.HasExited)
    Write-Host "Executor gone: $execGone; Grandchild gone: $grandGone"

    $statusRaw = node lib/factory.mjs status --state-dir "$stateDir" --json 2>&1
    if ($LASTEXITCODE -ne 0) {
      Write-Host "Failed to query status" -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }
    $statusText = ($statusRaw | ForEach-Object { "$_" }) -join "`n"
    $parsed = $statusText | ConvertFrom-Json

    $task = @($parsed.tasks | Where-Object { $_.id -eq $script:taskId1 })[0]
    $taskDone = ($null -ne $task) -and ($task.status -eq 'done')
    Write-Host "Task 1 done: $taskDone (status=$($task.status))"

    $attemptsValid = $false
    if ($null -ne $task -and $task.attempts.Count -eq 2) {
      $a1 = $task.attempts[0]
      $a2 = $task.attempts[1]
      if ($a1.no -eq 1 -and $a1.status -eq 'interrupted' -and $a2.no -eq 2 -and $a2.status -eq 'succeeded') {
        $attemptsValid = $true
      }
    }
    Write-Host "Attempts interrupted + succeeded: $attemptsValid (count=$($task.attempts.Count))"

    $evidenceValid = $false
    if ($attemptsValid) {
      $evidence = $task.attempts[1].evidence
      if ($null -ne $evidence -and -not [string]::IsNullOrWhiteSpace($evidence.headSha)) {
        $env:FACTORY_WT_DIR = Join-Path $stateDir "worktrees\$($script:taskId1)"
        $env:FACTORY_HEAD_SHA = $evidence.headSha
        $env:FACTORY_FILES_JSON = ($evidence.files | ConvertTo-Json -Compress)
        $rawVerify = node "$verifyEvidenceScript" 2>&1
        $verifyCode = $LASTEXITCODE
        Remove-Item env:FACTORY_WT_DIR, env:FACTORY_HEAD_SHA, env:FACTORY_FILES_JSON -ErrorAction SilentlyContinue
        foreach ($l in $rawVerify) { Write-Host "VERIFY: $l" }
        $evidenceValid = ($verifyCode -eq 0)
      }
    }
    Write-Host "Evidence verified: $evidenceValid"

    $wtPath = Join-Path $stateDir "worktrees\$($script:taskId1)"
    $commitCount = (& git -C $wtPath rev-list --count HEAD "^$($script:baseSha)").Trim()
    $commitValid = ($commitCount -match '^1$')
    Write-Host "Commits above base: $commitCount (valid: $commitValid)"

    if ($execGone -and $grandGone -and $taskDone -and $attemptsValid -and $evidenceValid -and $commitValid) {
      $global:LASTEXITCODE = 0
    } else {
      $global:LASTEXITCODE = 1
    }
  })) { throw 'Step 15 failed' }

  $script:taskId2 = [guid]::NewGuid().ToString().ToLowerInvariant()
  # 16) Outbox crash: second task under FACTORY_FAULT=outbox-after-effect terminates supervisor non-zero
  if (-not (Step 16 'Outbox crash: task 2 under FACTORY_FAULT=outbox-after-effect ends supervisor non-zero' {
    $ErrorActionPreference = 'Continue'
    $tId = $script:taskId2

    $rawCreate = node lib/factory.mjs task create --state-dir "$stateDir" --title "Task 2 Fault" --command-id $tId 2>&1
    $codeCreate = $LASTEXITCODE
    $resCreate = $rawCreate | ForEach-Object { "$_" }
    foreach ($line in $resCreate) { Write-Host $line }
    if ($codeCreate -ne 0 -or -not ($resCreate[0] -match "^created $tId$")) {
      Write-Host "Failed to create task 2" -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }

    $supFaultOut = Join-Path $logsDir 'sup-fault.out.log'
    $supFaultErr = Join-Path $logsDir 'sup-fault.err.log'

    $env:FACTORY_FAULT = 'outbox-after-effect'
    $supFault = Start-Process -FilePath 'node' `
      -ArgumentList "lib/factory.mjs start --state-dir `"$stateDir`" --stale-after-ms 2000 --heartbeat-ms 500" `
      -RedirectStandardOutput $supFaultOut `
      -RedirectStandardError $supFaultErr `
      -PassThru `
      -NoNewWindow
    $null = $supFault.Handle
    $script:startedProcesses.Add($supFault)
    Remove-Item env:FACTORY_FAULT -ErrorAction SilentlyContinue

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while (-not $supFault.HasExited -and $sw.Elapsed.TotalSeconds -lt 30) {
      Start-Sleep -Milliseconds 200
    }
    [void]$sw.Stop()

    $faultExited = $supFault.HasExited
    $faultCode = $supFault.ExitCode
    Write-Host "Supervisor with fault exited: $faultExited; ExitCode: $faultCode"

    if ($faultExited -and $faultCode -ne 0) {
      $global:LASTEXITCODE = 0
    } else {
      $global:LASTEXITCODE = 1
    }
  })) { throw 'Step 16 failed' }

  # 17) Restart without fault recovers outbox, commits, and records single evidence
  if (-not (Step 17 'Restart without fault recovers outbox, commits, and records single evidence' {
    $ErrorActionPreference = 'Continue'
    $statusRaw = node lib/factory.mjs status --state-dir "$stateDir" --json 2>&1
    if ($LASTEXITCODE -ne 0) {
      Write-Host "Failed to read status" -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }
    $statusText = ($statusRaw | ForEach-Object { "$_" }) -join "`n"
    $parsed = $statusText | ConvertFrom-Json
    $takeover = $parsed.lease.takeover
    $heartbeatMs = $parsed.lease.heartbeatMs
    Write-Host "Lease takeover evidence: $takeover (Heartbeat: $heartbeatMs)"

    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $staleDeadline = $heartbeatMs + 2000 + 500
    $waitMs = $staleDeadline - $nowMs
    if ($waitMs -gt 0) {
      Write-Host "Waiting $waitMs ms for lease to become stale..."
      Start-Sleep -Milliseconds $waitMs
    }

    $supRestart2Out = Join-Path $logsDir 'sup-restart2.out.log'
    $supRestart2Err = Join-Path $logsDir 'sup-restart2.err.log'

    $supRestart2 = Start-Process -FilePath 'node' `
      -ArgumentList "lib/factory.mjs start --state-dir `"$stateDir`" --takeover $takeover --exit-when-idle --stale-after-ms 2000 --heartbeat-ms 500" `
      -RedirectStandardOutput $supRestart2Out `
      -RedirectStandardError $supRestart2Err `
      -PassThru `
      -NoNewWindow
    $null = $supRestart2.Handle
    $script:startedProcesses.Add($supRestart2)

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while (-not $supRestart2.HasExited -and $sw.Elapsed.TotalSeconds -lt 60) {
      Start-Sleep -Milliseconds 200
    }
    [void]$sw.Stop()

    if (-not $supRestart2.HasExited -or $supRestart2.ExitCode -ne 0) {
      Write-Host "Recovery supervisor failed to exit 0" -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }

    $statusRaw2 = node lib/factory.mjs status --state-dir "$stateDir" --json 2>&1
    $statusText2 = ($statusRaw2 | ForEach-Object { "$_" }) -join "`n"
    $parsed2 = $statusText2 | ConvertFrom-Json

    $task2 = @($parsed2.tasks | Where-Object { $_.id -eq $script:taskId2 })[0]
    $task2Done = ($null -ne $task2 -and $task2.status -eq 'done')

    $evidenceCount = if ($null -ne $task2) { @($task2.attempts | Where-Object { $null -ne $_.evidence }).Count } else { 0 }
    Write-Host "Task 2 done: $task2Done; evidence rows: $evidenceCount"

    $wt2Path = Join-Path $stateDir "worktrees\$($script:taskId2)"
    $commitCount = (& git -C $wt2Path rev-list --count HEAD "^$($script:baseSha)").Trim()
    Write-Host "Task 2 commits above base: $commitCount"

    if ($task2Done -and $evidenceCount -eq 1 -and $commitCount -match '^1$') {
      $global:LASTEXITCODE = 0
    } else {
      $global:LASTEXITCODE = 1
    }
  })) { throw 'Step 17 failed' }

  $script:taskId3 = [guid]::NewGuid().ToString().ToLowerInvariant()
  $script:worker3Pid = $null
  $script:worker3GrandchildPid = $null

  # 18) Kill task terminates process tree and marks task dropped
  if (-not (Step 18 'Kill task terminates process tree and marks task dropped' {
    $ErrorActionPreference = 'Continue'
    $tId = $script:taskId3

    $rawCreate = node lib/factory.mjs task create --state-dir "$stateDir" --title "Task 3 Kill Test" --command-id $tId 2>&1
    $codeCreate = $LASTEXITCODE
    $resCreate = $rawCreate | ForEach-Object { "$_" }
    foreach ($line in $resCreate) { Write-Host $line }
    if ($codeCreate -ne 0 -or -not ($resCreate[0] -match "^created $tId$")) {
      Write-Host "Failed to create task 3" -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }

    $sup3Out = Join-Path $logsDir 'sup3.out.log'
    $sup3Err = Join-Path $logsDir 'sup3.err.log'

    $env:FAKE_SLEEP_MS = '60000'
    $sup3 = Start-Process -FilePath 'node' `
      -ArgumentList "lib/factory.mjs start --state-dir `"$stateDir`" --exit-when-idle --stale-after-ms 2000 --heartbeat-ms 500" `
      -RedirectStandardOutput $sup3Out `
      -RedirectStandardError $sup3Err `
      -PassThru `
      -NoNewWindow
    $null = $sup3.Handle
    $script:startedProcesses.Add($sup3)
    Remove-Item env:FAKE_SLEEP_MS -ErrorAction SilentlyContinue

    $timeoutSec = 30
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $running = $false
    while ($sw.Elapsed.TotalSeconds -lt $timeoutSec) {
      if ($sup3.HasExited) {
        Write-Host "Supervisor 3 exited prematurely" -ForegroundColor Red
        break
      }
      $statusRaw = node lib/factory.mjs status --state-dir "$stateDir" --json 2>&1
      if ($LASTEXITCODE -eq 0) {
        try {
          $statusText = ($statusRaw | ForEach-Object { "$_" }) -join "`n"
          $parsed = $statusText | ConvertFrom-Json
          $task3 = @($parsed.tasks | Where-Object { $_.id -eq $script:taskId3 })[0]
          if ($null -ne $task3 -and $task3.status -eq 'progress' -and $task3.attempts.Count -ge 1) {
            $att = $task3.attempts[0]
            if ($att.status -eq 'running' -and $null -ne $att.worker -and $att.worker.state -eq 'running' -and $att.worker.pid -gt 0) {
              $script:worker3Pid = $att.worker.pid
              $running = $true
              break
            }
          }
        } catch {}
      }
      Start-Sleep -Milliseconds 200
    }
    [void]$sw.Stop()

    if (-not $running) {
      Write-Host "Timeout waiting for task 3 worker to run" -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }

    $runsDir = Join-Path $stateDir 'runs'
    $workerJsonFiles = @(Get-ChildItem -LiteralPath $runsDir -Filter 'worker.json' -Recurse -ErrorAction SilentlyContinue)
    foreach ($wf in $workerJsonFiles) {
      try {
        $wj = (Get-Content -LiteralPath $wf.FullName -Raw) | ConvertFrom-Json
        if ($wj.pid -eq $script:worker3Pid) {
          $script:worker3GrandchildPid = $wj.grandchildPid
          if (-not [string]::IsNullOrWhiteSpace($wj.nonce)) {
            $script:trackedWorkerNonces.Add($wj.nonce)
          }
          break
        }
      } catch {}
    }

    Write-Host "Task 3 worker PID=$($script:worker3Pid), grandchild PID=$($script:worker3GrandchildPid)"

    # Issue task kill
    $killRaw = node lib/factory.mjs task kill --state-dir "$stateDir" --task $tId 2>&1
    $killCode = $LASTEXITCODE
    $killRes = $killRaw | ForEach-Object { "$_" }
    foreach ($line in $killRes) { Write-Host $line }
    if ($killCode -ne 0 -or -not ($killRes[0] -match '^created [0-9a-f-]+$')) {
      Write-Host "task kill command failed" -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }

    # Wait for worker process and grandchild process to be dead
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $treeDead = $false
    while ($sw.Elapsed.TotalSeconds -lt 25) {
      $pExec = Get-Process -Id $script:worker3Pid -ErrorAction SilentlyContinue
      $pGrand = if ($script:worker3GrandchildPid) { Get-Process -Id $script:worker3GrandchildPid -ErrorAction SilentlyContinue } else { $null }
      $execGone = ($null -eq $pExec -or $pExec.HasExited)
      $grandGone = ($null -eq $pGrand -or $pGrand.HasExited)
      if ($execGone -and $grandGone) {
        $treeDead = $true
        break
      }
      Start-Sleep -Milliseconds 150
    }
    [void]$sw.Stop()

    if (-not $treeDead) {
      Write-Host "Process tree for task 3 was not killed within timeout" -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }

    # Wait for supervisor 3 to exit
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while (-not $sup3.HasExited -and $sw.Elapsed.TotalSeconds -lt 30) {
      Start-Sleep -Milliseconds 200
    }
    [void]$sw.Stop()

    $statusRaw3 = node lib/factory.mjs status --state-dir "$stateDir" --json 2>&1
    $statusText3 = ($statusRaw3 | ForEach-Object { "$_" }) -join "`n"
    $parsed3 = $statusText3 | ConvertFrom-Json
    $task3After = @($parsed3.tasks | Where-Object { $_.id -eq $script:taskId3 })[0]

    Write-Host "Task 3 status after kill: $($task3After.status); attempt status: $($task3After.attempts[0].status)"
    if ($task3After.status -eq 'dropped' -and $task3After.attempts[0].status -eq 'killed') {
      $global:LASTEXITCODE = 0
    } else {
      $global:LASTEXITCODE = 1
    }
  })) { throw 'Step 18 failed' }

  # 19) Dropped task is not retried after another restart
  if (-not (Step 19 'Dropped task is not retried after another restart' {
    $ErrorActionPreference = 'Continue'
    $supFinalOut = Join-Path $logsDir 'sup-final.out.log'
    $supFinalErr = Join-Path $logsDir 'sup-final.err.log'

    $supFinal = Start-Process -FilePath 'node' `
      -ArgumentList "lib/factory.mjs start --state-dir `"$stateDir`" --exit-when-idle --stale-after-ms 2000 --heartbeat-ms 500" `
      -RedirectStandardOutput $supFinalOut `
      -RedirectStandardError $supFinalErr `
      -PassThru `
      -NoNewWindow
    $null = $supFinal.Handle
    $script:startedProcesses.Add($supFinal)

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while (-not $supFinal.HasExited -and $sw.Elapsed.TotalSeconds -lt 30) {
      Start-Sleep -Milliseconds 200
    }
    [void]$sw.Stop()

    if (-not $supFinal.HasExited -or $supFinal.ExitCode -ne 0) {
      Write-Host "Final supervisor failed to exit 0" -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }

    $statusRaw = node lib/factory.mjs status --state-dir "$stateDir" --json 2>&1
    $statusText = ($statusRaw | ForEach-Object { "$_" }) -join "`n"
    $parsed = $statusText | ConvertFrom-Json
    $task3Final = @($parsed.tasks | Where-Object { $_.id -eq $script:taskId3 })[0]

    Write-Host "Task 3 final status: $($task3Final.status); attempts count: $($task3Final.attempts.Count)"
    if ($task3Final.status -eq 'dropped' -and $task3Final.attempts.Count -eq 1 -and $task3Final.attempts[0].status -eq 'killed') {
      $global:LASTEXITCODE = 0
    } else {
      $global:LASTEXITCODE = 1
    }
  })) { throw 'Step 19 failed' }

} catch {
  $script:overallFailed = $true
  if ($null -eq $script:failureReason) {
    $script:failureReason = $_.Exception.Message
  }
}

# --- Cleanup phase (checked and bounded) ---
try {
  Stop-AllAcceptanceProcesses
} catch {
  $script:overallFailed = $true
  if ($null -eq $script:failureReason) {
    $script:failureReason = $_.Exception.Message
  }
}

try {
  Cleanup-TaskWorktrees
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
  if ($acceptanceBase) { Remove-AcceptanceTempDir $acceptanceBase }
} catch {
  $script:overallFailed = $true
  if ($null -eq $script:failureReason) {
    $script:failureReason = $_.Exception.Message
  }
}

# Verify removal of acceptance folder; failure to clean up fails acceptance
try {
  if ($acceptanceBase -and (Test-Path -LiteralPath $acceptanceBase)) {
    $script:overallFailed = $true
    if ($null -eq $script:failureReason) {
      $script:failureReason = "Acceptance directory still exists after cleanup: $acceptanceBase"
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
  Remove-Item env:FAKE_SLEEP_MS, env:FACTORY_FAULT, env:FACTORY_WT_DIR, env:FACTORY_HEAD_SHA, env:FACTORY_FILES_JSON -ErrorAction SilentlyContinue
} catch {}

# Restore console output encoding
try {
  if ($origConsoleEncoding) {
    [Console]::OutputEncoding = $origConsoleEncoding
  }
} catch {}

# --- Centralized final verdict ---
try {
  Write-Host "`n===== M3 acceptance =====" -ForegroundColor Yellow
  $results | Format-Table -AutoSize
  if ($script:overallFailed -or ($results.Result -contains 'FAIL') -or ($results.Count -lt 19)) {
    if ($script:failureReason -and -not $script:failureReason.StartsWith('Step ')) {
      Write-Host "Failure details: $script:failureReason" -ForegroundColor Red
    }
    Write-Host 'M3: FAIL' -ForegroundColor Red
    exit 1
  } else {
    Write-Host 'M3: PASS' -ForegroundColor Green
    exit 0
  }
} catch {
  Write-Host 'M3: FAIL' -ForegroundColor Red
  exit 1
}
