import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openStore } from '../supervisor/src/app/store.ts'
import { acquireSupervisor } from '../supervisor/src/app/supervisor-lease.ts'
import { runTick, type LoopDeps } from '../supervisor/src/app/supervisor-loop.ts'

it('dispatches by graph, blocks transitively, and leaves locked and failed dependencies idle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm506-'))
  const db = openStore(join(dir, 'state.sqlite'))
  const handle = acquireSupervisor(db, dir, { nowMs: 1, staleAfterMs: 10000 })
  try {
    db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p', 'P', 'now')").run()
    db.prepare("INSERT INTO phases (project_id, name, ord, status) VALUES ('p', 'intake', 1, 'open'), ('p', 'development', 2, 'locked')").run()
    const task = (id: string, status: string, phase = 'intake', scope = id, backoff = 0) => {
      db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES (?, 'p', 'task.create', '{}', 'now')").run(id)
      db.prepare("INSERT INTO command_outcomes (command_id, outcome, lease_generation, applied_at) VALUES (?, 'applied', ?, 'now')").run(id, handle.generation)
      db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, phase, scope_json, not_before_ms, created_at, updated_at) VALUES (?, 'p', ?, ?, ?, ?, ?, ?, 'now', 'now')").run(id, id, id, status, phase, JSON.stringify([scope]), backoff)
    }
    task('dead', 'dropped'); task('b', 'ready'); task('c', 'ready')
    task('failed', 'failed'); task('waiting', 'ready'); task('locked', 'ready', 'development', '.')
    task('free', 'ready'); task('later', 'ready', 'intake', 'later', 5000)
    const dependency = db.prepare('INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)')
    dependency.run('b', 'dead'); dependency.run('c', 'b'); dependency.run('waiting', 'failed')
    const skip = <T>() => undefined as T
    const deps: LoopDeps = { stateDir: dir, spawnWorker: () => ({ pid: 1, nonce: 'unused' }), killTree: async () => ({ result: 'not-running' }), isAlive: () => true, readResult: () => undefined, wrapRecoverOutbox: skip, wrapReconcileWorkers: skip, wrapApplyCommands: skip, wrapWorkerLiveness: skip }
    expect((await runTick(db, handle, deps, 1000)).idle).toBe(false)
    const statuses = () => Object.fromEntries(db.prepare('SELECT id, status FROM tasks').all().map((row) => [row.id, row.status]))
    expect(statuses()).toMatchObject({ b: 'blocked', c: 'blocked', waiting: 'ready', locked: 'ready', free: 'progress', later: 'ready' })
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = 'free'").run()
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = 'later'").run()
    db.prepare("UPDATE outbox SET status = 'done' WHERE status = 'pending'").run()
    expect((await runTick(db, handle, deps, 1001)).idle).toBe(true)
  } finally { handle.release(2000); db.close(); rmSync(dir, { recursive: true, force: true }) }
})
