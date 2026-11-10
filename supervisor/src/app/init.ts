import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openStore } from './store.ts'
import { acquireSupervisor, DEFAULT_STALE_AFTER_MS } from './supervisor-lease.ts'
import { fencedWrite } from './fence.ts'

export function init(stateDir: string, repo: string): void {
  const repoPath = resolve(repo)
  if (!statSync(repoPath).isDirectory()) throw new Error('invalid repository')
  const baseRef = execFileSync('git', ['-C', repoPath, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  execFileSync('git', ['-C', repoPath, 'rev-parse', '--show-toplevel'], { stdio: 'ignore' })
  const dbPath = join(resolve(stateDir), 'state.sqlite')
  if (existsSync(dbPath)) {
    const existing = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const rows = existing.prepare('SELECT repo_path FROM project_config').all() as Array<{ repo_path: string }>
      if (rows.length !== 1) throw new Error('invalid project configuration')
      const normalize = (p: string) => {
        const path = realpathSync(resolve(p))
        return process.platform === 'win32' ? path.toLowerCase() : path
      }
      if (normalize(rows[0]!.repo_path) !== normalize(repoPath)) throw new Error('repository mismatch')
      return
    } finally { existing.close() }
  }
  mkdirSync(resolve(stateDir), { recursive: true })
  const db = openStore(dbPath)
  try {
    const handle = acquireSupervisor(db, resolve(stateDir), { nowMs: Date.now(), staleAfterMs: DEFAULT_STALE_AFTER_MS })
    try {
      fencedWrite(db, handle, () => {
        const id = randomUUID()
        const now = new Date().toISOString()
        db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(id, basename(repoPath) || repoPath, now)
        db.prepare('INSERT INTO project_config (project_id, repo_path, base_ref, created_at) VALUES (?, ?, ?, ?)').run(id, repoPath, baseRef, now)
      })
    } finally { handle.release(Date.now()) }
  } finally { db.close() }
}
