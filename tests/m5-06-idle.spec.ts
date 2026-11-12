import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openStore } from '../supervisor/src/app/store.ts'
import { acquireSupervisor } from '../supervisor/src/app/supervisor-lease.ts'
import { runTick, type LoopDeps } from '../supervisor/src/app/supervisor-loop.ts'

async function fixture(run: (f: { task: (id: string, status: string, phase?: string, scope?: string, backoff?: number) => void; dep: (id: string, on: string) => void; tick: () => Promise<{ idle: boolean }> }) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'm506-idle-'))
  const db = openStore(join(dir, 'state.sqlite'))
  const handle = acquireSupervisor(db, dir, { nowMs: 1, staleAfterMs: 10000 })
  try {
    db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p', 'P', 'now')").run()
    db.prepare("INSERT INTO phases (project_id, name, ord, status) VALUES ('p', 'intake', 1, 'open'), ('p', 'development', 2, 'locked')").run()
    const task = (id: string, status: string, phase = 'intake', scope = id, backoff = 0) => {
      db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES (?, 'p', 'task.create', '{}', 'now')").run(id)
      db.prepare("INSERT INTO command_outcomes (command_id, outcome, lease_generation, applied_at) VALUES (?, 'applied', ?, 'now')").run(id, handle.generation)
      db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, phase, scope_json, not_before_ms, created_at, updated_at) VALUES (?, 'p', ?, ?, ?, ?, ?, ?, 'now', 'now')").run(id, id, id, status, phase, scope === 'INVALID' ? '[]' : JSON.stringify([scope]), backoff)
    }
    const dep = (id: string, on: string) => { db.prepare('INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)').run(id, on) }
    const skip = <T>() => undefined as T
    const deps: LoopDeps = { stateDir: dir, spawnWorker: () => ({ pid: 1, nonce: 'unused' }), killTree: async () => ({ result: 'not-running' }), isAlive: () => true, readResult: () => undefined, wrapRecoverOutbox: skip, wrapReconcileWorkers: skip, wrapApplyCommands: skip, wrapDispatchTasks: skip, wrapWorkerLiveness: skip }
    await run({ task, dep, tick: () => runTick(db, handle, deps, 1000) })
  } finally { handle.release(2000); db.close(); rmSync(dir, { recursive: true, force: true }) }
}

it('rejects an invalid persisted task scope with its reason', async () => {
  await fixture(async ({ task, tick }) => {
    task('bad', 'ready', 'intake', 'INVALID')
    await expect(tick()).rejects.toThrow('invalid task scope: scope array must not be empty')
  })
})

it('stays busy for a backoff even with no running work', async () => {
  await fixture(async ({ task, tick }) => {
    task('later', 'ready', 'intake', 'later', 5000)
    expect((await tick()).idle).toBe(false)
  })
})

it('stays busy when any dependency is ready, even alongside a failed dependency', async () => {
  await fixture(async ({ task, dep, tick }) => {
    task('failed', 'failed'); task('ready', 'ready', 'development'); task('waiting', 'ready')
    dep('waiting', 'failed'); dep('waiting', 'ready')
    expect((await tick()).idle).toBe(false)
  })
})

it('is idle when dependencies are failed and other work is phase locked', async () => {
  await fixture(async ({ task, dep, tick }) => {
    task('failed', 'failed'); task('waiting', 'ready'); task('locked', 'ready', 'development')
    dep('waiting', 'failed')
    expect((await tick()).idle).toBe(true)
  })
})
