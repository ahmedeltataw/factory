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
import { afterEach, describe, expect, it } from 'vitest'
import * as recoveryModule from '../../supervisor/src/app/recovery.ts'
import * as outboxModule from '../../supervisor/src/app/outbox.ts'
import {
  runTick,
  type LoopDeps,
} from '../../supervisor/src/app/supervisor-loop.ts'
import { openStore } from '../../supervisor/src/app/store.ts'
import {
  acquireSupervisor,
  type SupervisorLeaseHandle,
} from '../../supervisor/src/app/supervisor-lease.ts'
import { appendCommand } from '../../supervisor/src/app/commands.ts'
import { killTree, parseWindowsProcesses } from '../../supervisor/src/app/process-tree.ts'

interface RecoveryExports {
  RETRY_BASE_MS?: number
  RETRY_MAX_MS?: number
  MAX_ATTEMPTS: number
  reconcileWorkers: typeof recoveryModule.reconcileWorkers
  scheduleAttempt: typeof recoveryModule.scheduleAttempt
}
const recovery = recoveryModule as unknown as RecoveryExports

interface OutboxExports {
  BACKOFF_MS: number
  OUTBOX_BACKOFF_MAX_MS?: number
  MAX_TRIES: number
  runDue: typeof outboxModule.runDue
  createEffectHandlers: typeof outboxModule.createEffectHandlers
  enqueueInTransaction: typeof outboxModule.enqueueInTransaction
}
const outbox = outboxModule as unknown as OutboxExports

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
  getStdout(): string
  getStderr(): string
}

const tempDirs: string[] = []
const activeNonces = new Set<string>()
const spawnedSupervisorChildren: TrackedSupervisorChild[] = []
const activeContexts: TestContext[] = []

function getTempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-cli-cwd-'))
  tempDirs.push(dir)
  return dir
}

function safeRemoveDir(dir: string): void {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (err) {
      if (attempt === 10) throw err
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

function powershell(script: string): string {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; " + script],
    { encoding: 'utf8', timeout: 10000, windowsHide: true },
  )
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr?.trim() || 'PowerShell failed')
  }
  return result.stdout.trim()
}

function isSupervisorProcess(pid: number, marker: string): boolean {
  if (!pid || pid <= 0) return false
  try {
    if (process.platform === 'win32') {
      const script = `$records = @(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -Property ProcessId,ParentProcessId,CreationDate,CommandLine | ForEach-Object {
        $command = if ($null -eq $_.CommandLine) { '' } else { [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($_.CommandLine)) }
        @{ ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId; CreationDate = $_.CreationDate.ToUniversalTime().Ticks.ToString(); CommandLine = $command }
      }); ConvertTo-Json -InputObject $records -Compress`
      const procs = parseWindowsProcesses(powershell(script), pid)
      return procs[0]?.command?.includes(marker) ?? false
    } else {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      return cmd.includes(marker)
    }
  } catch {
    return false
  }
}

async function waitForProcessDeath(pid: number, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await delay(50)
  }
  return !isProcessAlive(pid)
}

async function killSupervisorSafely(item: TrackedSupervisorChild, timeoutMs = 15000): Promise<void> {
  const { child, marker, pid } = item
  if (!pid || !isProcessAlive(pid)) return
  if (!isSupervisorProcess(pid, marker)) {
    throw new Error(`Supervisor PID ${pid} does not match marker ${marker} (possible PID reuse); refusing to kill`)
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
      timeout: 10000,
      stdio: 'ignore',
      windowsHide: true,
    })
  } else {
    child.kill('SIGKILL')
  }
  const dead = await waitForProcessDeath(pid, timeoutMs)
  if (!dead) {
    throw new Error(`Supervisor process PID ${pid} failed to terminate within ${timeoutMs}ms`)
  }
}

async function killSupervisorOnly(item: TrackedSupervisorChild, timeoutMs = 15000): Promise<void> {
  const { child, marker, pid } = item
  if (!pid || !isProcessAlive(pid)) return
  if (!isSupervisorProcess(pid, marker)) {
    throw new Error(`Supervisor PID ${pid} does not match marker ${marker} (possible PID reuse); refusing to kill`)
  }
  if (process.platform === 'win32') {
    // Kill ONLY the supervisor process without /T so child executor & grandchild orphans survive
    spawnSync('taskkill', ['/F', '/PID', String(pid)], {
      timeout: 10000,
      stdio: 'ignore',
      windowsHide: true,
    })
  } else {
    child.kill('SIGKILL')
  }
  const dead = await waitForProcessDeath(pid, timeoutMs)
  if (!dead) {
    throw new Error(`Supervisor process PID ${pid} failed to terminate within ${timeoutMs}ms`)
  }
}

function processesWithNonces(nonces: string[]): Array<{ pid: number; nonce: string }> {
  if (!nonces.length) return []
  if (process.platform === 'win32') {
    const query = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; $p=@(Get-CimInstance Win32_Process -Property ProcessId,CommandLine | Where-Object { $_.CommandLine } | ForEach-Object { @{ ProcessId = $_.ProcessId; CommandLine = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($_.CommandLine)) } }); ConvertTo-Json -InputObject $p -Compress"],
    { encoding: 'utf8', timeout: 10000, windowsHide: true })
    if (query.error || query.status !== 0) throw new Error(query.error?.message || query.stderr)
    const rows = JSON.parse(query.stdout) as Array<{ ProcessId: number; CommandLine: string }>
    return rows.flatMap((row) => {
      if (typeof row.CommandLine !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.CommandLine)) throw new Error('Invalid process command')
      const bytes = Buffer.from(row.CommandLine, 'base64')
      if (bytes.length % 2 !== 0 || bytes.toString('base64') !== row.CommandLine) throw new Error('Invalid process command')
      const command = bytes.toString('utf16le')
      return nonces.filter((nonce) => command.includes(nonce)).map((nonce) => ({ pid: row.ProcessId, nonce }))
    })
  }
  const query = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 10000 })
  if (query.error || query.status !== 0) throw new Error(query.error?.message || query.stderr)
  return query.stdout.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/)
    return match ? nonces.filter((nonce) => match[2]!.includes(nonce)).map((nonce) => ({ pid: Number(match[1]), nonce })) : []
  })
}

function findPidsByNonces(nonces: string[]): number[] {
  const validNonces = nonces.filter((n) => typeof n === 'string' && n.trim().length > 0)
  if (validNonces.length === 0) return []
  return Array.from(
    new Set(
      processesWithNonces(validNonces)
        .map((p) => p.pid)
        .filter((pid) => pid !== process.pid),
    ),
  )
}

async function cleanupNonces(nonces: Iterable<string>, timeoutMs = 25000): Promise<void> {
  const nonceList = Array.from(new Set(Array.from(nonces).filter((n) => typeof n === 'string' && n.length > 0)))
  if (nonceList.length === 0) return

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const survivors = findPidsByNonces(nonceList)
    if (survivors.length === 0) break
    for (const pid of survivors) {
      if (pid === process.pid) continue
      for (const n of nonceList) {
        try {
          await killTree(pid, n)
        } catch {
          // ignore individual error
        }
      }
    }
    await delay(150)
  }

  const remaining = findPidsByNonces(nonceList)
  if (remaining.length > 0) {
    throw new Error(
      `Cleanup failed to terminate matching processes for nonces [${nonceList.join(', ')}]. Survivors: ${remaining.join(', ')}`,
    )
  }
  for (const n of nonceList) activeNonces.delete(n)
}

