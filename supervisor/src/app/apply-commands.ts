import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { fencedWrite } from './fence.ts'
import type { SupervisorLeaseHandle } from './supervisor-lease.ts'

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
      if (command.kind === 'task.create' && typeof object.title === 'string' && object.title.trim().length > 0 && object.title.isWellFormed()) {
        db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'ready', ?, ?)")
          .run(command.id, command.project_id, command.id, object.title, command.created_at, now)
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
