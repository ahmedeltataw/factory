// CHK-M3-06-f Property Test Contract:
//
// Property: Random create / tick / crash / restart / kill sequences never give a task
// two live attempts or an attempt two evidence rows.
//
// Invariants verified after every step:
// 1. At most one live simulated process per task (verified continuously and at effect boundaries).
// 2. At most one evidence row per attempt (evidence immutability).
// 3. No live process for any interrupted, killed, or terminal attempt.
// 4. Terminal tasks (done, failed, dropped) have zero live attempts and zero live simulated processes.
// 5. Total attempts per task are strictly bounded by MAX_ATTEMPTS.
// 6. Completion and evidence production paths are exercised deterministically across runs.
// 7. Spawn and kill logs match the independent process model transitions (replay assertions).
//
// Documented Time Budget:
// - Fast-check configuration: numRuns: 10, endOnFailure: true to bound execution and prevent shrinking delays.
// - Real bounded git repo fixture created per example (git init with timeout and GIT_TERMINAL_PROMPT=0).
// - Independent process model (taskId, attemptId -> simulated process state) tracking liveness and lifecycle.
// - Effect boundary assertions: stubbed spawnWorker asserts, before accepting a spawn, that no live
//   process exists for the task, recording violations in a list asserted empty. killTree updates model immediately.
// - Injected deps seams: { spawnWorker, killTree, isAlive(pid, nonce), readResult(runDir) }, where
//   readResult returns the completion record exactly as supervisor/src/executors/fake-executor.ts writes it
//   (<runDir>/result.json {"exitCode": n} written atomically before normal exit; absent on kill/crash)
//   or undefined while running or when worker lost without result.json.
// - Deterministic execution of successful completion and evidence production within each example.
// - In-process crash simulation releases OS lock/handle, preserves active lease row in database, and takes over
//   with exact evidence from the row once stale.

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
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
import {
  AttemptStatusSchema,
  TaskStatusSchema,
  WorkerStateSchema,
} from '../../supervisor/src/app/domain.ts'
import type { EnsureWorktreeConfig } from '../../supervisor/src/app/worktree.ts'

const directories: string[] = []

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

afterEach(() => {
  const failed: string[] = []
  for (const dir of [...directories]) {
    try {
      safeRemoveDir(dir)
      const idx = directories.indexOf(dir)
      if (idx !== -1) directories.splice(idx, 1)
    } catch (e: any) {
      failed.push(`${dir}: ${e.message}`)
    }
  }
  if (failed.length > 0) {
    throw new Error(`Directory cleanup failed:\n${failed.join('\n')}`)
  }
})

