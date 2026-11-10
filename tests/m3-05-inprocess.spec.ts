import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openStore } from '../supervisor/src/app/store.ts'
import { acquireSupervisor } from '../supervisor/src/app/supervisor-lease.ts'
import { createEffectHandlers, enqueue, runDue } from '../supervisor/src/app/outbox.ts'

const mocks = vi.hoisted(() => ({ evidence: vi.fn(), fault: vi.fn() }))
vi.mock('../supervisor/src/app/evidence.ts', () => ({ recordEvidence: mocks.evidence }))
vi.mock('../supervisor/src/app/faults.ts', () => ({ triggerFault: mocks.fault }))
const cleanups: Array<() => void> = []
afterEach(() => { vi.resetAllMocks(); for (const cleanup of cleanups.splice(0)) cleanup() })
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'm305-inprocess-'))
  const db = openStore(join(dir, 'state.sqlite'))
  const handle = acquireSupervisor(db, dir, { nowMs: 1, staleAfterMs: 10000 })
  cleanups.push(() => { try { handle.release(2) } catch {} db.close(); rmSync(dir, { recursive: true, force: true }) })
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p', 'Project', '2026-01-01')").run()
  db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c', 'p', 'task.create', '{}', '2026-01-01')").run()
  db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES ('t', 'p', 'c', 'Task', 'ready', '2026-01-01', '2026-01-01')").run()
  for (const id of ['a', 'b', 'c']) db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation) VALUES (?, 't', ?, 'succeeded', 1)").run(id, ['a', 'b', 'c'].indexOf(id) + 1)
  return { db, handle, dir }
}

