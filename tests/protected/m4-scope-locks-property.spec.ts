import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { appendCommand } from '../../supervisor/src/app/commands.ts'
import { openStore } from '../../supervisor/src/app/store.ts'
import { acquireSupervisor } from '../../supervisor/src/app/supervisor-lease.ts'
import { runTick, type LoopDeps } from '../../supervisor/src/app/supervisor-loop.ts'
import { parseScope, scopesOverlap } from '../../supervisor/src/core/scope.ts'

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
      stdio: 'ignore',
      timeout: 15000,
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
    [
      '-c', 'user.name=Factory Test',
      '-c', 'user.email=factory@example.test',
      '-c', 'core.hooksPath=',
      'add', '.',
    ],
    { cwd: repoDir, timeout: 15000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
  )
  execFileSync(
    'git',
    [
      '-c', 'user.name=Factory Test',
      '-c', 'user.email=factory@example.test',
      '-c', 'core.hooksPath=',
      'commit', '-m', 'Initial commit',
    ],
    { cwd: repoDir, timeout: 15000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
  )
  return execFileSync(
    'git',
    ['rev-parse', 'HEAD'],
    { cwd: repoDir, encoding: 'utf8', timeout: 15000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
  ).trim()
}

afterEach(() => {
  for (const dir of [...directories]) {
    try {
      safeRemoveDir(dir)
    } catch {
      // ignore
    }
  }
  directories.length = 0
})

const alphabet = ['a', 'b', 'c'] as const
const segment = fc.constantFrom(...alphabet)
const pathEntry = fc.array(segment, { minLength: 1, maxLength: 2 }).map((parts) => parts.join('/'))
const scopeArbitrary = fc.oneof(
  { weight: 1, arbitrary: fc.constant(['.']) },
  {
    weight: 7,
    arbitrary: fc.array(pathEntry, { minLength: 1, maxLength: 2 }).map((entries) => {
      const res = parseScope(entries)
      return res.ok ? res.scope : ['a']
    }),
  },
)

interface PropertyTaskSpec {
  title: string
  scope: string[]
  durationTicks: number
}

const taskSpecArbitrary = fc.record({
  title: fc.stringMatching(/^[a-zA-Z0-9_-]{1,16}$/),
  scope: scopeArbitrary,
  durationTicks: fc.integer({ min: 1, max: 2 }),
})

const taskSetArbitrary = fc.array(taskSpecArbitrary, { minLength: 3, maxLength: 6 })

interface SimulatedWorker {
  pid: number
  nonce: string
  taskId: string
  attemptId: string
  spawnedAtTick: number
  durationTicks: number
  completed: boolean
}

describe('M4-06 scope lock property tests', () => {
  it(
    'CHK-M4-06-e: no two progress tasks ever have overlapping scopes, and all tasks eventually leave ready',
    async () => {
      await fc.assert(
        fc.asyncProperty(taskSetArbitrary, async (taskSpecs) => {
          const root = mkdtempSync(join(tmpdir(), 'm4-06-prop-'))
          directories.push(root)
          const repoDir = join(root, 'repo')
          const stateDir = join(root, 'state')
          mkdirSync(stateDir, { recursive: true })

          const baseSha = initGitRepo(repoDir)
          const dbPath = join(stateDir, 'state.sqlite')

          const db = openStore(dbPath)
          let simulatedNow = 1000
          let tickCount = 0
          let nextPid = 1000
          const workers = new Map<number, SimulatedWorker>()

          const projectId = 'proj-prop'
          db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(
            projectId,
            'Scope Property Test',
            new Date(simulatedNow).toISOString(),
          )
          db.prepare('INSERT INTO project_config (project_id, repo_path, base_ref, created_at) VALUES (?, ?, ?, ?)').run(
            projectId,
            repoDir,
            baseSha,
            new Date(simulatedNow).toISOString(),
          )

          const handle = acquireSupervisor(db, stateDir, { nowMs: simulatedNow, staleAfterMs: 30000 })

          const tasks = taskSpecs.map((spec, idx) => ({
            id: `task-${idx + 1}-${randomUUID().slice(0, 8)}`,
            title: spec.title,
            scope: spec.scope,
            durationTicks: spec.durationTicks,
          }))

          const taskMap = new Map(tasks.map((t) => [t.id, t]))

          for (const task of tasks) {
            appendCommand(db, {
              id: task.id,
              projectId,
              kind: 'task.create',
              payloadJson: JSON.stringify({
                title: task.title,
                scope: task.scope,
                maxAttempts: 3,
                timeoutMs: null,
              }),
              createdAt: new Date(simulatedNow).toISOString(),
            })
          }

          const loopDeps: LoopDeps = {
            config: { stateDir, repoPath: repoDir, baseRef: baseSha },
            spawnWorker: async ({ runDir, cwd, taskId, attemptId }) => {
              const task = taskMap.get(taskId)!
              const pid = nextPid++
              const nonce = `prop-nonce-${randomUUID()}`
              workers.set(pid, {
                pid,
                nonce,
                taskId,
                attemptId,
                spawnedAtTick: tickCount,
                durationTicks: task.durationTicks,
                completed: false,
              })
              mkdirSync(runDir, { recursive: true })
              writeFileSync(join(runDir, 'stdout.log'), '')
              writeFileSync(join(runDir, 'stderr.log'), '')

              mkdirSync(cwd, { recursive: true })
              const relPath = task.scope[0] === '.' ? 'change.txt' : join(task.scope[0], 'change.txt')
              const fullChange = join(cwd, relPath)
              mkdirSync(dirname(fullChange), { recursive: true })
              writeFileSync(fullChange, `data-${attemptId}\n`, 'utf8')

              return { pid, nonce }
            },
            isAlive: (pid) => {
              const w = workers.get(pid)
              if (!w || w.completed) return false
              if (tickCount - w.spawnedAtTick >= w.durationTicks) {
                w.completed = true
                return false
              }
              return true
            },
            readResult: () => ({ exitCode: 0 }),
            killTree: async (pid) => {
              const w = workers.get(pid)
              if (w) w.completed = true
              return { result: 'killed' }
            },
          }

          try {
            const maxTicks = 40
            while (tickCount < maxTicks) {
              tickCount++
              simulatedNow += 1000
              await runTick(db, handle, loopDeps, simulatedNow)

              if (tickCount === 1) {
                // Assert command application before checking scheduler invariants
                const outcomes = db.prepare('SELECT command_id, outcome, reason FROM command_outcomes').all() as Array<{
                  command_id: string
                  outcome: string
                  reason: string | null
                }>
                expect(outcomes.length).toBe(tasks.length)
                for (const o of outcomes) {
                  expect(o.outcome).toBe('applied')
                  expect(o.reason).toBeNull()
                }
              }

              // Assert after every tick that no two progress tasks have overlapping scopes
              const progressTasks = db.prepare("SELECT id, scope_json FROM tasks WHERE status = 'progress'").all() as Array<{
                id: string
                scope_json: string
              }>
              for (let i = 0; i < progressTasks.length; i++) {
                for (let j = i + 1; j < progressTasks.length; j++) {
                  const scopeA = JSON.parse(progressTasks[i]!.scope_json) as string[]
                  const scopeB = JSON.parse(progressTasks[j]!.scope_json) as string[]
                  expect(
                    scopesOverlap(scopeA, scopeB),
                    `Invariant violation at tick ${tickCount}: tasks ${progressTasks[i]!.id} (${JSON.stringify(scopeA)}) and ${progressTasks[j]!.id} (${JSON.stringify(scopeB)}) are both in progress but their scopes overlap!`,
                  ).toBe(false)
                }
              }

              const pending = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status IN ('ready', 'progress')").get() as { c: number }
              if (pending.c === 0) break
            }

            // Assert all tasks eventually leave ready
            const readyTasks = db.prepare("SELECT id FROM tasks WHERE status = 'ready'").all() as Array<{ id: string }>
            expect(readyTasks).toHaveLength(0)

            const finalTasks = db.prepare('SELECT id, status FROM tasks').all() as Array<{ id: string; status: string }>
            expect(finalTasks.length).toBe(tasks.length)
            for (const t of finalTasks) {
              expect(t.status).toBe('done')
            }
          } finally {
            try {
              handle.release(simulatedNow)
            } catch {
              // ignore
            }
            db.close()
          }
        }),
        { numRuns: 8, endOnFailure: true },
      )
    },
    180000,
  )
})
