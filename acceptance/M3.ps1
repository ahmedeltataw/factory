# M3 acceptance (L5). Run in PowerShell:  powershell -ExecutionPolicy Bypass -File acceptance\M3.ps1
# كل خطوة بتطبع PASS أو FAIL. النتيجة المطلوبة: كل الخطوات PASS.
param(
  [string]$Source = 'https://github.com/ahmedeltataw/factory.git',
  [switch]$SkipBaseline
)

$origConsoleEncoding = $null
$origInputEncoding = $null
$origOutputEncoding = $null
$script:overallFailed = $false
$script:failureReason = $null
$script:hasSurvivors = $false
$script:nodeExe = $null
$results = @()
$script:stepOk = $false
$script:startedProcesses = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$script:ownedPids = [System.Collections.Generic.List[int]]::new()
$script:trackedProcessRecords = [System.Collections.Generic.List[object]]::new()
$script:trackedWorkerNonces = [System.Collections.Generic.List[string]]::new()
$script:baseSha = $null
$script:taskId1 = $null
$script:taskId2 = $null
$script:taskId3 = $null
$script:attemptId2 = $null
$script:worker1Pid = $null
$script:worker1GrandchildPid = $null
$script:worker1Nonce = $null
$script:worker2Pid = $null
$script:worker2GrandchildPid = $null
$script:worker2Nonce = $null
$script:worker3Pid = $null
$script:worker3GrandchildPid = $null
$script:sup1Process = $null
$script:sup1Pid = $null

$acceptanceNonce = [guid]::NewGuid().ToString('N')
$sharedBase = Join-Path $env:TEMP 'factory-m3-acceptance'
$acceptanceBase = Join-Path $sharedBase $acceptanceNonce
$dest = Join-Path $acceptanceBase 'factory'
$tempRepo = Join-Path $acceptanceBase 'demo-repo'
$stateDir = Join-Path $acceptanceBase 'state'
$logsDir = Join-Path $acceptanceBase 'logs'
$helpersDir = Join-Path $acceptanceBase 'helpers'
$origLocation = $null
$verifyEvidenceScript = $null
$arrangePendingScript = $null
$checkCrashBoundaryScript = $null

