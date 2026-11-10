import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import * as recoveryModule from '../../supervisor/src/app/recovery.ts'
import {
  reconcileWorkers,
  type RecoveryDeps,
} from '../../supervisor/src/app/recovery.ts'
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
import {
  AttemptStatusSchema,
  TaskStatusSchema,
  WorkerStateSchema,
} from '../../supervisor/src/app/domain.ts'
import type { EnsureWorktreeConfig } from '../../supervisor/src/app/worktree.ts'

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

const directories: string[] = []

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

afterEach(() => {
  const toRemove = [...directories]
  directories.length = 0
  for (const dir of toRemove) {
    try {
      safeRemoveDir(dir)
    } catch {
      // ignore individual directory deletion failure
    }
  }
})

function initGitRepo(repoDir: string): string {
  mkdirSync(repoDir, { recursive: true })
  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'Factory Property Test'], { cwd: repoDir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'factory-prop@example.test'], { cwd: repoDir, stdio: 'ignore' })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: repoDir, stdio: 'ignore' })
  execFileSync('git', ['config', 'core.hooksPath', ''], { cwd: repoDir, stdio: 'ignore' })
  writeFileSync(join(repoDir, 'README.md'), '# Property Test Repo\n', 'utf8')
  execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' })
  execFileSync('git', ['commit', '-m', 'Initial base commit'], { cwd: repoDir, stdio: 'ignore' })
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim()
}

interface SimulatedProcess {
  pid: number
  nonce: string
  taskId: string
  attemptId: string
  cwd: string
  runDir: string
  alive: boolean
  exitCode: number
  scheduledAt: number
}

type Action =
  | { type: 'createTask'; title: string; maxAttempts: number; timeoutMs: number | null }
  | { type: 'retryTask'; taskIndex: number }
  | { type: 'tick' }
  | { type: 'advanceTime'; deltaMs: number }
  | { type: 'crashAndRestart' }
  | { type: 'completeWorker'; exitCode: 0 | 75 | 42 }

const actionArbitrary: fc.Arbitrary<Action> = fc.oneof(
  {
    arbitrary: fc.record({
      title: fc.string({ minLength: 1, maxLength: 20 }),
      maxAttempts: fc.integer({ min: 1, max: 3 }),
      timeoutMs: fc.option(fc.integer({ min: 1000, max: 3000 }), { nil: null }),
    }).map((r) => ({ type: 'createTask' as const, ...r })),
    weight: 4,
  },
  {
    arbitrary: fc.nat({ max: 15 }).map((taskIndex) => ({ type: 'retryTask' as const, taskIndex })),
    weight: 3,
  },
  {
    arbitrary: fc.constant({ type: 'tick' as const }),
    weight: 6,
  },
  {
    arbitrary: fc.integer({ min: 500, max: 3000 }).map((deltaMs) => ({ type: 'advanceTime' as const, deltaMs })),
    weight: 4,
  },
  {
    arbitrary: fc.constant({ type: 'crashAndRestart' as const }),
    weight: 2,
  },
  {
    arbitrary: fc.constantFrom(0 as const, 75 as const, 42 as const).map((exitCode) => ({
      type: 'completeWorker' as const,
      exitCode,
    })),
    weight: 5,
  },
)

const sequenceArbitrary = fc.array(actionArbitrary, { minLength: 15, maxLength: 35 })

