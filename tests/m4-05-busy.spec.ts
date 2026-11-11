import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openStore } from '../supervisor/src/app/store.ts'
import { acquireSupervisor } from '../supervisor/src/app/supervisor-lease.ts'
import { enqueue, runDue } from '../supervisor/src/app/outbox.ts'

it.each([5, 6])('propagates SQLite lock %i without consuming an outbox attempt', async (errcode) => {
  const dir = mkdtempSync(join(tmpdir(), 'm405-busy-'))
  const db = openStore(join(dir, 'state.sqlite'))
  const handle = acquireSupervisor(db, dir, { nowMs: 1, staleAfterMs: 10000 })
  try {
    enqueue(db, handle, { idempotencyKey: 'k', kind: 'x', payloadJson: '{}', nowMs: 1 })
    const error = Object.assign(new Error('locked'), { errcode })
    await expect(runDue(db, handle, { x: () => { throw error } }, 2)).rejects.toBe(error)
    expect(db.prepare("SELECT status, tries FROM outbox WHERE idempotency_key = 'k'").get()).toMatchObject({ status: 'pending', tries: 0 })
  } finally { handle.release(3); db.close(); rmSync(dir, { recursive: true, force: true }) }
})
