import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { appendCommand } from '../../supervisor/src/app/commands.ts'
import { applyPendingCommands } from '../../supervisor/src/app/apply-commands.ts'
import { acquireSupervisor } from '../../supervisor/src/app/supervisor-lease.ts'
import { enqueue, runDue } from '../../supervisor/src/app/outbox.ts'
import { formatStatus, readStatus, type Status } from '../../supervisor/src/app/status.ts'
import { openStore } from '../../supervisor/src/app/store.ts'

const ASCII_WHITESPACE = 'char(32, 9, 10, 13, 12, 11)'

const V8_DDL = [
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
    not_before_ms INTEGER NOT NULL DEFAULT 0 CHECK (not_before_ms >= 0),
    phase TEXT NOT NULL DEFAULT 'intake' CHECK (phase IN ('intake','development','qa','devops','handover'))
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
  `CREATE TABLE phases (project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL CHECK (name IN ('intake','development','qa','devops','handover')), ord INTEGER NOT NULL CHECK (ord BETWEEN 1 AND 5), status TEXT NOT NULL CHECK (status IN ('locked','open','done')), opened_at TEXT, closed_at TEXT, PRIMARY KEY (project_id, name), UNIQUE (project_id, ord), CHECK (ord = CASE name WHEN 'intake' THEN 1 WHEN 'development' THEN 2 WHEN 'qa' THEN 3 WHEN 'devops' THEN 4 WHEN 'handover' THEN 5 END))`,
  `CREATE UNIQUE INDEX phases_one_open ON phases(project_id) WHERE status = 'open'`,
  `CREATE TRIGGER phases_no_delete BEFORE DELETE ON phases BEGIN SELECT RAISE(ABORT, 'phases are permanent'); END`,
  `CREATE TABLE task_deps (task_id TEXT NOT NULL REFERENCES tasks(id), depends_on TEXT NOT NULL REFERENCES tasks(id), PRIMARY KEY (task_id, depends_on), CHECK (task_id <> depends_on))`,
  `CREATE TRIGGER task_deps_no_update BEFORE UPDATE ON task_deps BEGIN SELECT RAISE(ABORT, 'task_deps are immutable'); END`,
  `CREATE TRIGGER task_deps_no_delete BEFORE DELETE ON task_deps BEGIN SELECT RAISE(ABORT, 'task_deps are immutable'); END`,
  `CREATE TABLE github_events (event_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id), repo TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('issue.opened','issue.comment')), actor_id INTEGER NOT NULL, actor_login TEXT NOT NULL, issue INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('ignored','pending','approved','rejected')), reason TEXT, title TEXT, scope_json TEXT, basis_json TEXT, text TEXT NOT NULL, text_trust TEXT NOT NULL CHECK (text_trust = 'untrusted'), text_sha256 TEXT NOT NULL, event_at TEXT NOT NULL, received_at TEXT NOT NULL, decided_at TEXT, decided_by_command TEXT REFERENCES commands(id), task_id TEXT REFERENCES tasks(id), PRIMARY KEY (project_id, event_id))`,
  `CREATE TABLE github_cursor (project_id TEXT NOT NULL REFERENCES projects(id), repo TEXT NOT NULL, etag TEXT, next_poll_ms INTEGER NOT NULL, error TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (project_id, repo))`,
  `CREATE TRIGGER github_events_no_delete BEFORE DELETE ON github_events BEGIN SELECT RAISE(ABORT, 'github_events are permanent'); END`,
  `CREATE TRIGGER github_events_immutable BEFORE UPDATE ON github_events BEGIN SELECT RAISE(ABORT, 'github_events is immutable') WHERE OLD.status <> 'pending' OR NEW.status NOT IN ('approved', 'rejected') OR (NEW.status = 'approved' AND NEW.task_id IS NULL) OR NEW.event_id IS NOT OLD.event_id OR NEW.project_id IS NOT OLD.project_id OR NEW.repo IS NOT OLD.repo OR NEW.kind IS NOT OLD.kind OR NEW.actor_id IS NOT OLD.actor_id OR NEW.actor_login IS NOT OLD.actor_login OR NEW.issue IS NOT OLD.issue OR NEW.title IS NOT OLD.title OR NEW.scope_json IS NOT OLD.scope_json OR NEW.basis_json IS NOT OLD.basis_json OR NEW.text IS NOT OLD.text OR NEW.text_trust IS NOT OLD.text_trust OR NEW.text_sha256 IS NOT OLD.text_sha256 OR NEW.event_at IS NOT OLD.event_at OR NEW.received_at IS NOT OLD.received_at; END`,
  `CREATE TRIGGER github_events_pending_check BEFORE INSERT ON github_events WHEN NEW.status = 'pending' AND (NEW.title IS NULL OR length(trim(NEW.title)) = 0 OR NEW.scope_json IS NULL OR length(trim(NEW.scope_json)) = 0) BEGIN SELECT RAISE(ABORT, 'pending github_events must have title and scope_json'); END`,
  `PRAGMA user_version = 8`,
]

