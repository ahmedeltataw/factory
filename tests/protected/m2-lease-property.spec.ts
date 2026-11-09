import { linkSync, mkdtempSync, mkdirSync, realpathSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import fc from 'fast-check'
import { expect, it, vi } from 'vitest'
import { openStore } from '../../supervisor/src/app/store.ts'
import { acquireSupervisor } from '../../supervisor/src/app/supervisor-lease.ts'
import { LeaseLostError } from '../../supervisor/src/app/supervisor-lease.ts'
import * as leaseModule from '../../supervisor/src/app/supervisor-lease.ts'

it('CHK-M2-03-d/f: takeover changes only at the stale boundary with exact evidence', () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 1000000 }), fc.integer({ min: 1, max: 100000 }), (heartbeatMs, staleAfterMs) => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-lease-property-'))
    const db = openStore(join(dir, 'state.sqlite'))
    try {
      db.prepare("INSERT INTO supervisor_lease VALUES (1, 'owner', 1, ?, 'active')").run(heartbeatMs)
      const evidence = { ownerId: 'owner', generation: 1, heartbeatMs }
      const nowMs = heartbeatMs + staleAfterMs
      expect(() => acquireSupervisor(db, dir, { nowMs: nowMs - 1, staleAfterMs, takeover: evidence })).toThrow()
      expect(() => acquireSupervisor(db, dir, { nowMs, staleAfterMs, takeover: { ...evidence, generation: 2 } })).toThrow()
      expect(db.prepare('SELECT owner_id, generation, heartbeat_ms, status FROM supervisor_lease').get()).toMatchObject({ owner_id: 'owner', generation: 1, heartbeat_ms: heartbeatMs, status: 'active' })
      const next = acquireSupervisor(db, dir, { nowMs, staleAfterMs, takeover: evidence })
      try { expect(next.generation).toBe(2) } finally { next.release(nowMs) }
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
  }), { numRuns: 30 })
}, 20000)

