import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { applyPendingCommands } from '../../supervisor/src/app/apply-commands.ts'
import { appendCommand } from '../../supervisor/src/app/commands.ts'
import { openStore } from '../../supervisor/src/app/store.ts'
import { acquireSupervisor, type SupervisorLeaseHandle } from '../../supervisor/src/app/supervisor-lease.ts'
import { runTick, type LoopDeps } from '../../supervisor/src/app/supervisor-loop.ts'
import { reconcileWorkers } from '../../supervisor/src/app/recovery.ts'
import { PHASES, type PhaseName, phaseOrd } from '../../supervisor/src/core/graph.ts'
import { scopesOverlap } from '../../supervisor/src/core/scope.ts'

const directories: string[] = []

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

afterEach(() => {
  for (const dir of directories) {
    try {
      safeRemoveDir(dir)
    } catch {}
  }
  directories.length = 0
})

interface GenTask {
  readonly id: string
  readonly title: string
  readonly phase: PhaseName
  readonly scope: string[]
  readonly deps: string[]
  readonly willFail: boolean
}

interface SimulatedWorker {
  readonly taskId: string
  readonly attemptId: string
  readonly pid: number
  readonly nonce: string
  readonly startMs: number
  readonly durationMs: number
  readonly willFail: boolean
}