const directories: string[] = []
function databaseDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-m7-schema-'))
  directories.push(dir)
  return dir
}
function databasePath(): string { return join(databaseDir(), 'state.sqlite') }
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(path: string): void {
  const db = new DatabaseSync(path)
  try {
    for (const sql of V8_DDL) db.exec(sql)
    db.exec(`
      INSERT INTO projects (id, name, created_at) VALUES ('p', 'Project', 'now');
      INSERT INTO project_config (project_id, repo_path, base_ref, created_at) VALUES ('p', '/repo', 'main', 'now');
      INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c1', 'p', 'task.create', '{}', 'now'), ('c2', 'p', 'task.create', '{}', 'now');
      INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at) VALUES ('c1', 'applied', NULL, 1, 'now');
      INSERT INTO phases (project_id, name, ord, status, opened_at, closed_at) VALUES ('p', 'intake', 1, 'open', 'now', NULL);
      INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, max_attempts, timeout_ms, attempt_base, not_before_ms, phase) VALUES ('t1', 'p', 'c1', 'First', 'ready', 'now', 'now', '["src"]', 3, NULL, 0, 0, 'intake'), ('t2', 'p', 'c2', 'Second', 'ready', 'now', 'now', '["test"]', 3, NULL, 0, 0, 'intake');
      INSERT INTO task_deps (task_id, depends_on) VALUES ('t2', 't1');
      INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at, deadline_ms) VALUES ('a', 't1', 1, 'running', NULL, NULL, 1, 'now', NULL, NULL);
      INSERT INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at, ended_at) VALUES ('a', 'nonce', 123, 'running', '/work', 42, 'now', NULL);
      INSERT INTO outbox (id, idempotency_key, kind, payload_json, status, tries, next_attempt_ms, last_error, created_at, updated_at) VALUES ('o', 'key', 'test', '{}', 'pending', 0, 0, NULL, 'now', 'now');
      INSERT INTO evidence (attempt_id, base_sha, head_sha, files_json, stdout_sha256, stderr_sha256, recorded_at) VALUES ('a', 'base', 'head', '[]', 'out', 'err', 'now');
      INSERT INTO github_events (event_id, project_id, repo, kind, actor_id, actor_login, issue, status, reason, title, scope_json, basis_json, text, text_trust, text_sha256, event_at, received_at, decided_at, decided_by_command, task_id) VALUES ('ev1', 'p', 'owner/repo', 'issue.opened', 1, 'actor', 10, 'pending', NULL, 'GH Title', '["src"]', '{}', 'GH body', 'untrusted', 'sha', 'now', 'now', NULL, NULL, NULL);
      INSERT INTO github_cursor (project_id, repo, etag, next_poll_ms, error, updated_at) VALUES ('p', 'owner/repo', 'tag1', 1000, NULL, 'now');
    `)
  } finally { db.close() }
}

const oldTablesWithoutTasks = [
  'projects',
  'project_config',
  'commands',
  'command_outcomes',
  'supervisor_lease',
  'phases',
  'task_deps',
  'attempts',
  'workers',
  'outbox',
  'evidence',
  'github_events',
  'github_cursor',
]

