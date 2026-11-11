import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openStore } from '../supervisor/src/app/store.ts'
import { acquireSupervisor } from '../supervisor/src/app/supervisor-lease.ts'
import { runTick, type LoopDeps } from '../supervisor/src/app/supervisor-loop.ts'

it('reserves skipped and backoff scopes in FIFO order while dispatching disjoint work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm406-fifo-'))
  const db = openStore(join(dir, 'state.sqlite'))
  const handle = acquireSupervisor(db, dir, { nowMs: 1, staleAfterMs: 10000 })
  try {
    db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p', 'P', 'now')").run()
    const task = (id: string, scope: string[], status: string, backoff = 0) => {
      db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES (?, 'p', 'task.create', '{}', 'now')").run(id)
      db.prepare("INSERT INTO command_outcomes (command_id, outcome, lease_generation, applied_at) VALUES (?, 'applied', ?, 'now')").run(id, handle.generation)
      db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, scope_json, not_before_ms, created_at, updated_at) VALUES (?, 'p', ?, ?, ?, ?, ?, 'now', 'now')").run(id, id, id, status, JSON.stringify(scope), backoff)
    }
    task('a', ['src'], 'progress')
    task('b', ['src/x', 'docs'], 'ready')
    task('c', ['docs/y'], 'ready')
    task('d', ['lib'], 'ready', 5000)
    task('e', ['lib/x'], 'ready')
    task('f', ['other'], 'ready')
    const skip = <T>() => undefined as T
    const deps: LoopDeps = {
      stateDir: dir, spawnWorker: () => ({ pid: 1, nonce: 'unused' }),
      killTree: async () => ({ result: 'not-running' }), isAlive: () => true, readResult: () => undefined,
      wrapRecoverOutbox: skip, wrapReconcileWorkers: skip, wrapApplyCommands: skip, wrapWorkerLiveness: skip,
    }
    await runTick(db, handle, deps, 1000)
    const rows = db.prepare('SELECT id, status FROM tasks ORDER BY rowid').all()
    expect(rows.map((row) => [row.id, row.status])).toEqual([['a', 'progress'], ['b', 'ready'], ['c', 'ready'], ['d', 'ready'], ['e', 'ready'], ['f', 'progress']])
  } finally { handle.release(2000); db.close(); rmSync(dir, { recursive: true, force: true }) }
})
