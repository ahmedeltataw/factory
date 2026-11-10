import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { openStore } from '../supervisor/src/app/store.ts'
import { acquireSupervisor, DEFAULT_STALE_AFTER_MS } from '../supervisor/src/app/supervisor-lease.ts'
import { formatStatus, readStatus } from '../supervisor/src/app/status.ts'

const faults = vi.hoisted(() => ({ unlock: false, close: false }))
vi.mock('fs-native-extensions', async (original) => {
  const actual = await original<typeof import('fs-native-extensions')>()
  return { ...actual, unlock: (fd: number) => { actual.unlock(fd); if (faults.unlock) throw new Error('unlock failure') } }
})
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, closeSync: (fd: number) => { actual.closeSync(fd); if (faults.close) throw new Error('close failure') } }
})
const dirs: string[] = []
function directory(): string { const dir = mkdtempSync(join(tmpdir(), 'm2-05-')); dirs.push(dir); return dir }
afterEach(() => { faults.unlock = false; faults.close = false; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

it.each(['heartbeat', 'release'] as const)('fails closed when transaction state is absent during %s', (method) => {
  const dir = directory()
  const db = openStore(join(dir, 'state.sqlite'))
  let updates = 0
  const stub = {
    exec: db.exec.bind(db),
    prepare(sql: string) { if (sql.startsWith('UPDATE supervisor_lease SET heartbeat_ms') || sql.startsWith("UPDATE supervisor_lease SET status = 'released'")) updates++; return db.prepare(sql) },
  } as unknown as DatabaseSync
  try {
    const handle = acquireSupervisor(stub, dir, { nowMs: 10, staleAfterMs: 10 })
    expect(() => handle[method](11)).toThrow(/transaction state/)
    expect(updates).toBe(0)
    expect(() => handle[method](12)).toThrow(/closed|lost/)
  } finally { db.close() }
})

it('retains the primary acquisition error and both cleanup failures', () => {
  const dir = directory()
  const db = openStore(join(dir, 'state.sqlite'))
  const primary = new Error('primary acquisition failure')
  const stub = { prepare: db.prepare.bind(db), exec(sql: string) { if (sql === 'BEGIN IMMEDIATE') throw primary; db.exec(sql) } } as unknown as DatabaseSync
  try {
    faults.unlock = true; faults.close = true
    let caught: unknown
    try { acquireSupervisor(stub, dir, { nowMs: 10, staleAfterMs: 10 }) } catch (error) { caught = error }
    expect(caught).toBe(primary)
    expect(primary.cause).toBeInstanceOf(AggregateError)
    expect((primary.cause as AggregateError).errors.map((e: Error) => e.message)).toEqual(['unlock failure', 'close failure'])
  } finally { faults.unlock = false; faults.close = false; db.close() }
})

function cli(...args: string[]) { return spawnSync(process.execPath, ['supervisor/src/cli/main.ts', ...args], { encoding: 'utf8' }) }
it('renders released facts consistently and labels the heartbeat as a timestamp', () => {
  const dir = directory(); const db = openStore(join(dir, 'state.sqlite'))
  try { db.exec("INSERT INTO supervisor_lease VALUES (1, 'owner', 2, 123, 'released')") } finally { db.close() }
  const status = readStatus(dir, { nowMs: 200, staleAfterMs: DEFAULT_STALE_AFTER_MS })
  const text = formatStatus(status)
  expect(text).toContain('\u0645\u064f\u062d\u0631\u064e\u0651\u0631')
  expect(text).toContain('\u063a\u064a\u0631 \u0645\u0646\u0637\u0628\u0642 (\u062a\u0645 \u062a\u062d\u0631\u064a\u0631 \u0627\u0644\u0645\u0644\u0643\u064a\u0629)')
  expect(text).toContain('timestamp'); expect(text).toContain('123'); expect(text).toContain('owner')
  expect(JSON.parse(cli('status', '--state-dir', dir, '--json').stdout)).toEqual(status)
})
it('validates threshold and applies it to freshness', () => {
  const dir = directory(); const db = openStore(join(dir, 'state.sqlite'))
  try { db.exec(`INSERT INTO supervisor_lease VALUES (1, 'owner', 1, ${Date.now() - 10000}, 'active')`) } finally { db.close() }
  expect(DEFAULT_STALE_AFTER_MS).toBe(300_000)
  expect(JSON.parse(cli('status', '--state-dir', dir, '--json').stdout).lease.freshness).toBe('fresh')
  expect(JSON.parse(cli('status', '--state-dir', dir, '--json', '--stale-after-ms', '1').stdout).lease.freshness).toBe('stale')
  for (const value of ['0', '-1', '1.5', '9007199254740992', 'abc']) expect(cli('status', '--state-dir', dir, '--stale-after-ms', value).status).toBe(2)
  expect(cli('status', '--state-dir', dir, '--stale-after-ms').status).toBe(2)
})
it('reports missing, unsupported and malformed databases in Arabic before details', () => {
  const dir = directory()
  const missing = cli('status', '--state-dir', dir); expect(missing.status).toBe(1); expect(missing.stderr.split('\n')[0]).toMatch(/[\u0600-\u06ff]/)
  const db = new DatabaseSync(join(dir, 'state.sqlite'))
  try { db.exec('PRAGMA user_version = 7') } finally { db.close() }
  const unsupported = cli('status', '--state-dir', dir); expect(unsupported.status).toBe(1); expect(unsupported.stderr.split('\n')[0]).toContain('\u063a\u064a\u0631 \u0645\u062f\u0639\u0648\u0645')
  const malformedDb = new DatabaseSync(join(dir, 'state.sqlite'))
  try { malformedDb.exec("PRAGMA user_version = 6; CREATE TABLE commands (id TEXT); CREATE TABLE supervisor_lease (id INTEGER, owner_id TEXT, generation INTEGER, heartbeat_ms INTEGER, status TEXT); INSERT INTO supervisor_lease VALUES (1, '', 1, 0, 'active')") } finally { malformedDb.close() }
  const malformed = cli('status', '--state-dir', dir); expect(malformed.status).toBe(1); expect(malformed.stderr.split('\n')[0]).toContain('\u063a\u064a\u0631 \u0635\u0627\u0644\u062d\u0629')
})