it('CHK-M7-01-a: fresh and v8 databases upgrade without data loss and preserve constraints', () => {
  const fresh = openStore(databasePath())
  try { expect(fresh.prepare('PRAGMA user_version').get()).toEqual({ user_version: 9 }) } finally { fresh.close() }
  const path = databasePath(); fixture(path)
  const before = new DatabaseSync(path)
  const beforeRows = Object.fromEntries(oldTablesWithoutTasks.map(name => [name, before.prepare(`SELECT * FROM ${name}`).all()]))
  const beforeTasks = before.prepare('SELECT * FROM tasks').all() as Record<string, unknown>[]
  before.close()

  for (let pass = 0; pass < 2; pass++) {
    const db = openStore(path)
    try {
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 9 })
      for (const name of oldTablesWithoutTasks) {
        expect(db.prepare(`SELECT * FROM ${name}`).all()).toEqual(beforeRows[name])
      }
      const afterTasks = db.prepare('SELECT * FROM tasks').all() as Record<string, unknown>[]
      expect(afterTasks.length).toBe(beforeTasks.length)
      for (let i = 0; i < afterTasks.length; i++) {
        expect(afterTasks[i]).toEqual({
          ...beforeTasks[i],
          provider: 'default',
        })
      }
      expect(db.prepare('SELECT * FROM project_limits').all()).toEqual([])
      expect(db.prepare('SELECT * FROM quota_windows').all()).toEqual([])
      expect(db.prepare('SELECT * FROM quota_reservations').all()).toEqual([])
      expect(db.prepare('SELECT * FROM budget_caps').all()).toEqual([])

      // M3 triggers & indexes still enforced
      expect(() => db.exec("UPDATE commands SET kind='x' WHERE id='c1'")).toThrow()
      expect(() => db.exec("DELETE FROM command_outcomes WHERE command_id='c1'")).toThrow()
      expect(() => db.exec("INSERT INTO attempts (id,task_id,attempt_no,status,lease_generation) VALUES ('a2','t1',2,'pending',1)")).toThrow()

      // M4 triggers still enforced
      expect(() => db.exec("UPDATE evidence SET head_sha='x' WHERE attempt_id='a'")).toThrow()

      // M5 triggers & indexes still enforced
      expect(() => db.exec("DELETE FROM phases WHERE project_id='p'")).toThrow()
      expect(() => db.exec("DELETE FROM task_deps WHERE task_id='t2'")).toThrow()
      expect(() => db.exec("INSERT INTO phases (project_id,name,ord,status) VALUES ('p','development',2,'open')")).toThrow()

      // M6 triggers still enforced
      expect(() => db.exec("DELETE FROM github_events WHERE event_id='ev1'")).toThrow()
    } finally { db.close() }
  }
})

it('CHK-M7-01-b: migration failure rolls back and future version is refused unchanged', () => {
  const path = databasePath(); fixture(path)
  const original = DatabaseSync.prototype.exec
  const prepare = DatabaseSync.prototype.prepare
  let statements = 0; let injected = false
  DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
    const version = this.isTransaction ? (prepare.call(this, 'PRAGMA user_version').get() as { user_version: number }).user_version : 0
    if (!injected && version === 8 && !/^\s*(?:BEGIN|COMMIT|ROLLBACK|PRAGMA)\b/i.test(sql)) {
      if (statements === 1) { injected = true; throw new Error('injected migration-9 failure') }
      const result = original.call(this, sql); statements++; return result
    }
    return original.call(this, sql)
  }
  let opened: DatabaseSync | undefined
  try { expect(() => { opened = openStore(path) }).toThrow('injected migration-9 failure') }
  finally { opened?.close(); DatabaseSync.prototype.exec = original }
  expect(injected).toBe(true); expect(statements).toBe(1)
  const check = new DatabaseSync(path)
  try {
    expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 })
    expect(check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('project_limits','quota_windows','quota_reservations','budget_caps')").all()).toEqual([])
    const taskCols = (check.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(taskCols).not.toContain('provider')
  } finally { check.close() }

  const futurePath = databasePath(); const future = new DatabaseSync(futurePath)
  future.exec("CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES ('preserved'); PRAGMA user_version = 10"); future.close()
  const hash = () => createHash('sha256').update(readFileSync(futurePath)).digest('hex')
  const before = hash()
  let futureOpened: DatabaseSync | undefined
  try { expect(() => { futureOpened = openStore(futurePath) }).toThrow() } finally { futureOpened?.close() }
  expect(hash()).toBe(before)
  const probe = new DatabaseSync(futurePath)
  try {
    expect(probe.prepare('PRAGMA user_version').get()).toEqual({ user_version: 10 })
    expect(probe.prepare('SELECT * FROM future_data').all()).toEqual([{ value: 'preserved' }])
  } finally { probe.close() }
})

