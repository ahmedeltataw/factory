import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendCommand } from '../../supervisor/src/app/commands.ts'
import { applyPendingCommands } from '../../supervisor/src/app/apply-commands.ts'
import { acquireSupervisor } from '../../supervisor/src/app/supervisor-lease.ts'
import { enqueue, runDue } from '../../supervisor/src/app/outbox.ts'
import { formatStatus, readStatus, type Status } from '../../supervisor/src/app/status.ts'
import { openStore } from '../../supervisor/src/app/store.ts'

const ASCII_WHITESPACE = 'char(32, 9, 10, 13, 12, 11)'

const V1_TO_V5_DDL = [
  'CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL)',
  'CREATE INDEX projects_name_idx ON projects(name)',
  `CREATE TABLE commands (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id, ${ASCII_WHITESPACE})) > 0),
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT CHECK (length(trim(project_id, ${ASCII_WHITESPACE})) > 0),
    kind TEXT NOT NULL CHECK (length(trim(kind, ${ASCII_WHITESPACE})) > 0),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL
  )`,
  `CREATE TRIGGER commands_no_update BEFORE UPDATE ON commands BEGIN SELECT RAISE(ABORT, 'commands are append-only'); END`,
  `CREATE TRIGGER commands_no_delete BEFORE DELETE ON commands BEGIN SELECT RAISE(ABORT, 'commands are append-only'); END`,
  `CREATE TRIGGER commands_no_replace BEFORE INSERT ON commands WHEN EXISTS (SELECT 1 FROM commands WHERE id = NEW.id) BEGIN SELECT RAISE(IGNORE); END`,
  `CREATE TABLE supervisor_lease (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    owner_id TEXT NOT NULL CHECK (length(trim(owner_id, ${ASCII_WHITESPACE})) > 0),
    generation INTEGER NOT NULL CHECK (generation > 0),
    heartbeat_ms INTEGER NOT NULL CHECK (heartbeat_ms >= 0),
    status TEXT NOT NULL CHECK (status IN ('active', 'released'))
  )`,
  `CREATE TABLE project_config (project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id), repo_path TEXT NOT NULL, base_ref TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE command_outcomes (command_id TEXT PRIMARY KEY NOT NULL REFERENCES commands(id), outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'rejected')), reason TEXT, lease_generation INTEGER NOT NULL, applied_at TEXT NOT NULL)`,
  `CREATE TABLE tasks (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id), created_by_command TEXT NOT NULL UNIQUE REFERENCES commands(id), title TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped', 'done')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE attempts (id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id), attempt_no INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'interrupted', 'killed')), exit_code INTEGER, error_class TEXT, lease_generation INTEGER NOT NULL, started_at TEXT, ended_at TEXT, UNIQUE(task_id, attempt_no))`,
  `CREATE UNIQUE INDEX attempts_one_live_per_task ON attempts(task_id) WHERE status IN ('pending', 'running')`,
  `CREATE TABLE workers (attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES attempts(id), nonce TEXT NOT NULL UNIQUE, pid INTEGER, state TEXT NOT NULL CHECK (state IN ('starting', 'running', 'exited', 'killed', 'lost')), worktree_path TEXT NOT NULL, heartbeat_ms INTEGER, started_at TEXT, ended_at TEXT)`,
  `CREATE TABLE outbox (id TEXT PRIMARY KEY NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')), tries INTEGER NOT NULL, next_attempt_ms INTEGER NOT NULL, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE evidence (attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES attempts(id), base_sha TEXT NOT NULL, head_sha TEXT NOT NULL, files_json TEXT NOT NULL, stdout_sha256 TEXT NOT NULL, stderr_sha256 TEXT NOT NULL, recorded_at TEXT NOT NULL)`,
  `CREATE TRIGGER command_outcomes_no_update BEFORE UPDATE ON command_outcomes BEGIN SELECT RAISE(ABORT, 'command_outcomes are append-only'); END`,
  `CREATE TRIGGER command_outcomes_no_delete BEFORE DELETE ON command_outcomes BEGIN SELECT RAISE(ABORT, 'command_outcomes are append-only'); END`,
  `CREATE TRIGGER evidence_no_update BEFORE UPDATE ON evidence BEGIN SELECT RAISE(ABORT, 'evidence is immutable'); END`,
  `CREATE TRIGGER evidence_no_delete BEFORE DELETE ON evidence BEGIN SELECT RAISE(ABORT, 'evidence is immutable'); END`,
  `PRAGMA user_version = 5`,
]

