import type { DatabaseSync } from 'node:sqlite'
import { LeaseLostError, type SupervisorLeaseHandle } from './supervisor-lease.ts'

export function fencedWrite<T>(db: DatabaseSync, handle: SupervisorLeaseHandle, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = db.prepare("SELECT 1 FROM supervisor_lease WHERE id = 1 AND owner_id = ? AND generation = ? AND status = 'active'").get(handle.ownerId, handle.generation)
    if (row === undefined) throw new LeaseLostError()
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* transaction may already have ended */ }
    throw error
  }
}
