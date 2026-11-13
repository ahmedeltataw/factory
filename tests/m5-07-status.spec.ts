import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  formatStatus,
  readStatus,
  type Status,
  type PhaseStatus,
  type LeaseFreshness,
  type TaskWaitingReason,
} from '../supervisor/src/app/status.ts'
import {
  type TaskStatus,
  type AttemptStatus,
  type WorkerState,
} from '../supervisor/src/app/domain.ts'
import { openStore } from '../supervisor/src/app/store.ts'
import { PHASES } from '../supervisor/src/core/graph.ts'

const stamp = '2026-01-01T00:00:00.000Z'

const dirs: string[] = []
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-m5-07-unit-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function seedProject(db: DatabaseSync, projectId = 'p') {
  db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(projectId, 'Project', stamp)
  db.prepare('INSERT INTO project_config (project_id, repo_path, base_ref, created_at) VALUES (?, ?, ?, ?)').run(projectId, '/dummy', 'main', stamp)
  const phase = db.prepare('INSERT INTO phases (project_id, name, ord, status, opened_at, closed_at) VALUES (?, ?, ?, ?, ?, ?)')
  phase.run(projectId, 'intake', 1, 'open', stamp, null)
  phase.run(projectId, 'development', 2, 'locked', null, null)
  phase.run(projectId, 'qa', 3, 'locked', null, null)
  phase.run(projectId, 'devops', 4, 'locked', null, null)
  phase.run(projectId, 'handover', 5, 'locked', null, null)
}

function insertCommand(db: DatabaseSync, id = 'cmd-1', projectId = 'p') {
  db.prepare('INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)').run(id, projectId, 'task.create', '{}', stamp)
}

