import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

/** Storage schema version this status reader supports: the M2-03 storage schema. */
const SCHEMA_VERSION = 4

export type LeaseState = 'active' | 'released'
export type LeaseFreshness = 'fresh' | 'stale' | 'future' | 'not-applicable'

export interface Lease {
  readonly ownerId: string
  readonly generation: number
  readonly heartbeatMs: number
  readonly state: LeaseState
  readonly freshness: LeaseFreshness
}

export interface Status {
  readonly schemaVersion: 4
  readonly recordedCommandCount: number
  readonly lease: null | Lease
}

export interface ReadStatusOptions {
  readonly nowMs: number
  readonly staleAfterMs: number
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

interface LeaseRow {
  readonly owner_id: unknown
  readonly generation: unknown
  readonly heartbeat_ms: unknown
  readonly status: unknown
}

function isLeaseRow(value: unknown): value is LeaseRow & {
  readonly owner_id: string
  readonly generation: number
  readonly heartbeat_ms: number
  readonly status: LeaseState
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as LeaseRow
  return (
    typeof row.owner_id === 'string' &&
    row.owner_id.trim().length > 0 &&
    Number.isSafeInteger(row.generation as number) &&
    (row.generation as number) > 0 &&
    Number.isSafeInteger(row.heartbeat_ms as number) &&
    (row.heartbeat_ms as number) >= 0 &&
    (row.status === 'active' || row.status === 'released')
  )
}

/** Classify an active lease heartbeat without treating freshness as proof of liveness. */
function heartbeatFreshness(
  state: LeaseState,
  heartbeatMs: number,
  nowMs: number,
  staleAfterMs: number,
): LeaseFreshness {
  if (state === 'released') return 'not-applicable'
  if (heartbeatMs > nowMs) return 'future'
  if (nowMs - heartbeatMs >= staleAfterMs) return 'stale'
  return 'fresh'
}

/**
 * Read a snapshot of the supervisor status from an existing version-4 database.
 * Opens the database in SQLite read-only mode: never migrates, never writes,
 * never reads payloads, and always closes its connection.
 */
export function readStatus(stateDir: string, options: ReadStatusOptions): Status {
  const { nowMs, staleAfterMs } = options
  if (!isNonnegativeSafeInteger(nowMs)) throw new Error('status: nowMs must be a nonnegative safe integer')
  if (!isPositiveSafeInteger(staleAfterMs)) throw new Error('status: staleAfterMs must be a positive safe integer')

  const path = join(stateDir, 'state.sqlite')
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const versionRow = db.prepare('PRAGMA user_version').get() as { readonly user_version?: number } | undefined
    if (Number(versionRow?.user_version) !== SCHEMA_VERSION) {
      throw new Error(`status: unsupported schema version ${Number(versionRow?.user_version)}`)
    }

    const countRow = db
      .prepare('SELECT COUNT(*) AS count FROM commands')
      .get() as { readonly count?: unknown } | undefined
    if (!isNonnegativeSafeInteger(countRow?.count)) {
      throw new Error('status: command count is not a nonnegative safe integer')
    }
    const recordedCommandCount = countRow.count

    const leaseRow = db
      .prepare('SELECT owner_id, generation, heartbeat_ms, status FROM supervisor_lease LIMIT 1')
      .get() as LeaseRow | undefined

    let lease: null | Lease = null
    if (leaseRow !== undefined) {
      if (!isLeaseRow(leaseRow)) throw new Error('status: malformed supervisor_lease row')
      lease = {
        ownerId: leaseRow.owner_id,
        generation: leaseRow.generation,
        heartbeatMs: leaseRow.heartbeat_ms,
        state: leaseRow.status,
        freshness: heartbeatFreshness(leaseRow.status, leaseRow.heartbeat_ms, nowMs, staleAfterMs),
      }
    }

    return { schemaVersion: SCHEMA_VERSION, recordedCommandCount, lease }
  } finally {
    db.close()
  }
}

function freshnessLabel(freshness: LeaseFreshness): string {
  switch (freshness) {
    case 'fresh':
      return 'حديث (لا يشكل دليلاً على أن العملية قيد التشغيل)'
    case 'stale':
      return 'قديم'
    case 'future':
      return 'في المستقبل'
    case 'not-applicable':
      return 'غير مطبق (تم الإطلاق)'
  }
}

/**
 * Render the same status facts in clear Arabic text: heartbeat freshness is
 * described explicitly and never mistaken for a live process, and no payloads
 * or secrets are included.
 */
export function formatStatus(status: Status): string {
  const lines: string[] = [
    `إصدار المخطط: ${status.schemaVersion}`,
    `عدد الأوامر المسجلة: ${status.recordedCommandCount}`,
  ]
  if (status.lease === null) {
    lines.push('الملكية: غير موجود')
  } else {
    const { ownerId, generation, heartbeatMs, state, freshness } = status.lease
    const stateLabel = state === 'active' ? 'نشط' : 'مُطْلَق'
    lines.push(
      `الملكية: المالك="${ownerId}", الجيل=${generation}, النبض=${heartbeatMs} ميلي ثانية, الحالة=${stateLabel}, حداثة النبض=${freshnessLabel(freshness)}`,
    )
  }
  return lines.join('\n')
}
