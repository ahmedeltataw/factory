import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openStore } from '../../supervisor/src/app/store.ts'
import { appendCommand, CommandConflictError } from '../../supervisor/src/app/commands.ts'

const directories: string[] = []
function pathForTest(): string {
  const directory = mkdtempSync(join(tmpdir(), 'factory-m2-command-'))
  directories.push(directory)
  return join(directory, 'state.sqlite')
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const command = {
  id: 'command-1', projectId: 'project-1', kind: 'task.create',
  payloadJson: '{"title":"Hello"}', createdAt: '2026-11-08T00:00:00.000Z',
}
function seed(db: DatabaseSync): void {
  db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run('project-1', 'Factory', command.createdAt)
}
function count(db: DatabaseSync): unknown {
  return db.prepare('SELECT COUNT(*) AS count FROM commands').get()
}

describe('M2-02 append-only command log', () => {
  it('CHK-M2-02-a: upgrades a version-2 database without losing projects', () => {
    const path = pathForTest()
    const old = new DatabaseSync(path)
    old.exec("CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL); CREATE INDEX projects_name_idx ON projects(name); INSERT INTO projects VALUES ('project-1', 'Existing', '2026-01-01T00:00:00Z'); PRAGMA user_version = 2")
    old.close()
    const db = openStore(path)
    try {
      expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 6 })
      expect(db.prepare("SELECT name FROM projects WHERE id = 'project-1'").get()).toMatchObject({ name: 'Existing' })
      expect(appendCommand(db, command)).toBe('created')
    } finally { db.close() }
  })

  it('CHK-M2-02-b: preserves an immutable command and returns duplicate after reopen', () => {
    const path = pathForTest()
    const db = openStore(path)
    try {
      seed(db)
      expect(appendCommand(db, command)).toBe('created')
      expect(appendCommand(db, command)).toBe('duplicate')
      expect(count(db)).toMatchObject({ count: 1 })
    } finally { db.close() }
    const reopened = openStore(path)
    try {
      expect(appendCommand(reopened, command)).toBe('duplicate')
      expect(reopened.prepare('SELECT * FROM commands WHERE id = ?').get(command.id)).toMatchObject({
        id: command.id, project_id: command.projectId, kind: command.kind,
        payload_json: command.payloadJson, created_at: command.createdAt,
      })
    } finally { reopened.close() }
  })

  it('CHK-M2-02-c: rejects conflicting and invalid envelopes without modifying existing commands', () => {
    const db = openStore(pathForTest())
    try {
      seed(db)
      appendCommand(db, command)
      for (const change of [
        { projectId: 'other' }, { kind: 'other' }, { payloadJson: '{ "title":"Hello" }' },
        { createdAt: '2026-11-09T00:00:00.000Z' },
      ]) expect(() => appendCommand(db, { ...command, ...change })).toThrow(CommandConflictError)
      for (const change of [
        { id: ' ' }, { projectId: ' ' }, { kind: '\t' }, { kind: '\u00a0' }, { payloadJson: '{' },
        { createdAt: '2026-11-08' }, { createdAt: '2026-02-30T00:00:00.000Z' },
      ]) expect(() => appendCommand(db, { ...command, id: 'new', ...change })).toThrow()
      expect(() => appendCommand(db, { ...command, id: 'new', projectId: 'missing' })).toThrow()
      expect(count(db)).toMatchObject({ count: 1 })
    } finally { db.close() }
  })

  it('CHK-M2-02-d: enforces immutability and constraints at the SQL layer', () => {
    const db = openStore(pathForTest())
    try {
      seed(db)
      appendCommand(db, command)
      expect(() => db.exec("UPDATE commands SET kind = 'changed' WHERE id = 'command-1'")).toThrow()
      expect(() => db.exec("DELETE FROM commands WHERE id = 'command-1'")).toThrow()
      try { db.exec("INSERT OR REPLACE INTO commands VALUES ('command-1', 'project-1', 'replaced', '{}', '2026-11-08T00:00:00.000Z')") } catch { /* rejection is also valid */ }
      expect(db.prepare("SELECT kind FROM commands WHERE id = 'command-1'").get()).toMatchObject({ kind: command.kind })
      const insert = db.prepare('INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
      expect(() => insert.run(' ', 'project-1', 'x', '{}', command.createdAt)).toThrow()
      expect(() => insert.run('tab', 'project-1', '\t\n', '{}', command.createdAt)).toThrow()
      expect(() => insert.run('bad-json', 'project-1', 'x', '{', command.createdAt)).toThrow()
      expect(() => insert.run('bad-project', 'missing', 'x', '{}', command.createdAt)).toThrow()
      expect(count(db)).toMatchObject({ count: 1 })
    } finally { db.close() }
  })

  it('CHK-M2-02-d: respects the caller transaction and rollback', () => {
    const db = openStore(pathForTest())
    try {
      seed(db)
      db.exec('BEGIN IMMEDIATE')
      expect(appendCommand(db, command)).toBe('created')
      db.exec('ROLLBACK')
      expect(count(db)).toMatchObject({ count: 0 })
    } finally { db.close() }
  })

  it('CHK-M2-02-e: separate connections deduplicate a repeated ID', () => {
    const path = pathForTest()
    const first = openStore(path)
    const second = openStore(path)
    try {
      seed(first)
      expect(appendCommand(first, command)).toBe('created')
      expect(appendCommand(second, command)).toBe('duplicate')
      expect(count(second)).toMatchObject({ count: 1 })
    } finally { first.close(); second.close() }
  })
})