function Remove-AcceptanceTempDir([string]$dir) {
  if ([string]::IsNullOrWhiteSpace($dir)) { return }
  if (-not (Test-Path -LiteralPath $dir)) { return }
  $expectedShared = Join-Path $env:TEMP 'factory-m3-acceptance'
  $fullExpected = [System.IO.Path]::GetFullPath($expectedShared).TrimEnd([char[]]@('\', '/'))
  $fullDir = [System.IO.Path]::GetFullPath($dir).TrimEnd([char[]]@('\', '/'))
  # Refuse to delete the shared base itself or anything outside of it
  if ($fullDir -eq $fullExpected -or (-not $fullDir.StartsWith($fullExpected + '\', [System.StringComparison]::OrdinalIgnoreCase) -and -not $fullDir.StartsWith($fullExpected + '/', [System.StringComparison]::OrdinalIgnoreCase))) {
    throw "Safety error: refused to delete path outside ${expectedShared} subdirectories: $dir"
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

function Register-TrackedPid([int]$pId, [string]$nonce = $null) {
  if ($pId -le 0 -or $pId -eq $PID) { return }
  try {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $pId" -Property ProcessId, Name, CommandLine, CreationDate -ErrorAction Stop
  } catch {
    $proc = $null
  }
  if ($null -ne $proc) {
    foreach ($rec in $script:trackedProcessRecords) {
      if ($rec.ProcessId -eq $pId -and $rec.CreationDate -eq $proc.CreationDate) {
        if (-not [string]::IsNullOrWhiteSpace($nonce) -and [string]::IsNullOrWhiteSpace($rec.Nonce)) {
          $rec.Nonce = $nonce
        }
        return
      }
    }
    $record = [pscustomobject]@{
      ProcessId    = $pId
      CreationDate = $proc.CreationDate
      CommandLine  = $proc.CommandLine
      Nonce        = $nonce
    }
    $script:trackedProcessRecords.Add($record)
  } elseif (-not [string]::IsNullOrWhiteSpace($nonce)) {
    foreach ($rec in $script:trackedProcessRecords) {
      if ($rec.ProcessId -eq $pId -and [string]::IsNullOrWhiteSpace($rec.Nonce)) {
        $rec.Nonce = $nonce
      }
    }
  }
  if (-not $script:ownedPids.Contains($pId)) {
    $script:ownedPids.Add($pId)
  }
}

function Test-CommandLineMatchesRun([string]$cmd, [string]$specificNonce = $null) {
  if ([string]::IsNullOrWhiteSpace($cmd)) { return $false }

  if (-not [string]::IsNullOrWhiteSpace($acceptanceBase)) {
    if ($cmd.IndexOf($acceptanceBase, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
    $fwdBase = $acceptanceBase.Replace('\', '/')
    if ($cmd.IndexOf($fwdBase, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
    try {
      $fullBase = [System.IO.Path]::GetFullPath($acceptanceBase)
      if ($cmd.IndexOf($fullBase, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
      $fwdFull = $fullBase.Replace('\', '/')
      if ($cmd.IndexOf($fwdFull, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
    } catch {}
  }

  if (-not [string]::IsNullOrWhiteSpace($acceptanceNonce)) {
    if ($cmd.IndexOf($acceptanceNonce, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
  }

  if (-not [string]::IsNullOrWhiteSpace($specificNonce)) {
    if ($cmd.IndexOf($specificNonce, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
  }

  foreach ($wn in $script:trackedWorkerNonces) {
    if (-not [string]::IsNullOrWhiteSpace($wn) -and $cmd.IndexOf($wn, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
      return $true
    }
  }

  return $false
}

function Test-TrackedPidIdentityValid($rec) {
  if ($null -eq $rec -or $rec.ProcessId -le 0 -or $rec.ProcessId -eq $PID) { return $false }
  $pId = $rec.ProcessId
  $curr = Get-CimInstance Win32_Process -Filter "ProcessId = $pId" -Property ProcessId, Name, CommandLine, CreationDate -ErrorAction Stop
  if ($null -eq $curr) {
    return $false
  }
  $dateMatch = ($curr.CreationDate -eq $rec.CreationDate) -or ([Math]::Abs(($curr.CreationDate - $rec.CreationDate).TotalMilliseconds) -lt 1000)
  if (-not $dateMatch) {
    return $false
  }
  return (Test-CommandLineMatchesRun $curr.CommandLine $rec.Nonce)
}

function Test-ProcessMatchesRun($proc) {
  if ($null -eq $proc -or $proc.ProcessId -eq $PID) { return $false }
  $pName = $proc.Name
  if ([string]::IsNullOrWhiteSpace($pName) -or ($pName -ne 'node.exe' -and $pName -notlike 'node*.exe')) {
    return $false
  }
  return (Test-CommandLineMatchesRun $proc.CommandLine)
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
    } catch {}
  }

  # 2. Stop all known owned worker and grandchild PIDs after validating current identity
  foreach ($rec in $script:trackedProcessRecords) {
    if ($null -eq $rec -or $rec.ProcessId -le 0 -or $rec.ProcessId -eq $PID) { continue }
    try {
      if (Test-TrackedPidIdentityValid $rec) {
        Stop-Process -Id $rec.ProcessId -Force -ErrorAction SilentlyContinue
      }
    } catch {
      $script:hasSurvivors = $true
      $script:overallFailed = $true
      throw "Process identity check failed during termination: $($_.Exception.Message)"
    }
  }

  # 3. Sweep: kill every node.exe whose command line contains this run's directory OR any tracked nonce
  try {
    $allProcs = @(Get-CimInstance Win32_Process -Property ProcessId, Name, CommandLine -ErrorAction Stop)
    if ($allProcs.Count -eq 0) {
      $script:hasSurvivors = $true
      $script:overallFailed = $true
      throw "Process enumeration returned 0 processes; enumeration failed"
    }
    foreach ($p in $allProcs) {
      if (Test-ProcessMatchesRun $p) {
        try {
          Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        } catch {}
      }
    }
  } catch {
    $script:hasSurvivors = $true
    $script:overallFailed = $true
    throw "Process sweep enumeration failed: $($_.Exception.Message)"
  }

  # 4. Bounded wait for all candidate processes to be gone
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $timeoutSec = 10
  while ($sw.Elapsed.TotalSeconds -lt $timeoutSec) {
    $anyAlive = $false
    foreach ($proc in $script:startedProcesses) {
      if ($null -ne $proc) {
        try {
          if (-not $proc.HasExited) { $anyAlive = $true; break }
        } catch {}
      }
    }
    if (-not $anyAlive) {
      foreach ($rec in $script:trackedProcessRecords) {
        try {
          if (Test-TrackedPidIdentityValid $rec) { $anyAlive = $true; break }
        } catch {
          $script:hasSurvivors = $true
          $script:overallFailed = $true
          throw "Process identity check failed during wait: $($_.Exception.Message)"
        }
      }
    }
    if (-not $anyAlive) {
      try {
        $procs = @(Get-CimInstance Win32_Process -Property ProcessId, Name, CommandLine -ErrorAction Stop)
        if ($procs.Count -eq 0) {
          $script:hasSurvivors = $true
          $script:overallFailed = $true
          throw "Process enumeration returned 0 processes during wait"
        }
        foreach ($p in $procs) {
          if (Test-ProcessMatchesRun $p) { $anyAlive = $true; break }
        }
      } catch {
        $script:hasSurvivors = $true
        $script:overallFailed = $true
        throw "Process wait enumeration failed: $($_.Exception.Message)"
      }
    }
    if (-not $anyAlive) { break }
    Start-Sleep -Milliseconds 150
  }
  [void]$sw.Stop()

  # 5. Survivor checks: assert none survive
  $survivorDetails = [System.Collections.Generic.List[string]]::new()
  foreach ($proc in $script:startedProcesses) {
    if ($null -ne $proc) {
      try {
        if (-not $proc.HasExited) {
          $survivorDetails.Add("Started process PID $($proc.Id) still running")
        }
      } catch [System.InvalidOperationException] {}
    }
  }
  foreach ($rec in $script:trackedProcessRecords) {
    try {
      if (Test-TrackedPidIdentityValid $rec) {
        $survivorDetails.Add("Tracked worker/grandchild PID $($rec.ProcessId) still running (CreationDate: $($rec.CreationDate))")
      }
    } catch {
      $script:hasSurvivors = $true
      $script:overallFailed = $true
      throw "Process identity check failed during survivor verification: $($_.Exception.Message)"
    }
  }
  try {
    $remainingProcs = @(Get-CimInstance Win32_Process -Property ProcessId, Name, CommandLine -ErrorAction Stop)
    if ($remainingProcs.Count -eq 0) {
      $script:hasSurvivors = $true
      $script:overallFailed = $true
      throw "Process enumeration returned 0 processes during survivor check; enumeration failed"
    }
    foreach ($p in $remainingProcs) {
      if (Test-ProcessMatchesRun $p) {
        $survivorDetails.Add("Node process PID $($p.ProcessId) matching run dir or nonce still running: $($p.CommandLine)")
      }
    }
  } catch {
    $script:hasSurvivors = $true
    $script:overallFailed = $true
    throw "Process survivor check enumeration failed: $($_.Exception.Message)"
  }

  if ($survivorDetails.Count -gt 0) {
    $script:hasSurvivors = $true
    $script:overallFailed = $true
    $errMessage = "Process cleanup failed - surviving processes detected:`n" + ($survivorDetails -join "`n")
    throw $errMessage
  }
}

function Normalize-Path([string]$path) {
  if ([string]::IsNullOrWhiteSpace($path)) { return '' }
  try {
    return [System.IO.Path]::GetFullPath($path).Replace('\', '/').TrimEnd('/').ToLowerInvariant()
  } catch {
    return $path.Replace('\', '/').TrimEnd('/').ToLowerInvariant()
  }
}

function Cleanup-TaskWorktrees {
  if ([string]::IsNullOrWhiteSpace($tempRepo) -or -not (Test-Path -LiteralPath $tempRepo)) { return }
  if ([string]::IsNullOrWhiteSpace($stateDir) -or -not (Test-Path -LiteralPath $stateDir)) { return }
  $wtBase = Join-Path $stateDir 'worktrees'
  if (Test-Path -LiteralPath $wtBase) {
    $dirs = @(Get-ChildItem -LiteralPath $wtBase -Directory -ErrorAction SilentlyContinue)
    foreach ($d in $dirs) {
      if (-not (Test-Path -LiteralPath $d.FullName)) { continue }
      $out = & git -C $tempRepo worktree remove --force "$($d.FullName)" 2>&1
      $code = $LASTEXITCODE
      if ($code -ne 0) {
        $pruneFallbackOut = & git -C $tempRepo worktree prune 2>&1
        $pruneFallbackCode = $LASTEXITCODE
        if ($pruneFallbackCode -ne 0) {
          throw "Fallback 'git worktree prune' failed with code ${pruneFallbackCode}: $($pruneFallbackOut -join ' ')"
        }

        $wtListRaw = & git -C $tempRepo worktree list --porcelain 2>&1
        $wtListCode = $LASTEXITCODE
        if ($wtListCode -ne 0) {
          throw "'git worktree list --porcelain' failed with code ${wtListCode}: $($wtListRaw -join ' ')"
        }

        $normD = Normalize-Path $d.FullName
        $normalizedActiveWorktrees = @($wtListRaw | Where-Object { $_ -match '^worktree\s+(.+)$' } | ForEach-Object { Normalize-Path $Matches[1].Trim() })
        if ($normalizedActiveWorktrees -contains $normD) {
          throw "Worktree removal failed for '$($d.FullName)' with code ${code}: $($out -join ' ')"
        }
      }
    }
  }
  $pruneOut = & git -C $tempRepo worktree prune 2>&1
  $pruneCode = $LASTEXITCODE
  if ($pruneCode -ne 0) {
    throw "git worktree prune failed with code ${pruneCode}: $($pruneOut -join ' ')"
  }
}

function Invoke-FactoryStatus([string]$sDir) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = if ($script:nodeExe) { $script:nodeExe } else { 'node' }
  $cliPath = if ($dest -and (Test-Path -LiteralPath (Join-Path $dest 'lib\factory.mjs'))) {
    Join-Path $dest 'lib\factory.mjs'
  } else {
    'lib/factory.mjs'
  }
  $psi.Arguments = "`"$cliPath`" status --state-dir `"$sDir`" --json"
  $psi.WorkingDirectory = if ($dest -and (Test-Path -LiteralPath $dest)) { $dest } else { $PWD.Path }
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $proc = [System.Diagnostics.Process]::Start($psi)
  $null = $proc.Handle
  $script:startedProcesses.Add($proc)
  Register-TrackedPid $proc.Id

  $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
  $stderrTask = $proc.StandardError.ReadToEndAsync()

  $timeoutMs = 10000
  $exited = $proc.WaitForExit($timeoutMs)
  if (-not $exited) {
    try {
      $proc.Kill()
      [void]$proc.WaitForExit(2000)
    } catch {}
    throw "factory status timed out after ${timeoutMs}ms"
  }

  [void]$stdoutTask.Wait(3000)
  [void]$stderrTask.Wait(3000)
  $stdout = $stdoutTask.Result
  $stderr = $stderrTask.Result
  $code = $proc.ExitCode
  if ($code -ne 0) {
    throw "factory status failed with exit code ${code}: $stderr"
  }
  try {
    return ($stdout | ConvertFrom-Json)
  } catch {
    throw "factory status JSON parse failed: $($_.Exception.Message)`nRaw stdout: $stdout`nRaw stderr: $stderr"
  }
}

function Step($n, $label, [scriptblock]$cmd = $null, [switch]$Skip) {
  Write-Host "`n[$n] $label" -ForegroundColor Cyan
  if ($Skip) {
    Write-Host 'SKIP' -ForegroundColor Yellow
    $script:results += [pscustomobject]@{ Step = $n; Check = $label; Result = 'SKIP' }
    return $true
  }
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

function Skip-Step($n, $label) {
  Step $n $label -Skip | Out-Null
}

try {
  $origConsoleEncoding = [Console]::OutputEncoding
  $origInputEncoding = [Console]::InputEncoding
  $origOutputEncoding = $OutputEncoding
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  [Console]::InputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8

  # Resolve the real node binary once early
  $rawNodeExe = & node -p "process.execPath"
  $nodeResCode = $LASTEXITCODE
  if ($nodeResCode -ne 0) {
    throw "Failed to resolve node executable via 'node -p process.execPath' with code ${nodeResCode}"
  }
  $resolvedNode = ($rawNodeExe -join '').Trim()
  if ([string]::IsNullOrWhiteSpace($resolvedNode) -or -not (Test-Path -LiteralPath $resolvedNode)) {
    throw "Resolved node executable does not exist or is invalid: '$resolvedNode'"
  }
  $script:nodeExe = $resolvedNode

  $ErrorActionPreference = 'Stop'

  if ([string]::IsNullOrWhiteSpace($env:TEMP)) {
    throw 'TEMP environment variable is not set'
  }

  $origLocation = $PWD.Path

  $pnpm = if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
    Join-Path $env:USERPROFILE '.local\c2c-tools\pnpm.CMD'
  } else { 'pnpm' }
  if (-not (Test-Path $pnpm)) { $pnpm = 'pnpm' }

  # Create per-run directory under shared base without removing shared base or other concurrent runs
  New-Item -ItemType Directory -Path $sharedBase -Force | Out-Null
  New-Item -ItemType Directory -Path $acceptanceBase -Force | Out-Null
  New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
  New-Item -ItemType Directory -Path $helpersDir -Force | Out-Null

  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  $verifyEvidenceScript = Join-Path $helpersDir 'verify-evidence.mjs'
  $arrangePendingScript = Join-Path $helpersDir 'arrange-pending-commit.mjs'
  $checkCrashBoundaryScript = Join-Path $helpersDir 'check-crash-boundary.mjs'

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

  $arrangePendingCode = @'
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const stateDir = process.env.FACTORY_STATE_DIR;
const taskId = process.env.FACTORY_TASK_ID;
const runDirOverride = process.env.FACTORY_RUN_DIR;

if (!stateDir || !taskId) {
  process.stderr.write('Missing required environment variables FACTORY_STATE_DIR or FACTORY_TASK_ID\n');
  process.exit(1);
}

const dbPath = join(stateDir, 'state.sqlite');
const db = new DatabaseSync(dbPath);
try {
  db.exec('PRAGMA busy_timeout = 5000');
  const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId);
  if (!task) {
    process.stderr.write(`Task not found: ${taskId}\n`);
    process.exit(1);
  }

  const attempt = db.prepare("SELECT id FROM attempts WHERE task_id = ? AND status = 'running'").get(taskId);
  if (!attempt) {
    process.stderr.write(`Running attempt not found for task: ${taskId}\n`);
    process.exit(1);
  }

  const config = db.prepare('SELECT base_ref FROM project_config JOIN tasks ON tasks.project_id = project_config.project_id WHERE tasks.id = ?').get(taskId);
  if (!config) {
    process.stderr.write(`Project config not found for task: ${taskId}\n`);
    process.exit(1);
  }

  const runDir = runDirOverride || join(stateDir, 'runs', attempt.id);
  const resultFile = join(runDir, 'result.json');
  let result;
  try {
    result = JSON.parse(readFileSync(resultFile, 'utf8'));
  } catch (err) {
    process.stderr.write(`Failed to read result.json from ${runDir}: ${err}\n`);
    process.exit(1);
  }

  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE workers SET state = 'exited', ended_at = ? WHERE attempt_id = ?").run(now, attempt.id);
    db.prepare("UPDATE attempts SET status = 'succeeded', exit_code = ?, ended_at = ? WHERE id = ?").run(result.exitCode, now, attempt.id);
    db.prepare("UPDATE tasks SET status = 'progress', updated_at = ? WHERE id = ?").run(now, taskId);
    db.prepare(`INSERT INTO outbox (id, idempotency_key, kind, payload_json, status, tries, next_attempt_ms, last_error, created_at, updated_at)
      VALUES (?, ?, 'evidence.commit', ?, 'pending', 0, ?, NULL, ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING`)
      .run(
        randomUUID(),
        `evidence.commit:${attempt.id}`,
        JSON.stringify({
          attemptId: attempt.id,
          worktreePath: join(stateDir, 'worktrees', taskId),
          baseSha: config.base_ref,
          stdoutPath: join(runDir, 'stdout.log'),
          stderrPath: join(runDir, 'stderr.log'),
          exitCode: result.exitCode,
        }),
        nowMs,
        now,
        now,
      );
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    process.stderr.write(`Database transaction failed: ${e}\n`);
    process.exit(1);
  }
  process.stdout.write('arranged pending commit\n');
  process.exit(0);
} finally {
  db.close();
}
'@
  [System.IO.File]::WriteAllText($arrangePendingScript, $arrangePendingCode, $utf8NoBom)

  $checkCrashBoundaryCode = @'
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const stateDir = process.env.FACTORY_STATE_DIR;
const taskId = process.env.FACTORY_TASK_ID;

if (!stateDir || !taskId) {
  process.stderr.write('Missing FACTORY_STATE_DIR or FACTORY_TASK_ID\n');
  process.exit(1);
}

const dbPath = join(stateDir, 'state.sqlite');
const db = new DatabaseSync(dbPath);
try {
  db.exec('PRAGMA busy_timeout = 5000');
  const attempts = db.prepare('SELECT id, status FROM attempts WHERE task_id = ?').all(taskId);
  if (attempts.length === 0) {
    process.stderr.write('No attempts found for task\n');
    process.exit(1);
  }
  const attemptId = attempts[0].id;

  const evRows = db.prepare('SELECT head_sha FROM evidence WHERE attempt_id = ?').all(attemptId);
  if (evRows.length !== 1) {
    process.stderr.write(`Expected exactly 1 evidence row, found ${evRows.length}\n`);
    process.exit(1);
  }

  const outboxRow = db.prepare('SELECT status FROM outbox WHERE idempotency_key = ?').get(`evidence.commit:${attemptId}`);
  if (!outboxRow || outboxRow.status !== 'pending') {
    process.stderr.write(`Expected outbox status pending, found ${outboxRow?.status}\n`);
    process.exit(1);
  }

  process.stdout.write(JSON.stringify({ headSha: evRows[0].head_sha, outboxStatus: outboxRow.status }));
  process.exit(0);
} finally {
  db.close();
}
'@
  [System.IO.File]::WriteAllText($checkCrashBoundaryScript, $checkCrashBoundaryCode, $utf8NoBom)

  Write-Host "Clone destination: $dest"

  # 1) Node version: 24 or 26
  if (-not (Step 1 'Node version is 24 or 26' {
    $v = & $script:nodeExe -v
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
  if ($SkipBaseline) {
    Skip-Step 4 'Typecheck'
  } elseif (-not (Step 4 'Typecheck' { & $pnpm typecheck })) { throw 'Step 4 failed' }
  # 5) All tests
  if ($SkipBaseline) {
    Skip-Step 5 'All tests'
  } elseif (-not (Step 5 'All tests' { & $pnpm test })) { throw 'Step 5 failed' }
  # 6) Build
  if (-not (Step 6 'Build' { & $pnpm build })) { throw 'Step 6 failed' }
  # 7) Manifest check
  if ($SkipBaseline) {
    Skip-Step 7 'Manifest: ported files match dsh'
  } elseif (-not (Step 7 'Manifest: ported files match dsh' { & $script:nodeExe scripts/check-manifest.mjs })) { throw 'Step 7 failed' }
  # 8) No forbidden imports
  if ($SkipBaseline) {
    Skip-Step 8 'No forbidden imports'
  } elseif (-not (Step 8 'No forbidden imports' { & $script:nodeExe scripts/check-forbidden-imports.mjs })) { throw 'Step 8 failed' }
  # 9) Traceability check
  if ($SkipBaseline) {
    Skip-Step 9 'Every DoD check has passing evidence'
  } elseif (-not (Step 9 'Every DoD check has passing evidence' { & $script:nodeExe scripts/check-traceability.mjs --all --require-passing })) { throw 'Step 9 failed' }

  # 10) Init factory project with fresh git repository
  if (-not (Step 10 'Init factory project with fresh git repository' {
    $ErrorActionPreference = 'Continue'
    if (Test-Path -LiteralPath $tempRepo) { Remove-Item -LiteralPath $tempRepo -Recurse -Force }
    New-Item -ItemType Directory -Path $tempRepo -Force | Out-Null

    $outInit = & git -C $tempRepo init -q 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git init failed: $($outInit -join ' ')" }
    $outCo = & git -C $tempRepo checkout -B main -q 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git checkout failed: $($outCo -join ' ')" }
    $outName = & git -C $tempRepo config user.name "M3 Acceptance" 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git config user.name failed: $($outName -join ' ')" }
    $outEmail = & git -C $tempRepo config user.email "acceptance@factory.local" 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git config user.email failed: $($outEmail -join ' ')" }
    $outCommit = & git -C $tempRepo commit --allow-empty -m "Initial commit" -q 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git commit failed: $($outCommit -join ' ')" }

    $baseShaRaw = & git -C $tempRepo rev-parse HEAD
    if ($LASTEXITCODE -ne 0) { throw "git rev-parse HEAD failed" }
    $baseSha = ($baseShaRaw -join '').Trim()
    $script:baseSha = $baseSha
    Write-Host "Demo repository initialized at $tempRepo with baseSha $baseSha"

    if (-not (Test-Path -LiteralPath $stateDir)) {
      New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    }

    $raw = & $script:nodeExe lib/factory.mjs init --state-dir "$stateDir" --repo "$tempRepo" 2>&1
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

    $raw1 = & $script:nodeExe lib/factory.mjs task create --state-dir "$stateDir" --title "M3 Demo Task 1" --command-id $tId 2>&1
    $code1 = $LASTEXITCODE
    $res1 = $raw1 | ForEach-Object { "$_" }
    foreach ($line in $res1) { Write-Host $line }
    $createdValid = ($code1 -eq 0) -and ($res1.Count -ge 1) -and ($res1[0] -match "^created $tId$")

    $raw2 = & $script:nodeExe lib/factory.mjs task create --state-dir "$stateDir" --title "M3 Demo Task 1" --command-id $tId 2>&1
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
    $sup1 = Start-Process -FilePath $script:nodeExe `
      -ArgumentList "lib/factory.mjs start --state-dir `"$stateDir`" --stale-after-ms 2000 --heartbeat-ms 500" `
      -RedirectStandardOutput $sup1Out `
      -RedirectStandardError $sup1Err `
      -PassThru `
      -NoNewWindow
    $null = $sup1.Handle
    $script:startedProcesses.Add($sup1)
    Register-TrackedPid $sup1.Id
    $script:sup1Process = $sup1
    $script:sup1Pid = $sup1.Id
    Remove-Item env:FAKE_SLEEP_MS -ErrorAction SilentlyContinue

    $timeoutSec = 30
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $workerRunning = $false

    while ($sw.Elapsed.TotalSeconds -lt $timeoutSec) {
      if ($sup1.HasExited) {
        Write-Host "Supervisor unexpectedly exited prematurely with code $($sup1.ExitCode)" -ForegroundColor Red
        break
      }

      try {
        $parsed = Invoke-FactoryStatus $stateDir
        if ($null -ne $parsed.tasks -and @($parsed.tasks).Count -ge 1) {
          $task = @(@($parsed.tasks) | Where-Object { $_.id -eq $script:taskId1 })[0]
          if ($null -ne $task -and $task.status -eq 'progress' -and @($task.attempts).Count -ge 1) {
            $att = @($task.attempts)[0]
            if ($att.status -eq 'running' -and $null -ne $att.worker -and $att.worker.state -eq 'running' -and $att.worker.pid -gt 0) {
              $script:worker1Pid = $att.worker.pid
              Register-TrackedPid $att.worker.pid
              $workerRunning = $true
              break
            }
          }
        }
      } catch {}
      Start-Sleep -Milliseconds 200
    }
    [void]$sw.Stop()

    if (-not $workerRunning) {
      Write-Host "Timeout waiting for worker to reach running state" -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }

    # Harvest worker.json to find grandchild PID and worker nonce with bounded deadline polling
    $runsDir = Join-Path $stateDir 'runs'
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $foundJson = $false
    while ($sw.Elapsed.TotalSeconds -lt 20) {
      if (Test-Path -LiteralPath $runsDir) {
        $workerJsonFiles = @(Get-ChildItem -LiteralPath $runsDir -Filter 'worker.json' -Recurse -ErrorAction SilentlyContinue)
        foreach ($wf in $workerJsonFiles) {
          try {
            $rawContent = Get-Content -LiteralPath $wf.FullName -Raw
            $wJson = $rawContent | ConvertFrom-Json
            if ($null -ne $wJson -and $wJson.pid -eq $script:worker1Pid -and $null -ne $wJson.grandchildPid -and $wJson.grandchildPid -gt 0 -and -not [string]::IsNullOrWhiteSpace($wJson.nonce)) {
              $script:worker1GrandchildPid = [int]$wJson.grandchildPid
              $script:worker1Nonce = $wJson.nonce
              $script:trackedWorkerNonces.Add($wJson.nonce)
              Register-TrackedPid $script:worker1Pid $wJson.nonce
              Register-TrackedPid $script:worker1GrandchildPid $wJson.nonce
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
    if ($foundJson -and $null -ne $script:worker1Pid -and $null -ne $script:worker1GrandchildPid -and $script:worker1GrandchildPid -gt 0) {
      $global:LASTEXITCODE = 0
    } else {
      $global:LASTEXITCODE = 1
    }
  })) { throw 'Step 12 failed' }

  # 13) Stop the Supervisor only and assert the executor pid from worker.json is alive
  if (-not (Step 13 'Stop supervisor and assert orphaned executor and grandchild are alive' {
    $ErrorActionPreference = 'Continue'
    $supPid = if ($null -ne $script:sup1Process) { $script:sup1Process.Id } else { $script:sup1Pid }
    if ($null -eq $supPid -or $supPid -le 0) {
      Write-Host "Supervisor PID not recorded" -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }

    if ($null -ne $script:sup1Process -and -not $script:sup1Process.HasExited) {
      $script:sup1Process.Kill()
      [void]$script:sup1Process.WaitForExit(5000)
    }

    # Bounded wait to confirm the real supervisor PID is dead
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $supDead = $false
    while ($sw.Elapsed.TotalSeconds -lt 5) {
      $pSup = Get-Process -Id $supPid -ErrorAction SilentlyContinue
      if (($null -eq $pSup -or $pSup.HasExited) -and ($null -eq $script:sup1Process -or $script:sup1Process.HasExited)) {
        $supDead = $true
        break
      }
      Start-Sleep -Milliseconds 100
    }
    [void]$sw.Stop()

    if (-not $supDead) {
      Write-Host "Real Supervisor PID $supPid failed to stop" -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }

    $executorProc = Get-Process -Id $script:worker1Pid -ErrorAction SilentlyContinue
    $executorAlive = ($null -ne $executorProc) -and (-not $executorProc.HasExited)

    $grandchildProc = Get-Process -Id $script:worker1GrandchildPid -ErrorAction SilentlyContinue
    $grandchildAlive = ($null -ne $grandchildProc) -and (-not $grandchildProc.HasExited)

    Write-Host "Supervisor PID $supPid dead: $supDead; Executor alive: $executorAlive; Grandchild alive: $grandchildAlive"
    if ($supDead -and $executorAlive -and $grandchildAlive) {
      $global:LASTEXITCODE = 0
    } else {
      $global:LASTEXITCODE = 1
    }
  })) { throw 'Step 13 failed' }

  # 14) Restart with --takeover from status after the short stale window and --exit-when-idle
  if (-not (Step 14 'Restart supervisor with takeover after stale window and exit-when-idle' {
    $ErrorActionPreference = 'Continue'
    $parsed = Invoke-FactoryStatus $stateDir
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

    $supRestart = Start-Process -FilePath $script:nodeExe `
      -ArgumentList "lib/factory.mjs start --state-dir `"$stateDir`" --takeover $takeover --exit-when-idle --stale-after-ms 2000 --heartbeat-ms 500" `
      -RedirectStandardOutput $supRestartOut `
      -RedirectStandardError $supRestartErr `
      -PassThru `
      -NoNewWindow
    $null = $supRestart.Handle
    $script:startedProcesses.Add($supRestart)
    Register-TrackedPid $supRestart.Id

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

  # 15) Assert executor and grandchild gone, one task done, attempts interrupted+succeeded, evidence, commit on task branch
  if (-not (Step 15 'Takeover completes task done, interrupted+succeeded attempts, evidence and commit' {
    $ErrorActionPreference = 'Continue'
    $pExec = Get-Process -Id $script:worker1Pid -ErrorAction SilentlyContinue
    $pGrand = Get-Process -Id $script:worker1GrandchildPid -ErrorAction SilentlyContinue
    $execGone = ($null -eq $pExec -or $pExec.HasExited)
    $grandGone = ($null -eq $pGrand -or $pGrand.HasExited)
    Write-Host "Executor gone: $execGone (PID=$($script:worker1Pid)); Grandchild gone: $grandGone (PID=$($script:worker1GrandchildPid))"

    $parsed = Invoke-FactoryStatus $stateDir
    $tasks = if ($null -ne $parsed -and $null -ne $parsed.tasks) { @($parsed.tasks) } else { @() }
    $task = @($tasks | Where-Object { $_.id -eq $script:taskId1 })[0]
    $taskStatus = if ($null -ne $task) { $task.status } else { 'missing' }
    $taskDone = ($null -ne $task) -and ($taskStatus -eq 'done')
    Write-Host "Task 1 done: $taskDone (status=$taskStatus, expected=done)"

    $attempts = if ($null -ne $task -and $null -ne $task.attempts) { @($task.attempts) } else { @() }
    $attemptsValid = $false
    if ($attempts.Count -eq 2) {
      $a1 = $attempts[0]
      $a2 = $attempts[1]
      if ($a1.no -eq 1 -and $a1.status -eq 'interrupted' -and $a2.no -eq 2 -and $a2.status -eq 'succeeded') {
        $attemptsValid = $true
      }
    }
    $attemptsSummary = ($attempts | ForEach-Object { "#$($_.no):$($_.status)" }) -join ', '
    Write-Host "Attempts interrupted + succeeded: $attemptsValid (count=$($attempts.Count), expected=2, attempts=[$attemptsSummary])"

    # Count attempts whose evidence is not $null (wrap arrays with @() - ConvertFrom-Json unwraps single-element arrays), take headSha from that one
    $withEvidence = @($attempts | Where-Object { $null -ne $_.evidence })
    $evidenceCount = $withEvidence.Count
    $singleEvidenceRow = ($evidenceCount -eq 1)
    Write-Host "Exactly one evidence row across attempts: $singleEvidenceRow (count=$evidenceCount, expected=1)"

    $evidence = if ($singleEvidenceRow) { $withEvidence[0].evidence } else { $null }
    $evidenceHeadSha = if ($null -ne $evidence) { $evidence.headSha } else { $null }
    $evidenceFiles = if ($null -ne $evidence -and $null -ne $evidence.files) { @($evidence.files) } else { @() }

    $evidenceValid = $false
    if ($singleEvidenceRow -and $null -ne $evidence -and -not [string]::IsNullOrWhiteSpace($evidenceHeadSha)) {
      $env:FACTORY_WT_DIR = Join-Path $stateDir "worktrees\$($script:taskId1)"
      $env:FACTORY_HEAD_SHA = $evidenceHeadSha
      $env:FACTORY_FILES_JSON = ($evidenceFiles | ConvertTo-Json -Compress)
      $rawVerify = & $script:nodeExe "$verifyEvidenceScript" 2>&1
      $verifyCode = $LASTEXITCODE
      Remove-Item env:FACTORY_WT_DIR, env:FACTORY_HEAD_SHA, env:FACTORY_FILES_JSON -ErrorAction SilentlyContinue
      foreach ($l in $rawVerify) { Write-Host "VERIFY: $l" }
      $evidenceValid = ($verifyCode -eq 0)
    }
    Write-Host "Evidence verified: $evidenceValid (headSha=$evidenceHeadSha, filesCount=$($evidenceFiles.Count))"

    # Verify task branch factory/task/<id> exists, matches evidence headSha, and has exactly 1 commit above base
    $branchRef = "refs/heads/factory/task/$($script:taskId1)"
    $branchShaRaw = & git -C $tempRepo rev-parse --verify $branchRef 2>&1
    $branchShaCode = $LASTEXITCODE
    $branchSha = ($branchShaRaw -join '').Trim()
    $branchExists = ($branchShaCode -eq 0) -and ($branchSha -match '^[0-9a-f]{40}$')

    $branchShaMatches = ($branchExists -and $singleEvidenceRow -and ($branchSha -eq $evidenceHeadSha))

    $branchCommitRaw = & git -C $tempRepo rev-list --count $branchRef "^$($script:baseSha)" 2>&1
    $branchCommitCode = $LASTEXITCODE
    $branchCommitCount = ($branchCommitRaw -join '').Trim()
    $branchCommitValid = ($branchCommitCode -eq 0) -and ($branchCommitCount -eq '1')
    Write-Host "Task branch exists: $branchExists (ref=$branchRef); SHA matches evidence: $branchShaMatches (branchSha=$branchSha, evidenceHeadSha=$evidenceHeadSha); Commits above base on branch: $branchCommitCount (expected=1)"

    if ($execGone -and $grandGone -and $taskDone -and $attemptsValid -and $singleEvidenceRow -and $evidenceValid -and $branchShaMatches -and $branchCommitValid) {
      $global:LASTEXITCODE = 0
    } else {
      $global:LASTEXITCODE = 1
    }
  })) { throw 'Step 15 failed' }

  $script:taskId2 = [guid]::NewGuid().ToString().ToLowerInvariant()
  $script:worker2Pid = $null
  $script:worker2GrandchildPid = $null
  $script:worker2Nonce = $null
  $faultCommitSha = $null

  # 16) Outbox crash: commit-side crash with FACTORY_FAULT=outbox-after-effect terminates supervisor non-zero after commit created
  if (-not (Step 16 'Outbox crash: pending evidence.commit under FACTORY_FAULT=outbox-after-effect ends supervisor non-zero at commit boundary' {
    $ErrorActionPreference = 'Continue'
    $tId = $script:taskId2

    $rawCreate = & $script:nodeExe lib/factory.mjs task create --state-dir "$stateDir" --title "Task 2 Fault" --command-id $tId 2>&1
    $codeCreate = $LASTEXITCODE
    $resCreate = $rawCreate | ForEach-Object { "$_" }
    foreach ($line in $resCreate) { Write-Host $line }
    if ($codeCreate -ne 0 -or -not ($resCreate[0] -match "^created $tId$")) {
      Write-Host "Failed to create task 2" -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }

    # Start Supervisor without fault first, allowing worktree.ensure and attempt.start to apply cleanly
    $supPreOut = Join-Path $logsDir 'sup2-pre.out.log'
    $supPreErr = Join-Path $logsDir 'sup2-pre.err.log'

    $env:FAKE_SLEEP_MS = '2500'
    $supPre = Start-Process -FilePath $script:nodeExe `
      -ArgumentList "lib/factory.mjs start --state-dir `"$stateDir`" --stale-after-ms 2000 --heartbeat-ms 500" `
      -RedirectStandardOutput $supPreOut `
      -RedirectStandardError $supPreErr `
      -PassThru `
      -NoNewWindow
    $null = $supPre.Handle
    $script:startedProcesses.Add($supPre)
    Register-TrackedPid $supPre.Id
    Remove-Item env:FAKE_SLEEP_MS -ErrorAction SilentlyContinue

    # Poll status until worker is running
    $timeoutSec = 20
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $running = $false
    $lastObservedTask2 = 'none'
    while ($sw.Elapsed.TotalSeconds -lt $timeoutSec) {
      if ($supPre.HasExited) { break }
      try {
        $parsed = Invoke-FactoryStatus $stateDir
        $task2 = @(@($parsed.tasks) | Where-Object { $_.id -eq $tId })[0]
        if ($null -ne $task2) {
          $attCount = if ($null -ne $task2.attempts) { @($task2.attempts).Count } else { 0 }
          $lastObservedTask2 = "status=$($task2.status), attempts=$attCount"
          if ($task2.status -eq 'progress' -and $attCount -ge 1) {
            $att = @($task2.attempts)[0]
            $wState = if ($null -ne $att.worker) { $att.worker.state } else { 'null' }
            $wPid = if ($null -ne $att.worker) { $att.worker.pid } else { 'null' }
            $lastObservedTask2 = "status=$($task2.status), attStatus=$($att.status), workerState=$wState, workerPid=$wPid"
            if ($att.status -eq 'running' -and $null -ne $att.worker -and $att.worker.state -eq 'running' -and $att.worker.pid -gt 0) {
              $script:worker2Pid = $att.worker.pid
              if ($null -ne $att.id) {
                $script:attemptId2 = $att.id
              }
              Register-TrackedPid $att.worker.pid
              $running = $true
              break
            }
          }
        }
      } catch {
        $lastObservedTask2 = "status error: $($_.Exception.Message)"
      }
      Start-Sleep -Milliseconds 200
    }
    [void]$sw.Stop()

    if (-not $running) {
      Write-Host "Task 2 worker failed to reach running state within ${timeoutSec}s timeout. Last observed: $lastObservedTask2" -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }

    # Harvest worker.json to find worker nonce, grandchild, and run directory
    $worker2RunDir = $null
    $runsDir = Join-Path $stateDir 'runs'
    $timeoutSec = 15
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $lastObservedWorker = 'none'
    while ($sw.Elapsed.TotalSeconds -lt $timeoutSec) {
      if (Test-Path -LiteralPath $runsDir) {
        $workerJsonFiles = @(Get-ChildItem -LiteralPath $runsDir -Filter 'worker.json' -Recurse -ErrorAction SilentlyContinue)
        foreach ($wf in $workerJsonFiles) {
          try {
            $wj = (Get-Content -LiteralPath $wf.FullName -Raw) | ConvertFrom-Json
            $lastObservedWorker = "PID=$($wj.pid), Grandchild=$($wj.grandchildPid), Nonce=$($wj.nonce), Dir=$($wf.DirectoryName)"
            if ($wj.pid -eq $script:worker2Pid -and $null -ne $wj.grandchildPid -and $wj.grandchildPid -gt 0 -and -not [string]::IsNullOrWhiteSpace($wj.nonce)) {
              $script:worker2GrandchildPid = [int]$wj.grandchildPid
              $script:worker2Nonce = $wj.nonce
              $script:trackedWorkerNonces.Add($wj.nonce)
              Register-TrackedPid $script:worker2Pid $wj.nonce
              Register-TrackedPid $script:worker2GrandchildPid $wj.nonce
              $worker2RunDir = $wf.DirectoryName
              $script:attemptId2 = $wf.Directory.Name
              break
            }
          } catch {}
        }
      }
      if ($null -ne $script:worker2GrandchildPid -and -not [string]::IsNullOrWhiteSpace($worker2RunDir)) { break }
      Start-Sleep -Milliseconds 100
    }
    [void]$sw.Stop()

    if ($null -eq $script:worker2GrandchildPid -or [string]::IsNullOrWhiteSpace($worker2RunDir)) {
      Write-Host "Failed to find worker.json for worker 2 (PID=$($script:worker2Pid)) within ${timeoutSec}s timeout. Last observed: $lastObservedWorker" -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }

    # Stop supervisor cleanly so we can intercept before evidence.commit
    if (-not $supPre.HasExited) {
      $supPre.Kill()
      [void]$supPre.WaitForExit(5000)
    }

    # Wait bounded for the executor to complete its work and write result.json
    $resultDir = if (-not [string]::IsNullOrWhiteSpace($worker2RunDir)) { $worker2RunDir } elseif (-not [string]::IsNullOrWhiteSpace($script:attemptId2)) { Join-Path $runsDir $script:attemptId2 } else { $runsDir }
    $resultFile = Join-Path $resultDir 'result.json'
    $timeoutSec = 15
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $resultFound = $false
    $lastObservedResult = $false
    while ($sw.Elapsed.TotalSeconds -lt $timeoutSec) {
      $lastObservedResult = Test-Path -LiteralPath $resultFile
      if ($lastObservedResult) {
        $resultFound = $true
        break
      }
      Start-Sleep -Milliseconds 150
    }
    [void]$sw.Stop()

    if (-not $resultFound) {
      $presentFiles = if (Test-Path -LiteralPath $resultDir) {
        @((Get-ChildItem -LiteralPath $resultDir -ErrorAction SilentlyContinue) | ForEach-Object { $_.Name }) -join ', '
      } else {
        '<directory does not exist>'
      }
      Write-Host "Executor failed to write result.json within ${timeoutSec}s timeout. Waited for: '$resultFile'. Last observed: exists=$lastObservedResult. Files present in '$resultDir': [$presentFiles]" -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }

    # Wait for executor process to terminate
    $timeoutSec = 5
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $execExited = $false
    $lastObservedExec = 'running'
    while ($sw.Elapsed.TotalSeconds -lt $timeoutSec) {
      $p = Get-Process -Id $script:worker2Pid -ErrorAction SilentlyContinue
      $lastObservedExec = if ($null -eq $p) { 'exited' } else { "running (PID=$($p.Id), HasExited=$($p.HasExited))" }
      if ($null -eq $p -or $p.HasExited) {
        $execExited = $true
        break
      }
      Start-Sleep -Milliseconds 100
    }
    [void]$sw.Stop()

    if (-not $execExited) {
      Write-Host "Executor PID $($script:worker2Pid) failed to terminate within ${timeoutSec}s timeout. Last observed: $lastObservedExec" -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }

    # Arrange pending evidence.commit in outbox with worker exited and attempt succeeded
    $env:FACTORY_STATE_DIR = $stateDir
    $env:FACTORY_TASK_ID = $tId
    $env:FACTORY_RUN_DIR = $worker2RunDir
    $rawArrange = & $script:nodeExe "$arrangePendingScript" 2>&1
    $codeArrange = $LASTEXITCODE
    Remove-Item env:FACTORY_STATE_DIR, env:FACTORY_TASK_ID, env:FACTORY_RUN_DIR -ErrorAction SilentlyContinue
    foreach ($l in $rawArrange) { Write-Host "ARRANGE: $l" }
    if ($codeArrange -ne 0) {
      Write-Host "Failed to arrange pending evidence.commit" -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }

    # Query lease status for takeover after stale window
    $parsed = Invoke-FactoryStatus $stateDir
    $takeover = $parsed.lease.takeover
    $heartbeatMs = $parsed.lease.heartbeatMs
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $staleDeadline = $heartbeatMs + 2000 + 500
    $waitMs = $staleDeadline - $nowMs
    if ($waitMs -gt 0) {
      Write-Host "Waiting $waitMs ms for lease stale window..."
      Start-Sleep -Milliseconds $waitMs
    }

    $supFaultOut = Join-Path $logsDir 'sup-fault.out.log'
    $supFaultErr = Join-Path $logsDir 'sup-fault.err.log'

    # Start Supervisor with FACTORY_FAULT=outbox-after-effect so next effect (evidence.commit) crashes
    $env:FACTORY_FAULT = 'outbox-after-effect'
    $supFault = Start-Process -FilePath $script:nodeExe `
      -ArgumentList "lib/factory.mjs start --state-dir `"$stateDir`" --takeover $takeover --stale-after-ms 2000 --heartbeat-ms 500" `
      -RedirectStandardOutput $supFaultOut `
      -RedirectStandardError $supFaultErr `
      -PassThru `
      -NoNewWindow
    $null = $supFault.Handle
    $script:startedProcesses.Add($supFault)
    Register-TrackedPid $supFault.Id
    Remove-Item env:FACTORY_FAULT -ErrorAction SilentlyContinue

    $timeoutSec = 30
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $lastObservedFault = 'running'
    while (-not $supFault.HasExited -and $sw.Elapsed.TotalSeconds -lt $timeoutSec) {
      $lastObservedFault = "HasExited=$($supFault.HasExited), ExitCode=$($supFault.ExitCode)"
      Start-Sleep -Milliseconds 200
    }
    [void]$sw.Stop()

    $faultExited = $supFault.HasExited
    $faultCode = $supFault.ExitCode
    Write-Host "Supervisor with fault exited: $faultExited; ExitCode: $faultCode"

    if (-not $faultExited -or $faultCode -eq 0) {
      Write-Host "Supervisor under fault unexpectedly did not exit non-zero within ${timeoutSec}s timeout. Last observed: $lastObservedFault" -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }

    # CRASH BOUNDARY ASSERTIONS:
    # 1. Commit on task branch factory/task/<id> ALREADY exists at the crash boundary
    $branchRef = "refs/heads/factory/task/$tId"
    $fShaRaw = & git -C $tempRepo rev-parse --verify $branchRef 2>&1
    $fShaCode = $LASTEXITCODE
    $fSha = ($fShaRaw -join '').Trim()
    if ($fShaCode -ne 0 -or -not ($fSha -match '^[0-9a-f]{40}$')) {
      Write-Host "Commit on task branch does not exist at crash boundary" -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }
    $script:faultCommitSha = $fSha
    Write-Host "Crash boundary commit exists on branch: $fSha"

    # Commit must contain the attempt trailer
    $commitMsgRaw = & git -C $tempRepo log -1 --format=%B $fSha 2>&1
    $commitMsgCode = $LASTEXITCODE
    $commitMsg = $commitMsgRaw -join "`n"
    $escapedAttemptId2 = [regex]::Escape($script:attemptId2)
    $hasTrailer = ($commitMsgCode -eq 0) -and ($commitMsg -match "(?m)^Factory-Attempt:\s*${escapedAttemptId2}\s*$")
    Write-Host "Commit message at crash boundary contains attempt trailer: $hasTrailer"
    if (-not $hasTrailer) {
      Write-Host "Commit message at crash boundary does not contain attempt trailer (attemptId=$($script:attemptId2), message=$commitMsg)" -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }

    # Exactly 1 commit above base on task branch
    $commitCountBeforeRaw = & git -C $tempRepo rev-list --count $branchRef "^$($script:baseSha)" 2>&1
    $commitCountBeforeCode = $LASTEXITCODE
    $commitCountBefore = ($commitCountBeforeRaw -join '').Trim()
    $commitCountBeforeValid = ($commitCountBeforeCode -eq 0) -and ($commitCountBefore -eq '1')
    Write-Host "Crash boundary commit count: $commitCountBefore (expected=1)"
    if (-not $commitCountBeforeValid) {
      Write-Host "Expected 1 commit above base at crash boundary, found $commitCountBefore" -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }

    # 2. Evidence row exists in database, but outbox status is still pending (crash occurred before status=done)
    $env:FACTORY_STATE_DIR = $stateDir
    $env:FACTORY_TASK_ID = $tId
    $boundaryErrFile = Join-Path $logsDir 'boundary.err.log'
    $rawBoundary = & $script:nodeExe "$checkCrashBoundaryScript" 2> $boundaryErrFile
    $codeBoundary = $LASTEXITCODE
    Remove-Item env:FACTORY_STATE_DIR, env:FACTORY_TASK_ID -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $boundaryErrFile) {
      $errContent = Get-Content -LiteralPath $boundaryErrFile
      foreach ($l in $errContent) { Write-Host "BOUNDARY ERR: $l" -ForegroundColor Yellow }
    }
    foreach ($l in $rawBoundary) { Write-Host "BOUNDARY: $l" }
    if ($codeBoundary -ne 0) {
      Write-Host "Crash boundary database state check failed with code ${codeBoundary}" -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }

    $boundaryJsonText = ($rawBoundary -join "`n").Trim()
    $boundaryJson = $null
    try {
      $boundaryJson = $boundaryJsonText | ConvertFrom-Json
    } catch {
      Write-Host "Crash boundary JSON parse failed: $($_.Exception.Message)`nRaw stdout: $boundaryJsonText" -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }

    $boundaryHeadSha = if ($null -ne $boundaryJson) { $boundaryJson.headSha } else { $null }
    $boundaryOutboxStatus = if ($null -ne $boundaryJson) { $boundaryJson.outboxStatus } else { $null }
    $boundaryShaMatches = ($null -ne $boundaryHeadSha -and $boundaryHeadSha -eq $fSha)
    $boundaryOutboxPending = ($boundaryOutboxStatus -eq 'pending')
    Write-Host "Crash boundary evidence: SHA matches branch: $boundaryShaMatches (headSha=$boundaryHeadSha, branchSha=$fSha); Outbox status: $boundaryOutboxPending (status=$boundaryOutboxStatus, expected=pending)"

    if (-not $boundaryShaMatches -or -not $boundaryOutboxPending) {
      Write-Host "Crash boundary state mismatch" -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }

    $global:LASTEXITCODE = 0
  })) { throw 'Step 16 failed' }

  # 17) Restart without fault recovers outbox, commits, and records single evidence
  if (-not (Step 17 'Restart without fault recovers outbox, commits, and records single evidence' {
    $ErrorActionPreference = 'Continue'
    $tId = $script:taskId2
    $parsed = Invoke-FactoryStatus $stateDir
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

    $supRestart2 = Start-Process -FilePath $script:nodeExe `
      -ArgumentList "lib/factory.mjs start --state-dir `"$stateDir`" --takeover $takeover --exit-when-idle --stale-after-ms 2000 --heartbeat-ms 500" `
      -RedirectStandardOutput $supRestart2Out `
      -RedirectStandardError $supRestart2Err `
      -PassThru `
      -NoNewWindow
    $null = $supRestart2.Handle
    $script:startedProcesses.Add($supRestart2)
    Register-TrackedPid $supRestart2.Id

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while (-not $supRestart2.HasExited -and $sw.Elapsed.TotalSeconds -lt 60) {
      Start-Sleep -Milliseconds 200
    }
    [void]$sw.Stop()

    Write-Host "Restarted supervisor exited: $($supRestart2.HasExited); ExitCode: $($supRestart2.ExitCode)"
    if (-not $supRestart2.HasExited -or $supRestart2.ExitCode -ne 0) {
      Write-Host "Recovery supervisor failed to exit 0" -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }

    $parsed2 = Invoke-FactoryStatus $stateDir
    $tasks2 = if ($null -ne $parsed2 -and $null -ne $parsed2.tasks) { @($parsed2.tasks) } else { @() }
    $task2 = @($tasks2 | Where-Object { $_.id -eq $script:taskId2 })[0]
    $task2Status = if ($null -ne $task2) { $task2.status } else { 'missing' }
    $task2Done = ($null -ne $task2) -and ($task2Status -eq 'done')
    Write-Host "Task 2 done: $task2Done (status=$task2Status, expected=done)"

    # Count attempts whose evidence is not $null (wrap arrays with @() - ConvertFrom-Json unwraps single-element arrays), take headSha from that one
    $attempts2 = if ($null -ne $task2 -and $null -ne $task2.attempts) { @($task2.attempts) } else { @() }
    $withEvidence2 = @($attempts2 | Where-Object { $null -ne $_.evidence })
    $evidenceCount2 = $withEvidence2.Count
    $singleEvidenceRow2 = ($evidenceCount2 -eq 1)
    Write-Host "Task 2 exactly one evidence row: $singleEvidenceRow2 (count=$evidenceCount2, expected=1)"

    $evidence2 = if ($singleEvidenceRow2) { $withEvidence2[0].evidence } else { $null }
    $evidenceHeadSha2 = if ($null -ne $evidence2) { $evidence2.headSha } else { $null }
    $evidenceFiles2 = if ($null -ne $evidence2 -and $null -ne $evidence2.files) { @($evidence2.files) } else { @() }

    # Branch factory/task/<id> must exist with UNCHANGED head SHA from the crash boundary
    $branchRef = "refs/heads/factory/task/$tId"
    $recoveredShaRaw = & git -C $tempRepo rev-parse --verify $branchRef 2>&1
    $recoveredShaCode = $LASTEXITCODE
    $recoveredSha = ($recoveredShaRaw -join '').Trim()
    $branchExists2 = ($recoveredShaCode -eq 0) -and ($recoveredSha -match '^[0-9a-f]{40}$')

    $shaMatchesEvidence2 = ($branchExists2 -and $singleEvidenceRow2 -and ($recoveredSha -eq $evidenceHeadSha2))
    $shaUnchanged = ($branchExists2 -and ($recoveredSha -eq $script:faultCommitSha))

    $commitCountRaw = & git -C $tempRepo rev-list --count $branchRef "^$($script:baseSha)" 2>&1
    $commitCountCode = $LASTEXITCODE
    $commitCountAfter = ($commitCountRaw -join '').Trim()
    $commitCountValid = ($commitCountCode -eq 0) -and ($commitCountAfter -eq '1')

    Write-Host "Task 2 branch exists: $branchExists2 (ref=$branchRef); SHA matches evidence: $shaMatchesEvidence2 (branchSha=$recoveredSha, evidenceHeadSha=$evidenceHeadSha2); SHA unchanged from crash boundary: $shaUnchanged (branchSha=$recoveredSha, crashBoundarySha=$($script:faultCommitSha)); Commits above base on branch: $commitCountAfter (expected=1)"

    if ($task2Done -and $singleEvidenceRow2 -and $branchExists2 -and $shaMatchesEvidence2 -and $shaUnchanged -and $commitCountValid) {
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

    $rawCreate = & $script:nodeExe lib/factory.mjs task create --state-dir "$stateDir" --title "Task 3 Kill Test" --command-id $tId 2>&1
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
    $sup3 = Start-Process -FilePath $script:nodeExe `
      -ArgumentList "lib/factory.mjs start --state-dir `"$stateDir`" --exit-when-idle --stale-after-ms 2000 --heartbeat-ms 500" `
      -RedirectStandardOutput $sup3Out `
      -RedirectStandardError $sup3Err `
      -PassThru `
      -NoNewWindow
    $null = $sup3.Handle
    $script:startedProcesses.Add($sup3)
    Register-TrackedPid $sup3.Id
    Remove-Item env:FAKE_SLEEP_MS -ErrorAction SilentlyContinue

    $timeoutSec = 30
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $running = $false
    while ($sw.Elapsed.TotalSeconds -lt $timeoutSec) {
      if ($sup3.HasExited) {
        Write-Host "Supervisor 3 exited prematurely" -ForegroundColor Red
        break
      }
      try {
        $parsed = Invoke-FactoryStatus $stateDir
        if ($null -ne $parsed.tasks -and @($parsed.tasks).Count -ge 1) {
          $task3 = @(@($parsed.tasks) | Where-Object { $_.id -eq $script:taskId3 })[0]
          if ($null -ne $task3 -and $task3.status -eq 'progress' -and @($task3.attempts).Count -ge 1) {
            $att = @($task3.attempts)[0]
            if ($att.status -eq 'running' -and $null -ne $att.worker -and $att.worker.state -eq 'running' -and $att.worker.pid -gt 0) {
              $script:worker3Pid = $att.worker.pid
              Register-TrackedPid $att.worker.pid
              $running = $true
              break
            }
          }
        }
      } catch {}
      Start-Sleep -Milliseconds 200
    }
    [void]$sw.Stop()

    if (-not $running) {
      Write-Host "Timeout waiting for task 3 worker to run" -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }

    # Poll with a deadline until matching worker identity, non-empty nonce, and a positive grandchild PID are observed
    $runsDir = Join-Path $stateDir 'runs'
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $foundWorker3 = $false
    while ($sw.Elapsed.TotalSeconds -lt 20) {
      if (Test-Path -LiteralPath $runsDir) {
        $workerJsonFiles = @(Get-ChildItem -LiteralPath $runsDir -Filter 'worker.json' -Recurse -ErrorAction SilentlyContinue)
        foreach ($wf in $workerJsonFiles) {
          try {
            $rawContent = Get-Content -LiteralPath $wf.FullName -Raw
            $wj = $rawContent | ConvertFrom-Json
            if ($null -ne $wj -and $wj.pid -eq $script:worker3Pid -and $null -ne $wj.grandchildPid -and $wj.grandchildPid -gt 0 -and -not [string]::IsNullOrWhiteSpace($wj.nonce)) {
              $script:worker3GrandchildPid = [int]$wj.grandchildPid
              $script:trackedWorkerNonces.Add($wj.nonce)
              Register-TrackedPid $script:worker3Pid $wj.nonce
              Register-TrackedPid $script:worker3GrandchildPid $wj.nonce
              $foundWorker3 = $true
              break
            }
          } catch {}
        }
      }
      if ($foundWorker3) { break }
      Start-Sleep -Milliseconds 100
    }
    [void]$sw.Stop()

    if (-not $foundWorker3 -or $null -eq $script:worker3GrandchildPid -or $script:worker3GrandchildPid -le 0) {
      Write-Host "Failed to observe task 3 grandchild PID within deadline" -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }

    Write-Host "Task 3 worker PID=$($script:worker3Pid), grandchild PID=$($script:worker3GrandchildPid)"

    # Assert both worker and grandchild are alive BEFORE issuing task kill
    $pExecBefore = Get-Process -Id $script:worker3Pid -ErrorAction SilentlyContinue
    $pGrandBefore = Get-Process -Id $script:worker3GrandchildPid -ErrorAction SilentlyContinue
    $bothAliveBefore = ($null -ne $pExecBefore -and -not $pExecBefore.HasExited -and $null -ne $pGrandBefore -and -not $pGrandBefore.HasExited)
    if (-not $bothAliveBefore) {
      Write-Host "Worker or grandchild was not alive before issuing task kill" -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }

    # Issue task kill
    $killRaw = & $script:nodeExe lib/factory.mjs task kill --state-dir "$stateDir" --task $tId 2>&1
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
      $pGrand = Get-Process -Id $script:worker3GrandchildPid -ErrorAction SilentlyContinue
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

    # Wait for supervisor 3 to exit and verify it exited successfully
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while (-not $sup3.HasExited -and $sw.Elapsed.TotalSeconds -lt 30) {
      Start-Sleep -Milliseconds 200
    }
    [void]$sw.Stop()

    if (-not $sup3.HasExited -or $sup3.ExitCode -ne 0) {
      Write-Host "Supervisor 3 failed to exit successfully (Exited: $($sup3.HasExited), ExitCode: $($sup3.ExitCode))" -ForegroundColor Red
      if (Test-Path -LiteralPath $sup3Err) {
        Get-Content -LiteralPath $sup3Err | ForEach-Object { Write-Host "SUP3 ERR: $_" -ForegroundColor Red }
      }
      $global:LASTEXITCODE = 1
      return
    }

    $parsed3 = Invoke-FactoryStatus $stateDir
    $task3After = @(@($parsed3.tasks) | Where-Object { $_.id -eq $script:taskId3 })[0]

    Write-Host "Task 3 status after kill: $($task3After.status); attempt status: $(@($task3After.attempts)[0].status)"
    if ($task3After.status -eq 'dropped' -and @($task3After.attempts)[0].status -eq 'killed') {
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

    $supFinal = Start-Process -FilePath $script:nodeExe `
      -ArgumentList "lib/factory.mjs start --state-dir `"$stateDir`" --exit-when-idle --stale-after-ms 2000 --heartbeat-ms 500" `
      -RedirectStandardOutput $supFinalOut `
      -RedirectStandardError $supFinalErr `
      -PassThru `
      -NoNewWindow
    $null = $supFinal.Handle
    $script:startedProcesses.Add($supFinal)
    Register-TrackedPid $supFinal.Id

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while (-not $supFinal.HasExited -and $sw.Elapsed.TotalSeconds -lt 30) {
      Start-Sleep -Milliseconds 200
    }
    [void]$sw.Stop()

    if (-not $supFinal.HasExited -or $supFinal.ExitCode -ne 0) {
      Write-Host "Final supervisor failed to exit 0 (ExitCode: $($supFinal.ExitCode))" -ForegroundColor Red
      $global:LASTEXITCODE = 1
      return
    }

    $parsed = Invoke-FactoryStatus $stateDir
    $task3Final = @(@($parsed.tasks) | Where-Object { $_.id -eq $script:taskId3 })[0]

    Write-Host "Task 3 final status: $($task3Final.status); attempts count: $(@($task3Final.attempts).Count)"
    if ($task3Final.status -eq 'dropped' -and @($task3Final.attempts).Count -eq 1 -and @($task3Final.attempts)[0].status -eq 'killed') {
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
} finally {
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
    if ($script:hasSurvivors) {
      Write-Host "Process survivors detected: keeping run directory for inspection: $acceptanceBase" -ForegroundColor Yellow
    } else {
      if ($acceptanceBase) { Remove-AcceptanceTempDir $acceptanceBase }
    }
  } catch {
    $script:overallFailed = $true
    if ($null -eq $script:failureReason) {
      $script:failureReason = $_.Exception.Message
    }
  }

  # Verify removal of per-run acceptance folder if no survivors; failure to clean up fails acceptance
  try {
    if (-not $script:hasSurvivors -and $acceptanceBase -and (Test-Path -LiteralPath $acceptanceBase)) {
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
    Remove-Item env:FAKE_SLEEP_MS, env:FACTORY_FAULT, env:FACTORY_WT_DIR, env:FACTORY_HEAD_SHA, env:FACTORY_FILES_JSON, env:FACTORY_STATE_DIR, env:FACTORY_TASK_ID, env:FACTORY_RUN_DIR -ErrorAction SilentlyContinue
  } catch {}

  # Restore console and output encodings
  try {
    if ($origConsoleEncoding) {
      [Console]::OutputEncoding = $origConsoleEncoding
    }
    if ($origInputEncoding) {
      [Console]::InputEncoding = $origInputEncoding
    }
    if ($origOutputEncoding) {
      $OutputEncoding = $origOutputEncoding
    }
  } catch {}

  # --- Centralized final verdict ---
  try {
    Write-Host "`n===== M3 acceptance =====" -ForegroundColor Yellow
    $results | Format-Table -AutoSize
    $failed = $SkipBaseline -or $script:overallFailed -or ($results.Result -contains 'FAIL') -or ($results.Count -lt 19)
    if ($failed -and $script:failureReason -and -not $script:failureReason.StartsWith('Step ')) {
      Write-Host "Failure details: $script:failureReason" -ForegroundColor Red
    }
    if ($SkipBaseline) {
      Write-Host 'Baseline skipped: dev run, not an acceptance result' -ForegroundColor Yellow
    }
    if ($failed) {
      Write-Host 'M3: FAIL' -ForegroundColor Red
      exit 1
    } else {
      Write-Host 'M3: PASS' -ForegroundColor Green
      exit 0
    }
  } catch {
    if ($SkipBaseline) {
      Write-Host 'Baseline skipped: dev run, not an acceptance result' -ForegroundColor Yellow
    }
    Write-Host 'M3: FAIL' -ForegroundColor Red
    exit 1
  }
}