it('CHK-M2-03-e: failed release relinquishes the OS lock and preserves the active row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-lease-release-'))
  const db = openStore(join(dir, 'state.sqlite'))
  try {
    const handle = acquireSupervisor(db, dir, { nowMs: 10, staleAfterMs: 10 })
    db.exec("CREATE TRIGGER refuse_release BEFORE UPDATE ON supervisor_lease WHEN NEW.status = 'released' BEGIN SELECT RAISE(ABORT, 'release failed'); END")
    expect(() => handle.release(11)).toThrow()
    expect(() => handle.heartbeat(12)).toThrow()
    expect(db.prepare('SELECT status FROM supervisor_lease').get()).toMatchObject({ status: 'active' })
    db.exec('DROP TRIGGER refuse_release')
    const next = acquireSupervisor(db, dir, { nowMs: 20, staleAfterMs: 10, takeover: { ownerId: handle.ownerId, generation: handle.generation, heartbeatMs: 10 } })
    next.release(20)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('CHK-M2-03-e: ownership identifiers cannot be changed by the caller', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-lease-identity-'))
  const db = openStore(join(dir, 'state.sqlite'))
  try {
    const handle = acquireSupervisor(db, dir, { nowMs: 10, staleAfterMs: 10 })
    try {
      const owner = handle.ownerId
      try { Reflect.set(handle, 'ownerId', 'different') } catch { /* immutable properties may throw */ }
      try { Reflect.set(handle, 'generation', 99) } catch { /* immutable properties may throw */ }
      expect(handle.ownerId).toBe(owner)
      expect(handle.generation).toBe(1)
      handle.heartbeat(11)
    } finally { try { handle.release(12) } catch { /* failed identity assertion may have displaced the handle */ } }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('CHK-M2-03-e: refuses to overflow the generation fence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-lease-overflow-'))
  const db = openStore(join(dir, 'state.sqlite'))
  try {
    db.prepare("INSERT INTO supervisor_lease VALUES (1, 'owner', ?, 10, 'released')").run(Number.MAX_SAFE_INTEGER)
    expect(() => acquireSupervisor(db, dir, { nowMs: 20, staleAfterMs: 10 })).toThrow()
    expect(db.prepare('SELECT owner_id, generation, status FROM supervisor_lease').get()).toMatchObject({ owner_id: 'owner', generation: Number.MAX_SAFE_INTEGER, status: 'released' })
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('CHK-M2-03-b/d: validates clocks and every field of takeover evidence without changing the row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-lease-input-'))
  const db = openStore(join(dir, 'state.sqlite'))
  try {
    const valid = { nowMs: 20, staleAfterMs: 10 }
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '20']) {
      expect(() => acquireSupervisor(db, dir, { ...valid, nowMs: value as number })).toThrow()
    }
    for (const value of [0, -1, 1.5, NaN, '10']) {
      expect(() => acquireSupervisor(db, dir, { ...valid, staleAfterMs: value as number })).toThrow()
    }
    db.prepare("INSERT INTO supervisor_lease VALUES (1, 'owner', 4, 10, 'active')").run()
    const evidence = { ownerId: 'owner', generation: 4, heartbeatMs: 10 }
    for (const bad of [
      { ...evidence, ownerId: '' }, { ...evidence, ownerId: '   ' },
      { ...evidence, ownerId: 'other' }, { ...evidence, generation: 0 },
      { ...evidence, generation: 5 }, { ...evidence, heartbeatMs: -1 },
      { ...evidence, heartbeatMs: 9 },
    ]) expect(() => acquireSupervisor(db, dir, { ...valid, takeover: bad })).toThrow()
    expect(() => acquireSupervisor(db, dir, { nowMs: 9, staleAfterMs: 1, takeover: evidence })).toThrow()
    expect(db.prepare('SELECT owner_id, generation, heartbeat_ms, status FROM supervisor_lease').get()).toMatchObject({ owner_id: 'owner', generation: 4, heartbeat_ms: 10, status: 'active' })
    const handle = acquireSupervisor(db, dir, { ...valid, takeover: evidence })
    try {
      handle.heartbeat(20)
      for (const value of [-1, 0.5, NaN, Infinity]) expect(() => handle.heartbeat(value)).toThrow()
      for (const value of [-1, 0.5, NaN, Infinity]) expect(() => handle.release(value)).toThrow()
      handle.heartbeat(21)
    } finally { handle.release(22) }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('CHK-M2-03-e: ignored acquisition updates roll back and do not retain the lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-lease-ignored-'))
  const db = openStore(join(dir, 'state.sqlite'))
  try {
    db.exec("INSERT INTO supervisor_lease VALUES (1, 'old', 1, 10, 'released'); CREATE TRIGGER ignore_acquire BEFORE UPDATE ON supervisor_lease WHEN NEW.status = 'active' BEGIN SELECT RAISE(IGNORE); END")
    expect(() => acquireSupervisor(db, dir, { nowMs: 20, staleAfterMs: 10 })).toThrow()
    expect(db.prepare('SELECT owner_id, generation, status FROM supervisor_lease').get()).toMatchObject({ owner_id: 'old', generation: 1, status: 'released' })
    db.exec('DROP TRIGGER ignore_acquire')
    const handle = acquireSupervisor(db, dir, { nowMs: 20, staleAfterMs: 10 })
    handle.release(20)
    db.exec("UPDATE supervisor_lease SET status = 'active'; CREATE TRIGGER ignore_acquire BEFORE UPDATE ON supervisor_lease WHEN NEW.status = 'active' BEGIN SELECT RAISE(IGNORE); END")
    const evidence = { ownerId: handle.ownerId, generation: handle.generation, heartbeatMs: 20 }
    expect(() => acquireSupervisor(db, dir, { nowMs: 30, staleAfterMs: 10, takeover: evidence })).toThrow()
    db.exec('DROP TRIGGER ignore_acquire')
    const next = acquireSupervisor(db, dir, { nowMs: 30, staleAfterMs: 10, takeover: evidence })
    next.release(30)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('CHK-M2-03-e: direct release by a displaced owner fails and releases its OS lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-lease-displaced-'))
  const db = openStore(join(dir, 'state.sqlite'))
  try {
    const handle = acquireSupervisor(db, dir, { nowMs: 10, staleAfterMs: 10 })
    db.exec("UPDATE supervisor_lease SET owner_id = 'new', generation = 2")
    expect(() => handle.release(11)).toThrow()
    expect(() => handle.heartbeat(12)).toThrow()
    const next = acquireSupervisor(db, dir, { nowMs: 20, staleAfterMs: 10, takeover: { ownerId: 'new', generation: 2, heartbeatMs: 10 } })
    next.release(20)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('CHK-M2-03-b/d: validates takeover evidence even when no prior lease exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-lease-validation-'))
  const db = openStore(join(dir, 'state.sqlite'))
  try {
    const good = { ownerId: 'owner', generation: 1, heartbeatMs: 0 }
    for (const takeover of [{ ...good, ownerId: '' }, { ...good, ownerId: '  ' }, { ...good, generation: 0 }, { ...good, heartbeatMs: -1 }]) {
      expect(() => acquireSupervisor(db, dir, { nowMs: 20, staleAfterMs: 10, takeover })).toThrow()
      expect(db.prepare('SELECT COUNT(*) AS n FROM supervisor_lease').get()).toMatchObject({ n: 0 })
    }
    const handle = acquireSupervisor(db, dir, { nowMs: 20, staleAfterMs: 10 })
    handle.release(20)
    db.close()
    expect(() => handle.heartbeat(21)).toThrow(LeaseLostError)
    expect(() => handle.release(21)).toThrow(LeaseLostError)
  } finally { try { db.close() } catch { /* already closed */ }; rmSync(dir, { recursive: true, force: true }) }
})

