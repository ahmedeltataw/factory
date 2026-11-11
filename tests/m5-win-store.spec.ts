import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { openStore } from '../supervisor/src/app/store.ts'

function sqliteError(code: number): Error & { errcode: number } {
  return Object.assign(new Error(`SQLite error ${code}`), { errcode: code })
}

describe('M5-WIN store opening', () => {
  it('retries two I/O errors, closes their handles, waits, and migrates once', () => {
    const directory = mkdtempSync(join(tmpdir(), 'factory-m5-win-'))
    const path = join(directory, 'state.sqlite')
    const exec = DatabaseSync.prototype.exec
    const close = DatabaseSync.prototype.close
    const failed = new Set<DatabaseSync>()
    const closed = new Set<DatabaseSync>()
    let attempts = 0
    let migrations = 0
    try {
      vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
        if (sql === 'PRAGMA foreign_keys = ON' && ++attempts <= 2) {
          failed.add(this)
          throw sqliteError(1546)
        }
        if (sql === 'BEGIN IMMEDIATE') migrations++
        return exec.call(this, sql)
      })
      vi.spyOn(DatabaseSync.prototype, 'close').mockImplementation(function (this: DatabaseSync) {
        closed.add(this)
        return close.call(this)
      })
      const start = performance.now()
      const db = openStore(path)
      try {
        expect(performance.now() - start).toBeGreaterThanOrEqual(400)
        expect(attempts).toBe(3)
        expect(migrations).toBe(1)
        expect(failed.size).toBe(2)
        expect([...failed].every(handle => closed.has(handle))).toBe(true)
        expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 6 })
      } finally { db.close() }
    } finally {
      vi.restoreAllMocks()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('throws the fifth I/O error unchanged and closes every failed handle', () => {
    const directory = mkdtempSync(join(tmpdir(), 'factory-m5-win-'))
    const exec = DatabaseSync.prototype.exec
    const close = DatabaseSync.prototype.close
    const handles = new Set<DatabaseSync>()
    const closed = new Set<DatabaseSync>()
    const errors = Array.from({ length: 5 }, () => sqliteError(1546))
    let attempts = 0
    try {
      vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
        if (sql === 'PRAGMA foreign_keys = ON') {
          handles.add(this)
          throw errors[attempts++]
        }
        return exec.call(this, sql)
      })
      vi.spyOn(DatabaseSync.prototype, 'close').mockImplementation(function (this: DatabaseSync) {
        closed.add(this)
        return close.call(this)
      })
      try { openStore(join(directory, 'state.sqlite')); expect.fail('expected an error') } catch (error) { expect(error).toBe(errors[4]) }
      expect(attempts).toBe(5)
      expect(handles.size).toBe(5)
      expect([...handles].every(handle => closed.has(handle))).toBe(true)
    } finally {
      vi.restoreAllMocks()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('throws a busy error immediately without retrying', () => {
    const directory = mkdtempSync(join(tmpdir(), 'factory-m5-win-'))
    const failure = sqliteError(5)
    let attempts = 0
    try {
      vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function () {
        attempts++
        throw failure
      })
      try { openStore(join(directory, 'state.sqlite')); expect.fail('expected an error') } catch (error) { expect(error).toBe(failure) }
      expect(attempts).toBe(1)
    } finally {
      vi.restoreAllMocks()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects an unsupported schema immediately without retrying', () => {
    const directory = mkdtempSync(join(tmpdir(), 'factory-m5-win-'))
    const path = join(directory, 'state.sqlite')
    const seed = new DatabaseSync(path)
    try { seed.exec('PRAGMA user_version = 999') } finally { seed.close() }
    const exec = DatabaseSync.prototype.exec
    let attempts = 0
    try {
      vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
        if (sql === 'PRAGMA foreign_keys = ON') attempts++
        return exec.call(this, sql)
      })
      expect(() => openStore(path)).toThrow('store: unsupported schema version 999')
      expect(attempts).toBe(1)
    } finally {
      vi.restoreAllMocks()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
