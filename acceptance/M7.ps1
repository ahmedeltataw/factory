# M7 acceptance (L5). Run in PowerShell:  powershell -ExecutionPolicy Bypass -File acceptance\M7.ps1
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
$script:allDemoProjects = [System.Collections.Generic.List[object]]::new()
$script:fakeServerProc = $null
$script:fakeServerUrl = $null
$script:fakeLogFile = $null
$script:fakeControlFile = $null
$script:canaryToken = $null
$script:tempRepo = $null
$script:stateDir = $null
$script:baseSha = $null

$acceptanceNonce = [guid]::NewGuid().ToString('N')
$sharedBase = Join-Path $env:TEMP 'factory-m7-acceptance'
$acceptanceBase = Join-Path $sharedBase $acceptanceNonce
$dest = Join-Path $acceptanceBase 'factory'
$tempRepo = Join-Path $acceptanceBase 'demo-repo'
$stateDir = Join-Path $acceptanceBase 'state'
$logsDir = Join-Path $acceptanceBase 'logs'
$helpersDir = Join-Path $acceptanceBase 'helpers'
$fakeServerDir = Join-Path $acceptanceBase 'fake-server'
$origLocation = $null

function ConvertFrom-JsonArray($jsonInput) {
  if ($null -eq $jsonInput) { return @() }
  if ($jsonInput -is [System.Array]) {
    if ($jsonInput.Count -gt 0 -and ($jsonInput[0] -is [string])) {
      $text = ($jsonInput -join "`n").Trim()
      if ($text.StartsWith('[') -and $text.EndsWith(']')) {
        try {
          $parsed = $text | ConvertFrom-Json
          if ($null -eq $parsed) { return @() }
          return @($parsed | ForEach-Object { $_ })
        } catch {}
      }
    }
    return @($jsonInput | ForEach-Object { $_ })
  }
  if ($jsonInput -is [string]) {
    $text = $jsonInput.Trim()
    if ([string]::IsNullOrWhiteSpace($text)) { return @() }
    if ($text.StartsWith('[') -and $text.EndsWith(']')) {
      $parsed = $text | ConvertFrom-Json
      if ($null -eq $parsed) { return @() }
      return @($parsed | ForEach-Object { $_ })
    }
    if ($text.StartsWith('{') -and $text.EndsWith('}')) {
      try {
        $parsed = $text | ConvertFrom-Json
        if ($null -eq $parsed) { return @() }
        return @($parsed | ForEach-Object { $_ })
      } catch {
        return @($jsonInput)
      }
    }
    return @($jsonInput)
  }
  return @($jsonInput | ForEach-Object { $_ })
}

function Read-DemoText([string]$path) {
  if ([string]::IsNullOrWhiteSpace($path) -or -not (Test-Path -LiteralPath $path)) {
    return ''
  }
  try {
    $text = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
    if ($null -eq $text) { return '' }
    return [string]$text
  } catch {
    try {
      $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
      try {
        $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
        try {
          $content = $reader.ReadToEnd()
          if ($null -eq $content) { return '' }
          return [string]$content
        } finally {
          $reader.Dispose()
        }
      } finally {
        $stream.Dispose()
      }
    } catch {
      return ''
    }
  }
}

function Read-DemoTextStrict([string]$path) {
  if ([string]::IsNullOrWhiteSpace($path)) {
    throw "Read-DemoTextStrict: path is empty or null"
  }
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Read-DemoTextStrict: file does not exist: $path"
  }
  $item = Get-Item -LiteralPath $path -ErrorAction Stop
  if ($item.Length -eq 0) {
    return ''
  }
  try {
    $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
      if ($stream.Length -eq 0) { return '' }
      $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
      try {
        $content = $reader.ReadToEnd()
        if ($null -eq $content) { return '' }
        return [string]$content
      } finally {
        $reader.Dispose()
      }
    } finally {
      $stream.Dispose()
    }
  } catch {
    throw "Read-DemoTextStrict: error reading '$path': $($_.Exception.Message)"
  }
}

