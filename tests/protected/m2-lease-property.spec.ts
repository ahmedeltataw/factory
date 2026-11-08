import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { expect, it } from 'vitest'
import { openStore } from '../../supervisor/src/app/store.ts'
import { acquireSupervisor } from '../../supervisor/src/app/supervisor-lease.ts'
import { LeaseLostError } from '../../supervisor/src/app/supervisor-lease.ts'

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
