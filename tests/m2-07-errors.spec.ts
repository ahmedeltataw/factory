import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { openStore } from '../supervisor/src/app/store.ts'
import { acquireSupervisor, LeaseLostError } from '../supervisor/src/app/supervisor-lease.ts'

const fault = vi.hoisted(() => ({ close: false, error: new Error('close failed') }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, closeSync: (fd: number) => { fs.closeSync(fd); if (fault.close) throw fault.error } }
})

const dirs: string[] = []
const dbs: ReturnType<typeof openStore>[] = []
const handles: ReturnType<typeof acquireSupervisor>[] = []
afterEach(() => {
  fault.close = false
  vi.restoreAllMocks()
  for (const handle of handles.splice(0)) { try { handle.release(0) } catch {} }
  for (const db of dbs.splice(0)) { if (db.isOpen === false) continue; try { db.close() } catch {} }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'm2-07-'))
  dirs.push(dir)
  const db = openStore(join(dir, 'state.sqlite'))
  dbs.push(db)
  const handle = acquireSupervisor(db, dir, { nowMs: 10, staleAfterMs: 10 })
  handles.push(handle)
  return { db, dir, handle }
}

for (const operation of ['heartbeat', 'release'] as const) {
  for (const kind of ['error', 'existing cause', 'frozen', 'primitive', 'null', 'function'] as const) {
    it(`${operation} preserves ${kind} when closing the lock also fails`, () => {
      const { db, dir, handle } = setup()
      const primary: unknown = kind === 'error' ? new Error('database failed')
        : kind === 'existing cause' ? new Error('database failed', { cause: 'original cause' })
        : kind === 'frozen' ? Object.freeze(new Error('database failed'))
        : kind === 'primitive' ? 'database failed'
        : kind === 'function' ? function failure() {} : null
      const prepare = vi.spyOn(db, 'prepare').mockImplementation(() => { throw primary })
      fault.close = true
      let caught: unknown = Symbol('not thrown')
      try { handle[operation](11) } catch (error) { caught = error }
      fault.close = false
      prepare.mockRestore()
      if (kind === 'error' || kind === 'function') {
        expect(caught).toBe(primary)
        expect(Object.getOwnPropertyDescriptor(primary, 'cause')).toEqual({ value: fault.error, writable: true, configurable: true, enumerable: false })
      } else {
        expect(caught).toBeInstanceOf(AggregateError)
        expect((caught as AggregateError).message).toBe(operation === 'heartbeat' ? 'supervisor: lost marking failed' : 'supervisor: release and close failed')
        expect((caught as AggregateError).errors).toEqual([primary, fault.error])
      }
      expect(() => handle.heartbeat(12)).toThrow(LeaseLostError)
      expect(db.prepare('SELECT heartbeat_ms, status FROM supervisor_lease').get()).toMatchObject({ heartbeat_ms: 10, status: 'active' })
      const recovered = acquireSupervisor(db, dir, { nowMs: 20, staleAfterMs: 10, takeover: { ownerId: handle.ownerId, generation: handle.generation, heartbeatMs: 10 } })
      handles.push(recovered)
      recovered.release(20)
      db.close()
    })
  }
}

it('reports a close failure after a successful durable release', () => {
  const { db, dir, handle } = setup()
  fault.close = true
  expect(() => handle.release(11)).toThrow(fault.error)
  fault.close = false
  expect(db.prepare('SELECT status FROM supervisor_lease').get()).toMatchObject({ status: 'released' })
  expect(() => handle.release(12)).toThrow(LeaseLostError)
  const next = acquireSupervisor(db, dir, { nowMs: 12, staleAfterMs: 10 })
  handles.push(next)
  expect(next.generation).toBe(handle.generation + 1)
  next.release(12)
  db.close()
})

