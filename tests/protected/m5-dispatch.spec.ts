import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { killTree, spawnWorker } from '../../supervisor/src/app/process-tree.ts'
import {
  cleanupNonces as helperCleanupNonces,
  findProcessesWithNonces,
  isProcessAliveWithNonce,
  killIfOurs,
  probePid,
  waitForProcessDeath,
} from '../helpers/process-identity.ts'
import { readCompletion, reconcileWorkers } from '../../supervisor/src/app/recovery.ts'
import { openStore } from '../../supervisor/src/app/store.ts'
import { acquireSupervisor } from '../../supervisor/src/app/supervisor-lease.ts'
import { runTick, type LoopDeps } from '../../supervisor/src/app/supervisor-loop.ts'
import { planDispatch } from '../../supervisor/src/core/graph.ts'

const cliPath = join(process.cwd(), 'supervisor/src/cli/main.ts')
const directories: string[] = []
const activeNonces = new Set<string>()

interface TrackedSupervisorChild {
  readonly child: ChildProcess
  readonly pid: number
  readonly marker: string
}
const spawnedSupervisors: TrackedSupervisorChild[] = []

function collectNoncesFromDatabases(): void {
  for (const root of directories) {
    const dbPath = join(root, 'state', 'state.sqlite')
    if (existsSync(dbPath)) {
      try {
        const db = openStore(dbPath)
        try {
          const rows = db.prepare('SELECT nonce FROM workers').all() as Array<{ nonce: string }>
          for (const r of rows) {
            if (r.nonce) activeNonces.add(r.nonce)
          }
        } finally {
          db.close()
        }
      } catch {
        // ignore DB read error on cleanup
      }
    }
    const runsDir = join(root, 'state', 'runs')
    if (existsSync(runsDir)) {
      try {
        for (const entry of readdirSync(runsDir)) {
          const workerJsonPath = join(runsDir, entry, 'worker.json')
          if (existsSync(workerJsonPath)) {
            try {
              const data = JSON.parse(readFileSync(workerJsonPath, 'utf8')) as { nonce?: string }
              if (data && typeof data.nonce === 'string' && data.nonce.length > 0) {
                activeNonces.add(data.nonce)
              }
            } catch {}
          }
        }
      } catch {}
    }
  }
}

async function cleanupAllProcesses(timeoutMs = 25000): Promise<void> {
  const cleanupFailures: string[] = []

  // 1. Terminate tracked supervisors
  const remainingSupervisors: TrackedSupervisorChild[] = []
  for (const s of spawnedSupervisors) {
    if (s.child) {
      await killIfOurs(s.child)
      const dead = await waitForProcessDeath(s.pid, 15000, s.marker)
      if (!dead) {
        cleanupFailures.push(`Supervisor process ${s.pid} failed to terminate within 15000ms`)
        remainingSupervisors.push(s)
      }
    }
  }
  spawnedSupervisors.length = 0
  spawnedSupervisors.push(...remainingSupervisors)

  // 2. Collect any remaining nonces from all DBs and run directories
  collectNoncesFromDatabases()

  // 3. Sweep workers by verified identity until empty or deadline
  const nonces = Array.from(activeNonces).filter((n) => typeof n === 'string' && n.length > 0)
  if (nonces.length > 0) {
    try {
      await helperCleanupNonces(nonces, timeoutMs)
      activeNonces.clear()
    } catch (err: any) {
      cleanupFailures.push(err?.message || String(err))
    }
  }

  if (cleanupFailures.length > 0) {
    throw new Error(`Process cleanup failed:\n${cleanupFailures.join('\n')}`)
  }
}

function safeRemoveDir(dir: string): void {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
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

function createGitRepo(dir: string, initialFiles?: Record<string, string>): { baseSha: string } {
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', dir], { stdio: 'ignore', timeout: 15000 })
  git(dir, 'config', 'core.autocrlf', 'false')
  if (initialFiles) {
    for (const [rel, content] of Object.entries(initialFiles)) {
      const full = join(dir, rel)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content, 'utf8')
    }
  } else {
    writeFileSync(join(dir, 'README.md'), '# test\n', 'utf8')
  }
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'initial commit')
  const baseSha = git(dir, 'rev-parse', 'HEAD')
  return { baseSha }
}

function cleanTestEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of [
    'FACTORY_FAULT',
    'FAKE_FAIL_UNTIL_ATTEMPT',
    'FAKE_FAIL_CODE',
    'FAKE_HANG',
    'FAKE_WRITE',
    'FAKE_SLEEP_MS',
    'FAKE_EXIT_CODE',
    'NODE_OPTIONS',
  ]) {
    delete env[key]
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  return env
}

function runCli(
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number },
) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options?.cwd,
    env: options?.env ?? cleanTestEnv(),
    encoding: 'utf8',
    timeout: options?.timeout ?? 45000,
    windowsHide: true,
  })
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    throw new Error(`CLI execution timed out after ${options?.timeout ?? 45000}ms: factory ${args.join(' ')}`)
  }
  return result
}