it('CHK-M7-01-c: constraints and triggers on v9 tables and tasks.provider', () => {
  const db = openStore(databasePath())
  try {
    db.exec(`
      INSERT INTO projects (id, name, created_at) VALUES ('p', 'Project', 'now');
      INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c1', 'p', 'task.create', '{}', 'now');
      INSERT INTO phases (project_id, name, ord, status, opened_at, closed_at) VALUES ('p', 'intake', 1, 'open', 'now', NULL);
      INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, provider) VALUES ('t1', 'p', 'c1', 'Task 1', 'ready', 'now', 'now', 'default');
      INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation) VALUES ('a1', 't1', 1, 'running', 1);
      INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation) VALUES ('a2', 't1', 2, 'pending', 1);
      INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation) VALUES ('a3', 't1', 3, 'pending', 1);
    `)

    // 1. budget_caps level outside project/phase/task
    expect(() => db.exec("INSERT INTO budget_caps (project_id, level, key, cap_units, updated_at) VALUES ('p', 'invalid', '', 5, 'now')")).toThrow()

    // 2. quota_reservations state outside reserved/settled/released
    expect(() => db.exec("INSERT INTO quota_reservations (id, project_id, attempt_id, provider, units, state, reserved_at_ms) VALUES ('r-bad-state', 'p', 'a1', 'default', 1, 'pending', 1000)")).toThrow()

    // 3. project_limits max_parallel 0
    expect(() => db.exec("INSERT INTO project_limits (project_id, max_parallel, updated_at) VALUES ('p', 0, 'now')")).toThrow()

    // 4. quota_reservations units other than 1
    expect(() => db.exec("INSERT INTO quota_reservations (id, project_id, attempt_id, provider, units, state, reserved_at_ms) VALUES ('r-units-0', 'p', 'a1', 'default', 0, 'reserved', 1000)")).toThrow()
    expect(() => db.exec("INSERT INTO quota_reservations (id, project_id, attempt_id, provider, units, state, reserved_at_ms) VALUES ('r-units-2', 'p', 'a1', 'default', 2, 'reserved', 1000)")).toThrow()

    // 5. quota_windows window_ms below 1000 and max_units 0
    expect(() => db.exec("INSERT INTO quota_windows (project_id, provider, window_ms, max_units, updated_at) VALUES ('p', 'default', 999, 10, 'now')")).toThrow()
    expect(() => db.exec("INSERT INTO quota_windows (project_id, provider, window_ms, max_units, updated_at) VALUES ('p', 'default', 1000, 0, 'now')")).toThrow()

    // 6. budget_caps cap_units 0
    expect(() => db.exec("INSERT INTO budget_caps (project_id, level, key, cap_units, updated_at) VALUES ('p', 'project', '', 0, 'now')")).toThrow()

    // 7. a second reservation row for the same attempt_id
    db.exec("INSERT INTO quota_reservations (id, project_id, attempt_id, provider, units, state, reserved_at_ms) VALUES ('r1', 'p', 'a1', 'default', 1, 'reserved', 1000)")
    expect(() => db.exec("INSERT INTO quota_reservations (id, project_id, attempt_id, provider, units, state, reserved_at_ms) VALUES ('r1-second', 'p', 'a1', 'default', 1, 'reserved', 1000)")).toThrow()

    // 10. reserved to settled and reserved to released succeed
    db.exec("INSERT INTO quota_reservations (id, project_id, attempt_id, provider, units, state, reserved_at_ms) VALUES ('r2', 'p', 'a2', 'default', 1, 'reserved', 1000)")
    db.exec("UPDATE quota_reservations SET state = 'settled', closed_at_ms = 2000 WHERE id = 'r1'")
    expect(db.prepare("SELECT state, closed_at_ms FROM quota_reservations WHERE id = 'r1'").get()).toEqual({ state: 'settled', closed_at_ms: 2000 })
    db.exec("UPDATE quota_reservations SET state = 'released', closed_at_ms = 2000 WHERE id = 'r2'")
    expect(db.prepare("SELECT state, closed_at_ms FROM quota_reservations WHERE id = 'r2'").get()).toEqual({ state: 'released', closed_at_ms: 2000 })

    // 8. a reservation state moving backwards (settled to reserved, released to reserved) or from settled to released
    expect(() => db.exec("UPDATE quota_reservations SET state = 'reserved' WHERE id = 'r1'")).toThrow()
    expect(() => db.exec("UPDATE quota_reservations SET state = 'released' WHERE id = 'r1'")).toThrow()
    expect(() => db.exec("UPDATE quota_reservations SET state = 'reserved' WHERE id = 'r2'")).toThrow()
    expect(() => db.exec("UPDATE quota_reservations SET state = 'settled' WHERE id = 'r2'")).toThrow()

    // 9. deleting a quota_reservations row
    expect(() => db.exec("DELETE FROM quota_reservations WHERE id = 'r1'")).toThrow()
    expect(() => db.exec("DELETE FROM quota_reservations WHERE id = 'r2'")).toThrow()

    // 11. a reservation for a missing attempt (foreign keys on)
    expect(() => db.exec("INSERT INTO quota_reservations (id, project_id, attempt_id, provider, units, state, reserved_at_ms) VALUES ('r-missing-attempt', 'p', 'non-existent-attempt', 'default', 1, 'reserved', 1000)")).toThrow()

    // 12. tasks.provider cannot be NULL
    expect(() => db.exec("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c-null-p', 'p', 'task.create', '{}', 'now')")).not.toThrow()
    expect(() => db.exec("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, provider) VALUES ('t-null-provider', 'p', 'c-null-p', 'Task Null', 'ready', 'now', 'now', NULL)")).toThrow()
    expect(() => db.exec("UPDATE tasks SET provider = NULL WHERE id = 't1'")).toThrow()
  } finally {
    db.close()
  }
})

