import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { openStore } from '../supervisor/src/app/store.ts'

type Project = { id: string; name: string }

const V1_SCHEMA = 'CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL)'
const SCHEMA_OBJECTS = "SELECT type, name FROM sqlite_master WHERE type IN ('table', 'trigger') AND name NOT LIKE 'sqlite_%'"

/**
 * Return the single reused database file to the exact v1 state: no tables or triggers left over
 * from an earlier sample, the v1 projects table populated, and `user_version` back to 1 so the
 * next `openStore` replays migrations 2..9.
 *
 * The journal mode is also restored: `openStore` switches the file to WAL, which persists across
 * connections even after SQLite removes the `-wal` and `-shm` files on close, so every sample must
 * start in the original `DELETE` mode again.
 */
function resetToV1(path: string, projects: readonly Project[]): void {
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA foreign_keys = OFF')
    db.exec('PRAGMA journal_mode = DELETE')
    const objects = db.prepare(SCHEMA_OBJECTS).all() as Array<{ type: string; name: string }>
    for (const object of objects) if (object.type === 'trigger') db.exec(`DROP TRIGGER IF EXISTS "${object.name}"`)
    for (const object of objects) if (object.type === 'table') db.exec(`DROP TABLE IF EXISTS "${object.name}"`)
    db.exec(V1_SCHEMA)
    const insert = db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)')
    for (const project of projects) insert.run(project.id, project.name, '2026-01-01T00:00:00Z')
    db.exec('PRAGMA user_version = 1')
  } finally {
    db.close()
  }
}

describe('M2-02 storage property (CHK-M2-TOOLS-b)', () => {
  it('preserves every generated project across migration from v1 and reopening is idempotent', () => {
    // One temp directory and one SQLite file are shared by all fast-check samples; a fresh database
    // per sample made this test exceed its budget on windows-latest CI.
    const directory = mkdtempSync(join(tmpdir(), 'factory-m2-property-'))
    const path = join(directory, 'state.sqlite')
    try {
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
            resetToV1(path, projects)

            const expected = [...projects]
              .map((project) => ({ ...project, created_at: '2026-01-01T00:00:00Z' }))
              .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

            // migrate once, then reopen: both passes must see the exact same data
            for (let attempt = 0; attempt < 2; attempt++) {
              const db = openStore(path)
              try {
                expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 9 })
                expect(db.prepare('SELECT id, name, created_at FROM projects ORDER BY id').all()).toEqual(expected)
              } finally {
                db.close()
              }
            }
          },
        ),
        { numRuns: 25 },
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