function harvestRunDirectories(stateDir: string): void {
  const runsDir = join(stateDir, 'runs')
  if (!existsSync(runsDir)) return
  for (const entry of readdirSync(runsDir)) {
    const workerJsonPath = join(runsDir, entry, 'worker.json')
    if (existsSync(workerJsonPath)) {
      try {
        const data = JSON.parse(readFileSync(workerJsonPath, 'utf8')) as { nonce?: string }
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

function parseCreatedTaskId(stdout: string): string {
  const match = stdout.match(/^(?:created|duplicate)\s+([0-9a-f-]+)/im)
  const id = match?.[1]
  if (!id) {
    throw new Error(`Failed to parse task ID from output: ${stdout}`)
  }
  return id
}

function runCli(args: string[], options?: { env?: NodeJS.ProcessEnv; cwd?: string; timeout?: number }) {
  const cwd = options?.cwd ?? getTempCwd()
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: options?.timeout ?? 25000,
    windowsHide: true,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      ...options?.env,
    },
  })
  if (res.error && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    throw new Error(`CLI timed out after ${options?.timeout ?? 25000}ms: factory ${args.join(' ')}`)
  }
  return res
}

function spawnCli(
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; cwd?: string },
): TrackedSupervisorChild {
  const marker = `factory-supervisor-${randomUUID()}`
  const cwd = options?.cwd ?? getTempCwd()
  const child = spawn(
    process.execPath,
    [`--title=${marker}`, cliPath, ...args],
    {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        FACTORY_SUPERVISOR_MARKER: marker,
        ...options?.env,
      },
    },
  )

  let stdoutBuffer = ''
  let stderrBuffer = ''
  child.stdout?.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk) => {
    stderrBuffer += chunk.toString('utf8')
  })

  const tracked: TrackedSupervisorChild = {
    child,
    marker,
    pid: child.pid!,
    getStdout: () => stdoutBuffer,
    getStderr: () => stderrBuffer,
  }

  if (child.pid) {
    spawnedSupervisorChildren.push(tracked)
  }
  return tracked
}

function waitForSupervisorExit(
  tracked: TrackedSupervisorChild,
  timeoutMs = 45000,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const { child } = tracked
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve({ exitCode: child.exitCode, stdout: tracked.getStdout(), stderr: tracked.getStderr() })
      return
    }
    const timer = setTimeout(() => {
      reject(new Error(`Supervisor child PID ${child.pid} timed out after ${timeoutMs}ms. Stderr: ${tracked.getStderr()}`))
    }, timeoutMs)

    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code, stdout: tracked.getStdout(), stderr: tracked.getStderr() })
    })
    child.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

function createInitializedProject(prefix = 'factory-m4-retries-'): TestContext {
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
  const errors: string[] = []

  // 1. Terminate all spawned supervisor children
  try {
    const remaining: TrackedSupervisorChild[] = []
    for (const sup of spawnedSupervisorChildren) {
      try {
        await killSupervisorSafely(sup, 10000)
      } catch (err: any) {
        errors.push(`Supervisor cleanup error (PID ${sup.pid}): ${err?.message ?? String(err)}`)
        remaining.push(sup)
      }
    }
    spawnedSupervisorChildren.length = 0
    spawnedSupervisorChildren.push(...remaining)
  } catch (err: any) {
    errors.push(`Supervisor cleanup stage failed: ${err?.message ?? String(err)}`)
  }

  // 2. Harvest worker nonces and terminate workers
  try {
    for (const ctx of activeContexts) {
      harvestRunDirectories(ctx.stateDir)
      harvestDbWorkers(ctx.dbPath)
    }
    await cleanupNonces(activeNonces, 25000)
  } catch (err: any) {
    errors.push(`Worker cleanup stage failed: ${err?.message ?? String(err)}`)
  }

  // 3. Remove fixture directories
  try {
    const dirsToRemove = [...tempDirs]
    for (const dir of dirsToRemove) {
      try {
        safeRemoveDir(dir)
        const idx = tempDirs.indexOf(dir)
        if (idx !== -1) tempDirs.splice(idx, 1)
      } catch (err: any) {
        errors.push(`Dir cleanup error (${dir}): ${err?.message ?? String(err)}`)
      }
    }
  } catch (err: any) {
    errors.push(`Temp dir cleanup stage failed: ${err?.message ?? String(err)}`)
  }

  activeContexts.length = 0

  if (errors.length > 0) {
    throw new Error(`Cleanup failed:\n${errors.join('\n')}`)
  }
}, 90000)

