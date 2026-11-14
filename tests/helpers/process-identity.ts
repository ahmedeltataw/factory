import { spawnSync, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { killTree } from '../../supervisor/src/app/process-tree.ts'

export interface KillItem {
  child?: ChildProcess
  pid?: number
  nonce?: string
  marker?: string
}

export interface DeadlineOptions {
  deadlineMs?: number
  timeoutMs?: number
}

function resolveDeadline(
  timeoutMsOrOptions?: number | DeadlineOptions,
  defaultTimeoutMs = 5000,
): number {
  if (typeof timeoutMsOrOptions === 'number') {
    return Date.now() + timeoutMsOrOptions
  }
  if (timeoutMsOrOptions && typeof timeoutMsOrOptions === 'object') {
    if (typeof timeoutMsOrOptions.deadlineMs === 'number') {
      return timeoutMsOrOptions.deadlineMs
    }
    if (typeof timeoutMsOrOptions.timeoutMs === 'number') {
      return Date.now() + timeoutMsOrOptions.timeoutMs
    }
  }
  return Date.now() + defaultTimeoutMs
}

/**
 * Probes process existence.
 * Returns 'absent' ONLY when process.kill(pid, 0) confirms no such process (ESRCH).
 * Returns 'present' when the process exists.
 * Any other error (e.g. EPERM or invalid arguments) is thrown (never treated as death/absence).
 */
export function probePid(pid: number): 'absent' | 'present' {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid pid: ${pid}`)
  }
  try {
    process.kill(pid, 0)
    return 'present'
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ESRCH') {
      return 'absent'
    }
    throw err
  }
}

/**
 * Reads and validates the command line of a process.
 * Takes relative timeoutMs or options { deadlineMs }.
 * PowerShell calls use an explicit remaining timeout and no nested retries.
 * Throws an 'unresolved' error on empty output, missing PID record, malformed or
 * non-canonical base64, wrong UTF-16 length, empty decoded command, or timeout.
 * Never converts unresolved queries into absence or mismatch.
 */
export function readCommandLine(
  pid: number,
  timeoutMsOrOptions?: number | DeadlineOptions,
): string {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    throw new Error(`unresolved: invalid pid ${pid}`)
  }
  const deadline = resolveDeadline(timeoutMsOrOptions, 5000)
  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) {
    throw new Error(`unresolved: timeout before reading command line for PID ${pid}`)
  }

  if (process.platform === 'win32') {
    const script = `$records = @(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -Property ProcessId,CommandLine | ForEach-Object {
      $command = if ($null -eq $_.CommandLine) { '' } else { [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($_.CommandLine)) }
      @{ ProcessId = $_.ProcessId; CommandLine = $command }
    }); ConvertTo-Json -InputObject $records -Compress`

    const timeoutMs = Math.max(1, Math.min(remainingMs, deadline - Date.now()))
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; " + script],
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true },
    )
    if (result.error) {
      throw new Error(`unresolved: PowerShell execution error for PID ${pid}: ${result.error.message}`)
    }
    if (result.status !== 0) {
      throw new Error(`unresolved: PowerShell exited with status ${result.status} for PID ${pid}: ${result.stderr?.trim()}`)
    }
    const stdout = result.stdout ? result.stdout.trim() : ''
    if (!stdout || stdout === '[]') {
      throw new Error(`unresolved: empty output for PID ${pid}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(stdout)
    } catch (e: unknown) {
      throw new Error(`unresolved: failed to parse JSON output for PID ${pid}: ${(e as Error)?.message}`)
    }
    const list = Array.isArray(parsed) ? parsed : [parsed]
    const record = list.find((r: any) => r && r.ProcessId === pid)
    if (!record) {
      throw new Error(`unresolved: missing PID record for PID ${pid}`)
    }
    if (typeof record.CommandLine !== 'string' || record.CommandLine.length === 0) {
      throw new Error(`unresolved: empty command line record for PID ${pid}`)
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.CommandLine)) {
      throw new Error(`unresolved: malformed base64 for PID ${pid}`)
    }
    const bytes = Buffer.from(record.CommandLine, 'base64')
    if (bytes.toString('base64') !== record.CommandLine) {
      throw new Error(`unresolved: non-canonical base64 for PID ${pid}`)
    }
    if (bytes.length % 2 !== 0 || bytes.length === 0) {
      throw new Error(`unresolved: wrong UTF-16 length for PID ${pid}`)
    }
    const decoded = bytes.toString('utf16le')
    if (!decoded || decoded.length === 0) {
      throw new Error(`unresolved: empty decoded command for PID ${pid}`)
    }
    return decoded
  } else {
    let cmd = ''
    try {
      const raw = readFileSync(`/proc/${pid}/cmdline`)
      cmd = raw.toString('utf8').replace(/\0/g, ' ').trim()
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT' && (err as NodeJS.ErrnoException)?.code !== 'ESRCH') {
        // Fall through to ps
      }
    }
    if (!cmd) {
      const psTimeout = Math.max(1, Math.min(5000, deadline - Date.now()))
      const res = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
        timeout: psTimeout,
      })
      if (res.status === 0 && res.stdout) {
        cmd = res.stdout.trim()
      }
    }
    if (!cmd || cmd.length === 0) {
      throw new Error(`unresolved: empty or missing command line for PID ${pid}`)
    }
    return cmd
  }
}

