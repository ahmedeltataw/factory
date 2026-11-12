# M5 acceptance (L5). Run in PowerShell:  powershell -ExecutionPolicy Bypass -File acceptance\M5.ps1
# كل خطوة بتطبع PASS أو FAIL. النتيجة المطلوبة: كل الخطوات PASS.
param(
  [string]$Source = 'https://github.com/ahmedeltataw/factory.git',
  [string]$Ref = '',
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
$script:attemptId2 = $null

$acceptanceNonce = [guid]::NewGuid().ToString('N')
$sharedBase = Join-Path $env:TEMP 'factory-m5-acceptance'
$acceptanceBase = Join-Path $sharedBase $acceptanceNonce
$dest = Join-Path $acceptanceBase 'factory'
$tempRepo = Join-Path $acceptanceBase 'demo-repo'
$stateDir = Join-Path $acceptanceBase 'state'
$logsDir = Join-Path $acceptanceBase 'logs'
$helpersDir = Join-Path $acceptanceBase 'helpers'
$origLocation = $null

function Remove-AcceptanceTempDir([string]$dir) {
  if ([string]::IsNullOrWhiteSpace($dir)) { return }
  if (-not (Test-Path -LiteralPath $dir)) { return }
  $expectedShared = Join-Path $env:TEMP 'factory-m5-acceptance'
  $fullExpected = [System.IO.Path]::GetFullPath($expectedShared).TrimEnd([char[]]@('\', '/'))
  $fullDir = [System.IO.Path]::GetFullPath($dir).TrimEnd([char[]]@('\', '/'))
  # Refuse to delete the shared base itself or anything outside of it
  if ($fullDir -eq $fullExpected -or (-not $fullDir.StartsWith($fullExpected + '\', [System.StringComparison]::OrdinalIgnoreCase) -and -not $fullDir.StartsWith($fullExpected + '/', [System.StringComparison]::OrdinalIgnoreCase))) {
    throw "Safety error: refused to delete path outside ${expectedShared} subdirectories: $dir"
  }

  $dir = $fullDir
  $empty = Join-Path $expectedShared ("empty-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $empty -Force | Out-Null
  try {
    $timeoutSec = 180
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $lastCleanupError = $null
    while ((Test-Path -LiteralPath $dir) -and $sw.Elapsed.TotalSeconds -lt $timeoutSec) {
      $roboOutLog = Join-Path $expectedShared ("robocopy-out-" + [guid]::NewGuid().ToString('N') + ".log")
      $roboErrLog = Join-Path $expectedShared ("robocopy-err-" + [guid]::NewGuid().ToString('N') + ".log")
      $roboProc = $null
      try {
        if (-not (Test-Path -LiteralPath $empty)) {
          New-Item -ItemType Directory -Path $empty -Force | Out-Null
        }
        $remainingMs = [Math]::Max(100, [int](($timeoutSec - $sw.Elapsed.TotalSeconds) * 1000))
        $roboProc = Start-Process -FilePath 'robocopy' `
          -ArgumentList "`"$empty`" `"$dir`" /MIR /R:0 /W:0 /NFL /NDL /NJH /NJS /NP" `
          -RedirectStandardOutput $roboOutLog `
          -RedirectStandardError $roboErrLog `
          -PassThru `
          -NoNewWindow
        $null = $roboProc.Handle
        $script:startedProcesses.Add($roboProc)

        $exited = $roboProc.WaitForExit($remainingMs)
        if (-not $exited) {
          try {
            if (-not $roboProc.HasExited) {
              $roboProc.Kill()
            }
            [void]$roboProc.WaitForExit(1000)
          } catch {}
          throw "robocopy timed out after ${remainingMs}ms"
        }

        $robocopyExit = $roboProc.ExitCode
        if ($null -eq $robocopyExit -or $robocopyExit -lt 0 -or $robocopyExit -gt 7) {
          $roboErr = if (Test-Path -LiteralPath $roboErrLog) { (Get-Content -LiteralPath $roboErrLog -Raw) } else { '' }
          throw "robocopy failed with exit code ${robocopyExit}: $roboErr"
        }
        $global:LASTEXITCODE = 0
        Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction Stop
      } catch {
        $lastCleanupError = $_.Exception.Message
        Start-Sleep -Milliseconds 200
      } finally {
        if ($null -ne $roboProc -and -not $roboProc.HasExited) {
          try {
            $roboProc.Kill()
            [void]$roboProc.WaitForExit(1000)
          } catch {}
        }
        if (Test-Path -LiteralPath $roboOutLog) {
          Remove-Item -LiteralPath $roboOutLog -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $roboErrLog) {
          Remove-Item -LiteralPath $roboErrLog -Force -ErrorAction SilentlyContinue
        }
      }
    }
    [void]$sw.Stop()

    if (Test-Path -LiteralPath $dir) {
      $detail = if ($lastCleanupError) { " (last error: $lastCleanupError)" } else { '' }
      throw "Cleanup error: failed to remove temporary directory within timeout: ${dir}${detail}"
    }
    if (Test-Path -LiteralPath $empty) {
      Remove-Item -LiteralPath $empty -Force -ErrorAction SilentlyContinue
    }
  } finally {
    if (Test-Path -LiteralPath $empty) {
      Remove-Item -LiteralPath $empty -Force -ErrorAction SilentlyContinue
    }
  }
}

function Register-TrackedPid([int]$targetPid, [string]$nonce = $null) {
  if ($targetPid -le 0 -or $targetPid -eq $PID) { return }
  try {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $targetPid" -Property ProcessId, Name, CommandLine, CreationDate -ErrorAction Stop
  } catch {
    $proc = $null
  }
  if ($null -ne $proc) {
    foreach ($rec in $script:trackedProcessRecords) {
      if ($rec.ProcessId -eq $targetPid -and $rec.CreationDate -eq $proc.CreationDate) {
        if (-not [string]::IsNullOrWhiteSpace($nonce) -and [string]::IsNullOrWhiteSpace($rec.Nonce)) {
          $rec.Nonce = $nonce
        }
        return
      }
    }
    $record = [pscustomobject]@{
      ProcessId    = $targetPid
      CreationDate = $proc.CreationDate
      CommandLine  = $proc.CommandLine
      Nonce        = $nonce
    }
    $script:trackedProcessRecords.Add($record)
  } elseif (-not [string]::IsNullOrWhiteSpace($nonce)) {
    foreach ($rec in $script:trackedProcessRecords) {
      if ($rec.ProcessId -eq $targetPid -and [string]::IsNullOrWhiteSpace($rec.Nonce)) {
        $rec.Nonce = $nonce
      }
    }
  }
  if (-not $script:ownedPids.Contains($targetPid)) {
    $script:ownedPids.Add($targetPid)
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
  $targetPid = $rec.ProcessId
  $curr = Get-CimInstance Win32_Process -Filter "ProcessId = $targetPid" -Property ProcessId, Name, CommandLine, CreationDate -ErrorAction Stop
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

function Normalize-Paths([string[]]$paths) {
  $ErrorActionPreference = 'Continue'
  $helperPath = Join-Path $helpersDir 'canonicalize-paths.mjs'
  $helperCode = @'
import fs from 'node:fs';
import path from 'node:path';

const paths = JSON.parse(process.env.FACTORY_PATHS_JSON);
const canonical = paths.map((inputPath) => {
  const resolved = path.resolve(inputPath);
  let ancestor = resolved;
  const remaining = [];
  while (true) {
    try {
      return path.join(fs.realpathSync.native(ancestor), ...remaining);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return resolved;
      remaining.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
});
process.stdout.write(JSON.stringify(canonical));
'@
  [System.IO.File]::WriteAllText($helperPath, $helperCode, (New-Object System.Text.UTF8Encoding $false))
  $previousPathsJson = $env:FACTORY_PATHS_JSON
  try {
    $env:FACTORY_PATHS_JSON = ConvertTo-Json -InputObject @($paths) -Compress
    $helperErrFile = Join-Path $logsDir 'canonicalize-paths.stderr.log'
    $rawPaths = & $script:nodeExe $helperPath 2> $helperErrFile
    $helperCodeExit = $LASTEXITCODE
    if ($helperCodeExit -ne 0) {
      throw "Path canonicalization failed with code ${helperCodeExit}: $(Get-Content -LiteralPath $helperErrFile -Raw)"
    }
    try {
      $canonicalPaths = @($rawPaths | ConvertFrom-Json)
    } catch {
      throw "Invalid path canonicalization JSON: $rawPaths"
    }
    if ($canonicalPaths.Count -ne $paths.Count) {
      throw "Path canonicalization returned $($canonicalPaths.Count) paths; expected $($paths.Count): $rawPaths"
    }
    return @($canonicalPaths | ForEach-Object { $_.Replace('\', '/').TrimEnd('/').ToLowerInvariant() })
  } finally {
    $env:FACTORY_PATHS_JSON = $previousPathsJson
  }
}

function Cleanup-TaskWorktrees {
  $ErrorActionPreference = 'Continue'
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

        $activeWorktrees = @($wtListRaw | Where-Object { $_ -match '^worktree\s+(.+)$' } | ForEach-Object { $Matches[1].Trim() })
        $normalizedPaths = @(Normalize-Paths (@($d.FullName) + $activeWorktrees))
        $normD = $normalizedPaths[0]
        $normalizedActiveWorktrees = @($normalizedPaths | Select-Object -Skip 1)
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

  $outTask = $proc.StandardOutput.ReadToEndAsync()
  $errTask = $proc.StandardError.ReadToEndAsync()

  $timeoutMs = 10000
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $remainingMs = $timeoutMs
  $exited = $proc.WaitForExit($remainingMs)
  $remainingMs = [Math]::Max(0, [int]($timeoutMs - $sw.ElapsedMilliseconds))
  $drained = $false
  if ($exited -and $remainingMs -gt 0) {
    try {
      $drained = [System.Threading.Tasks.Task]::WaitAll(@($outTask, $errTask), $remainingMs)
    } catch {
      $drained = $false
    }
  }
  [void]$sw.Stop()

  if (-not $exited -or -not $drained -or -not $outTask.IsCompleted -or -not $errTask.IsCompleted) {
    try {
      if (-not $proc.HasExited) {
        $proc.Kill()
      }
      [void]$proc.WaitForExit(2000)
    } catch {}
    throw "factory status timed out after ${timeoutMs}ms (exited: $exited, drained: $drained)"
  }

  $stdout = $outTask.Result
  $stderr = $errTask.Result
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


function New-DemoTask([string]$taskId, [string[]]$options) {
  $stderr = Join-Path $logsDir "create-$taskId.err"
  $output = & $script:nodeExe lib/factory.mjs task create --state-dir $stateDir --title "Acceptance $taskId" --command-id $taskId @options 2> $stderr
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0 -or @($output)[0] -ne "created $taskId") { throw "Task create failed ($exitCode): $output $(Get-Content $stderr -Raw)" }
}
function Start-DemoSupervisor([string]$name, [string]$takeover = '') {
  $extra = if ($takeover) { " --takeover $takeover" } else { '' }
  $proc = Start-Process -FilePath $script:nodeExe -ArgumentList "lib/factory.mjs start --state-dir `"$stateDir`" --exit-when-idle --stale-after-ms 2000 --heartbeat-ms 200$extra" -RedirectStandardOutput (Join-Path $logsDir "$name.out") -RedirectStandardError (Join-Path $logsDir "$name.err") -PassThru -NoNewWindow
  $null = $proc.Handle
  $script:startedProcesses.Add($proc)
  Register-TrackedPid $proc.Id
  return $proc
}
function Wait-DemoSupervisor($proc, [string]$name) {
  if (-not $proc.WaitForExit(90000)) { throw "Supervisor $name timed out" }
  if ($proc.ExitCode -ne 0) { throw "Supervisor $name exited $($proc.ExitCode): $(Get-Content (Join-Path $logsDir "$name.err") -Raw)" }
}
function Get-DemoTask([string]$taskId) {
  $snapshot = Invoke-FactoryStatus $stateDir
  $found = @($snapshot.tasks | Where-Object { $_.id -eq $taskId })
  if ($found.Count -ne 1) { throw "Expected task $taskId once, found $($found.Count)" }
  return $found[0]
}
function Get-DemoDatabase([string]$taskId) {
  $helper = Join-Path $helpersDir 'read-task.mjs'
  $code = @'
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
const db = new DatabaseSync(join(process.env.FACTORY_STATE_DIR, 'state.sqlite'), { readOnly: true });
try {
  const task = db.prepare('SELECT attempt_base FROM tasks WHERE id = ?').get(process.env.FACTORY_TASK_ID);
  const evidence = db.prepare('SELECT count(*) AS n FROM evidence JOIN attempts ON attempts.id = evidence.attempt_id WHERE attempts.task_id = ?').get(process.env.FACTORY_TASK_ID);
  const attempts = db.prepare('SELECT attempt_no, status, started_at, ended_at FROM attempts WHERE task_id = ? ORDER BY attempt_no').all(process.env.FACTORY_TASK_ID);
  if (!task) throw new Error('task missing');
  process.stdout.write(JSON.stringify({ attemptBase: task.attempt_base, evidence: evidence.n, attempts }));
} finally { db.close(); }
'@
  [System.IO.File]::WriteAllText($helper, $code, (New-Object System.Text.UTF8Encoding $false))
  $env:FACTORY_STATE_DIR = $stateDir
  $env:FACTORY_TASK_ID = $taskId
  try {
    $errFile = Join-Path $logsDir "db-$taskId.err"
    $raw = & $script:nodeExe $helper 2> $errFile
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) { throw "Database read failed ($exitCode): $(Get-Content $errFile -Raw)" }
    try { return (($raw -join "`n") | ConvertFrom-Json) } catch { throw "Invalid database JSON: $raw" }
  } finally { Remove-Item env:FACTORY_STATE_DIR, env:FACTORY_TASK_ID -ErrorAction SilentlyContinue }
}
function Get-DemoCommandOutcome([string]$cmdId) {
  $helper = Join-Path $helpersDir 'read-command-outcome.mjs'
  $code = @'
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
const db = new DatabaseSync(join(process.env.FACTORY_STATE_DIR, 'state.sqlite'), { readOnly: true });
try {
  const row = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get(process.env.FACTORY_COMMAND_ID);
  if (!row) throw new Error('command outcome missing');
  process.stdout.write(JSON.stringify(row));
} finally { db.close(); }
'@
  [System.IO.File]::WriteAllText($helper, $code, (New-Object System.Text.UTF8Encoding $false))
  $env:FACTORY_STATE_DIR = $stateDir
  $env:FACTORY_COMMAND_ID = $cmdId
  try {
    $errFile = Join-Path $logsDir "cmd-$cmdId.err"
    $raw = & $script:nodeExe $helper 2> $errFile
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) { throw "Command outcome read failed ($exitCode): $(Get-Content $errFile -Raw)" }
    try { return (($raw -join "`n") | ConvertFrom-Json) } catch { throw "Invalid command outcome JSON: $raw" }
  } finally { Remove-Item env:FACTORY_STATE_DIR, env:FACTORY_COMMAND_ID -ErrorAction SilentlyContinue }
}
function Assert-DemoCommits([string]$taskId, [int]$expected) {
  $errFile = Join-Path $logsDir "git-$taskId.err"
  $raw = & git -C $tempRepo rev-list --count "refs/heads/factory/task/$taskId" "^$($script:baseSha)" 2> $errFile
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0 -or ($raw -join '').Trim() -ne "$expected") { throw "Task $taskId commits expected $expected, got $raw (exit $exitCode)" }
}
function Assert-Demo($condition, [string]$message) { if (-not $condition) { throw $message } }

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
    $targetRef = if ($Ref) { $Ref.Trim() } else { '' }
    if ([string]::IsNullOrWhiteSpace($targetRef)) {
      if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) {
        throw 'PSScriptRoot is empty. Please pass -Ref explicitly.'
      }
      $refErrFile = Join-Path $logsDir 'git-resolve-ref.err'
      $refRaw = & git -C $PSScriptRoot rev-parse --abbrev-ref HEAD 2> $refErrFile
      $refExit = $LASTEXITCODE
      if ($refExit -ne 0) {
        $refErr = if (Test-Path -LiteralPath $refErrFile) { (Get-Content -LiteralPath $refErrFile -Raw).Trim() } else { '' }
        throw "Failed to resolve git ref from repository at '$PSScriptRoot' (exit code $($refExit)) - $refErr. Please pass -Ref explicitly."
      }
      $targetRef = ($refRaw -join '').Trim()
      if ([string]::IsNullOrWhiteSpace($targetRef) -or $targetRef -eq 'HEAD') {
        throw "Repository at '$PSScriptRoot' is in detached HEAD state. Please pass -Ref explicitly."
      }
    }

    $cloneErrFile = Join-Path $logsDir 'git-clone.err'
    & git clone -q --branch $targetRef -- $Source $dest 2> $cloneErrFile
    $cloneExit = $LASTEXITCODE
    if ($cloneExit -ne 0) {
      $cloneErr = if (Test-Path -LiteralPath $cloneErrFile) { (Get-Content -LiteralPath $cloneErrFile -Raw).Trim() } else { '' }
      throw "git clone failed with exit code $($cloneExit) - $cloneErr"
    }

    $shaErrFile = Join-Path $logsDir 'git-rev-parse-cloned.err'
    $shaRaw = & git -C $dest rev-parse HEAD 2> $shaErrFile
    $shaExit = $LASTEXITCODE
    if ($shaExit -ne 0) {
      $shaErr = if (Test-Path -LiteralPath $shaErrFile) { (Get-Content -LiteralPath $shaErrFile -Raw).Trim() } else { '' }
      throw "git rev-parse HEAD failed with exit code $($shaExit) - $shaErr"
    }
    $clonedSha = ($shaRaw -join '').Trim()
    Write-Host "Cloned ref $targetRef at commit $clonedSha"
    $global:LASTEXITCODE = 0
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
    $outName = & git -C $tempRepo config user.name "M5 Acceptance" 2>&1
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

  # M5 demonstrations




  # CHK-M5-08-b: graph demo: chain A -> B and diamond (B, C after A; D after B and C)
  if (-not (Step 11 'Graph demo: chain and diamond run in dependency order' {
    $ErrorActionPreference = 'Continue'
    $chainA = [guid]::NewGuid().ToString()
    $chainB = [guid]::NewGuid().ToString()
    $diaA = [guid]::NewGuid().ToString()
    $diaB = [guid]::NewGuid().ToString()
    $diaC = [guid]::NewGuid().ToString()
    $diaD = [guid]::NewGuid().ToString()

    # Chain: A -> B
    New-DemoTask $chainA @('--scope', 'src/chainA', '--scope', "factory-fake/${chainA}.txt")
    New-DemoTask $chainB @('--scope', 'src/chainB', '--scope', "factory-fake/${chainB}.txt", '--after', $chainA)

    # Diamond: diaA -> (diaB, diaC) -> diaD
    New-DemoTask $diaA @('--scope', 'src/diaA', '--scope', "factory-fake/${diaA}.txt")
    New-DemoTask $diaB @('--scope', 'src/diaB', '--scope', "factory-fake/${diaB}.txt", '--after', $diaA)
    New-DemoTask $diaC @('--scope', 'src/diaC', '--scope', "factory-fake/${diaC}.txt", '--after', $diaA)
    New-DemoTask $diaD @('--scope', 'src/diaD', '--scope', "factory-fake/${diaD}.txt", '--after', $diaB, '--after', $diaC)

    $allGraphTaskIds = @($chainA, $chainB, $diaA, $diaB, $diaC, $diaD)

    $env:FAKE_SLEEP_MS = '2500'
    try {
      $proc = Start-DemoSupervisor 'graph'
    } finally {
      Remove-Item env:FAKE_SLEEP_MS -ErrorAction SilentlyContinue
    }

    $watch = [Diagnostics.Stopwatch]::StartNew()
    $observedDiamondOverlap = $false
    $lastStatusText = ''

    while ($watch.Elapsed.TotalSeconds -lt 90) {
      $snapshot = Invoke-FactoryStatus $stateDir
      $tasks = @($snapshot.tasks | Where-Object { $_.id -in $allGraphTaskIds })
      if ($tasks.Count -eq 6) {
        $tChainA = @($tasks | Where-Object { $_.id -eq $chainA })[0]
        $tChainB = @($tasks | Where-Object { $_.id -eq $chainB })[0]
        $tDiaA = @($tasks | Where-Object { $_.id -eq $diaA })[0]
        $tDiaB = @($tasks | Where-Object { $_.id -eq $diaB })[0]
        $tDiaC = @($tasks | Where-Object { $_.id -eq $diaC })[0]
        $tDiaD = @($tasks | Where-Object { $_.id -eq $diaD })[0]

        $lastStatusText = "ChainA=$($tChainA.status), ChainB=$($tChainB.status), DiaA=$($tDiaA.status), DiaB=$($tDiaB.status), DiaC=$($tDiaC.status), DiaD=$($tDiaD.status)"

        # Dependency order invariant: Chain B must not run before Chain A is done
        if ($tChainA.status -ne 'done') {
          Assert-Demo ($tChainB.status -ne 'progress' -and $tChainB.status -ne 'done') "Chain B ran before Chain A completed: $lastStatusText"
        }

        # Dependency order invariant: Dia B, C, D must not run before Dia A is done
        if ($tDiaA.status -ne 'done') {
          Assert-Demo ($tDiaB.status -ne 'progress' -and $tDiaB.status -ne 'done') "Dia B ran before Dia A completed: $lastStatusText"
          Assert-Demo ($tDiaC.status -ne 'progress' -and $tDiaC.status -ne 'done') "Dia C ran before Dia A completed: $lastStatusText"
          Assert-Demo ($tDiaD.status -ne 'progress' -and $tDiaD.status -ne 'done') "Dia D ran before Dia A completed: $lastStatusText"
        }

        # Concurrency in diamond: Dia B and Dia C running concurrently
        if ($tDiaB.status -eq 'progress' -and $tDiaC.status -eq 'progress') {
          $observedDiamondOverlap = $true
        }

        # Dependency order invariant: Dia D must not run before both Dia B and Dia C are done
        if ($tDiaB.status -ne 'done' -or $tDiaC.status -ne 'done') {
          Assert-Demo ($tDiaD.status -ne 'progress' -and $tDiaD.status -ne 'done') "Dia D ran before Dia B and Dia C completed: $lastStatusText"
        }

        # Register worker nonces for cleanup tracking
        $workers = @(Get-ChildItem -LiteralPath (Join-Path $stateDir 'runs') -Filter worker.json -Recurse -ErrorAction SilentlyContinue | ForEach-Object { Get-Content $_.FullName -Raw | ConvertFrom-Json })
        foreach ($w in $workers) {
          if ($w.nonce -and -not $script:trackedWorkerNonces.Contains($w.nonce)) {
            $script:trackedWorkerNonces.Add($w.nonce)
          }
        }

        if (@($tasks | Where-Object { $_.status -eq 'done' }).Count -eq 6) {
          break
        }
      }
      if ($proc.HasExited) { break }
      Start-Sleep -Milliseconds 100
    }

    Wait-DemoSupervisor $proc 'graph'

    $snapshot = Invoke-FactoryStatus $stateDir
    $tasks = @($snapshot.tasks | Where-Object { $_.id -in $allGraphTaskIds })
    Assert-Demo ($tasks.Count -eq 6 -and @($tasks | Where-Object { $_.status -eq 'done' }).Count -eq 6) "Graph demo failed: $lastStatusText"
    Assert-Demo ($observedDiamondOverlap) "Diamond branches Dia B and Dia C did not run concurrently"

    # Verify attempt timestamps confirm dependency order
    $dbChainA = Get-DemoDatabase $chainA
    $dbChainB = Get-DemoDatabase $chainB
    $dbDiaA = Get-DemoDatabase $diaA
    $dbDiaB = Get-DemoDatabase $diaB
    $dbDiaC = Get-DemoDatabase $diaC
    $dbDiaD = Get-DemoDatabase $diaD

    $endChainA = [DateTimeOffset]::Parse($dbChainA.attempts[0].ended_at).ToUnixTimeMilliseconds()
    $startChainB = [DateTimeOffset]::Parse($dbChainB.attempts[0].started_at).ToUnixTimeMilliseconds()
    Assert-Demo ($startChainB -ge $endChainA) "Chain B started ($startChainB) before Chain A ended ($endChainA)"

    $endDiaA = [DateTimeOffset]::Parse($dbDiaA.attempts[0].ended_at).ToUnixTimeMilliseconds()
    $startDiaB = [DateTimeOffset]::Parse($dbDiaB.attempts[0].started_at).ToUnixTimeMilliseconds()
    $startDiaC = [DateTimeOffset]::Parse($dbDiaC.attempts[0].started_at).ToUnixTimeMilliseconds()
    Assert-Demo ($startDiaB -ge $endDiaA) "Dia B started ($startDiaB) before Dia A ended ($endDiaA)"
    Assert-Demo ($startDiaC -ge $endDiaA) "Dia C started ($startDiaC) before Dia A ended ($endDiaA)"

    $endDiaB = [DateTimeOffset]::Parse($dbDiaB.attempts[0].ended_at).ToUnixTimeMilliseconds()
    $endDiaC = [DateTimeOffset]::Parse($dbDiaC.attempts[0].ended_at).ToUnixTimeMilliseconds()
    $latestDiaBC = [Math]::Max($endDiaB, $endDiaC)
    $startDiaD = [DateTimeOffset]::Parse($dbDiaD.attempts[0].started_at).ToUnixTimeMilliseconds()
    Assert-Demo ($startDiaD -ge $latestDiaBC) "Dia D started ($startDiaD) before Dia B ($endDiaB) and Dia C ($endDiaC) ended"

    # Assert exactly one commit each
    foreach ($taskId in $allGraphTaskIds) {
      Assert-DemoCommits $taskId 1
    }

    $global:LASTEXITCODE = 0
  })) { throw 'Step 11 failed' }

  # CHK-M5-08-c: block demo: task after killed task becomes blocked with no attempts
  if (-not (Step 12 'Block demo: task after killed task becomes blocked with no attempts' {
    $ErrorActionPreference = 'Continue'
    $taskKillA = [guid]::NewGuid().ToString()
    $taskBlockB = [guid]::NewGuid().ToString()

    New-DemoTask $taskKillA @('--scope', 'src/killA', '--scope', "factory-fake/${taskKillA}.txt")
    New-DemoTask $taskBlockB @('--scope', 'src/blockB', '--scope', "factory-fake/${taskBlockB}.txt", '--after', $taskKillA)

    $errFile = Join-Path $logsDir "kill-${taskKillA}.err"
    $output = & $script:nodeExe lib/factory.mjs task kill --state-dir $stateDir --task $taskKillA 2> $errFile
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
      $errContent = if (Test-Path -LiteralPath $errFile) { Get-Content $errFile -Raw } else { '' }
      throw "task kill failed ($exitCode): $output $errContent"
    }

    $proc = Start-DemoSupervisor 'block'
    Wait-DemoSupervisor $proc 'block'

    $tA = Get-DemoTask $taskKillA
    $tB = Get-DemoTask $taskBlockB
    Assert-Demo ($tA.status -eq 'dropped') "Killed task A status expected dropped, got $($tA.status)"
    Assert-Demo ($tB.status -eq 'blocked') "Dependent task B status expected blocked, got $($tB.status)"
    Assert-Demo (@($tB.attempts).Count -eq 0) "Blocked task B must never get an attempt from status, got $(@($tB.attempts).Count)"

    $dbB = Get-DemoDatabase $taskBlockB
    Assert-Demo (@($dbB.attempts).Count -eq 0) "Blocked task B must never get an attempt in DB, got $(@($dbB.attempts).Count)"
    Assert-Demo ($dbB.evidence -eq 0) "Blocked task B must have 0 evidence rows, got $($dbB.evidence)"
    Assert-DemoCommits $taskBlockB 0

    $global:LASTEXITCODE = 0
  })) { throw 'Step 12 failed' }

  # CHK-M5-08-d: phase demo
  if (-not (Step 13 'Phase demo: qa task waits while earlier phases have work, advance rejected while unfinished, then runs' {
    $ErrorActionPreference = 'Continue'
    $taskIntake = [guid]::NewGuid().ToString()
    $taskDev = [guid]::NewGuid().ToString()
    $taskQa = [guid]::NewGuid().ToString()

    New-DemoTask $taskIntake @('--phase', 'intake', '--scope', 'src/pIntake', '--scope', "factory-fake/${taskIntake}.txt")
    New-DemoTask $taskDev @('--phase', 'development', '--scope', 'src/pDev', '--scope', "factory-fake/${taskDev}.txt")
    New-DemoTask $taskQa @('--phase', 'qa', '--scope', 'src/pQa', '--scope', "factory-fake/${taskQa}.txt")

    # 1. Assert initial states: qa task is ready with waiting reason 'phase-locked'
    $tQa0 = Get-DemoTask $taskQa
    Assert-Demo ($tQa0.status -eq 'ready' -and $null -ne $tQa0.waiting -and $tQa0.waiting.reason -eq 'phase-locked' -and @($tQa0.waiting.on) -contains 'qa') "Task QA expected ready and phase-locked on qa"

    # 2. Advance phase intake while taskIntake is unfinished -> must be rejected
    $advCmd1 = [guid]::NewGuid().ToString()
    $errAdv1 = Join-Path $logsDir "adv1.err"
    $rawAdv1 = & $script:nodeExe lib/factory.mjs phase advance --state-dir $stateDir --phase intake --command-id $advCmd1 2> $errAdv1
    Assert-Demo ($LASTEXITCODE -eq 0) "phase advance command submission failed: $rawAdv1"

    # Start supervisor: applies advCmd1 (rejected: phase has unfinished tasks), runs taskIntake to done, leaves taskDev and taskQa phase-locked
    $proc1 = Start-DemoSupervisor 'phase-intake'
    Wait-DemoSupervisor $proc1 'phase-intake'

    $outcome1 = Get-DemoCommandOutcome $advCmd1
    Assert-Demo ($outcome1.outcome -eq 'rejected' -and $outcome1.reason -eq 'phase has unfinished tasks') "phase advance with unfinished tasks must be rejected, got: $($outcome1 | ConvertTo-Json)"

    $tIntake1 = Get-DemoTask $taskIntake
    Assert-Demo ($tIntake1.status -eq 'done') "Task intake expected done, got $($tIntake1.status)"

    # While intake was running and finished, taskQa stayed ready and phase-locked
    $tQa1 = Get-DemoTask $taskQa
    Assert-Demo ($tQa1.status -eq 'ready' -and $null -ne $tQa1.waiting -and $tQa1.waiting.reason -eq 'phase-locked' -and @($tQa1.attempts).Count -eq 0) "Task QA must stay ready with 0 attempts while intake had work"

    # 3. Advance phase intake to development now that intake tasks are done
    $advCmd2 = [guid]::NewGuid().ToString()
    $errAdv2 = Join-Path $logsDir "adv2.err"
    $rawAdv2 = & $script:nodeExe lib/factory.mjs phase advance --state-dir $stateDir --phase intake --command-id $advCmd2 2> $errAdv2
    Assert-Demo ($LASTEXITCODE -eq 0) "phase advance intake submission failed: $rawAdv2"

    # Start supervisor: applies advCmd2, runs taskDev to done, leaves taskQa phase-locked
    $proc2 = Start-DemoSupervisor 'phase-dev'
    Wait-DemoSupervisor $proc2 'phase-dev'

    $outcome2 = Get-DemoCommandOutcome $advCmd2
    Assert-Demo ($outcome2.outcome -eq 'applied') "phase advance intake must be applied, got $($outcome2.outcome)"

    $tDev2 = Get-DemoTask $taskDev
    Assert-Demo ($tDev2.status -eq 'done') "Task dev expected done, got $($tDev2.status)"

    # While development had work and finished, taskQa stayed ready and phase-locked
    $tQa2 = Get-DemoTask $taskQa
    Assert-Demo ($tQa2.status -eq 'ready' -and $null -ne $tQa2.waiting -and $tQa2.waiting.reason -eq 'phase-locked' -and @($tQa2.attempts).Count -eq 0) "Task QA must stay ready with 0 attempts while development had work"

    # 4. Advance phase development to qa now that development tasks are done
    $advCmd3 = [guid]::NewGuid().ToString()
    $errAdv3 = Join-Path $logsDir "adv3.err"
    $rawAdv3 = & $script:nodeExe lib/factory.mjs phase advance --state-dir $stateDir --phase development --command-id $advCmd3 2> $errAdv3
    Assert-Demo ($LASTEXITCODE -eq 0) "phase advance dev submission failed: $rawAdv3"

    # Start supervisor: applies advCmd3, qa phase opens, taskQa runs and ends done
    $proc3 = Start-DemoSupervisor 'phase-qa'
    Wait-DemoSupervisor $proc3 'phase-qa'

    $outcome3 = Get-DemoCommandOutcome $advCmd3
    Assert-Demo ($outcome3.outcome -eq 'applied') "phase advance development must be applied, got $($outcome3.outcome)"

    $tQa3 = Get-DemoTask $taskQa
    Assert-Demo ($tQa3.status -eq 'done' -and @($tQa3.attempts).Count -eq 1) "Task QA expected done with 1 attempt, got $($tQa3.status)"

    Assert-DemoCommits $taskIntake 1
    Assert-DemoCommits $taskDev 1
    Assert-DemoCommits $taskQa 1

    $global:LASTEXITCODE = 0
  })) { throw 'Step 13 failed' }

  # CHK-M5-08-e: crash demo
  if (-not (Step 14 'Crash demo: Supervisor stopped while A runs and B waits, restarted with takeover' {
    $ErrorActionPreference = 'Continue'
    $crashA = [guid]::NewGuid().ToString()
    $crashB = [guid]::NewGuid().ToString()

    New-DemoTask $crashA @('--scope', 'src/crashA', '--scope', "factory-fake/${crashA}.txt")
    New-DemoTask $crashB @('--scope', 'src/crashB', '--scope', "factory-fake/${crashB}.txt", '--after', $crashA)

    $env:FAKE_SLEEP_MS = '30000'
    try {
      $proc = Start-DemoSupervisor 'crash'
    } finally {
      Remove-Item env:FAKE_SLEEP_MS -ErrorAction SilentlyContinue
    }

    # Bounded wait to observe boundary state: A is progress, B is ready waiting on deps
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $boundaryObserved = $false
    $boundaryDetails = 'no snapshot'
    while ($watch.Elapsed.TotalSeconds -lt 30 -and -not $proc.HasExited) {
      $snapshot = Invoke-FactoryStatus $stateDir
      $tA = @($snapshot.tasks | Where-Object { $_.id -eq $crashA })
      $tB = @($snapshot.tasks | Where-Object { $_.id -eq $crashB })
      if ($tA.Count -eq 1 -and $tB.Count -eq 1) {
        $boundaryDetails = "A=$($tA[0].status), B=$($tB[0].status)"
        if ($tA[0].status -eq 'progress' -and $tB[0].status -eq 'ready' -and $null -ne $tB[0].waiting -and $tB[0].waiting.reason -eq 'deps') {
          $boundaryObserved = $true
          break
        }
      }
      Start-Sleep -Milliseconds 50
    }
    Assert-Demo ($boundaryObserved) "Did not reach crash boundary state: $boundaryDetails"

    # Register worker nonces before stopping supervisor
    $workers = @(Get-ChildItem -LiteralPath (Join-Path $stateDir 'runs') -Filter worker.json -Recurse -ErrorAction SilentlyContinue | ForEach-Object { Get-Content $_.FullName -Raw | ConvertFrom-Json })
    foreach ($w in $workers) {
      if ($w.nonce -and -not $script:trackedWorkerNonces.Contains($w.nonce)) {
        $script:trackedWorkerNonces.Add($w.nonce)
      }
    }

    $proc.Kill()
    Assert-Demo ($proc.WaitForExit(10000)) 'Supervisor did not stop at crash boundary'

    $snapshot = Invoke-FactoryStatus $stateDir
    $takeover = $snapshot.lease.takeover
    Assert-Demo (-not [string]::IsNullOrWhiteSpace($takeover)) 'Missing takeover token'

    # Wait for lease staleness
    $delay = [Math]::Max(0, [long]$snapshot.lease.heartbeatMs + 2500 - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    if ($delay -gt 0) { Start-Sleep -Milliseconds $delay }

    # Set short sleep for re-attempt and task B
    $env:FAKE_SLEEP_MS = '200'
    try {
      $proc2 = Start-DemoSupervisor 'crash-restart' $takeover
      Wait-DemoSupervisor $proc2 'crash-restart'
    } finally {
      Remove-Item env:FAKE_SLEEP_MS -ErrorAction SilentlyContinue
    }

    $tA = Get-DemoTask $crashA
    $tB = Get-DemoTask $crashB
    Assert-Demo ($tA.status -eq 'done') "Task A expected done, got $($tA.status)"
    Assert-Demo ($tB.status -eq 'done') "Task B expected done, got $($tB.status)"

    $dbA = Get-DemoDatabase $crashA
    $dbB = Get-DemoDatabase $crashB

    # Task A had attempt 1 interrupted, attempt 2 succeeded
    Assert-Demo (@($dbA.attempts).Count -eq 2) "Task A expected 2 attempts, got $(@($dbA.attempts).Count)"
    Assert-Demo ($dbA.attempts[0].status -eq 'interrupted') "Task A attempt 1 expected interrupted, got $($dbA.attempts[0].status)"
    Assert-Demo ($dbA.attempts[1].status -eq 'succeeded') "Task A attempt 2 expected succeeded, got $($dbA.attempts[1].status)"

    # Task B had 1 attempt succeeded
    Assert-Demo (@($dbB.attempts).Count -eq 1 -and $dbB.attempts[0].status -eq 'succeeded') "Task B expected 1 succeeded attempt"

    # B starts only after A is done
    $endA2 = [DateTimeOffset]::Parse($dbA.attempts[1].ended_at).ToUnixTimeMilliseconds()
    $startB1 = [DateTimeOffset]::Parse($dbB.attempts[0].started_at).ToUnixTimeMilliseconds()
    Assert-Demo ($startB1 -ge $endA2) "Task B start ($startB1) must be >= Task A re-attempt end ($endA2)"

    # Exactly one evidence row each
    Assert-Demo ($dbA.evidence -eq 1) "Task A evidence expected 1, got $($dbA.evidence)"
    Assert-Demo ($dbB.evidence -eq 1) "Task B evidence expected 1, got $($dbB.evidence)"

    Assert-DemoCommits $crashA 1
    Assert-DemoCommits $crashB 1

    $global:LASTEXITCODE = 0
  })) { throw 'Step 14 failed' }

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
    Remove-Item env:FAKE_SLEEP_MS, env:FAKE_HANG, env:FAKE_FAIL_UNTIL_ATTEMPT, env:FAKE_WRITE, env:FACTORY_FAULT, env:FACTORY_WT_DIR, env:FACTORY_HEAD_SHA, env:FACTORY_FILES_JSON, env:FACTORY_STATE_DIR, env:FACTORY_TASK_ID, env:FACTORY_COMMAND_ID, env:FACTORY_RUN_DIR -ErrorAction SilentlyContinue
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
    Write-Host "`n===== M5 acceptance =====" -ForegroundColor Yellow
    $results | Format-Table -AutoSize
    $failed = $SkipBaseline -or $script:overallFailed -or ($results.Result -contains 'FAIL') -or ($results.Count -lt 14)
    if ($failed -and $script:failureReason -and -not $script:failureReason.StartsWith('Step ')) {
      Write-Host "Failure details: $script:failureReason" -ForegroundColor Red
    }
    if ($SkipBaseline) {
      Write-Host 'Baseline skipped: dev run, not an acceptance result' -ForegroundColor Yellow
    }
    if ($failed) {
      Write-Host 'M5: FAIL' -ForegroundColor Red
      exit 1
    } else {
      Write-Host 'M5: PASS' -ForegroundColor Green
      exit 0
    }
  } catch {
    if ($SkipBaseline) {
      Write-Host 'Baseline skipped: dev run, not an acceptance result' -ForegroundColor Yellow
    }
    Write-Host 'M5: FAIL' -ForegroundColor Red
    exit 1
  }
}