it('CHK-M7-01-d: status on a v9 DB with M6-shaped data gives the M6 output with schemaVersion 9', async () => {
  const dir = databaseDir()
  const path = join(dir, 'state.sqlite')
  const db = openStore(path)
  try {
    db.prepare("INSERT INTO projects VALUES ('p1', 'Project', '2026-11-10T00:00:00.000Z')").run()
    db.prepare("INSERT INTO project_config VALUES ('p1', ?, 'main', '2026-11-10T00:00:00.000Z')").run(process.cwd())

    db.exec("INSERT INTO phases (project_id,name,ord,status,opened_at,closed_at) VALUES ('p1','intake',1,'open','2026-11-10T00:00:00.000Z',NULL), ('p1','development',2,'locked',NULL,NULL), ('p1','qa',3,'locked',NULL,NULL), ('p1','devops',4,'locked',NULL,NULL), ('p1','handover',5,'locked',NULL,NULL)")

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
        phases: [
          { name: 'intake', ord: 1, status: 'open', openedAt: '2026-11-10T00:00:00.000Z', closedAt: null, tasks: { ready: 1, progress: 0, blocked: 0, failed: 0, done: 0, dropped: 0 } },
          { name: 'development', ord: 2, status: 'locked', openedAt: null, closedAt: null, tasks: { ready: 0, progress: 0, blocked: 0, failed: 0, done: 0, dropped: 0 } },
          { name: 'qa', ord: 3, status: 'locked', openedAt: null, closedAt: null, tasks: { ready: 0, progress: 0, blocked: 0, failed: 0, done: 0, dropped: 0 } },
          { name: 'devops', ord: 4, status: 'locked', openedAt: null, closedAt: null, tasks: { ready: 0, progress: 0, blocked: 0, failed: 0, done: 0, dropped: 0 } },
          { name: 'handover', ord: 5, status: 'locked', openedAt: null, closedAt: null, tasks: { ready: 0, progress: 0, blocked: 0, failed: 0, done: 0, dropped: 0 } },
        ],
        schemaVersion: 9,
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
      expect(arabic).toContain('إصدار المخطط: 9')
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
