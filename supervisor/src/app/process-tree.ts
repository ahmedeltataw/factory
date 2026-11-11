import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

type ProcessInfo = { pid: number; parent: number; created: string; command?: string }
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
      detached: true, windowsHide: true,
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
  const run = () => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; " + script], { encoding: 'utf8', timeout: 30000, windowsHide: true })
  let result = run()
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') result = run()
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr?.trim() || 'PowerShell failed')
  return result.stdout.trim()
}

export function parseWindowsProcesses(output: string, filter?: number): ProcessInfo[] {
  const items: unknown = JSON.parse(output)
  if (!Array.isArray(items)) throw new Error('Invalid process enumeration')
  if (filter !== undefined && items.length > 1) throw new Error('Invalid filtered process enumeration')
  return items.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid process record')
    const { ProcessId, ParentProcessId, CreationDate, CommandLine } = item as Record<string, unknown>
    const uint32 = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff
    if (!uint32(ProcessId) || !uint32(ParentProcessId) || (filter !== undefined && ProcessId !== filter)) throw new Error('Invalid process record')
    if (typeof CreationDate !== 'string' || !/^(0|[1-9]\d*)$/.test(CreationDate)) throw new Error('Invalid process creation time')
    if (filter === undefined) return { pid: ProcessId, parent: ParentProcessId, created: CreationDate }
    if (typeof CommandLine !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(CommandLine)) throw new Error('Invalid process command')
    const bytes = Buffer.from(CommandLine, 'base64')
    if (bytes.length % 2 !== 0 || bytes.toString('base64') !== CommandLine) throw new Error('Invalid process command')
    return { pid: ProcessId, parent: ParentProcessId, created: CreationDate, command: bytes.toString('utf16le') }
  })
}

function windowsProcesses(filter?: number): ProcessInfo[] {
  const script = filter === undefined
    ? `$records = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object { @{ ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId; CreationDate = $_.CreationDate.ToUniversalTime().Ticks.ToString() } })`
    : `$records = @(Get-CimInstance Win32_Process -Filter 'ProcessId = ${filter}' -Property ProcessId,ParentProcessId,CreationDate,CommandLine | ForEach-Object {
        $command = if ($null -eq $_.CommandLine) { '' } else { [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($_.CommandLine)) }
        @{ ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId; CreationDate = $_.CreationDate.ToUniversalTime().Ticks.ToString(); CommandLine = $command }
      })`
  return parseWindowsProcesses(powershell(`${script}; ConvertTo-Json -InputObject $records -Compress`), filter)
}

export function parseLinuxStat(entry: string, stat: string): ProcessInfo | undefined {
  const close = stat.lastIndexOf(')')
  if (!/^\d+$/.test(entry) || close < 0 || !stat.startsWith(`${entry} (`)) throw new Error('Invalid process stat')
  const fields = stat.slice(close + 2).trim().split(/\s+/)
  if (fields[0] === 'Z') return undefined
  if (fields.length < 20 || !/^\d+$/.test(fields[1]!) || !/^(0|[1-9]\d*)$/.test(fields[19]!)) throw new Error('Invalid process stat')
  const pid = Number(entry), parent = Number(fields[1])
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parent)) throw new Error('Invalid process stat')
  return { pid, parent, created: fields[19]! }
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

const identity = (item: ProcessInfo): string => `${item.pid}:${item.created}`

export function treeMembers(processes: ProcessInfo[], members: Map<string, ProcessInfo>): Map<string, ProcessInfo> {
  const found = new Map(members)
  let changed = true
  while (changed) {
    changed = false
    for (const item of processes) {
      if (!found.has(identity(item)) && [...found.values()].some((parent) => item.parent === parent.pid && BigInt(item.created) >= BigInt(parent.created))) {
        found.set(identity(item), item)
        changed = true
      }
    }
  }
  return found
}

export function aliveMembers(processes: ProcessInfo[], members: Map<string, ProcessInfo>): ProcessInfo[] {
  return processes.filter((item) => members.has(identity(item)))
}

function linuxProcess(pid: number): ProcessInfo | undefined {
  try { return parseLinuxStat(String(pid), readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined
    throw error
  }
}

export async function killTree(pid: number, nonce: string, options?: { killCommand?: { file: string; args: string[] } }): Promise<KillResult> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !nonce.trim()) return { result: 'kill-failed', detail: 'Invalid process identity' }
  if (pid === process.pid) return { result: 'identity-mismatch' }
  try {
    let root: ProcessInfo | undefined
    let command: string
    if (process.platform === 'win32') {
      root = windowsProcesses(pid)[0]
      if (!root) return { result: 'not-running' }
      command = root.command ?? ''
    } else {
      root = linuxProcess(pid)
      if (!root) return { result: 'not-running' }
      try { command = readFileSync(`/proc/${pid}/cmdline`, 'utf8') } catch (error) {
        if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return { result: 'not-running' }
        throw error
      }
      if (!command) return { result: 'not-running' }
      if (linuxProcess(pid)?.created !== root.created) return { result: 'identity-mismatch' }
    }
    if (!command.includes(nonce)) return { result: 'identity-mismatch' }
    let members = new Map([[identity(root), root]])
    const list = process.platform === 'win32' ? windowsProcesses() : linuxProcesses()
    members = treeMembers(list, members)
    const deadline = Date.now() + 5000
    if (options?.killCommand || process.platform === 'win32') {
      const cmd = options?.killCommand ?? { file: 'taskkill', args: ['/T', '/F', '/PID', String(pid)] }
      const result = spawnSync(cmd.file, cmd.args, { encoding: 'utf8', timeout: 10000, windowsHide: true })
      if (result.error || result.status !== 0) return { result: 'kill-failed', detail: result.error?.message || result.stderr?.trim() || `Kill command exited ${result.status}` }
    } else {
      try { process.kill(-pid, 'SIGKILL') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    let remaining = process.platform === 'win32' ? windowsProcesses() : linuxProcesses()
    const finished = async (): Promise<KillResult> => {
      if (process.platform !== 'win32') {
        do {
          try { process.kill(pid, 0) } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') return { result: 'killed' }
            throw error
          }
          if (Date.now() >= deadline) break
          await delay(Math.min(100, Math.max(0, deadline - Date.now())))
        } while (true)
        return { result: 'kill-failed', detail: 'Process tree remained alive after timeout' }
      }
      return { result: 'killed' }
    }
    do {
      members = treeMembers(remaining, members)
      const alive = aliveMembers(remaining, members)
      if (!alive.length) return await finished()
      if (!options?.killCommand) {
        // ponytail: PID reuse between this snapshot and kill remains an accepted, milliseconds-long window.
        for (const item of alive.reverse()) {
          if (process.platform === 'win32') {
            spawnSync('taskkill', ['/F', '/PID', String(item.pid)], {
              encoding: 'utf8', timeout: Math.max(1, deadline - Date.now()), windowsHide: true,
            })
          } else {
            try { process.kill(item.pid, 'SIGKILL') } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
            }
          }
          if (Date.now() >= deadline) break
        }
      }
      await delay(Math.min(100, Math.max(0, deadline - Date.now())))
      remaining = process.platform === 'win32' ? windowsProcesses() : linuxProcesses()
    } while (Date.now() < deadline)
    members = treeMembers(remaining, members)
    return aliveMembers(remaining, members).length ? { result: 'kill-failed', detail: 'Process tree remained alive after timeout' } : await finished()
  } catch (error) {
    return { result: 'kill-failed', detail: error instanceof Error ? error.message : String(error) }
  }
}
