import { DatabaseSync } from 'node:sqlite'

const SCHEMA_VERSION = 2
const MIGRATIONS: Readonly<Record<number, string>> = {
  1: 'CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL)',
  2: 'CREATE INDEX projects_name_idx ON projects(name)',
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
