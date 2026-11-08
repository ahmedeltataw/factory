/// <reference path="./native-lock.d.ts" />

import { join } from 'node:path'
import { closeSync, openSync, realpathSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { tryLock, unlock } from 'fs-native-extensions'

const LOCK_FILE = 'supervisor.lock'
const DATABASE_FILE = 'state.sqlite'

/** Thrown when a handle no longer matches the persisted lease row (displaced, closed or lost). */
export class LeaseLostError extends Error {
  constructor(message = 'supervisor: lease handle is closed, lost or displaced') {
    super(message)
    this.name = 'LeaseLostError'
  }
}

function requireSafeInteger(value: unknown, name: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`supervisor: ${name} must be a safe integer >= ${minimum}`)
  }
  return value
}

function requireOwnerId(value: unknown, name = 'takeover.ownerId'): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`supervisor: ${name} must be a nonempty string`)
  }
  return value
}

/** Greatest generation that can still be incremented within the safe-integer range. */
const MAX_SAFE_GENERATION = Number.MAX_SAFE_INTEGER

function nextGeneration(value: number): number {
  const incremented = value + 1
  if (!Number.isSafeInteger(incremented)) {
    throw new Error(`supervisor: generation increment would overflow the safe integer range`)
  }
  return incremented
}

function mainDatabaseFile(db: DatabaseSync): string | undefined {
  const rows = db.prepare('PRAGMA database_list').all() as Array<{ name: string; file: string } | undefined>
  for (const row of rows ?? []) {
    if (row?.name === 'main') return row.file ?? undefined
  }
  return undefined
}

function resolveSamePath(a: string, b: string): boolean {
  try {
    return realpathSync.native(a) === realpathSync.native(b)
  } catch {
    return false
  }
}

interface TakeoverEvidence {
  readonly ownerId: string
  readonly generation: number
  readonly heartbeatMs: number
}

interface LeaseOptions {
  readonly nowMs: number
  readonly staleAfterMs: number
  readonly takeover?: TakeoverEvidence
}

interface LeaseRow {
  readonly ownerId: string
  readonly generation: number
  readonly heartbeatMs: number
  readonly status: string
}

/**
 * Acquire the supervisor ownership lease for the database in stateDir.
 *
 * The caller's database connection is left open on every outcome. The OS lock
 * file (`supervisor.lock` inside stateDir) is never deleted. Fails closed:
 * every failed acquisition releases the OS lock and closes the lock descriptor.
 */
export function acquireSupervisor(db: DatabaseSync, stateDir: string, options: LeaseOptions) {
  const nowMs = requireSafeInteger(options?.nowMs, 'nowMs', 0)
  const staleAfterMs = requireSafeInteger(options?.staleAfterMs, 'staleAfterMs', 1)

  let takeover: TakeoverEvidence | undefined
  if (options?.takeover !== undefined) {
    takeover = {
      ownerId: requireOwnerId(options.takeover.ownerId),
      generation: requireSafeInteger(options.takeover.generation, 'takeover.generation', 1),
      heartbeatMs: requireSafeInteger(options.takeover.heartbeatMs, 'takeover.heartbeatMs', 0),
    }
  }

  const stateDatabase = join(stateDir, DATABASE_FILE)
  const lockFile = join(stateDir, LOCK_FILE)

  // The provided connection's main database must be state.sqlite inside stateDir before any lock is taken.
  const main = mainDatabaseFile(db)
  if (main === undefined || !resolveSamePath(main, stateDatabase)) {
    throw new Error('supervisor: state directory does not contain the connection database')
  }

  const fd = openSync(lockFile, 'a+')
  let closed = false
  // `locked` is true only while this acquisition actually holds the OS lock.
  // `closeLock` must never unlock an unheld lock and must close the descriptor once only.
  let locked = false
  const closeLock = (): void => {
    if (closed) return
    closed = true
    if (locked) {
      try { unlock(fd) } catch { /* best effort: close the descriptor below either way */ }
    }
    try { closeSync(fd) } catch { /* descriptor already closed */ }
  }

  try {
    // Cooperative processes serialize here; a live OS lock blocks acquisition even for a stale-looking lease.
    if (!tryLock(fd)) {
      closeLock()
      throw new Error('supervisor: OS lock is held by another process')
    }
    locked = true

    let ownerId: string
    let generation: number
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = db.prepare('SELECT owner_id AS ownerId, generation, heartbeat_ms AS heartbeatMs, status FROM supervisor_lease WHERE id = 1').get() as LeaseRow | undefined

      if (row === undefined) {
        generation = 1
        ownerId = randomUUID()
        db.prepare("INSERT INTO supervisor_lease (id, owner_id, generation, heartbeat_ms, status) VALUES (1, ?, 1, ?, 'active')").run(ownerId, nowMs)
      } else if (row.status === 'released') {
        generation = nextGeneration(row.generation)
        ownerId = randomUUID()
        const result = db.prepare("UPDATE supervisor_lease SET owner_id = ?, generation = ?, heartbeat_ms = ?, status = 'active' WHERE id = 1 AND generation = ? AND status = 'released'").run(ownerId, generation, nowMs, row.generation)
        if (result.changes !== 1) throw new Error('supervisor: released lease changed during acquisition')
      } else {
        // Explicit narrowing: once this guard throws, `takeover` is definitely defined.
        if (
          takeover === undefined
          || nowMs - row.heartbeatMs < staleAfterMs
          || row.ownerId !== takeover.ownerId
          || row.generation !== takeover.generation
          || row.heartbeatMs !== takeover.heartbeatMs
        ) {
          throw new Error('supervisor: active supervisor lease blocks acquisition')
        }
        generation = nextGeneration(row.generation)
        ownerId = randomUUID()
        const result = db.prepare("UPDATE supervisor_lease SET owner_id = ?, generation = ?, heartbeat_ms = ?, status = 'active' WHERE id = 1 AND owner_id = ? AND generation = ? AND heartbeat_ms = ? AND status = 'active'")
          .run(ownerId, generation, nowMs, takeover.ownerId, takeover.generation, takeover.heartbeatMs)
        if (result.changes !== 1) throw new Error('supervisor: takeover evidence no longer matches the lease row')
      }

      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* the failed statement may already have ended the transaction */ }
      closeLock()
      throw error
    }

    return new SupervisorLeaseHandle(db, fd, ownerId, generation, nowMs)
  } catch (error) {
    closeLock()
    throw error
  }
}