function Remove-AcceptanceTempDir([string]$dir) {
  if ([string]::IsNullOrWhiteSpace($dir)) { return }
  if (-not (Test-Path -LiteralPath $dir)) { return }
  $expectedShared = Join-Path $env:TEMP 'factory-m7-acceptance'
  $fullExpected = [System.IO.Path]::GetFullPath($expectedShared).TrimEnd([char[]]@('\', '/'))
  $fullDir = [System.IO.Path]::GetFullPath($dir).TrimEnd([char[]]@('\', '/'))
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
          $roboErr = Read-DemoText $roboErrLog
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
  if ($null -ne $script:ownedPids -and -not $script:ownedPids.Contains($targetPid)) {
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
  $dateMatch = $false
  if ($null -ne $curr.CreationDate -and $null -ne $rec.CreationDate) {
    $dateMatch = ($curr.CreationDate -eq $rec.CreationDate) -or ([Math]::Abs(($curr.CreationDate - $rec.CreationDate).TotalMilliseconds) -lt 1000)
  }
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

function Register-DemoWorkerNonces([string]$sDir) {
  if ([string]::IsNullOrWhiteSpace($sDir) -or -not (Test-Path -LiteralPath $sDir)) { return }
  $runsDir = Join-Path $sDir 'runs'
  if (-not (Test-Path -LiteralPath $runsDir)) { return }
  $workers = @(Get-ChildItem -LiteralPath $runsDir -Filter worker.json -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $workerRaw = Read-DemoText $_.FullName
      if (-not [string]::IsNullOrWhiteSpace($workerRaw)) {
        $workerRaw | ConvertFrom-Json
      } else { $null }
    } catch { $null }
  })
  foreach ($w in $workers) {
    if ($null -ne $w) {
      $wNonce = if ($w.nonce) { [string]$w.nonce } else { $null }
      if ($null -ne $script:trackedWorkerNonces -and -not [string]::IsNullOrWhiteSpace($wNonce)) {
        if (-not $script:trackedWorkerNonces.Contains($wNonce)) {
          $script:trackedWorkerNonces.Add($wNonce)
        }
      }
      if ($w.pid) {
        Register-TrackedPid ([int]$w.pid) $wNonce
      }
      if ($w.grandchildPid) {
        Register-TrackedPid ([int]$w.grandchildPid) $wNonce
      }
    }
  }
}

function Discover-AllWorkerIdentities {
  $stateDirs = [System.Collections.Generic.List[string]]::new()
  if ($null -ne $script:allDemoProjects) {
    foreach ($p in $script:allDemoProjects) {
      if ($p -and $p.StateDir -and -not $stateDirs.Contains([string]$p.StateDir)) {
        $stateDirs.Add([string]$p.StateDir)
      }
    }
  }
  if (-not [string]::IsNullOrWhiteSpace($stateDir) -and -not $stateDirs.Contains($stateDir)) {
    $stateDirs.Add($stateDir)
  }
  if (-not [string]::IsNullOrWhiteSpace($acceptanceBase) -and (Test-Path -LiteralPath $acceptanceBase)) {
    $foundDirs = @(Get-ChildItem -LiteralPath $acceptanceBase -Directory -Filter 'state*' -ErrorAction SilentlyContinue)
    foreach ($d in $foundDirs) {
      if ($d -and -not $stateDirs.Contains($d.FullName)) {
        $stateDirs.Add($d.FullName)
      }
    }
  }
  foreach ($sd in $stateDirs) {
    try {
      Register-DemoWorkerNonces $sd
    } catch {}
  }
}

function Stop-AllAcceptanceProcesses {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $timeoutSec = 15

  while ($sw.Elapsed.TotalSeconds -lt $timeoutSec) {
    try { Discover-AllWorkerIdentities } catch {}

    # 1. Stop all explicitly tracked processes started via Start-Process
    foreach ($proc in $script:startedProcesses) {
      if ($null -eq $proc) { continue }
      try {
        if (-not $proc.HasExited) {
          $proc.Kill()
          [void]$proc.WaitForExit(1000)
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

    # 3. Sweep and kill: repeat enumeration and kill every node.exe matching run dir or tracked nonces
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

    # 4. Check if any processes are still alive
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

  # 5. Survivor checks
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
      throw "Path canonicalization failed with code ${helperCodeExit}: $(Read-DemoText $helperErrFile)"
    }
    try {
      $canonicalPaths = @(ConvertFrom-JsonArray $rawPaths)
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
  $projectsToClean = [System.Collections.Generic.List[object]]::new()
  foreach ($p in $script:allDemoProjects) {
    if ($p -and $p.Repo -and $p.StateDir) {
      $projectsToClean.Add($p)
    }
  }
  if (-not [string]::IsNullOrWhiteSpace($tempRepo) -and -not [string]::IsNullOrWhiteSpace($stateDir)) {
    $already = $false
    foreach ($p in $projectsToClean) {
      if ($p.Repo -eq $tempRepo -and $p.StateDir -eq $stateDir) { $already = $true; break }
    }
    if (-not $already) {
      $projectsToClean.Add([pscustomobject]@{ Repo = $tempRepo; StateDir = $stateDir })
    }
  }

  foreach ($proj in $projectsToClean) {
    $tRepo = $proj.Repo
    $sDir = $proj.StateDir
    if ([string]::IsNullOrWhiteSpace($tRepo) -or -not (Test-Path -LiteralPath $tRepo)) { continue }
    if ([string]::IsNullOrWhiteSpace($sDir) -or -not (Test-Path -LiteralPath $sDir)) { continue }
    $wtBase = Join-Path $sDir 'worktrees'
    if (Test-Path -LiteralPath $wtBase) {
      $dirs = @(Get-ChildItem -LiteralPath $wtBase -Directory -ErrorAction SilentlyContinue)
      foreach ($d in $dirs) {
        if (-not (Test-Path -LiteralPath $d.FullName)) { continue }
        $out = & git -C $tRepo worktree remove --force "$($d.FullName)" 2>&1
        $code = $LASTEXITCODE
        if ($code -ne 0) {
          $pruneFallbackOut = & git -C $tRepo worktree prune 2>&1
          $pruneFallbackCode = $LASTEXITCODE
          if ($pruneFallbackCode -ne 0) {
            throw "Fallback 'git worktree prune' failed with code ${pruneFallbackCode}: $($pruneFallbackOut -join ' ')"
          }

          $wtListRaw = & git -C $tRepo worktree list --porcelain 2>&1
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
    $pruneOut = & git -C $tRepo worktree prune 2>&1
    $pruneCode = $LASTEXITCODE
    if ($pruneCode -ne 0) {
      throw "git worktree prune failed with code ${pruneCode}: $($pruneOut -join ' ')"
    }
  }
}

function Invoke-FactoryStatus([string]$sDir, [int]$staleAfterMs = 0) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = if ($script:nodeExe) { $script:nodeExe } else { 'node' }
  $cliPath = if ($dest -and (Test-Path -LiteralPath (Join-Path $dest 'lib\factory.mjs'))) {
    Join-Path $dest 'lib\factory.mjs'
  } else {
    'lib/factory.mjs'
  }
  $staleArg = if ($staleAfterMs -gt 0) { " --stale-after-ms $staleAfterMs" } else { '' }
  $psi.Arguments = "`"$cliPath`" status --state-dir `"$sDir`"$staleArg --json"
  $psi.WorkingDirectory = if ($dest -and (Test-Path -LiteralPath $dest)) { $dest } else { $PWD.Path }
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $proc = [System.Diagnostics.Process]::Start($psi)
  $null = $proc.Handle
  $script:startedProcesses.Add($proc)
  Register-TrackedPid $proc.Id $acceptanceNonce

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

  $stdout = [string]$outTask.Result
  $stderr = [string]$errTask.Result

  if (-not [string]::IsNullOrWhiteSpace($script:canaryToken)) {
    $canary = [string]$script:canaryToken
    if ($stderr.Contains($canary)) {
      throw "Canary token leaked in factory status stderr"
    }
  }

  $code = $proc.ExitCode
  if ($code -ne 0) {
    throw "factory status failed with exit code ${code}: $stderr"
  }
  try {
    $parsed = ($stdout | ConvertFrom-Json)
    if ($null -eq $parsed) {
      throw "factory status returned empty or null JSON"
    }
    if ($null -ne $parsed) {
      if ($null -ne $parsed.tasks) {
        $parsed.tasks = @(@(ConvertFrom-JsonArray $parsed.tasks) | ForEach-Object {
          $t = $_
          if ($null -ne $t.scope) { $t.scope = @(ConvertFrom-JsonArray $t.scope) }
          if ($null -ne $t.attempts) { $t.attempts = @(ConvertFrom-JsonArray $t.attempts) }
          if ($null -ne $t.blockedBy) { $t.blockedBy = @(ConvertFrom-JsonArray $t.blockedBy) }
          if ($null -ne $t.dependsOn) { $t.dependsOn = @(ConvertFrom-JsonArray $t.dependsOn) }
          $t
        })
      } else {
        $parsed.tasks = @()
      }
      if ($null -ne $parsed.phases) {
        $parsed.phases = @(ConvertFrom-JsonArray $parsed.phases)
      } else {
        $parsed.phases = @()
      }
      if ($null -ne $parsed.github) {
        if ($null -ne $parsed.github.repos) {
          $parsed.github.repos = @(ConvertFrom-JsonArray $parsed.github.repos)
        } else {
          $parsed.github.repos = @()
        }
        if ($null -ne $parsed.github.pending) {
          $parsed.github.pending = @(@(ConvertFrom-JsonArray $parsed.github.pending) | ForEach-Object {
            $p = $_
            if ($null -ne $p.scope) { $p.scope = @(ConvertFrom-JsonArray $p.scope) }
            $p
          })
        } else {
          $parsed.github.pending = @()
        }
      }
      if ($null -ne $parsed.quota -and $null -ne $parsed.quota.windows) {
        $parsed.quota.windows = @(ConvertFrom-JsonArray $parsed.quota.windows)
      }
      if ($null -ne $parsed.budget -and $null -ne $parsed.budget.caps) {
        $parsed.budget.caps = @(ConvertFrom-JsonArray $parsed.budget.caps)
      }
    }
    return $parsed
  } catch {
    throw "factory status JSON parse failed: $($_.Exception.Message)`nRaw stdout: $stdout`nRaw stderr: $stderr"
  }
}

function Invoke-FactoryStatusText([string]$sDir) {
  $cliPath = if ($dest -and (Test-Path -LiteralPath (Join-Path $dest 'lib\factory.mjs'))) {
    Join-Path $dest 'lib\factory.mjs'
  } else {
    'lib/factory.mjs'
  }
  $activeLogsDir = if ($logsDir) { $logsDir } elseif ($acceptanceBase) { Join-Path $acceptanceBase 'logs' } else { $env:TEMP }
  $errFile = Join-Path $activeLogsDir 'status-text.err'
  $raw = & $script:nodeExe $cliPath status --state-dir $sDir 2> $errFile
  $code = $LASTEXITCODE
  $errText = Read-DemoTextStrict $errFile
  if (-not [string]::IsNullOrWhiteSpace($script:canaryToken)) {
    $canary = [string]$script:canaryToken
    if ($errText.Contains($canary)) {
      throw "Canary token leaked in factory status text stderr ($errFile)"
    }
  }
  if ($code -ne 0) {
    throw "factory status text failed with code ${code}: $errText"
  }
  $result = if ($raw) { ($raw -join "`n") } else { '' }
  if ($null -eq $result) { return '' }
  return [string]$result
}

function Invoke-FactoryCli([string[]]$cliArgs) {
  $cliPath = if ($dest -and (Test-Path -LiteralPath (Join-Path $dest 'lib\factory.mjs'))) {
    Join-Path $dest 'lib\factory.mjs'
  } else {
    'lib/factory.mjs'
  }
  $activeLogsDir = if ($logsDir) { $logsDir } elseif ($acceptanceBase) { Join-Path $acceptanceBase 'logs' } else { $env:TEMP }
  $errFile = Join-Path $activeLogsDir ("cli-" + [guid]::NewGuid().ToString('N') + ".err")
  $raw = & $script:nodeExe $cliPath @cliArgs 2> $errFile
  $code = $LASTEXITCODE
  $errText = Read-DemoText $errFile
  if (-not [string]::IsNullOrWhiteSpace($script:canaryToken)) {
    $canary = [string]$script:canaryToken
    if ($errText.Contains($canary)) {
      throw "Canary token leaked in factory cli stderr ($errFile)"
    }
  }
  if ($code -ne 0) {
    throw "Factory CLI command 'factory $($cliArgs -join ' ')' failed with code ${code}: $errText"
  }
  return $raw
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
    $errMsg = [string]$_.Exception.Message
    $lineNum = 0
    $lineText = ''
    if ($null -ne $_.InvocationInfo) {
      $lineNum = [int]$_.InvocationInfo.ScriptLineNumber
      if ($null -ne $_.InvocationInfo.Line) {
        $lineText = ([string]$_.InvocationInfo.Line).Trim()
      }
    }
    $stack = ''
    if ($_.ScriptStackTrace) {
      $stackLines = @([string]$_.ScriptStackTrace -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -First 5)
      $stack = $stackLines -join "`n"
    }
    if (-not [string]::IsNullOrWhiteSpace($script:canaryToken)) {
      $canary = [string]$script:canaryToken
      $errMsg = $errMsg.Replace($canary, '[REDACTED_CANARY]')
      $lineText = $lineText.Replace($canary, '[REDACTED_CANARY]')
      $stack = $stack.Replace($canary, '[REDACTED_CANARY]')
    }
    Write-Host $errMsg -ForegroundColor Red
    if ($lineNum -gt 0 -or -not [string]::IsNullOrWhiteSpace($lineText)) {
      Write-Host "At line ${lineNum}: ${lineText}" -ForegroundColor Red
    }
    if (-not [string]::IsNullOrWhiteSpace($stack)) {
      Write-Host $stack -ForegroundColor Red
    }
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

function Initialize-DemoProject([string]$name) {
  $pRepo = Join-Path $acceptanceBase "demo-repo-$name"
  $pState = Join-Path $acceptanceBase "state-$name"
  if (Test-Path -LiteralPath $pRepo) { Remove-Item -LiteralPath $pRepo -Recurse -Force }
  New-Item -ItemType Directory -Path $pRepo -Force | Out-Null
  if (Test-Path -LiteralPath $pState) { Remove-Item -LiteralPath $pState -Recurse -Force }
  New-Item -ItemType Directory -Path $pState -Force | Out-Null

  $outInit = & git -C $pRepo init -q 2>&1
  if ($LASTEXITCODE -ne 0) { throw "git init failed: $($outInit -join ' ')" }
  $outCo = & git -C $pRepo checkout -B main -q 2>&1
  if ($LASTEXITCODE -ne 0) { throw "git checkout failed: $($outCo -join ' ')" }
  $outName = & git -C $pRepo config user.name "M7 Acceptance" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "git config user.name failed: $($outName -join ' ')" }
  $outEmail = & git -C $pRepo config user.email "acceptance@factory.local" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "git config user.email failed: $($outEmail -join ' ')" }
  $outCommit = & git -C $pRepo commit --allow-empty -m "Initial commit" -q 2>&1
  if ($LASTEXITCODE -ne 0) { throw "git commit failed: $($outCommit -join ' ')" }

  $baseShaRaw = & git -C $pRepo rev-parse HEAD 2>&1
  if ($LASTEXITCODE -ne 0) { throw "git rev-parse HEAD failed" }
  $pBaseSha = ($baseShaRaw -join '').Trim()

  $cliPath = if ($dest -and (Test-Path -LiteralPath (Join-Path $dest 'lib\factory.mjs'))) {
    Join-Path $dest 'lib\factory.mjs'
  } else {
    'lib/factory.mjs'
  }
  $raw = & $script:nodeExe $cliPath init --state-dir "$pState" --repo "$pRepo" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "factory init failed for ${name}: $($raw -join ' ')" }

  $projRecord = [pscustomobject]@{ Repo = $pRepo; StateDir = $pState; BaseSha = $pBaseSha }
  $script:allDemoProjects.Add($projRecord)

  $script:tempRepo = $pRepo
  $script:stateDir = $pState
  $script:baseSha = $pBaseSha

  return $projRecord
}

function New-DemoTask([string]$taskId, [string[]]$options = @(), [string]$sDir = $null) {
  $activeState = if ($sDir) { $sDir } elseif ($script:stateDir) { $script:stateDir } else { $stateDir }
  $cliPath = if ($dest -and (Test-Path -LiteralPath (Join-Path $dest 'lib\factory.mjs'))) {
    Join-Path $dest 'lib\factory.mjs'
  } else {
    'lib/factory.mjs'
  }
  $activeLogsDir = if ($logsDir) { $logsDir } elseif ($acceptanceBase) { Join-Path $acceptanceBase 'logs' } else { $env:TEMP }
  $errFile = Join-Path $activeLogsDir "create-$taskId.err"
  $cmdArgs = @('task', 'create', '--state-dir', $activeState, '--title', "Acceptance $taskId", '--command-id', $taskId) + $options
  $raw = & $script:nodeExe $cliPath @cmdArgs 2> $errFile
  $code = $LASTEXITCODE
  $errText = Read-DemoText $errFile
  if (-not [string]::IsNullOrWhiteSpace($script:canaryToken)) {
    $canary = [string]$script:canaryToken
    if ($errText.Contains($canary)) {
      throw "Canary token leaked in task create stderr ($errFile)"
    }
  }
  if ($code -ne 0) {
    throw "Task create $taskId failed with code ${code}: $errText"
  }
}

function Write-DemoGitHubPolicy {
  param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$sDir,
    [Parameter(Position = 1)]
    [string]$repoName = 'owner/repo',
    [Parameter(Position = 2)]
    [string[]]$scope = @('.'),
    [Parameter(Position = 3)]
    [int]$maxPending = 10,
    [Parameter(Position = 4)]
    [int]$maxPerActorPerDay = 0
  )
  $policy = [ordered]@{
    version = 1
    repos = @(
      [ordered]@{
        name = $repoName
        labels = @('factory')
        scope = @($scope)
      }
    )
    actors = @(
      [ordered]@{ id = 1; login = 'alice' },
      [ordered]@{ id = 2; login = 'bob' }
    )
    command = '/factory task'
    maxPendingPerRepo = $maxPending
  }
  if ($maxPerActorPerDay -gt 0) {
    $policy['maxPerActorPerDay'] = $maxPerActorPerDay
  }
  $policyJson = ConvertTo-Json -InputObject $policy -Depth 5
  $policyPath = Join-Path $sDir 'github-policy.json'
  [System.IO.File]::WriteAllText($policyPath, $policyJson, (New-Object System.Text.UTF8Encoding $false))
}

function Start-FakeGitHubServer {
  if ($null -ne $script:fakeServerProc -and -not $script:fakeServerProc.HasExited) {
    return
  }
  New-Item -ItemType Directory -Path $fakeServerDir -Force | Out-Null
  $portFile = Join-Path $fakeServerDir 'port.txt'
  $logFile = Join-Path $fakeServerDir 'requests.jsonl'
  $controlFile = Join-Path $fakeServerDir 'control.json'
  if (Test-Path -LiteralPath $portFile) { Remove-Item -LiteralPath $portFile -Force }

  $fakeScript = if ($dest -and (Test-Path -LiteralPath (Join-Path $dest 'acceptance\lib\fake-github.mjs'))) {
    Join-Path $dest 'acceptance\lib\fake-github.mjs'
  } elseif (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'lib\fake-github.mjs')) {
    Join-Path $PSScriptRoot 'lib\fake-github.mjs'
  } else {
    'acceptance/lib/fake-github.mjs'
  }

  $proc = Start-Process -FilePath $script:nodeExe `
    -ArgumentList "`"$fakeScript`" --port-file `"$portFile`" --log-file `"$logFile`" --control-file `"$controlFile`" --nonce `"$acceptanceNonce`"" `
    -RedirectStandardOutput (Join-Path $logsDir 'fake-github.out') `
    -RedirectStandardError (Join-Path $logsDir 'fake-github.err') `
    -PassThru -NoNewWindow
  $null = $proc.Handle
  $script:startedProcesses.Add($proc)
  Register-TrackedPid $proc.Id $acceptanceNonce
  $script:fakeServerProc = $proc

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while (-not (Test-Path -LiteralPath $portFile) -and $sw.Elapsed.TotalSeconds -lt 15) {
    if ($proc.HasExited) {
      $err = Read-DemoText (Join-Path $logsDir 'fake-github.err')
      throw "Fake GitHub server exited prematurely with code $($proc.ExitCode): $err"
    }
    Start-Sleep -Milliseconds 50
  }
  if (-not (Test-Path -LiteralPath $portFile)) {
    throw "Fake GitHub server did not write port file within 15s"
  }
  $portRaw = Read-DemoText $portFile
  $rawUrl = $portRaw.Trim()
  if ([string]::IsNullOrWhiteSpace($rawUrl) -or -not $rawUrl.StartsWith('http://127.0.0.1:')) {
    throw "Invalid URL from Fake GitHub server: $rawUrl"
  }
  $script:fakeServerUrl = $rawUrl
  $script:fakeLogFile = $logFile
  $script:fakeControlFile = $controlFile
  Write-Host "Fake GitHub server listening at $script:fakeServerUrl"
}

function Set-FakeGitHubEvents([string]$repo, [array]$events, [string]$etag = $null) {
  $repoEntry = [ordered]@{
    events = @($events)
  }
  if (-not [string]::IsNullOrWhiteSpace($etag)) {
    $repoEntry['etag'] = $etag
  }
  $controlData = [ordered]@{
    repos = [ordered]@{
      $repo = $repoEntry
    }
  }
  $json = ConvertTo-Json -InputObject $controlData -Depth 10
  $targetFile = $script:fakeControlFile
  [System.IO.File]::WriteAllText($targetFile, $json, (New-Object System.Text.UTF8Encoding $false))
}

function Clear-DemoFakeServerLogs {
  if (-not [string]::IsNullOrWhiteSpace($script:fakeLogFile) -and (Test-Path -LiteralPath $script:fakeLogFile)) {
    [System.IO.File]::WriteAllText($script:fakeLogFile, '', (New-Object System.Text.UTF8Encoding $false))
  }
}

function New-GitHubIssueCommentEvent(
  [string]$id,
  [string]$repo,
  [int]$actorId,
  [string]$actorLogin,
  [string]$commentBody,
  [string[]]$labels = @('factory'),
  [switch]$IsBot,
  [switch]$IsPullRequest,
  [string]$issueTitle = 'Issue title',
  [int]$issueNumber = 42
) {
  $actorType = if ($IsBot) { 'Bot' } else { 'User' }
  $issueObj = [ordered]@{
    number = $issueNumber
    title = $issueTitle
    body = 'Issue body'
    labels = @($labels | ForEach-Object { [ordered]@{ name = $_ } })
  }
  if ($IsPullRequest) {
    $issueObj['pull_request'] = [ordered]@{}
  }
  return [ordered]@{
    id = $id
    type = 'IssueCommentEvent'
    actor = [ordered]@{
      id = $actorId
      login = $actorLogin
      type = $actorType
    }
    repo = [ordered]@{
      name = $repo
    }
    payload = [ordered]@{
      action = 'created'
      issue = $issueObj
      comment = [ordered]@{
        body = $commentBody
      }
    }
    created_at = '2026-11-15T00:00:00.000Z'
  }
}

function Start-DemoSupervisor([string]$name, [string]$takeover = '', [string]$sDir = $null, [hashtable]$extraEnv = $null) {
  $activeState = if ($sDir) { $sDir } elseif ($script:stateDir) { $script:stateDir } else { $stateDir }
  $extra = if ($takeover) { " --takeover $takeover" } else { '' }

  $envToSet = @{}
  if ($script:fakeServerUrl) {
    $envToSet['FACTORY_GITHUB_API_URL'] = $script:fakeServerUrl
  }
  if ($script:canaryToken) {
    $envToSet['FACTORY_GITHUB_TOKEN'] = $script:canaryToken
  }
  if ($null -ne $extraEnv) {
    foreach ($k in $extraEnv.Keys) {
      $envToSet[$k] = $extraEnv[$k]
    }
  }

  $oldEnv = @{}
  foreach ($k in $envToSet.Keys) {
    $oldEnv[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
    [Environment]::SetEnvironmentVariable($k, $envToSet[$k], 'Process')
  }

  try {
    $cliPath = if ($dest -and (Test-Path -LiteralPath (Join-Path $dest 'lib\factory.mjs'))) {
      Join-Path $dest 'lib\factory.mjs'
    } else {
      'lib/factory.mjs'
    }
    $workDir = if ($dest -and (Test-Path -LiteralPath $dest)) { $dest } else { $PWD.Path }
    $proc = Start-Process -FilePath $script:nodeExe `
      -ArgumentList "`"$cliPath`" start --state-dir `"$activeState`" --exit-when-idle --stale-after-ms 2000 --heartbeat-ms 200$extra" `
      -WorkingDirectory $workDir `
      -RedirectStandardOutput (Join-Path $logsDir "$name.out") `
      -RedirectStandardError (Join-Path $logsDir "$name.err") `
      -PassThru -NoNewWindow
    $null = $proc.Handle
    $script:startedProcesses.Add($proc)
    Register-TrackedPid $proc.Id $acceptanceNonce
    return $proc
  } finally {
    foreach ($k in $envToSet.Keys) {
      [Environment]::SetEnvironmentVariable($k, $oldEnv[$k], 'Process')
    }
  }
}

function Wait-DemoSupervisor($proc, [string]$name, [int]$timeoutSec = 90) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  if (-not $proc.WaitForExit($timeoutSec * 1000)) {
    try {
      if (-not $proc.HasExited) { $proc.Kill() }
      [void]$proc.WaitForExit(1000)
    } catch {}
    throw "Supervisor $name timed out after ${timeoutSec}s"
  }
  if ($proc.ExitCode -ne 0) {
    $errPath = Join-Path $logsDir "$name.err"
    $errContent = Read-DemoText $errPath
    throw "Supervisor $name exited with code $($proc.ExitCode): $errContent"
  }
}

function Get-DemoTask([string]$taskId, [string]$sDir = $null) {
  $activeState = if ($sDir) { $sDir } elseif ($script:stateDir) { $script:stateDir } else { $stateDir }
  $snapshot = Invoke-FactoryStatus $activeState
  $tasks = if ($null -ne $snapshot -and $null -ne $snapshot.tasks) { @($snapshot.tasks) } else { @() }
  $found = @($tasks | Where-Object { $null -ne $_ -and $_.id -eq $taskId })
  if ($found.Count -ne 1) { throw "Expected task $taskId once, found $($found.Count)" }
  return $found[0]
}

function Get-DemoDatabase([string]$taskId, [string]$sDir = $null) {
  $activeState = if ($sDir) { $sDir } elseif ($script:stateDir) { $script:stateDir } else { $stateDir }
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
  $env:FACTORY_STATE_DIR = $activeState
  $env:FACTORY_TASK_ID = $taskId
  try {
    $errFile = Join-Path $logsDir "db-$taskId.err"
    $raw = & $script:nodeExe $helper 2> $errFile
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) { throw "Database read failed ($exitCode): $(Read-DemoText $errFile)" }
    try {
      $parsed = (($raw -join "`n") | ConvertFrom-Json)
      return [pscustomobject]@{
        attemptBase = $parsed.attemptBase
        evidence    = $parsed.evidence
        attempts    = @(ConvertFrom-JsonArray $parsed.attempts)
      }
    } catch { throw "Invalid database JSON: $raw" }
  } finally { Remove-Item env:FACTORY_STATE_DIR, env:FACTORY_TASK_ID -ErrorAction SilentlyContinue }
}

function Get-DemoCommandOutcome([string]$cmdId, [string]$sDir = $null) {
  $activeState = if ($sDir) { $sDir } elseif ($script:stateDir) { $script:stateDir } else { $stateDir }
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
  $env:FACTORY_STATE_DIR = $activeState
  $env:FACTORY_COMMAND_ID = $cmdId
  try {
    $errFile = Join-Path $logsDir "cmd-$cmdId.err"
    $raw = & $script:nodeExe $helper 2> $errFile
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) { throw "Command outcome read failed ($exitCode): $(Read-DemoText $errFile)" }
    try { return (($raw -join "`n") | ConvertFrom-Json) } catch { throw "Invalid command outcome JSON: $raw" }
  } finally { Remove-Item env:FACTORY_STATE_DIR, env:FACTORY_COMMAND_ID -ErrorAction SilentlyContinue }
}

function Get-DemoGitHubData([string]$sDir = $null) {
  $activeState = if ($sDir) { $sDir } elseif ($script:stateDir) { $script:stateDir } else { $stateDir }
  $helper = Join-Path $helpersDir 'read-github-data.mjs'
  $code = @'
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
const db = new DatabaseSync(join(process.env.FACTORY_STATE_DIR, 'state.sqlite'), { readOnly: true });
try {
  const events = db.prepare('SELECT event_id, repo, kind, actor_id, actor_login, issue, status, reason, title, scope_json, task_id FROM github_events ORDER BY CAST(event_id AS INTEGER) ASC').all();
  const cursors = db.prepare('SELECT repo, etag, next_poll_ms, error FROM github_cursor ORDER BY repo ASC').all();
  process.stdout.write(JSON.stringify({ events, cursors }));
} finally { db.close(); }
'@
  [System.IO.File]::WriteAllText($helper, $code, (New-Object System.Text.UTF8Encoding $false))
  $env:FACTORY_STATE_DIR = $activeState
  try {
    $errFile = Join-Path $logsDir 'read-github-data.err'
    $raw = & $script:nodeExe $helper 2> $errFile
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) { throw "Failed to read GitHub database data ($exitCode): $(Read-DemoText $errFile)" }
    try {
      $parsed = (($raw -join "`n") | ConvertFrom-Json)
      return [pscustomobject]@{
        events  = @(ConvertFrom-JsonArray $parsed.events)
        cursors = @(ConvertFrom-JsonArray $parsed.cursors)
      }
    } catch { throw "Invalid GitHub database JSON: $raw" }
  } finally { Remove-Item env:FACTORY_STATE_DIR -ErrorAction SilentlyContinue }
}

function Get-DemoQuotaData([string]$sDir = $null) {
  $activeState = if ($sDir) { $sDir } elseif ($script:stateDir) { $script:stateDir } else { $stateDir }
  $activeHelpersDir = if ($helpersDir) { $helpersDir } elseif ($acceptanceBase) { Join-Path $acceptanceBase 'helpers' } else { $env:TEMP }
  $activeLogsDir = if ($logsDir) { $logsDir } elseif ($acceptanceBase) { Join-Path $acceptanceBase 'logs' } else { $env:TEMP }
  $helper = Join-Path $activeHelpersDir 'read-quota-data.mjs'
  $code = @'
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
const db = new DatabaseSync(join(process.env.FACTORY_STATE_DIR, 'state.sqlite'), { readOnly: true });
try {
  const attempts = db.prepare('SELECT id, task_id, attempt_no, status, started_at, ended_at FROM attempts ORDER BY attempt_no').all();
  const workers = db.prepare('SELECT attempt_id, pid, state FROM workers').all();
  const startedAttempts = db.prepare('SELECT a.id, a.task_id, a.attempt_no, a.status FROM attempts a WHERE EXISTS (SELECT 1 FROM workers w WHERE w.attempt_id = a.id)').all();
  const reservations = db.prepare('SELECT id, attempt_id, provider, units, state, reserved_at_ms, closed_at_ms FROM quota_reservations').all();
  const terminalWithReserved = db.prepare("SELECT r.id, a.id AS attempt_id, a.status AS attempt_status, r.state FROM quota_reservations r JOIN attempts a ON a.id = r.attempt_id WHERE r.state = 'reserved' AND a.status IN ('succeeded', 'failed', 'interrupted', 'killed')").all();
  const limits = db.prepare('SELECT max_parallel FROM project_limits').all();
  const windows = db.prepare('SELECT provider, window_ms, max_units FROM quota_windows').all();
  const caps = db.prepare('SELECT level, key, cap_units FROM budget_caps').all();
  process.stdout.write(JSON.stringify({ attempts, workers, startedAttempts, reservations, terminalWithReserved, limits, windows, caps }));
} finally { db.close(); }
'@
  [System.IO.File]::WriteAllText($helper, $code, (New-Object System.Text.UTF8Encoding $false))
  $prevDir = $env:FACTORY_STATE_DIR
  $env:FACTORY_STATE_DIR = $activeState
  try {
    $errFile = Join-Path $activeLogsDir 'read-quota-data.err'
    $raw = & $script:nodeExe $helper 2> $errFile
    $codeExit = $LASTEXITCODE
    $errText = Read-DemoText $errFile
    if (-not [string]::IsNullOrWhiteSpace($script:canaryToken)) {
      $canary = [string]$script:canaryToken
      if ($errText.Contains($canary)) {
        throw "Canary token leaked in read quota data stderr ($errFile)"
      }
    }
    if ($codeExit -ne 0) {
      throw "Failed to read quota data ($codeExit): $errText"
    }
    try {
      $parsed = (($raw -join "`n") | ConvertFrom-Json)
      return [pscustomobject]@{
        attempts             = @(ConvertFrom-JsonArray $parsed.attempts)
        workers              = @(ConvertFrom-JsonArray $parsed.workers)
        startedAttempts      = @(ConvertFrom-JsonArray $parsed.startedAttempts)
        reservations         = @(ConvertFrom-JsonArray $parsed.reservations)
        terminalWithReserved = @(ConvertFrom-JsonArray $parsed.terminalWithReserved)
        limits               = @(ConvertFrom-JsonArray $parsed.limits)
        windows              = @(ConvertFrom-JsonArray $parsed.windows)
        caps                 = @(ConvertFrom-JsonArray $parsed.caps)
      }
    } catch {
      throw "Invalid quota data JSON: $raw"
    }
  } finally {
    $env:FACTORY_STATE_DIR = $prevDir
  }
}

function Assert-DemoCanaryAbsent([string]$sDir, [string]$canary) {
  if ([string]::IsNullOrWhiteSpace($canary)) {
    throw "Assert-DemoCanaryAbsent: canary token is empty or null"
  }
  if ([string]::IsNullOrWhiteSpace($sDir) -or -not (Test-Path -LiteralPath $sDir)) {
    throw "Assert-DemoCanaryAbsent: state directory does not exist: $sDir"
  }
  $activeHelpersDir = if ($helpersDir) { $helpersDir } elseif ($acceptanceBase) { Join-Path $acceptanceBase 'helpers' } else { $env:TEMP }
  $activeLogsDir = if ($logsDir) { $logsDir } elseif ($acceptanceBase) { Join-Path $acceptanceBase 'logs' } else { $env:TEMP }
  $helper = Join-Path $activeHelpersDir 'scan-canary.mjs'
  $code = @'
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.FACTORY_SCAN_DIR;
const canary = process.env.FACTORY_CANARY;
const canaryBuf = Buffer.from(canary, 'utf8');
const matches = [];

function walk(dir) {
  if (!existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    process.stderr.write(`Canary scanner failed to read directory ${dir}: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.isFile()) {
      try {
        const content = readFileSync(full);
        if (content.includes(canaryBuf)) {
          matches.push(full);
        }
      } catch (err) {
        process.stderr.write(`Canary scanner failed to read file ${full}: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    }
  }
}
walk(root);
process.stdout.write(JSON.stringify(matches));
'@
  [System.IO.File]::WriteAllText($helper, $code, (New-Object System.Text.UTF8Encoding $false))
  $env:FACTORY_SCAN_DIR = $sDir
  $env:FACTORY_CANARY = $canary
  try {
    $errFile = Join-Path $activeLogsDir 'scan-canary.err'
    $raw = & $script:nodeExe $helper 2> $errFile
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
      $errContent = Read-DemoTextStrict $errFile
      throw "Failed to scan canary ($exitCode): $errContent"
    }
    $matches = @(ConvertFrom-JsonArray $raw)
    if ($matches.Count -gt 0) {
      throw "Canary token was found in files: $($matches -join ', ')"
    }
  } finally { Remove-Item env:FACTORY_SCAN_DIR, env:FACTORY_CANARY -ErrorAction SilentlyContinue }
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
  New-Item -ItemType Directory -Path $fakeServerDir -Force | Out-Null

  $script:canaryToken = 'ghp_CANARY_TOKEN_' + [guid]::NewGuid().ToString('N')

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
        $refErr = (Read-DemoText $refErrFile).Trim()
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
      $cloneErr = (Read-DemoText $cloneErrFile).Trim()
      throw "git clone failed with exit code $($cloneExit) - $cloneErr"
    }

    $shaErrFile = Join-Path $logsDir 'git-rev-parse-cloned.err'
    $shaRaw = & git -C $dest rev-parse HEAD 2> $shaErrFile
    $shaExit = $LASTEXITCODE
    if ($shaExit -ne 0) {
      $shaErr = (Read-DemoText $shaErrFile).Trim()
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
    $outName = & git -C $tempRepo config user.name "M7 Acceptance" 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git config user.name failed: $($outName -join ' ')" }
    $outEmail = & git -C $tempRepo config user.email "acceptance@factory.local" 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git config user.email failed: $($outEmail -join ' ')" }
    $outCommit = & git -C $tempRepo commit --allow-empty -m "Initial commit" -q 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git commit failed: $($outCommit -join ' ')" }

    $baseShaRaw = & git -C $tempRepo rev-parse HEAD
    if ($LASTEXITCODE -ne 0) { throw "git rev-parse HEAD failed" }
    $baseSha = ($baseShaRaw -join '').Trim()
    $script:baseSha = $baseSha
    $script:tempRepo = $tempRepo
    $script:stateDir = $stateDir
    $script:allDemoProjects.Add([pscustomobject]@{ Repo = $tempRepo; StateDir = $stateDir; BaseSha = $baseSha })
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

  # =========================================================================
  # Step 11: Parallel cap
  # =========================================================================
  if (-not (Step 11 'Parallel cap: limits set max-parallel 1, three tasks run with at most one in progress and waiting tasks show slots' {
    $ErrorActionPreference = 'Continue'
    $proj = Initialize-DemoProject 'parallel'
    $pState = $proj.StateDir

    # 1. Set max-parallel to 1
    Invoke-FactoryCli @('limits', 'set', '--state-dir', $pState, '--max-parallel', '1')

    # 2. Create three non-overlapping tasks
    $t1 = [guid]::NewGuid().ToString()
    $t2 = [guid]::NewGuid().ToString()
    $t3 = [guid]::NewGuid().ToString()

    New-DemoTask $t1 @('--scope', 'src/t1', '--scope', "factory-fake/${t1}.txt") $pState
    New-DemoTask $t2 @('--scope', 'src/t2', '--scope', "factory-fake/${t2}.txt") $pState
    New-DemoTask $t3 @('--scope', 'src/t3', '--scope', "factory-fake/${t3}.txt") $pState

    # 3. Start supervisor with fake executor slow enough to overlap (4000ms)
    $proc = Start-DemoSupervisor 'parallel-sup' -sDir $pState -extraEnv @{ FAKE_SLEEP_MS = '4000' }

    # 4. Poll status in a loop while tasks run: assert at no sampled moment > 1 in progress
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $maxInProgress = 0
    $sawSlotsWait = $false
    $sawParallel1 = $false

    while ($sw.Elapsed.TotalSeconds -lt 75 -and -not $proc.HasExited) {
      $snap = Invoke-FactoryStatus $pState
      $inProg = @($snap.tasks | Where-Object { $_.status -eq 'progress' })
      if ($inProg.Count -gt $maxInProgress) {
        $maxInProgress = $inProg.Count
      }
      Assert-Demo ($inProg.Count -le 1) "At sampled moment more than 1 task was in progress: $($inProg.Count)"

      if ($null -ne $snap.limits -and $snap.limits.maxParallel -eq 1) {
        $sawParallel1 = $true
      }

      $waitingSlots = @($snap.tasks | Where-Object { $_.status -eq 'ready' -and $null -ne $_.waiting -and $_.waiting.reason -eq 'slots' })
      if ($waitingSlots.Count -gt 0) {
        $sawSlotsWait = $true
      }

      $allDone = @($snap.tasks | Where-Object { $_.status -eq 'done' })
      if ($allDone.Count -eq 3) {
        break
      }
      Start-Sleep -Milliseconds 100
    }

    Wait-DemoSupervisor $proc 'parallel-sup' 75
    Register-DemoWorkerNonces $pState

    $finalSnap = Invoke-FactoryStatus $pState
    Assert-Demo ($maxInProgress -le 1) "Maximum in-progress tasks exceeded 1: $maxInProgress"
    Assert-Demo ($sawParallel1 -or ($null -ne $finalSnap.limits -and $finalSnap.limits.maxParallel -eq 1)) "limits.maxParallel was not 1"
    Assert-Demo $sawSlotsWait "No task was observed waiting with reason 'slots'"
    Assert-Demo (@($finalSnap.tasks | Where-Object { $_.status -eq 'done' }).Count -eq 3) "Not all three tasks completed done"

    $global:LASTEXITCODE = 0
  })) { throw 'Step 11 failed' }

  # =========================================================================
  # Step 12: Quota window
  # =========================================================================
  if (-not (Step 12 'Quota window: quota set 2 per 30s, two tasks run and third waits quota then runs after window slides' {
    $ErrorActionPreference = 'Continue'
    $proj = Initialize-DemoProject 'quota'
    $pState = $proj.StateDir

    # 1. Set quota: window 30s, max 2 units
    Invoke-FactoryCli @('quota', 'set', '--state-dir', $pState, '--provider', 'default', '--window-ms', '30000', '--max-units', '2')

    # 2. Create three non-overlapping tasks
    $t1 = [guid]::NewGuid().ToString()
    $t2 = [guid]::NewGuid().ToString()
    $t3 = [guid]::NewGuid().ToString()

    New-DemoTask $t1 @('--scope', 'src/t1', '--scope', "factory-fake/${t1}.txt", '--provider', 'default') $pState
    New-DemoTask $t2 @('--scope', 'src/t2', '--scope', "factory-fake/${t2}.txt", '--provider', 'default') $pState
    New-DemoTask $t3 @('--scope', 'src/t3', '--scope', "factory-fake/${t3}.txt", '--provider', 'default') $pState

    # 3. Start supervisor
    $proc = Start-DemoSupervisor 'quota-sup' -sDir $pState

    # 4. Poll status: observe first 2 run, third waits with reason 'quota', quota.windows resetsAt, dispatch = waiting-quota
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $sawWaitingQuota = $false
    $observedRetryAtMs = 0
    $sawDispatchWaitingQuota = $false
    $checkedBeforeExpiry = $false

    while ($sw.Elapsed.TotalSeconds -lt 90 -and -not $proc.HasExited) {
      $snap = Invoke-FactoryStatus $pState
      if ($snap.dispatch -eq 'waiting-quota') {
        $sawDispatchWaitingQuota = $true
      }

      $waitingTasks = @($snap.tasks | Where-Object { $_.id -eq $t3 -and $_.status -eq 'ready' -and $null -ne $_.waiting -and $_.waiting.reason -eq 'quota' })
      if ($waitingTasks.Count -gt 0) {
        $sawWaitingQuota = $true
        $wt = $waitingTasks[0]
        if ($null -ne $snap.quota -and $null -ne $snap.quota.windows) {
          $defWindow = @($snap.quota.windows | Where-Object { $_.provider -eq 'default' })
          if ($defWindow.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace($defWindow[0].resetsAt)) {
            $observedRetryAtMs = [long][DateTimeOffset]::Parse($defWindow[0].resetsAt).ToUnixTimeMilliseconds()
          }
        }

        # Take the pre-expiry assertions (exactly two attempts started, third has no attempt) from ONE snapshot read right after observing the wait (status and DB reads close together)
        if (-not $checkedBeforeExpiry -and $observedRetryAtMs -gt 0) {
          $nowUtcMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
          if ($nowUtcMs -lt $observedRetryAtMs) {
            # Assert third task has NO attempt row while waiting (in status and in DB)
            Assert-Demo (@($wt.attempts).Count -eq 0) "Third task has attempt rows in status while waiting for quota"
            $dbT3Waiting = Get-DemoDatabase $t3 $pState
            Assert-Demo (@($dbT3Waiting.attempts).Count -eq 0) "Third task has attempt rows in database while waiting for quota"

            # Assert exactly two attempts have started before the window expires
            $qDataBefore = Get-DemoQuotaData $pState
            Assert-Demo ($qDataBefore.attempts.Count -eq 2) "Expected exactly two attempts started before window expires, found $($qDataBefore.attempts.Count)"
            $checkedBeforeExpiry = $true
          }
        }
      }

      $allDone = @($snap.tasks | Where-Object { $_.status -eq 'done' })
      if ($allDone.Count -eq 3) {
        break
      }
      Start-Sleep -Milliseconds 150
    }

    Wait-DemoSupervisor $proc 'quota-sup' 90
    Register-DemoWorkerNonces $pState

    $finalSnap = Invoke-FactoryStatus $pState
    Assert-Demo $sawWaitingQuota "No task was observed waiting with reason 'quota'"
    Assert-Demo ($observedRetryAtMs -gt 0) "quota.windows resetsAt was not observed while the third task waited"
    Assert-Demo $checkedBeforeExpiry "Did not verify that exactly two attempts started before window expiry"
    Assert-Demo $sawDispatchWaitingQuota "Status dispatch was not observed as 'waiting-quota'"
    Assert-Demo (@($finalSnap.tasks | Where-Object { $_.status -eq 'done' }).Count -eq 3) "Not all three tasks completed done"

    # Compare third task's attempt started time with observed retryAtMs
    $dbT3Final = Get-DemoDatabase $t3 $pState
    Assert-Demo (@($dbT3Final.attempts).Count -ge 1) "Third task has no attempts after completion"
    $t3Attempt = $dbT3Final.attempts[0]
    $t3StartedAtMs = [DateTimeOffset]::Parse($t3Attempt.started_at).ToUnixTimeMilliseconds()

    # Assert third task attempt started no earlier than retryAtMs (allow tolerance on late side)
    Assert-Demo ($t3StartedAtMs -ge $observedRetryAtMs) "Third task attempt started at $t3StartedAtMs, which is earlier than retryAtMs $observedRetryAtMs (premature resume)"
    Assert-Demo ($t3StartedAtMs -le ($observedRetryAtMs + 60000)) "Third task attempt started too late ($t3StartedAtMs vs retryAtMs $observedRetryAtMs)"

    # Also assert all attempts ended succeeded
    foreach ($t in $finalSnap.tasks) {
      Assert-Demo ($t.status -eq 'done') "Task $($t.id) status expected done, got $($t.status)"
      Assert-Demo (@($t.attempts).Count -ge 1) "Task $($t.id) has no attempts"
      $lastAttempt = @($t.attempts)[-1]
      Assert-Demo ($lastAttempt.status -eq 'succeeded') "Task $($t.id) last attempt expected succeeded, got $($lastAttempt.status)"
    }

    $global:LASTEXITCODE = 0
  })) { throw 'Step 12 failed' }

  # =========================================================================
  # Step 13: Project budget
  # =========================================================================
  if (-not (Step 13 'Project budget: cap 2 pauses dispatch at 100%, cap 5 resumes and completes third task, Arabic text clean' {
    $ErrorActionPreference = 'Continue'
    $proj = Initialize-DemoProject 'budget'
    $pState = $proj.StateDir

    # 1. Set project budget cap to 2
    Invoke-FactoryCli @('budget', 'set', '--state-dir', $pState, '--level', 'project', '--cap', '2')

    # 2. Create three non-overlapping tasks
    $t1 = [guid]::NewGuid().ToString()
    $t2 = [guid]::NewGuid().ToString()
    $t3 = [guid]::NewGuid().ToString()

    New-DemoTask $t1 @('--scope', 'src/t1', '--scope', "factory-fake/${t1}.txt") $pState
    New-DemoTask $t2 @('--scope', 'src/t2', '--scope', "factory-fake/${t2}.txt") $pState
    New-DemoTask $t3 @('--scope', 'src/t3', '--scope', "factory-fake/${t3}.txt") $pState

    # 3. Start supervisor: runs first 2 tasks, halts at 100% budget cap
    $proc1 = Start-DemoSupervisor 'budget-cap2' -sDir $pState
    Wait-DemoSupervisor $proc1 'budget-cap2' 35
    Register-DemoWorkerNonces $pState

    # 4. Assert: dispatch stops at 100%, third task stays ready with reason budget, budget.caps[0].state = stop, pct 100
    $snap1 = Invoke-FactoryStatus $pState
    $doneCount1 = @($snap1.tasks | Where-Object { $_.status -eq 'done' }).Count
    Assert-Demo ($doneCount1 -eq 2) "Expected exactly 2 done tasks, found $doneCount1"

    $t3Obj = Get-DemoTask $t3 $pState
    Assert-Demo ($t3Obj.status -eq 'ready') "Third task expected status ready, got $($t3Obj.status)"
    Assert-Demo ($null -ne $t3Obj.waiting -and $t3Obj.waiting.reason -eq 'budget') "Third task waiting reason expected 'budget', got $(if ($t3Obj.waiting) { $t3Obj.waiting.reason } else { '<null>' })"

    Assert-Demo ($snap1.dispatch -eq 'paused-budget') "Dispatch expected 'paused-budget', got '$($snap1.dispatch)'"
    Assert-Demo ($null -ne $snap1.budget -and $snap1.budget.caps.Count -ge 1) "Budget status caps missing"
    $cap0 = $snap1.budget.caps[0]
    Assert-Demo ($cap0.state -eq 'stop') "Budget cap state expected 'stop', got '$($cap0.state)'"
    Assert-Demo ($cap0.pct -eq 100) "Budget cap pct expected 100, got $($cap0.pct)"

    # 5. Assert Arabic status text contains no wording about remaining tokens
    $statusText = [string](Invoke-FactoryStatusText $pState)
    $forbiddenWords = @('متبق', 'المتبقي', 'رموز', 'توكن', 'tokens', 'remaining')
    foreach ($w in $forbiddenWords) {
      Assert-Demo (-not $statusText.Contains($w)) "Arabic status text contained forbidden word '$w'"
    }

    # 6. Raise budget cap to 5 and resume
    Invoke-FactoryCli @('budget', 'set', '--state-dir', $pState, '--level', 'project', '--cap', '5')

    $proc2 = Start-DemoSupervisor 'budget-cap5' -sDir $pState
    Wait-DemoSupervisor $proc2 'budget-cap5' 35
    Register-DemoWorkerNonces $pState

    # 7. Assert third task runs and completes done
    $snap2 = Invoke-FactoryStatus $pState
    $t3Final = Get-DemoTask $t3 $pState
    Assert-Demo ($t3Final.status -eq 'done') "Third task expected done after budget increase, got $($t3Final.status)"
    Assert-Demo ($snap2.dispatch -eq 'open') "Dispatch status expected 'open', got '$($snap2.dispatch)'"
    Assert-Demo (@($snap2.tasks | Where-Object { $_.status -eq 'done' }).Count -eq 3) "Not all three tasks completed done"

    $global:LASTEXITCODE = 0
  })) { throw 'Step 13 failed' }

  # =========================================================================
  # Step 14: Intake budget
  # =========================================================================
  if (-not (Step 14 'Intake budget: maxPerActorPerDay policy rejects third issue event with actor-daily-limit' {
    $ErrorActionPreference = 'Continue'
    if ([string]::IsNullOrWhiteSpace($script:canaryToken)) {
      $script:canaryToken = 'ghp_CANARY_TOKEN_' + [guid]::NewGuid().ToString('N')
    }
    $proj = Initialize-DemoProject 'intake-budget'
    $pState = $proj.StateDir

    # 1. Start fake GitHub server and configure policy with maxPerActorPerDay = 2
    Start-FakeGitHubServer
    Write-DemoGitHubPolicy -sDir $pState -repoName 'owner/repo' -scope @('.') -maxPending 10 -maxPerActorPerDay 2

    # 2. Three issue events from actor alice (id 1)
    $ev1 = New-GitHubIssueCommentEvent '7001' 'owner/repo' 1 'alice' '/factory task Task 1' -issueNumber 10
    $ev2 = New-GitHubIssueCommentEvent '7002' 'owner/repo' 1 'alice' '/factory task Task 2' -issueNumber 11
    $ev3 = New-GitHubIssueCommentEvent '7003' 'owner/repo' 1 'alice' '/factory task Task 3' -issueNumber 12

    Clear-DemoFakeServerLogs
    Set-FakeGitHubEvents 'owner/repo' @($ev1, $ev2, $ev3)

    # 3. Start supervisor: polls and ingests events
    $proc = Start-DemoSupervisor 'intake-budget-sup' -sDir $pState
    Wait-DemoSupervisor $proc 'intake-budget-sup' 30

    # 4. Assert: third event stored rejected with reason actor-daily-limit
    $ghData = Get-DemoGitHubData $pState
    $events = @($ghData.events)
    Assert-Demo ($events.Count -eq 3) "Expected 3 events in github_events, found $($events.Count)"

    $e1 = @($events | Where-Object { $_.event_id -eq '7001' })[0]
    $e2 = @($events | Where-Object { $_.event_id -eq '7002' })[0]
    $e3 = @($events | Where-Object { $_.event_id -eq '7003' })[0]

    Assert-Demo ($e1.status -eq 'pending') "Event 7001 status expected pending, got $($e1.status)"
    Assert-Demo ($e2.status -eq 'pending') "Event 7002 status expected pending, got $($e2.status)"
    Assert-Demo ($e3.status -eq 'rejected') "Event 7003 status expected rejected, got $($e3.status)"
    Assert-Demo ($e3.reason -eq 'actor-daily-limit') "Event 7003 reason expected 'actor-daily-limit', got '$($e3.reason)'"

    # Status github section verification
    $snap = Invoke-FactoryStatus $pState
    Assert-Demo ($null -ne $snap.github) "Status missing github section"
    Assert-Demo ($snap.github.events.pending -eq 2) "Status github pending count expected 2, got $($snap.github.events.pending)"
    Assert-Demo ($snap.github.events.rejected -ge 1) "Status github rejected count expected >= 1, got $($snap.github.events.rejected)"

    # Verify that the server's request log file does not leak the secret canary token value (fail-closed)
    Assert-Demo (Test-Path -LiteralPath $script:fakeLogFile) "Server request log missing: $($script:fakeLogFile)"
    $logRaw = Read-DemoTextStrict $script:fakeLogFile
    if (-not [string]::IsNullOrWhiteSpace($script:canaryToken)) {
      Assert-Demo (-not $logRaw.Contains([string]$script:canaryToken)) "Canary token was leaked into server request log!"
    }

    # Canary token appears in none of the files under state directory
    if (-not [string]::IsNullOrWhiteSpace($script:canaryToken)) {
      Assert-DemoCanaryAbsent $pState ([string]$script:canaryToken)
    }

    # Verify status snapshot and status text outputs do not leak canary
    $snapJson = Invoke-FactoryStatus $pState
    $snapRaw = [string](ConvertTo-Json -InputObject $snapJson -Depth 10)
    if ($null -eq $snapRaw) { $snapRaw = '' }
    if (-not [string]::IsNullOrWhiteSpace($script:canaryToken)) {
      Assert-Demo (-not $snapRaw.Contains([string]$script:canaryToken)) "Canary token leaked in status --json"
    }
    $statusText = [string](Invoke-FactoryStatusText $pState)
    if ($null -eq $statusText) { $statusText = '' }
    if (-not [string]::IsNullOrWhiteSpace($script:canaryToken)) {
      Assert-Demo (-not $statusText.Contains([string]$script:canaryToken)) "Canary token leaked in status text"
    }

    # Also verify supervisor stdout/stderr and status outputs do not leak canary (fail-closed: every expected file must exist)
    $activeLogsDir = if ($logsDir) { $logsDir } elseif ($acceptanceBase) { Join-Path $acceptanceBase 'logs' } else { $env:TEMP }
    $expectedCanaryLogs = @(
      (Join-Path $activeLogsDir 'intake-budget-sup.out'),
      (Join-Path $activeLogsDir 'intake-budget-sup.err'),
      (Join-Path $activeLogsDir 'status-text.err')
    )
    foreach ($outPath in $expectedCanaryLogs) {
      Assert-Demo (Test-Path -LiteralPath $outPath) "Expected log file missing for canary check: $outPath"
      $c = Read-DemoTextStrict $outPath
      if (-not [string]::IsNullOrWhiteSpace($script:canaryToken)) {
        Assert-Demo (-not $c.Contains([string]$script:canaryToken)) "Canary token leaked in log: $outPath"
      }
    }

    $global:LASTEXITCODE = 0
  })) { throw 'Step 14 failed' }

  # =========================================================================
  # Step 15: Restart mid-run keeps counts exact
  # =========================================================================
  if (-not (Step 15 'Restart mid-run keeps counts exact: quota used equals started attempts, no reserved row for terminal attempts' {
    $ErrorActionPreference = 'Continue'
    if ([string]::IsNullOrWhiteSpace($script:canaryToken)) {
      $script:canaryToken = 'ghp_CANARY_TOKEN_' + [guid]::NewGuid().ToString('N')
    }
    $proj = Initialize-DemoProject 'restart'
    $pState = $proj.StateDir

    # 1. Set quota: window 300000ms, max 2 units
    Invoke-FactoryCli @('quota', 'set', '--state-dir', $pState, '--provider', 'default', '--window-ms', '300000', '--max-units', '2')

    # 2. Create two non-overlapping tasks
    $t1 = [guid]::NewGuid().ToString()
    $t2 = [guid]::NewGuid().ToString()

    New-DemoTask $t1 @('--scope', 'src/t1', '--scope', "factory-fake/${t1}.txt") $pState
    New-DemoTask $t2 @('--scope', 'src/t2', '--scope', "factory-fake/${t2}.txt") $pState

    # 3. Start supervisor with fake executor sleeping 6000ms
    $proc1 = Start-DemoSupervisor 'restart-sup1' -sDir $pState -extraEnv @{ FAKE_SLEEP_MS = '6000' }

    # 4. Poll until two attempts have a confirmed RUNNING worker before killing the Supervisor
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $bothWorkersRunning = $false
    $timeoutWorkersSec = 45
    $lastSnapBeforeKill = $null

    while ($sw.Elapsed.TotalSeconds -lt $timeoutWorkersSec -and -not $proc1.HasExited) {
      $snap = Invoke-FactoryStatus $pState
      $lastSnapBeforeKill = $snap
      $runningAttempts = @($snap.tasks | ForEach-Object {
        if ($null -ne $_.attempts) {
          @($_.attempts) | Where-Object {
            $null -ne $_ -and $_.status -eq 'running' -and $null -ne $_.worker -and $_.worker.state -eq 'running'
          }
        }
      })
      if ($runningAttempts.Count -ge 2) {
        $bothWorkersRunning = $true
        break
      }
      Start-Sleep -Milliseconds 50
    }
    Assert-Demo $bothWorkersRunning "Timed out after ${timeoutWorkersSec}s waiting for two attempts with confirmed RUNNING worker before killing Supervisor (observed: $(if ($lastSnapBeforeKill) { @($lastSnapBeforeKill.tasks | ForEach-Object { $_.attempts } | Where-Object { $_.status -eq 'running' }).Count } else { 0 }))"
    Register-DemoWorkerNonces $pState

    # 5. Kill supervisor mid-run
    $proc1.Kill()
    Assert-Demo ($proc1.WaitForExit(10000)) 'Supervisor did not exit after kill'

    # Read takeover token from lease
    $snapCrash = Invoke-FactoryStatus $pState 2000
    $takeover = $snapCrash.lease.takeover
    Assert-Demo (-not [string]::IsNullOrWhiteSpace($takeover)) 'Missing takeover token after crash'

    # Poll (bounded) until lease.freshness is stale
    $swRestart = [System.Diagnostics.Stopwatch]::StartNew()
    $leaseStale = $false
    $timeoutRestartSec = 30
    $lastPollSnap = $null

    while ($swRestart.Elapsed.TotalSeconds -lt $timeoutRestartSec) {
      $lastPollSnap = Invoke-FactoryStatus $pState 2000
      Register-DemoWorkerNonces $pState

      if ($null -ne $lastPollSnap.lease -and $lastPollSnap.lease.freshness -eq 'stale') {
        $leaseStale = $true
        if (-not [string]::IsNullOrWhiteSpace($lastPollSnap.lease.takeover)) {
          $takeover = $lastPollSnap.lease.takeover
        }
        break
      }
      Start-Sleep -Milliseconds 100
    }

    if (-not $leaseStale) {
      $snapJsonStr = if ($lastPollSnap) { ConvertTo-Json -InputObject $lastPollSnap -Depth 10 } else { '<no snapshot>' }
      throw "Timeout after ${timeoutRestartSec}s waiting for lease freshness to become stale.`nStatus JSON:`n$snapJsonStr"
    }

    # 6. Restart supervisor with --takeover
    $proc2 = Start-DemoSupervisor 'restart-sup2' -takeover $takeover -sDir $pState
    Wait-DemoSupervisor $proc2 'restart-sup2' 60
    Register-DemoWorkerNonces $pState

    # Wait (bounded) for the two tasks to finish
    $swTasks = [System.Diagnostics.Stopwatch]::StartNew()
    $tasksFinished = $false
    $timeoutTasksSec = 60

    while ($swTasks.Elapsed.TotalSeconds -lt $timeoutTasksSec) {
      $pollTasksSnap = Invoke-FactoryStatus $pState
      $activeTasks = @($pollTasksSnap.tasks | Where-Object { ($_.id -eq $t1 -or $_.id -eq $t2) -and ($_.status -eq 'ready' -or $_.status -eq 'progress') })
      if ($activeTasks.Count -eq 0) {
        $tasksFinished = $true
        break
      }
      Start-Sleep -Milliseconds 100
    }
    Assert-Demo $tasksFinished "Timeout after ${timeoutTasksSec}s waiting for tasks $t1 and $t2 to reach terminal state"

    # 7. Assertions: after completion, quota.windows[0].used equals started attempts (a worker row exists)
    $finalSnap = Invoke-FactoryStatus $pState
    $qData = Get-DemoQuotaData $pState

    # Compute expected usage from started attempts (a worker row exists, via status/db inspection)
    $dbStartedAttempts = @($qData.startedAttempts)
    $statusStartedAttempts = @($finalSnap.tasks | ForEach-Object {
      if ($null -ne $_.attempts) {
        @($_.attempts) | Where-Object { $null -ne $_.worker }
      }
    })

    Assert-Demo ($dbStartedAttempts.Count -gt 0) "No started attempts (with worker row in DB) were recorded"
    Assert-Demo ($statusStartedAttempts.Count -eq $dbStartedAttempts.Count) "Started attempts mismatch between status ($($statusStartedAttempts.Count)) and database ($($dbStartedAttempts.Count))"

    $expectedUsage = $dbStartedAttempts.Count

    Assert-Demo ($null -ne $finalSnap.quota -and $finalSnap.quota.windows.Count -ge 1) "Quota status missing in final snapshot"
    $usedInStatus = $finalSnap.quota.windows[0].used

    # Assert exact counts: used in status equals started attempts with worker row
    Assert-Demo ($usedInStatus -eq $expectedUsage) "quota.windows[0].used ($usedInStatus) does not equal started attempts with worker row ($expectedUsage)"

    # Assert no 'reserved' reservation left for a terminal attempt
    Assert-Demo ($qData.terminalWithReserved.Count -eq 0) "Found reserved reservations for terminal attempts: $(ConvertTo-Json $qData.terminalWithReserved)"
    foreach ($res in $qData.reservations) {
      Assert-Demo ($res.state -ne 'reserved') "Reservation $($res.id) is still in 'reserved' state"
    }

    # Canary token appears in none of the files under state directory
    if (-not [string]::IsNullOrWhiteSpace($script:canaryToken)) {
      Assert-DemoCanaryAbsent $pState ([string]$script:canaryToken)
    }

    # Verify status snapshot and status text outputs do not leak canary
    $snapJson = Invoke-FactoryStatus $pState
    $snapRaw = [string](ConvertTo-Json -InputObject $snapJson -Depth 10)
    if ($null -eq $snapRaw) { $snapRaw = '' }
    if (-not [string]::IsNullOrWhiteSpace($script:canaryToken)) {
      Assert-Demo (-not $snapRaw.Contains([string]$script:canaryToken)) "Canary token leaked in status --json"
    }
    $statusText = [string](Invoke-FactoryStatusText $pState)
    if ($null -eq $statusText) { $statusText = '' }
    if (-not [string]::IsNullOrWhiteSpace($script:canaryToken)) {
      Assert-Demo (-not $statusText.Contains([string]$script:canaryToken)) "Canary token leaked in status text"
    }

    # Also verify supervisor stdout/stderr and status outputs do not leak canary (fail-closed: every expected file must exist)
    $activeLogsDir = if ($logsDir) { $logsDir } elseif ($acceptanceBase) { Join-Path $acceptanceBase 'logs' } else { $env:TEMP }
    $expectedCanaryLogs = @(
      (Join-Path $activeLogsDir 'restart-sup1.out'),
      (Join-Path $activeLogsDir 'restart-sup1.err'),
      (Join-Path $activeLogsDir 'restart-sup2.out'),
      (Join-Path $activeLogsDir 'restart-sup2.err'),
      (Join-Path $activeLogsDir 'status-text.err')
    )
    foreach ($outPath in $expectedCanaryLogs) {
      Assert-Demo (Test-Path -LiteralPath $outPath) "Expected log file missing for canary check: $outPath"
      $c = Read-DemoTextStrict $outPath
      if (-not [string]::IsNullOrWhiteSpace($script:canaryToken)) {
        Assert-Demo (-not $c.Contains([string]$script:canaryToken)) "Canary token leaked in log: $outPath"
      }
    }

    $global:LASTEXITCODE = 0
  })) { throw 'Step 15 failed' }

} catch {
  $script:overallFailed = $true
  if ($null -eq $script:failureReason) {
    $script:failureReason = $_.Exception.Message
  }
} finally {
  # --- Cleanup phase (checked and bounded) ---
  try {
    Discover-AllWorkerIdentities
  } catch {
    $script:overallFailed = $true
    if ($null -eq $script:failureReason) {
      $script:failureReason = $_.Exception.Message
    }
  }

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

  try {
    Remove-Item env:FAKE_SLEEP_MS, env:FAKE_HANG, env:FAKE_FAIL_UNTIL_ATTEMPT, env:FAKE_WRITE, env:FAKE_PRINT_ENV, env:FACTORY_FAULT, env:FACTORY_WT_DIR, env:FACTORY_HEAD_SHA, env:FACTORY_FILES_JSON, env:FACTORY_STATE_DIR, env:FACTORY_TASK_ID, env:FACTORY_COMMAND_ID, env:FACTORY_RUN_DIR, env:FACTORY_GITHUB_API_URL, env:FACTORY_GITHUB_TOKEN, env:FACTORY_SCAN_DIR, env:FACTORY_CANARY, env:FACTORY_REPO -ErrorAction SilentlyContinue
  } catch {}

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
    Write-Host "`n===== M7 acceptance =====" -ForegroundColor Yellow
    $results | Format-Table -AutoSize
    $failed = $SkipBaseline -or $script:overallFailed -or ($results.Result -contains 'FAIL') -or ($results.Count -lt 15)
    if ($failed -and $script:failureReason -and -not $script:failureReason.StartsWith('Step ')) {
      $reasonToPrint = [string]$script:failureReason
      if (-not [string]::IsNullOrWhiteSpace($script:canaryToken)) {
        $reasonToPrint = $reasonToPrint.Replace($script:canaryToken, '[REDACTED_CANARY]')
      }
      Write-Host "Failure details: $reasonToPrint" -ForegroundColor Red
    }
    if ($SkipBaseline) {
      Write-Host 'Baseline skipped: dev run, not an acceptance result' -ForegroundColor Yellow
    }
    if ($failed) {
      Write-Host 'M7: FAIL' -ForegroundColor Red
      exit 1
    } else {
      Write-Host 'M7: PASS' -ForegroundColor Green
      exit 0
    }
  } catch {
    if ($SkipBaseline) {
      Write-Host 'Baseline skipped: dev run, not an acceptance result' -ForegroundColor Yellow
    }
    Write-Host 'M7: FAIL' -ForegroundColor Red
    exit 1
  }
}