describe('CHK-M4-05-g: recovery, retry backoff, timeout, and budget property invariants', () => {
  it(
    'CHK-M4-05-g: random exit codes, hangs, timeouts, crashes, and retries preserve lifecycle, budget, and not_before invariants',
    async () => {
      expect(recovery.RETRY_BASE_MS).toBe(1000)
      expect(recovery.RETRY_MAX_MS).toBe(60000)
      expect(outbox.OUTBOX_BACKOFF_MAX_MS).toBe(30000)

      let exercisedTimeout = false
      let exercisedSuccessfulRetry = false
      let exercisedExhaustion = false
      let exercisedBackoffBoundary = false

      const sharedRootDir = mkdtempSync(join(tmpdir(), `factory-m4-prop-shared-${randomUUID().slice(0, 8)}-`))
      directories.push(sharedRootDir)
      const repoDir = join(sharedRootDir, 'repo')
      const baseSha = initGitRepo(repoDir)

      const executeSequence = async (actions: Action[]) => {
        const rootDir = mkdtempSync(join(tmpdir(), `factory-m4-prop-${randomUUID().slice(0, 8)}-`))
        directories.push(rootDir)

        const stateDir = join(rootDir, 'state')
        mkdirSync(stateDir, { recursive: true })

        const dbPath = join(stateDir, 'state.sqlite')

          let db: DatabaseSync | undefined
          let handle: SupervisorLeaseHandle | undefined
          let currentTime = 10000
          let simulatedPidCounter = 5000

          const simulatedProcesses = new Map<number, SimulatedProcess>()
          const createdTaskIds: string[] = []
          const boundaryViolations: string[] = []

          try {
            db = openStore(dbPath)
            handle = acquireSupervisor(db, stateDir, { nowMs: currentTime, staleAfterMs: 1000 })

            const projectId = 'proj-prop-m4'
            db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(
              projectId,
              'Property Test Project',
              new Date(currentTime).toISOString(),
            )
            db.prepare('INSERT INTO project_config (project_id, repo_path, base_ref, created_at) VALUES (?, ?, ?, ?)').run(
              projectId,
              repoDir,
              baseSha,
              new Date(currentTime).toISOString(),
            )

            const worktreeConfig: EnsureWorktreeConfig = {
              stateDir,
              repoPath: repoDir,
              baseRef: baseSha,
            }

            const loopDeps: LoopDeps = {
              config: worktreeConfig,
              spawnWorker: async ({ runDir, cwd, taskId, attemptId }) => {
                // Invariant 1: no live process before accepting spawn
                const liveExisting = Array.from(simulatedProcesses.values()).filter(
                  (p) => p.taskId === taskId && p.alive,
                )
                if (liveExisting.length > 0) {
                  const pids = liveExisting.map((p) => p.pid).join(', ')
                  boundaryViolations.push(`Task ${taskId} already has live process(es) [${pids}] before accepting spawn of attempt ${attemptId}`)
                }

                // Invariant 3: attempt must not start before not_before_ms
                const taskRow = db!.prepare('SELECT not_before_ms, max_attempts, attempt_base FROM tasks WHERE id = ?').get(taskId) as {
                  not_before_ms: number
                  max_attempts: number
                  attempt_base: number
                } | undefined
                if (taskRow && currentTime < taskRow.not_before_ms) {
                  boundaryViolations.push(`Task ${taskId} spawned attempt ${attemptId} at nowMs ${currentTime} before not_before_ms ${taskRow.not_before_ms}`)
                }
                if (taskRow && taskRow.not_before_ms > 0 && currentTime >= taskRow.not_before_ms) {
                  exercisedBackoffBoundary = true
                }

                // Invariant 2: attempt number must not exceed max_attempts after attempt_base
                const attemptRow = db!.prepare('SELECT attempt_no FROM attempts WHERE id = ?').get(attemptId) as { attempt_no: number } | undefined
                if (taskRow && attemptRow) {
                  const attemptsSinceBase = attemptRow.attempt_no - taskRow.attempt_base
                  if (attemptsSinceBase > taskRow.max_attempts) {
                    boundaryViolations.push(`Task ${taskId} attempt ${attemptRow.attempt_no} exceeded max_attempts ${taskRow.max_attempts} after attempt_base ${taskRow.attempt_base}`)
                  }
                }

                const pid = simulatedPidCounter++
                const nonce = `prop-nonce-${attemptId}-${randomUUID().slice(0, 6)}`
                const proc: SimulatedProcess = {
                  pid,
                  nonce,
                  taskId,
                  attemptId,
                  cwd,
                  runDir,
                  alive: true,
                  exitCode: 0,
                  scheduledAt: currentTime,
                }
                simulatedProcesses.set(pid, proc)

                mkdirSync(runDir, { recursive: true })
                writeFileSync(
                  join(runDir, 'worker.json'),
                  JSON.stringify({ pid, nonce, grandchildPid: pid + 5000 }),
                  'utf8',
                )
                writeFileSync(join(runDir, 'stdout.log'), 'simulated stdout\n', 'utf8')
                writeFileSync(join(runDir, 'stderr.log'), '', 'utf8')

                return { pid, nonce }
              },
              killTree: async (pid, nonce) => {
                const proc = simulatedProcesses.get(pid)
                if (!proc || !proc.alive) {
                  return { result: 'not-running' }
                }
                if (proc.nonce !== nonce) {
                  return { result: 'identity-mismatch' }
                }
                proc.alive = false
                return { result: 'killed' }
              },
              isAlive: (pid: number, nonce: string) => {
                const proc = simulatedProcesses.get(pid)
                return proc ? proc.alive && proc.nonce === nonce : false
              },
              readResult: (runDir: string) => {
                const resultPath = join(runDir, 'result.json')
                try {
                  const raw = readFileSync(resultPath, 'utf8')
                  const parsed = JSON.parse(raw) as { exitCode: number }
                  if (parsed && typeof parsed.exitCode === 'number') {
                    return { exitCode: parsed.exitCode }
                  }
                } catch {
                  return undefined
                }
                return undefined
              },
              isProcessAlive: (pid: number) => {
                const proc = simulatedProcesses.get(pid)
                return proc ? proc.alive : false
              },
            }

            const recoveryDeps: RecoveryDeps = {
              killTree: loopDeps.killTree,
              stateDir,
            }

            const assertInvariants = () => {
              expect(boundaryViolations).toEqual([])

              // 1. Process model: at most one live simulated process per task
              const liveByTask = new Map<string, number>()
              for (const proc of simulatedProcesses.values()) {
                if (proc.alive) {
                  liveByTask.set(proc.taskId, (liveByTask.get(proc.taskId) ?? 0) + 1)
                }
              }
              for (const [taskId, count] of liveByTask) {
                expect(
                  count,
                  `Task ${taskId} has ${count} live simulated processes; maximum allowed is 1`,
                ).toBeLessThanOrEqual(1)
              }

              // 2. Database tasks invariants
              const allTasks = db!.prepare('SELECT id, status, max_attempts, attempt_base, not_before_ms FROM tasks').all() as Array<{
                id: string
                status: string
                max_attempts: number
                attempt_base: number
                not_before_ms: number
              }>

              for (const task of allTasks) {
                expect(TaskStatusSchema.safeParse(task.status).success).toBe(true)

                // Invariant 1: at most 1 live attempt in DB per task
                const liveAttempts = db!.prepare(
                  "SELECT id, status FROM attempts WHERE task_id = ? AND status IN ('pending', 'running')",
                ).all(task.id) as Array<{ id: string; status: string }>

                expect(
                  liveAttempts.length,
                  `Task ${task.id} has ${liveAttempts.length} live attempts; maximum allowed is 1`,
                ).toBeLessThanOrEqual(1)

                // Terminal tasks have 0 live attempts and 0 live simulated processes
                if (['done', 'failed', 'dropped'].includes(task.status)) {
                  expect(
                    liveAttempts.length,
                    `Terminal task ${task.id} (${task.status}) must not have live attempts`,
                  ).toBe(0)
                  expect(
                    liveByTask.get(task.id) ?? 0,
                    `Terminal task ${task.id} (${task.status}) must not have live processes`,
                  ).toBe(0)
                }

                // Invariant 2: total attempts since attempt_base <= max_attempts
                const totalSinceBase = (
                  db!.prepare('SELECT COUNT(*) as c FROM attempts WHERE task_id = ? AND attempt_no > ?').get(
                    task.id,
                    task.attempt_base ?? 0,
                  ) as { c: number }
                ).c

                expect(
                  totalSinceBase,
                  `Task ${task.id} exceeded max_attempts (${task.max_attempts}) after attempt_base (${task.attempt_base})`,
                ).toBeLessThanOrEqual(task.max_attempts)
              }

              // 3. Database attempts invariants
              const allAttempts = db!.prepare('SELECT id, task_id, status, exit_code, error_class FROM attempts').all() as Array<{
                id: string
                task_id: string
                status: string
                exit_code: number | null
                error_class: string | null
              }>

              for (const attempt of allAttempts) {
                expect(AttemptStatusSchema.safeParse(attempt.status).success).toBe(true)

                if (attempt.exit_code === 75) {
                  expect(attempt.error_class).toBe('transient')
                }

                // Invariant 4: at most 1 evidence row per attempt
                const evCount = (
                  db!.prepare('SELECT COUNT(*) as c FROM evidence WHERE attempt_id = ?').get(attempt.id) as { c: number }
                ).c
                expect(
                  evCount,
                  `Attempt ${attempt.id} has ${evCount} evidence rows; maximum allowed is 1`,
                ).toBeLessThanOrEqual(1)

                if (['interrupted', 'killed', 'succeeded', 'failed'].includes(attempt.status)) {
                  const liveForAttempt = Array.from(simulatedProcesses.values()).filter(
                    (p) => p.attemptId === attempt.id && p.alive,
                  )
                  expect(
                    liveForAttempt.length,
                    `Attempt ${attempt.id} (${attempt.status}) must not have live processes`,
                  ).toBe(0)
                }
              }

              // 4. Worker states
              const allWorkers = db!.prepare('SELECT state FROM workers').all() as Array<{ state: string }>
              for (const w of allWorkers) {
                expect(WorkerStateSchema.safeParse(w.state).success).toBe(true)
              }

              // Coverage marking strictly from specific DB state transitions
              const timeoutCount = (
                db!.prepare("SELECT COUNT(*) as c FROM attempts WHERE status = 'interrupted' AND error_class = 'timeout'").get() as { c: number }
              ).c
              if (timeoutCount > 0) {
                exercisedTimeout = true
              }

              const exhaustedCount = (
                db!.prepare(`
                  SELECT COUNT(*) as c FROM tasks t
                  WHERE t.status = 'failed'
                    AND (SELECT COUNT(*) FROM attempts a WHERE a.task_id = t.id AND a.attempt_no > t.attempt_base) >= t.max_attempts
                    AND EXISTS (SELECT 1 FROM attempts a WHERE a.task_id = t.id AND a.error_class IN ('transient', 'timeout'))
                `).get() as { c: number }
              ).c
              if (exhaustedCount > 0) {
                exercisedExhaustion = true
              }

              const retriedSuccessCount = (
                db!.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = 'done' AND attempt_base > 0").get() as { c: number }
              ).c
              if (retriedSuccessCount > 0) {
                exercisedSuccessfulRetry = true
              }
            }

            for (const action of actions) {
              switch (action.type) {
                case 'createTask': {
                  currentTime += 50
                  const commandId = randomUUID()
                  // Normalized payload with distinct disjoint scope
                  const payload = JSON.stringify({
                    title: action.title.trim() || 'Untitled',
                    scope: [`task-${commandId}`],
                    maxAttempts: action.maxAttempts,
                    timeoutMs: action.timeoutMs,
                  })
                  appendCommand(db, {
                    id: commandId,
                    projectId,
                    kind: 'task.create',
                    payloadJson: payload,
                    createdAt: new Date(currentTime).toISOString(),
                  })
                  createdTaskIds.push(commandId)
                  break
                }

                case 'retryTask': {
                  if (createdTaskIds.length > 0) {
                    currentTime += 50
                    const targetTaskId = createdTaskIds[action.taskIndex % createdTaskIds.length]!
                    const commandId = randomUUID()
                    appendCommand(db, {
                      id: commandId,
                      projectId,
                      kind: 'task.retry',
                      payloadJson: JSON.stringify({ taskId: targetTaskId }),
                      createdAt: new Date(currentTime).toISOString(),
                    })
                  }
                  break
                }

                case 'tick': {
                  currentTime += 50
                  await runTick(db, handle, loopDeps, currentTime)
                  break
                }

                case 'advanceTime': {
                  currentTime += action.deltaMs
                  break
                }

                case 'crashAndRestart': {
                  const oldRow = db.prepare('SELECT owner_id AS ownerId, generation, heartbeat_ms AS heartbeatMs FROM supervisor_lease WHERE id = 1').get() as {
                    ownerId: string
                    generation: number
                    heartbeatMs: number
                  }

                  handle.release(currentTime)
                  db.prepare("UPDATE supervisor_lease SET status = 'active' WHERE id = 1").run()

                  currentTime = Math.max(currentTime, oldRow.heartbeatMs + 1000)

                  handle = acquireSupervisor(db, stateDir, {
                    nowMs: currentTime,
                    staleAfterMs: 1000,
                    takeover: oldRow,
                  })

                  await reconcileWorkers(db, handle, recoveryDeps, currentTime)
                  break
                }

                case 'completeWorker': {
                  const liveProcs = Array.from(simulatedProcesses.values()).filter((p) => p.alive)
                  if (liveProcs.length > 0) {
                    const target = liveProcs[0]!
                    target.alive = false
                    target.exitCode = action.exitCode

                    const resultPath = join(target.runDir, 'result.json')
                    const tempResult = `${resultPath}.${randomUUID()}.tmp`
                    writeFileSync(tempResult, JSON.stringify({ exitCode: target.exitCode }), 'utf8')
                    renameSync(tempResult, resultPath)

                    if (action.exitCode === 0) {
                      const fakeDir = join(target.cwd, 'factory-fake')
                      mkdirSync(fakeDir, { recursive: true })
                      writeFileSync(join(fakeDir, `${target.taskId}.txt`), `completed by ${target.attemptId}\n`, 'utf8')
                    }

                    currentTime += 50
                    await runTick(db, handle, loopDeps, currentTime)
                  }
                  break
                }
              }

              assertInvariants()
            }

          } finally {
            if (handle) {
              try {
                handle.release(currentTime)
              } catch {
                // ignore
              }
            }
            if (db) {
              try {
                db.close()
              } catch {
                // ignore
              }
            }
          }
      }

      // 1. Guaranteed sequence exercising timeout, backoff boundary, budget exhaustion, and successful manual retry
      const guaranteedScenario: Action[] = [
        { type: 'createTask', title: 'Guaranteed Task', maxAttempts: 2, timeoutMs: 1500 },
        { type: 'tick' },
        { type: 'advanceTime', deltaMs: 1600 },
        { type: 'tick' },
        { type: 'advanceTime', deltaMs: 1100 },
        { type: 'tick' },
        { type: 'completeWorker', exitCode: 75 },
        { type: 'tick' },
        { type: 'retryTask', taskIndex: 0 },
        { type: 'tick' },
        { type: 'completeWorker', exitCode: 0 },
        { type: 'tick' },
      ]

      await executeSequence(guaranteedScenario)

      // 2. Randomized property testing verifying lifecycle invariants across 15 runs
      await fc.assert(
        fc.asyncProperty(sequenceArbitrary, executeSequence),
        { numRuns: 15, endOnFailure: true },
      )

      expect(exercisedTimeout).toBe(true)
      expect(exercisedSuccessfulRetry).toBe(true)
      expect(exercisedExhaustion).toBe(true)
      expect(exercisedBackoffBoundary).toBe(true)
    },
    180000,
  )
})
