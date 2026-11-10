import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { recordEvidence, type RecordEvidenceOptions } from './evidence.ts'
import { fencedWrite } from './fence.ts'
import { triggerFault, type FaultName } from './faults.ts'
import { LeaseLostError, type SupervisorLeaseHandle } from './supervisor-lease.ts'
import { ensureWorktree, type EnsureWorktreeConfig } from './worktree.ts'

export interface OutboxRow {
  [key: string]: SQLOutputValue
  id: string; idempotency_key: string; kind: string; payload_json: string
  status: 'pending' | 'done' | 'failed'; tries: number; next_attempt_ms: number
  last_error: string | null; created_at: string; updated_at: string
}
export interface EnqueueOptions { idempotencyKey: string; kind: string; payloadJson: string; nowMs?: number }
export const MAX_TRIES = 3
export const BACKOFF_MS = 1000

export function enqueueInTransaction(db: DatabaseSync, options: EnqueueOptions): OutboxRow {
  const nowMs = options.nowMs ?? Date.now()
  const now = new Date(nowMs).toISOString()
  db.prepare(`INSERT INTO outbox (id, idempotency_key, kind, payload_json, status, tries, next_attempt_ms, last_error, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, ?, ?) ON CONFLICT(idempotency_key) DO NOTHING`)
    .run(randomUUID(), options.idempotencyKey, options.kind, options.payloadJson, nowMs, now, now)
  return db.prepare('SELECT * FROM outbox WHERE idempotency_key = ?').get(options.idempotencyKey) as unknown as OutboxRow
}
export function enqueue(db: DatabaseSync, handle: SupervisorLeaseHandle, options: EnqueueOptions): OutboxRow {
  return fencedWrite(db, handle, () => enqueueInTransaction(db, options))
}

const lease = Symbol('outbox lease')
type Context = { idempotencyKey: string; [lease]?: SupervisorLeaseHandle }
export type OutboxHandler = (row: OutboxRow, context: { idempotencyKey: string }) => void | Promise<void>
export interface EffectHandlerDeps {
  db: DatabaseSync
  spawnWorker?: (options: { runDir: string; cwd: string; taskId: string; attemptId: string; env?: Record<string, string> }) => Promise<{ pid: number; nonce: string }> | { pid: number; nonce: string }
  config?: EnsureWorktreeConfig
}

function evidenceDatabase(db: DatabaseSync, handle: SupervisorLeaseHandle): DatabaseSync {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => {
        const statement = target.prepare(sql)
        if (!/^\s*INSERT INTO evidence\b/i.test(sql)) return statement
        return new Proxy(statement, { get(stmt, key) {
          if (key === 'run') return (...args: Parameters<typeof stmt.run>) => fencedWrite(target, handle, () => stmt.run(...args))
          const value = Reflect.get(stmt, key, stmt) as unknown
          return typeof value === 'function' ? value.bind(stmt) : value
        } })
      }
      const value = Reflect.get(target, prop, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

export function createEffectHandlers(deps: EffectHandlerDeps): Record<string, OutboxHandler> {
  return {
    'worktree.ensure': async (row) => {
      if (!deps.config) throw new Error('worktree configuration required')
      const { taskId } = JSON.parse(row.payload_json) as { taskId: string }
      await ensureWorktree(deps.config, taskId)
    },
    'attempt.start': async (row, context: Context) => {
      const { attemptId, taskId, runDir, cwd, env } = JSON.parse(row.payload_json) as { attemptId: string; taskId: string; runDir?: string; cwd?: string; env?: Record<string, string> }
      const worker = deps.db.prepare('SELECT state FROM workers WHERE attempt_id = ?').get(attemptId) as { state: string } | undefined
      if (worker && worker.state !== 'starting') return
      if (!deps.spawnWorker) throw new Error('spawnWorker required')
      const handle = context[lease]
      if (!handle) throw new Error('outbox lease required')
      const dir = runDir ?? join(deps.config?.stateDir ?? '.', 'runs', attemptId)
      const worktree = cwd ?? join(deps.config?.stateDir ?? '.', 'worktrees', taskId)
      const result = await deps.spawnWorker({ runDir: dir, cwd: worktree, taskId, attemptId, env })
      fencedWrite(deps.db, handle, () => {
        deps.db.prepare(`INSERT INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at)
          VALUES (?, ?, ?, 'running', ?, ?, ?) ON CONFLICT(attempt_id) DO UPDATE SET nonce = excluded.nonce, pid = excluded.pid, state = excluded.state, worktree_path = excluded.worktree_path, heartbeat_ms = excluded.heartbeat_ms, started_at = excluded.started_at WHERE workers.state = 'starting'`)
          .run(attemptId, result.nonce, result.pid, worktree, Date.now(), new Date().toISOString())
      })
    },
    'evidence.commit': async (row, context: Context) => {
      const { attemptId, ...options } = JSON.parse(row.payload_json) as RecordEvidenceOptions & { attemptId: string }
      if (deps.db.prepare('SELECT 1 FROM evidence WHERE attempt_id = ?').get(attemptId)) return
      const handle = context[lease]
      if (!handle) throw new Error('outbox lease required')
      await recordEvidence(evidenceDatabase(deps.db, handle), attemptId, options)
    },
  }
}

export async function runDue(db: DatabaseSync, handle: SupervisorLeaseHandle, handlers: Record<string, OutboxHandler>, nowMs: number, options?: { fault?: FaultName }): Promise<{ done: number; failed: number; retried: number }> {
  const rows = fencedWrite(db, handle, () => db.prepare("SELECT * FROM outbox WHERE status = 'pending' AND next_attempt_ms <= ?").all(nowMs) as unknown as OutboxRow[])
  const result = { done: 0, failed: 0, retried: 0 }
  for (const row of rows) {
    fencedWrite(db, handle, () => {})
    try {
      if (options?.fault === 'outbox-before-effect') triggerFault(options.fault)
      const handler = Object.hasOwn(handlers, row.kind) ? handlers[row.kind] : undefined
      if (!handler) throw new Error(`no handler for ${row.kind}`)
      await handler(row, { idempotencyKey: row.idempotency_key, [lease]: handle } as Context)
      if (options?.fault === 'outbox-after-effect') triggerFault(options.fault)
      fencedWrite(db, handle, () => {
        db.prepare("UPDATE outbox SET status = 'done', updated_at = ? WHERE id = ? AND status = 'pending'").run(new Date(nowMs).toISOString(), row.id)
      })
      result.done++
    } catch (error) {
      if (error instanceof LeaseLostError) throw error
      const tries = row.tries + 1
      const failed = tries >= MAX_TRIES
      const message = error instanceof Error ? error.message || String(error) : String(error) || 'unknown error'
      fencedWrite(db, handle, () => {
        db.prepare('UPDATE outbox SET status = ?, tries = ?, next_attempt_ms = ?, last_error = ?, updated_at = ? WHERE id = ? AND status = \'pending\'')
          .run(failed ? 'failed' : 'pending', tries, nowMs + BACKOFF_MS, message, new Date(nowMs).toISOString(), row.id)
      })
      if (failed) result.failed++
      else result.retried++
    }
  }
  return result
}