/**
 * Determines identity of a PID relative to a marker.
 * Takes relative timeoutMs or options { deadlineMs }.
 * Returns:
 * - 'absent' if confirmed not running (ESRCH)
 * - 'ours' if alive and validated command contains marker
 * - 'not-ours' ONLY for a valid non-empty command that lacks the marker
 * Rethrows unresolved / timeout errors.
 */
export function identityOf(
  pid: number,
  marker: string,
  timeoutMsOrOptions?: number | DeadlineOptions,
): 'ours' | 'not-ours' | 'absent' {
  if (probePid(pid) === 'absent') {
    return 'absent'
  }
  const deadline = resolveDeadline(timeoutMsOrOptions, 5000)
  try {
    const cmd = readCommandLine(pid, { deadlineMs: deadline })
    if (cmd.includes(marker)) {
      return 'ours'
    }
    return 'not-ours'
  } catch (err) {
    if (probePid(pid) === 'absent') {
      return 'absent'
    }
    throw err
  }
}

/**
 * Helper to check if a process is alive and matches the marker.
 * Returns true iff identityOf returns 'ours'.
 */
export function isProcessAliveWithNonce(
  pid: number,
  marker: string,
  timeoutMsOrOptions?: number | DeadlineOptions,
): boolean {
  return identityOf(pid, marker, timeoutMsOrOptions) === 'ours'
}

/**
 * Safely kills a tracked process.
 * If item holds a ChildProcess handle:
 * kills only while handle has not exited (exitCode === null && signalCode === null)
 * via the handle (POSIX child.kill('SIGKILL'); Windows taskkill /T /F /PID with that PID),
 * then awaits exit with a bounded wait.
 * With no handle, uses the product's killTree(pid, nonce) which verifies identity itself.
 * No raw PID kills anywhere.
 */
export async function killIfOurs(
  item: KillItem | ChildProcess,
  options?: { tree?: boolean; timeoutMs?: number; deadlineMs?: number },
): Promise<void> {
  const isCp = item && 'kill' in item && typeof (item as any).kill === 'function'
  const child = isCp ? (item as ChildProcess) : (item as KillItem).child

  if (child) {
    if (child.exitCode === null && child.signalCode === null) {
      const pid = child.pid ?? (isCp ? child.pid : (item as KillItem).pid)
      if (pid) {
        if (process.platform === 'win32') {
          const remainingMs = options?.deadlineMs ? Math.max(1, options.deadlineMs - Date.now()) : (options?.timeoutMs ?? 5000)
          const args = options?.tree === false ? ['/F', '/PID', String(pid)] : ['/T', '/F', '/PID', String(pid)]
          spawnSync('taskkill', args, {
            timeout: Math.min(5000, remainingMs),
            stdio: 'ignore',
            windowsHide: true,
          })
        } else {
          try {
            child.kill('SIGKILL')
          } catch {}
        }
      }
      if (child.exitCode === null && child.signalCode === null) {
        const waitTimeoutMs = options?.timeoutMs ?? (options?.deadlineMs ? Math.max(1, options.deadlineMs - Date.now()) : 5000)
        await new Promise<void>((resolve) => {
          let timer: NodeJS.Timeout
          const onExit = () => {
            clearTimeout(timer)
            child.removeListener('exit', onExit)
            child.removeListener('close', onExit)
            resolve()
          }
          child.once('exit', onExit)
          child.once('close', onExit)
          timer = setTimeout(onExit, waitTimeoutMs)
          if (child.exitCode !== null || child.signalCode !== null) {
            onExit()
          }
        })
      }
    }
    return
  }

  const pid = (item as KillItem).pid
  const nonce = (item as KillItem).nonce ?? (item as KillItem).marker
  if (typeof pid === 'number' && typeof nonce === 'string' && nonce.trim().length > 0) {
    await killTree(pid, nonce)
  }
}

