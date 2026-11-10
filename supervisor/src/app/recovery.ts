import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { fencedWrite } from './fence.ts'
import { createEffectHandlers, enqueueInTransaction, runDue } from './outbox.ts'
import type { SupervisorLeaseHandle } from './supervisor-lease.ts'

export interface RecoveryDeps {
  killTree: (pid: number, nonce: string, options?: { killCommand?: { file: string; args: string[] } }) => Promise<{ result: 'killed' | 'not-running' | 'identity-mismatch' | 'kill-failed'; detail?: string }>
  stateDir?: string
  staleAfterMs?: number
}
export interface ReconcileResult { reconciledCount: number; killedCount: number; lostCount: number }
export function stateDirectory(db: DatabaseSync): string {
  const row = db.prepare("PRAGMA database_list").all().find((r) => r.name === 'main') as { file: string }
  return join(row.file, '..')
}
export function readWorker(dir: string): { pid: number; nonce: string } | undefined {
  try {
    const value = JSON.parse(readFileSync(join(dir, 'worker.json'), 'utf8')) as { pid: number; nonce: string }
    return Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.nonce === 'string' && value.nonce.length > 0 ? value : undefined
  } catch { return undefined }
}
export function readCompletion(dir: string): { exitCode: number } | undefined {
  try {
    const value = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as { exitCode: number }
    return Number.isSafeInteger(value.exitCode) ? value : undefined
  } catch { return undefined }
}
export const RETRY_BASE_MS = 1000
export const RETRY_MAX_MS = 60000

export function retryTask(db: DatabaseSync, taskId: string, attemptId: string, nowMs: number): void {
  const task = db.prepare('SELECT t.max_attempts, t.attempt_base, a.attempt_no FROM tasks t JOIN attempts a ON a.task_id = t.id WHERE t.id = ? AND a.id = ?').get(taskId, attemptId) as { max_attempts: number; attempt_base: number; attempt_no: number }
  const used = task.attempt_no - task.attempt_base
  const delay = Math.min(RETRY_BASE_MS * 2 ** (used - 1), RETRY_MAX_MS)
  db.prepare("UPDATE tasks SET status = ?, not_before_ms = ?, updated_at = ? WHERE id = ? AND status = 'progress'").run(used < task.max_attempts ? 'ready' : 'failed', used < task.max_attempts ? nowMs + delay : 0, new Date(nowMs).toISOString(), taskId)
}

