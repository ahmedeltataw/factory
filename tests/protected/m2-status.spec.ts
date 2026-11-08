import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { formatStatus, readStatus } from '../../supervisor/src/app/status.ts'

const dirs: string[] = []
function directory(): string { const dir = mkdtempSync(join(tmpdir(), 'factory-status-')); dirs.push(dir); return dir }
function seed(dir: string): void {
  const db = new DatabaseSync(join(dir, 'state.sqlite'))
  try {
    db.exec("CREATE TABLE commands (id TEXT PRIMARY KEY, payload_json TEXT); INSERT INTO commands VALUES ('c1', 'private-payload'), ('c2', '{}'); CREATE TABLE supervisor_lease (id INTEGER PRIMARY KEY, owner_id TEXT, generation INTEGER, heartbeat_ms INTEGER, status TEXT); PRAGMA user_version = 4")
  } finally { db.close() }
}
function hash(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex') }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

it('CHK-M2-04-a/c: reports observations without inventing live state or exposing payloads', () => {
  const dir = directory()
  seed(dir)
  const options = { nowMs: 2000, staleAfterMs: 500 }
  const path = join(dir, 'state.sqlite')
  const before = hash(path)
  expect(readStatus(dir, options)).toEqual({ schemaVersion: 4, recordedCommandCount: 2, lease: null })
  expect(hash(path)).toBe(before)
  const db = new DatabaseSync(path)
  try { db.exec("INSERT INTO supervisor_lease VALUES (1, 'owner', 3, 1800, 'active')") } finally { db.close() }
  const status = readStatus(dir, options)
  expect(status).toEqual({ schemaVersion: 4, recordedCommandCount: 2, lease: { ownerId: 'owner', generation: 3, heartbeatMs: 1800, state: 'active', freshness: 'fresh' } })
  expect(JSON.stringify(status)).not.toContain('private-payload')
  const arabic = formatStatus(status)
  expect(arabic).toMatch(/[\u0600-\u06ff]/)
  expect(arabic).toContain('2')
  expect(arabic).toContain('owner')
  expect(arabic).not.toContain('private-payload')
  expect(arabic).not.toMatch(/RUNNING/i)
})

it('CHK-M2-04-a: distinguishes stale, future and released heartbeats', () => {
  const dir = directory()
  seed(dir)
  const db = new DatabaseSync(join(dir, 'state.sqlite'))
  try {
    db.exec("INSERT INTO supervisor_lease VALUES (1, 'owner', 1, 1500, 'active')")
    expect(readStatus(dir, { nowMs: 2000, staleAfterMs: 500 }).lease?.freshness).toBe('stale')
    db.exec("UPDATE supervisor_lease SET heartbeat_ms = 2001")
    expect(readStatus(dir, { nowMs: 2000, staleAfterMs: 500 }).lease?.freshness).toBe('future')
    db.exec("UPDATE supervisor_lease SET status = 'released'")
    expect(readStatus(dir, { nowMs: 2000, staleAfterMs: 500 }).lease?.freshness).toBe('not-applicable')
  } finally { db.close() }
})

it('CHK-M2-04-b: does not create missing DBs and rejects incompatible and malformed data', () => {
  const dir = directory()
  const path = join(dir, 'state.sqlite')
  expect(() => readStatus(dir, { nowMs: 2000, staleAfterMs: 500 })).toThrow()
  expect(existsSync(path)).toBe(false)
  seed(dir)
  const db = new DatabaseSync(path)
  db.exec('PRAGMA user_version = 999')
  db.close()
  const before = hash(path)
  expect(() => readStatus(dir, { nowMs: 2000, staleAfterMs: 500 })).toThrow()
  expect(() => readStatus(dir, { nowMs: -1, staleAfterMs: 500 })).toThrow()
  expect(() => readStatus(dir, { nowMs: 2000, staleAfterMs: 0 })).toThrow()
  expect(hash(path)).toBe(before)
})
