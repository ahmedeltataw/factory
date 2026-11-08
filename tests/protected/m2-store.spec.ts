import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openStore } from '../../supervisor/src/app/store.ts'

const directories: string[] = []
function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'factory-m2-store-'))
  directories.push(directory)
  return join(directory, 'state.sqlite')
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('M2-01 SQLite storage contract', () => {
  it('CHK-M2-01-a: initializes the required settings and version', () => {
    const db = openStore(databasePath())
    try {
      expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 2 })
      expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 })
      expect(db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' })
      expect(db.prepare('PRAGMA busy_timeout').get()).toMatchObject({ timeout: 5000 })
      db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run('p1', 'Factory', '2026-11-08T00:00:00Z')
      expect(db.prepare('SELECT name FROM projects WHERE id = ?').get('p1')).toMatchObject({ name: 'Factory' })
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'projects_name_idx'").get()).toBeDefined()
    } finally { db.close() }
  })

  it('CHK-M2-01-b: upgrades and reopens without losing projects', () => {
    const path = databasePath()
    const old = new DatabaseSync(path)
    old.exec("CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL); INSERT INTO projects VALUES ('p1', 'Existing', '2026-01-01T00:00:00Z'); PRAGMA user_version = 1")
    old.close()
    for (let attempt = 0; attempt < 2; attempt++) {
      const db = openStore(path)
      try {
        expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 2 })
        expect(db.prepare('SELECT name FROM projects WHERE id = ?').get('p1')).toMatchObject({ name: 'Existing' })
        expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'projects_name_idx'").get()).toBeDefined()
      } finally { db.close() }
    }
  })

  it('CHK-M2-01-c: rolls back a failed upgrade', () => {
    const path = databasePath()
    const old = new DatabaseSync(path)
    old.exec("CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, created_at TEXT NOT NULL); INSERT INTO projects VALUES ('p1', 'preserved'); PRAGMA user_version = 1")
    old.close()
    expect(() => openStore(path)).toThrow()
    const check = new DatabaseSync(path)
    try {
      expect(check.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 1 })
      expect(check.prepare('SELECT created_at FROM projects WHERE id = ?').get('p1')).toMatchObject({ created_at: 'preserved' })
      expect(check.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'projects_name_idx'").get()).toBeUndefined()
    } finally { check.close() }
  })

  it('CHK-M2-01-c: rejects a newer schema without changing data', () => {
    const path = databasePath()
    const future = new DatabaseSync(path)
    future.exec("CREATE TABLE future_data (value TEXT NOT NULL); INSERT INTO future_data VALUES ('preserved'); PRAGMA user_version = 999")
    future.close()
    expect(() => openStore(path)).toThrow()
    const check = new DatabaseSync(path)
    try {
      expect(check.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 999 })
      expect(check.prepare('SELECT value FROM future_data').get()).toMatchObject({ value: 'preserved' })
    } finally { check.close() }
  })
})
