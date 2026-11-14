import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendCommand } from '../../supervisor/src/app/commands.ts'
import { applyPendingCommands } from '../../supervisor/src/app/apply-commands.ts'
import { acquireSupervisor } from '../../supervisor/src/app/supervisor-lease.ts'
import { enqueue, runDue } from '../../supervisor/src/app/outbox.ts'
import { formatStatus, readStatus, type Status } from '../../supervisor/src/app/status.ts'
import { openStore } from '../../supervisor/src/app/store.ts'
import { init } from '../../supervisor/src/app/init.ts'

const ASCII_WHITESPACE = 'char(32, 9, 10, 13, 12, 11)'

const V1_TO_V6_DDL = [
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
  `CREATE TABLE tasks (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id),
    created_by_command TEXT NOT NULL UNIQUE REFERENCES commands(id),
    title TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped', 'done')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    scope_json TEXT NOT NULL DEFAULT '["."]' CHECK (json_valid(scope_json)),
    max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
    timeout_ms INTEGER CHECK (timeout_ms IS NULL OR timeout_ms BETWEEN 1000 AND 86400000),
    attempt_base INTEGER NOT NULL DEFAULT 0 CHECK (attempt_base >= 0),
    not_before_ms INTEGER NOT NULL DEFAULT 0 CHECK (not_before_ms >= 0)
  )`,
  `CREATE TABLE attempts (
    id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    attempt_no INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'interrupted', 'killed')),
    exit_code INTEGER,
    error_class TEXT,
    lease_generation INTEGER NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    deadline_ms INTEGER CHECK (deadline_ms IS NULL OR deadline_ms >= 0),
    UNIQUE(task_id, attempt_no)
  )`,
  `CREATE UNIQUE INDEX attempts_one_live_per_task ON attempts(task_id) WHERE status IN ('pending', 'running')`,
  `CREATE TABLE workers (attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES attempts(id), nonce TEXT NOT NULL UNIQUE, pid INTEGER, state TEXT NOT NULL CHECK (state IN ('starting', 'running', 'exited', 'killed', 'lost')), worktree_path TEXT NOT NULL, heartbeat_ms INTEGER, started_at TEXT, ended_at TEXT)`,
  `CREATE TABLE outbox (id TEXT PRIMARY KEY NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')), tries INTEGER NOT NULL, next_attempt_ms INTEGER NOT NULL, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE evidence (attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES attempts(id), base_sha TEXT NOT NULL, head_sha TEXT NOT NULL, files_json TEXT NOT NULL, stdout_sha256 TEXT NOT NULL, stderr_sha256 TEXT NOT NULL, recorded_at TEXT NOT NULL)`,
  `CREATE TRIGGER command_outcomes_no_update BEFORE UPDATE ON command_outcomes BEGIN SELECT RAISE(ABORT, 'command_outcomes are append-only'); END`,
  `CREATE TRIGGER command_outcomes_no_delete BEFORE DELETE ON command_outcomes BEGIN SELECT RAISE(ABORT, 'command_outcomes are append-only'); END`,
  `CREATE TRIGGER evidence_no_update BEFORE UPDATE ON evidence BEGIN SELECT RAISE(ABORT, 'evidence is immutable'); END`,
  `CREATE TRIGGER evidence_no_delete BEFORE DELETE ON evidence BEGIN SELECT RAISE(ABORT, 'evidence is immutable'); END`,
  `PRAGMA user_version = 6`,
]

function createV6Database(path: string): void {
  const db = new DatabaseSync(path)
  try {
    for (const stmt of V1_TO_V6_DDL) {
      db.exec(stmt)
    }
  } finally {
    db.close()
  }
}

function createGitRepo(dir: string): void {
  execFileSync('git', ['init', dir], { stdio: 'ignore' })
  execFileSync(
    'git',
    [
      '-C',
      dir,
      '-c',
      'user.name=Factory Test',
      '-c',
      'user.email=factory@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'initial commit',
    ],
    { stdio: 'ignore' },
  )
}

const directories: string[] = []
function databaseDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'factory-m5-schema-'))
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