it('CHK-M2-03-e: SQLite busy during acquisition closes the OS lock and leaves no lease', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-lease-busy-'))
  const path = join(dir, 'state.sqlite')
  const db = openStore(path)
  const other = openStore(path)
  try {
    db.exec('PRAGMA busy_timeout = 0')
    other.exec('BEGIN IMMEDIATE')
    try { expect(() => acquireSupervisor(db, dir, { nowMs: 10, staleAfterMs: 10 })).toThrow() } finally { other.exec('ROLLBACK') }
    expect(db.prepare('SELECT COUNT(*) AS n FROM supervisor_lease').get()).toMatchObject({ n: 0 })
    const handle = acquireSupervisor(db, dir, { nowMs: 10, staleAfterMs: 10 })
    handle.release(10)
  } finally { other.close(); db.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('CHK-M2-03-a/c: rejects a database resolving outside the canonical state directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-lease-canonical-'))
  const actual = join(root, 'actual')
  const alias = join(root, 'alias')
  mkdirSync(actual)
  mkdirSync(alias)
  const db = openStore(join(actual, 'state.sqlite'))
  const native = realpathSync.native
  const aliasDb = join(alias, 'state.sqlite')
  const spy = vi.spyOn(realpathSync, 'native').mockImplementation(((path: Parameters<typeof native>[0], ...args: unknown[]) => {
    if (String(path) === aliasDb) return native(join(actual, 'state.sqlite'))
    return (native as (...values: unknown[]) => string)(path, ...args)
  }) as typeof native)
  let accidental: ReturnType<typeof acquireSupervisor> | undefined
  try {
    expect(() => { accidental = acquireSupervisor(db, alias, { nowMs: 10, staleAfterMs: 10 }) }).toThrow()
  } finally {
    try { accidental?.release(10) } catch { /* cleanup after a failing assertion */ }
    spy.mockRestore()
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('CHK-M2-03-b/e: callers cannot change the handle clock or internal ownership state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-lease-private-'))
  const db = openStore(join(dir, 'state.sqlite'))
  let handle: ReturnType<typeof acquireSupervisor> | undefined
  try {
    handle = acquireSupervisor(db, dir, { nowMs: 10, staleAfterMs: 10 })
    const active = handle
    active.heartbeat(20)
    Reflect.set(active, 'lastHeartbeat', 0)
    expect(() => active.heartbeat(19)).toThrow()
    active.release(20)
    Reflect.set(active, 'closed', false)
    Reflect.set(active, 'lost', false)
    expect(() => active.heartbeat(21)).toThrow(LeaseLostError)
    expect(Object.prototype.hasOwnProperty.call(active, 'fd')).toBe(false)
  } finally { try { handle?.release(30) } catch { /* already released or lost */ }; db.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('CHK-M2-03-e: callers cannot replace internal lock cleanup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-lease-private-method-'))
  const db = openStore(join(dir, 'state.sqlite'))
  const handle = acquireSupervisor(db, dir, { nowMs: 10, staleAfterMs: 10 })
  try {
    Reflect.set(handle, 'closeLock', () => {})
    handle.release(10)
    const next = acquireSupervisor(db, dir, { nowMs: 20, staleAfterMs: 10 })
    next.release(20)
  } finally {
    Reflect.deleteProperty(handle, 'closeLock')
    try { handle.release(30) } catch { /* already released or lost */ }
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('CHK-M2-03-e: callers cannot shadow the lease identity or operations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-lease-shadow-'))
  const db = openStore(join(dir, 'state.sqlite'))
  const handle = acquireSupervisor(db, dir, { nowMs: 10, staleAfterMs: 10 })
  try {
    expect(() => Object.defineProperty(handle, 'ownerId', { value: 'forged' })).toThrow()
    expect(() => Object.defineProperty(handle, 'release', { value: () => {} })).toThrow()
    expect(Object.isFrozen(Object.getPrototypeOf(handle))).toBe(true)
    expect(handle).toBeInstanceOf(leaseModule.SupervisorLeaseHandle)
    const ctor = Object.getPrototypeOf(handle).constructor as new (...args: unknown[]) => unknown
    expect(() => new ctor(Symbol(), db, 0, 'forged', 1, 10)).toThrow()
  } finally { handle.release(10); db.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('CHK-M2-03-e: corrupted generation values cannot acquire a released lease', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-lease-corrupt-generation-'))
  const db = openStore(join(dir, 'state.sqlite'))
  try {
    db.exec('PRAGMA ignore_check_constraints = ON')
    for (const generation of [0, -1, 1.5]) {
      db.prepare('DELETE FROM supervisor_lease').run()
      db.prepare("INSERT INTO supervisor_lease VALUES (1, 'old-owner', ?, 10, 'released')").run(generation)
      expect(() => acquireSupervisor(db, dir, { nowMs: 20, staleAfterMs: 10 })).toThrow()
      expect(db.prepare('SELECT generation, status FROM supervisor_lease').get()).toMatchObject({ generation, status: 'released' })
    }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('CHK-M2-03-a/c: rejects in-memory databases and missing state directories', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-lease-invalid-paths-'))
  const memory = new DatabaseSync(':memory:')
  const db = openStore(join(dir, 'state.sqlite'))
  try {
    expect(() => acquireSupervisor(memory, dir, { nowMs: 10, staleAfterMs: 10 })).toThrow(/state directory/)
    expect(() => acquireSupervisor(db, join(dir, 'missing'), { nowMs: 10, staleAfterMs: 10 })).toThrow(/state directory/)
    const handle = acquireSupervisor(db, dir, { nowMs: 10, staleAfterMs: 10 })
    handle.release(10)
  } finally { memory.close(); db.close(); rmSync(dir, { recursive: true, force: true }) }
})


it('CHK-M2-03-a/c: rejects hard-linked databases that could use different lock files', () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-lease-hardlink-'))
  const actual = join(root, 'actual')
  const alias = join(root, 'alias')
  mkdirSync(actual)
  mkdirSync(alias)
  const path = join(actual, 'state.sqlite')
  const otherPath = join(alias, 'state.sqlite')
  const db = openStore(path)
  let accidental: ReturnType<typeof acquireSupervisor> | undefined
  try {
    linkSync(path, otherPath)
    expect(() => { accidental = acquireSupervisor(db, actual, { nowMs: 10, staleAfterMs: 10 }) }).toThrow()
    unlinkSync(otherPath)
    const valid = acquireSupervisor(db, actual, { nowMs: 20, staleAfterMs: 10 })
    valid.release(20)
  } finally { try { accidental?.release(30) } catch { /* cleanup after a failing assertion */ }; db.close(); rmSync(root, { recursive: true, force: true }) }
})

it('CHK-M2-03-e: caller transaction cannot make heartbeat or release falsely appear durable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-lease-transaction-'))
  const path = join(dir, 'state.sqlite')
  const db = openStore(path)
  let handle: ReturnType<typeof acquireSupervisor> | undefined
  try {
    handle = acquireSupervisor(db, dir, { nowMs: 10, staleAfterMs: 10 })
    const active = handle
    db.exec('BEGIN')
    expect(() => active.heartbeat(11)).toThrow()
    expect(db.isTransaction).toBe(true)
    db.exec('ROLLBACK')
    active.heartbeat(12)
    db.exec('BEGIN')
    expect(() => active.release(13)).toThrow()
    expect(db.isTransaction).toBe(true)
    db.exec('ROLLBACK')
    expect(() => active.heartbeat(14)).toThrow()
    expect(db.prepare('SELECT heartbeat_ms, status FROM supervisor_lease').get()).toMatchObject({ heartbeat_ms: 12, status: 'active' })
    const recovered = acquireSupervisor(db, dir, { nowMs: 22, staleAfterMs: 10, takeover: { ownerId: active.ownerId, generation: active.generation, heartbeatMs: 12 } })
    recovered.release(22)
  } finally { if (db.isTransaction) db.exec('ROLLBACK'); try { handle?.release(50) } catch { /* already released or lost */ }; db.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('CHK-M2-03-e: a closed database cannot strand the OS lock on release failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-lease-closed-db-'))
  const path = join(dir, 'state.sqlite')
  const db = openStore(path)
  const handle = acquireSupervisor(db, dir, { nowMs: 10, staleAfterMs: 10 })
  db.close()
  try {
    expect(() => handle.release(11)).toThrow()
    const other = openStore(path)
    try {
      const recovered = acquireSupervisor(other, dir, { nowMs: 20, staleAfterMs: 10, takeover: { ownerId: handle.ownerId, generation: handle.generation, heartbeatMs: 10 } })
      recovered.release(20)
    } finally { other.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('CHK-M2-03-e: a failed heartbeat invalidates ownership and releases the OS lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-lease-heartbeat-failure-'))
  const db = openStore(join(dir, 'state.sqlite'))
  let handle: ReturnType<typeof acquireSupervisor> | undefined
  try {
    handle = acquireSupervisor(db, dir, { nowMs: 10, staleAfterMs: 10 })
    const active = handle
    db.exec("CREATE TRIGGER refuse_heartbeat BEFORE UPDATE ON supervisor_lease WHEN NEW.heartbeat_ms != OLD.heartbeat_ms BEGIN SELECT RAISE(ABORT, 'heartbeat failed'); END")
    expect(() => active.heartbeat(11)).toThrow()
    db.exec('DROP TRIGGER refuse_heartbeat')
    expect(() => active.heartbeat(12)).toThrow(LeaseLostError)
    const recovered = acquireSupervisor(db, dir, { nowMs: 20, staleAfterMs: 10, takeover: { ownerId: active.ownerId, generation: active.generation, heartbeatMs: 10 } })
    recovered.release(20)
  } finally { try { handle?.release(30) } catch { /* already released or lost */ }; db.close(); rmSync(dir, { recursive: true, force: true }) }
})
