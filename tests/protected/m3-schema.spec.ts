import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendCommand } from '../../supervisor/src/app/commands.ts'
import { formatStatus, readStatus } from '../../supervisor/src/app/status.ts'
import { openStore } from '../../supervisor/src/app/store.ts'
import { acquireSupervisor } from '../../supervisor/src/app/supervisor-lease.ts'

const directories: string[] = []
function databaseDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'factory-m3-schema-'))
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
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('M3-01 Schema v5 contract', () => {
  it('CHK-M3-01-a: fresh DB reaches v5 with all tables, foreign keys and WAL enabled', () => {
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
      ]
      for (const table of expectedTables) {
        const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
        expect(row, `expected table ${table} to exist`).toBeDefined()
      }

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

  it('CHK-M3-01-a: upgrades a v4 DB with projects, commands and lease to v5 with all rows intact and idempotent reopen', () => {
    const path = databasePath()
    const old = new DatabaseSync(path)
    old.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX projects_name_idx ON projects(name);
      CREATE TABLE commands (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TRIGGER commands_no_update BEFORE UPDATE ON commands BEGIN SELECT RAISE(ABORT, 'commands are append-only'); END;
      CREATE TRIGGER commands_no_delete BEFORE DELETE ON commands BEGIN SELECT RAISE(ABORT, 'commands are append-only'); END;
      CREATE TRIGGER commands_no_replace BEFORE INSERT ON commands WHEN EXISTS (SELECT 1 FROM commands WHERE id = NEW.id) BEGIN SELECT RAISE(IGNORE); END;
      CREATE TABLE supervisor_lease (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        owner_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        heartbeat_ms INTEGER NOT NULL CHECK (heartbeat_ms >= 0),
        status TEXT NOT NULL CHECK (status IN ('active', 'released'))
      );
      INSERT INTO projects VALUES ('p1', 'Alpha', '2026-01-01T00:00:00.000Z');
      INSERT INTO commands VALUES ('c1', 'p1', 'task.create', '{"title":"T1"}', '2026-01-01T00:00:00.000Z');
      INSERT INTO supervisor_lease VALUES (1, 'owner-m2', 2, 5000, 'active');
      PRAGMA user_version = 4;
    `)
    old.close()

    for (let attempt = 0; attempt < 2; attempt++) {
      const db = openStore(path)
      try {
        expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 8 })
        expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 })
        expect(db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' })
        expect(db.prepare('SELECT name FROM projects WHERE id = ?').get('p1')).toMatchObject({ name: 'Alpha' })
        expect(db.prepare('SELECT kind, payload_json FROM commands WHERE id = ?').get('c1')).toMatchObject({
          kind: 'task.create',
          payload_json: '{"title":"T1"}',
        })
        expect(db.prepare('SELECT owner_id, generation, heartbeat_ms, status FROM supervisor_lease WHERE id = 1').get()).toMatchObject({
          owner_id: 'owner-m2',
          generation: 2,
          heartbeat_ms: 5000,
          status: 'active',
        })

        if (attempt === 0) {
          db.prepare(
            "INSERT INTO project_config (project_id, repo_path, base_ref, created_at) VALUES ('p1', '/repo', 'main', '2026-11-10T00:00:00.000Z')",
          ).run()
          db.prepare(
            "INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES ('t1', 'p1', 'c1', 'Task 1', 'ready', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')",
          ).run()
        } else {
          expect(db.prepare('SELECT repo_path FROM project_config WHERE project_id = ?').get('p1')).toMatchObject({ repo_path: '/repo' })
          expect(db.prepare('SELECT title, status FROM tasks WHERE id = ?').get('t1')).toMatchObject({ title: 'Task 1', status: 'ready' })
        }
      } finally {
        db.close()
      }
    }
  })

  it('CHK-M3-01-b: rolls back failed migration 5 leaving DB at v4 with no v5 tables', () => {
    const path = databasePath()
    const old = new DatabaseSync(path)
    old.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX projects_name_idx ON projects(name);
      CREATE TABLE commands (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TRIGGER commands_no_update BEFORE UPDATE ON commands BEGIN SELECT RAISE(ABORT, 'commands are append-only'); END;
      CREATE TRIGGER commands_no_delete BEFORE DELETE ON commands BEGIN SELECT RAISE(ABORT, 'commands are append-only'); END;
      CREATE TRIGGER commands_no_replace BEFORE INSERT ON commands WHEN EXISTS (SELECT 1 FROM commands WHERE id = NEW.id) BEGIN SELECT RAISE(IGNORE); END;
      CREATE TABLE supervisor_lease (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        owner_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        heartbeat_ms INTEGER NOT NULL CHECK (heartbeat_ms >= 0),
        status TEXT NOT NULL CHECK (status IN ('active', 'released'))
      );
      INSERT INTO projects VALUES ('p1', 'Alpha', '2026-01-01T00:00:00.000Z');
      INSERT INTO commands VALUES ('c1', 'p1', 'task.create', '{"title":"T1"}', '2026-01-01T00:00:00.000Z');
      INSERT INTO supervisor_lease VALUES (1, 'owner-m2', 1, 1000, 'active');
      PRAGMA user_version = 4;
    `)
    old.close()

    let firstCreateSucceeded = false
    let injectionOccurred = false
    const origExec = DatabaseSync.prototype.exec

    DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
      if (this.isTransaction && /CREATE/i.test(sql)) {
        if (firstCreateSucceeded && !injectionOccurred) {
          injectionOccurred = true
          throw new Error('injected migration-5 failure')
        }
        const result = origExec.call(this, sql)
        firstCreateSucceeded = true
        return result
      }
      return origExec.call(this, sql)
    }

    let unexpectedDb: DatabaseSync | undefined
    try {
      expect(() => {
        unexpectedDb = openStore(path)
      }).toThrow('injected migration-5 failure')
    } finally {
      unexpectedDb?.close()
      DatabaseSync.prototype.exec = origExec
    }

    expect(injectionOccurred, 'migration failure must be injected after an observed successful first migration statement').toBe(true)

    const check = new DatabaseSync(path)
    try {
      expect(check.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 4 })
      expect(check.prepare('SELECT name FROM projects WHERE id = ?').get('p1')).toMatchObject({ name: 'Alpha' })
      expect(check.prepare('SELECT kind FROM commands WHERE id = ?').get('c1')).toMatchObject({ kind: 'task.create' })
      expect(check.prepare('SELECT owner_id FROM supervisor_lease WHERE id = 1').get()).toMatchObject({ owner_id: 'owner-m2' })

      const v5TableNames = ['project_config', 'command_outcomes', 'tasks', 'attempts', 'workers', 'outbox', 'evidence']
      for (const name of v5TableNames) {
        expect(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)).toBeUndefined()
      }
    } finally {
      check.close()
    }
  })

  it('CHK-M3-01-b: refuses a v8 database unmodified', () => {
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
      }).toThrow('store: unsupported schema version 9')
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

  it('CHK-M3-01-b: rejects a future version observed after the initial check', () => {
    const path = databasePath()
    let simulatedVersionChangeOccurred = false
    const origExec = DatabaseSync.prototype.exec

    const commitV8 = () => {
      if (simulatedVersionChangeOccurred) return
      simulatedVersionChangeOccurred = true
      const second = new DatabaseSync(path)
      try {
        origExec.call(second, 'PRAGMA user_version = 9')
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
      }).toThrow(/unsupported schema version 9/i)
    } finally {
      unexpectedDb?.close()
      DatabaseSync.prototype.exec = origExec
    }

    expect(simulatedVersionChangeOccurred).toBe(true)

    const check = new DatabaseSync(path)
    try {
      expect(check.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 9 })
      const v5TableNames = ['project_config', 'command_outcomes', 'tasks', 'attempts', 'workers', 'outbox', 'evidence']
      for (const name of v5TableNames) {
        expect(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)).toBeUndefined()
      }
    } finally {
      check.close()
    }
  })

  it('CHK-M3-01-c: rejects a second pending|running attempt for one task', () => {
    const path = databasePath()
    const db = openStore(path)
    try {
      db.prepare("INSERT INTO projects VALUES ('p1', 'Alpha', '2026-11-10T00:00:00.000Z')").run()
      db.prepare("INSERT INTO commands VALUES ('c1', 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run()
      db.prepare("INSERT INTO commands VALUES ('c2', 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run()
      db.prepare(
        "INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES ('t1', 'p1', 'c1', 'T1', 'ready', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')",
      ).run()
      db.prepare(
        "INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES ('t2', 'p1', 'c2', 'T2', 'ready', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')",
      ).run()

      const insertAttempt = db.prepare(
        'INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )

      insertAttempt.run('a1', 't1', 1, 'pending', null, null, 1, '2026-11-10T00:00:00.000Z', null)

      // Duplicate pending attempt for the same task fails
      expect(() => {
        insertAttempt.run('a2', 't1', 2, 'pending', null, null, 1, '2026-11-10T00:00:01.000Z', null)
      }).toThrow(/UNIQUE constraint failed/i)

      // Running attempt for the same task fails while one is pending
      expect(() => {
        insertAttempt.run('a2', 't1', 2, 'running', null, null, 1, '2026-11-10T00:00:01.000Z', null)
      }).toThrow(/UNIQUE constraint failed/i)

      // Pending attempt for a different task succeeds
      expect(() => {
        insertAttempt.run('a-other', 't2', 1, 'pending', null, null, 1, '2026-11-10T00:00:00.000Z', null)
      }).not.toThrow()

      // Transition a1 to running: still blocks new pending or running attempts
      db.prepare("UPDATE attempts SET status = 'running' WHERE id = 'a1'").run()
      expect(() => {
        insertAttempt.run('a2', 't1', 2, 'pending', null, null, 1, '2026-11-10T00:00:01.000Z', null)
      }).toThrow(/UNIQUE constraint failed/i)
      expect(() => {
        insertAttempt.run('a2', 't1', 2, 'running', null, null, 1, '2026-11-10T00:00:01.000Z', null)
      }).toThrow(/UNIQUE constraint failed/i)

      // Transition a1 to terminal status: failed
      db.prepare("UPDATE attempts SET status = 'failed', ended_at = '2026-11-10T00:01:00.000Z' WHERE id = 'a1'").run()

      // Now a new pending attempt for t1 succeeds
      expect(() => {
        insertAttempt.run('a2', 't1', 2, 'pending', null, null, 1, '2026-11-10T00:01:01.000Z', null)
      }).not.toThrow()

      // Updating terminal attempt back to running while another is pending fails
      expect(() => {
        db.prepare("UPDATE attempts SET status = 'running' WHERE id = 'a1'").run()
      }).toThrow(/UNIQUE constraint failed/i)

      // Duplicate (task_id, attempt_no) fails
      expect(() => {
        insertAttempt.run('a3', 't1', 2, 'succeeded', 0, null, 1, '2026-11-10T00:02:00.000Z', '2026-11-10T00:02:01.000Z')
      }).toThrow(/UNIQUE constraint failed/i)
    } finally {
      db.close()
    }
  })

  it('CHK-M3-01-c: rejects duplicate tasks.created_by_command and duplicate outbox.idempotency_key', () => {
    const path = databasePath()
    const db = openStore(path)
    try {
      db.prepare("INSERT INTO projects VALUES ('p1', 'Alpha', '2026-11-10T00:00:00.000Z')").run()
      db.prepare("INSERT INTO commands VALUES ('c1', 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run()

      db.prepare(
        "INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES ('t1', 'p1', 'c1', 'Task 1', 'ready', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')",
      ).run()

      expect(() => {
        db.prepare(
          "INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES ('t2', 'p1', 'c1', 'Task 2', 'ready', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')",
        ).run()
      }).toThrow(/UNIQUE constraint failed/i)

      db.prepare(
        "INSERT INTO outbox (id, idempotency_key, kind, payload_json, status, tries, next_attempt_ms, last_error, created_at, updated_at) VALUES ('o1', 'idem-1', 'attempt.start', '{}', 'pending', 0, 0, null, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')",
      ).run()

      expect(() => {
        db.prepare(
          "INSERT INTO outbox (id, idempotency_key, kind, payload_json, status, tries, next_attempt_ms, last_error, created_at, updated_at) VALUES ('o2', 'idem-1', 'attempt.start', '{}', 'pending', 0, 0, null, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')",
        ).run()
      }).toThrow(/UNIQUE constraint failed/i)
    } finally {
      db.close()
    }
  })

  it('CHK-M3-01-c: enforces primary-key uniqueness on command_outcomes, evidence, workers, project_config, and outbox', () => {
    const path = databasePath()
    const db = openStore(path)
    try {
      db.prepare("INSERT INTO projects VALUES ('p1', 'Alpha', '2026-11-10T00:00:00.000Z')").run()
      db.prepare("INSERT INTO commands VALUES ('c1', 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run()
      db.prepare("INSERT INTO commands VALUES ('c2', 'p1', 'task.create', '{}', '2026-11-10T00:00:01.000Z')").run()
      db.prepare(
        "INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES ('t1', 'p1', 'c1', 'Task 1', 'ready', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')",
      ).run()
      db.prepare(
        "INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES ('t2', 'p1', 'c2', 'Task 2', 'ready', '2026-11-10T00:00:01.000Z', '2026-11-10T00:00:01.000Z')",
      ).run()
      db.prepare(
        "INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at) VALUES ('a1', 't1', 1, 'running', null, null, 1, '2026-11-10T00:00:00.000Z', null)",
      ).run()
      db.prepare(
        "INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at) VALUES ('a2', 't2', 1, 'succeeded', 0, null, 1, '2026-11-10T00:00:01.000Z', '2026-11-10T00:01:00.000Z')",
      ).run()

      // 1. project_config.project_id
      db.prepare(
        "INSERT INTO project_config (project_id, repo_path, base_ref, created_at) VALUES ('p1', '/repo-1', 'main', '2026-11-10T00:00:00.000Z')",
      ).run()
      expect(() => {
        db.prepare(
          "INSERT INTO project_config (project_id, repo_path, base_ref, created_at) VALUES ('p1', '/repo-2', 'feature', '2026-11-10T00:01:00.000Z')",
        ).run()
      }).toThrow(/UNIQUE constraint failed/i)
      const configRows = db.prepare('SELECT * FROM project_config WHERE project_id = ?').all('p1')
      expect(configRows).toHaveLength(1)
      expect(configRows[0]).toMatchObject({ project_id: 'p1', repo_path: '/repo-1' })

      // 2. command_outcomes.command_id
      db.prepare(
        "INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at) VALUES ('c1', 'applied', null, 1, '2026-11-10T00:00:00.000Z')",
      ).run()
      expect(() => {
        db.prepare(
          "INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at) VALUES ('c1', 'rejected', 'conflict', 2, '2026-11-10T00:01:00.000Z')",
        ).run()
      }).toThrow(/UNIQUE constraint failed/i)
      const outcomeRows = db.prepare('SELECT * FROM command_outcomes WHERE command_id = ?').all('c1')
      expect(outcomeRows).toHaveLength(1)
      expect(outcomeRows[0]).toMatchObject({ command_id: 'c1', outcome: 'applied' })

      // 3. workers.attempt_id (distinct secondary unique nonce)
      db.prepare(
        "INSERT INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at, ended_at) VALUES ('a1', 'nonce-1', 101, 'running', '/wt1', 1000, '2026-11-10T00:00:00.000Z', null)",
      ).run()
      expect(() => {
        db.prepare(
          "INSERT INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at, ended_at) VALUES ('a1', 'nonce-2', 102, 'starting', '/wt2', 2000, '2026-11-10T00:01:00.000Z', null)",
        ).run()
      }).toThrow(/UNIQUE constraint failed/i)
      const workerRows = db.prepare('SELECT * FROM workers WHERE attempt_id = ?').all('a1')
      expect(workerRows).toHaveLength(1)
      expect(workerRows[0]).toMatchObject({ attempt_id: 'a1', nonce: 'nonce-1' })

      // 4. evidence.attempt_id
      db.prepare(
        "INSERT INTO evidence (attempt_id, base_sha, head_sha, files_json, stdout_sha256, stderr_sha256, recorded_at) VALUES ('a2', 'base1', 'head1', '[]', 'out1', 'err1', '2026-11-10T00:01:00.000Z')",
      ).run()
      expect(() => {
        db.prepare(
          "INSERT INTO evidence (attempt_id, base_sha, head_sha, files_json, stdout_sha256, stderr_sha256, recorded_at) VALUES ('a2', 'base2', 'head2', '[]', 'out2', 'err2', '2026-11-10T00:02:00.000Z')",
        ).run()
      }).toThrow(/UNIQUE constraint failed/i)
      const evidenceRows = db.prepare('SELECT * FROM evidence WHERE attempt_id = ?').all('a2')
      expect(evidenceRows).toHaveLength(1)
      expect(evidenceRows[0]).toMatchObject({ attempt_id: 'a2', head_sha: 'head1' })

      // 5. outbox.id (distinct secondary unique idempotency_key)
      db.prepare(
        "INSERT INTO outbox (id, idempotency_key, kind, payload_json, status, tries, next_attempt_ms, last_error, created_at, updated_at) VALUES ('o1', 'idem-1', 'attempt.start', '{}', 'pending', 0, 0, null, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')",
      ).run()
      expect(() => {
        db.prepare(
          "INSERT INTO outbox (id, idempotency_key, kind, payload_json, status, tries, next_attempt_ms, last_error, created_at, updated_at) VALUES ('o1', 'idem-2', 'attempt.start', '{}', 'pending', 0, 0, null, '2026-11-10T00:01:00.000Z', '2026-11-10T00:01:00.000Z')",
        ).run()
      }).toThrow(/UNIQUE constraint failed/i)
      const outboxRows = db.prepare('SELECT * FROM outbox WHERE id = ?').all('o1')
      expect(outboxRows).toHaveLength(1)
      expect(outboxRows[0]).toMatchObject({ id: 'o1', idempotency_key: 'idem-1' })
    } finally {
      db.close()
    }
  })

  it('CHK-M3-01-c: rejects UPDATE and DELETE on command_outcomes and evidence', () => {
    const path = databasePath()
    const db = openStore(path)
    try {
      db.prepare("INSERT INTO projects VALUES ('p1', 'Alpha', '2026-11-10T00:00:00.000Z')").run()
      db.prepare("INSERT INTO commands VALUES ('c1', 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run()
      db.prepare(
        "INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES ('t1', 'p1', 'c1', 'T1', 'ready', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')",
      ).run()
      db.prepare(
        "INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at) VALUES ('a1', 't1', 1, 'succeeded', 0, null, 1, '2026-11-10T00:00:00.000Z', '2026-11-10T00:01:00.000Z')",
      ).run()

      db.prepare("INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at) VALUES ('c1', 'applied', null, 1, '2026-11-10T00:00:00.000Z')").run()
      expect(() => {
        db.prepare("UPDATE command_outcomes SET outcome = 'rejected' WHERE command_id = 'c1'").run()
      }).toThrow()
      expect(() => {
        db.prepare("DELETE FROM command_outcomes WHERE command_id = 'c1'").run()
      }).toThrow()

      db.prepare(
        "INSERT INTO evidence (attempt_id, base_sha, head_sha, files_json, stdout_sha256, stderr_sha256, recorded_at) VALUES ('a1', 'base', 'head', '[]', 'out', 'err', '2026-11-10T00:01:00.000Z')",
      ).run()
      expect(() => {
        db.prepare("UPDATE evidence SET head_sha = 'head2' WHERE attempt_id = 'a1'").run()
      }).toThrow()
      expect(() => {
        db.prepare("DELETE FROM evidence WHERE attempt_id = 'a1'").run()
      }).toThrow()
    } finally {
      db.close()
    }
  })

  it('CHK-M3-01-c: enforces foreign key relationships independently and workers.nonce uniqueness', () => {
    const path = databasePath()
    const db = openStore(path)
    try {
      db.prepare("INSERT INTO projects VALUES ('p1', 'Alpha', '2026-11-10T00:00:00.000Z')").run()
      db.prepare("INSERT INTO commands VALUES ('c1', 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run()
      db.prepare(
        "INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES ('t1', 'p1', 'c1', 'Task 1', 'ready', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')",
      ).run()
      db.prepare(
        "INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at) VALUES ('a1', 't1', 1, 'running', null, null, 1, '2026-11-10T00:00:00.000Z', null)",
      ).run()

      // 1. project_config.project_id -> projects(id)
      expect(() => {
        db.prepare(
          "INSERT INTO project_config (project_id, repo_path, base_ref, created_at) VALUES ('missing-p', '/repo', 'main', '2026-11-10T00:00:00.000Z')",
        ).run()
      }).toThrow(/FOREIGN KEY/i)
      expect(() => {
        db.prepare(
          "INSERT INTO project_config (project_id, repo_path, base_ref, created_at) VALUES ('p1', '/repo', 'main', '2026-11-10T00:00:00.000Z')",
        ).run()
      }).not.toThrow()

      // 2. tasks.project_id -> projects(id) independently (valid created_by_command, invalid project_id)
      db.prepare("INSERT INTO commands VALUES ('c2', 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run()
      expect(() => {
        db.prepare(
          "INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES ('t2-bad-p', 'missing-p', 'c2', 'Title', 'ready', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')",
        ).run()
      }).toThrow(/FOREIGN KEY/i)

      // 3. tasks.created_by_command -> commands(id) independently (valid project_id, invalid created_by_command)
      expect(() => {
        db.prepare(
          "INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES ('t2-bad-c', 'p1', 'missing-c', 'Title', 'ready', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')",
        ).run()
      }).toThrow(/FOREIGN KEY/i)

      // 4. command_outcomes.command_id -> commands(id) independently
      expect(() => {
        db.prepare(
          "INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at) VALUES ('missing-c', 'applied', null, 1, '2026-11-10T00:00:00.000Z')",
        ).run()
      }).toThrow(/FOREIGN KEY/i)

      // 5. attempts.task_id -> tasks(id) independently
      expect(() => {
        db.prepare(
          "INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at) VALUES ('a-bad-t', 'missing-t', 1, 'pending', null, null, 1, '2026-11-10T00:00:00.000Z', null)",
        ).run()
      }).toThrow(/FOREIGN KEY/i)

      // 6. workers.attempt_id -> attempts(id) independently
      expect(() => {
        db.prepare(
          "INSERT INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at, ended_at) VALUES ('missing-a', 'nonce-probe', 100, 'starting', '/wt', 1000, '2026-11-10T00:00:00.000Z', null)",
        ).run()
      }).toThrow(/FOREIGN KEY/i)

      // 7. evidence.attempt_id -> attempts(id) independently
      expect(() => {
        db.prepare(
          "INSERT INTO evidence (attempt_id, base_sha, head_sha, files_json, stdout_sha256, stderr_sha256, recorded_at) VALUES ('missing-a', 'b', 'h', '[]', 'out', 'err', '2026-11-10T00:00:00.000Z')",
        ).run()
      }).toThrow(/FOREIGN KEY/i)

      // 8. workers.nonce uniqueness across distinct attempts
      db.prepare("INSERT INTO commands VALUES ('c-w2', 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run()
      db.prepare(
        "INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES ('t-w2', 'p1', 'c-w2', 'Task W2', 'ready', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')",
      ).run()
      db.prepare(
        "INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at) VALUES ('a-w2', 't-w2', 1, 'running', null, null, 1, '2026-11-10T00:00:00.000Z', null)",
      ).run()

      db.prepare(
        "INSERT INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at, ended_at) VALUES ('a1', 'shared-nonce', 101, 'running', '/wt1', 1000, '2026-11-10T00:00:00.000Z', null)",
      ).run()

      expect(() => {
        db.prepare(
          "INSERT INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at, ended_at) VALUES ('a-w2', 'shared-nonce', 102, 'running', '/wt2', 1000, '2026-11-10T00:00:00.000Z', null)",
        ).run()
      }).toThrow(/UNIQUE constraint failed/i)
    } finally {
      db.close()
    }
  })

  it('CHK-M3-01-c: rejects unknown status and state values across all v5 tables', () => {
    const path = databasePath()
    const db = openStore(path)
    try {
      db.prepare("INSERT INTO projects VALUES ('p1', 'Alpha', '2026-11-10T00:00:00.000Z')").run()
      db.prepare("INSERT INTO commands VALUES ('c1', 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run()

      // tasks: progress|waiting|ready|blocked|failed|dropped|done
      for (const valid of ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped', 'done']) {
        const id = `t-${valid}`
        const cmdId = `c-${valid}`
        db.prepare("INSERT INTO commands VALUES (?, 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run(cmdId)
        db.prepare(
          'INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(id, 'p1', cmdId, 'Task', valid, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')
        expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get(id)).toMatchObject({ status: valid })
      }
      expect(() => {
        db.prepare(
          "INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES ('t-bad', 'p1', 'c1', 'Task', 'invalid-status', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')",
        ).run()
      }).toThrow(/CHECK constraint failed/i)

      // attempts: pending|running|succeeded|failed|interrupted|killed (separate task per attempt to respect partial unique index)
      let attemptNoCounter = 1
      for (const valid of ['pending', 'running', 'succeeded', 'failed', 'interrupted', 'killed']) {
        const taskId = `t-att-task-${valid}`
        const cmdId = `c-att-task-${valid}`
        db.prepare("INSERT INTO commands VALUES (?, 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run(cmdId)
        db.prepare(
          'INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(taskId, 'p1', cmdId, 'Task', 'ready', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')

        const id = `a-${valid}`
        db.prepare(
          'INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(id, taskId, attemptNoCounter++, valid, 0, null, 1, '2026-11-10T00:00:00.000Z', '2026-11-10T00:01:00.000Z')
        expect(db.prepare('SELECT status FROM attempts WHERE id = ?').get(id)).toMatchObject({ status: valid })
      }
      expect(() => {
        db.prepare(
          "INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at) VALUES ('a-bad', 't-ready', 999, 'invalid-status', 0, null, 1, '2026-11-10T00:00:00.000Z', '2026-11-10T00:01:00.000Z')",
        ).run()
      }).toThrow(/CHECK constraint failed/i)

      // workers: starting|running|exited|killed|lost (separate task and attempt per worker)
      let workerAttemptCounter = 100
      for (const valid of ['starting', 'running', 'exited', 'killed', 'lost']) {
        const taskId = `t-w-task-${valid}`
        const cmdId = `c-w-task-${valid}`
        const attemptId = `a-w-att-${valid}`
        db.prepare("INSERT INTO commands VALUES (?, 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run(cmdId)
        db.prepare(
          'INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(taskId, 'p1', cmdId, 'Task', 'ready', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')
        db.prepare(
          'INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(attemptId, taskId, workerAttemptCounter++, 'running', null, null, 1, '2026-11-10T00:00:00.000Z', null)

        db.prepare(
          'INSERT INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(attemptId, `nonce-${valid}`, 1234, valid, '/wt', 1000, '2026-11-10T00:00:00.000Z', null)
        expect(db.prepare('SELECT state FROM workers WHERE attempt_id = ?').get(attemptId)).toMatchObject({ state: valid })
      }

      // Invalid worker state with an unused valid attempt and fresh nonce
      const invalidWorkerTaskId = 't-w-invalid'
      const invalidWorkerCmdId = 'c-w-invalid'
      const invalidWorkerAttemptId = 'a-w-invalid'
      db.prepare("INSERT INTO commands VALUES (?, 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run(invalidWorkerCmdId)
      db.prepare(
        'INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(invalidWorkerTaskId, 'p1', invalidWorkerCmdId, 'Task', 'ready', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')
      db.prepare(
        'INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(invalidWorkerAttemptId, invalidWorkerTaskId, 9999, 'running', null, null, 1, '2026-11-10T00:00:00.000Z', null)

      expect(() => {
        db.prepare(
          "INSERT INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at, ended_at) VALUES (?, 'nonce-invalid-test', 1234, 'invalid-state', '/wt', 1000, '2026-11-10T00:00:00.000Z', null)",
        ).run(invalidWorkerAttemptId)
      }).toThrow(/CHECK constraint failed/i)

      // outbox: pending|done|failed
      for (const valid of ['pending', 'done', 'failed']) {
        const id = `o-${valid}`
        db.prepare(
          'INSERT INTO outbox (id, idempotency_key, kind, payload_json, status, tries, next_attempt_ms, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(id, `key-${valid}`, 'attempt.start', '{}', valid, 0, 0, null, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')
        expect(db.prepare('SELECT status FROM outbox WHERE id = ?').get(id)).toMatchObject({ status: valid })
      }
      expect(() => {
        db.prepare(
          "INSERT INTO outbox (id, idempotency_key, kind, payload_json, status, tries, next_attempt_ms, last_error, created_at, updated_at) VALUES ('o-bad', 'key-bad', 'attempt.start', '{}', 'invalid-status', 0, 0, null, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')",
        ).run()
      }).toThrow(/CHECK constraint failed/i)

      // command_outcomes: applied|rejected
      for (const valid of ['applied', 'rejected']) {
        const cmdId = `c-outcome-${valid}`
        db.prepare("INSERT INTO commands VALUES (?, 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run(cmdId)
        db.prepare(
          'INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at) VALUES (?, ?, ?, ?, ?)',
        ).run(cmdId, valid, null, 1, '2026-11-10T00:00:00.000Z')
        expect(db.prepare('SELECT outcome FROM command_outcomes WHERE command_id = ?').get(cmdId)).toMatchObject({ outcome: valid })
      }
      const badCmdId = 'c-outcome-bad'
      db.prepare("INSERT INTO commands VALUES (?, 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run(badCmdId)
      expect(() => {
        db.prepare(
          "INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at) VALUES (?, 'invalid-outcome', null, 1, '2026-11-10T00:00:00.000Z')",
        ).run(badCmdId)
      }).toThrow(/CHECK constraint failed/i)
    } finally {
      db.close()
    }
  })

  it('CHK-M3-01-e: status reads a v5 DB with output identical to M2 expectations for the same data', () => {
    const m2Lease = (lease: ReturnType<typeof readStatus>['lease']) => lease === null ? null : ({
      ownerId: lease.ownerId,
      generation: lease.generation,
      heartbeatMs: lease.heartbeatMs,
      state: lease.state,
      freshness: lease.freshness,
    })
    const m2Status = (status: ReturnType<typeof readStatus>) => ({
      schemaVersion: status.schemaVersion,
      recordedCommandCount: status.recordedCommandCount,
      lease: m2Lease(status.lease),
    })
    const dir = databaseDir()
    const path = join(dir, 'state.sqlite')
    const db = openStore(path)
    try {
      db.prepare("INSERT INTO projects VALUES ('p1', 'Project', '2026-11-10T00:00:00.000Z')").run()
      appendCommand(db, {
        id: 'c1',
        projectId: 'p1',
        kind: 'task.create',
        payloadJson: '{"secret":"never-disclosed"}',
        createdAt: '2026-11-10T00:00:00.000Z',
      })
      appendCommand(db, {
        id: 'c2',
        projectId: 'p1',
        kind: 'task.create',
        payloadJson: '{"title":"T2"}',
        createdAt: '2026-11-10T00:00:01.000Z',
      })

      // 1. Status with no lease
      const beforeHash = fileHash(path)
      const noLeaseStatus = readStatus(dir, { nowMs: 2000, staleAfterMs: 500 })
      expect(fileHash(path)).toBe(beforeHash)
      expect(m2Status(noLeaseStatus)).toEqual({
        schemaVersion: 8,
        recordedCommandCount: 2,
        lease: null,
      })
      const noLeaseArabic = formatStatus(noLeaseStatus)
      expect(noLeaseArabic).toContain('إصدار المخطط: 8')
      expect(noLeaseArabic).toContain('عدد الأوامر المسجلة: 2')
      expect(noLeaseArabic).toContain('الملكية: غير موجود')

      // 2. Status with active lease
      const handle = acquireSupervisor(db, dir, { nowMs: 1800, staleAfterMs: 500 })
      try {
        const activeStatus = readStatus(dir, { nowMs: 2000, staleAfterMs: 500 })
        expect(m2Status(activeStatus)).toEqual({
          schemaVersion: 8,
          recordedCommandCount: 2,
          lease: {
            ownerId: handle.ownerId,
            generation: handle.generation,
            heartbeatMs: 1800,
            state: 'active',
            freshness: 'fresh',
          },
        })
        expect(JSON.stringify(activeStatus)).not.toContain('never-disclosed')

        const activeArabic = formatStatus(activeStatus)
        expect(activeArabic).toContain('إصدار المخطط: 8')
        expect(activeArabic).toContain('عدد الأوامر المسجلة: 2')
        expect(activeArabic).toContain(
          `الملكية: المالك="${handle.ownerId}", الجيل=${handle.generation}, وقت النبض (Unix timestamp)=1800 ميلي ثانية, الحالة=نشط, حداثة النبض=حديث (لا يشكل دليلاً على أن العملية قيد التشغيل)`,
        )
        expect(activeArabic).not.toContain('never-disclosed')

        // 3. Status with stale heartbeat
        const staleStatus = readStatus(dir, { nowMs: 2500, staleAfterMs: 500 })
        expect(staleStatus.lease?.freshness).toBe('stale')
        expect(formatStatus(staleStatus)).toContain('حداثة النبض=قديم')

        // 4. Status with released lease
        handle.release(2100)
        const releasedStatus = readStatus(dir, { nowMs: 2200, staleAfterMs: 500 })
        expect(m2Lease(releasedStatus.lease)).toEqual({
          ownerId: handle.ownerId,
          generation: handle.generation,
          heartbeatMs: 1800,
          state: 'released',
          freshness: 'not-applicable',
        })
        const releasedArabic = formatStatus(releasedStatus)
        expect(releasedArabic).toContain('الحالة=مُحرَّر')
        expect(releasedArabic).toContain('حداثة النبض=غير منطبق (تم تحرير الملكية)')
      } finally {
        try {
          handle.release(2300)
        } catch {
          // already released
        }
      }
    } finally {
      db.close()
    }
  })
})