describe('M5-03 Schema v7 and phase seeding contract', () => {
  it('CHK-M5-03-a: fresh DB reaches v7 with all tables, foreign keys and WAL enabled', () => {
    const path = databasePath()
    const db = openStore(path)
    try {
      expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 8 })
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
        'phases',
        'task_deps',
      ]
      for (const table of expectedTables) {
        const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
        expect(row, `expected table ${table} to exist`).toBeDefined()
      }

      interface ColumnInfo {
        cid: number
        name: string
        type: string
        notnull: number
        dflt_value: string | null
        pk: number
      }

      // Verify tasks table phase column
      const taskColumns = db.prepare('PRAGMA table_info(tasks)').all() as unknown as ColumnInfo[]
      const taskColMap = new Map(taskColumns.map((c) => [c.name, c]))
      const phaseCol = taskColMap.get('phase')
      expect(phaseCol, 'tasks table must contain column phase').toBeDefined()
      expect(phaseCol!.type.toUpperCase()).toBe('TEXT')
      expect(phaseCol!.notnull).toBe(1)
      expect(phaseCol!.dflt_value).toBe("'intake'")

      // Verify phases table columns
      const phaseColumns = db.prepare('PRAGMA table_info(phases)').all() as unknown as ColumnInfo[]
      const phaseColMap = new Map(phaseColumns.map((c) => [c.name, c]))
      expect(phaseColMap.get('project_id')).toMatchObject({ notnull: 1 })
      expect(phaseColMap.get('name')).toMatchObject({ notnull: 1 })
      expect(phaseColMap.get('ord')).toMatchObject({ notnull: 1 })
      expect(phaseColMap.get('status')).toMatchObject({ notnull: 1 })
      expect(phaseColMap.get('opened_at')).toBeDefined()
      expect(phaseColMap.get('closed_at')).toBeDefined()

      // Verify task_deps table columns
      const taskDepsColumns = db.prepare('PRAGMA table_info(task_deps)').all() as unknown as ColumnInfo[]
      const taskDepsColMap = new Map(taskDepsColumns.map((c) => [c.name, c]))
      expect(taskDepsColMap.get('task_id')).toMatchObject({ notnull: 1 })
      expect(taskDepsColMap.get('depends_on')).toMatchObject({ notnull: 1 })

      // Verify index and triggers
      const indexRow = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'phases_one_open'").get()
      expect(indexRow, 'expected index phases_one_open to exist').toBeDefined()

      for (const trigger of ['phases_no_delete', 'task_deps_no_update', 'task_deps_no_delete']) {
        const trigRow = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(trigger)
        expect(trigRow, `expected trigger ${trigger} to exist`).toBeDefined()
      }

      // Foreign key on phases.project_id rejects an unknown project
      expect(() => {
        db.prepare("INSERT INTO phases (project_id, name, ord, status) VALUES ('unknown_project', 'intake', 1, 'locked')").run()
      }).toThrow(/FOREIGN KEY constraint failed/i)

      // Inserting task omitting phase gets default 'intake'
      db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p_fresh', 'Fresh', '2026-11-10T00:00:00.000Z')").run()

      // phases.status CHECK rejects 'closed'
      expect(() => {
        db.prepare("INSERT INTO phases (project_id, name, ord, status) VALUES ('p_fresh', 'intake', 1, 'closed')").run()
      }).toThrow(/CHECK constraint failed/i)
      db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c_fresh', 'p_fresh', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run()
      db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES ('t_def', 'p_fresh', 'c_fresh', 'Default Task', 'ready', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')").run()

      const defaultTask = db.prepare('SELECT phase FROM tasks WHERE id = ?').get('t_def') as Record<string, unknown>
      expect(defaultTask).toEqual({ phase: 'intake' })

      // Explicit NULL for phase is rejected
      db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c_null_phase', 'p_fresh', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run()
      expect(() => {
        db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, phase, created_at, updated_at) VALUES ('t_null_phase', 'p_fresh', 'c_null_phase', 'Null Phase Task', 'ready', NULL, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')").run()
      }).toThrow(/NOT NULL constraint failed/i)

      // Reopening is idempotent
      const observer = new DatabaseSync(path)
      try {
        expect(observer.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 8 })
      } finally {
        observer.close()
      }
    } finally {
      db.close()
    }
  })

  it('CHK-M5-03-a: upgrades a v6 DB with tasks, attempts, workers, outbox and evidence rows to v7 with every row intact, task phase intake, and five phases per project', () => {
    const path = databasePath()
    const raw = new DatabaseSync(path)
    const V6_TABLES = [
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

    const v6Snapshots: Record<string, Record<string, unknown>[]> = {}
    const v6Counts: Record<string, number> = {}

    try {
      for (const stmt of V1_TO_V6_DDL) raw.exec(stmt)
      raw.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'Alpha', '2026-11-10T00:00:00.000Z')").run()
      raw.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p2', 'Beta', '2026-11-10T00:00:01.000Z')").run()
      raw.prepare("INSERT INTO project_config (project_id, repo_path, base_ref, created_at) VALUES ('p1', '/repo/path', 'main', '2026-11-10T00:00:00.000Z')").run()
      raw.prepare("INSERT INTO project_config (project_id, repo_path, base_ref, created_at) VALUES ('p2', '/repo/beta', 'develop', '2026-11-10T00:00:01.000Z')").run()
      raw.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c1', 'p1', 'task.create', '{\"title\":\"Task 1\"}', '2026-11-10T00:00:00.000Z')").run()
      raw.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c2', 'p1', 'task.create', '{\"title\":\"Task 2\"}', '2026-11-10T00:00:01.000Z')").run()
      raw.prepare("INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at) VALUES ('c1', 'applied', NULL, 1, '2026-11-10T00:00:01.000Z')").run()
      raw.prepare("INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at) VALUES ('c2', 'rejected', 'test reject', 1, '2026-11-10T00:00:02.000Z')").run()
      raw.prepare("INSERT INTO supervisor_lease (id, owner_id, generation, heartbeat_ms, status) VALUES (1, 'owner-1', 1, 1000, 'active')").run()
      raw.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, max_attempts, timeout_ms, attempt_base, not_before_ms) VALUES ('t1', 'p1', 'c1', 'Task 1', 'ready', '2026-11-10T00:00:02.000Z', '2026-11-10T00:00:02.000Z', '[\".\"]', 3, NULL, 0, 0)").run()
      raw.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, max_attempts, timeout_ms, attempt_base, not_before_ms) VALUES ('t2', 'p1', 'c2', 'Task 2', 'progress', '2026-11-10T00:00:03.000Z', '2026-11-10T00:00:03.000Z', '[\"src/a\",\"src/b\"]', 5, 10000, 1, 5000)").run()
      raw.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at, deadline_ms) VALUES ('a1', 't1', 1, 'succeeded', 0, NULL, 1, '2026-11-10T00:00:03.000Z', '2026-11-10T00:00:10.000Z', NULL)").run()
      raw.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at, deadline_ms) VALUES ('a2', 't2', 1, 'running', NULL, 'transient', 1, '2026-11-10T00:00:04.000Z', NULL, 15000)").run()
      raw.prepare("INSERT INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at, ended_at) VALUES ('a1', 'nonce-1', 1234, 'exited', '/repo/wt/t1', 5000, '2026-11-10T00:00:03.000Z', '2026-11-10T00:00:10.000Z')").run()
      raw.prepare("INSERT INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at, ended_at) VALUES ('a2', 'nonce-2', 5678, 'running', '/repo/wt/t2', 6000, '2026-11-10T00:00:04.000Z', NULL)").run()
      raw.prepare("INSERT INTO outbox (id, idempotency_key, kind, payload_json, status, tries, next_attempt_ms, last_error, created_at, updated_at) VALUES ('o1', 'attempt.start:a1', 'attempt.start', '{\"taskId\":\"t1\"}', 'done', 1, 0, NULL, '2026-11-10T00:00:03.000Z', '2026-11-10T00:00:10.000Z')").run()
      raw.prepare("INSERT INTO outbox (id, idempotency_key, kind, payload_json, status, tries, next_attempt_ms, last_error, created_at, updated_at) VALUES ('o2', 'attempt.start:a2', 'attempt.start', '{\"taskId\":\"t2\"}', 'pending', 2, 15000, 'connection reset', '2026-11-10T00:00:04.000Z', '2026-11-10T00:00:12.000Z')").run()
      raw.prepare("INSERT INTO evidence (attempt_id, base_sha, head_sha, files_json, stdout_sha256, stderr_sha256, recorded_at) VALUES ('a1', 'base-sha-1', 'head-sha-1', '[{\"path\":\"file.txt\",\"sha256\":\"abc\"}]', 'sha-out-1', 'sha-err-1', '2026-11-10T00:00:10.000Z')").run()

      for (const table of V6_TABLES) {
        v6Snapshots[table] = raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[]
        const countRow = raw.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get() as { cnt: number }
        v6Counts[table] = countRow.cnt
      }
    } finally {
      raw.close()
    }

    const timeBeforeUpgrade = new Date(Date.now() - 100).toISOString()
    let timeAfterUpgrade: string | undefined
    let firstPhasesSnapshot: Record<string, unknown>[] | undefined

    for (let attempt = 0; attempt < 2; attempt++) {
      const db = openStore(path)
      if (attempt === 0) {
        timeAfterUpgrade = new Date(Date.now() + 100).toISOString()
      }
      try {
        expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 8 })
        expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 })
        expect(db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' })

        // Reopening the DB leaves the whole phases table byte-identical (compare full row snapshots before/after reopen)
        const currentPhasesSnapshot = db.prepare('SELECT * FROM phases ORDER BY project_id, ord').all() as Record<string, unknown>[]
        if (attempt === 0) {
          firstPhasesSnapshot = currentPhasesSnapshot
        } else {
          expect(currentPhasesSnapshot, 'reopening the DB leaves the whole phases table byte-identical').toEqual(firstPhasesSnapshot)
        }

        // Check row counts for every v6 table match snapshot
        for (const table of V6_TABLES) {
          const countRow = db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get() as { cnt: number }
          expect(countRow.cnt, `row count for table ${table} must be preserved`).toBe(v6Counts[table])
        }

        // Check unmodified v6 tables have complete rows identical to snapshot
        for (const table of [
          'projects',
          'project_config',
          'commands',
          'command_outcomes',
          'supervisor_lease',
          'attempts',
          'workers',
          'outbox',
          'evidence',
        ] as const) {
          const afterRows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[]
          expect(afterRows, `complete rows for table ${table} must match snapshot`).toEqual(v6Snapshots[table])
        }

        // Check tasks: old columns equal to snapshot, plus new column phase = 'intake'
        const afterTaskRows = db.prepare('SELECT * FROM tasks ORDER BY rowid').all() as Record<string, unknown>[]
        expect(afterTaskRows).toHaveLength(v6Snapshots['tasks']!.length)
        for (let i = 0; i < afterTaskRows.length; i++) {
          const before = v6Snapshots['tasks']![i]!
          const after = afterTaskRows[i]!
          expect(after).toEqual({
            ...before,
            phase: 'intake',
          })
        }

        // Check five phases seeded per project with frozen (name, ord) pairs
        for (const projectId of ['p1', 'p2']) {
          const phases = db.prepare('SELECT project_id, name, ord, status, opened_at, closed_at FROM phases WHERE project_id = ? ORDER BY ord').all(projectId) as Array<{
            project_id: string
            name: string
            ord: number
            status: string
            opened_at: string | null
            closed_at: string | null
          }>
          expect(phases).toHaveLength(5)
          expect(phases.map((p) => ({ name: p.name, ord: p.ord }))).toEqual([
            { name: 'intake', ord: 1 },
            { name: 'development', ord: 2 },
            { name: 'qa', ord: 3 },
            { name: 'devops', ord: 4 },
            { name: 'handover', ord: 5 },
          ])

          const intake = phases.find((p) => p.name === 'intake')!
          expect(intake.status).toBe('open')
          expect(typeof intake.opened_at).toBe('string')
          expect(intake.opened_at!.length).toBeGreaterThan(0)
          expect(intake.closed_at).toBeNull()

          // opened_at of the intake phase after upgrade is a valid ISO timestamp between the time before and after the upgrade call
          const parsedMs = Date.parse(intake.opened_at!)
          expect(Number.isNaN(parsedMs)).toBe(false)
          expect(new Date(parsedMs).toISOString()).toBe(intake.opened_at)
          expect(parsedMs).toBeGreaterThanOrEqual(Date.parse(timeBeforeUpgrade))
          expect(parsedMs).toBeLessThanOrEqual(Date.parse(timeAfterUpgrade!))

          for (const otherName of ['development', 'qa', 'devops', 'handover']) {
            const other = phases.find((p) => p.name === otherName)!
            expect(other.status).toBe('locked')
            expect(other.opened_at).toBeNull()
            expect(other.closed_at).toBeNull()
          }
        }
      } finally {
        db.close()
      }
    }

    // Verify M3/M4 triggers and indexes still enforced in upgraded DB
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
      expect(() => {
        db.prepare("UPDATE commands SET kind = 'tampered' WHERE id = 'c1'").run()
      }).toThrow(/commands are append-only/i)
      expect(() => {
        db.prepare("DELETE FROM commands WHERE id = 'c1'").run()
      }).toThrow(/commands are append-only/i)
    } finally {
      db.close()
    }
  })

  it('CHK-M5-03-b: rolls back failed migration 7 leaving DB at v6 with no phases or task_deps tables and no phase column', () => {
    const path = databasePath()
    createV6Database(path)

    let firstStatementSucceeded = false
    let injectionOccurred = false
    let statementsAfterV6 = 0
    const origExec = DatabaseSync.prototype.exec
    const origPrepare = DatabaseSync.prototype.prepare

    DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
      if (injectionOccurred) {
        return origExec.call(this, sql)
      }

      if (this.isTransaction) {
        let isV6 = false
        try {
          const row = origPrepare.call(this, 'PRAGMA user_version').get() as { user_version?: number } | undefined
          isV6 = row?.user_version === 6
        } catch {
          // ignore
        }

        if (isV6 && !/^\s*(?:BEGIN|COMMIT|ROLLBACK|PRAGMA)\b/i.test(sql)) {
          const _hint = /phases|task_deps|tasks/i.test(sql)
          if (statementsAfterV6 >= 1 && !injectionOccurred) {
            injectionOccurred = true
            throw new Error('injected migration-7 failure')
          }
          const result = origExec.call(this, sql)
          statementsAfterV6++
          firstStatementSucceeded = true
          return result
        }
      }

      return origExec.call(this, sql)
    }

    let unexpectedDb: DatabaseSync | undefined
    try {
      expect(() => {
        unexpectedDb = openStore(path)
      }).toThrow('injected migration-7 failure')
    } finally {
      unexpectedDb?.close()
      DatabaseSync.prototype.exec = origExec
    }

    expect(injectionOccurred, 'migration failure must be injected after an observed successful first migration statement').toBe(true)

    const check = new DatabaseSync(path)
    try {
      expect(check.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 6 })

      expect(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'phases'").get()).toBeUndefined()
      expect(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_deps'").get()).toBeUndefined()

      const taskCols = (check.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((c) => c.name)
      expect(taskCols).not.toContain('phase')
    } finally {
      check.close()
    }
  })

  it('CHK-M5-03-b: refuses a v8 database unmodified', () => {
    const path = databasePath()
    const future = new DatabaseSync(path)
    future.exec(`
      CREATE TABLE future_data (value TEXT NOT NULL);
      INSERT INTO future_data VALUES ('preserved');
      PRAGMA user_version = 9;
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
      }).toThrow()
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
      expect(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'phases'").get()).toBeUndefined()
    } finally {
      check.close()
    }
  })

  it('CHK-M5-03-b: rejects a future version observed after the initial check', () => {
    const path = databasePath()
    let simulatedVersionChangeOccurred = false
    const origExec = DatabaseSync.prototype.exec

    const commitV8 = () => {
      if (simulatedVersionChangeOccurred) return
      simulatedVersionChangeOccurred = true
      const second = new DatabaseSync(path)
      try {
        origExec.call(
          second,
          `CREATE TABLE future_data (value TEXT NOT NULL);
           INSERT INTO future_data VALUES ('preserved');
           PRAGMA user_version = 9;`,
        )
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
      }).toThrow()
    } finally {
      unexpectedDb?.close()
      DatabaseSync.prototype.exec = origExec
    }

    expect(simulatedVersionChangeOccurred).toBe(true)

    const check = new DatabaseSync(path)
    try {
      expect(check.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 9 })
      expect(check.prepare('SELECT value FROM future_data').get()).toMatchObject({ value: 'preserved' })
      expect(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'phases'").get()).toBeUndefined()
    } finally {
      check.close()
    }
  })

  describe('CHK-M5-03-c: constraints', () => {
    it('CHK-M5-03-c: constraints reject a wrong (name, ord) pair', () => {
      const path = databasePath()
      const db = openStore(path)
      try {
        db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'Alpha', '2026-11-10T00:00:00.000Z')").run()

        // Wrong pairs
        expect(() => {
          db.prepare("INSERT INTO phases (project_id, name, ord, status) VALUES ('p1', 'intake', 2, 'locked')").run()
        }).toThrow(/CHECK constraint failed/i)
        expect(() => {
          db.prepare("INSERT INTO phases (project_id, name, ord, status) VALUES ('p1', 'development', 1, 'locked')").run()
        }).toThrow(/CHECK constraint failed/i)
        expect(() => {
          db.prepare("INSERT INTO phases (project_id, name, ord, status) VALUES ('p1', 'qa', 4, 'locked')").run()
        }).toThrow(/CHECK constraint failed/i)
        expect(() => {
          db.prepare("INSERT INTO phases (project_id, name, ord, status) VALUES ('p1', 'devops', 3, 'locked')").run()
        }).toThrow(/CHECK constraint failed/i)
        expect(() => {
          db.prepare("INSERT INTO phases (project_id, name, ord, status) VALUES ('p1', 'handover', 1, 'locked')").run()
        }).toThrow(/CHECK constraint failed/i)
        expect(() => {
          db.prepare("INSERT INTO phases (project_id, name, ord, status) VALUES ('p1', 'unknown', 1, 'locked')").run()
        }).toThrow(/CHECK constraint failed/i)
        expect(() => {
          db.prepare("INSERT INTO phases (project_id, name, ord, status) VALUES ('p1', 'intake', 0, 'locked')").run()
        }).toThrow(/CHECK constraint failed/i)
        expect(() => {
          db.prepare("INSERT INTO phases (project_id, name, ord, status) VALUES ('p1', 'intake', 6, 'locked')").run()
        }).toThrow(/CHECK constraint failed/i)

        // Valid pairs succeed
        db.prepare("INSERT INTO phases (project_id, name, ord, status, opened_at) VALUES ('p1', 'intake', 1, 'open', '2026-11-10T00:00:00.000Z')").run()
        db.prepare("INSERT INTO phases (project_id, name, ord, status) VALUES ('p1', 'development', 2, 'locked')").run()
        db.prepare("INSERT INTO phases (project_id, name, ord, status) VALUES ('p1', 'qa', 3, 'locked')").run()
        db.prepare("INSERT INTO phases (project_id, name, ord, status) VALUES ('p1', 'devops', 4, 'locked')").run()
        db.prepare("INSERT INTO phases (project_id, name, ord, status) VALUES ('p1', 'handover', 5, 'locked')").run()

        const count = db.prepare('SELECT COUNT(*) AS cnt FROM phases WHERE project_id = ?').get('p1') as { cnt: number }
        expect(count.cnt).toBe(5)
      } finally {
        db.close()
      }
    })

    it('CHK-M5-03-c: constraints reject a second open phase in a project', () => {
      const path = databasePath()
      const db = openStore(path)
      try {
        db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'Alpha', '2026-11-10T00:00:00.000Z')").run()
        db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p2', 'Beta', '2026-11-10T00:00:00.000Z')").run()

        db.prepare("INSERT INTO phases (project_id, name, ord, status, opened_at) VALUES ('p1', 'intake', 1, 'open', '2026-11-10T00:00:00.000Z')").run()
        db.prepare("INSERT INTO phases (project_id, name, ord, status) VALUES ('p1', 'development', 2, 'locked')").run()

        // Setting a second phase to 'open' in project p1 fails
        expect(() => {
          db.prepare("UPDATE phases SET status = 'open' WHERE project_id = 'p1' AND name = 'development'").run()
        }).toThrow(/UNIQUE constraint failed/i)

        // Inserting a second 'open' phase in project p1 fails
        expect(() => {
          db.prepare("INSERT INTO phases (project_id, name, ord, status, opened_at) VALUES ('p1', 'qa', 3, 'open', '2026-11-10T00:00:00.000Z')").run()
        }).toThrow(/UNIQUE constraint failed/i)

        // Another project p2 can have an open phase
        expect(() => {
          db.prepare("INSERT INTO phases (project_id, name, ord, status, opened_at) VALUES ('p2', 'intake', 1, 'open', '2026-11-10T00:00:00.000Z')").run()
        }).not.toThrow()
      } finally {
        db.close()
      }
    })

    it('CHK-M5-03-c: constraints reject deleting a phase', () => {
      const path = databasePath()
      const db = openStore(path)
      try {
        db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'Alpha', '2026-11-10T00:00:00.000Z')").run()
        db.prepare("INSERT INTO phases (project_id, name, ord, status, opened_at) VALUES ('p1', 'intake', 1, 'open', '2026-11-10T00:00:00.000Z')").run()

        expect(() => {
          db.prepare("DELETE FROM phases WHERE project_id = 'p1' AND name = 'intake'").run()
        }).toThrow(/phases are permanent/i)

        expect(() => {
          db.prepare("DELETE FROM phases WHERE project_id = 'p1'").run()
        }).toThrow(/phases are permanent/i)

        expect(() => {
          db.prepare("DELETE FROM phases").run()
        }).toThrow(/phases are permanent/i)
      } finally {
        db.close()
      }
    })

    it('CHK-M5-03-c: constraints reject a bad task phase', () => {
      const path = databasePath()
      const db = openStore(path)
      try {
        db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'Alpha', '2026-11-10T00:00:00.000Z')").run()
        db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c1', 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run()

        // Bad phase names on INSERT
        for (const badPhase of ['invalid', 'build', 'testing', '', 'INTAKE', 'intake ']) {
          expect(() => {
            db.prepare(`INSERT INTO tasks (id, project_id, created_by_command, title, status, phase, created_at, updated_at) VALUES ('t-bad-${badPhase}', 'p1', 'c1', 'T', 'ready', ?, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')`).run(badPhase)
          }).toThrow(/CHECK constraint failed/i)
        }

        // Valid phase names succeed
        for (const validPhase of ['intake', 'development', 'qa', 'devops', 'handover']) {
          const cmdId = `c-phase-${validPhase}`
          const taskId = `t-phase-${validPhase}`
          db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES (?, 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run(cmdId)
          db.prepare(`INSERT INTO tasks (id, project_id, created_by_command, title, status, phase, created_at, updated_at) VALUES (?, 'p1', ?, 'T', 'ready', ?, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')`).run(taskId, cmdId, validPhase)
          expect(db.prepare('SELECT phase FROM tasks WHERE id = ?').get(taskId)).toMatchObject({ phase: validPhase })
        }

        // UPDATE to bad phase fails
        expect(() => {
          db.prepare("UPDATE tasks SET phase = 'invalid' WHERE id = 't-phase-intake'").run()
        }).toThrow(/CHECK constraint failed/i)
      } finally {
        db.close()
      }
    })

    it('CHK-M5-03-c: constraints reject a self-dependency', () => {
      const path = databasePath()
      const db = openStore(path)
      try {
        db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'Alpha', '2026-11-10T00:00:00.000Z')").run()
        db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c1', 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run()
        db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES ('t1', 'p1', 'c1', 'Task 1', 'ready', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')").run()

        expect(() => {
          db.prepare("INSERT INTO task_deps (task_id, depends_on) VALUES ('t1', 't1')").run()
        }).toThrow(/CHECK constraint failed/i)
      } finally {
        db.close()
      }
    })

    it('CHK-M5-03-c: constraints reject a dep to a missing task', () => {
      const path = databasePath()
      const db = openStore(path)
      try {
        db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'Alpha', '2026-11-10T00:00:00.000Z')").run()
        db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c1', 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run()
        db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c2', 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run()
        db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES ('t1', 'p1', 'c1', 'Task 1', 'ready', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')").run()
        db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES ('t2', 'p1', 'c2', 'Task 2', 'ready', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')").run()

        // depends_on is missing
        expect(() => {
          db.prepare("INSERT INTO task_deps (task_id, depends_on) VALUES ('t2', 'nonexistent')").run()
        }).toThrow(/FOREIGN KEY constraint failed/i)

        // task_id is missing
        expect(() => {
          db.prepare("INSERT INTO task_deps (task_id, depends_on) VALUES ('nonexistent', 't1')").run()
        }).toThrow(/FOREIGN KEY constraint failed/i)

        // Valid dep succeeds
        expect(() => {
          db.prepare("INSERT INTO task_deps (task_id, depends_on) VALUES ('t2', 't1')").run()
        }).not.toThrow()

        // Duplicate primary key fails
        expect(() => {
          db.prepare("INSERT INTO task_deps (task_id, depends_on) VALUES ('t2', 't1')").run()
        }).toThrow(/UNIQUE constraint failed/i)
      } finally {
        db.close()
      }
    })

    it('CHK-M5-03-c: constraints reject any update or delete of task_deps', () => {
      const path = databasePath()
      const db = openStore(path)
      try {
        db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'Alpha', '2026-11-10T00:00:00.000Z')").run()
        db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c1', 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run()
        db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c2', 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run()
        db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c3', 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run()
        db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES ('t1', 'p1', 'c1', 'Task 1', 'ready', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')").run()
        db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES ('t2', 'p1', 'c2', 'Task 2', 'ready', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')").run()
        db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES ('t3', 'p1', 'c3', 'Task 3', 'ready', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')").run()

        db.prepare("INSERT INTO task_deps (task_id, depends_on) VALUES ('t2', 't1')").run()

        // UPDATE rejected
        expect(() => {
          db.prepare("UPDATE task_deps SET depends_on = 't3' WHERE task_id = 't2'").run()
        }).toThrow(/task_deps are immutable/i)
        expect(() => {
          db.prepare("UPDATE task_deps SET task_id = 't3' WHERE task_id = 't2'").run()
        }).toThrow(/task_deps are immutable/i)
        expect(() => {
          db.prepare("UPDATE task_deps SET depends_on = depends_on WHERE task_id = 't2'").run()
        }).toThrow(/task_deps are immutable/i)

        // DELETE rejected
        expect(() => {
          db.prepare("DELETE FROM task_deps WHERE task_id = 't2' AND depends_on = 't1'").run()
        }).toThrow(/task_deps are immutable/i)
        expect(() => {
          db.prepare("DELETE FROM task_deps").run()
        }).toThrow(/task_deps are immutable/i)
      } finally {
        db.close()
      }
    })
  })

  it('CHK-M5-03-d: factory init creates the five phases in the init transaction and failure injection leaves no project and no phases', () => {
    // 1. factory init creates the five phases in the init transaction
    const repoDir = databaseDir()
    createGitRepo(repoDir)
    const stateDir = databaseDir()

    init(stateDir, repoDir)

    const dbPath = join(stateDir, 'state.sqlite')
    const db = new DatabaseSync(dbPath)
    try {
      const project = db.prepare('SELECT id, name FROM projects').get() as { id: string; name: string } | undefined
      expect(project).toBeDefined()

      const phases = db.prepare('SELECT project_id, name, ord, status, opened_at, closed_at FROM phases WHERE project_id = ? ORDER BY ord').all(project!.id) as Array<{
        project_id: string
        name: string
        ord: number
        status: string
        opened_at: string | null
        closed_at: string | null
      }>
      expect(phases).toHaveLength(5)
      expect(phases.map((p) => ({ name: p.name, ord: p.ord }))).toEqual([
        { name: 'intake', ord: 1 },
        { name: 'development', ord: 2 },
        { name: 'qa', ord: 3 },
        { name: 'devops', ord: 4 },
        { name: 'handover', ord: 5 },
      ])

      const intake = phases.find((p) => p.name === 'intake')!
      expect(intake.status).toBe('open')
      expect(typeof intake.opened_at).toBe('string')
      expect(intake.opened_at!.length).toBeGreaterThan(0)
      expect(intake.closed_at).toBeNull()

      for (const lockedPhase of ['development', 'qa', 'devops', 'handover']) {
        const p = phases.find((phase) => phase.name === lockedPhase)!
        expect(p.status).toBe('locked')
        expect(p.opened_at).toBeNull()
        expect(p.closed_at).toBeNull()
      }
    } finally {
      db.close()
    }

    // 2. An injected failure after at least one phase row insert leaves no project, no project_config and no phases
    const repoDirFail = databaseDir()
    createGitRepo(repoDirFail)
    const stateDirFail = databaseDir()

    const origPrepare = DatabaseSync.prototype.prepare
    const origExec = DatabaseSync.prototype.exec
    let injectionOccurred = false
    let armed = false

    const checkStateAndThrow = (db: DatabaseSync, sqlHint?: string): void => {
      if (injectionOccurred) return
      const stack = new Error().stack || ''
      if (/\b(?:openStore|migrate)\b/.test(stack)) {
        return
      }
      armed = true

      const _isPhaseHint = sqlHint ? /phases\b/i.test(sqlHint) : false

      try {
        const pRow = origPrepare.call(db, 'SELECT COUNT(*) AS cnt FROM projects').get() as { cnt: number } | undefined
        const phRow = origPrepare.call(db, 'SELECT COUNT(*) AS cnt FROM phases').get() as { cnt: number } | undefined
        const projectCount = pRow?.cnt ?? 0
        const phaseCount = phRow?.cnt ?? 0
        if (projectCount >= 1 && phaseCount >= 1) {
          injectionOccurred = true
          throw new Error('injected init failure')
        }
      } catch (err: any) {
        if (err?.message === 'injected init failure') {
          throw err
        }
      }
    }

    DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
      if (injectionOccurred) {
        return origPrepare.call(this, sql)
      }
      const stmt = origPrepare.call(this, sql)
      const db = this
      const wrapMethod = <T extends (...args: any[]) => any>(origFn: T): T => {
        return function (this: any, ...args: any[]) {
          const res = origFn.apply(this, args)
          if (!injectionOccurred) {
            checkStateAndThrow(db, sql)
          }
          return res
        } as T
      }
      stmt.run = wrapMethod(stmt.run)
      stmt.get = wrapMethod(stmt.get)
      stmt.all = wrapMethod(stmt.all)
      return stmt
    }

    DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
      if (injectionOccurred) {
        return origExec.call(this, sql)
      }
      const res = origExec.call(this, sql)
      checkStateAndThrow(this, sql)
      return res
    }

    try {
      expect(() => {
        init(stateDirFail, repoDirFail)
      }).toThrow('injected init failure')
    } finally {
      DatabaseSync.prototype.prepare = origPrepare
      DatabaseSync.prototype.exec = origExec
    }

    expect(injectionOccurred, 'failure must be injected after at least one phase row was inserted').toBe(true)

    const checkFailDb = new DatabaseSync(join(stateDirFail, 'state.sqlite'))
    try {
      const projectCount = checkFailDb.prepare('SELECT COUNT(*) AS cnt FROM projects').get() as { cnt: number }
      expect(projectCount.cnt, 'no project must remain after failed init transaction').toBe(0)

      const phaseCount = checkFailDb.prepare('SELECT COUNT(*) AS cnt FROM phases').get() as { cnt: number }
      expect(phaseCount.cnt, 'no phases must remain after failed init transaction').toBe(0)

      const configCount = checkFailDb.prepare('SELECT COUNT(*) AS cnt FROM project_config').get() as { cnt: number }
      expect(configCount.cnt, 'no project_config must remain after failed init transaction').toBe(0)
    } finally {
      checkFailDb.close()
    }
  })

  it('CHK-M5-03-d: status on a v7 DB with M4-shaped data gives the M4 output with schemaVersion 7', async () => {
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
          phases: [],
          schemaVersion: 8,
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
              phase: 'intake',
              dependsOn: [],
              waiting: null,
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
          github: null,
        }

        const status = readStatus(dir, { nowMs: 2000, staleAfterMs: 500 }) as unknown as Record<string, unknown>
        expect(status).toEqual(expectedStatus)

        const arabic = formatStatus(status as unknown as Status)
        expect(arabic).toContain('إصدار المخطط: 8')
        expect(arabic).toContain('عدد الأوامر المسجلة: 6')
        expect(arabic).toContain('Example task')
        expect(arabic).toContain('task-one')
        expect(arabic).toContain('12345')
        expect(arabic).toContain('head-sha')
        expect(arabic).toContain('src/a.ts')
        expect(arabic).not.toContain('private-payload')
        expect(arabic).not.toContain('nonce-1')

        const cliPath = join(process.cwd(), 'supervisor/src/cli/main.ts')
        const cliResult = spawnSync(process.execPath, [cliPath, 'status', '--state-dir', dir, '--json'], {
          encoding: 'utf8',
          timeout: 10000,
        })
        expect(cliResult.status).toBe(0)
        const cliJson = JSON.parse(cliResult.stdout)
        expect(Object.keys(cliJson).sort()).toEqual(['commands', 'github', 'lease', 'outbox', 'phases', 'recordedCommandCount', 'schemaVersion', 'tasks'].sort())
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