describe('M5-07 status unit and mutation tests', () => {
  describe('validation of arguments and database headers', () => {
    it('validates stateDir argument', () => {
      expect(() => readStatus('', { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: stateDir must be a non-empty string')
      expect(() => readStatus('   ', { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: stateDir must be a non-empty string')
      expect(() => readStatus(null as any, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: stateDir must be a non-empty string')
    })

    it('validates options object and nowMs argument', () => {
      const dir = makeDir()
      openStore(join(dir, 'state.sqlite')).close()
      expect(() => readStatus(dir, undefined as any)).toThrow('status: nowMs must be a nonnegative safe integer')
      expect(() => readStatus(dir, { nowMs: -1, staleAfterMs: 500 })).toThrow('status: nowMs must be a nonnegative safe integer')
      expect(() => readStatus(dir, { nowMs: 1.5, staleAfterMs: 500 })).toThrow('status: nowMs must be a nonnegative safe integer')
      expect(() => readStatus(dir, { nowMs: NaN, staleAfterMs: 500 })).toThrow('status: nowMs must be a nonnegative safe integer')
      expect(() => readStatus(dir, { nowMs: null as any, staleAfterMs: 500 })).toThrow('status: nowMs must be a nonnegative safe integer')
      // boundary: 0 is valid nonnegative safe integer
      const status0 = readStatus(dir, { nowMs: 0, staleAfterMs: 500 })
      expect(status0.schemaVersion).toBe(8)
    })

    it('validates staleAfterMs argument', () => {
      const dir = makeDir()
      openStore(join(dir, 'state.sqlite')).close()
      expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 0 })).toThrow('status: staleAfterMs must be a positive safe integer')
      expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: -10 })).toThrow('status: staleAfterMs must be a positive safe integer')
      expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 1.5 })).toThrow('status: staleAfterMs must be a positive safe integer')
      expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: null as any })).toThrow('status: staleAfterMs must be a positive safe integer')
      // boundary: 1 is valid positive safe integer
      const status1 = readStatus(dir, { nowMs: 1000, staleAfterMs: 1 })
      expect(status1.schemaVersion).toBe(8)
    })

    it('validates unsupported user_version and missing user_version', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        db.exec('PRAGMA user_version = 9')
      } finally {
        db.close()
      }
      expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: unsupported schema version 9')

      const originalPrepare = DatabaseSync.prototype.prepare
      DatabaseSync.prototype.prepare = function (sql: string, ...rest: any[]) {
        if (sql.includes('PRAGMA user_version')) {
          return { get: () => undefined } as any
        }
        return originalPrepare.call(this, sql, ...rest)
      }
      try {
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: unsupported schema version NaN')
      } finally {
        DatabaseSync.prototype.prepare = originalPrepare
      }
    })

    it('validates corrupted or missing command count', () => {
      const dir = makeDir()
      openStore(join(dir, 'state.sqlite')).close()
      const originalPrepare = DatabaseSync.prototype.prepare

      // count -1
      DatabaseSync.prototype.prepare = function (sql: string, ...rest: any[]) {
        if (sql.includes('COUNT(*) AS count FROM commands')) {
          return { get: () => ({ count: -1 }) } as any
        }
        return originalPrepare.call(this, sql, ...rest)
      }
      try {
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: command count is not a nonnegative safe integer')
      } finally {
        DatabaseSync.prototype.prepare = originalPrepare
      }

      // count 1.5
      DatabaseSync.prototype.prepare = function (sql: string, ...rest: any[]) {
        if (sql.includes('COUNT(*) AS count FROM commands')) {
          return { get: () => ({ count: 1.5 }) } as any
        }
        return originalPrepare.call(this, sql, ...rest)
      }
      try {
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: command count is not a nonnegative safe integer')
      } finally {
        DatabaseSync.prototype.prepare = originalPrepare
      }

      // count undefined
      DatabaseSync.prototype.prepare = function (sql: string, ...rest: any[]) {
        if (sql.includes('COUNT(*) AS count FROM commands')) {
          return { get: () => undefined } as any
        }
        return originalPrepare.call(this, sql, ...rest)
      }
      try {
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: command count is not a nonnegative safe integer')
      } finally {
        DatabaseSync.prototype.prepare = originalPrepare
      }
    })

    it('verifies transaction rollback on error and handles rollback failure gracefully', () => {
      const dir = makeDir()
      openStore(join(dir, 'state.sqlite')).close()
      const originalExec = DatabaseSync.prototype.exec
      const execCalls: string[] = []
      DatabaseSync.prototype.exec = function (sql: string) {
        execCalls.push(sql)
        return originalExec.call(this, sql)
      }
      try {
        expect(() => readStatus(dir, { nowMs: -1, staleAfterMs: 500 })).toThrow()
        expect(execCalls).not.toContain('BEGIN')

        // Inside transaction error
        const originalPrepare = DatabaseSync.prototype.prepare
        DatabaseSync.prototype.prepare = function (sql: string, ...rest: any[]) {
          if (sql.includes('PRAGMA user_version')) {
            throw new Error('boom-inside-tx')
          }
          return originalPrepare.call(this, sql, ...rest)
        }
        try {
          expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('boom-inside-tx')
          expect(execCalls).toContain('BEGIN')
          expect(execCalls).toContain('ROLLBACK')
        } finally {
          DatabaseSync.prototype.prepare = originalPrepare
        }

        // When rollback itself throws inside catch, original error still thrown
        DatabaseSync.prototype.exec = function (sql: string) {
          if (sql === 'ROLLBACK') throw new Error('rollback-failed')
          return originalExec.call(this, sql)
        }
        DatabaseSync.prototype.prepare = function (sql: string, ...rest: any[]) {
          if (sql.includes('PRAGMA user_version')) {
            throw new Error('boom-first')
          }
          return originalPrepare.call(this, sql, ...rest)
        }
        try {
          expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('boom-first')
        } finally {
          DatabaseSync.prototype.prepare = originalPrepare
        }
      } finally {
        DatabaseSync.prototype.exec = originalExec
      }
    })
  })

  describe('lease validation and freshness', () => {
    it('handles empty supervisor_lease and multiple rows', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        db.exec('DELETE FROM supervisor_lease')
      } finally {
        db.close()
      }
      const emptyStatus = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
      expect(emptyStatus.lease).toBeNull()

      const db2 = openStore(join(dir, 'state.sqlite'))
      try {
        db2.exec("PRAGMA ignore_check_constraints = ON")
        db2.exec("INSERT INTO supervisor_lease VALUES (1, 'o1', 1, 500, 'active'), (2, 'o2', 2, 600, 'active')")
      } finally {
        db2.close()
      }
      expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: corrupt supervisor_lease table')
    })

    it('rejects malformed supervisor_lease row fields and non-object rows', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        db.exec("PRAGMA ignore_check_constraints = ON")

        // bad id (!== 1)
        db.exec("INSERT INTO supervisor_lease VALUES (2, 'o1', 1, 500, 'active')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: malformed supervisor_lease row')
        db.exec("DELETE FROM supervisor_lease")

        // bad owner_id (empty)
        db.exec("INSERT INTO supervisor_lease VALUES (1, '', 1, 500, 'active')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: malformed supervisor_lease row')
        db.exec("DELETE FROM supervisor_lease")

        // bad owner_id (whitespace)
        db.exec("INSERT INTO supervisor_lease VALUES (1, '   ', 1, 500, 'active')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: malformed supervisor_lease row')
        db.exec("DELETE FROM supervisor_lease")

        // bad owner_id (BLOB non-string)
        db.exec("INSERT INTO supervisor_lease VALUES (1, X'DEADBEEF', 1, 500, 'active')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: malformed supervisor_lease row')
        db.exec("DELETE FROM supervisor_lease")

        // bad generation (0)
        db.exec("INSERT INTO supervisor_lease VALUES (1, 'o1', 0, 500, 'active')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: malformed supervisor_lease row')
        db.exec("DELETE FROM supervisor_lease")

        // bad generation (1.5 float)
        db.exec("INSERT INTO supervisor_lease VALUES (1, 'o1', 1.5, 500, 'active')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: malformed supervisor_lease row')
        db.exec("DELETE FROM supervisor_lease")

        // bad heartbeat_ms (-1)
        db.exec("INSERT INTO supervisor_lease VALUES (1, 'o1', 1, -1, 'active')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: malformed supervisor_lease row')
        db.exec("DELETE FROM supervisor_lease")

        // bad heartbeat_ms (1.5 float)
        db.exec("INSERT INTO supervisor_lease VALUES (1, 'o1', 1, 1.5, 'active')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: malformed supervisor_lease row')
        db.exec("DELETE FROM supervisor_lease")

        // bad status
        db.exec("INSERT INTO supervisor_lease VALUES (1, 'o1', 1, 500, 'invalid')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: malformed supervisor_lease row')
        db.exec("DELETE FROM supervisor_lease")

        // boundary: heartbeat_ms === 0 is valid
        db.exec("INSERT INTO supervisor_lease VALUES (1, 'o1', 1, 0, 'active')")
        const validStatus = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
        expect(validStatus.lease?.heartbeatMs).toBe(0)
      } finally {
        db.close()
      }

      // Test isLeaseRow with non-object, array, null via mock
      const originalPrepare = DatabaseSync.prototype.prepare
      for (const badRow of [null, [], 'primitive-string', undefined]) {
        DatabaseSync.prototype.prepare = function (sql: string, ...rest: any[]) {
          if (sql.includes('FROM supervisor_lease LIMIT 2')) {
            return { all: () => [badRow] } as any
          }
          return originalPrepare.call(this, sql, ...rest)
        }
        try {
          expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: malformed supervisor_lease row')
        } finally {
          DatabaseSync.prototype.prepare = originalPrepare
        }
      }
    })

    it('classifies all lease freshness states and boundaries', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        // released -> not-applicable
        db.exec("INSERT INTO supervisor_lease VALUES (1, 'o1', 1, 500, 'released')")
        let status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
        expect(status.lease?.freshness).toBe('not-applicable')
        expect(formatStatus(status)).toContain('غير منطبق')
        db.exec("DELETE FROM supervisor_lease")

        // future: heartbeatMs > nowMs (1001 > 1000)
        db.exec("INSERT INTO supervisor_lease VALUES (1, 'o1', 1, 1001, 'active')")
        status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
        expect(status.lease?.freshness).toBe('future')
        expect(formatStatus(status)).toContain('في المستقبل')
        db.exec("DELETE FROM supervisor_lease")

        // exact boundary: heartbeatMs === nowMs (1000 === 1000) -> fresh, NOT future!
        db.exec("INSERT INTO supervisor_lease VALUES (1, 'o1', 1, 1000, 'active')")
        status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
        expect(status.lease?.freshness).toBe('fresh')
        expect(formatStatus(status)).toContain('حديث')
        db.exec("DELETE FROM supervisor_lease")

        // exact boundary: nowMs - heartbeatMs === staleAfterMs (1000 - 500 = 500 >= 500) -> stale!
        db.exec("INSERT INTO supervisor_lease VALUES (1, 'o1', 1, 500, 'active')")
        status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
        expect(status.lease?.freshness).toBe('stale')
        expect(formatStatus(status)).toContain('قديم')
        db.exec("DELETE FROM supervisor_lease")

        // fresh boundary: nowMs - heartbeatMs < staleAfterMs (1000 - 501 = 499 < 500) -> fresh!
        db.exec("INSERT INTO supervisor_lease VALUES (1, 'o1', 1, 501, 'active')")
        status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
        expect(status.lease?.freshness).toBe('fresh')
        expect(formatStatus(status)).toContain('حديث')
      } finally {
        db.close()
      }
    })
  })

  describe('legacy schema and partial tables (hasV5Tables)', () => {
    it('handles legacy database without command_outcomes, tasks, or outbox', () => {
      const dir = makeDir()
      const db = new DatabaseSync(join(dir, 'state.sqlite'))
      try {
        db.exec('PRAGMA user_version = 8')
        db.exec('CREATE TABLE commands (id TEXT, project_id TEXT, kind TEXT, payload_json TEXT, created_at TEXT)')
        db.exec('CREATE TABLE supervisor_lease (id INTEGER PRIMARY KEY, owner_id TEXT, generation INTEGER, heartbeat_ms INTEGER, status TEXT)')
        db.exec("INSERT INTO supervisor_lease VALUES (1, 'legacy-owner', 3, 800, 'active')")
      } finally {
        db.close()
      }

      const status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
      expect(status.schemaVersion).toBe(8)
      expect(status.recordedCommandCount).toBe(0)
      expect(status.lease).not.toBeNull()
      expect(status.lease?.takeover).toBeUndefined()
      expect(status.commands).toBeUndefined()
      expect(status.tasks).toBeUndefined()
      expect(status.outbox).toBeUndefined()
      expect(status.phases).toEqual([])

      const text = formatStatus(status)
      expect(text).toContain('إصدار المخطط: 8')
      expect(text).toContain('دليل الاستحواذ=legacy-owner:3:800')
      expect(text).not.toContain('الأوامر:')
      expect(text).not.toContain('صندوق الصادر:')
      expect(text).not.toContain('المرحلة:')
      expect(text).not.toContain('المهمة:')
    })

    it('enables hasV5Tables when only command_outcomes exists', () => {
      const dir = makeDir()
      const db = new DatabaseSync(join(dir, 'state.sqlite'))
      try {
        db.exec('PRAGMA user_version = 8')
        db.exec('CREATE TABLE commands (id TEXT, project_id TEXT, kind TEXT, payload_json TEXT, created_at TEXT)')
        db.exec('CREATE TABLE supervisor_lease (id INTEGER PRIMARY KEY, owner_id TEXT, generation INTEGER, heartbeat_ms INTEGER, status TEXT)')
        db.exec('CREATE TABLE command_outcomes (command_id TEXT, outcome TEXT, failure_class TEXT, duration_ms INTEGER, recorded_at TEXT)')
        db.exec("INSERT INTO supervisor_lease VALUES (1, 'co-owner', 1, 800, 'active')")
      } finally {
        db.close()
      }
      const status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
      expect(status.lease?.takeover).toBe('co-owner:1:800')
      expect(status.commands).toBeDefined()
    })

    it('enables hasV5Tables when only tasks exists', () => {
      const dir = makeDir()
      const db = new DatabaseSync(join(dir, 'state.sqlite'))
      try {
        db.exec('PRAGMA user_version = 8')
        db.exec('CREATE TABLE commands (id TEXT, project_id TEXT, kind TEXT, payload_json TEXT, created_at TEXT)')
        db.exec('CREATE TABLE supervisor_lease (id INTEGER PRIMARY KEY, owner_id TEXT, generation INTEGER, heartbeat_ms INTEGER, status TEXT)')
        db.exec('CREATE TABLE tasks (rowid INTEGER PRIMARY KEY, id TEXT, title TEXT, status TEXT, scope_json TEXT, max_attempts INTEGER, timeout_ms INTEGER, attempt_base INTEGER, not_before_ms INTEGER, created_at TEXT, updated_at TEXT)')
        db.exec("INSERT INTO supervisor_lease VALUES (1, 'tasks-owner', 1, 800, 'active')")
      } finally {
        db.close()
      }
      const status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
      expect(status.lease?.takeover).toBe('tasks-owner:1:800')
      expect(status.tasks).toBeDefined()
    })

    it('enables hasV5Tables when only outbox exists', () => {
      const dir = makeDir()
      const db = new DatabaseSync(join(dir, 'state.sqlite'))
      try {
        db.exec('PRAGMA user_version = 8')
        db.exec('CREATE TABLE commands (id TEXT, project_id TEXT, kind TEXT, payload_json TEXT, created_at TEXT)')
        db.exec('CREATE TABLE supervisor_lease (id INTEGER PRIMARY KEY, owner_id TEXT, generation INTEGER, heartbeat_ms INTEGER, status TEXT)')
        db.exec('CREATE TABLE outbox (id TEXT, idempotency_key TEXT, kind TEXT, payload_json TEXT, status TEXT, tries INTEGER, next_attempt_ms INTEGER, last_error TEXT)')
        db.exec("INSERT INTO supervisor_lease VALUES (1, 'outbox-owner', 1, 800, 'active')")
      } finally {
        db.close()
      }
      const status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
      expect(status.lease?.takeover).toBe('outbox-owner:1:800')
      expect(status.outbox).toBeDefined()
    })
  })

  describe('command outcomes and outbox validation and counts', () => {
    it('detects outcomes count exceeding recorded commands', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        seedProject(db)
        db.exec("PRAGMA foreign_keys = OFF")
        db.exec("INSERT INTO command_outcomes VALUES ('c1', 'applied', NULL, 1, '2026-01-01')")
      } finally {
        db.close()
      }
      expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: command outcome count exceeds recorded commands')
    })

    it('rejects invalid command outcome string', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        seedProject(db)
        insertCommand(db, 'c1')
        db.exec("PRAGMA foreign_keys = OFF")
        db.exec("PRAGMA ignore_check_constraints = ON")
        db.exec("INSERT INTO command_outcomes VALUES ('c1', 'corrupted_outcome', NULL, 1, '2026-01-01')")
      } finally {
        db.close()
      }
      expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid command outcome corrupted_outcome')
    })

    it('rejects malformed command outcome count', () => {
      const dir = makeDir()
      openStore(join(dir, 'state.sqlite')).close()
      const originalPrepare = DatabaseSync.prototype.prepare
      for (const badCount of [-1, 1.5, NaN, 'bad']) {
        DatabaseSync.prototype.prepare = function (sql: string, ...rest: any[]) {
          if (sql.includes('FROM command_outcomes GROUP BY outcome')) {
            return { all: () => [{ outcome: 'applied', count: badCount }] } as any
          }
          return originalPrepare.call(this, sql, ...rest)
        }
        try {
          expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: malformed command outcome count')
        } finally {
          DatabaseSync.prototype.prepare = originalPrepare
        }
      }
    })

    it('computes applied and rejected outcome counts accurately', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        seedProject(db)
        for (let i = 1; i <= 6; i++) insertCommand(db, `c${i}`)
        db.exec(`
          INSERT INTO command_outcomes VALUES
            ('c1', 'applied', NULL, 10, 'now'),
            ('c2', 'applied', NULL, 15, 'now'),
            ('c3', 'applied', NULL, 20, 'now'),
            ('c4', 'rejected', 'conflict', 5, 'now'),
            ('c5', 'rejected', 'conflict', 8, 'now')
        `)
      } finally {
        db.close()
      }
      const status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
      expect(status.commands).toEqual({
        recorded: 6,
        applied: 3,
        rejected: 2,
        pending: 1,
      })
    })

    it('computes pending count when only applied outcomes exist', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        seedProject(db)
        for (let i = 1; i <= 3; i++) insertCommand(db, `c${i}`)
        db.exec("INSERT INTO command_outcomes VALUES ('c1', 'applied', NULL, 10, 'now')")
      } finally {
        db.close()
      }
      const status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
      expect(status.commands).toEqual({
        recorded: 3,
        applied: 1,
        rejected: 0,
        pending: 2,
      })
    })

    it('validates outbox status, non-string payload, and malformed payload', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        seedProject(db)
        db.exec("PRAGMA ignore_check_constraints = ON")

        // invalid outbox status
        db.exec("INSERT INTO outbox VALUES ('o0', 'k0', 'kind', '{}', 'invalid_state', 0, 0, NULL, 'now', 'now')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid outbox status invalid_state')
        db.exec("DELETE FROM outbox")

        // non-string payload_json
        db.exec("INSERT INTO outbox VALUES ('o1', 'k1', 'kind', X'DEADBEEF', 'pending', 0, 0, NULL, 'now', 'now')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid outbox payload_json')
        db.exec("DELETE FROM outbox")

        // malformed payload_json
        db.exec("INSERT INTO outbox VALUES ('o2', 'k2', 'kind', '{malformed', 'pending', 0, 0, NULL, 'now', 'now')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: malformed outbox payload_json')
      } finally {
        db.close()
      }
    })

    it('accurately counts pending, done, and failed outbox rows with lastError handling', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        seedProject(db)
        db.exec(`
          INSERT INTO outbox VALUES
            ('o1', 'key-pend', 'kind-a', '{}', 'pending', 0, 0, NULL, 'now', 'now'),
            ('o2', 'key-done', 'kind-b', '{}', 'done', 1, 0, NULL, 'now', 'now'),
            ('o3', 'key-fail-1', 'kind-c', '{}', 'failed', 3, 0, 'network timeout', 'now', 'now'),
            ('o4', 'key-fail-2', 'kind-d', '{}', 'failed', 2, 0, NULL, 'now', 'now')
        `)
      } finally {
        db.close()
      }
      const status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
      expect(status.outbox).toEqual({
        pending: 1,
        done: 1,
        failed: 2,
        failedRows: [
          { key: 'key-fail-1', kind: 'kind-c', tries: 3, lastError: 'network timeout' },
          { key: 'key-fail-2', kind: 'kind-d', tries: 2, lastError: null },
        ],
      })
    })
  })

  describe('workers table validation and suspect detection', () => {
    it('validates worker attempt_id, state, pid, and heartbeat_ms', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        seedProject(db)
        db.exec("PRAGMA foreign_keys = OFF")
        db.exec("PRAGMA ignore_check_constraints = ON")

        // bad attempt_id (empty)
        db.exec("INSERT INTO workers VALUES ('', 'n1', 100, 'running', '/tmp', 500, 'now', NULL)")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid worker attempt_id')
        db.exec("DELETE FROM workers")

        // bad attempt_id (whitespace)
        db.exec("INSERT INTO workers VALUES ('   ', 'n1', 100, 'running', '/tmp', 500, 'now', NULL)")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid worker attempt_id')
        db.exec("DELETE FROM workers")

        // bad attempt_id (BLOB non-string)
        db.exec("INSERT INTO workers VALUES (X'DEADBEEF', 'n1', 100, 'running', '/tmp', 500, 'now', NULL)")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid worker attempt_id')
        db.exec("DELETE FROM workers")

        // bad worker state
        db.exec("INSERT INTO workers VALUES ('att-1', 'n1', 100, 'bad_worker_state', '/tmp', 500, 'now', NULL)")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid worker state bad_worker_state')
        db.exec("DELETE FROM workers")

        // bad pid (0)
        db.exec("INSERT INTO workers VALUES ('att-1', 'n1', 0, 'running', '/tmp', 500, 'now', NULL)")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid worker pid')
        db.exec("DELETE FROM workers")

        // bad pid (-10)
        db.exec("INSERT INTO workers VALUES ('att-1', 'n1', -10, 'running', '/tmp', 500, 'now', NULL)")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid worker pid')
        db.exec("DELETE FROM workers")

        // bad pid (1.5 float)
        db.exec("INSERT INTO workers VALUES ('att-1', 'n1', 1.5, 'running', '/tmp', 500, 'now', NULL)")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid worker pid')
        db.exec("DELETE FROM workers")

        // bad heartbeat_ms (-1)
        db.exec("INSERT INTO workers VALUES ('att-1', 'n1', 100, 'running', '/tmp', -1, 'now', NULL)")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid worker heartbeat_ms')
        db.exec("DELETE FROM workers")

        // bad heartbeat_ms (1.5 float)
        db.exec("INSERT INTO workers VALUES ('att-1', 'n1', 100, 'running', '/tmp', 1.5, 'now', NULL)")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid worker heartbeat_ms')
        db.exec("DELETE FROM workers")

        // valid worker with null pid and null heartbeat_ms
        db.exec("INSERT INTO workers VALUES ('att-null', 'n1', NULL, 'starting', '/tmp', NULL, 'now', NULL)")
        // valid worker with pid 100 and heartbeat_ms 0
        db.exec("INSERT INTO workers VALUES ('att-zero', 'n2', 100, 'running', '/tmp', 0, 'now', NULL)")

        // Attach attempts so workers are attached
        insertCommand(db, 'c1')
        db.exec("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, phase) VALUES ('t1', 'p', 'c1', 'T1', 'ready', 'now', 'now', '[\".\"]', 'intake')")
        db.exec("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation) VALUES ('att-null', 't1', 1, 'succeeded', 0, NULL, 1)")
        db.exec("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation) VALUES ('att-zero', 't1', 2, 'running', NULL, NULL, 1)")

        const status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
        const t1 = status.tasks!.find(t => t.id === 't1')!
        expect(t1.attempts[0]!.worker).toEqual({ pid: null, state: 'starting', heartbeatMs: null })
        expect(t1.attempts[1]!.worker).toEqual({ pid: 100, state: 'running', heartbeatMs: 0 })
      } finally {
        db.close()
      }
    })

    it('determines suspect state across states and exact heartbeat boundaries', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        seedProject(db)
        db.exec("PRAGMA foreign_keys = OFF")
        db.exec("DROP INDEX IF EXISTS attempts_one_live_per_task")
        insertCommand(db, 'c1')
        db.exec("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, phase) VALUES ('t1', 'p', 'c1', 'T1', 'ready', 'now', 'now', '[\".\"]', 'intake')")

        // 1: starting, heartbeat 500 (1000 - 500 = 500 >= 500) -> suspect
        db.exec("INSERT INTO workers VALUES ('a1', 'n1', 101, 'starting', '/tmp', 500, 'now', NULL)")
        db.exec("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation) VALUES ('a1', 't1', 1, 'running', NULL, NULL, 1)")

        // 2: running, exact boundary heartbeat 500 (1000 - 500 = 500 >= 500) -> suspect
        db.exec("INSERT INTO workers VALUES ('a2', 'n2', 102, 'running', '/tmp', 500, 'now', NULL)")
        db.exec("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation) VALUES ('a2', 't1', 2, 'running', NULL, NULL, 1)")

        // 3: running, heartbeat 501 (1000 - 501 = 499 < 500) -> fresh, not suspect
        db.exec("INSERT INTO workers VALUES ('a3', 'n3', 103, 'running', '/tmp', 501, 'now', NULL)")
        db.exec("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation) VALUES ('a3', 't1', 3, 'running', NULL, NULL, 1)")

        // 4: running, heartbeat null -> not suspect
        db.exec("INSERT INTO workers VALUES ('a4', 'n4', 104, 'running', '/tmp', NULL, 'now', NULL)")
        db.exec("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation) VALUES ('a4', 't1', 4, 'running', NULL, NULL, 1)")

        // 5: exited, heartbeat 400 (stale) -> not suspect because state is exited
        db.exec("INSERT INTO workers VALUES ('a5', 'n5', 105, 'exited', '/tmp', 400, 'now', NULL)")
        db.exec("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation) VALUES ('a5', 't1', 5, 'failed', 0, NULL, 1)")

        // 6: killed, heartbeat 400 -> not suspect
        db.exec("INSERT INTO workers VALUES ('a6', 'n6', 106, 'killed', '/tmp', 400, 'now', NULL)")
        db.exec("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation) VALUES ('a6', 't1', 6, 'killed', NULL, NULL, 1)")

        // 7: lost, heartbeat 400 -> not suspect
        db.exec("INSERT INTO workers VALUES ('a7', 'n7', 107, 'lost', '/tmp', 400, 'now', NULL)")
        db.exec("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation) VALUES ('a7', 't1', 7, 'interrupted', NULL, NULL, 1)")
      } finally {
        db.close()
      }

      const status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
      const attempts = status.tasks![0]!.attempts
      expect((attempts[0]!.worker as any).isSuspect).toBe(true)
      expect((attempts[1]!.worker as any).isSuspect).toBe(true)
      expect((attempts[2]!.worker as any).isSuspect).toBe(false)
      expect((attempts[3]!.worker as any).isSuspect).toBe(false)
      expect((attempts[4]!.worker as any).isSuspect).toBe(false)
      expect((attempts[5]!.worker as any).isSuspect).toBe(false)
      expect((attempts[6]!.worker as any).isSuspect).toBe(false)

      // Test isSuspect descriptor property (writable, configurable, non-enumerable)
      const worker = attempts[0]!.worker as any
      expect(Object.keys(worker)).not.toContain('isSuspect')
      worker.isSuspect = false
      expect(worker.isSuspect).toBe(false)
      Object.defineProperty(worker, 'isSuspect', { value: true })
      expect(worker.isSuspect).toBe(true)
    })
  })

  describe('evidence table validation', () => {
    it('validates evidence attempt_id, head_sha, files_json types and entries', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        seedProject(db)
        db.exec("PRAGMA foreign_keys = OFF")
        db.exec("PRAGMA ignore_check_constraints = ON")
        db.exec("DROP TRIGGER IF EXISTS evidence_no_delete")

        // bad attempt_id (empty)
        db.exec("INSERT INTO evidence VALUES ('', 'base', 'head', '[]', 'out', 'err', 'now')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid evidence attempt_id')
        db.exec("DELETE FROM evidence")

        // bad attempt_id (whitespace)
        db.exec("INSERT INTO evidence VALUES ('   ', 'base', 'head', '[]', 'out', 'err', 'now')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid evidence attempt_id')
        db.exec("DELETE FROM evidence")

        // bad attempt_id (BLOB non-string)
        db.exec("INSERT INTO evidence VALUES (X'DEADBEEF', 'base', 'head', '[]', 'out', 'err', 'now')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid evidence attempt_id')
        db.exec("DELETE FROM evidence")

        // bad head_sha (empty)
        db.exec("INSERT INTO evidence VALUES ('att-1', 'base', '', '[]', 'out', 'err', 'now')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid evidence head_sha')
        db.exec("DELETE FROM evidence")

        // bad head_sha (whitespace)
        db.exec("INSERT INTO evidence VALUES ('att-1', 'base', '   ', '[]', 'out', 'err', 'now')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid evidence head_sha')
        db.exec("DELETE FROM evidence")

        // bad head_sha (BLOB non-string)
        db.exec("INSERT INTO evidence VALUES ('att-1', 'base', X'DEADBEEF', '[]', 'out', 'err', 'now')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid evidence head_sha')
        db.exec("DELETE FROM evidence")

        // bad files_json (BLOB non-string)
        db.exec("INSERT INTO evidence VALUES ('att-1', 'base', 'head', X'DEADBEEF', 'out', 'err', 'now')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid evidence files_json')
        db.exec("DELETE FROM evidence")

        // malformed files_json
        db.exec("INSERT INTO evidence VALUES ('att-1', 'base', 'head', '{not-json', 'out', 'err', 'now')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: malformed evidence files_json')
        db.exec("DELETE FROM evidence")

        // files_json not an array
        db.exec("INSERT INTO evidence VALUES ('att-1', 'base', 'head', '{\"not\":\"array\"}', 'out', 'err', 'now')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: evidence files_json must be an array')
        db.exec("DELETE FROM evidence")

        // files_json entry is null
        db.exec("INSERT INTO evidence VALUES ('att-1', 'base', 'head', '[null]', 'out', 'err', 'now')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid evidence file entry')
        db.exec("DELETE FROM evidence")

        // files_json entry is primitive
        db.exec("INSERT INTO evidence VALUES ('att-1', 'base', 'head', '[\"string-entry\"]', 'out', 'err', 'now')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid evidence file entry')
        db.exec("DELETE FROM evidence")

        // files_json entry missing path or path non-string
        db.exec("INSERT INTO evidence VALUES ('att-1', 'base', 'head', '[{\"sha256\":\"deadbeef\"}]', 'out', 'err', 'now')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid evidence file entry schema')
        db.exec("DELETE FROM evidence")

        db.exec("INSERT INTO evidence VALUES ('att-1', 'base', 'head', '[{\"path\":123,\"sha256\":\"deadbeef\"}]', 'out', 'err', 'now')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid evidence file entry schema')
        db.exec("DELETE FROM evidence")

        // files_json entry missing sha256 or sha256 non-string
        db.exec("INSERT INTO evidence VALUES ('att-1', 'base', 'head', '[{\"path\":\"file.txt\"}]', 'out', 'err', 'now')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid evidence file entry schema')
        db.exec("DELETE FROM evidence")

        db.exec("INSERT INTO evidence VALUES ('att-1', 'base', 'head', '[{\"path\":\"file.txt\",\"sha256\":123}]', 'out', 'err', 'now')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid evidence file entry schema')
        db.exec("DELETE FROM evidence")

        // valid evidence
        db.exec("INSERT INTO evidence VALUES ('att-1', 'base', 'sha-xyz', '[{\"path\":\"f1.txt\",\"sha256\":\"sha1\"}]', 'out', 'err', 'now')")
        insertCommand(db, 'c1')
        db.exec("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, phase) VALUES ('t1', 'p', 'c1', 'T1', 'ready', 'now', 'now', '[\".\"]', 'intake')")
        db.exec("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation) VALUES ('att-1', 't1', 1, 'succeeded', 0, NULL, 1)")

        const status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
        const att = status.tasks![0]!.attempts[0]!
        expect(att.evidence).toEqual({
          headSha: 'sha-xyz',
          files: [{ path: 'f1.txt', sha256: 'sha1' }],
        })
      } finally {
        db.close()
      }
    })
  })

  describe('attempts table validation and ordering', () => {
    it('validates attempt id, task_id, attempt_no, status, exit_code, error_class, deadline_ms', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        seedProject(db)
        db.exec("PRAGMA foreign_keys = OFF")
        insertCommand(db, 'c1')
        db.exec("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, phase) VALUES ('t1', 'p', 'c1', 'T1', 'ready', 'now', 'now', '[\".\"]', 'intake')")
        db.exec("PRAGMA ignore_check_constraints = ON")

        // bad id (empty)
        db.exec("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation) VALUES ('', 't1', 1, 'succeeded', 0, NULL, 1)")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid attempt id')
        db.exec("DELETE FROM attempts")

        // bad id (whitespace)
        db.exec("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation) VALUES ('   ', 't1', 1, 'succeeded', 0, NULL, 1)")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid attempt id')
        db.exec("DELETE FROM attempts")

        // bad id (BLOB non-string)
        db.exec("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation) VALUES (X'DEADBEEF', 't1', 1, 'succeeded', 0, NULL, 1)")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid attempt id')
        db.exec("DELETE FROM attempts")

        // bad task_id (empty)
        db.exec("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation) VALUES ('a1', '', 1, 'succeeded', 0, NULL, 1)")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid attempt task_id')
        db.exec("DELETE FROM attempts")

        // bad task_id (whitespace)
        db.exec("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation) VALUES ('a1', '   ', 1, 'succeeded', 0, NULL, 1)")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid attempt task_id')
        db.exec("DELETE FROM attempts")

        // bad task_id (BLOB non-string)
        db.exec("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation) VALUES ('a1', X'DEADBEEF', 1, 'succeeded', 0, NULL, 1)")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid attempt task_id')
        db.exec("DELETE FROM attempts")

        // bad attempt_no (0)
        db.exec("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation) VALUES ('a1', 't1', 0, 'succeeded', 0, NULL, 1)")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid attempt_no')
        db.exec("DELETE FROM attempts")

        // bad attempt_no (-1)
        db.exec("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation) VALUES ('a1', 't1', -1, 'succeeded', 0, NULL, 1)")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid attempt_no')
        db.exec("DELETE FROM attempts")

        // bad attempt_no (1.5 float)
        db.exec("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation) VALUES ('a1', 't1', 1.5, 'succeeded', 0, NULL, 1)")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid attempt_no')
        db.exec("DELETE FROM attempts")

        // bad status
        db.exec("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation) VALUES ('a1', 't1', 1, 'invalid_attempt_status', 0, NULL, 1)")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid attempt status invalid_attempt_status')
        db.exec("DELETE FROM attempts")

        // bad exit_code (1.5 float)
        db.exec("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation) VALUES ('a1', 't1', 1, 'failed', 1.5, NULL, 1)")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid attempt exit_code')
        db.exec("DELETE FROM attempts")

        // bad error_class (BLOB non-string)
        db.exec("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation) VALUES ('a1', 't1', 1, 'failed', 1, X'DEADBEEF', 1)")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid attempt error_class')
        db.exec("DELETE FROM attempts")

        // bad deadline_ms (-1)
        db.exec("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, deadline_ms) VALUES ('a1', 't1', 1, 'running', NULL, NULL, 1, -1)")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid attempt deadline_ms')
        db.exec("DELETE FROM attempts")

        // bad deadline_ms (1.5 float)
        db.exec("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, deadline_ms) VALUES ('a1', 't1', 1, 'running', NULL, NULL, 1, 1.5)")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid attempt deadline_ms')
        db.exec("DELETE FROM attempts")

        // boundary checks: exit_code = 0, exit_code = -1, deadline_ms = 0
        db.exec("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, deadline_ms) VALUES ('a1', 't1', 1, 'succeeded', 0, 'transient', 1, 0)")
        db.exec("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, deadline_ms) VALUES ('a2', 't1', 2, 'failed', -1, NULL, 1, NULL)")

        const status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
        const atts = status.tasks![0]!.attempts
        expect(atts.length).toBe(2)
        expect(atts[0]).toEqual({
          no: 1,
          status: 'succeeded',
          exitCode: 0,
          worker: null,
          evidence: null,
          errorClass: 'transient',
          deadlineMs: 0,
        })
        expect(atts[1]).toEqual({
          no: 2,
          status: 'failed',
          exitCode: -1,
          worker: null,
          evidence: null,
          errorClass: null,
          deadlineMs: null,
        })
      } finally {
        db.close()
      }
    })
  })

  describe('phases and target project resolution', () => {
    it('resolves targetProjectId when project_config and projects are absent but phases exist', () => {
      const dir = makeDir()
      const db = new DatabaseSync(join(dir, 'state.sqlite'))
      try {
        db.exec('PRAGMA user_version = 8')
        db.exec('CREATE TABLE commands (id TEXT, project_id TEXT, kind TEXT, payload_json TEXT, created_at TEXT)')
        db.exec('CREATE TABLE supervisor_lease (id INTEGER PRIMARY KEY, owner_id TEXT, generation INTEGER, heartbeat_ms INTEGER, status TEXT)')
        db.exec('CREATE TABLE tasks (rowid INTEGER PRIMARY KEY, id TEXT, title TEXT, status TEXT, scope_json TEXT, max_attempts INTEGER, timeout_ms INTEGER, attempt_base INTEGER, not_before_ms INTEGER, created_at TEXT, updated_at TEXT)')
        db.exec('CREATE TABLE phases (project_id TEXT, name TEXT, ord INTEGER, status TEXT, opened_at TEXT, closed_at TEXT)')
        for (let i = 0; i < 5; i++) {
          db.exec(`INSERT INTO phases VALUES ('orphan-proj', '${PHASES[i]}', ${i + 1}, '${i === 0 ? 'open' : 'locked'}', NULL, NULL)`)
        }
      } finally {
        db.close()
      }
      const status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
      expect(status.phases.length).toBe(5)
      expect(status.phases[0]!.name).toBe('intake')
    })

    it('resolves targetProjectId from projects table when project_config is absent', () => {
      const dir = makeDir()
      const db = new DatabaseSync(join(dir, 'state.sqlite'))
      try {
        db.exec('PRAGMA user_version = 8')
        db.exec('CREATE TABLE commands (id TEXT, project_id TEXT, kind TEXT, payload_json TEXT, created_at TEXT)')
        db.exec('CREATE TABLE supervisor_lease (id INTEGER PRIMARY KEY, owner_id TEXT, generation INTEGER, heartbeat_ms INTEGER, status TEXT)')
        db.exec('CREATE TABLE tasks (rowid INTEGER PRIMARY KEY, id TEXT, title TEXT, status TEXT, scope_json TEXT, max_attempts INTEGER, timeout_ms INTEGER, attempt_base INTEGER, not_before_ms INTEGER, created_at TEXT, updated_at TEXT)')
        db.exec('CREATE TABLE projects (id TEXT, name TEXT, created_at TEXT)')
        db.exec("INSERT INTO projects VALUES ('proj-only', 'P', 'now')")
        db.exec('CREATE TABLE phases (project_id TEXT, name TEXT, ord INTEGER, status TEXT, opened_at TEXT, closed_at TEXT)')
        for (let i = 0; i < 5; i++) {
          db.exec(`INSERT INTO phases VALUES ('proj-only', '${PHASES[i]}', ${i + 1}, '${i === 0 ? 'open' : 'locked'}', NULL, NULL)`)
        }
      } finally {
        db.close()
      }
      const status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
      expect(status.phases.length).toBe(5)
    })

    it('rejects partial phase rows for a project', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        seedProject(db)
        db.exec("DROP TRIGGER phases_no_delete")
        db.exec("DELETE FROM phases WHERE project_id = 'p' AND name IN ('handover', 'devops')")
      } finally {
        db.close()
      }
      expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: project has missing phase row')
    })

    it('rejects missing phase rows when targetProjectId has 1-4 rows', () => {
      const dir = makeDir()
      openStore(join(dir, 'state.sqlite')).close()
      const originalPrepare = DatabaseSync.prototype.prepare
      DatabaseSync.prototype.prepare = function (sql: string, ...rest: any[]) {
        if (sql.includes('SELECT project_id, COUNT(*) AS count FROM phases GROUP BY project_id')) {
          return { all: () => [{ project_id: 'p', count: 5 }], get: () => ({ count: 5 }) } as any
        }
        if (sql.trim().startsWith('SELECT id FROM projects')) {
          return { all: () => [{ id: 'p' }], get: () => ({ id: 'p' }) } as any
        }
        if (sql.includes('SELECT COUNT(*) AS count FROM phases WHERE project_id = ?')) {
          return { get: () => ({ count: 5 }), all: () => [{ count: 5 }] } as any
        }
        if (sql.includes('SELECT name, ord, status, opened_at, closed_at FROM phases WHERE project_id = ?')) {
          // returns 3 rows instead of 5
          return {
            all: () => [
              { name: 'intake', ord: 1, status: 'open', opened_at: null, closed_at: null },
              { name: 'development', ord: 2, status: 'locked', opened_at: null, closed_at: null },
              { name: 'qa', ord: 3, status: 'locked', opened_at: null, closed_at: null },
            ],
            get: () => undefined,
          } as any
        }
        return originalPrepare.call(this, sql, ...rest)
      }
      try {
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: project has missing phase row')
      } finally {
        DatabaseSync.prototype.prepare = originalPrepare
      }
    })

    it('rejects duplicate or corrupt phase names or ords', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        seedProject(db)
        db.exec("DROP TRIGGER phases_no_delete")
        db.exec("DROP TABLE phases")
        db.exec("CREATE TABLE phases (project_id TEXT, name TEXT, ord INTEGER, status TEXT, opened_at TEXT, closed_at TEXT)")
        // Insert 5 rows with corrupt names
        db.exec(`
          INSERT INTO phases (project_id, name, ord, status, opened_at, closed_at) VALUES
            ('p', 'intake', 1, 'done', 'now', 'now'),
            ('p', 'development', 2, 'open', 'now', NULL),
            ('p', 'qa', 3, 'locked', NULL, NULL),
            ('p', 'devops', 4, 'locked', NULL, NULL),
            ('p', 'corrupt', 5, 'locked', NULL, NULL)
        `)
      } finally {
        db.close()
      }
      expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: malformed phase row')
    })

    it('rejects corrupt phase ord, status, opened_at or closed_at', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        seedProject(db)
        db.exec("DROP TRIGGER phases_no_delete")
        db.exec("DROP TABLE phases")
        db.exec("CREATE TABLE phases (project_id TEXT, name TEXT, ord INTEGER, status TEXT, opened_at TEXT, closed_at TEXT)")

        // bad ord
        db.exec(`
          INSERT INTO phases (project_id, name, ord, status, opened_at, closed_at) VALUES
            ('p', 'intake', 2, 'open', NULL, NULL),
            ('p', 'development', 2, 'locked', NULL, NULL),
            ('p', 'qa', 3, 'locked', NULL, NULL),
            ('p', 'devops', 4, 'locked', NULL, NULL),
            ('p', 'handover', 5, 'locked', NULL, NULL)
        `)
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: malformed phase row')
        db.exec("DELETE FROM phases")

        // bad status
        db.exec(`
          INSERT INTO phases (project_id, name, ord, status, opened_at, closed_at) VALUES
            ('p', 'intake', 1, 'invalid_phase_status', NULL, NULL),
            ('p', 'development', 2, 'locked', NULL, NULL),
            ('p', 'qa', 3, 'locked', NULL, NULL),
            ('p', 'devops', 4, 'locked', NULL, NULL),
            ('p', 'handover', 5, 'locked', NULL, NULL)
        `)
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: malformed phase row')
        db.exec("DELETE FROM phases")

        // bad opened_at (BLOB non-string)
        db.exec(`
          INSERT INTO phases (project_id, name, ord, status, opened_at, closed_at) VALUES
            ('p', 'intake', 1, 'open', X'DEADBEEF', NULL),
            ('p', 'development', 2, 'locked', NULL, NULL),
            ('p', 'qa', 3, 'locked', NULL, NULL),
            ('p', 'devops', 4, 'locked', NULL, NULL),
            ('p', 'handover', 5, 'locked', NULL, NULL)
        `)
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: malformed phase row')
        db.exec("DELETE FROM phases")

        // bad closed_at (BLOB non-string)
        db.exec(`
          INSERT INTO phases (project_id, name, ord, status, opened_at, closed_at) VALUES
            ('p', 'intake', 1, 'done', 'now', X'DEADBEEF'),
            ('p', 'development', 2, 'open', 'now', NULL),
            ('p', 'qa', 3, 'locked', NULL, NULL),
            ('p', 'devops', 4, 'locked', NULL, NULL),
            ('p', 'handover', 5, 'locked', NULL, NULL)
        `)
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: malformed phase row')
      } finally {
        db.close()
      }
    })

    it('rejects more than one open phase', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        seedProject(db)
        db.exec("DROP INDEX phases_one_open")
        db.exec("UPDATE phases SET status = 'open' WHERE name = 'qa'")
      } finally {
        db.close()
      }
      expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: more than one open phase')
    })
  })

  describe('task_deps validation and edge cases', () => {
    it('handles task_deps when tasks table is missing or corrupted', () => {
      const dir = makeDir()
      const db = new DatabaseSync(join(dir, 'state.sqlite'))
      try {
        db.exec('PRAGMA user_version = 8')
        db.exec('CREATE TABLE commands (id TEXT, project_id TEXT, kind TEXT, payload_json TEXT, created_at TEXT)')
        db.exec('CREATE TABLE supervisor_lease (id INTEGER PRIMARY KEY, owner_id TEXT, generation INTEGER, heartbeat_ms INTEGER, status TEXT)')
        db.exec('CREATE TABLE task_deps (task_id TEXT, depends_on TEXT)')

        // Case A: tasks table missing and task_deps is empty -> succeeds!
        const statusEmpty = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
        expect(statusEmpty.schemaVersion).toBe(8)

        // Case B: tasks table missing and task_deps has a row -> throws!
        db.exec("INSERT INTO task_deps VALUES ('t1', 't0')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: task_deps row points to a missing task')
      } finally {
        db.close()
      }
    })

    it('rejects non-string task_id or depends_on in task_deps', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        seedProject(db)
        insertCommand(db, 'c1')
        insertCommand(db, 'c2')
        db.exec("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, phase) VALUES ('t1', 'p', 'c1', 'T1', 'ready', 'now', 'now', '[\".\"]', 'intake')")
        db.exec("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, phase) VALUES ('t2', 'p', 'c2', 'T2', 'ready', 'now', 'now', '[\".\"]', 'intake')")

        const originalPrepare = DatabaseSync.prototype.prepare
        // bad task_id (number)
        DatabaseSync.prototype.prepare = function (sql: string, ...rest: any[]) {
          if (sql.includes('SELECT task_id, depends_on FROM task_deps')) {
            return { all: () => [{ task_id: 12345, depends_on: 't2' }] } as any
          }
          return originalPrepare.call(this, sql, ...rest)
        }
        try {
          expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid task_deps row')
        } finally {
          DatabaseSync.prototype.prepare = originalPrepare
        }

        // bad depends_on (number)
        DatabaseSync.prototype.prepare = function (sql: string, ...rest: any[]) {
          if (sql.includes('SELECT task_id, depends_on FROM task_deps')) {
            return { all: () => [{ task_id: 't1', depends_on: 12345 }] } as any
          }
          return originalPrepare.call(this, sql, ...rest)
        }
        try {
          expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid task_deps row')
        } finally {
          DatabaseSync.prototype.prepare = originalPrepare
        }
      } finally {
        db.close()
      }
    })

    it('rejects task_deps pointing to missing tasks', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        seedProject(db)
        insertCommand(db, 'c1')
        db.exec("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, phase) VALUES ('t1', 'p', 'c1', 'T1', 'ready', 'now', 'now', '[\".\"]', 'intake')")
        db.exec("PRAGMA foreign_keys = OFF")
        db.exec("INSERT INTO task_deps VALUES ('t1', 'missing')")
      } finally {
        db.close()
      }
      expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: task_deps row points to a missing task')
    })
  })

  describe('tasks table validation, scope, and planDispatch', () => {
    it('validates task id, title, status, scope_json, max_attempts, timeout_ms, attempt_base, not_before_ms', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        seedProject(db)
        insertCommand(db, 'c1')
        db.exec("PRAGMA ignore_check_constraints = ON")

        // bad id (empty)
        db.exec("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, phase) VALUES ('', 'p', 'c1', 'T', 'ready', 'now', 'now', '[\".\"]', 'intake')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid task id')
        db.exec("DELETE FROM tasks")

        // bad id (whitespace)
        db.exec("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, phase) VALUES ('   ', 'p', 'c1', 'T', 'ready', 'now', 'now', '[\".\"]', 'intake')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid task id')
        db.exec("DELETE FROM tasks")

        // bad id (BLOB non-string)
        db.exec("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, phase) VALUES (X'DEADBEEF', 'p', 'c1', 'T', 'ready', 'now', 'now', '[\".\"]', 'intake')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid task id')
        db.exec("DELETE FROM tasks")

        // bad title (BLOB non-string)
        db.exec("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, phase) VALUES ('t1', 'p', 'c1', X'DEADBEEF', 'ready', 'now', 'now', '[\".\"]', 'intake')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid task title')
        db.exec("DELETE FROM tasks")

        // bad status
        db.exec("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, phase) VALUES ('t1', 'p', 'c1', 'T', 'bad_task_status', 'now', 'now', '[\".\"]', 'intake')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid task status bad_task_status')
        db.exec("DELETE FROM tasks")

        // bad scope_json (BLOB non-string)
        db.exec("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, phase) VALUES ('t1', 'p', 'c1', 'T', 'ready', 'now', 'now', X'DEADBEEF', 'intake')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid scope_json')
        db.exec("DELETE FROM tasks")

        // malformed scope_json
        db.exec("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, phase) VALUES ('t1', 'p', 'c1', 'T', 'ready', 'now', 'now', '{bad-json', 'intake')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: malformed scope_json')
        db.exec("DELETE FROM tasks")

        // invalid scope in task
        db.exec("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, phase) VALUES ('t1', 'p', 'c1', 'T', 'ready', 'now', 'now', '[\"..\"]', 'intake')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow(/status: invalid scope in task t1:/)
        db.exec("DELETE FROM tasks")

        // bad max_attempts boundaries (0, 11, 1.5)
        db.exec("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, max_attempts, phase) VALUES ('t1', 'p', 'c1', 'T', 'ready', 'now', 'now', '[\".\"]', 0, 'intake')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid task max_attempts')
        db.exec("DELETE FROM tasks")

        db.exec("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, max_attempts, phase) VALUES ('t1', 'p', 'c1', 'T', 'ready', 'now', 'now', '[\".\"]', 11, 'intake')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid task max_attempts')
        db.exec("DELETE FROM tasks")

        db.exec("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, max_attempts, phase) VALUES ('t1', 'p', 'c1', 'T', 'ready', 'now', 'now', '[\".\"]', 1.5, 'intake')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid task max_attempts')
        db.exec("DELETE FROM tasks")

        // bad timeout_ms boundaries (999, 86400001, 1500.5)
        db.exec("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, timeout_ms, phase) VALUES ('t1', 'p', 'c1', 'T', 'ready', 'now', 'now', '[\".\"]', 999, 'intake')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid task timeout_ms')
        db.exec("DELETE FROM tasks")

        db.exec("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, timeout_ms, phase) VALUES ('t1', 'p', 'c1', 'T', 'ready', 'now', 'now', '[\".\"]', 86400001, 'intake')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid task timeout_ms')
        db.exec("DELETE FROM tasks")

        db.exec("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, timeout_ms, phase) VALUES ('t1', 'p', 'c1', 'T', 'ready', 'now', 'now', '[\".\"]', 1500.5, 'intake')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid task timeout_ms')
        db.exec("DELETE FROM tasks")

        // bad attempt_base (-1, 1.5)
        db.exec("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, attempt_base, phase) VALUES ('t1', 'p', 'c1', 'T', 'ready', 'now', 'now', '[\".\"]', -1, 'intake')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid task attempt_base')
        db.exec("DELETE FROM tasks")

        db.exec("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, attempt_base, phase) VALUES ('t1', 'p', 'c1', 'T', 'ready', 'now', 'now', '[\".\"]', 1.5, 'intake')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid task attempt_base')
        db.exec("DELETE FROM tasks")

        // bad not_before_ms (-1, 1.5)
        db.exec("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, not_before_ms, phase) VALUES ('t1', 'p', 'c1', 'T', 'ready', 'now', 'now', '[\".\"]', -1, 'intake')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid task not_before_ms')
        db.exec("DELETE FROM tasks")

        db.exec("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, not_before_ms, phase) VALUES ('t1', 'p', 'c1', 'T', 'ready', 'now', 'now', '[\".\"]', 1.5, 'intake')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid task not_before_ms')
        db.exec("DELETE FROM tasks")

        // valid boundary tests:
        insertCommand(db, 'c-min')
        insertCommand(db, 'c-max')
        insertCommand(db, 'c-null')
        // max_attempts = 1, timeout_ms = 1000, attempt_base = 0, not_before_ms = 0
        db.exec("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, max_attempts, timeout_ms, attempt_base, not_before_ms, phase) VALUES ('t-min', 'p', 'c-min', 'T Min', 'ready', 'now', 'now', '[\".\"]', 1, 1000, 0, 0, 'intake')")
        // max_attempts = 10, timeout_ms = 86400000, timeout_ms null
        db.exec("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, max_attempts, timeout_ms, attempt_base, not_before_ms, phase) VALUES ('t-max', 'p', 'c-max', 'T Max', 'ready', 'now', 'now', '[\".\"]', 10, 86400000, 5, 2000, 'intake')")
        db.exec("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, max_attempts, timeout_ms, attempt_base, not_before_ms, phase) VALUES ('t-null-timeout', 'p', 'c-null', 'T Null', 'ready', 'now', 'now', '[\".\"]', 3, NULL, 0, 0, 'intake')")

        const status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
        const tMin = status.tasks!.find(t => t.id === 't-min')!
        const tMax = status.tasks!.find(t => t.id === 't-max')!
        const tNull = status.tasks!.find(t => t.id === 't-null-timeout')!

        expect(tMin.maxAttempts).toBe(1)
        expect(tMin.timeoutMs).toBe(1000)
        expect(tMin.notBeforeMs).toBe(0)
        expect((tMin as any).attemptBase).toBe(0)

        expect(tMax.maxAttempts).toBe(10)
        expect(tMax.timeoutMs).toBe(86400000)
        expect((tMax as any).attemptBase).toBe(5)

        expect(tNull.timeoutMs).toBeNull()
        expect(tNull.phase).toBe('intake')

        // attemptBase descriptor test (non-enumerable, writable, configurable)
        expect(Object.keys(tMin)).not.toContain('attemptBase')
        ;(tMin as any).attemptBase = 10
        expect((tMin as any).attemptBase).toBe(10)
        Object.defineProperty(tMin, 'attemptBase', { value: 20 })
        expect((tMin as any).attemptBase).toBe(20)
      } finally {
        db.close()
      }
    })

    it('defaults task phase to intake when tasks table lacks phase column', () => {
      const dir = makeDir()
      const db = new DatabaseSync(join(dir, 'state.sqlite'))
      try {
        db.exec('PRAGMA user_version = 8')
        db.exec('CREATE TABLE commands (id TEXT, project_id TEXT, kind TEXT, payload_json TEXT, created_at TEXT)')
        db.exec('CREATE TABLE supervisor_lease (id INTEGER PRIMARY KEY, owner_id TEXT, generation INTEGER, heartbeat_ms INTEGER, status TEXT)')
        db.exec(`
          CREATE TABLE tasks (
            rowid INTEGER PRIMARY KEY,
            id TEXT,
            title TEXT,
            status TEXT,
            scope_json TEXT,
            max_attempts INTEGER DEFAULT 3,
            timeout_ms INTEGER DEFAULT 60000,
            attempt_base INTEGER DEFAULT 0,
            not_before_ms INTEGER DEFAULT 0,
            created_at TEXT,
            updated_at TEXT
          )
        `)
        db.exec("INSERT INTO tasks VALUES (1, 't-legacy', 'Legacy Task', 'ready', '[\".\"]', 3, 60000, 0, 0, 'now', 'now')")
      } finally {
        db.close()
      }
      const status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
      expect(status.tasks![0]!.phase).toBe('intake')
    })

    it('defaults task phase to intake when task phase column is null', () => {
      const dir = makeDir()
      const db = new DatabaseSync(join(dir, 'state.sqlite'))
      try {
        db.exec('PRAGMA user_version = 8')
        db.exec('CREATE TABLE commands (id TEXT, project_id TEXT, kind TEXT, payload_json TEXT, created_at TEXT)')
        db.exec('CREATE TABLE supervisor_lease (id INTEGER PRIMARY KEY, owner_id TEXT, generation INTEGER, heartbeat_ms INTEGER, status TEXT)')
        db.exec(`
          CREATE TABLE tasks (
            rowid INTEGER PRIMARY KEY,
            id TEXT,
            title TEXT,
            status TEXT,
            scope_json TEXT,
            max_attempts INTEGER DEFAULT 3,
            timeout_ms INTEGER DEFAULT 60000,
            attempt_base INTEGER DEFAULT 0,
            not_before_ms INTEGER DEFAULT 0,
            phase TEXT,
            created_at TEXT,
            updated_at TEXT
          )
        `)
        db.exec("INSERT INTO tasks VALUES (1, 't-null-phase', 'Null Phase Task', 'ready', '[\".\"]', 3, 60000, 0, 0, NULL, 'now', 'now')")
      } finally {
        db.close()
      }
      const status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
      expect(status.tasks![0]!.phase).toBe('intake')
    })

    it('rejects invalid task phase', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        seedProject(db)
        insertCommand(db, 'c1')
        db.exec("PRAGMA ignore_check_constraints = ON")
        db.exec("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, phase) VALUES ('t1', 'p', 'c1', 'T1', 'ready', 'now', 'now', '[\".\"]', 'invalid-phase')")
      } finally {
        db.close()
      }
      expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('status: invalid task phase invalid-phase')
    })

    it('counts all task statuses accurately per phase and leaves waiting task uncounted in dropped', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        seedProject(db)
        for (let i = 1; i <= 7; i++) insertCommand(db, `c${i}`)
        const insertTask = db.prepare('INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, phase) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        insertTask.run('t-ready', 'p', 'c1', 'Ready', 'ready', stamp, stamp, '["a"]', 'intake')
        insertTask.run('t-prog', 'p', 'c2', 'Progress', 'progress', stamp, stamp, '["b"]', 'intake')
        insertTask.run('t-block', 'p', 'c3', 'Blocked', 'blocked', stamp, stamp, '["c"]', 'intake')
        insertTask.run('t-fail', 'p', 'c4', 'Failed', 'failed', stamp, stamp, '["d"]', 'intake')
        insertTask.run('t-done', 'p', 'c5', 'Done', 'done', stamp, stamp, '["e"]', 'intake')
        insertTask.run('t-drop', 'p', 'c6', 'Dropped', 'dropped', stamp, stamp, '["f"]', 'intake')
        // task with status waiting: should not be counted under dropped
        insertTask.run('t-wait', 'p', 'c7', 'Waiting Task', 'waiting', stamp, stamp, '["g"]', 'intake')
      } finally {
        db.close()
      }
      const status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
      const intakePhase = status.phases.find(p => p.name === 'intake')!
      expect(intakePhase.tasks).toEqual({
        ready: 1,
        progress: 1,
        blocked: 1,
        failed: 1,
        done: 1,
        dropped: 1,
      })
      // non-ready task waiting property is null
      const waitTask = status.tasks!.find(t => t.id === 't-wait')!
      expect(waitTask.waiting).toBeNull()
      const progTask = status.tasks!.find(t => t.id === 't-prog')!
      expect(progTask.waiting).toBeNull()
    })

    it('computes blockedBy independently from waiting and handles disjoint scopes', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        seedProject(db)
        for (let i = 1; i <= 5; i++) insertCommand(db, `c${i}`)
        const insertTask = db.prepare('INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, phase) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        insertTask.run('prog-1', 'p', 'c1', 'P1', 'progress', stamp, stamp, '["src"]', 'development')
        insertTask.run('prog-2', 'p', 'c2', 'P2', 'progress', stamp, stamp, '["docs"]', 'development')
        insertTask.run('ready-src', 'p', 'c3', 'R1', 'ready', stamp, stamp, '["src/api"]', 'development')
        insertTask.run('ready-docs', 'p', 'c4', 'R2', 'ready', stamp, stamp, '["docs/faq"]', 'development')
        insertTask.run('ready-disjoint', 'p', 'c5', 'R3', 'ready', stamp, stamp, '["other"]', 'development')
      } finally {
        db.close()
      }
      const status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
      const r1 = status.tasks!.find(t => t.id === 'ready-src')!
      const r2 = status.tasks!.find(t => t.id === 'ready-docs')!
      const r3 = status.tasks!.find(t => t.id === 'ready-disjoint')!
      expect(r1.blockedBy).toEqual(['prog-1'])
      expect(r2.blockedBy).toEqual(['prog-2'])
      expect(r3.blockedBy).toEqual([])
    })

    it('correctly handles blocked tasks in planDispatch where waiting becomes null', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        seedProject(db)
        insertCommand(db, 'c1')
        insertCommand(db, 'c2')
        const insertTask = db.prepare('INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, phase) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        insertTask.run('t-dropped', 'p', 'c1', 'Dropped', 'dropped', stamp, stamp, '["a"]', 'intake')
        // t-ready depends on dropped -> planDispatch puts it in block, so waiting is null
        insertTask.run('t-ready', 'p', 'c2', 'Ready on dropped', 'ready', stamp, stamp, '["b"]', 'intake')
        db.prepare('INSERT INTO task_deps VALUES (?, ?)').run('t-ready', 't-dropped')
      } finally {
        db.close()
      }
      const status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
      const readyTask = status.tasks!.find(t => t.id === 't-ready')!
      expect(readyTask.dependsOn).toEqual(['t-dropped'])
      expect(readyTask.waiting).toBeNull()
    })
  })

  describe('formatStatus comprehensive rendering and labels', () => {
    it('renders all enum values and status labels', () => {
      const allPhases: PhaseStatus[] = ['locked', 'open', 'done']
      const formattedPhases = allPhases.map(s => {
        const dummy: Status = {
          schemaVersion: 8,
          recordedCommandCount: 1,
          lease: null,
          phases: [{ name: 'intake', ord: 1, status: s, openedAt: null, closedAt: null, tasks: { ready: 0, progress: 0, blocked: 0, failed: 0, done: 0, dropped: 0 } }],
        }
        return formatStatus(dummy)
      })
      expect(formattedPhases[0]).toContain('مقفلة')
      expect(formattedPhases[1]).toContain('مفتوحة')
      expect(formattedPhases[2]).toContain('مكتملة')
    })

    it('renders all taskStatus labels', () => {
      const statuses: TaskStatus[] = ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped', 'done']
      const labels = ['قيد التقدم', 'قيد الانتظار', 'جاهزة', 'محظورة', 'فاشلة', 'متروكة', 'مكتملة']
      statuses.forEach((st, idx) => {
        const dummy: Status = {
          schemaVersion: 8,
          recordedCommandCount: 1,
          lease: null,
          phases: [],
          tasks: [{
            id: 't',
            title: 'Title',
            status: st,
            attempts: [],
            scope: ['src'],
            maxAttempts: 3,
            timeoutMs: null,
            notBeforeMs: 0,
            blockedBy: [],
            phase: 'intake',
            dependsOn: [],
            waiting: null,
          }],
        }
        expect(formatStatus(dummy)).toContain(`الحالة=${labels[idx]}`)
      })
    })

    it('renders all attemptStatus labels', () => {
      const statuses: AttemptStatus[] = ['pending', 'running', 'succeeded', 'failed', 'interrupted', 'killed']
      const labels = ['معلقة', 'قيد التشغيل', 'ناجحة', 'أخفقت', 'مقاطعة', 'تم إنهاؤها']
      statuses.forEach((st, idx) => {
        const dummy: Status = {
          schemaVersion: 8,
          recordedCommandCount: 1,
          lease: null,
          phases: [],
          tasks: [{
            id: 't',
            title: 'Title',
            status: 'progress',
            attempts: [{
              no: 1,
              status: st,
              exitCode: null,
              worker: null,
              evidence: null,
              errorClass: null,
              deadlineMs: null,
            }],
            scope: ['src'],
            maxAttempts: 3,
            timeoutMs: null,
            notBeforeMs: 0,
            blockedBy: [],
            phase: 'intake',
            dependsOn: [],
            waiting: null,
          }],
        }
        expect(formatStatus(dummy)).toContain(`الحالة=${labels[idx]}`)
      })
    })

    it('renders all workerState labels', () => {
      const states: WorkerState[] = ['starting', 'running', 'exited', 'killed', 'lost']
      const labels = ['قيد البدء', 'يعمل', 'خرج', 'تم إنهاؤه', 'مفقود']
      states.forEach((st, idx) => {
        const dummy: Status = {
          schemaVersion: 8,
          recordedCommandCount: 1,
          lease: null,
          phases: [],
          tasks: [{
            id: 't',
            title: 'Title',
            status: 'progress',
            attempts: [{
              no: 1,
              status: 'running',
              exitCode: null,
              worker: { pid: 100, state: st, heartbeatMs: 50 },
              evidence: null,
              errorClass: null,
              deadlineMs: null,
            }],
            scope: ['src'],
            maxAttempts: 3,
            timeoutMs: null,
            notBeforeMs: 0,
            blockedBy: [],
            phase: 'intake',
            dependsOn: [],
            waiting: null,
          }],
        }
        expect(formatStatus(dummy)).toContain(`الحالة=${labels[idx]}`)
      })
    })

    it('renders all errorClass labels including outbox and default fallback', () => {
      const classes = ['lost', 'not-running', 'identity-mismatch', 'killed', 'transient', 'timeout', 'scope-violation', 'exit', 'outbox:send-failed', 'custom-error']
      const expected = ['مفقود', 'غير قيد التشغيل', 'عدم تطابق الهوية', 'تم إنهاؤه', 'عابر', 'انتهاء المهلة', 'انتهاك النطاق', 'خروج غير صفري', 'خطأ صندوق الصادر: send-failed', 'custom-error']
      classes.forEach((ec, idx) => {
        const dummy: Status = {
          schemaVersion: 8,
          recordedCommandCount: 1,
          lease: null,
          phases: [],
          tasks: [{
            id: 't',
            title: 'Title',
            status: 'failed',
            attempts: [{
              no: 1,
              status: 'failed',
              exitCode: 1,
              worker: null,
              evidence: null,
              errorClass: ec,
              deadlineMs: null,
            }],
            scope: ['src'],
            maxAttempts: 3,
            timeoutMs: null,
            notBeforeMs: 0,
            blockedBy: [],
            phase: 'intake',
            dependsOn: [],
            waiting: null,
          }],
        }
        expect(formatStatus(dummy)).toContain(`فئة الخطأ=${expected[idx]}`)
      })
    })

    it('renders all lease freshness labels', () => {
      const freshnesses: LeaseFreshness[] = ['fresh', 'stale', 'future', 'not-applicable']
      const expected = [
        'حديث (لا يشكل دليلاً على أن العملية قيد التشغيل)',
        'قديم',
        'في المستقبل',
        'غير منطبق (تم تحرير الملكية)',
      ]
      freshnesses.forEach((fr, idx) => {
        const dummy: Status = {
          schemaVersion: 8,
          recordedCommandCount: 1,
          lease: {
            ownerId: 'owner',
            generation: 1,
            heartbeatMs: 500,
            state: fr === 'not-applicable' ? 'released' : 'active',
            freshness: fr,
          },
          phases: [],
        }
        expect(formatStatus(dummy)).toContain(`حداثة النبض=${expected[idx]}`)
      })
    })

    it('formats outbox with various pending, done, failed combinations and failedRows', () => {
      // 0, 0, 0: no outbox section
      const dummyZero: Status = {
        schemaVersion: 8,
        recordedCommandCount: 1,
        lease: null,
        outbox: { pending: 0, done: 0, failed: 0, failedRows: [] },
        phases: [],
      }
      expect(formatStatus(dummyZero)).not.toContain('صندوق الصادر:')

      // pending > 0
      const dummyPend: Status = {
        schemaVersion: 8,
        recordedCommandCount: 1,
        lease: null,
        outbox: { pending: 2, done: 0, failed: 0, failedRows: [] },
        phases: [],
      }
      expect(formatStatus(dummyPend)).toContain('صندوق الصادر: قيد الانتظار: 2، مُنجَزة: 0، فاشلة: 0')
      expect(formatStatus(dummyPend)).not.toContain('صندوق الصادر (فاشل):')

      // failed > 0 with failedRows (null lastError and non-null lastError)
      const dummyFailed: Status = {
        schemaVersion: 8,
        recordedCommandCount: 1,
        lease: null,
        outbox: {
          pending: 0,
          done: 3,
          failed: 2,
          failedRows: [
            { key: 'key1', kind: 'email', tries: 4, lastError: 'smtp down' },
            { key: 'key2', kind: 'sms', tries: 1, lastError: null },
          ],
        },
        phases: [],
      }
      const textFailed = formatStatus(dummyFailed)
      expect(textFailed).toContain('صندوق الصادر: قيد الانتظار: 0، مُنجَزة: 3، فاشلة: 2')
      expect(textFailed).toContain('صندوق الصادر (فاشل): المفتاح="key1", النوع="email", المحاولات=4, الخطأ الأخير="smtp down"')
      expect(textFailed).toContain('صندوق الصادر (فاشل): المفتاح="key2", النوع="sms", المحاولات=1')
      expect(textFailed).not.toContain('المفتاح="key2", النوع="sms", المحاولات=1, الخطأ الأخير=')
    })

    it('does not render phase or task section when empty', () => {
      const dummyEmpty: Status = {
        schemaVersion: 8,
        recordedCommandCount: 0,
        lease: null,
        phases: [],
        tasks: [],
      }
      const text = formatStatus(dummyEmpty)
      expect(text).not.toContain('المرحلة:')
      expect(text).not.toContain('المهمة:')
    })

    it('accurately computes task attempt budget in formatStatus', () => {
      // attemptBase = 2, attempts: [no 1, no 2, no 3], maxAttempts = 5 -> attemptsUsed = 1
      const dummyWithBase: Status = {
        schemaVersion: 8,
        recordedCommandCount: 1,
        lease: null,
        phases: [],
        tasks: [
          Object.defineProperty(
            {
              id: 't1',
              title: 'Task 1',
              status: 'ready',
              scope: ['src'],
              maxAttempts: 5,
              timeoutMs: null,
              notBeforeMs: 0,
              blockedBy: [],
              phase: 'intake',
              dependsOn: [],
              waiting: null,
              attempts: [
                { no: 1, status: 'failed', exitCode: 1, worker: null, evidence: null, errorClass: null, deadlineMs: null },
                { no: 2, status: 'failed', exitCode: 1, worker: null, evidence: null, errorClass: null, deadlineMs: null },
                { no: 3, status: 'failed', exitCode: 1, worker: null, evidence: null, errorClass: null, deadlineMs: null },
              ],
            },
            'attemptBase',
            { value: 2, enumerable: false }
          ),
        ],
      }
      expect(formatStatus(dummyWithBase)).toContain('ميزانية المحاولات=1 / 5')

      // attemptBase omitted, maxAttempts omitted -> attemptsUsed = 1, maxAttempts = 3
      const dummyDefault: Status = {
        schemaVersion: 8,
        recordedCommandCount: 1,
        lease: null,
        phases: [],
        tasks: [{
          id: 't2',
          title: 'Task 2',
          status: 'ready',
          scope: ['src'],
          maxAttempts: undefined as any,
          timeoutMs: null,
          notBeforeMs: 0,
          blockedBy: [],
          phase: 'intake',
          dependsOn: [],
          waiting: null,
          attempts: [
            { no: 1, status: 'failed', exitCode: 1, worker: null, evidence: null, errorClass: null, deadlineMs: null },
          ],
        }],
      }
      expect(formatStatus(dummyDefault)).toContain('ميزانية المحاولات=1 / 3')
    })

    it('formats task optional fields (timeoutMs, notBeforeMs, phase, dependsOn, blockedBy)', () => {
      const dummyFull: Status = {
        schemaVersion: 8,
        recordedCommandCount: 1,
        lease: null,
        phases: [],
        tasks: [{
          id: 't-full',
          title: 'Task Full',
          status: 'ready',
          scope: ['src'],
          maxAttempts: 3,
          timeoutMs: 4500,
          notBeforeMs: 250,
          blockedBy: ['blocker-1', 'blocker-2'],
          phase: 'development',
          dependsOn: ['dep-1', 'dep-2'],
          waiting: null,
          attempts: [],
        }],
      }
      const textFull = formatStatus(dummyFull)
      expect(textFull).toContain(', المهلة=4500 ميلي ثانية')
      expect(textFull).toContain(', وقت عدم البدء قبل=250 ميلي ثانية')
      expect(textFull).toContain(', المرحلة=development')
      expect(textFull).toContain('المهمة تعتمد على: dep-1, dep-2')
      expect(textFull).toContain('المهمة محظورة بواسطة: blocker-1, blocker-2')

      // Omitted / null fields
      const dummyOmitted: Status = {
        schemaVersion: 8,
        recordedCommandCount: 1,
        lease: null,
        phases: [],
        tasks: [{
          id: 't-omitted',
          title: 'Task Omitted',
          status: 'ready',
          scope: ['src'],
          maxAttempts: 3,
          timeoutMs: null,
          notBeforeMs: 0,
          blockedBy: [],
          phase: '',
          dependsOn: [],
          waiting: null,
          attempts: [],
        }],
      }
      const textOmitted = formatStatus(dummyOmitted)
      expect(textOmitted).not.toContain(', المهلة=')
      expect(textOmitted).not.toContain('المهمة تعتمد على:')
      expect(textOmitted).not.toContain('المهمة محظورة بواسطة:')
    })

    it('formats waiting reasons with empty target list without trailing parentheses', () => {
      const dummyBackoff: Status = {
        schemaVersion: 8,
        recordedCommandCount: 1,
        lease: null,
        phases: [],
        tasks: [{
          id: 't-wait',
          title: 'Task Wait',
          status: 'ready',
          scope: ['src'],
          maxAttempts: 3,
          timeoutMs: null,
          notBeforeMs: 0,
          blockedBy: [],
          phase: 'intake',
          dependsOn: [],
          waiting: { reason: 'backoff', on: [] },
          attempts: [],
        }],
      }
      const text = formatStatus(dummyBackoff)
      const lines = text.split(/\r?\n/)
      const waitLine = lines.find(l => l.startsWith('سبب الانتظار:'))!
      expect(waitLine).toBe('سبب الانتظار: فترة التراجع')
    })

    it('formats attempt line with null, 0, and positive exitCode and deadlineMs', () => {
      const dummyAtt: Status = {
        schemaVersion: 8,
        recordedCommandCount: 1,
        lease: null,
        phases: [],
        tasks: [{
          id: 't',
          title: 'T',
          status: 'progress',
          scope: ['src'],
          maxAttempts: 3,
          timeoutMs: null,
          notBeforeMs: 0,
          blockedBy: [],
          phase: 'intake',
          dependsOn: [],
          waiting: null,
          attempts: [
            // exitCode: null, deadlineMs: null
            { no: 1, status: 'running', exitCode: null, worker: null, evidence: null, errorClass: null, deadlineMs: null },
            // exitCode: 0, deadlineMs: 0
            { no: 2, status: 'succeeded', exitCode: 0, worker: null, evidence: null, errorClass: null, deadlineMs: 0 },
            // exitCode: 2, deadlineMs: 15000
            { no: 3, status: 'failed', exitCode: 2, worker: null, evidence: null, errorClass: null, deadlineMs: 15000 },
          ],
        }],
      }
      const text = formatStatus(dummyAtt)
      expect(text).toContain('المحاولة #1: الحالة=قيد التشغيل\n')
      expect(text).toContain('المحاولة #2: الحالة=ناجحة, رمز الخروج=0, الموعد النهائي=0 ميلي ثانية')
      expect(text).toContain('المحاولة #3: الحالة=أخفقت, رمز الخروج=2, الموعد النهائي=15000 ميلي ثانية')
    })

    it('formats worker with null pid, 0 heartbeatMs, and suspect flag accurately', () => {
      const dummyWorker: Status = {
        schemaVersion: 8,
        recordedCommandCount: 1,
        lease: null,
        phases: [],
        tasks: [{
          id: 't',
          title: 'T',
          status: 'progress',
          scope: ['src'],
          maxAttempts: 3,
          timeoutMs: null,
          notBeforeMs: 0,
          blockedBy: [],
          phase: 'intake',
          dependsOn: [],
          waiting: null,
          attempts: [
            // worker pid null, heartbeatMs null, not suspect
            {
              no: 1,
              status: 'running',
              exitCode: null,
              worker: { pid: null, state: 'starting', heartbeatMs: null },
              evidence: null,
              errorClass: null,
              deadlineMs: null,
            },
            // worker pid 456, heartbeatMs 0, suspect true
            {
              no: 2,
              status: 'running',
              exitCode: null,
              worker: Object.defineProperty(
                { pid: 456, state: 'running', heartbeatMs: 0 },
                'isSuspect',
                { value: true, enumerable: false }
              ),
              evidence: null,
              errorClass: null,
              deadlineMs: null,
            },
          ],
        }],
      }
      const text = formatStatus(dummyWorker)
      expect(text).toContain('العامل: المعرف=غير محدد, الحالة=قيد البدء, وقت النبض=غير محدد ميلي ثانية')
      expect(text).toContain('العامل: المعرف=456, الحالة=يعمل (مشبوه), وقت النبض=0 ميلي ثانية')
    })

    it('renders phase openedAt, closedAt, and task counts in Arabic view', () => {
      const dummy: Status = {
        schemaVersion: 8,
        recordedCommandCount: 1,
        lease: null,
        phases: [
          {
            name: 'development',
            ord: 2,
            status: 'open',
            openedAt: '2026-01-01T12:00:00.000Z',
            closedAt: null,
            tasks: {
              ready: 3,
              progress: 2,
              blocked: 1,
              failed: 4,
              done: 5,
              dropped: 6,
            },
          },
          {
            name: 'intake',
            ord: 1,
            status: 'done',
            openedAt: '2026-01-01T00:00:00.000Z',
            closedAt: '2026-01-01T12:00:00.000Z',
            tasks: {
              ready: 0,
              progress: 0,
              blocked: 0,
              failed: 0,
              done: 1,
              dropped: 0,
            },
          },
        ],
      }

      const text = formatStatus(dummy)
      const lines = text.split(/\r?\n/)
      const devLine = lines.find(l => l.includes('development'))!
      expect(devLine).toBe(
        'المرحلة: development (الترتيب=2)، الحالة=مفتوحة (المرحلة المفتوحة)، وقت الفتح=2026-01-01T12:00:00.000Z، وقت الإغلاق=غير محدد، المهام: جاهزة=3، قيد التقدم=2، محظورة=1، فاشلة=4، مكتملة=5، متروكة=6',
      )

      const intakeLine = lines.find(l => l.includes('intake'))!
      expect(intakeLine).toBe(
        'المرحلة: intake (الترتيب=1)، الحالة=مكتملة، وقت الفتح=2026-01-01T00:00:00.000Z، وقت الإغلاق=2026-01-01T12:00:00.000Z، المهام: جاهزة=0، قيد التقدم=0، محظورة=0، فاشلة=0، مكتملة=1، متروكة=0',
      )
    })

    it('handles phase with null dates and default task counts when omitted', () => {
      const dummy: Status = {
        schemaVersion: 8,
        recordedCommandCount: 1,
        lease: null,
        phases: [
          {
            name: 'qa',
            ord: 3,
            status: 'locked',
            openedAt: null,
            closedAt: null,
            tasks: undefined as any,
          },
        ],
      }
      const text = formatStatus(dummy)
      expect(text).toContain(
        'المرحلة: qa (الترتيب=3)، الحالة=مقفلة، وقت الفتح=غير محدد، وقت الإغلاق=غير محدد، المهام: جاهزة=0، قيد التقدم=0، محظورة=0، فاشلة=0، مكتملة=0، متروكة=0',
      )
    })

    it('renders task attempts with evidence and suspect workers', () => {
      const dummy: Status = {
        schemaVersion: 8,
        recordedCommandCount: 1,
        lease: null,
        phases: [],
        tasks: [
          {
            id: 't1',
            title: 'Task 1',
            status: 'progress',
            scope: ['src'],
            maxAttempts: 3,
            timeoutMs: 2000,
            notBeforeMs: 100,
            blockedBy: [],
            phase: 'intake',
            dependsOn: [],
            waiting: null,
            attempts: [
              {
                no: 1,
                status: 'running',
                exitCode: null,
                errorClass: 'transient',
                deadlineMs: 99999,
                worker: Object.defineProperty(
                  { pid: 1234, state: 'running', heartbeatMs: 500 },
                  'isSuspect',
                  { value: true, enumerable: false }
                ),
                evidence: {
                  headSha: 'abc1234',
                  files: [{ path: 'file.txt', sha256: 'deadbeef' }],
                },
              },
            ],
          },
        ],
      }
      const text = formatStatus(dummy)
      expect(text).toContain('(مشبوه)')
      expect(text).toContain('التغيير=abc1234')
      expect(text).toContain('file.txt (deadbeef)')
    })
  })
})
