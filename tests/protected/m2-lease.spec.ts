import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openStore } from '../../supervisor/src/app/store.ts'
import { acquireSupervisor, LeaseLostError } from '../../supervisor/src/app/supervisor-lease.ts'

const directories: string[] = []
function stateDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'factory-lease-'))
  directories.push(directory)
  return directory
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('M2-03 Supervisor lease', () => {
  it('CHK-M2-03-a: upgrades version 3 without losing projects or commands', () => {
    const dir = stateDir()
    const path = join(dir, 'state.sqlite')
    const old = new DatabaseSync(path)
    old.exec("CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL); CREATE INDEX projects_name_idx ON projects(name); CREATE TABLE commands (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id), kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL); INSERT INTO projects VALUES ('p1', 'Project', '2026-01-01T00:00:00.000Z'); INSERT INTO commands VALUES ('c1', 'p1', 'create', '{}', '2026-01-01T00:00:00.000Z'); PRAGMA user_version = 3")
    old.close()
    const db = openStore(path)
    try {
      expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 7 })
      expect(db.prepare("SELECT name FROM projects WHERE id = 'p1'").get()).toMatchObject({ name: 'Project' })
      expect(db.prepare("SELECT project_id FROM commands WHERE id = 'c1'").get()).toMatchObject({ project_id: 'p1' })
    } finally { db.close() }
  })

  it('CHK-M2-03-a: rejects a state directory that is not the connection database', () => {
    const dir = stateDir()
    const other = join(dir, 'other')
    mkdirSync(other)
    const db = openStore(join(dir, 'state.sqlite'))
    try {
      expect(() => acquireSupervisor(db, other, { nowMs: 1000, staleAfterMs: 1000 })).toThrow()
      const handle = acquireSupervisor(db, dir, { nowMs: 1000, staleAfterMs: 1000 })
      try { expect(handle.generation).toBeGreaterThan(0) } finally { handle.release(1001) }
    } finally { db.close() }
  })

  it('CHK-M2-03-b: acquires, heartbeats, releases and refuses use after release', () => {
    const dir = stateDir()
    const db = openStore(join(dir, 'state.sqlite'))
    try {
      expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 7 })
      const handle = acquireSupervisor(db, dir, { nowMs: 1000, staleAfterMs: 1000 })
      try {
        expect(handle.generation).toBe(1)
        expect(handle.ownerId).toMatch(/^[0-9a-f-]{36}$/i)
        handle.heartbeat(1100)
        expect(db.prepare('SELECT owner_id, generation, heartbeat_ms, status FROM supervisor_lease WHERE id = 1').get()).toMatchObject({ owner_id: handle.ownerId, generation: 1, heartbeat_ms: 1100, status: 'active' })
        expect(() => handle.heartbeat(1099)).toThrow()
        expect(() => handle.heartbeat(-1)).toThrow()
        handle.release(1200)
        expect(db.prepare('SELECT status FROM supervisor_lease WHERE id = 1').get()).toMatchObject({ status: 'released' })
        expect(() => handle.heartbeat(1300)).toThrow()
        expect(() => handle.release(1300)).toThrow()
        const next = acquireSupervisor(db, dir, { nowMs: 1300, staleAfterMs: 1000 })
        try {
          expect(next.generation).toBe(2)
          expect(next.ownerId).not.toBe(handle.ownerId)
        } finally { next.release(1300) }
      } finally { try { handle.release(1400) } catch { /* already released or lost */ } }
    } finally { db.close() }
  })

  it('CHK-M2-03-e: a displaced owner cannot renew or release a changed lease', () => {
    const dir = stateDir()
    const db = openStore(join(dir, 'state.sqlite'))
    try {
      const handle = acquireSupervisor(db, dir, { nowMs: 1000, staleAfterMs: 1000 })
      db.prepare("UPDATE supervisor_lease SET owner_id = 'different', generation = generation + 1 WHERE id = 1").run()
      expect(() => handle.heartbeat(1100)).toThrow(LeaseLostError)
      expect(() => handle.release(1200)).toThrow()
      expect(db.prepare('SELECT owner_id, generation FROM supervisor_lease WHERE id = 1').get()).toMatchObject({ owner_id: 'different', generation: 2 })
    } finally { db.close() }
  })
})
