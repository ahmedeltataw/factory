// M3-06 test interface and contract:
//
// CLI execution mode: source CLI entry (supervisor/src/cli/main.ts invoked via process.execPath under Node 24).
//
// 1. supervisor/src/app/recovery.ts:
//    - export interface RecoveryDeps {
//        killTree: (
//          pid: number,
//          nonce: string,
//          options?: { killCommand?: { file: string; args: string[] } }
//        ) => Promise<{
//          result: 'killed' | 'not-running' | 'identity-mismatch' | 'kill-failed'
//          detail?: string
//        }>
//        stateDir?: string
//      }
//    - export interface ReconcileResult {
//        reconciledCount: number
//        killedCount: number
//        lostCount: number
//      }
//    - export async function reconcileWorkers(
//        db: DatabaseSync,
//        handle: SupervisorLeaseHandle,
//        deps: RecoveryDeps,
//        nowMs: number,
//      ): Promise<ReconcileResult>
//      Reconciles starting|running workers belonging to older lease generations (< handle.generation).
//      For each such worker:
//        - If live and nonce matches -> killTree -> worker state 'killed', attempt status 'interrupted'.
//        - If not running -> worker state 'lost', attempt status 'interrupted'.
//        - If live but nonce mismatch (identity-mismatch) -> do not kill, worker state 'lost', attempt status 'interrupted' with diagnostic error_class.
//      Also reconciles any pre-spawn starting workers or orphan runs from older generations before new attempts start.
//
// 2. supervisor/src/app/supervisor-loop.ts:
//    - export const MAX_ATTEMPTS: number
//    - export interface WorkerCompletionRecord {
//        exitCode: number
//      }
//    - export interface LoopDeps {
//        spawnWorker: (options: {
//          runDir: string
//          cwd: string
//          taskId: string
//          attemptId: string
//          env?: Record<string, string>
//        }) => Promise<{ pid: number; nonce: string }> | { pid: number; nonce: string }
//        killTree: (
//          pid: number,
//          nonce: string,
//          options?: { killCommand?: { file: string; args: string[] } }
//        ) => Promise<{
//          result: 'killed' | 'not-running' | 'identity-mismatch' | 'kill-failed'
//          detail?: string
//        }>
//        isAlive: (pid: number, nonce: string) => Promise<boolean> | boolean
//        readResult: (runDir: string) => Promise<WorkerCompletionRecord | undefined> | WorkerCompletionRecord | undefined
//        config?: EnsureWorktreeConfig
//        onPhase?: (phase: string) => void
//        isProcessAlive?: (pid: number) => boolean
//        wrapRecoverOutbox?: <T>(fn: () => Promise<T> | T) => Promise<T> | T
//        wrapReconcileWorkers?: <T>(fn: () => Promise<T> | T) => Promise<T> | T
//        wrapApplyCommands?: <T>(fn: () => Promise<T> | T) => Promise<T> | T
//        wrapDispatchTasks?: <T>(fn: () => Promise<T> | T) => Promise<T> | T
//        wrapWorkerLiveness?: <T>(fn: () => Promise<T> | T) => Promise<T> | T
//        wrapLeaseHeartbeat?: <T>(fn: () => Promise<T> | T) => Promise<T> | T
//      }
//    - export interface RunTickResult {
//        idle: boolean
//      }
//    - export async function runTick(
//        db: DatabaseSync,
//        handle: SupervisorLeaseHandle,
//        deps: LoopDeps,
//        nowMs: number,
//        options?: { fault?: FaultName }
//      ): Promise<RunTickResult>
//      Tick sequence:
//        1. recover outbox (runDue)
//        2. reconcile workers (reconcileWorkers)
//        3. apply commands (applyPendingCommands)
//        4. dispatch ready tasks (via outbox attempt.start / worktree.ensure; bounded by MAX_ATTEMPTS)
//        5. worker liveness / heartbeats / completion check
//        6. lease heartbeat (handle.heartbeat)
//
// 3. CLI Contract (invoked via Node 24 on supervisor/src/cli/main.ts):
//    - `factory start --state-dir <d> [--exit-when-idle] [--takeover <ownerId>:<generation>:<heartbeatMs>] [--stale-after-ms n] [--heartbeat-ms n]`
//    - Exit codes:
//        0: success (e.g. --exit-when-idle and completed when nothing pending/running)
//        1: execution failure (lease blocked, active lease without takeover, stale mismatch, etc.) with Arabic message on stderr
//        2: argument error (missing --state-dir, malformed takeover evidence, unknown args, unknown FACTORY_FAULT) with Arabic message on stderr
//
// 4. Ordering note:
//    On startup, reconcile older-generation workers (and pre-spawn 'starting' workers / pending attempt.start outbox rows
//    of an older generation) BEFORE re-running attempt.start, so a crash between spawn and recording a worker row never
//    yields a second live process for one attempt. Covered in CHK-c (FACTORY_FAULT=attempt-after-spawn) by counting live
//    executors per attempt nonce.

import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  reconcileWorkers,
  type ReconcileResult,
  type RecoveryDeps,
} from '../../supervisor/src/app/recovery.ts'
import {
  MAX_ATTEMPTS,
  runTick,
  type LoopDeps,
  type RunTickResult,
  type WorkerCompletionRecord,
} from '../../supervisor/src/app/supervisor-loop.ts'
import { openStore } from '../../supervisor/src/app/store.ts'
import {
  acquireSupervisor,
  type SupervisorLeaseHandle,
} from '../../supervisor/src/app/supervisor-lease.ts'
import { appendCommand } from '../../supervisor/src/app/commands.ts'
import type { EnsureWorktreeConfig } from '../../supervisor/src/app/worktree.ts'
import type { FaultName } from '../../supervisor/src/app/faults.ts'

const ARABIC_REGEX = /[\u0600-\u06ff]/
const cliPath = join(process.cwd(), 'supervisor/src/cli/main.ts')

interface TestContext {
  readonly stateDir: string
  readonly repoDir: string
  readonly dbPath: string
  readonly baseSha: string
}

interface TrackedSupervisorChild {
  readonly child: ChildProcess
  readonly marker: string
  readonly pid: number
}

const tempDirs: string[] = []
const activeNonces = new Set<string>()
const spawnedSupervisorChildren: TrackedSupervisorChild[] = []
const activeContexts: TestContext[] = []

function getCommandLineForPid(pid: number): string | undefined {
  if (!pid || pid <= 0) return undefined
  try {
    if (process.platform === 'win32') {
      const res = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
        ],
        {
          encoding: 'utf8',
          timeout: 10000,
          windowsHide: true,
        },
      )
      if (res.status === 0 && res.stdout) {
        return res.stdout.trim()
      }
      return undefined
    } else {
      const res = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
        timeout: 10000,
      })
      if (res.status === 0 && res.stdout) {
        return res.stdout.trim()
      }
      return undefined
    }
  } catch {
    return undefined
  }
}

function isSupervisorProcess(pid: number, marker: string): boolean {
  const cmd = getCommandLineForPid(pid)
  if (!cmd) return false
  return cmd.includes(marker)
}

function parseCreatedTaskId(stdout: string): string {
  const match = stdout.match(/^created\s+([0-9a-f-]+)/i)
  const id = match?.[1]
  if (!id || typeof id !== 'string') {
    throw new Error(`Failed to parse created task ID from output: ${stdout}`)
  }
  return id
}

function safeRemoveDir(dir: string): void {
  const maxRetries = 10
  let lastError: unknown
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (err) {
      lastError = err
      if (attempt === maxRetries) {
        throw lastError
      }
      const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
      Atomics.wait(waitBuffer, 0, 0, 50)
    }
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c', 'user.name=Factory Test',
      '-c', 'user.email=factory@example.test',
      '-c', 'core.hooksPath=',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
    },
  ).trim()
}

function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function findPidsByNonces(
  nonces: string[],
  options?: { executorsOnly?: boolean },
): number[] {
  const validNonces = nonces.filter((n) => typeof n === 'string' && n.trim().length > 0)
  if (validNonces.length === 0) return []

  const executorsOnly = options?.executorsOnly === true

  if (process.platform === 'win32') {
    const escapedNonces = validNonces.map((n) => `'*${n.replace(/'/g, "''")}*'`).join(',')
    const runnerPid = process.pid
    const script = [
      `$n = @(${escapedNonces});`,
      `$execOnly = ${executorsOnly ? '$true' : '$false'};`,
      `Get-CimInstance Win32_Process | Where-Object {`,
      `  if ($_.ProcessId -eq $PID -or $_.ProcessId -eq ${runnerPid}) { return $false };`,
      `  $c = $_.CommandLine;`,
      `  if (-not $c) { return $false };`,
      `  if ($execOnly -and $c -like '*factory-grandchild-*') { return $false };`,
      `  foreach ($p in $n) { if ($c -like $p) { return $true } };`,
      `  return $false`,
      `} | ForEach-Object { $_.ProcessId }`,
    ].join(' ')

    const res = spawnSync('powershell', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    })

    if (res.error) {
      throw new Error(`Process enumeration failed: ${res.error.message}`)
    }
    if (res.status !== 0) {
      throw new Error(
        `Process enumeration command failed with status ${res.status}: ${res.stderr || res.stdout}`,
      )
    }

    const pids: number[] = []
    if (res.stdout) {
      for (const line of res.stdout.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (/^\d+$/.test(trimmed)) {
          const pid = Number(trimmed)
          if (pid > 0 && pid !== process.pid) {
            pids.push(pid)
          }
        }
      }
    }
    return Array.from(new Set(pids))
  } else {
    const pids: number[] = []
    const ps = spawnSync('ps', ['-eo', 'pid,command'], {
      encoding: 'utf8',
      timeout: 10000,
    })
    if (ps.error) {
      throw new Error(`ps command failed: ${ps.error.message}`)
    }
    if (ps.status !== 0) {
      throw new Error(`ps command failed with status ${ps.status}: ${ps.stderr || ps.stdout}`)
    }
    if (ps.stdout) {
      for (const line of ps.stdout.split('\n')) {
        if (executorsOnly && line.includes('factory-grandchild-')) {
          continue
        }
        for (const n of validNonces) {
          if (line.includes(n)) {
            const match = line.trim().match(/^(\d+)/)
            const pidStr = match?.[1]
            if (pidStr) {
              const pid = Number(pidStr)
              if (pid > 0 && pid !== process.pid) {
                pids.push(pid)
                break
              }
            }
          }
        }
      }
    }
    return Array.from(new Set(pids))
  }
}

function findGrandchildPidsByNonces(nonces: string[]): number[] {
  const validNonces = nonces.filter((n) => typeof n === 'string' && n.trim().length > 0)
  if (validNonces.length === 0) return []

  if (process.platform === 'win32') {
    const escapedNonces = validNonces.map((n) => `'*${n.replace(/'/g, "''")}*'`).join(',')
    const runnerPid = process.pid
    const script = [
      `$n = @(${escapedNonces});`,
      `Get-CimInstance Win32_Process | Where-Object {`,
      `  if ($_.ProcessId -eq $PID -or $_.ProcessId -eq ${runnerPid}) { return $false };`,
      `  $c = $_.CommandLine;`,
      `  if (-not $c) { return $false };`,
      `  if ($c -notlike '*factory-grandchild-*') { return $false };`,
      `  foreach ($p in $n) { if ($c -like $p) { return $true } };`,
      `  return $false`,
      `} | ForEach-Object { $_.ProcessId }`,
    ].join(' ')

    const res = spawnSync('powershell', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    })

    if (res.error) {
      throw new Error(`Grandchild process enumeration failed: ${res.error.message}`)
    }
    if (res.status !== 0) {
      throw new Error(
        `Grandchild process enumeration command failed with status ${res.status}: ${res.stderr || res.stdout}`,
      )
    }

    const pids: number[] = []
    if (res.stdout) {
      for (const line of res.stdout.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (/^\d+$/.test(trimmed)) {
          const pid = Number(trimmed)
          if (pid > 0 && pid !== process.pid) {
            pids.push(pid)
          }
        }
      }
    }
    return Array.from(new Set(pids))
  } else {
    const pids: number[] = []
    const ps = spawnSync('ps', ['-eo', 'pid,command'], {
      encoding: 'utf8',
      timeout: 10000,
    })
    if (ps.error) {
      throw new Error(`ps command failed: ${ps.error.message}`)
    }
    if (ps.status !== 0) {
      throw new Error(`ps command failed with status ${ps.status}: ${ps.stderr || ps.stdout}`)
    }
    if (ps.stdout) {
      for (const line of ps.stdout.split('\n')) {
        if (!line.includes('factory-grandchild-')) continue
        for (const n of validNonces) {
          if (line.includes(n)) {
            const match = line.trim().match(/^(\d+)/)
            const pidStr = match?.[1]
            if (pidStr) {
              const pid = Number(pidStr)
              if (pid > 0 && pid !== process.pid) {
                pids.push(pid)
                break
              }
            }
          }
        }
      }
    }
    return Array.from(new Set(pids))
  }
}