function createV5Database(path: string): void {
  const db = new DatabaseSync(path)
  try {
    for (const stmt of V1_TO_V5_DDL) {
      db.exec(stmt)
    }
  } finally {
    db.close()
  }
}

const directories: string[] = []
function databaseDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'factory-m4-schema-'))
  directories.push(directory)
  return directory
}
function databasePath(): string {
  return join(databaseDir(), 'state.sqlite')
}

function fileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

describe('M4-01 Schema v6 contract', () => {
  it('CHK-M4-01-a: fresh DB reaches v6 with all tables, foreign keys and WAL enabled', () => {
    const path = databasePath()
    const db = openStore(path)
    try {
      expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 7 })
      expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 })
      expect(db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' })
      expect(db.prepare('PRAGMA busy_timeout').get()).toMatchObject({ timeout: 5000 })

      const expectedTables = [
        'projects',
        'commands',
        'supervisor_lease',
        'project_config',
        'command_outcomes',
        'tasks',
        'attempts',
        'workers',
        'outbox',
        'evidence',
      ]
      for (const table of expectedTables) {
        const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
        expect(row, `expected table ${table} to exist`).toBeDefined()
      }

      // Verify tasks table columns in v6 via PRAGMA table_info
      interface ColumnInfo {
        cid: number
        name: string
        type: string
        notnull: number
        dflt_value: string | null
        pk: number
      }
      const taskColumns = db.prepare('PRAGMA table_info(tasks)').all() as unknown as ColumnInfo[]
      const taskColMap = new Map(taskColumns.map((c) => [c.name, c]))

      const expectedTaskCols: Record<string, { type: string; notnull: number; dflt_value: string | null }> = {
        scope_json: { type: 'TEXT', notnull: 1, dflt_value: "'[\".\"]'" },
        max_attempts: { type: 'INTEGER', notnull: 1, dflt_value: '3' },
        timeout_ms: { type: 'INTEGER', notnull: 0, dflt_value: null },
        attempt_base: { type: 'INTEGER', notnull: 1, dflt_value: '0' },
        not_before_ms: { type: 'INTEGER', notnull: 1, dflt_value: '0' },
      }
      for (const [colName, expected] of Object.entries(expectedTaskCols)) {
        const col = taskColMap.get(colName)
        expect(col, `tasks table must contain column ${colName}`).toBeDefined()
        expect(col!.type.toUpperCase()).toBe(expected.type)
        expect(col!.notnull).toBe(expected.notnull)
        expect(col!.dflt_value).toBe(expected.dflt_value)
      }

      // Verify attempts table columns in v6 via PRAGMA table_info
      const attemptColumns = db.prepare('PRAGMA table_info(attempts)').all() as unknown as ColumnInfo[]
      const attemptColMap = new Map(attemptColumns.map((c) => [c.name, c]))
      const deadlineCol = attemptColMap.get('deadline_ms')
      expect(deadlineCol, 'attempts table must contain column deadline_ms').toBeDefined()
      expect(deadlineCol!.type.toUpperCase()).toBe('INTEGER')
      expect(deadlineCol!.notnull).toBe(0)
      expect(deadlineCol!.dflt_value).toBeNull()

      // Test insert omitting new columns gets defaults
      db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p_fresh', 'Fresh', '2026-11-10T00:00:00.000Z')").run()
      db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c_fresh', 'p_fresh', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run()
      db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES ('t_def', 'p_fresh', 'c_fresh', 'Default Task', 'ready', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')").run()

      const defaultTask = db.prepare('SELECT scope_json, max_attempts, timeout_ms, attempt_base, not_before_ms FROM tasks WHERE id = ?').get('t_def') as Record<string, unknown>
      expect(defaultTask).toEqual({
        scope_json: '["."]',
        max_attempts: 3,
        timeout_ms: null,
        attempt_base: 0,
        not_before_ms: 0,
      })

      db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at) VALUES ('a_def', 't_def', 1, 'pending', NULL, NULL, 1, '2026-11-10T00:00:00.000Z', NULL)").run()
      const defaultAttempt = db.prepare('SELECT deadline_ms FROM attempts WHERE id = ?').get('a_def') as Record<string, unknown>
      expect(defaultAttempt).toEqual({ deadline_ms: null })

      // Explicit NULL is rejected for the NOT NULL ones
      for (const col of ['scope_json', 'max_attempts', 'attempt_base', 'not_before_ms']) {
        const cmdId = `c_null_${col}`
        const taskId = `t_null_${col}`
        db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES (?, 'p_fresh', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run(cmdId)
        expect(() => {
          db.prepare(`INSERT INTO tasks (id, project_id, created_by_command, title, status, ${col}, created_at, updated_at) VALUES (?, 'p_fresh', ?, 'Null Task', 'ready', NULL, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')`).run(taskId, cmdId)
        }).toThrow(/NOT NULL constraint failed/i)
      }

      // Reopening is idempotent
      const observer = new DatabaseSync(path)
      try {
        expect(observer.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 7 })
      } finally {
        observer.close()
      }
    } finally {
      db.close()
    }
  })

  it('CHK-M4-01-a: upgrades a v5 DB with tasks, attempts, workers, outbox and evidence rows to v6 with every row intact and exact defaults', () => {
    const path = databasePath()
    const raw = new DatabaseSync(path)
    const V5_TABLES = [
      'projects',
      'project_config',
      'commands',
      'command_outcomes',
      'supervisor_lease',
      'tasks',
      'attempts',
      'workers',
      'outbox',
      'evidence',
    ] as const

    const v5Snapshots: Record<string, Record<string, unknown>[]> = {}
    const v5Counts: Record<string, number> = {}

    try {
      for (const stmt of V1_TO_V5_DDL) raw.exec(stmt)
      raw.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'Alpha', '2026-11-10T00:00:00.000Z')").run()
      raw.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p2', 'Beta', '2026-11-10T00:00:01.000Z')").run()
      raw.prepare("INSERT INTO project_config (project_id, repo_path, base_ref, created_at) VALUES ('p1', '/repo/path', 'main', '2026-11-10T00:00:00.000Z')").run()
      raw.prepare("INSERT INTO project_config (project_id, repo_path, base_ref, created_at) VALUES ('p2', '/repo/beta', 'develop', '2026-11-10T00:00:01.000Z')").run()
      raw.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c1', 'p1', 'task.create', '{\"title\":\"Task 1\"}', '2026-11-10T00:00:00.000Z')").run()
      raw.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c2', 'p1', 'task.create', '{\"title\":\"Task 2\"}', '2026-11-10T00:00:01.000Z')").run()
      raw.prepare("INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at) VALUES ('c1', 'applied', NULL, 1, '2026-11-10T00:00:01.000Z')").run()
      raw.prepare("INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at) VALUES ('c2', 'rejected', 'test reject', 1, '2026-11-10T00:00:02.000Z')").run()
      raw.prepare("INSERT INTO supervisor_lease (id, owner_id, generation, heartbeat_ms, status) VALUES (1, 'owner-1', 1, 1000, 'active')").run()
      raw.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES ('t1', 'p1', 'c1', 'Task 1', 'ready', '2026-11-10T00:00:02.000Z', '2026-11-10T00:00:02.000Z')").run()
      raw.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES ('t2', 'p1', 'c2', 'Task 2', 'progress', '2026-11-10T00:00:03.000Z', '2026-11-10T00:00:03.000Z')").run()
      raw.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at) VALUES ('a1', 't1', 1, 'succeeded', 0, NULL, 1, '2026-11-10T00:00:03.000Z', '2026-11-10T00:00:10.000Z')").run()
      raw.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at) VALUES ('a2', 't2', 1, 'running', NULL, 'transient', 1, '2026-11-10T00:00:04.000Z', NULL)").run()
      raw.prepare("INSERT INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at, ended_at) VALUES ('a1', 'nonce-1', 1234, 'exited', '/repo/wt/t1', 5000, '2026-11-10T00:00:03.000Z', '2026-11-10T00:00:10.000Z')").run()
      raw.prepare("INSERT INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at, ended_at) VALUES ('a2', 'nonce-2', 5678, 'running', '/repo/wt/t2', 6000, '2026-11-10T00:00:04.000Z', NULL)").run()
      raw.prepare("INSERT INTO outbox (id, idempotency_key, kind, payload_json, status, tries, next_attempt_ms, last_error, created_at, updated_at) VALUES ('o1', 'attempt.start:a1', 'attempt.start', '{\"taskId\":\"t1\"}', 'done', 1, 0, NULL, '2026-11-10T00:00:03.000Z', '2026-11-10T00:00:10.000Z')").run()
      raw.prepare("INSERT INTO outbox (id, idempotency_key, kind, payload_json, status, tries, next_attempt_ms, last_error, created_at, updated_at) VALUES ('o2', 'attempt.start:a2', 'attempt.start', '{\"taskId\":\"t2\"}', 'pending', 2, 15000, 'connection reset', '2026-11-10T00:00:04.000Z', '2026-11-10T00:00:12.000Z')").run()
      raw.prepare("INSERT INTO evidence (attempt_id, base_sha, head_sha, files_json, stdout_sha256, stderr_sha256, recorded_at) VALUES ('a1', 'base-sha-1', 'head-sha-1', '[{\"path\":\"file.txt\",\"sha256\":\"abc\"}]', 'sha-out-1', 'sha-err-1', '2026-11-10T00:00:10.000Z')").run()

      for (const table of V5_TABLES) {
        v5Snapshots[table] = raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[]
        const countRow = raw.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get() as { cnt: number }
        v5Counts[table] = countRow.cnt
      }
    } finally {
      raw.close()
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const db = openStore(path)
      try {
        expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 7 })
        expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 })
        expect(db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' })

        // Check row counts for every v5 table match snapshot
        for (const table of V5_TABLES) {
          const countRow = db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get() as { cnt: number }
          expect(countRow.cnt, `row count for table ${table} must be preserved`).toBe(v5Counts[table])
        }

        // Check unmodified v5 tables have complete rows identical to snapshot (SELECT * ORDER BY rowid)
        for (const table of [
          'projects',
          'project_config',
          'commands',
          'command_outcomes',
          'supervisor_lease',
          'workers',
          'outbox',
          'evidence',
        ] as const) {
          const afterRows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[]
          expect(afterRows, `complete rows for table ${table} must match snapshot`).toEqual(v5Snapshots[table])
        }

        // Check tasks: old columns equal to snapshot, plus exact new defaults
        const afterTaskRows = db.prepare('SELECT * FROM tasks ORDER BY rowid').all() as Record<string, unknown>[]
        expect(afterTaskRows).toHaveLength(v5Snapshots['tasks']!.length)
        for (let i = 0; i < afterTaskRows.length; i++) {
          const before = v5Snapshots['tasks']![i]!
          const after = afterTaskRows[i]!
          expect(after).toEqual({
            ...before,
            scope_json: '["."]',
            max_attempts: 3,
            timeout_ms: null,
            attempt_base: 0,
            not_before_ms: 0,
          })
        }

        // Check attempts: old columns equal to snapshot, plus exact new defaults
        const afterAttemptRows = db.prepare('SELECT * FROM attempts ORDER BY rowid').all() as Record<string, unknown>[]
        expect(afterAttemptRows).toHaveLength(v5Snapshots['attempts']!.length)
        for (let i = 0; i < afterAttemptRows.length; i++) {
          const before = v5Snapshots['attempts']![i]!
          const after = afterAttemptRows[i]!
          expect(after).toEqual({
            ...before,
            deadline_ms: null,
          })
        }
      } finally {
        db.close()
      }
    }

    // Verify M3 triggers and one-live-attempt index still enforced in upgraded DB
    const db = openStore(path)
    try {
      db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c_trig', 'p1', 'task.create', '{}', '2026-11-10T00:01:00.000Z')").run()
      db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES ('t_trig', 'p1', 'c_trig', 'Task Trigger', 'ready', '2026-11-10T00:01:00.000Z', '2026-11-10T00:01:00.000Z')").run()
      db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at) VALUES ('a_trig_1', 't_trig', 1, 'pending', null, null, 1, '2026-11-10T00:01:00.000Z', null)").run()

      // Second live attempt fails unique partial index
      expect(() => {
        db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at) VALUES ('a_trig_2', 't_trig', 2, 'running', null, null, 1, '2026-11-10T00:01:01.000Z', null)").run()
      }).toThrow(/UNIQUE constraint failed/i)

      // Triggers still active
      expect(() => {
        db.prepare("UPDATE command_outcomes SET outcome = 'rejected' WHERE command_id = 'c1'").run()
      }).toThrow(/command_outcomes are append-only/i)
      expect(() => {
        db.prepare("DELETE FROM command_outcomes WHERE command_id = 'c1'").run()
      }).toThrow(/command_outcomes are append-only/i)
      expect(() => {
        db.prepare("UPDATE evidence SET head_sha = 'tampered' WHERE attempt_id = 'a1'").run()
      }).toThrow(/evidence is immutable/i)
      expect(() => {
        db.prepare("DELETE FROM evidence WHERE attempt_id = 'a1'").run()
      }).toThrow(/evidence is immutable/i)
    } finally {
      db.close()
    }
  })

  it('CHK-M4-01-b: rolls back failed migration 6 leaving DB at v5 with no new columns', () => {
    const path = databasePath()
    createV5Database(path)

    let firstAlterSucceeded = false
    let injectionOccurred = false
    const origExec = DatabaseSync.prototype.exec

    DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
      if (this.isTransaction && /ALTER\s+TABLE/i.test(sql)) {
        if (firstAlterSucceeded && !injectionOccurred) {
          injectionOccurred = true
          throw new Error('injected migration-6 failure')
        }
        const result = origExec.call(this, sql)
        firstAlterSucceeded = true
        return result
      }
      return origExec.call(this, sql)
    }

    let unexpectedDb: DatabaseSync | undefined
    try {
      expect(() => {
        unexpectedDb = openStore(path)
      }).toThrow('injected migration-6 failure')
    } finally {
      unexpectedDb?.close()
      DatabaseSync.prototype.exec = origExec
    }

    expect(injectionOccurred, 'migration failure must be injected after an observed successful first migration statement').toBe(true)

    const check = new DatabaseSync(path)
    try {
      expect(check.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 5 })

      const taskCols = (check.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((c) => c.name)
      expect(taskCols).not.toContain('scope_json')
      expect(taskCols).not.toContain('max_attempts')
      expect(taskCols).not.toContain('timeout_ms')
      expect(taskCols).not.toContain('attempt_base')
      expect(taskCols).not.toContain('not_before_ms')

      const attemptCols = (check.prepare('PRAGMA table_info(attempts)').all() as Array<{ name: string }>).map((c) => c.name)
      expect(attemptCols).not.toContain('deadline_ms')
    } finally {
      check.close()
    }
  })

  it('CHK-M4-01-b: refuses a v8 database unmodified', () => {
    const path = databasePath()
    const future = new DatabaseSync(path)
    future.exec(`
      CREATE TABLE future_data (value TEXT NOT NULL);
      INSERT INTO future_data VALUES ('preserved');
      PRAGMA user_version = 8;
    `)
    future.close()

    const beforeHash = fileHash(path)
    const probe = new DatabaseSync(path)
    const beforeSchema = probe.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all()
    const beforeUserVersion = probe.prepare('PRAGMA user_version').get()
    const beforeJournalMode = probe.prepare('PRAGMA journal_mode').get()
    probe.close()

    let unexpectedDb: DatabaseSync | undefined
    try {
      expect(() => {
        unexpectedDb = openStore(path)
      }).toThrow('store: unsupported schema version 8')
    } finally {
      unexpectedDb?.close()
    }

    expect(fileHash(path)).toBe(beforeHash)

    const check = new DatabaseSync(path)
    try {
      expect(check.prepare('PRAGMA user_version').get()).toEqual(beforeUserVersion)
      expect(check.prepare('PRAGMA journal_mode').get()).toEqual(beforeJournalMode)
      expect(check.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all()).toEqual(beforeSchema)
      expect(check.prepare('SELECT value FROM future_data').get()).toMatchObject({ value: 'preserved' })
    } finally {
      check.close()
    }
  })

  it('CHK-M4-01-b: rejects a future version observed after the initial check', () => {
    const path = databasePath()
    let simulatedVersionChangeOccurred = false
    const origExec = DatabaseSync.prototype.exec

    const commitV8 = () => {
      if (simulatedVersionChangeOccurred) return
      simulatedVersionChangeOccurred = true
      const second = new DatabaseSync(path)
      try {
        origExec.call(second, 'PRAGMA user_version = 8')
      } finally {
        second.close()
      }
    }

    DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
      if (/^\s*BEGIN\s+IMMEDIATE/i.test(sql)) {
        commitV8()
      }
      return origExec.call(this, sql)
    }

    let unexpectedDb: DatabaseSync | undefined
    try {
      expect(() => {
        unexpectedDb = openStore(path)
      }).toThrow(/unsupported schema version 8/i)
    } finally {
      unexpectedDb?.close()
      DatabaseSync.prototype.exec = origExec
    }

    expect(simulatedVersionChangeOccurred).toBe(true)

    const check = new DatabaseSync(path)
    try {
      expect(check.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 8 })
    } finally {
      check.close()
    }
  })

  it('CHK-M4-01-c: constraints reject max_attempts 0 or 11, timeout_ms 999 or 86400001, negative attempt_base, not_before_ms or deadline_ms, and non-JSON scope_json', () => {
    const path = databasePath()
    const db = openStore(path)
    try {
      db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'Alpha', '2026-11-10T00:00:00.000Z')").run()
      db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c1', 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run()

      // 1. max_attempts: BETWEEN 1 AND 10
      // Reject 0
      expect(() => {
        db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, max_attempts, created_at, updated_at) VALUES ('t-max-0', 'p1', 'c1', 'T', 'ready', 0, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')").run()
      }).toThrow(/CHECK constraint failed/i)
      // Reject 11
      expect(() => {
        db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, max_attempts, created_at, updated_at) VALUES ('t-max-11', 'p1', 'c1', 'T', 'ready', 11, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')").run()
      }).toThrow(/CHECK constraint failed/i)
      // Accept valid boundaries 1 and 10
      db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c-max-1', 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run()
      db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c-max-10', 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run()
      db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, max_attempts, created_at, updated_at) VALUES ('t-max-1', 'p1', 'c-max-1', 'T', 'ready', 1, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')").run()
      db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, max_attempts, created_at, updated_at) VALUES ('t-max-10', 'p1', 'c-max-10', 'T', 'ready', 10, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')").run()
      expect(db.prepare('SELECT max_attempts FROM tasks WHERE id = ?').get('t-max-1')).toMatchObject({ max_attempts: 1 })
      expect(db.prepare('SELECT max_attempts FROM tasks WHERE id = ?').get('t-max-10')).toMatchObject({ max_attempts: 10 })

      // 2. timeout_ms: IS NULL OR timeout_ms BETWEEN 1000 AND 86400000
      // Reject 999
      expect(() => {
        db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, timeout_ms, created_at, updated_at) VALUES ('t-to-999', 'p1', 'c1', 'T', 'ready', 999, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')").run()
      }).toThrow(/CHECK constraint failed/i)
      // Reject 86400001
      expect(() => {
        db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, timeout_ms, created_at, updated_at) VALUES ('t-to-86400001', 'p1', 'c1', 'T', 'ready', 86400001, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')").run()
      }).toThrow(/CHECK constraint failed/i)
      // Accept valid boundaries 1000, 86400000, and NULL
      db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c-to-1000', 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run()
      db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c-to-864', 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run()
      db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c-to-null', 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run()
      db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, timeout_ms, created_at, updated_at) VALUES ('t-to-1000', 'p1', 'c-to-1000', 'T', 'ready', 1000, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')").run()
      db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, timeout_ms, created_at, updated_at) VALUES ('t-to-864', 'p1', 'c-to-864', 'T', 'ready', 86400000, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')").run()
      db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, timeout_ms, created_at, updated_at) VALUES ('t-to-null', 'p1', 'c-to-null', 'T', 'ready', NULL, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')").run()
      expect(db.prepare('SELECT timeout_ms FROM tasks WHERE id = ?').get('t-to-1000')).toMatchObject({ timeout_ms: 1000 })
      expect(db.prepare('SELECT timeout_ms FROM tasks WHERE id = ?').get('t-to-864')).toMatchObject({ timeout_ms: 86400000 })
      expect(db.prepare('SELECT timeout_ms FROM tasks WHERE id = ?').get('t-to-null')).toMatchObject({ timeout_ms: null })

      // 3. attempt_base: attempt_base >= 0
      // Reject negative
      expect(() => {
        db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, attempt_base, created_at, updated_at) VALUES ('t-ab-neg', 'p1', 'c1', 'T', 'ready', -1, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')").run()
      }).toThrow(/CHECK constraint failed/i)
      // Accept 0
      db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c-ab-0', 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run()
      db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, attempt_base, created_at, updated_at) VALUES ('t-ab-0', 'p1', 'c-ab-0', 'T', 'ready', 0, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')").run()
      expect(db.prepare('SELECT attempt_base FROM tasks WHERE id = ?').get('t-ab-0')).toMatchObject({ attempt_base: 0 })

      // 4. not_before_ms: not_before_ms >= 0
      // Reject negative
      expect(() => {
        db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, not_before_ms, created_at, updated_at) VALUES ('t-nb-neg', 'p1', 'c1', 'T', 'ready', -1, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')").run()
      }).toThrow(/CHECK constraint failed/i)
      // Accept 0
      db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c-nb-0', 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run()
      db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, not_before_ms, created_at, updated_at) VALUES ('t-nb-0', 'p1', 'c-nb-0', 'T', 'ready', 0, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')").run()
      expect(db.prepare('SELECT not_before_ms FROM tasks WHERE id = ?').get('t-nb-0')).toMatchObject({ not_before_ms: 0 })

      // 5. scope_json: CHECK (json_valid(scope_json))
      // Reject non-JSON
      expect(() => {
        db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, scope_json, created_at, updated_at) VALUES ('t-sc-bad', 'p1', 'c1', 'T', 'ready', 'not-json', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')").run()
      }).toThrow(/CHECK constraint failed/i)
      expect(() => {
        db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, scope_json, created_at, updated_at) VALUES ('t-sc-bad2', 'p1', 'c1', 'T', 'ready', '{unclosed', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')").run()
      }).toThrow(/CHECK constraint failed/i)
      // Accept valid JSON
      db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c-sc-ok', 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run()
      db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, scope_json, created_at, updated_at) VALUES ('t-sc-ok', 'p1', 'c-sc-ok', 'T', 'ready', '[\".\"]', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')").run()
      expect(db.prepare('SELECT scope_json FROM tasks WHERE id = ?').get('t-sc-ok')).toMatchObject({ scope_json: '["."]' })

      // 6. deadline_ms in attempts: deadline_ms IS NULL OR deadline_ms >= 0
      // Reject negative
      expect(() => {
        db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, deadline_ms, started_at, ended_at) VALUES ('a-dl-neg', 't-sc-ok', 1, 'pending', null, null, 1, -1, '2026-11-10T00:00:00.000Z', null)").run()
      }).toThrow(/CHECK constraint failed/i)
      // Accept 0, positive, and NULL
      db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, deadline_ms, started_at, ended_at) VALUES ('a-dl-0', 't-sc-ok', 1, 'succeeded', 0, null, 1, 0, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:01.000Z')").run()
      db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, deadline_ms, started_at, ended_at) VALUES ('a-dl-pos', 't-sc-ok', 2, 'succeeded', 0, null, 1, 5000, '2026-11-10T00:00:02.000Z', '2026-11-10T00:00:03.000Z')").run()
      db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, deadline_ms, started_at, ended_at) VALUES ('a-dl-null', 't-sc-ok', 3, 'succeeded', 0, null, 1, null, '2026-11-10T00:00:04.000Z', '2026-11-10T00:00:05.000Z')").run()
      expect(db.prepare('SELECT deadline_ms FROM attempts WHERE id = ?').get('a-dl-0')).toMatchObject({ deadline_ms: 0 })
      expect(db.prepare('SELECT deadline_ms FROM attempts WHERE id = ?').get('a-dl-pos')).toMatchObject({ deadline_ms: 5000 })
      expect(db.prepare('SELECT deadline_ms FROM attempts WHERE id = ?').get('a-dl-null')).toMatchObject({ deadline_ms: null })
    } finally {
      db.close()
    }
  })

  it('CHK-M4-01-d: status on a v6 DB with M3-shaped data gives the same output as M3', async () => {
    const dir = databaseDir()
    const path = join(dir, 'state.sqlite')
    const db = openStore(path)
    try {
      db.prepare("INSERT INTO projects VALUES ('p1', 'Project', '2026-11-10T00:00:00.000Z')").run()
      db.prepare("INSERT INTO project_config VALUES ('p1', ?, 'main', '2026-11-10T00:00:00.000Z')").run(process.cwd())

      const handle = acquireSupervisor(db, dir, { nowMs: 1000, staleAfterMs: 500 })
      try {
        const add = (id: string, kind: string, payload: unknown) =>
          appendCommand(db, { id, projectId: 'p1', kind, payloadJson: JSON.stringify(payload), createdAt: '2026-11-10T00:00:00.000Z' })

        add('task-one', 'task.create', { title: 'Example task' })
        add('bad-command', 'task.kill', { taskId: 'missing' })
        add('bad-command-2', 'task.kill', { taskId: 'missing' })
        applyPendingCommands(db, handle)
        add('pending-2', 'task.create', { title: 'pending' })
        add('pending-3', 'task.create', { title: 'pending' })
        add('pending-command', 'task.create', { title: 'private-payload' })

        enqueue(db, handle, { idempotencyKey: 'pending', kind: 'pending', payloadJson: '{}', nowMs: 1000 })
        enqueue(db, handle, { idempotencyKey: 'done', kind: 'done', payloadJson: '{}', nowMs: 1000 })
        for (const [id, status] of [
          ['done-2', 'done'],
          ['failed-1', 'failed'],
          ['failed-2', 'failed'],
          ['failed-3', 'failed'],
        ]) {
          db.prepare('INSERT INTO outbox VALUES (?, ?, ?, ?, ?, 0, 1000, NULL, ?, ?)').run(id!, id!, 'extra', '{}', status!, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')
        }

        await runDue(db, handle, { done: () => {} }, 1000)

        db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at) VALUES ('attempt-1', 'task-one', 1, 'succeeded', 0, NULL, 1, NULL, NULL)").run()
        db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at) VALUES ('attempt-2', 'task-one', 2, 'running', NULL, NULL, 1, NULL, NULL)").run()
        db.prepare("INSERT INTO workers VALUES ('attempt-1', 'nonce-1', 12345, 'exited', '/work', 42, NULL, NULL)").run()
        db.prepare("INSERT INTO evidence VALUES ('attempt-1', 'base', 'head-sha', '[{\"path\":\"src/a.ts\",\"sha256\":\"abc123\"}]', 'out', 'err', 'now')").run()

        const expectedStatus = {
          schemaVersion: 7,
          recordedCommandCount: 6,
          commands: { recorded: 6, applied: 1, rejected: 2, pending: 3 },
          lease: {
            ownerId: handle.ownerId,
            generation: 1,
            heartbeatMs: 1000,
            state: 'active',
            freshness: 'stale',
            takeover: `${handle.ownerId}:1:1000`,
          },
          tasks: [
            {
              id: 'task-one',
              title: 'Example task',
              status: 'ready',
              scope: ['.'],
              maxAttempts: 3,
              timeoutMs: null,
              notBeforeMs: 0,
              blockedBy: [],
              attempts: [
                {
                  no: 1,
                  status: 'succeeded',
                  exitCode: 0,
                  errorClass: null,
                  deadlineMs: null,
                  worker: { pid: 12345, state: 'exited', heartbeatMs: 42 },
                  evidence: { headSha: 'head-sha', files: [{ path: 'src/a.ts', sha256: 'abc123' }] },
                },
                {
                  no: 2,
                  status: 'running',
                  exitCode: null,
                  errorClass: null,
                  deadlineMs: null,
                  worker: null,
                  evidence: null,
                },
              ],
            },
          ],
          outbox: { pending: 1, done: 2, failed: 3, failedRows: [{ key: 'failed-1', kind: 'extra', tries: 0, lastError: null }, { key: 'failed-2', kind: 'extra', tries: 0, lastError: null }, { key: 'failed-3', kind: 'extra', tries: 0, lastError: null }] },
        }

        // Read status directly and assert complete M3 status object including lease shape
        const status = readStatus(dir, { nowMs: 2000, staleAfterMs: 500 }) as unknown as Record<string, unknown>
        expect(status).toEqual(expectedStatus)

        // formatStatus gives Arabic view with schema version 6 and same M3 facts
        const arabic = formatStatus(status as unknown as Status)
        expect(arabic).toContain('إصدار المخطط: 7')
        expect(arabic).toContain('عدد الأوامر المسجلة: 6')
        expect(arabic).toContain('Example task')
        expect(arabic).toContain('task-one')
        expect(arabic).toContain('12345')
        expect(arabic).toContain('head-sha')
        expect(arabic).toContain('src/a.ts')
        expect(arabic).not.toContain('private-payload')
        expect(arabic).not.toContain('nonce-1')

        // CLI output: factory status --state-dir <d> --json
        const cliPath = join(process.cwd(), 'supervisor/src/cli/main.ts')
        const cliResult = spawnSync(process.execPath, [cliPath, 'status', '--state-dir', dir, '--json'], {
          encoding: 'utf8',
          timeout: 10000,
        })
        expect(cliResult.status).toBe(0)
        const cliJson = JSON.parse(cliResult.stdout)
        expect(Object.keys(cliJson).sort()).toEqual(['commands', 'lease', 'outbox', 'recordedCommandCount', 'schemaVersion', 'tasks'].sort())
        expect(cliJson).toEqual(expectedStatus)
        expect(cliResult.stdout).not.toContain('private-payload')
        expect(cliResult.stdout).not.toContain('nonce-1')
      } finally {
        try {
          handle.release(1000)
        } catch {
          // ignore
        }
      }
    } finally {
      db.close()
    }
  })
})
