import { DatabaseSync } from 'node:sqlite'

const SCHEMA_VERSION = 5
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
