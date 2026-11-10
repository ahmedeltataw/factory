import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openStore } from '../supervisor/src/app/store.ts'
import { acquireSupervisor, LeaseLostError } from '../supervisor/src/app/supervisor-lease.ts'
import { createEffectHandlers, enqueue, runDue } from '../supervisor/src/app/outbox.ts'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'factory-m305-extra-'))
  const db = openStore(join(dir, 'state.sqlite'))
  const handle = acquireSupervisor(db, dir, { nowMs: 1, staleAfterMs: 10000 })
  cleanups.push(() => { try { handle.release(2) } catch { /* displaced */ } db.close(); rmSync(dir, { recursive: true, force: true }) })
  return { db, handle }
}

describe('outbox failure boundaries', () => {
  it('does not invoke any effect after lease displacement', async () => {
    const { db, handle } = setup()
    enqueue(db, handle, { idempotencyKey: 'k', kind: 'x', payloadJson: '{}', nowMs: 1 })
    db.prepare('UPDATE supervisor_lease SET generation = generation + 1').run()
    const effect = vi.fn()
    await expect(runDue(db, handle, { x: effect }, 2)).rejects.toThrow(LeaseLostError)
    expect(effect).not.toHaveBeenCalled()
    expect(db.prepare('SELECT status, tries FROM outbox WHERE idempotency_key = ?').get('k')).toMatchObject({ status: 'pending', tries: 0 })
  })

  it('does not record a retry if the lease is displaced during an effect', async () => {
    const { db, handle } = setup()
    enqueue(db, handle, { idempotencyKey: 'k', kind: 'x', payloadJson: '{}', nowMs: 1 })
    await expect(runDue(db, handle, { x: () => { db.prepare('UPDATE supervisor_lease SET generation = generation + 1').run(); throw new Error('effect failed') } }, 2)).rejects.toThrow(LeaseLostError)
    expect(db.prepare('SELECT status, tries FROM outbox WHERE idempotency_key = ?').get('k')).toMatchObject({ status: 'pending', tries: 0 })
  })

  it('retries missing dependencies and non-Error failures with useful errors', async () => {
    const { db, handle } = setup()
    enqueue(db, handle, { idempotencyKey: 'worktree', kind: 'worktree.ensure', payloadJson: '{"taskId":"t"}', nowMs: 1 })
    enqueue(db, handle, { idempotencyKey: 'thrown', kind: 'x', payloadJson: '{}', nowMs: 1 })
    const handlers = { ...createEffectHandlers({ db }), x: () => { throw 'destination unavailable' } }
    expect(await runDue(db, handle, handlers, 2)).toEqual({ done: 0, failed: 0, retried: 2 })
    expect(db.prepare('SELECT last_error FROM outbox WHERE idempotency_key = ?').get('worktree')).toMatchObject({ last_error: 'worktree configuration required' })
    expect(db.prepare('SELECT last_error FROM outbox WHERE idempotency_key = ?').get('thrown')).toMatchObject({ last_error: 'destination unavailable' })
  })
})