describe('M5-06 dispatch property testing', () => {
  it(
    'CHK-M5-06-f: property: random graphs, phases, kills, failures, retries, advances and restarts never start a task before all its deps are done and its phase is open, never run two overlapping tasks at once (M4), and every task ends in done, blocked, dropped or failed once no commands remain',
    async () => {
      const taskScopes = [['.'], ['src'], ['src/a'], ['src/b'], ['lib'], ['docs']]

      const taskListArb = fc.integer({ min: 3, max: 6 }).chain((count) => {
        const tasks: fc.Arbitrary<GenTask>[] = []
        for (let i = 0; i < count; i++) {
          const taskId = `task_${i}`
          const taskArb = fc.record({
            phase: fc.constantFrom<PhaseName>(...PHASES),
            scope: fc.constantFrom<string[]>(...taskScopes),
            willFail: fc.boolean(),
          }).chain((spec) => {
            const earlierIndices = Array.from({ length: i }, (_, k) => k)
            return fc.subarray(earlierIndices, { maxLength: Math.min(2, earlierIndices.length) }).map((chosen) => ({
              id: taskId,
              title: `Task ${i}`,
              phase: spec.phase,
              scope: spec.scope,
              deps: chosen.map((k) => `task_${k}`),
              willFail: spec.willFail,
            }))
          })
          tasks.push(taskArb)
        }
        return fc.tuple(...tasks)
      })

      const testRunArb = fc.record({
        tasks: taskListArb,
        killIndices: fc.subarray([0, 1, 2, 3, 4, 5]),
        retryIndices: fc.subarray([0, 1, 2, 3, 4, 5]),
        restartAtTick: fc.option(fc.integer({ min: 2, max: 15 })),
      })

      await fc.assert(
        fc.asyncProperty(testRunArb, async ({ tasks, killIndices, retryIndices, restartAtTick }) => {
          // Normalize dependencies to enforce valid DAG: phaseOrd(dep.phase) <= phaseOrd(task.phase)
          const validTasks: GenTask[] = []
          for (const t of tasks) {
            const validDeps = t.deps.filter((depId) => {
              const depTask = validTasks.find((x) => x.id === depId)
              return depTask && phaseOrd(depTask.phase) <= phaseOrd(t.phase)
            })
            validTasks.push({ ...t, deps: validDeps })
          }

          const root = mkdtempSync(join(tmpdir(), 'fc-dispatch-'))
          directories.push(root)
          const stateDir = join(root, 'state')
          mkdirSync(stateDir, { recursive: true })
          const dbPath = join(stateDir, 'state.sqlite')

          const db = openStore(dbPath)
          let handle: SupervisorLeaseHandle | undefined

          try {
            const projId = 'p1'
            const nowIso = new Date(1000).toISOString()
            db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(projId, 'Prop Project', nowIso)
            db.prepare('INSERT INTO project_config (project_id, repo_path, base_ref, created_at) VALUES (?, ?, ?, ?)').run(projId, root, 'HEAD', nowIso)

            // Seed phases: intake open, others locked
            for (const p of PHASES) {
              const ord = phaseOrd(p)
              db.prepare('INSERT OR REPLACE INTO phases (project_id, name, ord, status, opened_at, closed_at) VALUES (?, ?, ?, ?, ?, ?)')
                .run(projId, p, ord, ord === 1 ? 'open' : 'locked', ord === 1 ? nowIso : null, null)
            }

            // In-memory fulfillment triggers for outbox effects:
            db.exec(`
              CREATE TRIGGER IF NOT EXISTS auto_fulfill_worktree AFTER INSERT ON outbox
              WHEN NEW.kind = 'worktree.ensure'
              BEGIN
                UPDATE outbox SET status = 'done', last_error = 'fulfilled-test' WHERE id = NEW.id;
              END;
              CREATE TRIGGER IF NOT EXISTS auto_fulfill_evidence AFTER INSERT ON outbox
              WHEN NEW.kind = 'evidence.commit'
              BEGIN
                INSERT OR IGNORE INTO evidence (attempt_id, base_sha, head_sha, files_json, stdout_sha256, stderr_sha256, recorded_at)
                VALUES (json_extract(NEW.payload_json, '$.attemptId'), 'base', 'head', '[]', 'out', 'err', datetime('now'));
                UPDATE outbox SET status = 'done', updated_at = datetime('now') WHERE id = NEW.id;
              END;
            `)

            // Append task.create commands
            for (const t of validTasks) {
              appendCommand(db, {
                id: t.id,
                projectId: projId,
                kind: 'task.create',
                payloadJson: JSON.stringify({
                  title: t.title,
                  scope: t.scope,
                  maxAttempts: 1,
                  timeoutMs: null,
                  phase: t.phase,
                  deps: t.deps,
                }),
                createdAt: nowIso,
              })
            }

            handle = acquireSupervisor(db, stateDir, { nowMs: 1000, staleAfterMs: 300000 })
            applyPendingCommands(db, handle)

            const activeWorkers = new Map<string, SimulatedWorker>()
            let nextPid = 20000
            let currentMs = 1000
            const killedWorkerNonces = new Set<string>()

            const loopDeps: LoopDeps = {
              stateDir,
              staleAfterMs: 300000,
              spawnWorker: (options) => {
                const taskId = options.taskId
                const attemptId = options.attemptId
                const taskDef = validTasks.find((t) => t.id === taskId)
                const willFail = taskDef ? taskDef.willFail : false

                const pid = nextPid++
                const nonce = randomUUID()
                activeWorkers.set(attemptId, {
                  taskId,
                  attemptId,
                  pid,
                  nonce,
                  startMs: currentMs,
                  durationMs: 0,
                  willFail,
                })
                return { pid, nonce }
              },

              isAlive: (pid, nonce) => {
                if (killedWorkerNonces.has(nonce)) return false
                const w = [...activeWorkers.values()].find((x) => x.pid === pid && x.nonce === nonce)
                return w ? currentMs < w.startMs + w.durationMs : false
              },

              readResult: (runDir) => {
                const attemptId = basename(runDir)
                const w = activeWorkers.get(attemptId)
                if (w && currentMs >= w.startMs + w.durationMs && !killedWorkerNonces.has(w.nonce)) {
                  activeWorkers.delete(attemptId)
                  return { exitCode: w.willFail ? 1 : 0 }
                }
                return undefined
              },

              killTree: async (pid, nonce) => {
                killedWorkerNonces.add(nonce)
                const w = [...activeWorkers.values()].find((x) => x.pid === pid && x.nonce === nonce)
                if (w) activeWorkers.delete(w.attemptId)
                return { result: 'killed' as const }
              },

              wrapDispatchTasks: async <T>(fn: () => Promise<T> | T): Promise<T> => {
                const res = await fn()

                // INVARIANT 1: never start a task before all its deps are done and its phase is open
                const runningTasks = db.prepare("SELECT t.id, t.phase, t.scope_json FROM tasks t WHERE t.status = 'progress'").all() as Array<{ id: string; phase: string; scope_json: string }>
                for (const t of runningTasks) {
                  const phaseRow = db.prepare('SELECT status FROM phases WHERE project_id = ? AND name = ?').get(projId, t.phase) as { status: string } | undefined
                  expect(phaseRow?.status, `Task ${t.id} in phase ${t.phase} started while phase is ${phaseRow?.status}`).toBe('open')

                  const depRows = db.prepare('SELECT t2.id, t2.status FROM task_deps d JOIN tasks t2 ON t2.id = d.depends_on WHERE d.task_id = ?').all(t.id) as Array<{ id: string; status: string }>
                  for (const dep of depRows) {
                    expect(dep.status, `Task ${t.id} started before dependency ${dep.id} was done (status: ${dep.status})`).toBe('done')
                  }
                }

                // INVARIANT 2: never run two overlapping tasks at once (M4)
                for (let a = 0; a < runningTasks.length; a++) {
                  for (let b = a + 1; b < runningTasks.length; b++) {
                    const sA = JSON.parse(runningTasks[a]!.scope_json) as string[]
                    const sB = JSON.parse(runningTasks[b]!.scope_json) as string[]
                    expect(scopesOverlap(sA, sB), `Tasks ${runningTasks[a]!.id} and ${runningTasks[b]!.id} ran concurrently with overlapping scopes`).toBe(false)
                  }
                }

                return res
              },
            }

            const killsApplied = new Set<string>()
            const retriesApplied = new Set<string>()

            for (let tick = 0; tick < 60; tick++) {
              currentMs += 100

              // Simulated restart
              if (restartAtTick !== null && restartAtTick !== undefined && tick === restartAtTick) {
                handle.release(currentMs)
                handle = acquireSupervisor(db, stateDir, { nowMs: currentMs, staleAfterMs: 300000 })
                await reconcileWorkers(db, handle, { killTree: loopDeps.killTree, stateDir, staleAfterMs: 300000 }, currentMs)
              }

              // Mid-run kills
              for (const idx of killIndices) {
                const target = validTasks[idx]
                if (target && !killsApplied.has(target.id)) {
                  const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(target.id) as { status: string } | undefined
                  if (row && ['ready', 'progress'].includes(row.status)) {
                    appendCommand(db, {
                      id: randomUUID(),
                      projectId: projId,
                      kind: 'task.kill',
                      payloadJson: JSON.stringify({ taskId: target.id }),
                      createdAt: new Date(currentMs).toISOString(),
                    })
                    killsApplied.add(target.id)
                  }
                }
              }

              // Mid-run retries for failed tasks
              for (const idx of retryIndices) {
                const target = validTasks[idx]
                if (target && !retriesApplied.has(target.id)) {
                  const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(target.id) as { status: string } | undefined
                  if (row && row.status === 'failed') {
                    appendCommand(db, {
                      id: randomUUID(),
                      projectId: projId,
                      kind: 'task.retry',
                      payloadJson: JSON.stringify({ taskId: target.id }),
                      createdAt: new Date(currentMs).toISOString(),
                    })
                    retriesApplied.add(target.id)
                  }
                }
              }

              // Phase advance when open phase has finished all its tasks
              const openPhase = db.prepare("SELECT name FROM phases WHERE project_id = ? AND status = 'open'").get(projId) as { name: string } | undefined
              if (openPhase) {
                const unfinished = db.prepare("SELECT 1 FROM tasks WHERE project_id = ? AND phase = ? AND status NOT IN ('done', 'dropped') LIMIT 1").get(projId, openPhase.name)
                if (!unfinished) {
                  appendCommand(db, {
                    id: randomUUID(),
                    projectId: projId,
                    kind: 'phase.advance',
                    payloadJson: JSON.stringify({ phase: openPhase.name }),
                    createdAt: new Date(currentMs).toISOString(),
                  })
                }
              }

              applyPendingCommands(db, handle)
              const tickRes = await runTick(db, handle, loopDeps, currentMs)

              // Check if all work settled
              const pendingCmds = db.prepare('SELECT 1 FROM commands c WHERE NOT EXISTS (SELECT 1 FROM command_outcomes o WHERE o.command_id = c.id) LIMIT 1').get()
              if (tickRes.idle && activeWorkers.size === 0 && !pendingCmds) {
                // If the open phase is ready to advance, advance and continue loop
                const currOpen = db.prepare("SELECT name FROM phases WHERE project_id = ? AND status = 'open'").get(projId) as { name: string } | undefined
                if (currOpen) {
                  const unfin = db.prepare("SELECT 1 FROM tasks WHERE project_id = ? AND phase = ? AND status NOT IN ('done', 'dropped') LIMIT 1").get(projId, currOpen.name)
                  if (!unfin) {
                    appendCommand(db, {
                      id: randomUUID(),
                      projectId: projId,
                      kind: 'phase.advance',
                      payloadJson: JSON.stringify({ phase: currOpen.name }),
                      createdAt: new Date(currentMs).toISOString(),
                    })
                    applyPendingCommands(db, handle)
                    continue
                  }
                }
                break
              }
            }

            // INVARIANT 3: every task ends in done, blocked, dropped or failed once no commands remain
            const finalTasks = db.prepare('SELECT id, status FROM tasks').all() as Array<{ id: string; status: string }>
            for (const t of finalTasks) {
              expect(
                ['done', 'blocked', 'dropped', 'failed'],
                `Task ${t.id} ended in invalid status: ${t.status}`,
              ).toContain(t.status)
            }
          } finally {
            if (handle) {
              try { handle.release(Date.now()) } catch {}
            }
            db.close()
          }
        }),
        { numRuns: 30 },
      )
    },
    90000,
  )
})
