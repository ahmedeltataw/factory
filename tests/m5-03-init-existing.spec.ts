import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { init } from '../supervisor/src/app/init.ts'
import { openStore } from '../supervisor/src/app/store.ts'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-m5-03-'))
  dirs.push(dir)
  return dir
}
function repo(): string {
  const dir = tempDir()
  execFileSync('git', ['init', dir], { stdio: 'ignore' })
  execFileSync('git', ['-C', dir, '-c', 'user.name=Factory Test', '-c', 'user.email=factory@example.com', 'commit', '--allow-empty', '-m', 'initial'], { stdio: 'ignore' })
  return dir
}
function snapshot(path: string): unknown {
  const db = new DatabaseSync(path)
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>
    return tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()])
  } finally { db.close() }
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

it('reinitializes the same repository without changing state and closes the read-only connection', () => {
  const state = tempDir()
  const repository = repo()
  const path = join(state, 'state.sqlite')
  init(state, repository)
  const before = snapshot(path)
  const close = vi.spyOn(DatabaseSync.prototype, 'close')
  init(state, join(repository, '.'))
  expect(close).toHaveBeenCalledTimes(1)
  expect(snapshot(path)).toEqual(before)
  const db = new DatabaseSync(path)
  try {
    expect(db.prepare('SELECT name FROM projects').get()).toEqual({ name: basename(repository) })
    const config = db.prepare('SELECT base_ref FROM project_config').get() as { base_ref: string }
    expect(config.base_ref).toBe(execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim())
    db.exec('BEGIN IMMEDIATE; COMMIT')
  } finally { db.close() }
  rmSync(path)
})

it('rejects a different repository and closes the existing connection on error', () => {
  const state = tempDir()
  const first = repo()
  const second = repo()
  init(state, first)
  const path = join(state, 'state.sqlite')
  const before = snapshot(path)
  const close = vi.spyOn(DatabaseSync.prototype, 'close')
  expect(() => init(state, second)).toThrow('repository mismatch')
  expect(close).toHaveBeenCalledTimes(1)
  expect(snapshot(path)).toEqual(before)
})

it.skipIf(process.platform !== 'win32')('accepts a different case for the same Windows repository path', () => {
  const state = tempDir()
  const repository = repo()
  init(state, repository)
  const before = snapshot(join(state, 'state.sqlite'))
  init(state, repository.toUpperCase())
  expect(snapshot(join(state, 'state.sqlite'))).toEqual(before)
})

it.each([0, 2])('rejects an existing database with %i configuration rows', (count) => {
  const state = tempDir()
  const repository = repo()
  const db = new DatabaseSync(join(state, 'state.sqlite'))
  try {
    db.exec('CREATE TABLE project_config (repo_path TEXT NOT NULL)')
    for (let i = 0; i < count; i++) db.prepare('INSERT INTO project_config VALUES (?)').run(repository)
  } finally { db.close() }
  const close = vi.spyOn(DatabaseSync.prototype, 'close')
  expect(() => init(state, repository)).toThrow('invalid project configuration')
  expect(close).toHaveBeenCalledTimes(1)
})

it('rejects a repository path that is a file', () => {
  const state = tempDir()
  const file = join(tempDir(), 'file')
  writeFileSync(file, 'not a directory')
  expect(() => init(state, file)).toThrow('invalid repository')
})

it('rolls back a failed migration and leaves the original database unchanged', () => {
  const path = join(tempDir(), 'state.sqlite')
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE projects (id TEXT); PRAGMA user_version = 1')
  db.close()
  const exec = vi.spyOn(DatabaseSync.prototype, 'exec')
  expect(() => openStore(path)).toThrow()
  expect(exec).toHaveBeenCalledWith('ROLLBACK')
  const check = new DatabaseSync(path)
  try {
    expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 })
    expect(check.prepare("SELECT name FROM sqlite_master WHERE name = 'projects_name_idx'").get()).toBeUndefined()
  } finally { check.close() }
})
