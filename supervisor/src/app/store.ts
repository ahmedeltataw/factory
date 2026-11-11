import { DatabaseSync } from 'node:sqlite'

const SCHEMA_VERSION = 7
const ASCII_WHITESPACE = 'char(32, 9, 10, 13, 12, 11)'
const MIGRATIONS: Readonly<Record<number, string | readonly string[]>> = {
  1: 'CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL)',
  2: 'CREATE INDEX projects_name_idx ON projects(name)',
  3: `
    CREATE TABLE commands (
      id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id, ${ASCII_WHITESPACE})) > 0),
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT CHECK (length(trim(project_id, ${ASCII_WHITESPACE})) > 0),
      kind TEXT NOT NULL CHECK (length(trim(kind, ${ASCII_WHITESPACE})) > 0),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      created_at TEXT NOT NULL
    );
    CREATE TRIGGER commands_no_update BEFORE UPDATE ON commands
    BEGIN SELECT RAISE(ABORT, 'commands are append-only'); END;
    CREATE TRIGGER commands_no_delete BEFORE DELETE ON commands
    BEGIN SELECT RAISE(ABORT, 'commands are append-only'); END;
    CREATE TRIGGER commands_no_replace BEFORE INSERT ON commands
    WHEN EXISTS (SELECT 1 FROM commands WHERE id = NEW.id)
    BEGIN SELECT RAISE(IGNORE); END;
  `,
  4: `
    CREATE TABLE supervisor_lease (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      owner_id TEXT NOT NULL CHECK (length(trim(owner_id, ${ASCII_WHITESPACE})) > 0),
      generation INTEGER NOT NULL CHECK (generation > 0),
      heartbeat_ms INTEGER NOT NULL CHECK (heartbeat_ms >= 0),
      status TEXT NOT NULL CHECK (status IN ('active', 'released'))
    )
  `,
  5: [
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
  ],
  6: [
    `ALTER TABLE tasks ADD COLUMN scope_json TEXT NOT NULL DEFAULT '["."]' CHECK (json_valid(scope_json))`,
    `ALTER TABLE tasks ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10)`,
    `ALTER TABLE tasks ADD COLUMN timeout_ms INTEGER CHECK (timeout_ms IS NULL OR timeout_ms BETWEEN 1000 AND 86400000)`,
    `ALTER TABLE tasks ADD COLUMN attempt_base INTEGER NOT NULL DEFAULT 0 CHECK (attempt_base >= 0)`,
    `ALTER TABLE tasks ADD COLUMN not_before_ms INTEGER NOT NULL DEFAULT 0 CHECK (not_before_ms >= 0)`,
    `ALTER TABLE attempts ADD COLUMN deadline_ms INTEGER CHECK (deadline_ms IS NULL OR deadline_ms >= 0)`,
  ],
  7: [
    `CREATE TABLE phases (project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL CHECK (name IN ('intake','development','qa','devops','handover')), ord INTEGER NOT NULL CHECK (ord BETWEEN 1 AND 5), status TEXT NOT NULL CHECK (status IN ('locked','open','done')), opened_at TEXT, closed_at TEXT, PRIMARY KEY (project_id, name), UNIQUE (project_id, ord), CHECK (ord = CASE name WHEN 'intake' THEN 1 WHEN 'development' THEN 2 WHEN 'qa' THEN 3 WHEN 'devops' THEN 4 WHEN 'handover' THEN 5 END))`,
    `CREATE UNIQUE INDEX phases_one_open ON phases(project_id) WHERE status = 'open'`,
    `CREATE TRIGGER phases_no_delete BEFORE DELETE ON phases BEGIN SELECT RAISE(ABORT, 'phases are permanent'); END`,
    `ALTER TABLE tasks ADD COLUMN phase TEXT NOT NULL DEFAULT 'intake' CHECK (phase IN ('intake','development','qa','devops','handover'))`,
    `CREATE TABLE task_deps (task_id TEXT NOT NULL REFERENCES tasks(id), depends_on TEXT NOT NULL REFERENCES tasks(id), PRIMARY KEY (task_id, depends_on), CHECK (task_id <> depends_on))`,
    `CREATE TRIGGER task_deps_no_update BEFORE UPDATE ON task_deps BEGIN SELECT RAISE(ABORT, 'task_deps are immutable'); END`,
    `CREATE TRIGGER task_deps_no_delete BEFORE DELETE ON task_deps BEGIN SELECT RAISE(ABORT, 'task_deps are immutable'); END`,
    `INSERT INTO phases (project_id, name, ord, status, opened_at) SELECT projects.id, phase.name, phase.ord, CASE WHEN phase.ord = 1 THEN 'open' ELSE 'locked' END, CASE WHEN phase.ord = 1 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END FROM projects CROSS JOIN (SELECT 'intake' AS name, 1 AS ord UNION ALL SELECT 'development', 2 UNION ALL SELECT 'qa', 3 UNION ALL SELECT 'devops', 4 UNION ALL SELECT 'handover', 5) AS phase`,
  ],
}

function version(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  return Number(row?.user_version)
}

function migrate(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    const current = version(db)
    if (current > SCHEMA_VERSION) throw new Error(`store: unsupported schema version ${current}`)
    for (let next = current + 1; next <= SCHEMA_VERSION; next++) {
      const sql = MIGRATIONS[next]
      if (sql === undefined) throw new Error(`store: missing migration ${next}`)
      if (typeof sql === 'string') db.exec(sql)
      else for (const statement of sql) db.exec(statement)
      db.exec(`PRAGMA user_version = ${next}`)
    }
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* the failed migration may already have ended the transaction */ }
    throw error
  }
}

/** Open and migrate the storage database; the caller owns and closes the connection. */
export function openStore(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA busy_timeout = 5000')
    const current = version(db)
    if (current > SCHEMA_VERSION) throw new Error(`store: unsupported schema version ${current}`)
    const journal = db.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode?: string } | undefined
    if (journal?.journal_mode !== 'wal') throw new Error('store: WAL journal mode is required')
    migrate(db)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
