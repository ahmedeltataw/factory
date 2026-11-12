import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { init } from '../supervisor/src/app/init.ts'
import { openStore } from '../supervisor/src/app/store.ts'

const dirs: string[] = []
function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-m5-03-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

it('seeds ordered phases for each project during upgrade and keeps them on reopen', () => {
  const path = join(stateDir(), 'state.sqlite')
  const old = new DatabaseSync(path)
  old.exec("CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL); INSERT INTO projects VALUES ('a','A','old'),('b','B','old'); PRAGMA user_version = 1")
  old.close()
  for (let pass = 0; pass < 2; pass++) {
    const db = openStore(path)
    try {
      const rows = db.prepare('SELECT project_id, name, ord, status, opened_at, closed_at FROM phases ORDER BY project_id, ord').all()
      expect(rows).toHaveLength(10)
      for (const [i, row] of rows.entries()) {
        const ord = i % 5
        expect(row).toMatchObject({ project_id: i < 5 ? 'a' : 'b', name: ['intake', 'development', 'qa', 'devops', 'handover'][ord], ord: ord + 1, status: ord === 0 ? 'open' : 'locked', closed_at: null })
        expect(ord === 0 ? typeof row.opened_at : row.opened_at).toBe(ord === 0 ? 'string' : null)
      }
    } finally { db.close() }
  }
})

it('initializes phases with the project and rolls back if phase insertion fails', () => {
  const dir = stateDir()
  init(dir, process.cwd())
  const db = new DatabaseSync(join(dir, 'state.sqlite'))
  try {
    const rows = db.prepare('SELECT p.created_at, ph.name, ph.status, ph.opened_at FROM projects p JOIN phases ph ON ph.project_id = p.id ORDER BY ph.ord').all()
    expect(rows.map(row => row.name)).toEqual(['intake', 'development', 'qa', 'devops', 'handover'])
    expect(rows.map(row => row.status)).toEqual(['open', 'locked', 'locked', 'locked', 'locked'])
    expect(rows[0]!.opened_at).toBe(rows[0]!.created_at)
    expect(rows.slice(1).every(row => row.opened_at === null)).toBe(true)
  } finally { db.close() }

  const failed = stateDir()
  const prepare = DatabaseSync.prototype.prepare
  vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
    if (sql.startsWith('INSERT INTO phases')) throw new Error('phase insertion failed')
    return prepare.call(this, sql)
  })
  expect(() => init(failed, process.cwd())).toThrow('phase insertion failed')
  vi.restoreAllMocks()
  const check = new DatabaseSync(join(failed, 'state.sqlite'))
  try {
    expect(check.prepare('SELECT count(*) AS n FROM projects').get()).toEqual({ n: 0 })
    expect(check.prepare('SELECT count(*) AS n FROM phases').get()).toEqual({ n: 0 })
  } finally { check.close() }
})