async function cleanupNonces(
  nonces: Iterable<string>,
  timeoutMs = 25000,
): Promise<void> {
  const nonceList = Array.from(
    new Set(Array.from(nonces).filter((n) => typeof n === 'string' && n.length > 0)),
  )
  if (nonceList.length === 0) return

  const deadline = Date.now() + timeoutMs
  let survivors: number[] = []

  while (Date.now() < deadline) {
    survivors = findPidsByNonces(nonceList)
    if (survivors.length === 0) break

    for (const pid of survivors) {
      if (pid === process.pid) continue
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/F', '/PID', String(pid)], {
            timeout: 10000,
            stdio: 'ignore',
            windowsHide: true,
          })
        } else {
          process.kill(pid, 'SIGKILL')
        }
      } catch {
        // ignore individual kill failure
      }
    }
    await delay(150)
  }

  survivors = findPidsByNonces(nonceList)
  if (survivors.length > 0) {
    throw new Error(
      `Cleanup failed to terminate all matching processes for nonces [${nonceList.join(', ')}]. Survivors: ${survivors.join(', ')}`,
    )
  }

  for (const n of nonceList) {
    activeNonces.delete(n)
  }
}

async function waitForProcessDeath(pid: number, timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await delay(50)
  }
  return !isProcessAlive(pid)
}

interface WorkerJson {
  pid: number
  nonce: string
  grandchildPid?: number
}

function readdirSyncSafe(path: string): string[] {
  try {
    return existsSync(path) ? readdirSync(path) : []
  } catch {
    return []
  }
}

async function waitForWorkerJson(
  runDir: string,
  timeoutMs = 20000,
): Promise<{ pid: number; nonce: string; grandchildPid: number }> {
  const workerPath = join(runDir, 'worker.json')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(workerPath)) {
      try {
        const raw = readFileSync(workerPath, 'utf8')
        const data = JSON.parse(raw) as WorkerJson
        if (
          data &&
          typeof data.pid === 'number' &&
          typeof data.nonce === 'string' &&
          typeof data.grandchildPid === 'number'
        ) {
          return {
            pid: data.pid,
            nonce: data.nonce,
            grandchildPid: data.grandchildPid,
          }
        }
      } catch {
        // retry on partial write
      }
    }
    await delay(50)
  }
  throw new Error(`worker.json with grandchildPid did not appear in ${runDir} within ${timeoutMs}ms`)
}

async function pollForRunsWorkerJson(
  runsDir: string,
  timeoutMs = 25000,
): Promise<{ pid: number; nonce: string; grandchildPid: number; runDir: string }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(runsDir)) {
      const attemptDirs = readdirSyncSafe(runsDir)
      for (const attDir of attemptDirs) {
        const candidateRun = join(runsDir, attDir)
        const workerJsonPath = join(candidateRun, 'worker.json')
        if (existsSync(workerJsonPath)) {
          try {
            const raw = readFileSync(workerJsonPath, 'utf8')
            const parsed = JSON.parse(raw) as WorkerJson
            if (
              parsed &&
              typeof parsed.pid === 'number' &&
              typeof parsed.nonce === 'string' &&
              typeof parsed.grandchildPid === 'number'
            ) {
              return {
                pid: parsed.pid,
                nonce: parsed.nonce,
                grandchildPid: parsed.grandchildPid,
                runDir: candidateRun,
              }
            }
          } catch {
            // retry on partial write
          }
        }
      }
    }
    await delay(100)
  }
  throw new Error(`Complete worker.json with grandchildPid did not appear in ${runsDir} within ${timeoutMs}ms`)
}

function harvestRunDirectories(stateDir: string): void {
  const runsDir = join(stateDir, 'runs')
  if (!existsSync(runsDir)) return
  for (const entry of readdirSyncSafe(runsDir)) {
    const candidate = join(runsDir, entry)
    const workerJsonPath = join(candidate, 'worker.json')
    if (existsSync(workerJsonPath)) {
      try {
        const raw = readFileSync(workerJsonPath, 'utf8')
        const data = JSON.parse(raw) as WorkerJson
        if (data && typeof data.nonce === 'string' && data.nonce.length > 0) {
          activeNonces.add(data.nonce)
        }
      } catch {
        // ignore
      }
    }
  }
}

function harvestDbWorkers(dbPath: string): void {
  if (!existsSync(dbPath)) return
  try {
    const db = openStore(dbPath)
    try {
      const rows = db.prepare('SELECT nonce FROM workers').all() as Array<{ nonce: string }>
      for (const row of rows) {
        if (row && typeof row.nonce === 'string' && row.nonce.length > 0) {
          activeNonces.add(row.nonce)
        }
      }
    } finally {
      db.close()
    }
  } catch {
    // ignore
  }
}

function runCli(args: string[], options?: { env?: NodeJS.ProcessEnv; timeout?: number }) {
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    timeout: options?.timeout ?? 20000,
    windowsHide: true,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      ...options?.env,
    },
  })
  if (res.error && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    throw new Error(`CLI execution timed out after ${options?.timeout ?? 20000}ms: factory ${args.join(' ')}`)
  }
  return res
}

function spawnCli(
  args: string[],
  options?: { env?: NodeJS.ProcessEnv },
): ChildProcess & { marker: string } {
  const marker = `factory-supervisor-${randomUUID()}`
  const child = spawn(
    process.execPath,
    [`--title=${marker}`, cliPath, ...args],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        FACTORY_SUPERVISOR_MARKER: marker,
        ...options?.env,
      },
    },
  ) as ChildProcess & { marker: string }
  child.marker = marker
  if (child.pid) {
    spawnedSupervisorChildren.push({ child, marker, pid: child.pid })
  }
  return child
}

function createInitializedProject(prefix = 'factory-m3-recovery-'): TestContext {
  const root = mkdtempSync(join(tmpdir(), `${prefix}${randomUUID().slice(0, 8)}-`))
  tempDirs.push(root)
  const repoDir = join(root, 'repo')
  const stateDir = join(root, 'state')
  mkdirSync(repoDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })

  git(repoDir, 'init')
  git(repoDir, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(repoDir, 'README.md'), '# Factory Repo\n', 'utf8')
  git(repoDir, 'add', '.')
  git(repoDir, 'commit', '-m', 'Initial base commit')
  const baseSha = git(repoDir, 'rev-parse', 'HEAD')

  const initRes = runCli(['init', '--state-dir', stateDir, '--repo', repoDir])
  if (initRes.status !== 0) {
    throw new Error(`factory init failed with status ${initRes.status}: ${initRes.stderr || initRes.stdout}`)
  }

  const dbPath = join(stateDir, 'state.sqlite')
  const ctx: TestContext = { stateDir, repoDir, dbPath, baseSha }
  activeContexts.push(ctx)
  return ctx
}

afterEach(async () => {
  // 1. Terminate all spawned supervisor child processes with verified identity.
  // Retain cleanup ownership: do NOT splice before termination succeeds.
  const supervisorKillFailures: string[] = []
  const remainingSupervisors: TrackedSupervisorChild[] = []

  for (const item of spawnedSupervisorChildren) {
    const { child, marker, pid } = item
    if (pid && isProcessAlive(pid)) {
      if (!isSupervisorProcess(pid, marker)) {
        supervisorKillFailures.push(
          `Supervisor PID ${pid} does not match marker ${marker} (possible PID reuse); refusing to kill`,
        )
        remainingSupervisors.push(item)
        continue
      }
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
            timeout: 10000,
            stdio: 'ignore',
            windowsHide: true,
          })
        } else {
          child.kill('SIGKILL')
        }
      } catch {
        // ignore
      }
      const dead = await waitForProcessDeath(pid, 15000)
      if (!dead) {
        supervisorKillFailures.push(`Supervisor process ${pid} failed to terminate within 15000ms`)
        remainingSupervisors.push(item)
      }
    }
  }

  // Retain unconfirmed or surviving supervisor children
  spawnedSupervisorChildren.length = 0
  spawnedSupervisorChildren.push(...remainingSupervisors)

  if (supervisorKillFailures.length > 0) {
    throw new Error(`Supervisor cleanup failed:\n${supervisorKillFailures.join('\n')}`)
  }

  // 2. Harvest all run directories and DB workers across active contexts
  for (const ctx of activeContexts) {
    harvestRunDirectories(ctx.stateDir)
    harvestDbWorkers(ctx.dbPath)
  }

  // 3. Clean up all matching worker processes by nonce and confirm termination.
  // Keep fixtures on disk if survivors remain (fail loudly, do not delete).
  await cleanupNonces(activeNonces, 25000)

  // 4. Safely remove temporary directories only after confirmed termination of all processes.
  // Never delete fixtures while survivors exist.
  if (spawnedSupervisorChildren.length > 0) {
    throw new Error(
      `Refusing to delete test fixtures while surviving supervisor processes exist: ${spawnedSupervisorChildren.map((s) => s.pid).join(', ')}`,
    )
  }
  if (activeNonces.size > 0) {
    throw new Error(
      `Refusing to delete test fixtures while active worker nonces remain: ${Array.from(activeNonces).join(', ')}`,
    )
  }

  const dirsToRemove = [...tempDirs]
  const dirFailures: string[] = []
  for (const dir of dirsToRemove) {
    try {
      safeRemoveDir(dir)
      const idx = tempDirs.indexOf(dir)
      if (idx !== -1) tempDirs.splice(idx, 1)
    } catch (err: any) {
      dirFailures.push(`${dir}: ${err?.message ?? String(err)}`)
    }
  }

  activeContexts.length = 0

  if (dirFailures.length > 0) {
    throw new Error(`Fixture directory cleanup failed:\n${dirFailures.join('\n')}`)
  }
}, 90000)