/** Handle for one held lease. Truly immutable ownerId and generation; heartbeat/release are CAS-guarded. */
export class SupervisorLeaseHandle {
  #ownerId: string
  #generation: number

  private readonly db: DatabaseSync
  private readonly fd: number
  private closed = false
  private lost = false
  private lastHeartbeat: number

  constructor(db: DatabaseSync, fd: number, ownerId: string, generation: number, lastHeartbeat: number) {
    this.db = db
    this.fd = fd
    this.#ownerId = ownerId
    this.#generation = generation
    this.lastHeartbeat = lastHeartbeat
  }

  get ownerId(): string {
    return this.#ownerId
  }

  get generation(): number {
    return this.#generation
  }

  private assertHeld(): void {
    if (this.closed || this.lost) throw new LeaseLostError()
  }

  private closeLock(): void {
    if (this.closed) return
    this.closed = true
    try { unlock(this.fd) } catch { /* best effort: the descriptor is closed below either way */ }
    try { closeSync(this.fd) } catch { /* descriptor already closed */ }
  }

  private markLost(): void {
    this.lost = true
    this.closeLock()
  }

  /** Refresh heartbeat_ms on the row this handle owns; rejects backwards clocks and lost handles. */
  heartbeat(nowMs: number): void {
    const time = requireSafeInteger(nowMs, 'nowMs', 0)
    this.assertHeld()
    if (time < this.lastHeartbeat) throw new Error('supervisor: heartbeat before the last heartbeat')
    const result = this.db.prepare("UPDATE supervisor_lease SET heartbeat_ms = ? WHERE id = 1 AND owner_id = ? AND generation = ? AND status = 'active'")
      .run(time, this.#ownerId, this.#generation)
    if (result.changes !== 1) {
      this.markLost()
      throw new LeaseLostError('supervisor: lease row no longer matches this handle')
    }
    this.lastHeartbeat = time
  }

  /** Mark the owned row released, release the OS lock and close the lock descriptor. */
  release(nowMs: number): void {
    const time = requireSafeInteger(nowMs, 'nowMs', 0)
    this.assertHeld()
    let released = false
    try {
      const result = this.db.prepare("UPDATE supervisor_lease SET status = 'released' WHERE id = 1 AND owner_id = ? AND generation = ? AND status = 'active'")
        .run(this.#ownerId, this.#generation)
      released = result.changes === 1
      if (!released) throw new LeaseLostError('supervisor: lease row no longer matches this handle')
    } finally {
      this.closeLock()
      if (!released) this.lost = true
    }
  }
}