/**
 * Batched enumeration: finds all live PIDs whose command line contains ANY of the given nonces.
 * Validates base64 shape and canonical encoding.
 * Bounded by relative timeoutMs or options { deadlineMs }.
 */
export function findProcessesWithNonces(
  nonces: string[],
  timeoutMsOrOptions?: number | DeadlineOptions,
): Array<{ pid: number; nonce: string; command: string }> {
  const validNonces = nonces.filter((n) => typeof n === 'string' && n.trim().length > 0)
  if (validNonces.length === 0) return []
  const deadline = resolveDeadline(timeoutMsOrOptions, 10000)
  const remaining = deadline - Date.now()
  if (remaining <= 0) {
    throw new Error('unresolved: timeout before process enumeration')
  }

  if (process.platform === 'win32') {
    const successMarker = '__FACTORY_ENUM_SUCCESS__'
    const script = `$records = @(Get-CimInstance Win32_Process -Property ProcessId,CommandLine | Where-Object { $_.CommandLine } | ForEach-Object {
      @{ ProcessId = $_.ProcessId; CommandLine = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($_.CommandLine)) }
    });
Write-Output '${successMarker}';
if ($records.Count -eq 0) { Write-Output '[]' } else { ConvertTo-Json -InputObject $records -Compress }`

    const timeoutMs = Math.max(1, Math.min(remaining, deadline - Date.now()))
    const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; " + script], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
    })
    if (res.error || res.status !== 0) {
      throw new Error(`unresolved: process enumeration failed: ${res.error?.message || res.stderr || res.status}`)
    }
    const stdout = res.stdout ? res.stdout.trim() : ''
    if (!stdout) {
      throw new Error('unresolved: empty output in process enumeration')
    }
    const lines = stdout.split(/\r?\n/)
    const markerIndex = lines.findIndex((l) => l.trim() === successMarker)
    if (markerIndex === -1) {
      throw new Error('unresolved: missing success marker in process enumeration output')
    }
    const jsonText = lines.slice(markerIndex + 1).join('\n').trim()
    if (!jsonText) {
      throw new Error('unresolved: missing JSON payload in process enumeration output')
    }
    let rows: unknown
    try {
      rows = JSON.parse(jsonText)
    } catch (e: unknown) {
      throw new Error(`unresolved: JSON parse error in process enumeration: ${(e as Error)?.message}`)
    }
    if (!Array.isArray(rows) && (typeof rows !== 'object' || rows === null)) {
      throw new Error('unresolved: malformed JSON records in process enumeration')
    }
    const list = Array.isArray(rows) ? rows : [rows]
    const results: Array<{ pid: number; nonce: string; command: string }> = []
    for (const row of list) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error('unresolved: malformed record object in process enumeration')
      }
      const record = row as { ProcessId?: unknown; CommandLine?: unknown }
      if (typeof record.ProcessId !== 'number' || !Number.isInteger(record.ProcessId) || record.ProcessId <= 0) {
        throw new Error(`unresolved: invalid ProcessId in process enumeration record`)
      }
      if (typeof record.CommandLine !== 'string' || record.CommandLine.length === 0) {
        throw new Error(`unresolved: missing or empty CommandLine in process enumeration for PID ${record.ProcessId}`)
      }
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.CommandLine)) {
        throw new Error(`unresolved: invalid base64 in process enumeration for PID ${record.ProcessId}`)
      }
      const bytes = Buffer.from(record.CommandLine, 'base64')
      if (bytes.toString('base64') !== record.CommandLine) {
        throw new Error(`unresolved: non-canonical base64 in process enumeration for PID ${record.ProcessId}`)
      }
      if (bytes.length % 2 !== 0 || bytes.length === 0) {
        throw new Error(`unresolved: wrong UTF-16 length in process enumeration for PID ${record.ProcessId}`)
      }
      const cmd = bytes.toString('utf16le')
      if (!cmd || cmd.length === 0) {
        throw new Error(`unresolved: empty decoded command in process enumeration for PID ${record.ProcessId}`)
      }
      if (record.ProcessId === process.pid) continue
      for (const nonce of validNonces) {
        if (cmd.includes(nonce)) {
          results.push({ pid: record.ProcessId, nonce, command: cmd })
        }
      }
    }
    return results
  } else {
    const res = spawnSync('ps', ['-eo', 'pid=,args='], {
      encoding: 'utf8',
      timeout: Math.min(5000, remaining),
    })
    if (res.error || res.status !== 0) {
      throw new Error(`unresolved: ps failed: ${res.error?.message || res.stderr || res.status}`)
    }
    const stdout = res.stdout ? res.stdout.trim() : ''
    if (!stdout) {
      throw new Error('unresolved: empty output from ps')
    }
    const results: Array<{ pid: number; nonce: string; command: string }> = []
    for (const rawLine of stdout.split('\n')) {
      const line = rawLine.trim()
      if (!line) continue
      const match = line.match(/^(\d+)\s+(.+)$/)
      if (!match) {
        throw new Error(`unresolved: malformed ps output line: ${line}`)
      }
      const pid = Number(match[1])
      if (!Number.isInteger(pid) || pid <= 0) {
        throw new Error(`unresolved: invalid PID in ps output: ${match[1]}`)
      }
      if (pid === process.pid) continue
      const cmd = match[2]!
      if (!cmd || cmd.length === 0) {
        throw new Error(`unresolved: empty command in ps output for PID ${pid}`)
      }
      for (const nonce of validNonces) {
        if (cmd.includes(nonce)) {
          results.push({ pid, nonce, command: cmd })
        }
      }
    }
    return results
  }
}