it('reports validation and lease-loss messages without changing the row', () => {
  const { db, handle } = setup()
  expect(() => handle.heartbeat(-1)).toThrow('supervisor: nowMs must be a safe integer >= 0')
  expect(() => handle.heartbeat(9)).toThrow('supervisor: heartbeat before the last heartbeat')
  db.exec("UPDATE supervisor_lease SET owner_id = 'other'")
  expect(() => handle.heartbeat(11)).toThrow('supervisor: lease row no longer matches this handle')
  expect(() => handle.release(12)).toThrow('supervisor: lease handle is closed, lost or displaced')
  expect(db.prepare('SELECT owner_id, heartbeat_ms, status FROM supervisor_lease').get()).toMatchObject({ owner_id: 'other', heartbeat_ms: 10, status: 'active' })
  db.close()
})

it('validates acquisition inputs with their specific error messages before writing a lease', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm2-07-input-'))
  dirs.push(dir)
  const db = openStore(join(dir, 'state.sqlite'))
  dbs.push(db)
  const valid = { nowMs: 10, staleAfterMs: 5 }
  for (const [options, message] of [
    [{ ...valid, nowMs: NaN }, 'supervisor: nowMs must be a safe integer >= 0'],
    [{ ...valid, staleAfterMs: 0 }, 'supervisor: staleAfterMs must be a safe integer >= 1'],
    [{ ...valid, takeover: { ownerId: ' ', generation: 1, heartbeatMs: 0 } }, 'supervisor: takeover.ownerId must be a nonempty string'],
    [{ ...valid, takeover: { ownerId: 'x', generation: 0, heartbeatMs: 0 } }, 'supervisor: takeover.generation must be a safe integer >= 1'],
    [{ ...valid, takeover: { ownerId: 'x', generation: 1, heartbeatMs: -1 } }, 'supervisor: takeover.heartbeatMs must be a safe integer >= 0'],
  ] as const) expect(() => acquireSupervisor(db, dir, options)).toThrow(message)
  expect(db.prepare('SELECT COUNT(*) AS n FROM supervisor_lease').get()).toMatchObject({ n: 0 })
  db.close()
})

it('preserves the transaction and releases the lock when release is attempted inside it', () => {
  const { db, dir, handle } = setup()
  db.exec('BEGIN')
  expect(() => handle.release(11)).toThrow('supervisor: cannot release a supervisor lease inside an active transaction')
  expect(db.isTransaction).toBe(true)
  db.exec('ROLLBACK')
  expect(db.prepare('SELECT heartbeat_ms, status FROM supervisor_lease').get()).toMatchObject({ heartbeat_ms: 10, status: 'active' })
  const next = acquireSupervisor(db, dir, { nowMs: 20, staleAfterMs: 10, takeover: { ownerId: handle.ownerId, generation: handle.generation, heartbeatMs: 10 } })
  handles.push(next)
  next.release(20)
  db.close()
})

it('keeps the lease usable after a heartbeat inside a caller transaction is rejected', () => {
  const { db, handle } = setup()
  db.exec('BEGIN')
  expect(() => handle.heartbeat(11)).toThrow('supervisor: cannot heartbeat a supervisor lease inside an active transaction')
  expect(db.isTransaction).toBe(true)
  db.exec('ROLLBACK')
  handle.heartbeat(12)
  expect(db.prepare('SELECT heartbeat_ms, status FROM supervisor_lease').get()).toMatchObject({ heartbeat_ms: 12, status: 'active' })
  handle.release(12)
  db.close()
})

it('reports the primary error unchanged when heartbeat cleanup succeeds', () => {
  const { db, dir, handle } = setup()
  const primary = new Error('heartbeat write failed')
  const prepare = vi.spyOn(db, 'prepare').mockImplementation(() => { throw primary })
  expect(() => handle.heartbeat(11)).toThrow(primary)
  expect(primary.cause).toBeUndefined()
  prepare.mockRestore()
  const next = acquireSupervisor(db, dir, { nowMs: 20, staleAfterMs: 10, takeover: { ownerId: handle.ownerId, generation: handle.generation, heartbeatMs: 10 } })
  handles.push(next)
  next.release(20)
  db.close()
})
