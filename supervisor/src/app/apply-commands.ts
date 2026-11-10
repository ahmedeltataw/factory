import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { fencedWrite } from './fence.ts'
import type { SupervisorLeaseHandle } from './supervisor-lease.ts'
import { parseScope } from '../core/scope.ts'

interface PendingCommand { id: string; project_id: string; kind: string; payload_json: string; created_at: string }

export function applyPendingCommands(db: DatabaseSync, handle: SupervisorLeaseHandle): void {
  while (true) {
    const processed = fencedWrite(db, handle, () => {
      const command = db.prepare(`SELECT c.id, c.project_id, c.kind, c.payload_json, c.created_at FROM commands c
        WHERE NOT EXISTS (SELECT 1 FROM command_outcomes o WHERE o.command_id = c.id) ORDER BY c.rowid LIMIT 1`).get() as PendingCommand | undefined
      if (!command) return false
      const now = new Date().toISOString()
      let reason: string | null = null
      let payload: unknown
      try { payload = JSON.parse(command.payload_json) } catch { payload = null }
      const object = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
      if (command.kind === 'task.create') {
        const legacy = Object.keys(object).length === 1 && Object.hasOwn(object, 'title')
        const scope = parseScope(legacy ? ['.'] : object.scope)
        const maxAttempts = legacy ? 3 : object.maxAttempts
        const timeoutMs = legacy ? null : object.timeoutMs
        if (typeof object.title !== 'string' || !object.title.trim() || !object.title.isWellFormed() || !scope.ok ||
            typeof maxAttempts !== 'number' || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10 ||
            (timeoutMs !== null && (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 86400000))) {
          reason = 'invalid command or payload'
        } else {
          db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, max_attempts, timeout_ms) VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?)")
            .run(command.id, command.project_id, command.id, object.title, command.created_at, now, JSON.stringify(scope.scope), maxAttempts, timeoutMs)
        }
      } else if (command.kind === 'task.retry' && typeof object.taskId === 'string' && object.taskId.trim().length > 0 && object.taskId.isWellFormed()) {
        const task = db.prepare('SELECT status FROM tasks WHERE id = ? AND project_id = ?').get(object.taskId, command.project_id) as { status: string } | undefined
        if (!task || task.status !== 'failed') reason = 'task cannot be retried'
        else db.prepare("UPDATE tasks SET status = 'ready', attempt_base = COALESCE((SELECT MAX(attempt_no) FROM attempts WHERE task_id = ?), 0), not_before_ms = 0, updated_at = ? WHERE id = ?").run(object.taskId, now, object.taskId)
      } else if (command.kind === 'task.kill' && typeof object.taskId === 'string' && object.taskId.trim().length > 0 && object.taskId.isWellFormed()) {
        const task = db.prepare('SELECT status FROM tasks WHERE id = ? AND project_id = ?').get(object.taskId, command.project_id) as { status: string } | undefined
        if (!task || !['ready', 'waiting', 'blocked', 'progress'].includes(task.status)) reason = 'task cannot be killed'
        else {
          db.prepare("UPDATE tasks SET status = 'dropped', updated_at = ? WHERE id = ?").run(now, object.taskId)
          const attempts = db.prepare("SELECT id FROM attempts WHERE task_id = ? AND status IN ('pending', 'running')").all(object.taskId) as Array<{ id: string }>
          for (const attempt of attempts) {
            db.prepare("INSERT OR IGNORE INTO outbox (id, idempotency_key, kind, payload_json, status, tries, next_attempt_ms, last_error, created_at, updated_at) VALUES (?, ?, 'attempt.kill', ?, 'pending', 0, 0, NULL, ?, ?)")
              .run(randomUUID(), `attempt.kill:${attempt.id}`, JSON.stringify({ attemptId: attempt.id }), now, now)
          }
        }
      } else reason = 'invalid command or payload'
      db.prepare('INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at) VALUES (?, ?, ?, ?, ?)')
        .run(command.id, reason === null ? 'applied' : 'rejected', reason, handle.generation, now)
      return true
    })
    if (!processed) return
  }
}