describe('in-process outbox effect coverage', () => {
  it('spawns with default and explicit paths and skips workers already running', async () => {
    const { db, handle, dir } = setup()
    const spawnWorker = vi.fn().mockResolvedValue({ pid: 42, nonce: 'nonce-a' })
    const handlers = createEffectHandlers({ db, spawnWorker, config: { stateDir: dir } as never })
    enqueue(db, handle, { idempotencyKey: 'a', kind: 'attempt.start', payloadJson: JSON.stringify({ attemptId: 'a', taskId: 't', env: { X: 'Y' } }), nowMs: 1 })
    expect(await runDue(db, handle, handlers, 2)).toEqual({ done: 1, failed: 0, retried: 0 })
    expect(spawnWorker).toHaveBeenCalledWith({ runDir: join(dir, 'runs', 'a'), cwd: join(dir, 'worktrees', 't'), taskId: 't', attemptId: 'a', env: { X: 'Y' } })
    expect(db.prepare('SELECT state, pid, nonce, worktree_path FROM workers WHERE attempt_id = ?').get('a')).toMatchObject({ state: 'running', pid: 42, nonce: 'nonce-a', worktree_path: join(dir, 'worktrees', 't') })
    enqueue(db, handle, { idempotencyKey: 'again', kind: 'attempt.start', payloadJson: '{"attemptId":"a","taskId":"t"}', nowMs: 1 })
    expect((await runDue(db, handle, handlers, 2)).done).toBe(1)
    expect(spawnWorker).toHaveBeenCalledTimes(1)
    spawnWorker.mockResolvedValueOnce({ pid: 43, nonce: 'nonce-b' })
    enqueue(db, handle, { idempotencyKey: 'b', kind: 'attempt.start', payloadJson: JSON.stringify({ attemptId: 'b', taskId: 't', runDir: 'custom-run', cwd: 'custom-cwd' }), nowMs: 1 })
    expect((await runDue(db, handle, handlers, 2)).done).toBe(1)
    expect(spawnWorker).toHaveBeenLastCalledWith({ runDir: 'custom-run', cwd: 'custom-cwd', taskId: 't', attemptId: 'b', env: undefined })
  })

  it('requires a spawner and a lease for direct built-in handler calls', async () => {
    const { db, handle } = setup()
    const row = enqueue(db, handle, { idempotencyKey: 'a', kind: 'attempt.start', payloadJson: '{"attemptId":"a","taskId":"t"}', nowMs: 1 })
    await expect(createEffectHandlers({ db })['attempt.start'](row, { idempotencyKey: 'a' })).rejects.toThrow('spawnWorker required')
    await expect(createEffectHandlers({ db, spawnWorker: vi.fn() })['attempt.start'](row, { idempotencyKey: 'a' })).rejects.toThrow('outbox lease required')
    const evidenceRow = enqueue(db, handle, { idempotencyKey: 'e', kind: 'evidence.commit', payloadJson: '{"attemptId":"a"}', nowMs: 1 })
    await expect(createEffectHandlers({ db })['evidence.commit'](evidenceRow, { idempotencyKey: 'e' })).rejects.toThrow('outbox lease required')
  })

  it('fences evidence inserts, preserves database methods, and skips existing evidence', async () => {
    const { db, handle } = setup()
    mocks.evidence.mockImplementation(async (proxy, attemptId) => {
      expect(proxy.isOpen).toBe(true)
      expect(proxy.prepare('SELECT 7 AS value').get()).toMatchObject({ value: 7 })
      const statement = proxy.prepare('  INSERT INTO evidence (attempt_id, base_sha, head_sha, files_json, stdout_sha256, stderr_sha256, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      expect(typeof statement.run).toBe('function')
      statement.run(attemptId, 'base', 'head', '[]', 'out', 'err', 'now')
      return 'head'
    })
    const handlers = createEffectHandlers({ db })
    enqueue(db, handle, { idempotencyKey: 'e', kind: 'evidence.commit', payloadJson: '{"attemptId":"a","exitCode":0}', nowMs: 1 })
    expect((await runDue(db, handle, handlers, 2)).done).toBe(1)
    expect(db.prepare('SELECT head_sha FROM evidence WHERE attempt_id = ?').get('a')).toMatchObject({ head_sha: 'head' })
    enqueue(db, handle, { idempotencyKey: 'e2', kind: 'evidence.commit', payloadJson: '{"attemptId":"a"}', nowMs: 1 })
    expect((await runDue(db, handle, handlers, 2)).done).toBe(1)
    expect(mocks.evidence).toHaveBeenCalledTimes(1)
  })

  it.each(['outbox-before-effect', 'outbox-after-effect'] as const)('invokes %s at the correct boundary', async (fault) => {
    const { db, handle } = setup()
    const calls: string[] = []
    mocks.fault.mockImplementation(() => { calls.push('fault'); throw new Error('simulated termination') })
    enqueue(db, handle, { idempotencyKey: 'x', kind: 'x', payloadJson: '{}', nowMs: 1 })
    expect(await runDue(db, handle, { x: () => { calls.push('effect') } }, 2, { fault })).toEqual({ done: 0, failed: 0, retried: 1 })
    expect(mocks.fault).toHaveBeenCalledWith(fault)
    expect(calls).toEqual(fault === 'outbox-before-effect' ? ['fault'] : ['effect', 'fault'])
  })
})


it('rejects an evidence insert after the lease is displaced', async () => {
  const { db, handle } = setup()
  mocks.evidence.mockImplementation(async (proxy, attemptId) => {
    db.prepare('UPDATE supervisor_lease SET generation = generation + 1').run()
    proxy.prepare('INSERT INTO evidence (attempt_id, base_sha, head_sha, files_json, stdout_sha256, stderr_sha256, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(attemptId, 'base', 'head', '[]', 'out', 'err', 'now')
  })
  enqueue(db, handle, { idempotencyKey: 'e', kind: 'evidence.commit', payloadJson: '{"attemptId":"a"}', nowMs: 1 })
  await expect(runDue(db, handle, createEffectHandlers({ db }), 2)).rejects.toThrow(/lease/i)
  expect(db.prepare('SELECT * FROM evidence WHERE attempt_id = ?').get('a')).toBeUndefined()
})