describe('M4-05: Retries, timeouts, outbox backoff and SQLITE_BUSY', () => {
  describe('CHK-M4-05-a: transient retry (code 75) up to max-attempts with exponential backoff', () => {
    it(
      'CHK-M4-05-a: FAKE_FAIL_UNTIL_ATTEMPT=2 with --max-attempts 3 retries transient exits and succeeds on attempt 3 with backoff',
      async () => {
        const { stateDir, dbPath } = createInitializedProject('m4-05-a-real-')

        const createRes = runCli([
          'task',
          'create',
          '--state-dir',
          stateDir,
          '--title',
          'Transient Retry Task',
          '--scope',
          'task-a-real',
          '--max-attempts',
          '3',
        ])
        expect(createRes.status).toBe(0)
        const taskId = parseCreatedTaskId(createRes.stdout)

        const supChild = spawnCli(['start', '--state-dir', stateDir, '--exit-when-idle'], {
          env: {
            FAKE_FAIL_UNTIL_ATTEMPT: '2',
            FAKE_FAIL_CODE: '75',
          },
        })

        const res = await waitForSupervisorExit(supChild, 45000)
        expect(res.exitCode).toBe(0)

        const db = openStore(dbPath)
        try {
          const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as {
            status: string
          }
          expect(task.status).toBe('done')

          const attempts = db.prepare(
            'SELECT attempt_no, status, error_class, exit_code, started_at FROM attempts WHERE task_id = ? ORDER BY attempt_no ASC',
          ).all(taskId) as Array<{
            attempt_no: number
            status: string
            error_class: string
            exit_code: number
            started_at: string
          }>

          expect(attempts.length).toBe(3)
          expect(attempts[0]?.attempt_no).toBe(1)
          expect(attempts[0]?.status).toBe('failed')
          expect(attempts[0]?.error_class).toBe('transient')
          expect(attempts[0]?.exit_code).toBe(75)

          expect(attempts[1]?.attempt_no).toBe(2)
          expect(attempts[1]?.status).toBe('failed')
          expect(attempts[1]?.error_class).toBe('transient')
          expect(attempts[1]?.exit_code).toBe(75)

          expect(attempts[2]?.attempt_no).toBe(3)
          expect(attempts[2]?.status).toBe('succeeded')
          expect(attempts[2]?.exit_code).toBe(0)

          const t1 = Date.parse(attempts[0]!.started_at)
          const t2 = Date.parse(attempts[1]!.started_at)
          const t3 = Date.parse(attempts[2]!.started_at)

          expect(t2 - t1).toBeGreaterThanOrEqual(1000)
          expect(t3 - t2).toBeGreaterThanOrEqual(2000)

          // Task-wide evidence assertion: exactly 1 evidence row across all attempts
          const evCountTask = (
            db.prepare('SELECT COUNT(*) as c FROM evidence WHERE attempt_id IN (SELECT id FROM attempts WHERE task_id = ?)').get(taskId) as { c: number }
          ).c
          expect(evCountTask).toBe(1)

          // Transient attempts 1 and 2 must have zero evidence rows
          for (let i = 0; i < 2; i++) {
            const evCountAttempt = (
              db.prepare('SELECT COUNT(*) as c FROM evidence WHERE attempt_id = ?').get(
                (db.prepare('SELECT id FROM attempts WHERE task_id = ? AND attempt_no = ?').get(taskId, i + 1) as { id: string }).id,
              ) as { c: number }
            ).c
            expect(evCountAttempt).toBe(0)
          }
        } finally {
          db.close()
        }
      },
      60000,
    )

    it(
      'CHK-M4-05-a: (in-process controlled clock) verifies exact not_before_ms schedule and dispatch gating',
      async () => {
        expect(recovery.RETRY_BASE_MS).toBe(1000)
        expect(recovery.RETRY_MAX_MS).toBe(60000)

        const { stateDir, dbPath, repoDir, baseSha } = createInitializedProject('m4-05-a-inproc-')
        const db = openStore(dbPath)
        let handle: SupervisorLeaseHandle | undefined

        try {
          let nowMs = 10000
          handle = acquireSupervisor(db, stateDir, { nowMs, staleAfterMs: 1000 })

          const project = db.prepare('SELECT project_id FROM project_config LIMIT 1').get() as { project_id: string }
          const taskId = randomUUID()
          appendCommand(db, {
            id: taskId,
            projectId: project.project_id,
            kind: 'task.create',
            payloadJson: JSON.stringify({ title: 'In-process Backoff Task', scope: ['inproc-a'], maxAttempts: 3, timeoutMs: null }),
            createdAt: new Date(nowMs).toISOString(),
          })
          db.prepare('UPDATE tasks SET max_attempts = 3, not_before_ms = 0, scope_json = ? WHERE id = ?').run(JSON.stringify(['inproc-a']), taskId)

          let attemptCount = 0
          let workerAlive = false

          const loopDeps: LoopDeps = {
            config: { stateDir, repoPath: repoDir, baseRef: baseSha },
            stateDir,
            killTree: async () => ({ result: 'killed' }),
            isAlive: () => workerAlive,
            readResult: () => ({ exitCode: attemptCount <= 2 ? 75 : 0 }),
            spawnWorker: async ({ runDir, cwd, attemptId }) => {
              attemptCount++
              workerAlive = true
              const pid = 7000 + attemptCount
              const nonce = `inproc-nonce-${attemptCount}-${randomUUID().slice(0, 6)}`
              mkdirSync(runDir, { recursive: true })
              writeFileSync(
                join(runDir, 'worker.json'),
                JSON.stringify({ pid, nonce, grandchildPid: pid + 100 }),
                'utf8',
              )
              if (attemptCount === 3) {
                const subDir = join(cwd, 'inproc-a')
                mkdirSync(subDir, { recursive: true })
                writeFileSync(join(subDir, 'output.txt'), `completed by ${attemptId}\n`, 'utf8')
                writeFileSync(join(runDir, 'stdout.log'), 'simulated executor stdout\n', 'utf8')
                writeFileSync(join(runDir, 'stderr.log'), '', 'utf8')
              }
              return { pid, nonce }
            },
          }

          // Step 1: dispatch attempt 1 at nowMs = 10000 (worker becomes alive)
          await runTick(db, handle, loopDeps, nowMs)
          expect(attemptCount).toBe(1)

          // Advance to 10100 and worker finishes with exitCode 75
          nowMs = 10100
          workerAlive = false
          await runTick(db, handle, loopDeps, nowMs)

          const taskAfter1 = db.prepare('SELECT status, not_before_ms FROM tasks WHERE id = ?').get(taskId) as {
            status: string
            not_before_ms: number
          }
          expect(taskAfter1.status).toBe('ready')
          expect(taskAfter1.not_before_ms).toBe(10100 + 1000) // k=1 -> min(1000 * 2^0, 60000) = 1000

          // Tick before backoff expires (11050 < 11100) -> must NOT schedule attempt 2
          await runTick(db, handle, loopDeps, 11050)
          expect(attemptCount).toBe(1)

          // Tick at backoff expiration (nowMs = 11100 >= 11100) -> schedules attempt 2
          nowMs = 11100
          await runTick(db, handle, loopDeps, nowMs)
          expect(attemptCount).toBe(2)

          // Finish attempt 2 with exitCode 75 at nowMs = 11200
          nowMs = 11200
          workerAlive = false
          await runTick(db, handle, loopDeps, nowMs)

          const taskAfter2 = db.prepare('SELECT status, not_before_ms FROM tasks WHERE id = ?').get(taskId) as {
            status: string
            not_before_ms: number
          }
          expect(taskAfter2.status).toBe('ready')
          expect(taskAfter2.not_before_ms).toBe(11200 + 2000) // k=2 -> min(1000 * 2^1, 60000) = 2000

          // Tick before backoff expires (13100 < 13200) -> must NOT schedule attempt 3
          await runTick(db, handle, loopDeps, 13100)
          expect(attemptCount).toBe(2)

          // Tick at backoff expiration (nowMs = 13200) -> schedules attempt 3
          nowMs = 13200
          await runTick(db, handle, loopDeps, nowMs)
          expect(attemptCount).toBe(3)

          // Finish attempt 3 with exitCode 0 at nowMs = 13300
          nowMs = 13300
          workerAlive = false
          await runTick(db, handle, loopDeps, nowMs)

          const taskAfter3 = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as {
            status: string
          }
          expect(taskAfter3.status).toBe('done')

          // Task-wide evidence assertion: exactly 1
          const evCount = (
            db.prepare('SELECT COUNT(*) as c FROM evidence WHERE attempt_id IN (SELECT id FROM attempts WHERE task_id = ?)').get(taskId) as { c: number }
          ).c
          expect(evCount).toBe(1)
        } finally {
          if (handle) handle.release(50000)
          db.close()
        }
      },
    )
  })

  describe('CHK-M4-05-b: attempt budget exhaustion and task retry resumption', () => {
    it(
      'CHK-M4-05-b: FAKE_FAIL_UNTIL_ATTEMPT=2 with --max-attempts 2 exhausts budget, task fails, task retry resets attempt_base and attempt 3 succeeds',
      async () => {
        const { stateDir, dbPath } = createInitializedProject('m4-05-b-retry-')

        const createRes = runCli([
          'task',
          'create',
          '--state-dir',
          stateDir,
          '--title',
          'Budget Exhaustion Task',
          '--scope',
          'task-b-real',
          '--max-attempts',
          '2',
        ])
        expect(createRes.status).toBe(0)
        const taskId = parseCreatedTaskId(createRes.stdout)

        // 1. Initial supervisor run with max-attempts 2: exhausts 2 attempts and exits when idle
        const supChild1 = spawnCli(['start', '--state-dir', stateDir, '--exit-when-idle'], {
          env: {
            FAKE_FAIL_UNTIL_ATTEMPT: '2',
            FAKE_FAIL_CODE: '75',
          },
        })

        const res1 = await waitForSupervisorExit(supChild1, 45000)
        expect(res1.exitCode).toBe(0)

        const db1 = openStore(dbPath)
        try {
          const task1 = db1.prepare('SELECT status, attempt_base FROM tasks WHERE id = ?').get(taskId) as {
            status: string
            attempt_base: number
          }
          expect(task1.status).toBe('failed')
          expect(task1.attempt_base).toBe(0)

          const attempts1 = db1.prepare(
            'SELECT attempt_no, status, error_class, exit_code FROM attempts WHERE task_id = ? ORDER BY attempt_no ASC',
          ).all(taskId) as Array<{ attempt_no: number; status: string; error_class: string; exit_code: number }>

          expect(attempts1.length).toBe(2)
          expect(attempts1[0]?.status).toBe('failed')
          expect(attempts1[0]?.error_class).toBe('transient')
          expect(attempts1[0]?.exit_code).toBe(75)

          expect(attempts1[1]?.status).toBe('failed')
          expect(attempts1[1]?.error_class).toBe('transient')
          expect(attempts1[1]?.exit_code).toBe(75)

          // Task-wide evidence must be 0
          const evCount1 = (
            db1.prepare('SELECT COUNT(*) as c FROM evidence WHERE attempt_id IN (SELECT id FROM attempts WHERE task_id = ?)').get(taskId) as { c: number }
          ).c
          expect(evCount1).toBe(0)
        } finally {
          db1.close()
        }

        // 2. Execute `factory task retry` CLI (only appends command)
        const retryRes = runCli(['task', 'retry', '--state-dir', stateDir, '--task', taskId])
        expect(retryRes.status).toBe(0)
        expect(retryRes.stdout).toMatch(/^(?:created|duplicate)\s+[0-9a-f-]+/im)

        // Verify command row exists in commands table with kind task.retry
        const db2 = openStore(dbPath)
        try {
          const cmdRow = db2.prepare("SELECT kind, payload_json FROM commands WHERE kind = 'task.retry'").get() as {
            kind: string
            payload_json: string
          } | undefined
          expect(cmdRow).toBeDefined()
          expect(JSON.parse(cmdRow!.payload_json)).toEqual({ taskId })
        } finally {
          db2.close()
        }

        // 3. Restart supervisor: applies the retry command and runs attempt 3
        const supChild2 = spawnCli(['start', '--state-dir', stateDir, '--exit-when-idle'], {
          env: {
            FAKE_FAIL_UNTIL_ATTEMPT: '2',
            FAKE_FAIL_CODE: '75',
          },
        })

        const res2 = await waitForSupervisorExit(supChild2, 45000)
        expect(res2.exitCode).toBe(0)

        const db3 = openStore(dbPath)
        try {
          const taskFinal = db3.prepare('SELECT status, attempt_base, not_before_ms FROM tasks WHERE id = ?').get(taskId) as {
            status: string
            attempt_base: number
            not_before_ms: number
          }
          expect(taskFinal.status).toBe('done')
          expect(taskFinal.attempt_base).toBe(2)
          expect(taskFinal.not_before_ms).toBe(0)

          const attempts3 = db3.prepare(
            'SELECT attempt_no, status, exit_code FROM attempts WHERE task_id = ? ORDER BY attempt_no ASC',
          ).all(taskId) as Array<{ attempt_no: number; status: string; exit_code: number }>

          expect(attempts3.length).toBe(3)
          expect(attempts3[2]?.attempt_no).toBe(3)
          expect(attempts3[2]?.status).toBe('succeeded')
          expect(attempts3[2]?.exit_code).toBe(0)

          // Task-wide evidence: exactly 1
          const evCountFinal = (
            db3.prepare('SELECT COUNT(*) as c FROM evidence WHERE attempt_id IN (SELECT id FROM attempts WHERE task_id = ?)').get(taskId) as { c: number }
          ).c
          expect(evCountFinal).toBe(1)
        } finally {
          db3.close()
        }
      },
      60000,
    )
  })

  describe('CHK-M4-05-c: timeout handling and non-retryable non-zero exit', () => {
    it(
      'CHK-M4-05-c: FAKE_HANG=1 with --timeout-ms 1000 --max-attempts 2 kills workers on deadline and exhausts budget without leaks',
      async () => {
        const { stateDir, dbPath } = createInitializedProject('m4-05-c-timeout-')

        const createRes = runCli([
          'task',
          'create',
          '--state-dir',
          stateDir,
          '--title',
          'Timeout Task',
          '--scope',
          'task-c-hang',
          '--timeout-ms',
          '1000',
          '--max-attempts',
          '2',
        ])
        expect(createRes.status).toBe(0)
        const taskId = parseCreatedTaskId(createRes.stdout)

        const supChild = spawnCli(['start', '--state-dir', stateDir, '--exit-when-idle'], {
          env: {
            FAKE_HANG: '1',
          },
        })

        const res = await waitForSupervisorExit(supChild, 45000)
        expect(res.exitCode).toBe(0)

        const db = openStore(dbPath)
        try {
          const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as {
            status: string
          }
          expect(task.status).toBe('failed')

          const attempts = db.prepare(
            'SELECT attempt_no, status, error_class, deadline_ms FROM attempts WHERE task_id = ? ORDER BY attempt_no ASC',
          ).all(taskId) as Array<{ attempt_no: number; status: string; error_class: string; deadline_ms: number }>

          expect(attempts.length).toBe(2)
          expect(attempts[0]?.status).toBe('interrupted')
          expect(attempts[0]?.error_class).toBe('timeout')
          expect(attempts[0]?.deadline_ms).toBeGreaterThan(0)

          expect(attempts[1]?.status).toBe('interrupted')
          expect(attempts[1]?.error_class).toBe('timeout')
          expect(attempts[1]?.deadline_ms).toBeGreaterThan(0)

          const workers = db.prepare(
            'SELECT state FROM workers WHERE attempt_id IN (SELECT id FROM attempts WHERE task_id = ?)',
          ).all(taskId) as Array<{ state: string }>

          expect(workers.length).toBe(2)
          for (const w of workers) {
            expect(w.state).toBe('killed')
          }

          // Task-wide evidence must be 0
          const evCount = (
            db.prepare('SELECT COUNT(*) as c FROM evidence WHERE attempt_id IN (SELECT id FROM attempts WHERE task_id = ?)').get(taskId) as { c: number }
          ).c
          expect(evCount).toBe(0)

          // Confirm no orphan executor or grandchild process survived for harvested nonces
          harvestRunDirectories(stateDir)
          harvestDbWorkers(dbPath)
          const survivors = findPidsByNonces(Array.from(activeNonces))
          expect(survivors).toEqual([])
        } finally {
          db.close()
        }
      },
      60000,
    )

    it(
      'CHK-M4-05-c: non-75 non-zero exit fails immediately with error_class exit and is not retried',
      async () => {
        const { stateDir, dbPath } = createInitializedProject('m4-05-c-exit-')

        const createRes = runCli([
          'task',
          'create',
          '--state-dir',
          stateDir,
          '--title',
          'Exit Code 42 Task',
          '--scope',
          'task-c-exit',
          '--max-attempts',
          '3',
        ])
        expect(createRes.status).toBe(0)
        const taskId = parseCreatedTaskId(createRes.stdout)

        const supChild = spawnCli(['start', '--state-dir', stateDir, '--exit-when-idle'], {
          env: {
            FAKE_EXIT_CODE: '42',
          },
        })

        const res = await waitForSupervisorExit(supChild, 45000)
        expect(res.exitCode).toBe(0)

        const db = openStore(dbPath)
        try {
          const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as {
            status: string
          }
          expect(task.status).toBe('failed')

          const attempts = db.prepare(
            'SELECT attempt_no, status, error_class, exit_code FROM attempts WHERE task_id = ?',
          ).all(taskId) as Array<{ attempt_no: number; status: string; error_class: string; exit_code: number }>

          expect(attempts.length).toBe(1)
          expect(attempts[0]?.attempt_no).toBe(1)
          expect(attempts[0]?.status).toBe('failed')
          expect(attempts[0]?.error_class).toBe('exit')
          expect(attempts[0]?.exit_code).toBe(42)

          const evCount = (
            db.prepare('SELECT COUNT(*) as c FROM evidence WHERE attempt_id IN (SELECT id FROM attempts WHERE task_id = ?)').get(taskId) as { c: number }
          ).c
          expect(evCount).toBe(0)
        } finally {
          db.close()
        }
      },
      60000,
    )

    it(
      'CHK-M4-05-c: (in-process controlled clock) verifies worker killed strictly when nowMs >= deadline_ms with retry cap',
      async () => {
        const { stateDir, dbPath, repoDir, baseSha } = createInitializedProject('m4-05-c-inproc-')
        const db = openStore(dbPath)
        let handle: SupervisorLeaseHandle | undefined

        try {
          let nowMs = 5000
          handle = acquireSupervisor(db, stateDir, { nowMs, staleAfterMs: 1000 })

          const project = db.prepare('SELECT project_id FROM project_config LIMIT 1').get() as { project_id: string }
          const taskId = randomUUID()
          appendCommand(db, {
            id: taskId,
            projectId: project.project_id,
            kind: 'task.create',
            payloadJson: JSON.stringify({ title: 'Deadline In-process', scope: ['inproc-c-timeout'], timeoutMs: 1500, maxAttempts: 2 }),
            createdAt: new Date(nowMs).toISOString(),
          })
          db.prepare('UPDATE tasks SET timeout_ms = 1500, max_attempts = 2, scope_json = ? WHERE id = ?').run(JSON.stringify(['inproc-c-timeout']), taskId)

          let spawnCounter = 0
          const liveWorkers = new Map<number, { nonce: string }>()
          const killedPids = new Set<number>()

          const loopDeps: LoopDeps = {
            config: { stateDir, repoPath: repoDir, baseRef: baseSha },
            stateDir,
            killTree: async (pid, nonce) => {
              const record = liveWorkers.get(pid)
              if (record && record.nonce === nonce) {
                liveWorkers.delete(pid)
                killedPids.add(pid)
                return { result: 'killed' }
              }
              return { result: 'not-running' }
            },
            isAlive: (pid, nonce) => {
              const record = liveWorkers.get(pid)
              return Boolean(record && record.nonce === nonce)
            },
            readResult: () => undefined,
            spawnWorker: async ({ runDir }) => {
              spawnCounter++
              const pid = 8800 + spawnCounter
              const nonce = `inproc-hang-${spawnCounter}-${randomUUID().slice(0, 6)}`
              liveWorkers.set(pid, { nonce })
              mkdirSync(runDir, { recursive: true })
              writeFileSync(
                join(runDir, 'worker.json'),
                JSON.stringify({ pid, nonce, grandchildPid: pid + 100 }),
                'utf8',
              )
              return { pid, nonce }
            },
          }

          // Step 1: dispatch attempt 1 at nowMs = 5000 -> deadline_ms = 5000 + 1500 = 6500
          await runTick(db, handle, loopDeps, nowMs)

          const attempt1 = db.prepare('SELECT status, deadline_ms FROM attempts WHERE task_id = ? AND attempt_no = 1').get(taskId) as {
            status: string
            deadline_ms: number
          }
          expect(attempt1.status).toBe('running')
          expect(attempt1.deadline_ms).toBe(6500)

          // Tick before deadline (nowMs = 6499 < 6500) -> worker remains alive
          await runTick(db, handle, loopDeps, 6499)
          expect(killedPids.has(8801)).toBe(false)

          // Tick at deadline (nowMs = 6500 >= 6500) -> worker killed, attempt interrupted/timeout
          await runTick(db, handle, loopDeps, 6500)
          expect(killedPids.has(8801)).toBe(true)

          const attempt1After = db.prepare('SELECT status, error_class FROM attempts WHERE task_id = ? AND attempt_no = 1').get(taskId) as {
            status: string
            error_class: string
          }
          expect(attempt1After.status).toBe('interrupted')
          expect(attempt1After.error_class).toBe('timeout')

          const taskAfter1 = db.prepare('SELECT status, not_before_ms FROM tasks WHERE id = ?').get(taskId) as {
            status: string
            not_before_ms: number
          }
          expect(taskAfter1.status).toBe('ready')
          expect(taskAfter1.not_before_ms).toBe(6500 + 1000)

          // Advance to not_before_ms (7500), dispatch attempt 2
          await runTick(db, handle, loopDeps, 7500)

          const attempt2 = db.prepare('SELECT status, deadline_ms FROM attempts WHERE task_id = ? AND attempt_no = 2').get(taskId) as {
            status: string
            deadline_ms: number
          }
          expect(attempt2.status).toBe('running')
          expect(attempt2.deadline_ms).toBe(7500 + 1500) // 9000

          // Advance past deadline of attempt 2 (9000) -> attempt 2 killed and budget exhausted (max_attempts = 2)
          await runTick(db, handle, loopDeps, 9000)
          expect(killedPids.has(8802)).toBe(true)
          expect(liveWorkers.size).toBe(0)

          const taskFinal = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }
          expect(taskFinal.status).toBe('failed')
        } finally {
          if (handle) handle.release(50000)
          db.close()
        }
      },
    )

    it(
      'CHK-M4-05-c: (in-process controlled clock) verifies killTree branches: not-running, identity-mismatch, and kill-failed',
      async () => {
        // Branch A: killTree returns not-running -> handled as normal completion via readResult, completes evidence
        {
          const { stateDir, dbPath, repoDir, baseSha } = createInitializedProject('m4-05-c-branch-a-')
          const db = openStore(dbPath)
          let handle: SupervisorLeaseHandle | undefined

          try {
            let nowMs = 10000
            handle = acquireSupervisor(db, stateDir, { nowMs, staleAfterMs: 1000 })
            const project = db.prepare('SELECT project_id FROM project_config LIMIT 1').get() as { project_id: string }
            const taskIdA = randomUUID()
            appendCommand(db, {
              id: taskIdA,
              projectId: project.project_id,
              kind: 'task.create',
              payloadJson: JSON.stringify({ title: 'Branch A', scope: ['branch-a'], timeoutMs: 1000, maxAttempts: 2 }),
              createdAt: new Date(nowMs).toISOString(),
            })

            const loopDepsA: LoopDeps = {
              config: { stateDir, repoPath: repoDir, baseRef: baseSha },
              stateDir,
              killTree: async (pid, nonce) => {
                if (pid === 9001 && nonce === 'nonce-a') {
                  return { result: 'not-running' }
                }
                return { result: 'not-running' }
              },
              isAlive: () => true,
              readResult: () => ({ exitCode: 0 }),
              spawnWorker: async ({ runDir, cwd, attemptId }) => {
                const subDir = join(cwd, 'branch-a')
                mkdirSync(subDir, { recursive: true })
                writeFileSync(join(subDir, 'output.txt'), `completed by ${attemptId}\n`, 'utf8')
                mkdirSync(runDir, { recursive: true })
                writeFileSync(join(runDir, 'worker.json'), JSON.stringify({ pid: 9001, nonce: 'nonce-a', grandchildPid: 9101 }), 'utf8')
                writeFileSync(join(runDir, 'stdout.log'), 'branch A success\n', 'utf8')
                writeFileSync(join(runDir, 'stderr.log'), '', 'utf8')
                return { pid: 9001, nonce: 'nonce-a' }
              },
            }

            await runTick(db, handle, loopDepsA, nowMs)
            nowMs += 1000
            // Deadline reached: killTree returns not-running -> normal completion handling runs, commits evidence
            await runTick(db, handle, loopDepsA, nowMs)

            // Assert attempt success, worker exit, and evidence completion
            const attemptA = db.prepare('SELECT status, exit_code FROM attempts WHERE task_id = ?').get(taskIdA) as {
              status: string
              exit_code: number | null
            }
            expect(attemptA.status).toBe('succeeded')
            expect(attemptA.exit_code).toBe(0)

            const workerA = db.prepare('SELECT state FROM workers WHERE attempt_id IN (SELECT id FROM attempts WHERE task_id = ?)').get(taskIdA) as { state: string }
            expect(workerA.state).toBe('exited')

            const taskA = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskIdA) as { status: string }
            expect(taskA.status).toBe('done')

            const evCountA = (
              db.prepare('SELECT COUNT(*) as c FROM evidence WHERE attempt_id IN (SELECT id FROM attempts WHERE task_id = ?)').get(taskIdA) as { c: number }
            ).c
            expect(evCountA).toBe(1)
          } finally {
            if (handle) handle.release(50000)
            db.close()
          }
        }

        // Branch B: killTree returns identity-mismatch -> worker marked lost, attempt interrupted
        {
          const { stateDir, dbPath, repoDir, baseSha } = createInitializedProject('m4-05-c-branch-b-')
          const db = openStore(dbPath)
          let handle: SupervisorLeaseHandle | undefined

          try {
            let nowMs = 20000
            handle = acquireSupervisor(db, stateDir, { nowMs, staleAfterMs: 1000 })
            const project = db.prepare('SELECT project_id FROM project_config LIMIT 1').get() as { project_id: string }
            const taskIdB = randomUUID()
            appendCommand(db, {
              id: taskIdB,
              projectId: project.project_id,
              kind: 'task.create',
              payloadJson: JSON.stringify({ title: 'Branch B', scope: ['branch-b'], timeoutMs: 1000, maxAttempts: 2 }),
              createdAt: new Date(nowMs).toISOString(),
            })

            let spawnCountB = 0
            const spawnedNoncesB = new Set<string>()
            const loopDepsB: LoopDeps = {
              config: { stateDir, repoPath: repoDir, baseRef: baseSha },
              stateDir,
              killTree: async (pid, nonce) => {
                if (pid === 9002 && spawnedNoncesB.has(nonce)) {
                  return { result: 'identity-mismatch', detail: 'simulated identity mismatch' }
                }
                return { result: 'not-running' }
              },
              isAlive: (pid, nonce) => pid === 9002 && spawnedNoncesB.has(nonce),
              readResult: () => undefined,
              spawnWorker: async ({ runDir, attemptId }) => {
                spawnCountB++
                const nonce = `nonce-b-${attemptId}`
                spawnedNoncesB.add(nonce)
                mkdirSync(runDir, { recursive: true })
                writeFileSync(join(runDir, 'worker.json'), JSON.stringify({ pid: 9002, nonce, grandchildPid: 9102 }), 'utf8')
                return { pid: 9002, nonce }
              },
            }

            await runTick(db, handle, loopDepsB, nowMs)
            nowMs += 1000
            await runTick(db, handle, loopDepsB, nowMs)

            const workerB = db.prepare('SELECT state FROM workers WHERE attempt_id IN (SELECT id FROM attempts WHERE task_id = ? AND attempt_no = 1)').get(taskIdB) as { state: string }
            expect(workerB.state).toBe('lost')

            const attemptB = db.prepare('SELECT status, error_class FROM attempts WHERE task_id = ? AND attempt_no = 1').get(taskIdB) as {
              status: string
              error_class: string
            }
            expect(attemptB.status).toBe('interrupted')
            expect(attemptB.error_class).toBe('timeout')

            const taskB = db.prepare('SELECT status, not_before_ms FROM tasks WHERE id = ?').get(taskIdB) as {
              status: string
              not_before_ms: number
            }
            expect(taskB.status).toBe('ready')
            expect(taskB.not_before_ms).toBe(nowMs + 1000)

            // Advance to not_before_ms (22000) to dispatch attempt 2, then to its deadline (23000) to exhaust budget
            nowMs = taskB.not_before_ms
            await runTick(db, handle, loopDepsB, nowMs)

            const attemptB2Running = db.prepare('SELECT status, deadline_ms FROM attempts WHERE task_id = ? AND attempt_no = 2').get(taskIdB) as {
              status: string
              deadline_ms: number
            }
            expect(attemptB2Running.status).toBe('running')
            expect(attemptB2Running.deadline_ms).toBe(nowMs + 1000)

            nowMs = attemptB2Running.deadline_ms
            await runTick(db, handle, loopDepsB, nowMs)

            const workerB2 = db.prepare('SELECT state FROM workers WHERE attempt_id IN (SELECT id FROM attempts WHERE task_id = ? AND attempt_no = 2)').get(taskIdB) as { state: string }
            expect(workerB2.state).toBe('lost')

            const attemptB2 = db.prepare('SELECT status, error_class FROM attempts WHERE task_id = ? AND attempt_no = 2').get(taskIdB) as {
              status: string
              error_class: string
            }
            expect(attemptB2.status).toBe('interrupted')
            expect(attemptB2.error_class).toBe('timeout')

            const taskBFinal = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskIdB) as { status: string }
            expect(taskBFinal.status).toBe('failed')
          } finally {
            if (handle) handle.release(50000)
            db.close()
          }
        }

        // Branch C: killTree returns kill-failed -> retried next tick, state unchanged
        {
          const { stateDir, dbPath, repoDir, baseSha } = createInitializedProject('m4-05-c-branch-c-')
          const db = openStore(dbPath)
          let handle: SupervisorLeaseHandle | undefined

          try {
            let nowMs = 30000
            handle = acquireSupervisor(db, stateDir, { nowMs, staleAfterMs: 1000 })
            const project = db.prepare('SELECT project_id FROM project_config LIMIT 1').get() as { project_id: string }
            const taskIdC = randomUUID()
            appendCommand(db, {
              id: taskIdC,
              projectId: project.project_id,
              kind: 'task.create',
              payloadJson: JSON.stringify({ title: 'Branch C', scope: ['branch-c'], timeoutMs: 1000, maxAttempts: 2 }),
              createdAt: new Date(nowMs).toISOString(),
            })

            let killAttemptsC = 0
            const loopDepsC: LoopDeps = {
              config: { stateDir, repoPath: repoDir, baseRef: baseSha },
              stateDir,
              killTree: async (pid, nonce) => {
                if (pid === 9003 && nonce === 'nonce-c') {
                  killAttemptsC++
                  return { result: 'kill-failed', detail: 'access denied' }
                }
                return { result: 'not-running' }
              },
              isAlive: () => true,
              readResult: () => undefined,
              spawnWorker: async ({ runDir }) => {
                mkdirSync(runDir, { recursive: true })
                writeFileSync(join(runDir, 'worker.json'), JSON.stringify({ pid: 9003, nonce: 'nonce-c', grandchildPid: 9103 }), 'utf8')
                return { pid: 9003, nonce: 'nonce-c' }
              },
            }

            await runTick(db, handle, loopDepsC, nowMs)
            nowMs += 1000
            await runTick(db, handle, loopDepsC, nowMs) // first attempt fails killTree
            expect(killAttemptsC).toBe(1)
            const attemptC = db.prepare('SELECT status FROM attempts WHERE task_id = ?').get(taskIdC) as { status: string }
            expect(attemptC.status).toBe('running') // remains running, state unchanged

            nowMs += 100
            await runTick(db, handle, loopDepsC, nowMs) // next tick retries killTree
            expect(killAttemptsC).toBe(2)
          } finally {
            if (handle) handle.release(50000)
            db.close()
          }
        }
      },
    )
  })

  describe('CHK-M4-05-d: supervisor crash during backoff or hang recovers cleanly under takeover', () => {
    it(
      'CHK-M4-05-d: crash during backoff preserves not_before_ms, attempt numbering, and exhausts original budget across takeover',
      async () => {
        const { stateDir, dbPath } = createInitializedProject('m4-05-d-crash-backoff-')

        const createRes = runCli([
          'task',
          'create',
          '--state-dir',
          stateDir,
          '--title',
          'Crash In Backoff Task',
          '--scope',
          'task-d-backoff',
          '--max-attempts',
          '2',
        ])
        expect(createRes.status).toBe(0)
        const taskId = parseCreatedTaskId(createRes.stdout)

        // Start supervisor 1 with transient failure on attempts 1 and 2
        const supChild1 = spawnCli(['start', '--state-dir', stateDir], {
          env: {
            FAKE_FAIL_UNTIL_ATTEMPT: '2',
            FAKE_FAIL_CODE: '75',
          },
        })

        // Poll until attempt 1 has failed and task is ready with not_before_ms in future
        let capturedNotBeforeMs = 0
        const pollDeadline = Date.now() + 20000
        while (Date.now() < pollDeadline) {
          const dbPoll = openStore(dbPath)
          try {
            const row = dbPoll.prepare('SELECT status, not_before_ms FROM tasks WHERE id = ?').get(taskId) as {
              status: string
              not_before_ms: number
            } | undefined
            const att = dbPoll.prepare('SELECT status, error_class FROM attempts WHERE task_id = ? AND attempt_no = 1').get(taskId) as {
              status: string
              error_class: string
            } | undefined
            if (row && row.status === 'ready' && att && att.status === 'failed' && att.error_class === 'transient') {
              capturedNotBeforeMs = row.not_before_ms
              break
            }
          } finally {
            dbPoll.close()
          }
          await delay(100)
        }

        expect(capturedNotBeforeMs).toBeGreaterThan(Date.now())

        // Hard-kill supervisor 1 immediately while backoff is pending (kill ONLY the supervisor, no /T)
        await killSupervisorOnly(supChild1, 10000)

        // Confirm supervisor 1 is dead
        const sup1Dead = await waitForProcessDeath(supChild1.pid, 15000)
        expect(sup1Dead).toBe(true)

        // Read lease row from DB for takeover
        const dbTakeover = openStore(dbPath)
        let takeoverEvidence = ''
        let leaseHeartbeatMs = 0
        try {
          const lease = dbTakeover.prepare('SELECT owner_id AS ownerId, generation, heartbeat_ms AS heartbeatMs FROM supervisor_lease WHERE id = 1').get() as {
            ownerId: string
            generation: number
            heartbeatMs: number
          }
          takeoverEvidence = `${lease.ownerId}:${lease.generation}:${lease.heartbeatMs}`
          leaseHeartbeatMs = lease.heartbeatMs
        } finally {
          dbTakeover.close()
        }

        // Preserve a longer pending backoff so that after waiting for lease staleness, backoff is still pending
        const pendingBackoffMs = leaseHeartbeatMs + 4000
        const dbUpdate = openStore(dbPath)
        try {
          dbUpdate.prepare('UPDATE tasks SET not_before_ms = ? WHERE id = ?').run(pendingBackoffMs, taskId)
        } finally {
          dbUpdate.close()
        }

        // Wait until that heartbeat is stale
        const waitStaleMs = Math.max(0, leaseHeartbeatMs + 1000 - Date.now() + 150)
        await delay(waitStaleMs)

        // Start supervisor 2 while backoff is still pending (Date.now() < pendingBackoffMs)
        expect(Date.now()).toBeLessThan(pendingBackoffMs)

        const supChild2 = spawnCli(
          [
            'start',
            '--state-dir',
            stateDir,
            '--exit-when-idle',
            '--stale-after-ms',
            '1000',
            '--takeover',
            takeoverEvidence,
          ],
          {
            env: {
              FAKE_FAIL_UNTIL_ATTEMPT: '2',
              FAKE_FAIL_CODE: '75',
            },
          },
        )

        const { exitCode } = await waitForSupervisorExit(supChild2, 45000)
        expect(exitCode).toBe(0)

        const dbFinal = openStore(dbPath)
        try {
          const task = dbFinal.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as {
            status: string
          }
          // Budget of 2 is exhausted; task must be failed (proving budget was NOT reset!)
          expect(task.status).toBe('failed')

          const attempts = dbFinal.prepare(
            'SELECT attempt_no, status, error_class, started_at FROM attempts WHERE task_id = ? ORDER BY attempt_no ASC',
          ).all(taskId) as Array<{ attempt_no: number; status: string; error_class: string; started_at: string }>

          expect(attempts.length).toBe(2)
          expect(attempts[0]?.attempt_no).toBe(1)
          expect(attempts[0]?.status).toBe('failed')
          expect(attempts[0]?.error_class).toBe('transient')

          expect(attempts[1]?.attempt_no).toBe(2)
          expect(attempts[1]?.status).toBe('failed')
          expect(attempts[1]?.error_class).toBe('transient')

          // Attempt 2 was not started early (respected pending backoff)
          const attempt2StartedMs = Date.parse(attempts[1]!.started_at)
          expect(attempt2StartedMs).toBeGreaterThanOrEqual(pendingBackoffMs)

          const evCount = (
            dbFinal.prepare('SELECT COUNT(*) as c FROM evidence WHERE attempt_id IN (SELECT id FROM attempts WHERE task_id = ?)').get(taskId) as { c: number }
          ).c
          expect(evCount).toBe(0)
        } finally {
          dbFinal.close()
        }
      },
      60000,
    )

    it(
      'CHK-M4-05-d: crash during hanging attempt with deadline reconciles orphan on restart without exceeding budget',
      async () => {
        const { stateDir, dbPath } = createInitializedProject('m4-05-d-crash-hang-')

        const createRes = runCli([
          'task',
          'create',
          '--state-dir',
          stateDir,
          '--title',
          'Crash In Hang Task',
          '--scope',
          'task-d-hang',
          '--timeout-ms',
          '2000',
          '--max-attempts',
          '2',
        ])
        expect(createRes.status).toBe(0)
        const taskId = parseCreatedTaskId(createRes.stdout)

        const supChild1 = spawnCli(['start', '--state-dir', stateDir], {
          env: {
            FAKE_HANG: '1',
          },
        })

        // Poll until worker row has pid and state 'running'
        let runningWorkerPid = 0
        let runningWorkerNonce = ''
        let grandchildPid = 0
        const pollDeadline = Date.now() + 20000
        while (Date.now() < pollDeadline) {
          const dbPoll = openStore(dbPath)
          try {
            const w = dbPoll.prepare("SELECT pid, nonce, state, attempt_id FROM workers WHERE attempt_id IN (SELECT id FROM attempts WHERE task_id = ?) AND state = 'running'").get(taskId) as {
              pid: number | null
              nonce: string
              state: string
              attempt_id: string
            } | undefined
            if (w && w.pid && w.state === 'running') {
              runningWorkerPid = w.pid
              runningWorkerNonce = w.nonce
              activeNonces.add(w.nonce)

              const wJsonPath = join(stateDir, 'runs', w.attempt_id, 'worker.json')
              if (existsSync(wJsonPath)) {
                try {
                  const parsed = JSON.parse(readFileSync(wJsonPath, 'utf8')) as { grandchildPid?: number }
                  grandchildPid = parsed.grandchildPid ?? 0
                } catch {}
              }
              break
            }
          } finally {
            dbPoll.close()
          }
          await delay(100)
        }

        expect(runningWorkerPid).toBeGreaterThan(0)
        expect(isProcessAlive(runningWorkerPid)).toBe(true)
        if (grandchildPid > 0) {
          expect(isProcessAlive(grandchildPid)).toBe(true)
        }

        // Hard-kill supervisor 1 while worker hangs (kill ONLY the supervisor, no /T, so worker & grandchild survive)
        await killSupervisorOnly(supChild1, 10000)

        // Confirm supervisor 1 is dead
        const supervisorDead = await waitForProcessDeath(supChild1.pid, 15000)
        expect(supervisorDead).toBe(true)

        // Assert orphan survives while supervisor is dead
        expect(isProcessAlive(runningWorkerPid)).toBe(true)
        if (grandchildPid > 0) {
          expect(isProcessAlive(grandchildPid)).toBe(true)
        }

        const dbTakeover = openStore(dbPath)
        let takeoverEvidence = ''
        let leaseHeartbeatMs = 0
        try {
          const lease = dbTakeover.prepare('SELECT owner_id AS ownerId, generation, heartbeat_ms AS heartbeatMs FROM supervisor_lease WHERE id = 1').get() as {
            ownerId: string
            generation: number
            heartbeatMs: number
          }
          takeoverEvidence = `${lease.ownerId}:${lease.generation}:${lease.heartbeatMs}`
          leaseHeartbeatMs = lease.heartbeatMs
        } finally {
          dbTakeover.close()
        }

        // Wait until that heartbeat is stale
        const waitStaleMs = Math.max(0, leaseHeartbeatMs + 1000 - Date.now() + 150)
        await delay(waitStaleMs)

        // Orphan STILL survives right before restart!
        expect(isProcessAlive(runningWorkerPid)).toBe(true)
        if (grandchildPid > 0) {
          expect(isProcessAlive(grandchildPid)).toBe(true)
        }

        const supChild2 = spawnCli(
          [
            'start',
            '--state-dir',
            stateDir,
            '--exit-when-idle',
            '--stale-after-ms',
            '1000',
            '--takeover',
            takeoverEvidence,
          ],
          {
            env: {
              FAKE_HANG: '1',
            },
          },
        )

        const { exitCode } = await waitForSupervisorExit(supChild2, 45000)
        expect(exitCode).toBe(0)

        // The hanging worker from supervisor 1 must have been killed during reconcile
        expect(isProcessAlive(runningWorkerPid)).toBe(false)
        if (grandchildPid > 0) {
          expect(isProcessAlive(grandchildPid)).toBe(false)
        }

        const dbFinal = openStore(dbPath)
        try {
          const task = dbFinal.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as {
            status: string
          }
          expect(task.status).toBe('failed')

          const attempts = dbFinal.prepare(
            'SELECT attempt_no, status, error_class FROM attempts WHERE task_id = ? ORDER BY attempt_no ASC',
          ).all(taskId) as Array<{ attempt_no: number; status: string; error_class: string }>

          expect(attempts.length).toBe(2)
          expect(attempts[0]?.attempt_no).toBe(1)
          expect(attempts[0]?.status).toBe('interrupted')

          expect(attempts[1]?.attempt_no).toBe(2)
          expect(attempts[1]?.status).toBe('interrupted')
          expect(attempts[1]?.error_class).toBe('timeout')

          // Confirm no orphan processes survived
          harvestRunDirectories(stateDir)
          harvestDbWorkers(dbPath)
          const survivors = findPidsByNonces(Array.from(activeNonces))
          expect(survivors).toEqual([])
        } finally {
          dbFinal.close()
        }
      },
      60000,
    )
  })

  describe('CHK-M4-05-e: outbox exponential backoff capped at 30 seconds', () => {
    it(
      'CHK-M4-05-e: (in-process controlled clock) verifies exponential outbox backoff formula and 30s cap',
      async () => {
        expect(outbox.BACKOFF_MS).toBe(1000)
        expect(outbox.OUTBOX_BACKOFF_MAX_MS).toBe(30000)
        expect(outbox.MAX_TRIES).toBe(3)

        const { stateDir, dbPath } = createInitializedProject('m4-05-e-outbox-')
        const db = openStore(dbPath)
        let handle: SupervisorLeaseHandle | undefined

        try {
          let nowMs = 10000
          handle = acquireSupervisor(db, stateDir, { nowMs, staleAfterMs: 1000 })

          const idempotencyKey = `test-outbox-backoff-${randomUUID()}`
          outbox.enqueueInTransaction(db, {
            idempotencyKey,
            kind: 'test.effect',
            payloadJson: JSON.stringify({ test: true }),
            nowMs,
          })

          const handlers = {
            'test.effect': () => {
              throw new Error('simulated outbox handler failure')
            },
          }

          // Step 1: runDue at nowMs = 10000 -> tries becomes 1, backoff is min(1000 * 2^(1-1), 30000) = 1000
          const res1 = await outbox.runDue(db, handle, handlers, nowMs)
          expect(res1.retried).toBe(1)
          expect(res1.failed).toBe(0)

          const row1 = db.prepare('SELECT status, tries, next_attempt_ms FROM outbox WHERE idempotency_key = ?').get(idempotencyKey) as {
            status: string
            tries: number
            next_attempt_ms: number
          }
          expect(row1.status).toBe('pending')
          expect(row1.tries).toBe(1)
          expect(row1.next_attempt_ms).toBe(nowMs + 1000) // 10000 + 1000 = 11000

          // Tick before next_attempt_ms (nowMs = 10500 < 11000) -> not due
          const resIgnored = await outbox.runDue(db, handle, handlers, 10500)
          expect(resIgnored.retried).toBe(0)
          expect(resIgnored.failed).toBe(0)

          // Step 2: runDue at nowMs = 11000 -> tries becomes 2, backoff is min(1000 * 2^(2-1), 30000) = 2000
          nowMs = 11000
          const res2 = await outbox.runDue(db, handle, handlers, nowMs)
          expect(res2.retried).toBe(1)
          expect(res2.failed).toBe(0)

          const row2 = db.prepare('SELECT status, tries, next_attempt_ms FROM outbox WHERE idempotency_key = ?').get(idempotencyKey) as {
            status: string
            tries: number
            next_attempt_ms: number
          }
          expect(row2.status).toBe('pending')
          expect(row2.tries).toBe(2)
          expect(row2.next_attempt_ms).toBe(nowMs + 2000) // 11000 + 2000 = 13000

          // Step 3: runDue at nowMs = 13000 -> tries reaches 3 (MAX_TRIES) -> status becomes failed
          nowMs = 13000
          const res3 = await outbox.runDue(db, handle, handlers, nowMs)
          expect(res3.retried).toBe(0)
          expect(res3.failed).toBe(1)

          const row3 = db.prepare('SELECT status, tries FROM outbox WHERE idempotency_key = ?').get(idempotencyKey) as {
            status: string
            tries: number
          }
          expect(row3.status).toBe('failed')
          expect(row3.tries).toBe(3)

          // Cap test: verify backoff formula caps at OUTBOX_BACKOFF_MAX_MS (30000)
          const capKey = `test-cap-${randomUUID()}`
          outbox.enqueueInTransaction(db, {
            idempotencyKey: capKey,
            kind: 'test.cap',
            payloadJson: '{}',
            nowMs: 20000,
          })
          db.prepare('UPDATE outbox SET tries = 6, next_attempt_ms = 20000 WHERE idempotency_key = ?').run(capKey)

          const capHandlers = {
            'test.cap': () => {
              throw new Error('cap failure')
            },
          }
          await outbox.runDue(db, handle, capHandlers, 20000)

          const capRow = db.prepare('SELECT next_attempt_ms FROM outbox WHERE idempotency_key = ?').get(capKey) as {
            next_attempt_ms: number
          }
          // With tries=6 -> new tries=7 -> min(1000 * 2^6, 30000) = min(64000, 30000) = 30000
          expect(capRow.next_attempt_ms).toBe(20000 + 30000)
        } finally {
          if (handle) handle.release(50000)
          db.close()
        }
      },
    )
  })

  describe('CHK-M4-05-f: SQLITE_BUSY non-fatal recovery and completion', () => {
    it(
      'CHK-M4-05-f: holding BEGIN IMMEDIATE past 5000ms busy timeout logs Arabic line to stderr and finishes task after release',
      async () => {
        const { stateDir, dbPath } = createInitializedProject('m4-05-f-busy-')

        const createRes = runCli([
          'task',
          'create',
          '--state-dir',
          stateDir,
          '--title',
          'Busy Lock Test Task',
          '--scope',
          'task-f-busy',
        ])
        expect(createRes.status).toBe(0)
        const taskId = parseCreatedTaskId(createRes.stdout)

        // Start supervisor with FAKE_SLEEP_MS to ensure worker runs while lock is contended
        const supChild = spawnCli(
          [
            'start',
            '--state-dir',
            stateDir,
            '--exit-when-idle',
            '--heartbeat-ms',
            '500',
          ],
          {
            env: {
              FAKE_SLEEP_MS: '3000',
            },
          },
        )

        // Open second DB connection to inject lock contention during a tick
        const secondDb = new DatabaseSync(dbPath)
        let leaseAcquired = false

        try {
          // 1. Wait until supervisor has started and acquired lease (status = 'active')
          const pollDeadline = Date.now() + 15000
          while (Date.now() < pollDeadline) {
            try {
              const row = secondDb.prepare('SELECT status FROM supervisor_lease WHERE id = 1').get() as { status?: string } | undefined
              if (row?.status === 'active') {
                leaseAcquired = true
                break
              }
            } catch {
              // retry
            }
            await delay(50)
          }
          expect(leaseAcquired).toBe(true)

          // 2. Synchronize contention: wait until task is in 'progress' (worker running)
          const taskDeadline = Date.now() + 15000
          let taskInProgress = false
          while (Date.now() < taskDeadline) {
            try {
              const t = secondDb.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status?: string } | undefined
              if (t?.status === 'progress') {
                taskInProgress = true
                break
              }
            } catch {
              // retry
            }
            await delay(50)
          }
          expect(taskInProgress).toBe(true)

          // 3. Hold BEGIN IMMEDIATE: supervisor will hit SQLITE_BUSY when attempting tick writes
          secondDb.exec('PRAGMA busy_timeout = 1000')
          secondDb.exec('BEGIN IMMEDIATE')

          // Assert supervisor child remains alive while database is locked
          expect(isProcessAlive(supChild.pid)).toBe(true)

          // Poll stderr until supervisor logs the Arabic busy line (> 5000ms busy timeout)
          const busyDeadline = Date.now() + 10000
          let observedBusy = false
          while (Date.now() < busyDeadline) {
            if (ARABIC_REGEX.test(supChild.getStderr())) {
              observedBusy = true
              break
            }
            expect(isProcessAlive(supChild.pid)).toBe(true)
            await delay(100)
          }

          // Assert supervisor survived while locked
          expect(isProcessAlive(supChild.pid)).toBe(true)

          // Release lock promptly after observing busy or timeout
          secondDb.exec('ROLLBACK')
          expect(observedBusy).toBe(true)
        } finally {
          secondDb.close()
        }

        // Supervisor must complete cleanly with exit code 0
        const { exitCode, stderr } = await waitForSupervisorExit(supChild, 45000)
        expect(exitCode).toBe(0)
        expect(stderr).toMatch(ARABIC_REGEX)

        const db = openStore(dbPath)
        try {
          const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as {
            status: string
          }
          expect(task.status).toBe('done')

          const attempts = db.prepare(
            'SELECT attempt_no, status FROM attempts WHERE task_id = ?',
          ).all(taskId) as Array<{ attempt_no: number; status: string }>

          expect(attempts.length).toBe(1)
          expect(attempts[0]?.status).toBe('succeeded')

          const evCount = (
            db.prepare('SELECT COUNT(*) as c FROM evidence WHERE attempt_id IN (SELECT id FROM attempts WHERE task_id = ?)').get(taskId) as { c: number }
          ).c
          expect(evCount).toBe(1)
        } finally {
          db.close()
        }
      },
      60000,
    )
  })
})
