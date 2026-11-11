# M4 acceptance (L5). Run in PowerShell:  powershell -ExecutionPolicy Bypass -File acceptance\M4.ps1
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
$sharedBase = Join-Path $env:TEMP 'factory-m4-acceptance'
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
  $expectedShared = Join-Path $env:TEMP 'factory-m4-acceptance'
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
  if (!task) throw new Error('task missing');
  process.stdout.write(JSON.stringify({ attemptBase: task.attempt_base, evidence: evidence.n }));
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
    $outName = & git -C $tempRepo config user.name "M4 Acceptance" 2>&1
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

  # M4 demonstrations

  if (-not (Step 11 'Retry and timeout' {
    $ErrorActionPreference = 'Continue'
    $retryId = [guid]::NewGuid().ToString()
    New-DemoTask $retryId @('--max-attempts', '2')
    $env:FAKE_FAIL_UNTIL_ATTEMPT = '1'
    try { $proc = Start-DemoSupervisor 'retry' } finally { Remove-Item env:FAKE_FAIL_UNTIL_ATTEMPT -ErrorAction SilentlyContinue }
    Wait-DemoSupervisor $proc 'retry'
    $task = Get-DemoTask $retryId; $attempts = @($task.attempts); $db = Get-DemoDatabase $retryId
    Assert-Demo ($task.status -eq 'done' -and $attempts.Count -eq 2 -and $attempts[0].errorClass -eq 'transient' -and $attempts[1].status -eq 'succeeded' -and $db.evidence -eq 1) "Retry mismatch: $($task | ConvertTo-Json -Depth 10 -Compress), evidence=$($db.evidence)"

    $timeoutId = [guid]::NewGuid().ToString()
    New-DemoTask $timeoutId @('--timeout-ms', '2000', '--max-attempts', '2')
    $env:FAKE_HANG = '1'
    try { $proc = Start-DemoSupervisor 'timeout' } finally { Remove-Item env:FAKE_HANG -ErrorAction SilentlyContinue }
    Wait-DemoSupervisor $proc 'timeout'
    $task = Get-DemoTask $timeoutId; $attempts = @($task.attempts)
    Assert-Demo ($task.status -eq 'failed' -and $attempts.Count -eq 2 -and @($attempts | Where-Object { $_.errorClass -eq 'timeout' }).Count -eq 2) "Timeout mismatch: $($task | ConvertTo-Json -Depth 10 -Compress)"
    $workers = @(Get-ChildItem -LiteralPath (Join-Path $stateDir 'runs') -Filter worker.json -Recurse | ForEach-Object { Get-Content $_.FullName -Raw | ConvertFrom-Json })
    foreach ($worker in $workers) {
      if ($worker.nonce) {
        if (-not $script:trackedWorkerNonces.Contains($worker.nonce)) { $script:trackedWorkerNonces.Add($worker.nonce) }
        $live = @(Get-CimInstance Win32_Process -Property ProcessId, CommandLine | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($worker.nonce) })
        Assert-Demo ($live.Count -eq 0) "Worker nonce $($worker.nonce) still has $($live.Count) processes"
      }
    }
    $errFile = Join-Path $logsDir 'retry-command.err'
    $output = & $script:nodeExe lib/factory.mjs task retry --state-dir $stateDir --task $timeoutId 2> $errFile
    $exitCode = $LASTEXITCODE
    Assert-Demo ($exitCode -eq 0) "Retry command failed ($exitCode): $output"
    $proc = Start-DemoSupervisor 'retry-command'; Wait-DemoSupervisor $proc 'retry-command'
    $db = Get-DemoDatabase $timeoutId
    Assert-Demo ($db.attemptBase -eq 2) "attempt_base expected 2, got $($db.attemptBase)"
    $global:LASTEXITCODE = 0
  })) { throw 'Step 11 failed' }

  if (-not (Step 12 'Scope locks' {
    $ErrorActionPreference = 'Continue'
    $a = [guid]::NewGuid().ToString(); $b = [guid]::NewGuid().ToString(); $c = [guid]::NewGuid().ToString()
    $shared = @('--scope', "factory-fake/$a.txt", '--scope', "factory-fake/$b.txt")
    New-DemoTask $a $shared; New-DemoTask $b $shared
    New-DemoTask $c @('--scope', "factory-fake/$c.txt")
    $env:FAKE_SLEEP_MS = '6000'
    try { $proc = Start-DemoSupervisor 'locks' } finally { Remove-Item env:FAKE_SLEEP_MS -ErrorAction SilentlyContinue }
    $watch = [Diagnostics.Stopwatch]::StartNew(); $overlap = $false; $last = ''
    while ($watch.Elapsed.TotalSeconds -lt 90) {
      $snapshot = Invoke-FactoryStatus $stateDir
      $tasks = @($snapshot.tasks | Where-Object { $_.id -in @($a, $b, $c) })
      $ta = @($tasks | Where-Object { $_.id -eq $a }); $tb = @($tasks | Where-Object { $_.id -eq $b }); $tc = @($tasks | Where-Object { $_.id -eq $c })
      if ($tasks.Count -eq 3) {
        $last = "A=$($ta[0].status), B=$($tb[0].status), C=$($tc[0].status)"
        Assert-Demo (-not ($ta[0].status -eq 'progress' -and $tb[0].status -eq 'progress')) "Overlapping tasks ran together: $last"
        if ($ta[0].status -eq 'progress' -and $tc[0].status -eq 'progress') { $overlap = $true }
        if (@($tasks | Where-Object { $_.status -eq 'done' }).Count -eq 3) { break }
      }
      if ($proc.HasExited) { break }
      Start-Sleep -Milliseconds 100
    }
    Wait-DemoSupervisor $proc 'locks'
    $snapshot = Invoke-FactoryStatus $stateDir
    $tasks = @($snapshot.tasks | Where-Object { $_.id -in @($a, $b, $c) })
    Assert-Demo ($tasks.Count -eq 3 -and @($tasks | Where-Object { $_.status -eq 'done' }).Count -eq 3 -and $overlap) "Lock demonstration failed: $last, disjoint overlap=$overlap"
    foreach ($taskId in @($a, $b, $c)) { Assert-DemoCommits $taskId 1 }
    $global:LASTEXITCODE = 0
  })) { throw 'Step 12 failed' }

  if (-not (Step 13 'Scope violation' {
    $ErrorActionPreference = 'Continue'
    $taskId = [guid]::NewGuid().ToString()
    New-DemoTask $taskId @('--scope', 'factory-fake')
    $env:FAKE_WRITE = 'outside.txt'
    try { $proc = Start-DemoSupervisor 'violation' } finally { Remove-Item env:FAKE_WRITE -ErrorAction SilentlyContinue }
    Wait-DemoSupervisor $proc 'violation'
    $task = Get-DemoTask $taskId; $attempts = @($task.attempts)
    Assert-Demo ($task.status -eq 'failed' -and $attempts.Count -eq 1 -and $attempts[0].errorClass -eq 'scope-violation') "Violation mismatch: $($task | ConvertTo-Json -Depth 10 -Compress)"
    Assert-DemoCommits $taskId 0
    $global:LASTEXITCODE = 0
  })) { throw 'Step 13 failed' }

  if (-not (Step 14 'Restart during backoff' {
    $ErrorActionPreference = 'Continue'
    $taskId = [guid]::NewGuid().ToString()
    New-DemoTask $taskId @('--max-attempts', '2')
    $env:FAKE_FAIL_UNTIL_ATTEMPT = '1'
    try { $proc = Start-DemoSupervisor 'crash' } finally { Remove-Item env:FAKE_FAIL_UNTIL_ATTEMPT -ErrorAction SilentlyContinue }
    $watch = [Diagnostics.Stopwatch]::StartNew(); $boundary = $null; $last = 'no snapshot'
    while ($watch.Elapsed.TotalSeconds -lt 30 -and -not $proc.HasExited) {
      $snapshot = Invoke-FactoryStatus $stateDir
      $found = @($snapshot.tasks | Where-Object { $_.id -eq $taskId })
      if ($found.Count -eq 1) {
        $last = $found[0] | ConvertTo-Json -Depth 10 -Compress
        $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        if ($found[0].status -eq 'ready' -and @($found[0].attempts).Count -eq 1 -and @($found[0].attempts)[0].errorClass -eq 'transient' -and $found[0].notBeforeMs -gt $now) { $boundary = $found[0]; break }
      }
      Start-Sleep -Milliseconds 50
    }
    Assert-Demo ($null -ne $boundary) "Did not observe backoff before crash: $last"
    $proc.Kill()
    Assert-Demo ($proc.WaitForExit(10000)) 'Supervisor did not stop at backoff boundary'
    $snapshot = Invoke-FactoryStatus $stateDir
    $boundaryTask = @($snapshot.tasks | Where-Object { $_.id -eq $taskId })[0]
    Assert-Demo ($boundaryTask.status -eq 'ready' -and @($boundaryTask.attempts).Count -eq 1) "Backoff changed before stop: $($boundaryTask | ConvertTo-Json -Depth 10 -Compress)"
    $takeover = $snapshot.lease.takeover
    Assert-Demo (-not [string]::IsNullOrWhiteSpace($takeover)) 'Missing takeover token'
    $delay = [Math]::Max(0, [long]$snapshot.lease.heartbeatMs + 2500 - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    if ($delay -gt 0) { Start-Sleep -Milliseconds $delay }
    $proc2 = Start-DemoSupervisor 'crash-restart' $takeover
    Wait-DemoSupervisor $proc2 'crash-restart'
    $task = Get-DemoTask $taskId; $attempts = @($task.attempts); $db = Get-DemoDatabase $taskId
    Assert-Demo ($task.status -eq 'done' -and $attempts.Count -eq 2 -and $attempts[0].errorClass -eq 'transient' -and $attempts[1].no -eq 2 -and $attempts[1].status -eq 'succeeded' -and $db.evidence -eq 1) "Restart mismatch: $($task | ConvertTo-Json -Depth 10 -Compress), evidence=$($db.evidence)"
    Assert-DemoCommits $taskId 1
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
    Remove-Item env:FAKE_SLEEP_MS, env:FAKE_HANG, env:FAKE_FAIL_UNTIL_ATTEMPT, env:FAKE_WRITE, env:FACTORY_FAULT, env:FACTORY_WT_DIR, env:FACTORY_HEAD_SHA, env:FACTORY_FILES_JSON, env:FACTORY_STATE_DIR, env:FACTORY_TASK_ID, env:FACTORY_RUN_DIR -ErrorAction SilentlyContinue
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
    Write-Host "`n===== M4 acceptance =====" -ForegroundColor Yellow
    $results | Format-Table -AutoSize
    $failed = $SkipBaseline -or $script:overallFailed -or ($results.Result -contains 'FAIL') -or ($results.Count -lt 14)
    if ($failed -and $script:failureReason -and -not $script:failureReason.StartsWith('Step ')) {
      Write-Host "Failure details: $script:failureReason" -ForegroundColor Red
    }
    if ($SkipBaseline) {
      Write-Host 'Baseline skipped: dev run, not an acceptance result' -ForegroundColor Yellow
    }
    if ($failed) {
      Write-Host 'M4: FAIL' -ForegroundColor Red
      exit 1
    } else {
      Write-Host 'M4: PASS' -ForegroundColor Green
      exit 0
    }
  } catch {
    if ($SkipBaseline) {
      Write-Host 'Baseline skipped: dev run, not an acceptance result' -ForegroundColor Yellow
    }
    Write-Host 'M4: FAIL' -ForegroundColor Red
    exit 1
  }
}
