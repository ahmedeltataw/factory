import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { openStore } from '../supervisor/src/app/store.ts'
import { acquireSupervisor } from '../supervisor/src/app/supervisor-lease.ts'
import { runTick, type LoopDeps } from '../supervisor/src/app/supervisor-loop.ts'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function setup(deadline: number | null = 1000, maxAttempts = 2) {
  const dir = mkdtempSync(join(tmpdir(), 'm405-loop-'))
  const db = openStore(join(dir, 'state.sqlite'))
  const handle = acquireSupervisor(db, dir, { nowMs: 1, staleAfterMs: 10000 })
  cleanups.push(() => { handle.release(2000); db.close(); rmSync(dir, { recursive: true, force: true }) })
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p', 'P', 'now')").run()
  db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c', 'p', 'task.create', '{}', 'now')").run()
  db.prepare("INSERT INTO command_outcomes (command_id, outcome, lease_generation, applied_at) VALUES ('c', 'applied', ?, 'now')").run(handle.generation)
  db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, max_attempts) VALUES ('t', 'p', 'c', 'T', 'progress', 'now', 'now', ?)").run(maxAttempts)
  db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation, deadline_ms) VALUES ('a', 't', 1, 'running', ?, ?)").run(handle.generation, deadline)
  db.prepare("INSERT INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms) VALUES ('a', 'nonce', 42, 'running', ?, 1)").run(dir)
  const deps: LoopDeps = {
    stateDir: dir,
    spawnWorker: vi.fn(() => ({ pid: 43, nonce: 'new' })),
    killTree: vi.fn(async () => ({ result: 'killed' as const })),
    isAlive: vi.fn(() => true),
    readResult: vi.fn(() => undefined),
  }
  return { db, handle, deps, dir }
}

it.each([null, 1001])('keeps a live worker running before deadline %s', async (deadline) => {
  const { db, handle, deps } = setup(deadline)
  await runTick(db, handle, deps, 1000)
  expect(deps.killTree).not.toHaveBeenCalled()
  expect(db.prepare('SELECT state, heartbeat_ms FROM workers').get()).toMatchObject({ state: 'running', heartbeat_ms: 1000 })
})

it.each([
  ['killed', 'killed'],
  ['identity-mismatch', 'lost'],
] as const)('handles timeout kill result %s', async (result, state) => {
  const { db, handle, deps } = setup()
  deps.killTree = vi.fn(async () => ({ result }))
  await runTick(db, handle, deps, 1000)
  expect(deps.killTree).toHaveBeenCalledWith(42, 'nonce')
  expect(db.prepare('SELECT state FROM workers').get()).toMatchObject({ state })
  expect(db.prepare('SELECT status, error_class FROM attempts').get()).toMatchObject({ status: 'interrupted', error_class: 'timeout' })
  expect(db.prepare('SELECT status, not_before_ms FROM tasks').get()).toMatchObject({ status: 'ready', not_before_ms: 2000 })
})

it('leaves a worker running when timeout termination fails', async () => {
  const { db, handle, deps } = setup()
  deps.killTree = vi.fn(async () => ({ result: 'kill-failed' as const }))
  await runTick(db, handle, deps, 1000)
  expect(db.prepare('SELECT status, error_class FROM attempts').get()).toMatchObject({ status: 'running', error_class: null })
  expect(db.prepare('SELECT state FROM workers').get()).toMatchObject({ state: 'running' })
})

it.each([undefined, { exitCode: 75 }, { exitCode: 1 }])('handles completion race after a timeout: %s', async (completion) => {
  const { db, handle, deps, dir } = setup()
  deps.killTree = vi.fn(async () => ({ result: 'not-running' as const }))
  deps.readResult = vi.fn(() => completion)
  await runTick(db, handle, deps, 1000)
  expect(deps.readResult).toHaveBeenCalledWith(join(dir, 'runs', 'a'))
  expect(db.prepare('SELECT status, error_class FROM attempts').get()).toMatchObject(completion
    ? { status: 'failed', error_class: completion.exitCode === 75 ? 'transient' : 'exit' }
    : { status: 'interrupted', error_class: 'lost' })
  expect(db.prepare('SELECT state FROM workers').get()).toMatchObject({ state: completion ? 'exited' : 'lost' })
  expect(db.prepare('SELECT status, not_before_ms FROM tasks').get()).toMatchObject(completion?.exitCode === 75
    ? { status: 'ready', not_before_ms: 2000 }
    : { status: completion ? 'failed' : 'ready', not_before_ms: 0 })
})

it('fails the task when a timeout exhausts its attempt budget', async () => {
  const { db, handle, deps } = setup(1000, 1)
  await runTick(db, handle, deps, 1000)
  expect(db.prepare('SELECT status, not_before_ms FROM tasks').get()).toMatchObject({ status: 'failed', not_before_ms: 0 })
})