describe('M3-06 Recovery and Supervisor Loop Contract', () => {
  describe('CHK-M3-06-a: supervisor loop tick order, exit-when-idle, and normal task progression', () => {
    it(
      'CHK-M3-06-a: normal run progresses task ready -> progress -> done with succeeded attempt, worker exited, and immutable evidence',
      async () => {
        const { stateDir, repoDir, dbPath } = createInitializedProject('m3-06-a-normal-')

        const createRes = runCli([
          'task',
          'create',
          '--state-dir',
          stateDir,
          '--title',
          'A Normal Task',
        ])
        expect(createRes.status).toBe(0)
        expect(createRes.stdout).toMatch(/^created [0-9a-f-]+\r?\n/i)
        expect(createRes.stdout).toMatch(ARABIC_REGEX)

        const taskId = parseCreatedTaskId(createRes.stdout)

        // Start supervisor in background with brief sleep to observe progress transition
        const supChild = spawnCli(['start', '--state-dir', stateDir, '--exit-when-idle'], {
          env: { FAKE_SLEEP_MS: '2000' },
        })

        // Poll and assert the required 'progress' transition while the executor is running
        let sawProgress = false
        const progressDeadline = Date.now() + 20000
        while (Date.now() < progressDeadline) {
          const dbPoll = openStore(dbPath)
          try {
            const taskRow = dbPoll.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string } | undefined
            if (taskRow && taskRow.status === 'progress') {
              sawProgress = true
              break
            }
          } finally {
            dbPoll.close()
          }
          await delay(100)
        }
        expect(sawProgress).toBe(true)

        // Wait for supervisor to finish idle shutdown
        const exitCode = await new Promise<number>((resolve) => {
          if (supChild.exitCode !== null) return resolve(supChild.exitCode)
          supChild.once('exit', (code) => resolve(code ?? 0))
        })
        expect(exitCode).toBe(0)

        const db = openStore(dbPath)
        try {
          const tasks = db.prepare('SELECT id, title, status FROM tasks').all() as Array<{
            id: string
            title: string
            status: string
          }>
          expect(tasks).toHaveLength(1)
          const task = tasks[0]!
          expect(task.id).toBe(taskId)
          expect(task.title).toBe('A Normal Task')
          expect(task.status).toBe('done')

          const attempts = db.prepare('SELECT * FROM attempts WHERE task_id = ?').all(task.id) as Array<{
            id: string
            attempt_no: number
            status: string
            exit_code: number | null
          }>
          expect(attempts).toHaveLength(1)
          const attempt = attempts[0]!
          expect(attempt.attempt_no).toBe(1)
          expect(attempt.status).toBe('succeeded')
          expect(attempt.exit_code).toBe(0)

          const runDir = join(stateDir, 'runs', attempt.id)
          const resultPath = join(runDir, 'result.json')
          expect(existsSync(resultPath)).toBe(true)
          const resultJson = JSON.parse(readFileSync(resultPath, 'utf8')) as { exitCode: number }
          expect(resultJson).toEqual({ exitCode: 0 })

          const workers = db.prepare('SELECT * FROM workers WHERE attempt_id = ?').all(attempt.id) as Array<{
            nonce: string
            state: string
            pid: number
          }>
          expect(workers).toHaveLength(1)
          const worker = workers[0]!
          expect(worker.state).toBe('exited')

          const evidenceRows = db.prepare('SELECT * FROM evidence WHERE attempt_id = ?').all(attempt.id) as Array<{
            base_sha: string
            head_sha: string
            files_json: string
            stdout_sha256: string
            stderr_sha256: string
          }>
          expect(evidenceRows).toHaveLength(1)
          const evidence = evidenceRows[0]!
          expect(evidence.head_sha).not.toBe(evidence.base_sha)

          const files = JSON.parse(evidence.files_json) as Array<{ path: string; sha256: string }>
          expect(files.some((f) => f.path.includes(`factory-fake/${task.id}.txt`))).toBe(true)

          const worktreePath = join(stateDir, 'worktrees', task.id)
          expect(existsSync(worktreePath)).toBe(true)
          const headLog = git(worktreePath, 'log', '-1', '--format=%B', evidence.head_sha)
          expect(headLog).toContain(`Factory-Attempt: ${attempt.id}`)

          const leaseRow = db.prepare('SELECT status FROM supervisor_lease WHERE id = 1').get() as {
            status: string
          }
          expect(leaseRow.status).toBe('released')
        } finally {
          db.close()
        }
      },
      90000,
    )

    it(
      'CHK-M3-06-a: real fake-executor run leaves result.json with its FAKE_EXIT_CODE and marks attempt failed on non-zero exit',
      async () => {
        const { stateDir, dbPath } = createInitializedProject('m3-06-a-fake-exit-')

        const createRes = runCli([
          'task',
          'create',
          '--state-dir',
          stateDir,
          '--title',
          'Fake Exit Code Task',
        ])
        expect(createRes.status).toBe(0)
        const taskId = parseCreatedTaskId(createRes.stdout)

        // Run supervisor with custom FAKE_EXIT_CODE=42
        const supChild = spawnCli(['start', '--state-dir', stateDir, '--exit-when-idle'], {
          env: { FAKE_EXIT_CODE: '42', FAKE_SLEEP_MS: '500' },
        })

        const exitCode = await new Promise<number>((resolve) => {
          if (supChild.exitCode !== null) return resolve(supChild.exitCode)
          supChild.once('exit', (code) => resolve(code ?? 0))
        })
        expect(exitCode).toBe(0)

        const db = openStore(dbPath)
        try {
          const attempt = db.prepare('SELECT id, status, exit_code FROM attempts WHERE task_id = ?').get(taskId) as {
            id: string
            status: string
            exit_code: number | null
          }
          expect(attempt).toBeDefined()
          expect(attempt.status).toBe('failed')
          expect(attempt.exit_code).toBe(42)

          const runDir = join(stateDir, 'runs', attempt.id)
          const resultPath = join(runDir, 'result.json')
          expect(existsSync(resultPath)).toBe(true)
          const resultJson = JSON.parse(readFileSync(resultPath, 'utf8')) as { exitCode: number }
          expect(resultJson).toEqual({ exitCode: 42 })
        } finally {
          db.close()
        }
      },
      60000,
    )

    it(
      'CHK-M3-06-a: tick execution order strictly adheres to: recover outbox -> reconcile workers -> apply commands -> dispatch ready tasks -> worker liveness -> lease heartbeat',
      async () => {
        const { stateDir, dbPath, repoDir, baseSha } = createInitializedProject('m3-06-a-order-')
        const db = openStore(dbPath)

        const project = db.prepare('SELECT id FROM projects').get() as { id: string }
        const projectId = project.id

        // Seed meaningful fixtures for each operational phase:
        // 1. Pending outbox row with due timestamp
        db.prepare(`INSERT INTO outbox (id, idempotency_key, kind, payload_json, status, tries, next_attempt_ms, created_at, updated_at)
          VALUES ('outbox-order-1', 'worktree.ensure:order-task', 'worktree.ensure', json_object('taskId', 'order-task'), 'pending', 0, 1000, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')`).run()

        // 2. Older generation worker for reconciliation
        const oldAttemptId = 'att-order-old'
        db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c-order-old', ?, 'task.create', '{\"title\":\"Old Task\"}', '2026-11-10T00:00:00.000Z')").run(projectId)
        db.prepare("INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at) VALUES ('c-order-old', 'applied', NULL, 1, '2026-11-10T00:00:00.000Z')").run()
        db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json) VALUES ('order-task-old', ?, 'c-order-old', 'Old Task', 'progress', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z', '[\"order-old\"]')").run(projectId)
        db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation, started_at) VALUES (?, 'order-task-old', 1, 'running', 1, '2026-11-10T00:00:00.000Z')").run(oldAttemptId)
        db.prepare("INSERT INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at) VALUES (?, 'nonce-order-old', 99991, 'running', 'wt', 1000, '2026-11-10T00:00:00.000Z')").run(oldAttemptId)

        // 3. Pending command for apply-commands
        db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c-order-new', ?, 'task.create', '{\"title\":\"New Task\"}', '2026-11-10T00:00:00.000Z')").run(projectId)

        // 4. Ready task for dispatch-tasks
        db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c-order-ready', ?, 'task.create', '{\"title\":\"Ready Task\"}', '2026-11-10T00:00:00.000Z')").run(projectId)
        db.prepare("INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at) VALUES ('c-order-ready', 'applied', NULL, 1, '2026-11-10T00:00:00.000Z')").run()
        db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json) VALUES ('order-task-ready', ?, 'c-order-ready', 'Ready Task', 'ready', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z', '[\"order-ready\",\"factory-fake/order-task-ready.txt\"]')").run(projectId)

        // 5. Running worker belonging to current lease generation for liveness check
        const liveAttemptId = 'att-order-live'
        db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c-order-live', ?, 'task.create', '{\"title\":\"Live Task\"}', '2026-11-10T00:00:00.000Z')").run(projectId)
        db.prepare("INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at) VALUES ('c-order-live', 'applied', NULL, 1, '2026-11-10T00:00:00.000Z')").run()
        db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json) VALUES ('order-task-live', ?, 'c-order-live', 'Live Task', 'progress', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z', '[\"order-live\"]')").run(projectId)
        db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation, started_at) VALUES (?, 'order-task-live', 1, 'running', 2, '2026-11-10T00:00:00.000Z')").run(liveAttemptId)
        db.prepare("INSERT INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at) VALUES (?, 'nonce-order-live', 99992, 'running', 'wt', 1000, '2026-11-10T00:00:00.000Z')").run(liveAttemptId)

        const handle = acquireSupervisor(db, stateDir, { nowMs: 1000, staleAfterMs: 300000 })
        expect(handle.generation).toBeGreaterThanOrEqual(2)

        try {
          const operationEvents: string[] = []
          const phasesSeen: string[] = []

          // Instrument database operations for outbox replay, command application, and lease heartbeat
          const origPrepare = db.prepare.bind(db)
          let loggedOutbox = false
          let loggedCommands = false
          let loggedHeartbeat = false
          db.prepare = ((sql: string) => {
            if (!loggedOutbox && (sql.includes('FROM outbox') || sql.includes('UPDATE outbox'))) {
              loggedOutbox = true
              operationEvents.push('op:outboxReplay')
            }
            if (!loggedCommands && (sql.includes('FROM commands') || sql.includes('command_outcomes'))) {
              loggedCommands = true
              operationEvents.push('op:applyCommands')
            }
            if (!loggedHeartbeat && sql.includes('UPDATE supervisor_lease') && sql.includes('heartbeat_ms')) {
              loggedHeartbeat = true
              operationEvents.push('op:leaseHeartbeat')
            }
            return origPrepare(sql)
          }) as typeof db.prepare

          const loopDeps: LoopDeps = {
            config: { stateDir, repoPath: repoDir, baseRef: baseSha },
            spawnWorker: (opts) => {
              operationEvents.push('op:spawnWorker')
              return { pid: 8888, nonce: 'nonce-order' }
            },
            killTree: async (pid, nonce) => {
              operationEvents.push('op:killTree')
              return { result: 'killed' }
            },
            isAlive: (pid, nonce) => {
              operationEvents.push('op:isAlive')
              return true
            },
            readResult: (runDir) => {
              operationEvents.push('op:readResult')
              return undefined
            },
            onPhase: (phase) => {
              phasesSeen.push(phase)
              operationEvents.push(`phase:${phase}`)
            },
            isProcessAlive: () => {
              operationEvents.push('op:isProcessAlive')
              return true
            },
            wrapRecoverOutbox: async (run) => {
              operationEvents.push('wrap:recover-outbox')
              return run()
            },
            wrapReconcileWorkers: async (run) => {
              operationEvents.push('wrap:reconcile-workers')
              return run()
            },
            wrapApplyCommands: async (run) => {
              operationEvents.push('wrap:apply-commands')
              const res = await run()
              const createdTaskAtBoundary = db.prepare('SELECT status FROM tasks WHERE created_by_command = ?').get('c-order-new') as { status: string } | undefined
              if (createdTaskAtBoundary) {
                operationEvents.push(`phaseEffect:apply-commands:status=${createdTaskAtBoundary.status}`)
              }
              return res
            },
            wrapDispatchTasks: async (run) => {
              operationEvents.push('wrap:dispatch-tasks')
              return run()
            },
            wrapWorkerLiveness: async (run) => {
              operationEvents.push('wrap:worker-liveness')
              return run()
            },
            wrapLeaseHeartbeat: async (run) => {
              operationEvents.push('wrap:lease-heartbeat')
              return run()
            },
          }

          const nowMs = 2000
          const tickResult: RunTickResult = await runTick(db, handle, loopDeps, nowMs)
          expect(tickResult).toBeDefined()
          expect(typeof tickResult.idle).toBe('boolean')

          // Verify exact phase callback sequence
          expect(phasesSeen).toEqual([
            'recover-outbox',
            'reconcile-workers',
            'apply-commands',
            'dispatch-tasks',
            'worker-liveness',
            'lease-heartbeat',
          ])

          // Verify relative order of actual operations from the shared log:
          // 1. outbox recovery (op:outboxReplay)
          // 2. reconcile workers (op:killTree)
          // 3. apply commands (op:applyCommands)
          // 4. dispatch ready tasks (op:spawnWorker)
          // 5. worker liveness (op:isAlive)
          // 6. lease heartbeat (op:leaseHeartbeat)

          const outboxIdx = operationEvents.indexOf('op:outboxReplay')
          const reconcileIdx = operationEvents.indexOf('op:killTree')
          const applyIdx = operationEvents.indexOf('op:applyCommands')
          const dispatchIdx = operationEvents.indexOf('op:spawnWorker')
          const livenessIdx = operationEvents.indexOf('op:isAlive')
          const heartbeatIdx = operationEvents.indexOf('op:leaseHeartbeat')

          expect(outboxIdx, 'op:outboxReplay must be emitted during outbox recovery').toBeGreaterThan(-1)
          expect(reconcileIdx, 'op:killTree must be emitted during worker reconciliation').toBeGreaterThan(-1)
          expect(applyIdx, 'op:applyCommands must be emitted during command application').toBeGreaterThan(-1)
          expect(dispatchIdx, 'op:spawnWorker must be emitted during task dispatch').toBeGreaterThan(-1)
          expect(livenessIdx, 'op:isAlive must be emitted during worker liveness check').toBeGreaterThan(-1)
          expect(heartbeatIdx, 'op:leaseHeartbeat must be emitted during lease heartbeat').toBeGreaterThan(-1)

          // Strict relative ordering across all operational steps
          expect(outboxIdx).toBeLessThan(reconcileIdx)
          expect(reconcileIdx).toBeLessThan(applyIdx)
          expect(applyIdx).toBeLessThan(dispatchIdx)
          expect(dispatchIdx).toBeLessThan(livenessIdx)
          expect(livenessIdx).toBeLessThan(heartbeatIdx)

          // Verify killTree strictly precedes spawnWorker
          const killIdx = operationEvents.indexOf('op:killTree')
          const spawnIdx = operationEvents.indexOf('op:spawnWorker')
          expect(killIdx).toBeGreaterThan(-1)
          expect(spawnIdx).toBeGreaterThan(-1)
          expect(killIdx).toBeLessThan(spawnIdx)

          // Verify observable fixture effects for every phase:
          // Phase 1 effect: outbox row processed from pending to done
          const outboxRow = db.prepare('SELECT status FROM outbox WHERE id = ?').get('outbox-order-1') as { status: string }
          expect(outboxRow.status).toBe('done')

          // Phase 2 effect: older generation worker reconciled (state killed, attempt interrupted)
          const oldWorker = db.prepare('SELECT state FROM workers WHERE attempt_id = ?').get(oldAttemptId) as { state: string }
          expect(oldWorker.state).toBe('killed')
          const oldAttempt = db.prepare('SELECT status FROM attempts WHERE id = ?').get(oldAttemptId) as { status: string }
          expect(oldAttempt.status).toBe('interrupted')

          // Phase 3 effect: pending command applied, new task created in ready status at apply-commands boundary
          const outcome = db.prepare('SELECT outcome FROM command_outcomes WHERE command_id = ?').get('c-order-new') as { outcome: string }
          expect(outcome).toBeDefined()
          expect(outcome.outcome).toBe('applied')
          expect(operationEvents).toContain('phaseEffect:apply-commands:status=ready')

          // After the tick, the task may remain 'ready' or have transitioned to 'progress' if dispatched
          const newTask = db.prepare('SELECT id, status FROM tasks WHERE created_by_command = ?').get('c-order-new') as { id: string; status: string }
          expect(newTask).toBeDefined()
          expect(['ready', 'progress']).toContain(newTask.status)
          if (newTask.status === 'progress') {
            const newTaskAttempts = db.prepare('SELECT id, status FROM attempts WHERE task_id = ?').all(newTask.id) as Array<{ id: string; status: string }>
            expect(newTaskAttempts).toHaveLength(1)
          }

          // Phase 4 effect: ready task dispatched, transitioned to progress with attempt spawned
          const readyTask = db.prepare('SELECT status FROM tasks WHERE id = ?').get('order-task-ready') as { status: string }
          expect(readyTask.status).toBe('progress')
          const spawnedAttempts = db.prepare('SELECT id, status FROM attempts WHERE task_id = ?').all('order-task-ready') as Array<{ id: string; status: string }>
          expect(spawnedAttempts.length).toBeGreaterThanOrEqual(1)

          // Phase 5 effect: live worker heartbeat updated to current tick time
          const liveWorker = db.prepare('SELECT heartbeat_ms FROM workers WHERE attempt_id = ?').get(liveAttemptId) as { heartbeat_ms: number }
          expect(liveWorker.heartbeat_ms).toBeGreaterThanOrEqual(nowMs)

          // Phase 6 effect: lease heartbeat updated in DB to nowMs
          const leaseAfter = db.prepare('SELECT heartbeat_ms FROM supervisor_lease WHERE id = 1').get() as {
            heartbeat_ms: number
          }
          expect(leaseAfter.heartbeat_ms).toBe(nowMs)
        } finally {
          try {
            handle.release(3000)
          } catch {
            // ignore
          }
          db.close()
        }
      },
      60000,
    )

    it(
      'CHK-M3-06-a: --exit-when-idle cleanly releases lease and exits 0 when nothing is pending or running',
      async () => {
        const { stateDir, dbPath } = createInitializedProject('m3-06-a-idle-')

        const res = runCli(['start', '--state-dir', stateDir, '--exit-when-idle'])
        expect(res.error).toBeUndefined()
        expect(res.status).toBe(0)

        const db = openStore(dbPath)
        try {
          const leaseRow = db.prepare('SELECT status FROM supervisor_lease WHERE id = 1').get() as {
            status: string
          }
          expect(leaseRow.status).toBe('released')
        } finally {
          db.close()
        }
      },
      60000,
    )
  })

  describe('CHK-M3-06-b: startup reconciliation of older-generation workers', () => {
    it(
      'CHK-M3-06-b: live worker from older generation is verified alive, killed, marked killed, attempt interrupted, and retried once',
      async () => {
        const { stateDir, dbPath } = createInitializedProject('m3-06-b-live-')

        const oldNonce = `worker-old-live-${randomUUID()}`
        activeNonces.add(oldNonce)

        const stubbornScript = [
          `const nonce = process.argv[2];`,
          `setInterval(() => {}, 1000);`,
        ].join(' ')
        const liveWorkerChild = spawn(process.execPath, ['-e', stubbornScript, oldNonce], {
          stdio: 'ignore',
          windowsHide: true,
        })
        const livePid = liveWorkerChild.pid!
        expect(isProcessAlive(livePid)).toBe(true)

        const taskId = 'task-b-live'
        const oldAttemptId = 'att-b-live-1'

        const db = openStore(dbPath)
        try {
          const project = db.prepare('SELECT id FROM projects').get() as { id: string }
          const now = '2026-11-10T00:00:00.000Z'
          db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c-b-live', ?, 'task.create', '{\"title\":\"Task B\"}', ?)").run(project.id, now)
          db.prepare("INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at) VALUES ('c-b-live', 'applied', NULL, 1, ?)").run(now)
          db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES (?, ?, 'c-b-live', 'Task B', 'progress', ?, ?)").run(taskId, project.id, now, now)
          db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation, started_at) VALUES (?, ?, 1, 'running', 1, ?)").run(oldAttemptId, taskId, now)
          db.prepare("INSERT INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at) VALUES (?, ?, ?, 'running', ?, 1000, ?)").run(
            oldAttemptId,
            oldNonce,
            livePid,
            join(stateDir, 'worktrees', taskId),
            now,
          )
          db.prepare("UPDATE supervisor_lease SET generation = 1, heartbeat_ms = 1000, status = 'released' WHERE id = 1").run()
        } finally {
          db.close()
        }

        const recoveryDeps: RecoveryDeps = {
          killTree: async (pid, nonce) => {
            if (nonce === oldNonce && isProcessAlive(pid)) {
              if (process.platform === 'win32') {
                spawnSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore', timeout: 5000, windowsHide: true })
              } else {
                process.kill(pid, 'SIGKILL')
              }
              return { result: 'killed' }
            }
            return { result: 'not-running' }
          },
          stateDir,
        }

        const handleDb = openStore(dbPath)
        const handle = acquireSupervisor(handleDb, stateDir, { nowMs: 5000, staleAfterMs: 1000 })
        expect(handle.generation).toBe(2)

        try {
          const recResult = await reconcileWorkers(handleDb, handle, recoveryDeps, 5000)
          expect(recResult.reconciledCount).toBeGreaterThanOrEqual(1)
          expect(recResult.killedCount).toBe(1)

          const deadConfirmed = await waitForProcessDeath(livePid, 15000)
          expect(deadConfirmed).toBe(true)

          const oldWorker = handleDb.prepare('SELECT state FROM workers WHERE attempt_id = ?').get(oldAttemptId) as { state: string }
          expect(oldWorker.state).toBe('killed')

          const oldAttempt = handleDb.prepare('SELECT status FROM attempts WHERE id = ?').get(oldAttemptId) as { status: string }
          expect(oldAttempt.status).toBe('interrupted')

          const newAttempts = handleDb.prepare('SELECT * FROM attempts WHERE task_id = ? AND attempt_no = 2').all(taskId) as Array<{
            id: string
            status: string
            attempt_no: number
          }>
          expect(newAttempts).toHaveLength(1)
          expect(['pending', 'running']).toContain(newAttempts[0]!.status)
        } finally {
          try {
            handle.release(6000)
          } catch {
            // ignore
          }
          handleDb.close()
        }
      },
      60000,
    )

    it(
      'CHK-M3-06-b: dead worker PID from older generation is marked lost, attempt interrupted, and retried once',
      async () => {
        const { stateDir, dbPath } = createInitializedProject('m3-06-b-dead-')

        const deadChild = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { timeout: 10000 })
        const deadPid = deadChild.pid!
        expect(isProcessAlive(deadPid)).toBe(false)

        const taskId = 'task-b-dead'
        const oldAttemptId = 'att-b-dead-1'
        const deadNonce = `dead-worker-nonce-${randomUUID()}`

        const db = openStore(dbPath)
        try {
          const project = db.prepare('SELECT id FROM projects').get() as { id: string }
          const now = '2026-11-10T00:00:00.000Z'
          db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c-b-dead', ?, 'task.create', '{\"title\":\"Dead Task\"}', ?)").run(project.id, now)
          db.prepare("INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at) VALUES ('c-b-dead', 'applied', NULL, 1, ?)").run(now)
          db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES (?, ?, 'c-b-dead', 'Dead Task', 'progress', ?, ?)").run(taskId, project.id, now, now)
          db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation, started_at) VALUES (?, ?, 1, 'running', 1, ?)").run(oldAttemptId, taskId, now)
          db.prepare("INSERT INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at) VALUES (?, ?, ?, 'running', ?, 1000, ?)").run(
            oldAttemptId,
            deadNonce,
            deadPid,
            join(stateDir, 'worktrees', taskId),
            now,
          )
          db.prepare("UPDATE supervisor_lease SET generation = 1, heartbeat_ms = 1000, status = 'released' WHERE id = 1").run()
        } finally {
          db.close()
        }

        const recoveryDeps: RecoveryDeps = {
          killTree: async (_pid, _nonce) => ({ result: 'not-running' }),
          stateDir,
        }

        const handleDb = openStore(dbPath)
        const handle = acquireSupervisor(handleDb, stateDir, { nowMs: 5000, staleAfterMs: 1000 })
        try {
          const recResult = await reconcileWorkers(handleDb, handle, recoveryDeps, 5000)
          expect(recResult.lostCount).toBe(1)

          const oldWorker = handleDb.prepare('SELECT state FROM workers WHERE attempt_id = ?').get(oldAttemptId) as { state: string }
          expect(oldWorker.state).toBe('lost')

          const oldAttempt = handleDb.prepare('SELECT status FROM attempts WHERE id = ?').get(oldAttemptId) as { status: string }
          expect(oldAttempt.status).toBe('interrupted')

          const newAttempts = handleDb.prepare('SELECT * FROM attempts WHERE task_id = ? AND attempt_no = 2').all(taskId) as Array<{
            id: string
            status: string
          }>
          expect(newAttempts).toHaveLength(1)
        } finally {
          try {
            handle.release(6000)
          } catch {
            // ignore
          }
          handleDb.close()
        }
      },
      60000,
    )

    it(
      'CHK-M3-06-b: restart with older-generation dead worker having result.json exitCode 0 marks attempt succeeded, task done, exactly one evidence row, and no new attempt',
      async () => {
        const { stateDir, dbPath, repoDir, baseSha } = createInitializedProject('m3-06-b-restart-0-')

        const deadChild = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { timeout: 10000 })
        const deadPid = deadChild.pid!
        expect(isProcessAlive(deadPid)).toBe(false)

        const taskId = 'task-b-restart-0'
        const oldAttemptId = 'att-b-restart-0-1'
        const deadNonce = `dead-restart-0-nonce-${randomUUID()}`

        // Set up worktree with completed output and commit
        const worktreePath = join(stateDir, 'worktrees', taskId)
        git(repoDir, 'worktree', 'add', worktreePath, '-b', `branch-${taskId}`, baseSha)
        const fakeDir = join(worktreePath, 'factory-fake')
        mkdirSync(fakeDir, { recursive: true })
        writeFileSync(join(fakeDir, `${taskId}.txt`), `completed by ${oldAttemptId}\n`, 'utf8')
        git(worktreePath, 'add', '.')
        git(worktreePath, 'commit', '-m', `Completed task ${taskId}\n\nFactory-Attempt: ${oldAttemptId}`)

        // Set up run directory with result.json { exitCode: 0 }
        const runDir = join(stateDir, 'runs', oldAttemptId)
        mkdirSync(runDir, { recursive: true })
        writeFileSync(join(runDir, 'worker.json'), JSON.stringify({ pid: deadPid, nonce: deadNonce, grandchildPid: deadPid + 1000 }), 'utf8')
        writeFileSync(join(runDir, 'result.json'), JSON.stringify({ exitCode: 0 }), 'utf8')
        writeFileSync(join(runDir, 'stdout.log'), 'simulated executor stdout\n', 'utf8')
        writeFileSync(join(runDir, 'stderr.log'), '', 'utf8')

        const db = openStore(dbPath)
        try {
          const project = db.prepare('SELECT id FROM projects').get() as { id: string }
          const now = '2026-11-10T00:00:00.000Z'
          db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c-b-restart-0', ?, 'task.create', '{\"title\":\"Restart Success Task\"}', ?)").run(project.id, now)
          db.prepare("INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at) VALUES ('c-b-restart-0', 'applied', NULL, 1, ?)").run(now)
          db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES (?, ?, 'c-b-restart-0', 'Restart Success Task', 'progress', ?, ?)").run(taskId, project.id, now, now)
          db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation, started_at) VALUES (?, ?, 1, 'running', 1, ?)").run(oldAttemptId, taskId, now)
          db.prepare("INSERT INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at) VALUES (?, ?, ?, 'running', ?, 1000, ?)").run(
            oldAttemptId,
            deadNonce,
            deadPid,
            worktreePath,
            now,
          )
          db.prepare("UPDATE supervisor_lease SET generation = 1, heartbeat_ms = 1000, status = 'released' WHERE id = 1").run()
        } finally {
          db.close()
        }

        const recoveryDeps: RecoveryDeps = {
          killTree: async (_pid, _nonce) => ({ result: 'not-running' }),
          stateDir,
        }

        const handleDb = openStore(dbPath)
        const handle = acquireSupervisor(handleDb, stateDir, { nowMs: 5000, staleAfterMs: 1000 })
        try {
          const recResult = await reconcileWorkers(handleDb, handle, recoveryDeps, 5000)
          expect(recResult.lostCount).toBe(0)
          expect(recResult.killedCount).toBe(0)

          const oldWorker = handleDb.prepare('SELECT state FROM workers WHERE attempt_id = ?').get(oldAttemptId) as { state: string }
          expect(oldWorker.state).toBe('exited')

          const oldAttempt = handleDb.prepare('SELECT status, exit_code FROM attempts WHERE id = ?').get(oldAttemptId) as {
            status: string
            exit_code: number | null
          }
          expect(oldAttempt.status).toBe('succeeded')
          expect(oldAttempt.exit_code).toBe(0)

          const task = handleDb.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }
          expect(task.status).toBe('done')

          const allAttempts = handleDb.prepare('SELECT id, attempt_no, status FROM attempts WHERE task_id = ?').all(taskId) as Array<{
            id: string
            attempt_no: number
            status: string
          }>
          expect(allAttempts).toHaveLength(1)

          const evidenceRows = handleDb.prepare('SELECT * FROM evidence WHERE attempt_id = ?').all(oldAttemptId) as Array<{
            attempt_id: string
          }>
          expect(evidenceRows).toHaveLength(1)

          const totalEvidence = handleDb.prepare('SELECT COUNT(*) as c FROM evidence').get() as { c: number }
          expect(totalEvidence.c).toBe(1)
        } finally {
          try {
            handle.release(6000)
          } catch {
            // ignore
          }
          handleDb.close()
        }
      },
      60000,
    )

    it(
      'CHK-M3-06-b: restart with older-generation dead worker having result.json exitCode 3 marks attempt failed, task failed, zero evidence, and no retry',
      async () => {
        const { stateDir, dbPath, repoDir, baseSha } = createInitializedProject('m3-06-b-restart-3-')

        const deadChild = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { timeout: 10000 })
        const deadPid = deadChild.pid!
        expect(isProcessAlive(deadPid)).toBe(false)

        const taskId = 'task-b-restart-3'
        const oldAttemptId = 'att-b-restart-3-1'
        const deadNonce = `dead-restart-3-nonce-${randomUUID()}`

        // Set up worktree
        const worktreePath = join(stateDir, 'worktrees', taskId)
        git(repoDir, 'worktree', 'add', worktreePath, '-b', `branch-${taskId}`, baseSha)

        // Set up run directory with result.json { exitCode: 3 }
        const runDir = join(stateDir, 'runs', oldAttemptId)
        mkdirSync(runDir, { recursive: true })
        writeFileSync(join(runDir, 'worker.json'), JSON.stringify({ pid: deadPid, nonce: deadNonce, grandchildPid: deadPid + 1000 }), 'utf8')
        writeFileSync(join(runDir, 'result.json'), JSON.stringify({ exitCode: 3 }), 'utf8')
        writeFileSync(join(runDir, 'stdout.log'), 'simulated executor stdout\n', 'utf8')
        writeFileSync(join(runDir, 'stderr.log'), 'execution failed with exit code 3\n', 'utf8')

        const db = openStore(dbPath)
        try {
          const project = db.prepare('SELECT id FROM projects').get() as { id: string }
          const now = '2026-11-10T00:00:00.000Z'
          db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c-b-restart-3', ?, 'task.create', '{\"title\":\"Restart Failure Task\"}', ?)").run(project.id, now)
          db.prepare("INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at) VALUES ('c-b-restart-3', 'applied', NULL, 1, ?)").run(now)
          db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES (?, ?, 'c-b-restart-3', 'Restart Failure Task', 'progress', ?, ?)").run(taskId, project.id, now, now)
          db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation, started_at) VALUES (?, ?, 1, 'running', 1, ?)").run(oldAttemptId, taskId, now)
          db.prepare("INSERT INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at) VALUES (?, ?, ?, 'running', ?, 1000, ?)").run(
            oldAttemptId,
            deadNonce,
            deadPid,
            worktreePath,
            now,
          )
          db.prepare("UPDATE supervisor_lease SET generation = 1, heartbeat_ms = 1000, status = 'released' WHERE id = 1").run()
        } finally {
          db.close()
        }

        const recoveryDeps: RecoveryDeps = {
          killTree: async (_pid, _nonce) => ({ result: 'not-running' }),
          stateDir,
        }

        const handleDb = openStore(dbPath)
        const handle = acquireSupervisor(handleDb, stateDir, { nowMs: 5000, staleAfterMs: 1000 })
        try {
          const recResult = await reconcileWorkers(handleDb, handle, recoveryDeps, 5000)
          expect(recResult.killedCount).toBe(0)

          const oldWorker = handleDb.prepare('SELECT state FROM workers WHERE attempt_id = ?').get(oldAttemptId) as { state: string }
          expect(['exited', 'lost']).toContain(oldWorker.state)

          const oldAttempt = handleDb.prepare('SELECT status, exit_code FROM attempts WHERE id = ?').get(oldAttemptId) as {
            status: string
            exit_code: number | null
          }
          expect(oldAttempt.status).toBe('failed')
          expect(oldAttempt.exit_code).toBe(3)

          const task = handleDb.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }
          expect(task.status).toBe('failed')

          // Contract: non-zero exit is final with zero evidence rows
          const evidenceRows = handleDb.prepare('SELECT * FROM evidence WHERE attempt_id = ?').all(oldAttemptId) as Array<{
            attempt_id: string
          }>
          expect(evidenceRows).toHaveLength(0)

          const totalEvidence = handleDb.prepare('SELECT COUNT(*) as c FROM evidence').get() as { c: number }
          expect(totalEvidence.c).toBe(0)

          // Contract: failed attempt is final (no retry, exactly the original attempt, NO attempt 2)
          const attempts = handleDb.prepare('SELECT id, attempt_no, status FROM attempts WHERE task_id = ? ORDER BY attempt_no ASC').all(taskId) as Array<{
            id: string
            attempt_no: number
            status: string
          }>
          expect(attempts).toHaveLength(1)
          const a0 = attempts[0]
          if (!a0) throw new Error('expected attempts[0] to be defined')
          expect(a0.id).toBe(oldAttemptId)
          expect(a0.attempt_no).toBe(1)
          expect(a0.status).toBe('failed')
          const attempt2 = attempts.find((a) => a.attempt_no === 2)
          expect(attempt2).toBeUndefined()
        } finally {
          try {
            handle.release(6000)
          } catch {
            // ignore
          }
          handleDb.close()
        }
      },
      60000,
    )

    it(
      'CHK-M3-06-b: older-generation pre-spawn starting worker is reconciled to lost and attempt interrupted before retry',
      async () => {
        const { stateDir, dbPath, repoDir, baseSha } = createInitializedProject('m3-06-b-starting-')
        const taskId = 'task-b-starting'
        const oldAttemptId = 'att-b-starting-1'
        const startingNonce = `starting-nonce-${randomUUID()}`

        const db = openStore(dbPath)
        try {
          const project = db.prepare('SELECT id FROM projects').get() as { id: string }
          const now = '2026-11-10T00:00:00.000Z'
          db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c-b-starting', ?, 'task.create', '{\"title\":\"Starting Task\"}', ?)").run(project.id, now)
          db.prepare("INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at) VALUES ('c-b-starting', 'applied', NULL, 1, ?)").run(now)
          db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES (?, ?, 'c-b-starting', 'Starting Task', 'progress', ?, ?)").run(taskId, project.id, now, now)
          db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation, started_at) VALUES (?, ?, 1, 'running', 1, ?)").run(oldAttemptId, taskId, now)
          db.prepare("INSERT INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at) VALUES (?, ?, NULL, 'starting', ?, 1000, ?)").run(
            oldAttemptId,
            startingNonce,
            join(stateDir, 'worktrees', taskId),
            now,
          )
          db.prepare("UPDATE supervisor_lease SET generation = 1, heartbeat_ms = 1000, status = 'released' WHERE id = 1").run()
        } finally {
          db.close()
        }

        const handleDb = openStore(dbPath)
        const handle = acquireSupervisor(handleDb, stateDir, { nowMs: 5000, staleAfterMs: 1000 })
        try {
          let spawnCalled = false
          const spawnBoundaryViolations: string[] = []
          const loopDeps: LoopDeps = {
            config: { stateDir, repoPath: repoDir, baseRef: baseSha },
            spawnWorker: async (opts) => {
              spawnCalled = true
              // Boundary check: record violations outside the callback so runDue cannot swallow them
              if (opts.attemptId === oldAttemptId) {
                spawnBoundaryViolations.push(`spawnWorker called with oldAttemptId: ${opts.attemptId}`)
              }
              const oldAttempt = handleDb.prepare('SELECT status FROM attempts WHERE id = ?').get(oldAttemptId) as { status: string } | undefined
              if (oldAttempt?.status !== 'interrupted') {
                spawnBoundaryViolations.push(`oldAttempt status before spawn was ${oldAttempt?.status}, expected interrupted`)
              }
              const oldWorker = handleDb.prepare('SELECT state FROM workers WHERE attempt_id = ?').get(oldAttemptId) as { state: string } | undefined
              if (oldWorker?.state === 'starting' || oldWorker?.state === 'running') {
                spawnBoundaryViolations.push(`oldWorker state before spawn was ${oldWorker?.state}, expected not starting or running`)
              }
              if (oldWorker?.state !== 'lost') {
                spawnBoundaryViolations.push(`oldWorker state before spawn was ${oldWorker?.state}, expected lost`)
              }
              return { pid: 99993, nonce: 'nonce-retry-starting' }
            },
            killTree: async () => ({ result: 'not-running' }),
            isAlive: () => false,
            readResult: () => undefined,
          }
          const tickResult = await runTick(handleDb, handle, loopDeps, 5000)
          expect(tickResult).toBeDefined()
          expect(spawnCalled).toBe(true)
          expect(spawnBoundaryViolations).toEqual([])

          const oldWorker = handleDb.prepare('SELECT state FROM workers WHERE attempt_id = ?').get(oldAttemptId) as { state: string }
          expect(oldWorker.state).toBe('lost')

          const oldAttempt = handleDb.prepare('SELECT status FROM attempts WHERE id = ?').get(oldAttemptId) as { status: string }
          expect(oldAttempt.status).toBe('interrupted')

          const newAttempts = handleDb.prepare('SELECT * FROM attempts WHERE task_id = ? AND attempt_no = 2').all(taskId) as Array<{
            id: string
            status: string
          }>
          expect(newAttempts).toHaveLength(1)
        } finally {
          try {
            handle.release(6000)
          } catch {
            // ignore
          }
          handleDb.close()
        }
      },
      60000,
    )

    it(
      'CHK-M3-06-b: older-generation pending attempt.start without a worker row is reconciled to interrupted before dispatching new attempts',
      async () => {
        const { stateDir, dbPath, repoDir, baseSha } = createInitializedProject('m3-06-b-noworker-')
        const taskId = 'task-b-noworker'
        const oldAttemptId = 'att-b-noworker-1'

        const db = openStore(dbPath)
        try {
          const project = db.prepare('SELECT id FROM projects').get() as { id: string }
          const now = '2026-11-10T00:00:00.000Z'
          db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c-b-noworker', ?, 'task.create', '{\"title\":\"No Worker Task\"}', ?)").run(project.id, now)
          db.prepare("INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at) VALUES ('c-b-noworker', 'applied', NULL, 1, ?)").run(now)
          db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES (?, ?, 'c-b-noworker', 'No Worker Task', 'progress', ?, ?)").run(taskId, project.id, now, now)
          db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation, started_at) VALUES (?, ?, 1, 'pending', 1, ?)").run(oldAttemptId, taskId, now)
          db.prepare(`INSERT INTO outbox (id, idempotency_key, kind, payload_json, status, tries, next_attempt_ms, created_at, updated_at)
            VALUES ('outbox-att-noworker', 'attempt.start:' || ?, 'attempt.start', json_object('taskId', ?, 'attemptId', ?), 'pending', 0, 1000, ?, ?)`).run(
            oldAttemptId,
            taskId,
            oldAttemptId,
            now,
            now,
          )
          db.prepare("UPDATE supervisor_lease SET generation = 1, heartbeat_ms = 1000, status = 'released' WHERE id = 1").run()
        } finally {
          db.close()
        }

        const handleDb = openStore(dbPath)
        const handle = acquireSupervisor(handleDb, stateDir, { nowMs: 5000, staleAfterMs: 1000 })
        try {
          let spawnCalled = false
          const spawnBoundaryViolations: string[] = []
          const loopDeps: LoopDeps = {
            config: { stateDir, repoPath: repoDir, baseRef: baseSha },
            spawnWorker: async (opts) => {
              spawnCalled = true
              // Boundary check: record violations outside the callback so runDue cannot swallow them
              if (opts.attemptId === oldAttemptId) {
                spawnBoundaryViolations.push(`spawnWorker called with oldAttemptId: ${opts.attemptId}`)
              }
              const oldAttempt = handleDb.prepare('SELECT status FROM attempts WHERE id = ?').get(oldAttemptId) as { status: string } | undefined
              if (oldAttempt?.status !== 'interrupted') {
                spawnBoundaryViolations.push(`oldAttempt status before spawn was ${oldAttempt?.status}, expected interrupted`)
              }
              const oldWorker = handleDb.prepare('SELECT state FROM workers WHERE attempt_id = ?').get(oldAttemptId) as { state: string } | undefined
              if (oldWorker) {
                if (oldWorker.state === 'starting' || oldWorker.state === 'running') {
                  spawnBoundaryViolations.push(`oldWorker state before spawn was ${oldWorker.state}, expected not starting or running`)
                }
              }
              return { pid: 99994, nonce: 'nonce-retry-noworker' }
            },
            killTree: async () => ({ result: 'not-running' }),
            isAlive: () => false,
            readResult: () => undefined,
          }
          const tickResult = await runTick(handleDb, handle, loopDeps, 5000)
          expect(tickResult).toBeDefined()
          expect(spawnCalled).toBe(true)
          expect(spawnBoundaryViolations).toEqual([])

          const oldAttempt = handleDb.prepare('SELECT status FROM attempts WHERE id = ?').get(oldAttemptId) as { status: string }
          expect(oldAttempt.status).toBe('interrupted')

          const newAttempts = handleDb.prepare('SELECT * FROM attempts WHERE task_id = ? AND attempt_no = 2').all(taskId) as Array<{
            id: string
            status: string
          }>
          expect(newAttempts).toHaveLength(1)
        } finally {
          try {
            handle.release(6000)
          } catch {
            // ignore
          }
          handleDb.close()
        }
      },
      60000,
    )

    it(
      'CHK-M3-06-b: live PID with nonce identity mismatch is never killed, marked lost with persisted diagnostic reason, attempt interrupted, and retried once',
      async () => {
        const { stateDir, dbPath } = createInitializedProject('m3-06-b-mismatch-')

        const runnerPid = process.pid
        expect(isProcessAlive(runnerPid)).toBe(true)

        const taskId = 'task-b-mismatch'
        const oldAttemptId = 'att-b-mismatch-1'
        const wrongNonce = `wrong-nonce-${randomUUID()}`

        const db = openStore(dbPath)
        try {
          const project = db.prepare('SELECT id FROM projects').get() as { id: string }
          const now = '2026-11-10T00:00:00.000Z'
          db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c-b-mismatch', ?, 'task.create', '{\"title\":\"Mismatch Task\"}', ?)").run(project.id, now)
          db.prepare("INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at) VALUES ('c-b-mismatch', 'applied', NULL, 1, ?)").run(now)
          db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES (?, ?, 'c-b-mismatch', 'Mismatch Task', 'progress', ?, ?)").run(taskId, project.id, now, now)
          db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation, started_at) VALUES (?, ?, 1, 'running', 1, ?)").run(oldAttemptId, taskId, now)
          db.prepare("INSERT INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at) VALUES (?, ?, ?, 'running', ?, 1000, ?)").run(
            oldAttemptId,
            wrongNonce,
            runnerPid,
            join(stateDir, 'worktrees', taskId),
            now,
          )
          db.prepare("UPDATE supervisor_lease SET generation = 1, heartbeat_ms = 1000, status = 'released' WHERE id = 1").run()
        } finally {
          db.close()
        }

        const recoveryDeps: RecoveryDeps = {
          killTree: async (pid, nonce) => {
            if (pid === runnerPid) {
              return { result: 'identity-mismatch', detail: 'CommandLine did not contain expected nonce' }
            }
            return { result: 'not-running' }
          },
          stateDir,
        }

        const handleDb = openStore(dbPath)
        const handle = acquireSupervisor(handleDb, stateDir, { nowMs: 5000, staleAfterMs: 1000 })
        try {
          const recResult = await reconcileWorkers(handleDb, handle, recoveryDeps, 5000)
          expect(recResult.lostCount).toBe(1)
          expect(recResult.killedCount).toBe(0)

          expect(isProcessAlive(runnerPid)).toBe(true)

          const oldWorker = handleDb.prepare('SELECT state FROM workers WHERE attempt_id = ?').get(oldAttemptId) as { state: string }
          expect(oldWorker.state).toBe('lost')

          const oldAttempt = handleDb.prepare('SELECT status, error_class FROM attempts WHERE id = ?').get(oldAttemptId) as {
            status: string
            error_class: string | null
          }
          expect(oldAttempt.status).toBe('interrupted')
          // Assert that a nonempty identity-mismatch diagnostic reason was persisted
          expect(typeof oldAttempt.error_class).toBe('string')
          expect(oldAttempt.error_class!.trim().length).toBeGreaterThan(0)

          const newAttempts = handleDb.prepare('SELECT * FROM attempts WHERE task_id = ? AND attempt_no = 2').all(taskId) as Array<{
            id: string
            status: string
          }>
          expect(newAttempts).toHaveLength(1)
        } finally {
          try {
            handle.release(6000)
          } catch {
            // ignore
          }
          handleDb.close()
        }
      },
      60000,
    )

    it(
      'CHK-M3-06-b: task reaching MAX_ATTEMPTS on reconciliation transitions to failed without spawning further attempts',
      async () => {
        const { stateDir, dbPath } = createInitializedProject('m3-06-b-max-')

        expect(typeof MAX_ATTEMPTS).toBe('number')
        expect(Number.isSafeInteger(MAX_ATTEMPTS) && MAX_ATTEMPTS >= 1).toBe(true)

        const taskId = 'task-b-max'
        const lastAttemptId = `att-b-max-${MAX_ATTEMPTS}`

        const db = openStore(dbPath)
        try {
          const project = db.prepare('SELECT id FROM projects').get() as { id: string }
          const now = '2026-11-10T00:00:00.000Z'
          db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c-b-max', ?, 'task.create', '{\"title\":\"Max Task\"}', ?)").run(project.id, now)
          db.prepare("INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at) VALUES ('c-b-max', 'applied', NULL, 1, ?)").run(now)
          db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES (?, ?, 'c-b-max', 'Max Task', 'progress', ?, ?)").run(taskId, project.id, now, now)

          for (let i = 1; i < MAX_ATTEMPTS; i++) {
            db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation, started_at, ended_at) VALUES (?, ?, ?, 'interrupted', 1, ?, ?)").run(
              `att-b-max-${i}`,
              taskId,
              i,
              now,
              now,
            )
          }

          db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation, started_at) VALUES (?, ?, ?, 'running', 1, ?)").run(
            lastAttemptId,
            taskId,
            MAX_ATTEMPTS,
            now,
          )
          db.prepare("INSERT INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at) VALUES (?, ?, 99999, 'running', ?, 1000, ?)").run(
            lastAttemptId,
            'max-nonce-999',
            join(stateDir, 'worktrees', taskId),
            now,
          )
          db.prepare("UPDATE supervisor_lease SET generation = 1, heartbeat_ms = 1000, status = 'released' WHERE id = 1").run()
        } finally {
          db.close()
        }

        const recoveryDeps: RecoveryDeps = {
          killTree: async () => ({ result: 'not-running' }),
          stateDir,
        }

        const handleDb = openStore(dbPath)
        const handle = acquireSupervisor(handleDb, stateDir, { nowMs: 5000, staleAfterMs: 1000 })
        try {
          await reconcileWorkers(handleDb, handle, recoveryDeps, 5000)

          const task = handleDb.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }
          expect(task.status).toBe('failed')

          const totalAttempts = handleDb.prepare('SELECT COUNT(*) as count FROM attempts WHERE task_id = ?').get(taskId) as { count: number }
          expect(totalAttempts.count).toBe(MAX_ATTEMPTS)

          const liveAttempts = handleDb.prepare("SELECT COUNT(*) as count FROM attempts WHERE task_id = ? AND status IN ('pending', 'running')").get(taskId) as { count: number }
          expect(liveAttempts.count).toBe(0)
        } finally {
          try {
            handle.release(6000)
          } catch {
            // ignore
          }
          handleDb.close()
        }
      },
      60000,
    )
  })

  describe('CHK-M3-06-c: crash recovery with stale lease takeover and fault injection', () => {
    it(
      'CHK-M3-06-c: supervisor hard-killed during running attempt and restarted with --takeover cleans orphaned tree, yields exactly two attempts, one commit, and one evidence row',
      async () => {
        const ctx = createInitializedProject('m3-06-c-kill-')
        const { stateDir, dbPath, baseSha } = ctx

        const createRes = runCli([
          'task',
          'create',
          '--state-dir',
          stateDir,
          '--title',
          'Hard Kill Recovery Task',
        ])
        expect(createRes.status).toBe(0)

        // Parse taskId from the CLI's first stdout line: 'created <id>'
        const taskId = parseCreatedTaskId(createRes.stdout)

        const supervisor1 = spawnCli(['start', '--state-dir', stateDir, '--stale-after-ms', '1000'], {
          env: { FAKE_SLEEP_MS: '60000' },
        })

        let attempt1Id: string | undefined
        let workerPid: number | undefined
        let grandchildPid: number | undefined
        let workerNonce: string | undefined

        const pollDeadline = Date.now() + 25000
        while (Date.now() < pollDeadline) {
          const dbPoll = openStore(dbPath)
          try {
            const att = dbPoll.prepare('SELECT id, status FROM attempts WHERE task_id = ?').get(taskId) as {
              id: string
              status: string
            } | undefined
            if (att && att.status === 'running') {
              attempt1Id = att.id
              const w = dbPoll.prepare('SELECT pid, nonce FROM workers WHERE attempt_id = ?').get(att.id) as {
                pid: number
                nonce: string
              } | undefined
              if (w && w.pid) {
                workerPid = w.pid
                workerNonce = w.nonce
                break
              }
            }
          } finally {
            dbPoll.close()
          }
          await delay(100)
        }

        expect(attempt1Id).toBeDefined()
        expect(workerPid).toBeDefined()
        expect(workerNonce).toBeDefined()
        if (!attempt1Id || !workerPid || !workerNonce) {
          throw new Error('Expected attempt1Id, workerPid, and workerNonce to be defined')
        }
        activeNonces.add(workerNonce)

        const runDir = join(stateDir, 'runs', attempt1Id)
        const workerInfo = await waitForWorkerJson(runDir, 20000)
        grandchildPid = workerInfo.grandchildPid
        if (!grandchildPid) {
          throw new Error('Expected grandchildPid to be defined')
        }

        expect(isProcessAlive(workerPid)).toBe(true)
        expect(isProcessAlive(grandchildPid)).toBe(true)

        // Kill supervisor1 first with verified identity and confirm termination BEFORE reading persisted evidence
        expect(isSupervisorProcess(supervisor1.pid!, supervisor1.marker)).toBe(true)
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/F', '/PID', String(supervisor1.pid)], { timeout: 10000, windowsHide: true })
        } else {
          supervisor1.kill('SIGKILL')
        }

        const supervisorDead = await waitForProcessDeath(supervisor1.pid!, 15000)
        expect(supervisorDead).toBe(true)

        // Read final persisted takeover evidence only after supervisor is confirmed dead
        let leaseEvidence: { ownerId: string; generation: number; heartbeatMs: number } | undefined
        const dbLease = openStore(dbPath)
        try {
          const l = dbLease.prepare('SELECT owner_id, generation, heartbeat_ms FROM supervisor_lease WHERE id = 1').get() as {
            owner_id: string
            generation: number
            heartbeat_ms: number
          }
          leaseEvidence = {
            ownerId: l.owner_id,
            generation: l.generation,
            heartbeatMs: l.heartbeat_ms,
          }
        } finally {
          dbLease.close()
        }
        expect(leaseEvidence).toBeDefined()
        if (!leaseEvidence) {
          throw new Error('Expected leaseEvidence to be defined')
        }

        // Executor and grandchild remain alive while supervisor is dead
        expect(isProcessAlive(workerPid!)).toBe(true)
        expect(isProcessAlive(grandchildPid)).toBe(true)

        // Wait until that heartbeat is stale
        const waitStaleMs = Math.max(0, leaseEvidence!.heartbeatMs + 1000 - Date.now() + 150)
        await delay(waitStaleMs)

        const restartRes = runCli([
          'start',
          '--state-dir',
          stateDir,
          '--exit-when-idle',
          '--takeover',
          `${leaseEvidence!.ownerId}:${leaseEvidence!.generation}:${leaseEvidence!.heartbeatMs}`,
          '--stale-after-ms',
          '1000',
        ])

        expect(restartRes.error).toBeUndefined()
        expect(restartRes.status).toBe(0)

        // Both executor and grandchild are verified terminated after takeover
        expect(isProcessAlive(workerPid!)).toBe(false)
        expect(isProcessAlive(grandchildPid)).toBe(false)

        const dbAfter = openStore(dbPath)
        try {
          const taskAfter = dbAfter.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }
          expect(taskAfter.status).toBe('done')

          const attemptsAfter = dbAfter.prepare('SELECT id, attempt_no, status FROM attempts WHERE task_id = ? ORDER BY attempt_no ASC').all(taskId) as Array<{
            id: string
            attempt_no: number
            status: string
          }>
          expect(attemptsAfter).toHaveLength(2)
          expect(attemptsAfter[0]!.attempt_no).toBe(1)
          expect(attemptsAfter[0]!.status).toBe('interrupted')
          expect(attemptsAfter[1]!.attempt_no).toBe(2)
          expect(attemptsAfter[1]!.status).toBe('succeeded')

          const evidenceAfter = dbAfter.prepare('SELECT * FROM evidence').all() as Array<{ attempt_id: string }>
          expect(evidenceAfter).toHaveLength(1)
          expect(evidenceAfter[0]!.attempt_id).toBe(attemptsAfter[1]!.id)

          // Verify commits above stored base_ref SHA
          const wtPath = join(stateDir, 'worktrees', taskId)
          const commitCount = Number(git(wtPath, 'rev-list', '--count', 'HEAD', `^${baseSha}`))
          expect(commitCount).toBe(1)

          const outcomes = dbAfter.prepare('SELECT outcome FROM command_outcomes').all() as Array<{ outcome: string }>
          expect(outcomes.length).toBeGreaterThanOrEqual(1)
          expect(outcomes.every((o) => o.outcome === 'applied')).toBe(true)
        } finally {
          dbAfter.close()
        }
      },
      120000,
    )

    it(
      'CHK-M3-06-c: crash under FACTORY_FAULT=attempt-after-spawn reconciles orphaned worker before retrying attempt.start, yielding zero concurrent executors per attempt',
      async () => {
        const ctx = createInitializedProject('m3-06-c-fault-')
        const { stateDir, dbPath, baseSha } = ctx

        const createRes = runCli([
          'task',
          'create',
          '--state-dir',
          stateDir,
          '--title',
          'Fault Injected Spawn Task',
        ])
        expect(createRes.status).toBe(0)

        // Parse taskId from the CLI's first stdout line: 'created <id>'
        const taskId = parseCreatedTaskId(createRes.stdout)

        const faultedChildRes = runCli(
          ['start', '--state-dir', stateDir, '--stale-after-ms', '1000'],
          {
            env: {
              FACTORY_FAULT: 'attempt-after-spawn',
              FAKE_SLEEP_MS: '60000',
            },
            timeout: 25000,
          },
        )

        expect(faultedChildRes.status).not.toBe(0)

        // Bounded poll for the complete worker.json record with grandchildPid
        const runsDir = join(stateDir, 'runs')
        const completeWorker = await pollForRunsWorkerJson(runsDir, 25000)
        const orphanedPid = completeWorker.pid
        const orphanedNonce = completeWorker.nonce
        const orphanedGrandchild = completeWorker.grandchildPid

        activeNonces.add(orphanedNonce)

        // Require BOTH executor and grandchild alive before recovery
        expect(isProcessAlive(orphanedPid)).toBe(true)
        expect(isProcessAlive(orphanedGrandchild)).toBe(true)

        // Confirm faulted supervisor child is dead before reading lease row
        let leaseEvidence: { ownerId: string; generation: number; heartbeatMs: number } | undefined
        const dbLease = openStore(dbPath)
        try {
          const l = dbLease.prepare('SELECT owner_id, generation, heartbeat_ms FROM supervisor_lease WHERE id = 1').get() as {
            owner_id: string
            generation: number
            heartbeat_ms: number
          }
          leaseEvidence = {
            ownerId: l.owner_id,
            generation: l.generation,
            heartbeatMs: l.heartbeat_ms,
          }
        } finally {
          dbLease.close()
        }
        expect(leaseEvidence).toBeDefined()
        if (!leaseEvidence) {
          throw new Error('Expected leaseEvidence to be defined')
        }

        const waitStaleMs = Math.max(0, leaseEvidence!.heartbeatMs + 1000 - Date.now() + 150)
        await delay(waitStaleMs)

        // Spawn recovery supervisor in background to observe executor counts and prove reconciliation precedes retry spawn
        const recoverySupervisor = spawnCli(
          [
            'start',
            '--state-dir',
            stateDir,
            '--exit-when-idle',
            '--takeover',
            `${leaseEvidence!.ownerId}:${leaseEvidence!.generation}:${leaseEvidence!.heartbeatMs}`,
            '--stale-after-ms',
            '1000',
          ],
          {
            env: { FAKE_SLEEP_MS: '3000' },
          },
        )

        // Monitor retry boundary: require observing the retry spawn (via executor run dirs / worker.json of attempt 2)
        // and count live executors per attempt nonce at each poll. Fail if retry was never observed.
        let observedAttempt2Spawn = false
        let attempt2Nonce: string | undefined
        let attempt2Pid: number | undefined
        let attempt2GrandchildPid: number | undefined

        const recoveryDeadline = Date.now() + 35000
        while (Date.now() < recoveryDeadline) {
          // 1. Scan executor run directories in stateDir/runs for attempt 2
          const attemptDirs = readdirSyncSafe(runsDir)
          for (const attDir of attemptDirs) {
            if (attDir === completeWorker.runDir.split(/[\\/]/).pop()) {
              // This is attempt 1's run directory
              continue
            }
            const candWorkerJson = join(runsDir, attDir, 'worker.json')
            if (existsSync(candWorkerJson)) {
              try {
                const raw = readFileSync(candWorkerJson, 'utf8')
                const parsed = JSON.parse(raw) as WorkerJson
                if (
                  parsed &&
                  typeof parsed.pid === 'number' &&
                  typeof parsed.nonce === 'string' &&
                  typeof parsed.grandchildPid === 'number'
                ) {
                  observedAttempt2Spawn = true
                  attempt2Nonce = parsed.nonce
                  attempt2Pid = parsed.pid
                  attempt2GrandchildPid = parsed.grandchildPid
                  activeNonces.add(parsed.nonce)
                  break
                }
              } catch {
                // partial write
              }
            }
          }

          // 2. Count live EXECUTORS only per attempt nonce at each poll (exclude factory-grandchild-)
          const liveAttempt1Executors = findPidsByNonces([orphanedNonce], { executorsOnly: true })
          expect(
            liveAttempt1Executors.length,
            `Attempt 1 nonce ${orphanedNonce} must have at most 1 live executor at any poll`,
          ).toBeLessThanOrEqual(1)

          if (attempt2Nonce) {
            const liveAttempt2Executors = findPidsByNonces([attempt2Nonce], { executorsOnly: true })
            expect(
              liveAttempt2Executors.length,
              `Attempt 2 nonce ${attempt2Nonce} must have at most 1 live executor at any poll`,
            ).toBeLessThanOrEqual(1)

            // When attempt 2 spawn is observed, attempt 1 executor MUST already be completely terminated (zero live executors)
            expect(
              liveAttempt1Executors.length,
              `Attempt 1 executor must be terminated before or when attempt 2 is observed alive`,
            ).toBe(0)
            expect(isProcessAlive(orphanedPid)).toBe(false)

            // Check descendant (grandchild) termination separately
            expect(isProcessAlive(orphanedGrandchild)).toBe(false)
            const liveAttempt1Grandchildren = findGrandchildPidsByNonces([orphanedNonce])
            expect(
              liveAttempt1Grandchildren.length,
              `Attempt 1 grandchild must be terminated before or when attempt 2 is observed alive`,
            ).toBe(0)
          }

          if (observedAttempt2Spawn && recoverySupervisor.exitCode !== null) {
            break
          }

          await delay(50)
        }

        const recoveryExitCode = await new Promise<number>((resolve) => {
          if (recoverySupervisor.exitCode !== null) return resolve(recoverySupervisor.exitCode)
          recoverySupervisor.once('exit', (code) => resolve(code ?? 0))
        })
        expect(recoveryExitCode).toBe(0)

        // Require that retry spawn of attempt 2 was actually observed via worker.json
        expect(
          observedAttempt2Spawn,
          'Retry spawn for attempt 2 was never observed via executor run dirs / worker.json',
        ).toBe(true)

        // Require BOTH executor and grandchild gone after recovery
        expect(isProcessAlive(orphanedPid)).toBe(false)
        expect(isProcessAlive(orphanedGrandchild)).toBe(false)

        // Check descendant (grandchild) termination separately
        const grandchildSurvivors = findGrandchildPidsByNonces([orphanedNonce])
        expect(grandchildSurvivors).toHaveLength(0)

        const survivors = findPidsByNonces([orphanedNonce])
        expect(survivors).toHaveLength(0)

        const dbFinal = openStore(dbPath)
        try {
          const task = dbFinal.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }
          expect(task.status).toBe('done')

          const attempts = dbFinal.prepare('SELECT id, attempt_no, status FROM attempts WHERE task_id = ? ORDER BY attempt_no ASC').all(taskId) as Array<{
            id: string
            attempt_no: number
            status: string
          }>
          expect(attempts).toHaveLength(2)
          expect(attempts[0]!.status).toBe('interrupted')
          expect(attempts[1]!.status).toBe('succeeded')

          const evidence = dbFinal.prepare('SELECT * FROM evidence').all() as Array<{ attempt_id: string }>
          expect(evidence).toHaveLength(1)
          expect(evidence[0]!.attempt_id).toBe(attempts[1]!.id)

          // One task commit above stored base_ref SHA
          const wtPath = join(stateDir, 'worktrees', taskId)
          const commitCount = Number(git(wtPath, 'rev-list', '--count', 'HEAD', `^${baseSha}`))
          expect(commitCount).toBe(1)
        } finally {
          dbFinal.close()
        }
      },
      120000,
    )
  })

  describe('CHK-M3-06-d: task kill handling and terminal protection', () => {
    it(
      'CHK-M3-06-d: applied task.kill terminates worker tree, marks attempt killed, task dropped, and restart never retries it',
      async () => {
        const { stateDir, dbPath } = createInitializedProject('m3-06-d-kill-')

        const createRes = runCli([
          'task',
          'create',
          '--state-dir',
          stateDir,
          '--title',
          'Task To Kill',
        ])
        expect(createRes.status).toBe(0)

        // Parse taskId from the CLI's first stdout line: 'created <id>'
        const taskId = parseCreatedTaskId(createRes.stdout)

        const supervisor = spawnCli(['start', '--state-dir', stateDir, '--exit-when-idle'], {
          env: { FAKE_SLEEP_MS: '60000' },
        })

        let attemptId: string | undefined
        let workerPid: number | undefined
        let grandchildPid: number | undefined
        let workerNonce: string | undefined

        const pollDeadline = Date.now() + 25000
        while (Date.now() < pollDeadline) {
          const dbPoll = openStore(dbPath)
          try {
            const att = dbPoll.prepare('SELECT id, status FROM attempts WHERE task_id = ?').get(taskId) as {
              id: string
              status: string
            } | undefined
            if (att && att.status === 'running') {
              attemptId = att.id
              const w = dbPoll.prepare('SELECT pid, nonce FROM workers WHERE attempt_id = ?').get(att.id) as {
                pid: number
                nonce: string
              } | undefined
              if (w && w.pid) {
                workerPid = w.pid
                workerNonce = w.nonce
                break
              }
            }
          } finally {
            dbPoll.close()
          }
          await delay(100)
        }

        expect(attemptId).toBeDefined()
        expect(workerPid).toBeDefined()
        expect(workerNonce).toBeDefined()
        if (!attemptId || !workerPid || !workerNonce) {
          throw new Error('Expected attemptId, workerPid, and workerNonce to be defined')
        }
        activeNonces.add(workerNonce)

        const workerJson = await waitForWorkerJson(join(stateDir, 'runs', attemptId), 20000)
        grandchildPid = workerJson.grandchildPid
        if (!grandchildPid) {
          throw new Error('Expected grandchildPid to be defined')
        }
        expect(isProcessAlive(workerPid)).toBe(true)
        expect(isProcessAlive(grandchildPid)).toBe(true)

        const killRes = runCli([
          'task',
          'kill',
          '--state-dir',
          stateDir,
          '--task',
          taskId,
        ])
        expect(killRes.status).toBe(0)
        expect(killRes.stdout).toMatch(/^created [0-9a-f-]+\r?\n/i)
        expect(killRes.stdout).toMatch(ARABIC_REGEX)

        const deathConfirmed = await waitForProcessDeath(workerPid, 20000)
        const grandDeathConfirmed = await waitForProcessDeath(grandchildPid, 20000)
        expect(deathConfirmed).toBe(true)
        expect(grandDeathConfirmed).toBe(true)

        const supExited = await new Promise<boolean>((resolve) => {
          if (supervisor.exitCode !== null) return resolve(true)
          const timer = setTimeout(() => resolve(false), 20000)
          supervisor.once('exit', () => {
            clearTimeout(timer)
            resolve(true)
          })
        })
        expect(supExited).toBe(true)

        const dbAfterKill = openStore(dbPath)
        try {
          const task = dbAfterKill.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }
          expect(task.status).toBe('dropped')

          const attempt = dbAfterKill.prepare('SELECT status FROM attempts WHERE id = ?').get(attemptId) as { status: string }
          expect(attempt.status).toBe('killed')

          const worker = dbAfterKill.prepare('SELECT state FROM workers WHERE attempt_id = ?').get(attemptId) as { state: string }
          expect(worker.state).toBe('killed')
        } finally {
          dbAfterKill.close()
        }

        const restartRes = runCli(['start', '--state-dir', stateDir, '--exit-when-idle'])
        expect(restartRes.status).toBe(0)

        const dbFinal = openStore(dbPath)
        try {
          const task = dbFinal.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }
          expect(task.status).toBe('dropped')

          const attempts = dbFinal.prepare('SELECT * FROM attempts WHERE task_id = ?').all(taskId)
          expect(attempts).toHaveLength(1)
        } finally {
          dbFinal.close()
        }
      },
      120000,
    )

    it(
      'CHK-M3-06-d: killing an already finished (done) task records rejected command outcome and leaves task unchanged',
      async () => {
        const { stateDir, dbPath } = createInitializedProject('m3-06-d-reject-')

        const createRes = runCli(['task', 'create', '--state-dir', stateDir, '--title', 'Done Task'])
        expect(createRes.status).toBe(0)
        const taskId = parseCreatedTaskId(createRes.stdout)

        runCli(['start', '--state-dir', stateDir, '--exit-when-idle'])

        const dbPre = openStore(dbPath)
        try {
          const t = dbPre.prepare('SELECT id, status FROM tasks WHERE id = ?').get(taskId) as { id: string; status: string }
          expect(t.status).toBe('done')
        } finally {
          dbPre.close()
        }

        const killRes = runCli([
          'task',
          'kill',
          '--state-dir',
          stateDir,
          '--task',
          taskId,
        ])
        expect(killRes.status).toBe(0)

        const startRes = runCli(['start', '--state-dir', stateDir, '--exit-when-idle'])
        expect(startRes.status).toBe(0)

        const dbAfter = openStore(dbPath)
        try {
          const task = dbAfter.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }
          expect(task.status).toBe('done')

          const outcomes = dbAfter.prepare(`
            SELECT co.outcome, co.reason FROM command_outcomes co
            JOIN commands c ON c.id = co.command_id
            WHERE c.kind = 'task.kill'
          `).all() as Array<{ outcome: string; reason: string | null }>

          expect(outcomes).toHaveLength(1)
          expect(outcomes[0]!.outcome).toBe('rejected')
          expect(typeof outcomes[0]!.reason).toBe('string')
          expect(outcomes[0]!.reason!.length).toBeGreaterThan(0)
        } finally {
          dbAfter.close()
        }
      },
      60000,
    )
  })

  describe('CHK-M3-06-e: concurrency and lease takeover refusal rules', () => {
    it(
      'CHK-M3-06-e: second factory start while one is live exits 1 with Arabic error and leaves running worker untouched',
      async () => {
        const { stateDir, dbPath } = createInitializedProject('m3-06-e-concurrent-')

        const createRes = runCli(['task', 'create', '--state-dir', stateDir, '--title', 'Concurrent Test Task'])
        expect(createRes.status).toBe(0)

        const supervisor1 = spawnCli(['start', '--state-dir', stateDir], {
          env: { FAKE_SLEEP_MS: '60000' },
        })

        let workerPid: number | undefined
        let workerNonce: string | undefined

        const pollDeadline = Date.now() + 25000
        while (Date.now() < pollDeadline) {
          const dbPoll = openStore(dbPath)
          try {
            const w = dbPoll.prepare('SELECT pid, nonce FROM workers WHERE state = ?').get('running') as {
              pid: number
              nonce: string
            } | undefined
            if (w && w.pid) {
              workerPid = w.pid
              workerNonce = w.nonce
              break
            }
          } finally {
            dbPoll.close()
          }
          await delay(100)
        }

        expect(workerPid).toBeDefined()
        expect(workerNonce).toBeDefined()
        if (!workerPid || !workerNonce) {
          throw new Error('Expected workerPid and workerNonce to be defined')
        }
        activeNonces.add(workerNonce)
        expect(isProcessAlive(workerPid)).toBe(true)

        const supervisor2Res = runCli(['start', '--state-dir', stateDir])
        expect(supervisor2Res.status).toBe(1)
        expect(supervisor2Res.stderr).toMatch(ARABIC_REGEX)

        expect(isProcessAlive(workerPid!)).toBe(true)
      },
      60000,
    )

    it(
      'CHK-M3-06-e: restart against fresh active lease is refused with exit 1 and Arabic error regardless of takeover flag, leaving worker untouched',
      async () => {
        const { stateDir, dbPath } = createInitializedProject('m3-06-e-fresh-')

        // Seed an identifiable live worker process and DB records
        const workerNonce = `fresh-refusal-nonce-${randomUUID()}`
        activeNonces.add(workerNonce)
        const workerChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', workerNonce], {
          stdio: 'ignore',
          windowsHide: true,
        })
        const workerPid = workerChild.pid!
        expect(isProcessAlive(workerPid)).toBe(true)

        const now = Date.now()
        const db = openStore(dbPath)
        try {
          const project = db.prepare('SELECT id FROM projects').get() as { id: string }
          const nowIso = new Date(now).toISOString()
          db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c-fresh', ?, 'task.create', '{\"title\":\"Fresh Task\"}', ?)").run(project.id, nowIso)
          db.prepare("INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at) VALUES ('c-fresh', 'applied', NULL, 1, ?)").run(nowIso)
          db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES ('task-fresh', ?, 'c-fresh', 'Fresh Task', 'progress', ?, ?)").run(project.id, nowIso, nowIso)
          db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation, started_at) VALUES ('att-fresh', 'task-fresh', 1, 'running', 1, ?)").run(nowIso)
          db.prepare("INSERT INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at) VALUES ('att-fresh', ?, ?, 'running', ?, ?, ?)").run(
            workerNonce,
            workerPid,
            join(stateDir, 'worktrees', 'task-fresh'),
            now,
            nowIso,
          )
          db.prepare("UPDATE supervisor_lease SET owner_id = 'fresh-owner', generation = 1, heartbeat_ms = ?, status = 'active' WHERE id = 1").run(now)
        } finally {
          db.close()
        }

        try {
          const resNoTakeover = runCli(['start', '--state-dir', stateDir, '--stale-after-ms', '300000'])
          expect(resNoTakeover.status).toBe(1)
          expect(resNoTakeover.stderr).toMatch(ARABIC_REGEX)

          const resWithTakeover = runCli([
            'start',
            '--state-dir',
            stateDir,
            '--takeover',
            `fresh-owner:1:${now}`,
            '--stale-after-ms',
            '300000',
          ])
          expect(resWithTakeover.status).toBe(1)
          expect(resWithTakeover.stderr).toMatch(ARABIC_REGEX)

          // Verify seeded worker remains untouched on refusal
          expect(isProcessAlive(workerPid)).toBe(true)

          const dbAfter = openStore(dbPath)
          try {
            const w = dbAfter.prepare('SELECT state FROM workers WHERE attempt_id = ?').get('att-fresh') as { state: string }
            expect(w.state).toBe('running')
            const a = dbAfter.prepare('SELECT status FROM attempts WHERE id = ?').get('att-fresh') as { status: string }
            expect(a.status).toBe('running')
          } finally {
            dbAfter.close()
          }
        } finally {
          if (workerChild.pid && isProcessAlive(workerChild.pid)) {
            if (process.platform === 'win32') {
              spawnSync('taskkill', ['/F', '/PID', String(workerChild.pid)], { timeout: 5000, windowsHide: true })
            } else {
              workerChild.kill('SIGKILL')
            }
          }
        }
      },
      60000,
    )

    it(
      'CHK-M3-06-e: restart against stale lease with mismatched or altered takeover evidence is refused with exit 1 and Arabic error, leaving worker untouched',
      async () => {
        const { stateDir, dbPath } = createInitializedProject('m3-06-e-stale-mismatch-')

        // Seed an identifiable live worker process and DB records
        const workerNonce = `mismatch-refusal-nonce-${randomUUID()}`
        activeNonces.add(workerNonce)
        const workerChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', workerNonce], {
          stdio: 'ignore',
          windowsHide: true,
        })
        const workerPid = workerChild.pid!
        expect(isProcessAlive(workerPid)).toBe(true)

        const staleTime = 1000
        const db = openStore(dbPath)
        try {
          const project = db.prepare('SELECT id FROM projects').get() as { id: string }
          const nowIso = '2026-11-10T00:00:00.000Z'
          db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c-mismatch', ?, 'task.create', '{\"title\":\"Mismatch Task\"}', ?)").run(project.id, nowIso)
          db.prepare("INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at) VALUES ('c-mismatch', 'applied', NULL, 1, ?)").run(nowIso)
          db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES ('task-mismatch', ?, 'c-mismatch', 'Mismatch Task', 'progress', ?, ?)").run(project.id, nowIso, nowIso)
          db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation, started_at) VALUES ('att-mismatch', 'task-mismatch', 1, 'running', 1, ?)").run(nowIso)
          db.prepare("INSERT INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at) VALUES ('att-mismatch', ?, ?, 'running', ?, ?, ?)").run(
            workerNonce,
            workerPid,
            join(stateDir, 'worktrees', 'task-mismatch'),
            staleTime,
            nowIso,
          )
          db.prepare("UPDATE supervisor_lease SET owner_id = 'stale-owner-1', generation = 2, heartbeat_ms = ?, status = 'active' WHERE id = 1").run(staleTime)
        } finally {
          db.close()
        }

        try {
          const resWrongOwner = runCli([
            'start',
            '--state-dir',
            stateDir,
            '--takeover',
            `wrong-owner-id:2:${staleTime}`,
            '--stale-after-ms',
            '1000',
          ])
          expect(resWrongOwner.status).toBe(1)
          expect(resWrongOwner.stderr).toMatch(ARABIC_REGEX)

          const resWrongGen = runCli([
            'start',
            '--state-dir',
            stateDir,
            '--takeover',
            `stale-owner-1:999:${staleTime}`,
            '--stale-after-ms',
            '1000',
          ])
          expect(resWrongGen.status).toBe(1)
          expect(resWrongGen.stderr).toMatch(ARABIC_REGEX)

          const resWrongHeartbeat = runCli([
            'start',
            '--state-dir',
            stateDir,
            '--takeover',
            `stale-owner-1:2:999999`,
            '--stale-after-ms',
            '1000',
          ])
          expect(resWrongHeartbeat.status).toBe(1)
          expect(resWrongHeartbeat.stderr).toMatch(ARABIC_REGEX)

          // Verify worker is never touched on any refusal
          expect(isProcessAlive(workerPid)).toBe(true)

          const dbAfter = openStore(dbPath)
          try {
            const w = dbAfter.prepare('SELECT state FROM workers WHERE attempt_id = ?').get('att-mismatch') as { state: string }
            expect(w.state).toBe('running')
            const a = dbAfter.prepare('SELECT status FROM attempts WHERE id = ?').get('att-mismatch') as { status: string }
            expect(a.status).toBe('running')
          } finally {
            dbAfter.close()
          }
        } finally {
          if (workerChild.pid && isProcessAlive(workerChild.pid)) {
            if (process.platform === 'win32') {
              spawnSync('taskkill', ['/F', '/PID', String(workerChild.pid)], { timeout: 5000, windowsHide: true })
            } else {
              workerChild.kill('SIGKILL')
            }
          }
        }
      },
      60000,
    )

    it(
      'CHK-M3-06-e: restart against stale lease with exact matching takeover evidence succeeds with exit 0 and touches no worker on refusal',
      async () => {
        const { stateDir, dbPath } = createInitializedProject('m3-06-e-stale-exact-')

        const staleTime = 1000
        const ownerId = randomUUID()
        const generation = 3

        const db = openStore(dbPath)
        try {
          db.prepare("UPDATE supervisor_lease SET owner_id = ?, generation = ?, heartbeat_ms = ?, status = 'active' WHERE id = 1").run(
            ownerId,
            generation,
            staleTime,
          )
        } finally {
          db.close()
        }

        const resExact = runCli([
          'start',
          '--state-dir',
          stateDir,
          '--exit-when-idle',
          '--takeover',
          `${ownerId}:${generation}:${staleTime}`,
          '--stale-after-ms',
          '1000',
        ])
        expect(resExact.error).toBeUndefined()
        expect(resExact.status).toBe(0)

        const dbAfter = openStore(dbPath)
        try {
          const l = dbAfter.prepare('SELECT owner_id, generation, status FROM supervisor_lease WHERE id = 1').get() as {
            owner_id: string
            generation: number
            status: string
          }
          expect(l.generation).toBe(generation + 1)
          expect(l.status).toBe('released')
        } finally {
          dbAfter.close()
        }
      },
      60000,
    )
  })
})