async function waitForWorkerPublication(
  runsDir: string,
  timeoutMs = 25000,
  excludeAttemptIds: Set<string> = new Set(),
): Promise<{ pid: number; nonce: string; grandchildPid: number; attemptId: string }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(runsDir)) {
      try {
        const attemptDirs = readdirSync(runsDir)
        for (const attId of attemptDirs) {
          if (excludeAttemptIds.has(attId)) continue
          const workerJsonPath = join(runsDir, attId, 'worker.json')
          if (existsSync(workerJsonPath)) {
            try {
              const raw = readFileSync(workerJsonPath, 'utf8')
              const data = JSON.parse(raw) as { pid: number; nonce: string; grandchildPid: number }
              if (
                data &&
                typeof data.pid === 'number' &&
                typeof data.nonce === 'string' &&
                typeof data.grandchildPid === 'number'
              ) {
                return { pid: data.pid, nonce: data.nonce, grandchildPid: data.grandchildPid, attemptId: attId }
              }
            } catch {}
          }
        }
      } catch {}
    }
    await delay(50)
  }
  throw new Error(`Worker identity was not published within ${timeoutMs}ms`)
}

afterEach(async () => {
  try {
    await cleanupAllProcesses()
  } finally {
    for (const dir of [...directories]) {
      try {
        safeRemoveDir(dir)
      } catch {}
    }
    directories.length = 0
  }
})