export function finishAttempt(db: DatabaseSync, handle: SupervisorLeaseHandle, row: { id: string; task_id: string; worktree_path: string | null }, stateDir: string, code: number, nowMs: number): void {
  fencedWrite(db, handle, () => {
    const now = new Date(nowMs).toISOString()
    db.prepare("UPDATE workers SET state = 'exited', ended_at = ? WHERE attempt_id = ?").run(now, row.id)
    db.prepare('UPDATE attempts SET status = ?, exit_code = ?, error_class = ?, ended_at = ? WHERE id = ?').run(code === 0 ? 'succeeded' : 'failed', code, code === 0 ? null : code === 75 ? 'transient' : 'exit', now, row.id)
    if (code === 75) retryTask(db, row.task_id, row.id, nowMs)
    else db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status != ?').run(code === 0 ? 'progress' : 'failed', now, row.task_id, 'dropped')
    if (code === 0) {
      const config = db.prepare('SELECT base_ref FROM project_config JOIN tasks ON tasks.project_id = project_config.project_id WHERE tasks.id = ?').get(row.task_id) as { base_ref: string }
      const dir = join(stateDir, 'runs', row.id)
      enqueueInTransaction(db, { idempotencyKey: `evidence.commit:${row.id}`, kind: 'evidence.commit', payloadJson: JSON.stringify({ attemptId: row.id, worktreePath: row.worktree_path ?? join(stateDir, 'worktrees', row.task_id), baseSha: config.base_ref, stdoutPath: join(dir, 'stdout.log'), stderrPath: join(dir, 'stderr.log'), exitCode: 0 }), nowMs })
    }
  })
}
export const MAX_ATTEMPTS = 3
async function commitReconciledEvidence(db: DatabaseSync, handle: SupervisorLeaseHandle, attemptId: string, nowMs: number): Promise<void> {
  const scoped = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => {
        if (sql === "SELECT * FROM outbox WHERE status = 'pending' AND next_attempt_ms <= ?") {
          const statement = target.prepare(`${sql} AND idempotency_key = ?`)
          return { all: (time: number) => statement.all(time, `evidence.commit:${attemptId}`) }
        }
        return target.prepare(sql)
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  await runDue(scoped, handle, createEffectHandlers({ db }), nowMs)
}
export function failExhaustedEffects(db: DatabaseSync, handle: SupervisorLeaseHandle, nowMs: number): void {
  fencedWrite(db, handle, () => {
    const rows = db.prepare(`SELECT a.id, a.task_id, o.kind FROM attempts a JOIN outbox o
      ON o.idempotency_key IN ('worktree.ensure:' || a.id, 'attempt.start:' || a.id, 'evidence.commit:' || a.id)
      WHERE o.status = 'failed' AND a.status IN ('pending','running','succeeded')`).all() as Array<{ id: string; task_id: string; kind: string }>
    const now = new Date(nowMs).toISOString()
    for (const row of rows) {
      db.prepare("UPDATE outbox SET status = 'done', last_error = 'superseded', updated_at = ? WHERE status = 'pending' AND idempotency_key IN (?, ?, ?)").run(now, `worktree.ensure:${row.id}`, `attempt.start:${row.id}`, `evidence.commit:${row.id}`)
      db.prepare("UPDATE attempts SET status = 'failed', error_class = ?, ended_at = COALESCE(ended_at, ?) WHERE id = ?").run(`outbox:${row.kind}`, now, row.id)
      db.prepare("UPDATE tasks SET status = 'failed', updated_at = ? WHERE id = ? AND status != 'dropped'").run(now, row.task_id)
    }
  })
}
export function scheduleAttempt(db: DatabaseSync, handle: SupervisorLeaseHandle, taskId: string, stateDir: string, nowMs: number): void {
  const task = db.prepare('SELECT status, max_attempts, attempt_base, not_before_ms FROM tasks WHERE id = ?').get(taskId) as { status: string; max_attempts: number; attempt_base: number; not_before_ms: number } | undefined
  if (task?.status !== 'ready' || task.not_before_ms > nowMs) return
  const count = db.prepare('SELECT COALESCE(MAX(attempt_no), 0) AS n FROM attempts WHERE task_id = ?').get(taskId) as { n: number }
  const now = new Date(nowMs).toISOString()
  if (count.n + 1 - task.attempt_base > task.max_attempts) { db.prepare("UPDATE tasks SET status = 'failed', updated_at = ? WHERE id = ?").run(now, taskId); return }
  const id = randomUUID()
  db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation, started_at) VALUES (?, ?, ?, 'pending', ?, ?)").run(id, taskId, count.n + 1, handle.generation, now)
  db.prepare("UPDATE tasks SET status = 'progress', updated_at = ? WHERE id = ?").run(now, taskId)
  enqueueInTransaction(db, { idempotencyKey: `worktree.ensure:${id}`, kind: 'worktree.ensure', payloadJson: JSON.stringify({ taskId }), nowMs })
  enqueueInTransaction(db, { idempotencyKey: `attempt.start:${id}`, kind: 'attempt.start', payloadJson: JSON.stringify({ attemptId: id, taskId, runDir: join(stateDir, 'runs', id), cwd: join(stateDir, 'worktrees', taskId), env: { FACTORY_ATTEMPT_NO: String(count.n + 1) } }), nowMs })
}
export async function reconcileWorkers(db: DatabaseSync, handle: SupervisorLeaseHandle, deps: RecoveryDeps, nowMs: number): Promise<ReconcileResult> {
  const stateDir = deps.stateDir ?? stateDirectory(db)
  const result: ReconcileResult = { reconciledCount: 0, killedCount: 0, lostCount: 0 }
  failExhaustedEffects(db, handle, nowMs)
  const rows = fencedWrite(db, handle, () => db.prepare("SELECT a.id, a.task_id, a.status, a.ended_at, t.status AS task_status, w.pid, w.nonce, w.state, w.worktree_path FROM attempts a JOIN tasks t ON t.id = a.task_id LEFT JOIN workers w ON w.attempt_id = a.id WHERE (a.lease_generation < ? AND a.status IN ('pending','running')) OR (a.status IN ('interrupted','killed') AND a.ended_at IS NOT NULL)").all(handle.generation)) as unknown as Array<{ id: string; task_id: string; status: string; task_status: string; ended_at: string | null; pid: number | null; nonce: string | null; state: string | null; worktree_path: string | null }>
  for (const row of rows) {
    // Recheck late worker.json files only during the bounded post-interruption window.
    if (['interrupted', 'killed'].includes(row.status) && nowMs - Date.parse(row.ended_at!) >= (deps.staleAfterMs ?? 300000)) continue
    const identity = readWorker(join(stateDir, 'runs', row.id)) ?? (row.pid && row.nonce ? { pid: row.pid, nonce: row.nonce } : undefined)
    const killed = identity ? await deps.killTree(identity.pid, identity.nonce) : { result: 'not-running' as const }
    if (killed.result === 'kill-failed') throw new Error(`worker kill failed: ${killed.detail ?? ''}`)
    if (['interrupted', 'killed'].includes(row.status)) continue
    result.reconciledCount++
    const completion = row.task_status !== 'dropped' && killed.result === 'not-running' ? readCompletion(join(stateDir, 'runs', row.id)) : undefined
    if (completion) {
      fencedWrite(db, handle, () => db.prepare("UPDATE outbox SET status = 'done', last_error = 'superseded', updated_at = ? WHERE idempotency_key = ? AND status = 'pending'").run(new Date(nowMs).toISOString(), `attempt.start:${row.id}`))
      finishAttempt(db, handle, row, stateDir, completion.exitCode, nowMs)
      if (completion.exitCode === 0) {
        await commitReconciledEvidence(db, handle, row.id, nowMs)
        failExhaustedEffects(db, handle, nowMs)
        fencedWrite(db, handle, () => { if (db.prepare('SELECT 1 FROM evidence WHERE attempt_id = ?').get(row.id)) db.prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ? AND status = 'progress'").run(new Date(nowMs).toISOString(), row.task_id) })
      }
    } else {
      const state = killed.result === 'killed' ? 'killed' : 'lost'
      if (state === 'killed') result.killedCount++; else result.lostCount++
      fencedWrite(db, handle, () => {
        const now = new Date(nowMs).toISOString()
        db.prepare("UPDATE outbox SET status = 'done', last_error = 'superseded', updated_at = ? WHERE idempotency_key IN (?, ?) AND status = 'pending'").run(now, `attempt.start:${row.id}`, `worktree.ensure:${row.id}`)
        db.prepare('UPDATE workers SET state = ?, ended_at = ? WHERE attempt_id = ?').run(state, now, row.id)
        db.prepare('UPDATE attempts SET status = ?, error_class = ?, ended_at = ? WHERE id = ?').run(row.task_status === 'dropped' ? 'killed' : 'interrupted', killed.result, now, row.id)
        db.prepare("UPDATE tasks SET status = 'ready', updated_at = ? WHERE id = ? AND status = 'progress'").run(now, row.task_id)
        scheduleAttempt(db, handle, row.task_id, stateDir, nowMs)
      })
    }
  }
  failExhaustedEffects(db, handle, nowMs)
  return result
}