function initGitRepo(repoDir: string): string {
  mkdirSync(repoDir, { recursive: true })
  execFileSync(
    'git',
    [
      '-c', 'user.name=Factory Test',
      '-c', 'user.email=factory@example.test',
      '-c', 'core.hooksPath=',
      'init',
    ],
    {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    },
  )
  execFileSync(
    'git',
    ['config', 'core.autocrlf', 'false'],
    { cwd: repoDir, timeout: 5000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
  )
  writeFileSync(join(repoDir, 'README.md'), '# Property Repo\n', 'utf8')
  execFileSync(
    'git',
    ['add', '.'],
    { cwd: repoDir, timeout: 5000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
  )
  execFileSync(
    'git',
    [
      '-c', 'user.name=Factory Test',
      '-c', 'user.email=factory@example.test',
      'commit',
      '-m', 'Initial commit',
    ],
    { cwd: repoDir, timeout: 10000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
  )
  const baseSha = execFileSync(
    'git',
    ['rev-parse', 'HEAD'],
    { cwd: repoDir, encoding: 'utf8', timeout: 5000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
  ).trim()
  return baseSha
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
}

type Action =
  | { type: 'createTask'; title: string }
  | { type: 'killTask'; taskIndex: number }
  | { type: 'tick' }
  | { type: 'crashAndRestart' }
  | { type: 'completeWorker'; success: boolean }

const actionArbitrary: fc.Arbitrary<Action> = fc.oneof(
  { arbitrary: fc.string({ minLength: 1, maxLength: 30 }).map((title) => ({ type: 'createTask' as const, title })), weight: 3 },
  { arbitrary: fc.nat({ max: 15 }).map((taskIndex) => ({ type: 'killTask' as const, taskIndex })), weight: 2 },
  { arbitrary: fc.constant({ type: 'tick' as const }), weight: 5 },
  { arbitrary: fc.constant({ type: 'crashAndRestart' as const }), weight: 2 },
  { arbitrary: fc.boolean().map((success) => ({ type: 'completeWorker' as const, success })), weight: 3 },
)

const sequenceArbitrary = fc.array(actionArbitrary, { minLength: 10, maxLength: 25 })

describe('CHK-M3-06-f: recovery and lifecycle property invariants', () => {
  it(
    'CHK-M3-06-f: random create/tick/crash/restart/kill sequences never give a task two live attempts or an attempt two evidence rows',
    async () => {
      expect(typeof MAX_ATTEMPTS).toBe('number')
      expect(Number.isSafeInteger(MAX_ATTEMPTS) && MAX_ATTEMPTS >= 1).toBe(true)

      let totalCompletedAttempts = 0
      let totalEvidenceRows = 0

      await fc.assert(
        fc.asyncProperty(sequenceArbitrary, async (actions) => {
          const rootDir = mkdtempSync(join(tmpdir(), `factory-prop-${randomUUID().slice(0, 8)}-`))
          directories.push(rootDir)

          const repoDir = join(rootDir, 'repo')
          const stateDir = join(rootDir, 'state')
          mkdirSync(stateDir, { recursive: true })

          const baseSha = initGitRepo(repoDir)
          const dbPath = join(stateDir, 'state.sqlite')
          const spawnLog = join(stateDir, 'spawn-records.log')
          const killLog = join(stateDir, 'kill-records.log')
          writeFileSync(spawnLog, '', 'utf8')
          writeFileSync(killLog, '', 'utf8')

          let db: DatabaseSync | undefined
          let handle: SupervisorLeaseHandle | undefined
          let currentTime = 1000
          let simulatedPidCounter = 1000

          const simulatedProcesses = new Map<number, SimulatedProcess>()
          const createdTaskIds: string[] = []
          const boundaryViolations: string[] = []

          try {
            db = openStore(dbPath)
            handle = acquireSupervisor(db, stateDir, { nowMs: currentTime, staleAfterMs: 1000 })

            const projectId = 'proj-prop-1'
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
                // Invariant check at effect boundary: assert BEFORE accepting a spawn that
                // the process model has no live process for that task.
                const liveExisting = Array.from(simulatedProcesses.values()).filter(
                  (p) => p.taskId === taskId && p.alive,
                )
                if (liveExisting.length > 0) {
                  const pids = liveExisting.map((p) => p.pid).join(', ')
                  const violation = `Invariant violation at spawnWorker effect boundary: Task ${taskId} already has live process(es) [${pids}] before accepting spawn of attempt ${attemptId}`
                  boundaryViolations.push(violation)
                  expect(liveExisting.length, violation).toBe(0)
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
                }
                simulatedProcesses.set(pid, proc)

                appendFileSync(
                  spawnLog,
                  JSON.stringify({ event: 'spawn', pid, nonce, taskId, attemptId, time: currentTime }) + '\n',
                  'utf8',
                )

                mkdirSync(runDir, { recursive: true })
                writeFileSync(
                  join(runDir, 'worker.json'),
                  JSON.stringify({ pid, nonce, grandchildPid: pid + 5000 }),
                  'utf8',
                )
                writeFileSync(join(runDir, 'stdout.log'), 'simulated executor stdout\n', 'utf8')
                writeFileSync(join(runDir, 'stderr.log'), '', 'utf8')

                // Provide deterministic fake executor output file
                const fakeDir = join(cwd, 'factory-fake')
                mkdirSync(fakeDir, { recursive: true })
                writeFileSync(join(fakeDir, `${taskId}.txt`), `completed by ${attemptId}\n`, 'utf8')

                return { pid, nonce }
              },
              killTree: async (pid, nonce) => {
                appendFileSync(
                  killLog,
                  JSON.stringify({ event: 'kill', pid, nonce, time: currentTime }) + '\n',
                  'utf8',
                )
                const proc = simulatedProcesses.get(pid)
                if (!proc || !proc.alive) {
                  return { result: 'not-running' }
                }
                if (proc.nonce !== nonce) {
                  return { result: 'identity-mismatch' }
                }
                // KillTree stub updates the process model immediately
                proc.alive = false
                return { result: 'killed' }
              },
              isAlive: (pid: number, nonce: string) => {
                const proc = simulatedProcesses.get(pid)
                return proc ? (proc.alive && proc.nonce === nonce) : false
              },
              readResult: (runDir: string) => {
                const resultPath = join(runDir, 'result.json')
                if (existsSync(resultPath)) {
                  try {
                    const raw = readFileSync(resultPath, 'utf8')
                    const parsed = JSON.parse(raw) as { exitCode: number }
                    if (parsed && typeof parsed.exitCode === 'number') {
                      return { exitCode: parsed.exitCode }
                    }
                  } catch {
                    return undefined
                  }
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
              // 1. Independent process model: at most one live simulated process per task
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
              const allTasks = db!.prepare('SELECT id, status FROM tasks').all() as Array<{
                id: string
                status: string
              }>

              for (const task of allTasks) {
                expect(TaskStatusSchema.safeParse(task.status).success).toBe(true)

                const liveAttempts = db!.prepare(
                  "SELECT id, status FROM attempts WHERE task_id = ? AND status IN ('pending', 'running')",
                ).all(task.id) as Array<{ id: string; status: string }>

                expect(
                  liveAttempts.length,
                  `Task ${task.id} has ${liveAttempts.length} live attempts; maximum allowed is 1`,
                ).toBeLessThanOrEqual(1)

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

                const totalAttempts = (
                  db!.prepare('SELECT COUNT(*) as c FROM attempts WHERE task_id = ?').get(task.id) as { c: number }
                ).c
                expect(
                  totalAttempts,
                  `Task ${task.id} exceeded MAX_ATTEMPTS (${MAX_ATTEMPTS})`,
                ).toBeLessThanOrEqual(MAX_ATTEMPTS)
              }

              // 3. Database attempts and evidence invariants
              const allAttempts = db!.prepare('SELECT id, task_id, status FROM attempts').all() as Array<{
                id: string
                task_id: string
                status: string
              }>

              for (const attempt of allAttempts) {
                expect(AttemptStatusSchema.safeParse(attempt.status).success).toBe(true)

                // Immutable evidence constraint: at most 1 evidence row per attempt
                const evCount = (
                  db!.prepare('SELECT COUNT(*) as c FROM evidence WHERE attempt_id = ?').get(
                    attempt.id,
                  ) as { c: number }
                ).c
                expect(
                  evCount,
                  `Attempt ${attempt.id} has ${evCount} evidence rows; maximum allowed is 1`,
                ).toBeLessThanOrEqual(1)

                // No live process for interrupted, killed, or terminal attempt
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

              // 4. Worker states conform to domain schema
              const allWorkers = db!.prepare('SELECT state FROM workers').all() as Array<{
                state: string
              }>
              for (const w of allWorkers) {
                expect(WorkerStateSchema.safeParse(w.state).success).toBe(true)
              }
            }

            for (const action of actions) {
              currentTime += 100

              switch (action.type) {
                case 'createTask': {
                  const commandId = randomUUID()
                  const payload = JSON.stringify({ title: action.title.trim() || 'Untitled' })
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

                case 'killTask': {
                  if (createdTaskIds.length > 0) {
                    const targetTaskId = createdTaskIds[action.taskIndex % createdTaskIds.length]!
                    const commandId = randomUUID()
                    appendCommand(db, {
                      id: commandId,
                      projectId,
                      kind: 'task.kill',
                      payloadJson: JSON.stringify({ taskId: targetTaskId }),
                      createdAt: new Date(currentTime).toISOString(),
                    })
                  }
                  break
                }

                case 'tick': {
                  await runTick(db, handle, loopDeps, currentTime)
                  break
                }

                case 'crashAndRestart': {
                  // Read exact persisted lease row before release
                  const oldRow = db.prepare('SELECT owner_id AS ownerId, generation, heartbeat_ms AS heartbeatMs FROM supervisor_lease WHERE id = 1').get() as {
                    ownerId: string
                    generation: number
                    heartbeatMs: number
                  }

                  // Release OS lock/handle
                  handle.release(currentTime)

                  // Restore active status to model a crashed owner who never cleanly released
                  db.prepare("UPDATE supervisor_lease SET status = 'active' WHERE id = 1").run()

                  // Advance time past stale window relative to persisted heartbeat
                  currentTime = Math.max(currentTime, oldRow.heartbeatMs + 1000)

                  // Reacquire with exact takeover evidence from the persisted row
                  handle = acquireSupervisor(db, stateDir, {
                    nowMs: currentTime,
                    staleAfterMs: 1000,
                    takeover: oldRow,
                  })

                  // Reconcile older-generation workers on startup
                  await reconcileWorkers(db, handle, recoveryDeps, currentTime)
                  break
                }

                case 'completeWorker': {
                  // Completion enters through the simulated executor interface
                  const liveProcs = Array.from(simulatedProcesses.values()).filter((p) => p.alive)
                  if (liveProcs.length > 0) {
                    const target = liveProcs[0]!
                    target.alive = false
                    target.exitCode = action.success ? 0 : 1

                    // Atomically write <runDir>/result.json {"exitCode": n} before normal exit
                    const resultPath = join(target.runDir, 'result.json')
                    const tempResult = `${resultPath}.${randomUUID()}.tmp`
                    writeFileSync(tempResult, JSON.stringify({ exitCode: target.exitCode }), 'utf8')
                    renameSync(tempResult, resultPath)

                    if (action.success) {
                      // Provide fake executor output file for evidence generation
                      const fakeDir = join(target.cwd, 'factory-fake')
                      mkdirSync(fakeDir, { recursive: true })
                      writeFileSync(join(fakeDir, `${target.taskId}.txt`), `completed by ${target.attemptId}\n`, 'utf8')
                    } else {
                      // Remove fake executor output to simulate execution failure
                      const fakeFile = join(target.cwd, 'factory-fake', `${target.taskId}.txt`)
                      if (existsSync(fakeFile)) {
                        try {
                          rmSync(fakeFile, { force: true })
                        } catch {
                          // ignore
                        }
                      }
                    }

                    // Advance loop tick to process liveness check and attempt completion via readResult seam
                    await runTick(db, handle, loopDeps, currentTime)
                  }
                  break
                }
              }

              assertInvariants()
            }

            // Deterministically exercise successful completion and evidence production within each property run:
            const detTaskId = randomUUID()
            appendCommand(db, {
              id: detTaskId,
              projectId,
              kind: 'task.create',
              payloadJson: JSON.stringify({ title: 'Deterministic Completion Task' }),
              createdAt: new Date((currentTime += 100)).toISOString(),
            })

            // Tick to dispatch task and spawn worker
            await runTick(db, handle, loopDeps, (currentTime += 100))

            // Find the live simulated process spawned for this deterministic task
            const detLiveProcs = Array.from(simulatedProcesses.values()).filter(
              (p) => p.taskId === detTaskId && p.alive,
            )
            expect(detLiveProcs.length).toBe(1)
            const detProc = detLiveProcs[0]!

            // Supply exit code 0 through result.json and ensure fake output file exists
            detProc.alive = false
            detProc.exitCode = 0
            const detResultPath = join(detProc.runDir, 'result.json')
            const detTempResult = `${detResultPath}.${randomUUID()}.tmp`
            writeFileSync(detTempResult, JSON.stringify({ exitCode: 0 }), 'utf8')
            renameSync(detTempResult, detResultPath)

            const detFakeDir = join(detProc.cwd, 'factory-fake')
            mkdirSync(detFakeDir, { recursive: true })
            writeFileSync(join(detFakeDir, `${detTaskId}.txt`), `completed by ${detProc.attemptId}\n`, 'utf8')

            // Advance tick: readResult seam supplies exitCode 0 from result.json, supervisor records succeeded attempt and produces evidence
            await runTick(db, handle, loopDeps, (currentTime += 100))

            // Verify evidence row was produced for this attempt
            const detEvCount = (
              db.prepare('SELECT COUNT(*) as c FROM evidence WHERE attempt_id = ?').get(detProc.attemptId) as { c: number }
            ).c
            expect(detEvCount).toBe(1)

            assertInvariants()
            expect(boundaryViolations).toEqual([])

            // Replay assertions: verify spawn and kill logs match simulated process model transitions
            const spawnLines = readFileSync(spawnLog, 'utf8').trim().split('\n').filter(Boolean)
            const killLines = readFileSync(killLog, 'utf8').trim().split('\n').filter(Boolean)

            for (const line of spawnLines) {
              const record = JSON.parse(line) as { pid: number; nonce: string; taskId: string; attemptId: string }
              expect(simulatedProcesses.has(record.pid)).toBe(true)
              const proc = simulatedProcesses.get(record.pid)!
              expect(proc.nonce).toBe(record.nonce)
              expect(proc.taskId).toBe(record.taskId)
              expect(proc.attemptId).toBe(record.attemptId)
            }

            for (const line of killLines) {
              const record = JSON.parse(line) as { pid: number; nonce: string }
              const proc = simulatedProcesses.get(record.pid)
              if (proc && proc.nonce === record.nonce) {
                expect(proc.alive).toBe(false)
              }
            }

            // Track completion and evidence production across runs
            const completedInRun = (
              db.prepare("SELECT COUNT(*) as c FROM attempts WHERE status = 'succeeded'").get() as { c: number }
            ).c
            const evidenceInRun = (
              db.prepare('SELECT COUNT(*) as c FROM evidence').get() as { c: number }
            ).c
            totalCompletedAttempts += completedInRun
            totalEvidenceRows += evidenceInRun
          } finally {
            if (handle) {
              try {
                handle.release(currentTime + 500)
              } catch {
                // handle may be lost or displaced on crash paths
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
        }),
        {
          numRuns: 10,
          endOnFailure: true,
        },
      )

      // Require that completion and evidence generation paths are actually exercised across runs
      expect(totalCompletedAttempts).toBeGreaterThan(0)
      expect(totalEvidenceRows).toBeGreaterThan(0)
    },
    // Explicit per-test timeout matching documented budget (measured basis: numRuns 10, ~5-8 s per example on Windows)
    180000,
  )
})
