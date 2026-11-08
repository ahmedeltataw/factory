import { DatabaseSync } from 'node:sqlite'

const SCHEMA_VERSION = 3
const ASCII_WHITESPACE = 'char(32, 9, 10, 13, 12, 11)'
const MIGRATIONS: Readonly<Record<number, string>> = {
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
      db.exec(sql)
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
