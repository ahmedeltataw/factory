import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { openStore } from '../supervisor/src/app/store.ts'

const directories: string[] = []
function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'factory-m2-property-'))
  directories.push(directory)
  return join(directory, 'state.sqlite')
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

type Project = { id: string; name: string }

describe('M2-02 storage property (CHK-M2-TOOLS-b)', () => {
  it('preserves every generated project across migration from v1 and reopening is idempotent', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 16 }),
            name: fc.string({ minLength: 1, maxLength: 16 }),
          }),
          { minLength: 1, maxLength: 8, selector: (project: Project) => project.id },
        ),
        (projects) => {
          const path = databasePath()
          const old = new DatabaseSync(path)
          try {
            old.exec(
              'CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL)',
            )
            const insert = old.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)')
            for (const project of projects) insert.run(project.id, project.name, '2026-01-01T00:00:00Z')
            old.exec('PRAGMA user_version = 1')
          } finally {
            old.close()
          }

          const expected = [...projects]
            .map((project) => ({ ...project, created_at: '2026-01-01T00:00:00Z' }))
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

          // migrate once, then reopen: both passes must see the exact same data
          for (let attempt = 0; attempt < 2; attempt++) {
            const db = openStore(path)
            try {
              expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 8 })
              expect(db.prepare('SELECT id, name, created_at FROM projects ORDER BY id').all()).toEqual(expected)
            } finally {
              db.close()
            }
          }
        },
      ),
      { numRuns: 25 },
    )
  })
})