/**
 * Independent identity-checked cleanup for multiple nonces.
 * Kills matching processes using identity-aware killTree.
 * Bounded by relative timeoutMs or options { deadlineMs }.
 */
export async function cleanupNonces(
  nonces: Iterable<string>,
  timeoutMsOrOptions?: number | DeadlineOptions,
): Promise<void> {
  const nonceList = Array.from(nonces).filter((n) => typeof n === 'string' && n.trim().length > 0)
  if (nonceList.length === 0) return
  const deadline = resolveDeadline(timeoutMsOrOptions, 25000)

  let lastSurvivors: Array<{ pid: number; nonce: string; command: string }> = []
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    const survivors = findProcessesWithNonces(nonceList, { deadlineMs: deadline })
    lastSurvivors = survivors
    if (survivors.length === 0) return
    for (const s of survivors) {
      if (s.pid === process.pid) continue
      try {
        await killTree(s.pid, s.nonce)
      } catch {}
    }
    const sleepMs = Math.min(100, Math.max(0, deadline - Date.now()))
    if (sleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, sleepMs))
    }
  }

  if (Date.now() < deadline) {
    const remaining = findProcessesWithNonces(nonceList, { deadlineMs: deadline })
    if (remaining.length > 0) {
      throw new Error(`Cleanup failed to terminate matching processes for nonces [${nonceList.join(', ')}]. Survivors: ${remaining.map((r) => r.pid).join(', ')}`)
    }
    return
  }
  if (lastSurvivors.length > 0) {
    throw new Error(`Cleanup failed to terminate matching processes for nonces [${nonceList.join(', ')}]. Survivors: ${lastSurvivors.map((r) => r.pid).join(', ')}`)
  }
}

/**
 * Awaits process death bounded by relative timeoutMs or options { deadlineMs }.
 * Returns true if the process is confirmed dead or confirmed not ours.
 */
export async function waitForProcessDeath(
  pid: number,
  timeoutMsOrOptions?: number | DeadlineOptions,
  marker?: string,
  options?: { deadlineMs?: number },
): Promise<boolean> {
  let deadline: number
  if (options && typeof options.deadlineMs === 'number') {
    deadline = options.deadlineMs
  } else {
    deadline = resolveDeadline(timeoutMsOrOptions, 15000)
  }

  const pollIntervalMs = 50
  let lastLookupError: unknown = null

  while (Date.now() < deadline) {
    if (probePid(pid) === 'absent') return true
    if (marker) {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) break
      try {
        const id = identityOf(pid, marker, { deadlineMs: deadline })
        lastLookupError = null
        if (id === 'absent' || id === 'not-ours') return true
      } catch (err) {
        if (probePid(pid) === 'absent') return true
        lastLookupError = err
      }
    }

    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break

    const sleepMs = Math.min(pollIntervalMs, remainingMs)
    if (sleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, sleepMs))
    }
  }

  if (probePid(pid) === 'absent') return true
  if (lastLookupError) {
    throw lastLookupError
  }
  return false
}
