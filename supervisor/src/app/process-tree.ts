import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

type ProcessInfo = { pid: number; parent: number; group?: number; command?: string }
type KillResult = { result: 'killed' | 'not-running' | 'identity-mismatch' | 'kill-failed'; detail?: string }

export function spawnWorker(options: { runDir: string; cwd: string; taskId: string; attemptId: string; env?: NodeJS.ProcessEnv }): { pid: number; nonce: string } {
  const runDir = resolve(options.runDir)
  mkdirSync(runDir, { recursive: true })
  const stdout = openSync(join(runDir, 'stdout.log'), 'w')
  let stderr: number | undefined
  try {
    stderr = openSync(join(runDir, 'stderr.log'), 'w')
    const nonce = randomUUID()
    const executor = ['./fake-executor.mjs', './executors/fake-executor.mjs', '../executors/fake-executor.ts', '../supervisor/src/executors/fake-executor.ts']
      .map((path) => fileURLToPath(new URL(path, import.meta.url)))
      .find((path) => existsSync(path))
    if (!executor) throw new Error('Fake executor not found')
    const child = spawn(process.execPath, [executor, options.taskId, nonce, runDir], {
      cwd: options.cwd, env: options.env ?? process.env, stdio: ['ignore', stdout, stderr],
      detached: process.platform !== 'win32', windowsHide: true,
    })
    child.on('error', () => {})
    if (!child.pid) throw new Error('Failed to spawn worker')
    child.unref()
    return { pid: child.pid, nonce }
  } finally {
    closeSync(stdout)
    if (stderr !== undefined) closeSync(stderr)
  }
}

function powershell(script: string): string {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; " + script], { encoding: 'utf8', timeout: 10000, windowsHide: true })
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr?.trim() || 'PowerShell failed')
  return result.stdout.trim()
}

export function parseWindowsProcesses(output: string, filter?: number): ProcessInfo[] {
  const items: unknown = JSON.parse(output)
  if (!Array.isArray(items)) throw new Error('Invalid process enumeration')
  if (filter !== undefined && items.length > 1) throw new Error('Invalid filtered process enumeration')
  return items.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid process record')
    const { ProcessId, ParentProcessId, CommandLine } = item as Record<string, unknown>
    const uint32 = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff
    if (!uint32(ProcessId) || !uint32(ParentProcessId) || (filter !== undefined && ProcessId !== filter)) throw new Error('Invalid process record')
    if (filter === undefined) return { pid: ProcessId, parent: ParentProcessId }
    if (typeof CommandLine !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(CommandLine)) throw new Error('Invalid process command')
    const bytes = Buffer.from(CommandLine, 'base64')
    if (bytes.length % 2 !== 0 || bytes.toString('base64') !== CommandLine) throw new Error('Invalid process command')
    return { pid: ProcessId, parent: ParentProcessId, command: bytes.toString('utf16le') }
  })
}

function windowsProcesses(filter?: number): ProcessInfo[] {
  const script = filter === undefined
    ? `$records = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | Select-Object ProcessId,ParentProcessId)`
    : `$records = @(Get-CimInstance Win32_Process -Filter 'ProcessId = ${filter}' -Property ProcessId,ParentProcessId,CommandLine | ForEach-Object {
        $command = if ($null -eq $_.CommandLine) { '' } else { [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($_.CommandLine)) }
        @{ ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId; CommandLine = $command }
      })`
  return parseWindowsProcesses(powershell(`${script}; ConvertTo-Json -InputObject $records -Compress`), filter)
}

export function parseLinuxStat(entry: string, stat: string): ProcessInfo | undefined {
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  if (fields[0] === 'Z') return undefined
  return { pid: Number(entry), parent: Number(fields[1]), group: Number(fields[2]) }
}

function linuxProcesses(): ProcessInfo[] {
  const processes: ProcessInfo[] = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
      const process = parseLinuxStat(entry, stat)
      if (process) processes.push(process)
    } catch (error) {
      if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
  return processes
}

export function treePids(processes: ProcessInfo[], pid: number): Set<number> {
  const found = new Set([pid])
  let changed = true
  while (changed) {
    changed = false
    for (const item of processes) {
      if (!found.has(item.pid) && (found.has(item.parent) || item.group === pid)) {
        found.add(item.pid)
        changed = true
      }
    }
  }
  return found
}

export async function killTree(pid: number, nonce: string, options?: { killCommand?: { file: string; args: string[] } }): Promise<KillResult> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !nonce.trim()) return { result: 'kill-failed', detail: 'Invalid process identity' }
  if (pid === process.pid) return { result: 'identity-mismatch' }
  try {
    let command: string
    if (process.platform === 'win32') {
      const target = windowsProcesses(pid)[0]
      if (!target) return { result: 'not-running' }
      command = target.command ?? ''
    } else {
      try {
        command = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
        if (!command) return { result: 'not-running' }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') return { result: 'not-running' }
        throw error
      }
    }
    if (!command.includes(nonce)) return { result: 'identity-mismatch' }
    const list = process.platform === 'win32' ? windowsProcesses() : linuxProcesses()
    const pids = treePids(list, pid)
    if (options?.killCommand || process.platform === 'win32') {
      const cmd = options?.killCommand ?? { file: 'taskkill', args: ['/T', '/F', '/PID', String(pid)] }
      const result = spawnSync(cmd.file, cmd.args, { encoding: 'utf8', timeout: 10000, windowsHide: true })
      if (result.error || result.status !== 0) return { result: 'kill-failed', detail: result.error?.message || result.stderr?.trim() || `Kill command exited ${result.status}` }
    } else {
      process.kill(-pid, 'SIGKILL')
    }
    const deadline = Date.now() + 5000
    do {
      const remaining = process.platform === 'win32' ? windowsProcesses() : linuxProcesses()
      for (const item of remaining) if (item.group === pid || pids.has(item.parent)) pids.add(item.pid)
      if (!remaining.some((item) => pids.has(item.pid))) return { result: 'killed' }
      await delay(100)
    } while (Date.now() < deadline)
    return { result: 'kill-failed', detail: 'Process tree remained alive after timeout' }
  } catch (error) {
    return { result: 'kill-failed', detail: error instanceof Error ? error.message : String(error) }
  }
}