describe('M5-06 dispatch with phases and dependencies', () => {
  it(
    'CHK-M5-06-a: chain A -> B -> C (B after A, C after B, disjoint scopes, FAKE_SLEEP_MS): each starts only after its dep is done; all end done with one evidence row each',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'm5-06-a-chain-'))
      directories.push(root)
      const repoDir = join(root, 'repo')
      const stateDir = join(root, 'state')
      const tempCwd = join(root, 'cwd')
      mkdirSync(tempCwd, { recursive: true })

      createGitRepo(repoDir)
      const initRes = runCli(['init', '--state-dir', stateDir, '--repo', repoDir], { cwd: tempCwd })
      expect(initRes.status).toBe(0)

      const taskAId = randomUUID()
      const taskBId = randomUUID()
      const taskCId = randomUUID()

      const createA = runCli(
        ['task', 'create', '--state-dir', stateDir, '--title', 'Task A', '--scope', 'src/a', '--scope', `factory-fake/${taskAId}.txt`, '--command-id', taskAId],
        { cwd: tempCwd },
      )
      expect(createA.status).toBe(0)

      const createB = runCli(
        ['task', 'create', '--state-dir', stateDir, '--title', 'Task B', '--scope', 'src/b', '--scope', `factory-fake/${taskBId}.txt`, '--after', taskAId, '--command-id', taskBId],
        { cwd: tempCwd },
      )
      expect(createB.status).toBe(0)

      const createC = runCli(
        ['task', 'create', '--state-dir', stateDir, '--title', 'Task C', '--scope', 'src/c', '--scope', `factory-fake/${taskCId}.txt`, '--after', taskBId, '--command-id', taskCId],
        { cwd: tempCwd },
      )
      expect(createC.status).toBe(0)

      const startRes = runCli(
        ['start', '--state-dir', stateDir, '--exit-when-idle'],
        {
          cwd: tempCwd,
          env: cleanTestEnv({
            FAKE_SLEEP_MS: '400',
          }),
          timeout: 60000,
        },
      )
      expect(startRes.status).toBe(0)

      const db = openStore(join(stateDir, 'state.sqlite'))
      try {
        const nonces = db.prepare('SELECT nonce FROM workers').all() as Array<{ nonce: string }>
        for (const n of nonces) {
          if (n.nonce) activeNonces.add(n.nonce)
        }

        const tA = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskAId) as { status: string }
        const tB = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskBId) as { status: string }
        const tC = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskCId) as { status: string }
        expect(tA.status).toBe('done')
        expect(tB.status).toBe('done')
        expect(tC.status).toBe('done')

        const attA = db.prepare('SELECT id, started_at, ended_at, status FROM attempts WHERE task_id = ?').get(taskAId) as { id: string; started_at: string; ended_at: string; status: string }
        const attB = db.prepare('SELECT id, started_at, ended_at, status FROM attempts WHERE task_id = ?').get(taskBId) as { id: string; started_at: string; ended_at: string; status: string }
        const attC = db.prepare('SELECT id, started_at, ended_at, status FROM attempts WHERE task_id = ?').get(taskCId) as { id: string; started_at: string; ended_at: string; status: string }

        expect(attA.status).toBe('succeeded')
        expect(attB.status).toBe('succeeded')
        expect(attC.status).toBe('succeeded')

        // Each starts only after its dep is done:
        expect(Date.parse(attB.started_at)).toBeGreaterThanOrEqual(Date.parse(attA.ended_at))
        expect(Date.parse(attC.started_at)).toBeGreaterThanOrEqual(Date.parse(attB.ended_at))

        // All end done with one evidence row each:
        const evA = db.prepare('SELECT COUNT(*) as c FROM evidence WHERE attempt_id = ?').get(attA.id) as { c: number }
        const evB = db.prepare('SELECT COUNT(*) as c FROM evidence WHERE attempt_id = ?').get(attB.id) as { c: number }
        const evC = db.prepare('SELECT COUNT(*) as c FROM evidence WHERE attempt_id = ?').get(attC.id) as { c: number }
        expect(evA.c).toBe(1)
        expect(evB.c).toBe(1)
        expect(evC.c).toBe(1)
      } finally {
        db.close()
      }
    },
    90000,
  )

  it(
    'CHK-M5-06-a: diamond (B and C after A, D after B and C) runs B and C at the same time and D last',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'm5-06-a-diamond-'))
      directories.push(root)
      const repoDir = join(root, 'repo')
      const stateDir = join(root, 'state')
      const tempCwd = join(root, 'cwd')
      mkdirSync(tempCwd, { recursive: true })

      createGitRepo(repoDir)
      const initRes = runCli(['init', '--state-dir', stateDir, '--repo', repoDir], { cwd: tempCwd })
      expect(initRes.status).toBe(0)

      const taskAId = randomUUID()
      const taskBId = randomUUID()
      const taskCId = randomUUID()
      const taskDId = randomUUID()

      const createA = runCli(
        ['task', 'create', '--state-dir', stateDir, '--title', 'Task A', '--scope', 'src/a', '--scope', `factory-fake/${taskAId}.txt`, '--command-id', taskAId],
        { cwd: tempCwd },
      )
      expect(createA.status).toBe(0)

      const createB = runCli(
        ['task', 'create', '--state-dir', stateDir, '--title', 'Task B', '--scope', 'src/b', '--scope', `factory-fake/${taskBId}.txt`, '--after', taskAId, '--command-id', taskBId],
        { cwd: tempCwd },
      )
      expect(createB.status).toBe(0)

      const createC = runCli(
        ['task', 'create', '--state-dir', stateDir, '--title', 'Task C', '--scope', 'src/c', '--scope', `factory-fake/${taskCId}.txt`, '--after', taskAId, '--command-id', taskCId],
        { cwd: tempCwd },
      )
      expect(createC.status).toBe(0)

      const createD = runCli(
        ['task', 'create', '--state-dir', stateDir, '--title', 'Task D', '--scope', 'src/d', '--scope', `factory-fake/${taskDId}.txt`, '--after', taskBId, '--after', taskCId, '--command-id', taskDId],
        { cwd: tempCwd },
      )
      expect(createD.status).toBe(0)

      // Spawn supervisor in background to observe concurrent execution of B and C:
      const supMarker = `factory-supervisor-${randomUUID()}`
      const sup = spawn(
        process.execPath,
        [`--title=${supMarker}`, cliPath, 'start', '--state-dir', stateDir, '--exit-when-idle'],
        {
          cwd: tempCwd,
          env: cleanTestEnv({
            FAKE_SLEEP_MS: '3000',
            FACTORY_SUPERVISOR_MARKER: supMarker,
          }),
          stdio: 'ignore',
          windowsHide: true,
        },
      )
      if (sup.pid) {
        spawnedSupervisors.push({ child: sup, pid: sup.pid, marker: supMarker })
      }

      // Bounded observation: observe both Task B and Task C workers alive at the same time:
      let observedBothRunning = false
      const pollDeadline = Date.now() + 60000
      while (Date.now() < pollDeadline) {
        if (existsSync(join(stateDir, 'state.sqlite'))) {
          try {
            const dbPoll = openStore(join(stateDir, 'state.sqlite'))
            try {
              const runningWorkers = dbPoll.prepare(
                `SELECT a.task_id, w.pid, w.nonce
                 FROM workers w
                 JOIN attempts a ON a.id = w.attempt_id
                 WHERE a.status = 'running' AND w.state = 'running' AND a.task_id IN (?, ?)`
              ).all(taskBId, taskCId) as Array<{ task_id: string; pid: number; nonce: string }>

              const bWorker = runningWorkers.find((w) => w.task_id === taskBId)
              const cWorker = runningWorkers.find((w) => w.task_id === taskCId)

              if (bWorker && cWorker && bWorker.pid && cWorker.pid && bWorker.nonce && cWorker.nonce) {
                activeNonces.add(bWorker.nonce)
                activeNonces.add(cWorker.nonce)
                if (
                  isProcessAliveWithNonce(bWorker.pid, bWorker.nonce) &&
                  isProcessAliveWithNonce(cWorker.pid, cWorker.nonce)
                ) {
                  observedBothRunning = true
                  break
                }
              }
            } finally {
              dbPoll.close()
            }
          } catch {}
        }
        if (sup.exitCode !== null || sup.signalCode !== null || !isProcessAliveWithNonce(sup.pid!, supMarker)) break
        await delay(50)
      }

      const supDead = await waitForProcessDeath(sup.pid!, 45000, supMarker)
      expect(supDead).toBe(true)
      expect(observedBothRunning, 'Tasks B and C must run concurrently').toBe(true)

      const db = openStore(join(stateDir, 'state.sqlite'))
      try {
        const nonces = db.prepare('SELECT nonce FROM workers').all() as Array<{ nonce: string }>
        for (const n of nonces) {
          if (n.nonce) activeNonces.add(n.nonce)
        }

        const tA = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskAId) as { status: string }
        const tB = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskBId) as { status: string }
        const tC = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskCId) as { status: string }
        const tD = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskDId) as { status: string }
        expect(tA.status).toBe('done')
        expect(tB.status).toBe('done')
        expect(tC.status).toBe('done')
        expect(tD.status).toBe('done')

        const attA = db.prepare('SELECT id, started_at, ended_at FROM attempts WHERE task_id = ?').get(taskAId) as { id: string; started_at: string; ended_at: string }
        const attB = db.prepare('SELECT id, started_at, ended_at FROM attempts WHERE task_id = ?').get(taskBId) as { id: string; started_at: string; ended_at: string }
        const attC = db.prepare('SELECT id, started_at, ended_at FROM attempts WHERE task_id = ?').get(taskCId) as { id: string; started_at: string; ended_at: string }
        const attD = db.prepare('SELECT id, started_at, ended_at FROM attempts WHERE task_id = ?').get(taskDId) as { id: string; started_at: string; ended_at: string }

        // B and C start after A is done:
        expect(Date.parse(attB.started_at)).toBeGreaterThanOrEqual(Date.parse(attA.ended_at))
        expect(Date.parse(attC.started_at)).toBeGreaterThanOrEqual(Date.parse(attA.ended_at))

        // B and C intervals overlap:
        const overlap = Date.parse(attB.started_at) <= Date.parse(attC.ended_at) && Date.parse(attC.started_at) <= Date.parse(attB.ended_at)
        expect(overlap).toBe(true)

        // D runs last (after both B and C are done):
        const latestBC = Math.max(Date.parse(attB.ended_at), Date.parse(attC.ended_at))
        expect(Date.parse(attD.started_at)).toBeGreaterThanOrEqual(latestBC)
      } finally {
        db.close()
      }
    },
    90000,
  )

  it(
    'CHK-M5-06-a: phase-less fixture project dispatches as in M4 without phase restrictions',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'm5-06-a-phaseless-'))
      directories.push(root)
      const repoDir = join(root, 'repo')
      const stateDir = join(root, 'state')
      const tempCwd = join(root, 'cwd')
      mkdirSync(tempCwd, { recursive: true })
      mkdirSync(stateDir, { recursive: true })

      const { baseSha } = createGitRepo(repoDir)
      const dbPath = join(stateDir, 'state.sqlite')
      const dbInit = openStore(dbPath)
      const projId = randomUUID()
      try {
        const now = new Date().toISOString()
        dbInit.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)").run(projId, 'Phase-less Project', now)
        dbInit.prepare("INSERT INTO project_config (project_id, repo_path, base_ref, created_at) VALUES (?, ?, ?, ?)").run(projId, resolve(repoDir), baseSha, now)
        // Notice: zero rows inserted into phases for projId (phase-less project fixture).
      } finally {
        dbInit.close()
      }

      const task1Id = randomUUID()
      const task2Id = randomUUID()

      const create1 = runCli(
        ['task', 'create', '--state-dir', stateDir, '--title', 'Task 1', '--scope', 'src/a', '--scope', `factory-fake/${task1Id}.txt`, '--command-id', task1Id],
        { cwd: tempCwd },
      )
      expect(create1.status).toBe(0)

      const create2 = runCli(
        ['task', 'create', '--state-dir', stateDir, '--title', 'Task 2', '--scope', 'src/b', '--scope', `factory-fake/${task2Id}.txt`, '--command-id', task2Id],
        { cwd: tempCwd },
      )
      expect(create2.status).toBe(0)

      const startRes = runCli(
        ['start', '--state-dir', stateDir, '--exit-when-idle'],
        {
          cwd: tempCwd,
          env: cleanTestEnv({
            FAKE_SLEEP_MS: '200',
          }),
          timeout: 60000,
        },
      )
      expect(startRes.status).toBe(0)

      const db = openStore(dbPath)
      try {
        const nonces = db.prepare('SELECT nonce FROM workers').all() as Array<{ nonce: string }>
        for (const n of nonces) {
          if (n.nonce) activeNonces.add(n.nonce)
        }

        const t1 = db.prepare('SELECT status FROM tasks WHERE id = ?').get(task1Id) as { status: string }
        const t2 = db.prepare('SELECT status FROM tasks WHERE id = ?').get(task2Id) as { status: string }
        expect(t1.status).toBe('done')
        expect(t2.status).toBe('done')

        const att1 = db.prepare('SELECT id, status FROM attempts WHERE task_id = ?').get(task1Id) as { id: string; status: string }
        const att2 = db.prepare('SELECT id, status FROM attempts WHERE task_id = ?').get(task2Id) as { id: string; status: string }
        expect(att1.status).toBe('succeeded')
        expect(att2.status).toBe('succeeded')
      } finally {
        db.close()
      }
    },
    90000,
  )

  it(
    'CHK-M5-06-b: A killed while B (after A) is ready -> B becomes blocked in the same or next tick and never gets an attempt; C after B also becomes blocked; task kill on B is applied',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'm5-06-b-'))
      directories.push(root)
      const repoDir = join(root, 'repo')
      const stateDir = join(root, 'state')
      const tempCwd = join(root, 'cwd')
      mkdirSync(tempCwd, { recursive: true })

      createGitRepo(repoDir)
      const initRes = runCli(['init', '--state-dir', stateDir, '--repo', repoDir], { cwd: tempCwd })
      expect(initRes.status).toBe(0)

      const taskAId = randomUUID()
      const taskBId = randomUUID()
      const taskCId = randomUUID()

      const createA = runCli(
        ['task', 'create', '--state-dir', stateDir, '--title', 'Task A', '--scope', 'src/a', '--scope', `factory-fake/${taskAId}.txt`, '--command-id', taskAId],
        { cwd: tempCwd },
      )
      expect(createA.status).toBe(0)

      const createB = runCli(
        ['task', 'create', '--state-dir', stateDir, '--title', 'Task B', '--scope', 'src/b', '--scope', `factory-fake/${taskBId}.txt`, '--after', taskAId, '--command-id', taskBId],
        { cwd: tempCwd },
      )
      expect(createB.status).toBe(0)

      const createC = runCli(
        ['task', 'create', '--state-dir', stateDir, '--title', 'Task C', '--scope', 'src/c', '--scope', `factory-fake/${taskCId}.txt`, '--after', taskBId, '--command-id', taskCId],
        { cwd: tempCwd },
      )
      expect(createC.status).toBe(0)

      // Kill task A while B is ready:
      const killA = runCli(['task', 'kill', '--state-dir', stateDir, '--task', taskAId], { cwd: tempCwd })
      expect(killA.status).toBe(0)

      // Run supervisor loop by tick and observe tick boundaries:
      const db = openStore(join(stateDir, 'state.sqlite'))
      try {
        const handle = acquireSupervisor(db, stateDir, { nowMs: Date.now(), staleAfterMs: 30000 })
        try {
          await reconcileWorkers(db, handle, { killTree, stateDir, staleAfterMs: 30000 }, Date.now())

          const loopDeps: LoopDeps = {
            stateDir,
            spawnWorker,
            killTree,
            readResult: readCompletion,
            isAlive: (pid, nonce) => isProcessAliveWithNonce(pid, nonce, { deadlineMs: Date.now() + 5000 }),
            staleAfterMs: 30000,
          }

          // Tick 1: processes the kill command for A, runs dispatch
          await runTick(db, handle, loopDeps, Date.now())

          // Observe tick boundary: B and C must become blocked in the same or next tick
          let tB = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskBId) as { status: string }
          let tC = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskCId) as { status: string }

          let tickCount = 1
          if (tB.status !== 'blocked' || tC.status !== 'blocked') {
            // Next tick:
            tickCount++
            await runTick(db, handle, loopDeps, Date.now())
            tB = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskBId) as { status: string }
            tC = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskCId) as { status: string }
          }

          expect(tickCount).toBeLessThanOrEqual(2)
          expect(tB.status).toBe('blocked')
          expect(tC.status).toBe('blocked')

          const tA = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskAId) as { status: string }
          expect(tA.status).toBe('dropped')

          const attB = db.prepare('SELECT COUNT(*) as c FROM attempts WHERE task_id = ?').get(taskBId) as { c: number }
          const attC = db.prepare('SELECT COUNT(*) as c FROM attempts WHERE task_id = ?').get(taskCId) as { c: number }
          expect(attB.c).toBe(0)
          expect(attC.c).toBe(0)
        } finally {
          handle.release(Date.now())
        }
      } finally {
        db.close()
      }

      // task kill on B is applied:
      const killB = runCli(['task', 'kill', '--state-dir', stateDir, '--task', taskBId], { cwd: tempCwd })
      expect(killB.status).toBe(0)

      const db2 = openStore(join(stateDir, 'state.sqlite'))
      try {
        const handle2 = acquireSupervisor(db2, stateDir, { nowMs: Date.now(), staleAfterMs: 30000 })
        try {
          const loopDeps: LoopDeps = {
            stateDir,
            spawnWorker,
            killTree,
            readResult: readCompletion,
            isAlive: (pid, nonce) => isProcessAliveWithNonce(pid, nonce, { deadlineMs: Date.now() + 5000 }),
            staleAfterMs: 30000,
          }

          await runTick(db2, handle2, loopDeps, Date.now())

          const tBAfter = db2.prepare('SELECT status FROM tasks WHERE id = ?').get(taskBId) as { status: string }
          expect(tBAfter.status).toBe('dropped')

          const outcomeB = db2.prepare("SELECT outcome FROM command_outcomes c JOIN commands cmd ON cmd.id = c.command_id WHERE cmd.kind = 'task.kill' AND json_extract(cmd.payload_json, '$.taskId') = ?").get(taskBId) as { outcome: string } | undefined
          expect(outcomeB?.outcome).toBe('applied')
        } finally {
          handle2.release(Date.now())
        }
      } finally {
        db2.close()
      }
    },
    90000,
  )

  it(
    'CHK-M5-06-c: A failed (budget spent) -> B stays ready with waiting reason deps, the Supervisor goes idle (--exit-when-idle exits); task retry A -> A succeeds, then B runs',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'm5-06-c-'))
      directories.push(root)
      const repoDir = join(root, 'repo')
      const stateDir = join(root, 'state')
      const tempCwd = join(root, 'cwd')
      mkdirSync(tempCwd, { recursive: true })

      createGitRepo(repoDir)
      const initRes = runCli(['init', '--state-dir', stateDir, '--repo', repoDir], { cwd: tempCwd })
      expect(initRes.status).toBe(0)

      const taskAId = randomUUID()
      const taskBId = randomUUID()

      const createA = runCli(
        ['task', 'create', '--state-dir', stateDir, '--title', 'Task A', '--scope', 'src/a', '--scope', `factory-fake/${taskAId}.txt`, '--max-attempts', '1', '--command-id', taskAId],
        { cwd: tempCwd },
      )
      expect(createA.status).toBe(0)

      const createB = runCli(
        ['task', 'create', '--state-dir', stateDir, '--title', 'Task B', '--scope', 'src/b', '--scope', `factory-fake/${taskBId}.txt`, '--after', taskAId, '--command-id', taskBId],
        { cwd: tempCwd },
      )
      expect(createB.status).toBe(0)

      // Start supervisor with FAKE_EXIT_CODE=1 so A spends its budget (max-attempts 1) and fails:
      const startRes1 = runCli(
        ['start', '--state-dir', stateDir, '--exit-when-idle'],
        {
          cwd: tempCwd,
          env: cleanTestEnv({
            FAKE_EXIT_CODE: '1',
          }),
          timeout: 45000,
        },
      )
      expect(startRes1.status).toBe(0)

      const db = openStore(join(stateDir, 'state.sqlite'))
      try {
        const nonces = db.prepare('SELECT nonce FROM workers').all() as Array<{ nonce: string }>
        for (const n of nonces) {
          if (n.nonce) activeNonces.add(n.nonce)
        }

        const tA = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskAId) as { status: string }
        const tB = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskBId) as { status: string }
        expect(tA.status).toBe('failed')
        expect(tB.status).toBe('ready')

        const attB = db.prepare('SELECT COUNT(*) as c FROM attempts WHERE task_id = ?').get(taskBId) as { c: number }
        expect(attB.c).toBe(0)

        // Verify waiting reason: B waits with reason 'deps' on taskAId
        const projectRow = db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: string } | undefined
        const projectId = projectRow?.id ?? 'p1'
        const phases = db.prepare('SELECT name, status FROM phases WHERE project_id = ?').all(projectId) as Array<{ name: string; status: string }>
        const tasks = db.prepare('SELECT id, status, phase, scope_json, not_before_ms FROM tasks').all() as Array<{ id: string; status: string; phase: string; scope_json: string; not_before_ms: number }>
        const taskList = tasks.map((t) => {
          const deps = (db.prepare('SELECT depends_on FROM task_deps WHERE task_id = ? ORDER BY depends_on').all(t.id) as Array<{ depends_on: string }>).map((d) => d.depends_on)
          return {
            id: t.id,
            status: t.status,
            phase: t.phase,
            deps,
            scope: JSON.parse(t.scope_json) as string[],
            notBeforeMs: t.not_before_ms,
          }
        })
        const plan = planDispatch({ nowMs: Date.now(), phases, tasks: taskList })
        const waitB = plan.wait.find((w) => w.id === taskBId)
        expect(waitB).toEqual({ id: taskBId, reason: 'deps', on: [taskAId] })
      } finally {
        db.close()
      }

      // Retry task A:
      const retryA = runCli(['task', 'retry', '--state-dir', stateDir, '--task', taskAId], { cwd: tempCwd })
      expect(retryA.status).toBe(0)

      // Start supervisor again (clean test env so A succeeds on retry):
      const startRes2 = runCli(
        ['start', '--state-dir', stateDir, '--exit-when-idle'],
        {
          cwd: tempCwd,
          timeout: 45000,
        },
      )
      expect(startRes2.status).toBe(0)

      const db2 = openStore(join(stateDir, 'state.sqlite'))
      try {
        const nonces = db2.prepare('SELECT nonce FROM workers').all() as Array<{ nonce: string }>
        for (const n of nonces) {
          if (n.nonce) activeNonces.add(n.nonce)
        }

        const tAFinal = db2.prepare('SELECT status FROM tasks WHERE id = ?').get(taskAId) as { status: string }
        const tBFinal = db2.prepare('SELECT status FROM tasks WHERE id = ?').get(taskBId) as { status: string }
        expect(tAFinal.status).toBe('done')
        expect(tBFinal.status).toBe('done')

        const attA2 = db2.prepare('SELECT ended_at FROM attempts WHERE task_id = ? AND attempt_no = 2').get(taskAId) as { ended_at: string }
        const attB1 = db2.prepare('SELECT started_at FROM attempts WHERE task_id = ? AND attempt_no = 1').get(taskBId) as { started_at: string }
        expect(Date.parse(attB1.started_at)).toBeGreaterThanOrEqual(Date.parse(attA2.ended_at))
      } finally {
        db2.close()
      }
    },
    90000,
  )

  it(
    'CHK-M5-06-d: a task in a locked phase never runs; after the open phase tasks finish and phase advance is applied, it runs. A later-phase task with scope . does not stop an open-phase task',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'm5-06-d-'))
      directories.push(root)
      const repoDir = join(root, 'repo')
      const stateDir = join(root, 'state')
      const tempCwd = join(root, 'cwd')
      mkdirSync(tempCwd, { recursive: true })

      createGitRepo(repoDir)
      const initRes = runCli(['init', '--state-dir', stateDir, '--repo', repoDir], { cwd: tempCwd })
      expect(initRes.status).toBe(0)

      const task1Id = randomUUID()
      const task2Id = randomUUID()

      // Task 2 in development (locked phase) with scope . (whole repo, overlaps with src) created first:
      const create2 = runCli(
        ['task', 'create', '--state-dir', stateDir, '--title', 'Task 2 Dev', '--scope', '.', '--scope', `factory-fake/${task2Id}.txt`, '--phase', 'development', '--command-id', task2Id],
        { cwd: tempCwd },
      )
      expect(create2.status).toBe(0)

      // Task 1 in intake (open phase) with scope src created second:
      const create1 = runCli(
        ['task', 'create', '--state-dir', stateDir, '--title', 'Task 1 Intake', '--scope', 'src', '--scope', `factory-fake/${task1Id}.txt`, '--phase', 'intake', '--command-id', task1Id],
        { cwd: tempCwd },
      )
      expect(create1.status).toBe(0)

      // Start supervisor with --exit-when-idle:
      const startRes1 = runCli(
        ['start', '--state-dir', stateDir, '--exit-when-idle'],
        { cwd: tempCwd, timeout: 45000 },
      )
      expect(startRes1.status).toBe(0)

      const db = openStore(join(stateDir, 'state.sqlite'))
      try {
        const nonces = db.prepare('SELECT nonce FROM workers').all() as Array<{ nonce: string }>
        for (const n of nonces) {
          if (n.nonce) activeNonces.add(n.nonce)
        }

        // Task 1 was not stopped by Task 2's . scope and finished done:
        const t1 = db.prepare('SELECT status FROM tasks WHERE id = ?').get(task1Id) as { status: string }
        expect(t1.status).toBe('done')

        // Task 2 never ran (locked phase):
        const t2 = db.prepare('SELECT status FROM tasks WHERE id = ?').get(task2Id) as { status: string }
        expect(t2.status).toBe('ready')
        const att2 = db.prepare('SELECT COUNT(*) as c FROM attempts WHERE task_id = ?').get(task2Id) as { c: number }
        expect(att2.c).toBe(0)
      } finally {
        db.close()
      }

      // Advance intake phase:
      const advRes = runCli(
        ['phase', 'advance', '--state-dir', stateDir, '--phase', 'intake'],
        { cwd: tempCwd },
      )
      expect(advRes.status).toBe(0)

      // Start supervisor again:
      const startRes2 = runCli(
        ['start', '--state-dir', stateDir, '--exit-when-idle'],
        { cwd: tempCwd, timeout: 45000 },
      )
      expect(startRes2.status).toBe(0)

      const db2 = openStore(join(stateDir, 'state.sqlite'))
      try {
        const nonces = db2.prepare('SELECT nonce FROM workers').all() as Array<{ nonce: string }>
        for (const n of nonces) {
          if (n.nonce) activeNonces.add(n.nonce)
        }

        const t2Final = db2.prepare('SELECT status FROM tasks WHERE id = ?').get(task2Id) as { status: string }
        expect(t2Final.status).toBe('done')
        const att2Final = db2.prepare('SELECT COUNT(*) as c FROM attempts WHERE task_id = ?').get(task2Id) as { c: number }
        expect(att2Final.c).toBe(1)
      } finally {
        db2.close()
      }
    },
    90000,
  )

  it(
    'CHK-M5-06-e: Supervisor hard-killed while A runs and B (after A) waits, restarted with --takeover: A re-attempt finishes before B starts; no duplicate attempts or evidence',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'm5-06-e-'))
      directories.push(root)
      const repoDir = join(root, 'repo')
      const stateDir = join(root, 'state')
      const dbPath = join(stateDir, 'state.sqlite')
      const tempCwd = join(root, 'cwd')
      mkdirSync(tempCwd, { recursive: true })

      createGitRepo(repoDir)
      const initRes = runCli(['init', '--state-dir', stateDir, '--repo', repoDir], { cwd: tempCwd })
      expect(initRes.status).toBe(0)

      const taskAId = randomUUID()
      const taskBId = randomUUID()

      const createA = runCli(
        ['task', 'create', '--state-dir', stateDir, '--title', 'Task A', '--scope', 'src/a', '--scope', `factory-fake/${taskAId}.txt`, '--command-id', taskAId],
        { cwd: tempCwd },
      )
      expect(createA.status).toBe(0)

      const createB = runCli(
        ['task', 'create', '--state-dir', stateDir, '--title', 'Task B', '--scope', 'src/b', '--scope', `factory-fake/${taskBId}.txt`, '--after', taskAId, '--command-id', taskBId],
        { cwd: tempCwd },
      )
      expect(createB.status).toBe(0)

      const runsDir = join(stateDir, 'runs')

      // Spawn supervisor 1 in background:
      const sup1Marker = `factory-supervisor-${randomUUID()}`
      const sup1 = spawn(
        process.execPath,
        [
          `--title=${sup1Marker}`,
          cliPath,
          'start',
          '--state-dir', stateDir,
          '--heartbeat-ms', '200',
          '--stale-after-ms', '1000',
        ],
        {
          cwd: tempCwd,
          env: cleanTestEnv({
            FAKE_SLEEP_MS: '30000',
            FACTORY_SUPERVISOR_MARKER: sup1Marker,
          }),
          stdio: 'ignore',
          windowsHide: true,
        },
      )
      if (sup1.pid) {
        spawnedSupervisors.push({ child: sup1, pid: sup1.pid, marker: sup1Marker })
      }

      try {
        const publishedWorker = await waitForWorkerPublication(runsDir, 25000)
        activeNonces.add(publishedWorker.nonce)

        // Verify Task A attempt 1 is running, Task B has 0 attempts:
        const dbRunning = openStore(dbPath)
        try {
          const attA = dbRunning.prepare('SELECT status FROM attempts WHERE id = ?').get(publishedWorker.attemptId) as { status: string } | undefined
          expect(attA?.status).toBe('running')
          const attBCount = dbRunning.prepare('SELECT COUNT(*) as c FROM attempts WHERE task_id = ?').get(taskBId) as { c: number }
          expect(attBCount.c).toBe(0)
        } finally {
          dbRunning.close()
        }

        // Revalidate command-line marker immediately before hard kill on both platforms:
        expect(isProcessAliveWithNonce(sup1.pid!, sup1Marker, 5000)).toBe(true)
        await killIfOurs(sup1, { tree: false })

        const sup1Dead = await waitForProcessDeath(sup1.pid!, 15000, sup1Marker)
        expect(sup1Dead).toBe(true)

        // Confirm supervisor dead, worker still alive:
        expect(isProcessAliveWithNonce(sup1.pid!, sup1Marker)).toBe(false)
        expect(isProcessAliveWithNonce(publishedWorker.pid, publishedWorker.nonce)).toBe(true)

        // Capture lease takeover evidence:
        let lease: { owner_id: string; generation: number; heartbeat_ms: number } | undefined
        const dbLease = openStore(dbPath)
        try {
          lease = dbLease.prepare('SELECT owner_id, generation, heartbeat_ms FROM supervisor_lease WHERE id = 1').get() as {
            owner_id: string
            generation: number
            heartbeat_ms: number
          }
        } finally {
          dbLease.close()
        }
        expect(lease).toBeDefined()
        const takeoverEvidence = `${lease!.owner_id}:${lease!.generation}:${lease!.heartbeat_ms}`

        // Wait for staleness:
        const staleDeadline = lease!.heartbeat_ms + 1000 + 200
        const waitMs = Math.max(0, staleDeadline - Date.now())
        if (waitMs > 0) await delay(waitMs)

        // Restart supervisor 2 with takeover:
        const start2Res = runCli(
          [
            'start',
            '--state-dir', stateDir,
            '--exit-when-idle',
            '--takeover', takeoverEvidence,
            '--stale-after-ms', '1000',
          ],
          {
            cwd: tempCwd,
            env: cleanTestEnv({
              FAKE_SLEEP_MS: '200',
            }),
            timeout: 60000,
          },
        )
        expect(start2Res.status).toBe(0)

        const dbFinal = openStore(dbPath)
        try {
          const nonces = dbFinal.prepare('SELECT nonce FROM workers').all() as Array<{ nonce: string }>
          for (const n of nonces) {
            if (n.nonce) activeNonces.add(n.nonce)
          }

          const attemptsA = dbFinal.prepare('SELECT attempt_no, status, started_at, ended_at FROM attempts WHERE task_id = ? ORDER BY attempt_no').all(taskAId) as Array<{
            attempt_no: number
            status: string
            started_at: string
            ended_at: string
          }>
          const attemptsB = dbFinal.prepare('SELECT attempt_no, status, started_at, ended_at FROM attempts WHERE task_id = ? ORDER BY attempt_no').all(taskBId) as Array<{
            attempt_no: number
            status: string
            started_at: string
            ended_at: string
          }>

          expect(attemptsA).toHaveLength(2)
          expect(attemptsA[0]!.status).toBe('interrupted')
          expect(attemptsA[1]!.status).toBe('succeeded')

          expect(attemptsB).toHaveLength(1)
          expect(attemptsB[0]!.status).toBe('succeeded')

          // A's re-attempt finishes before B starts:
          const startB = Date.parse(attemptsB[0]!.started_at)
          const endA2 = Date.parse(attemptsA[1]!.ended_at)
          expect(startB).toBeGreaterThanOrEqual(endA2)

          // No duplicate attempts or evidence:
          const evA = dbFinal.prepare('SELECT COUNT(*) as c FROM evidence e JOIN attempts a ON a.id = e.attempt_id WHERE a.task_id = ?').get(taskAId) as { c: number }
          const evB = dbFinal.prepare('SELECT COUNT(*) as c FROM evidence e JOIN attempts a ON a.id = e.attempt_id WHERE a.task_id = ?').get(taskBId) as { c: number }
          expect(evA.c).toBe(1)
          expect(evB.c).toBe(1)

          const tA = dbFinal.prepare('SELECT status FROM tasks WHERE id = ?').get(taskAId) as { status: string }
          const tB = dbFinal.prepare('SELECT status FROM tasks WHERE id = ?').get(taskBId) as { status: string }
          expect(tA.status).toBe('done')
          expect(tB.status).toBe('done')
        } finally {
          dbFinal.close()
        }
      } finally {
        collectNoncesFromDatabases()
      }
    },
    90000,
  )
})
