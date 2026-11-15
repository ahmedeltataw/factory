import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { SupervisorLeaseHandle } from './supervisor-lease.ts'

export type QuotaCheck = { ok: true } | { ok: false; reason: 'quota' | 'budget'; retryAtMs: number | null }

export function check(db: DatabaseSync, taskId: string, nowMs: number): QuotaCheck {
  const task = db.prepare('SELECT project_id, provider, phase FROM tasks WHERE id = ?').get(taskId) as { project_id: string; provider: string; phase: string } | undefined
  if (!task) throw new Error(`unknown task: ${taskId}`)
  const window = db.prepare('SELECT window_ms, max_units FROM quota_windows WHERE project_id = ? AND provider = ?').get(task.project_id, task.provider) as { window_ms: number; max_units: number } | undefined
  if (window) {
    const usage = db.prepare("SELECT COALESCE(SUM(units), 0) AS used, MIN(reserved_at_ms) AS oldest FROM quota_reservations WHERE project_id = ? AND provider = ? AND state IN ('reserved','settled') AND reserved_at_ms > ?").get(task.project_id, task.provider, nowMs - window.window_ms) as { used: number; oldest: number | null }
    if (usage.used + 1 > window.max_units) return { ok: false, reason: 'quota', retryAtMs: usage.oldest! + window.window_ms }
  }
  for (const [level, key] of [['task', taskId], ['phase', task.phase], ['project', '']] as const) {
    const cap = db.prepare('SELECT cap_units FROM budget_caps WHERE project_id = ? AND level = ? AND key = ?').get(task.project_id, level, key) as { cap_units: number } | undefined
    if (!cap) continue
    const usage = db.prepare(`SELECT COALESCE(SUM(r.units), 0) AS used FROM quota_reservations r JOIN attempts a ON a.id = r.attempt_id JOIN tasks t ON t.id = a.task_id WHERE r.project_id = ? AND r.state IN ('reserved','settled') AND (? = 'project' OR (? = 'phase' AND t.phase = ?) OR (? = 'task' AND t.id = ?))`).get(task.project_id, level, level, key, level, key) as { used: number }
    if (usage.used + 1 > cap.cap_units) return { ok: false, reason: 'budget', retryAtMs: null }
  }
  return { ok: true }
}

export function reserve(db: DatabaseSync, _handle: SupervisorLeaseHandle, taskId: string, attemptId: string, nowMs: number): QuotaCheck {
  const result = check(db, taskId, nowMs)
  if (!result.ok) return result
  const task = db.prepare('SELECT project_id, provider FROM tasks WHERE id = ?').get(taskId) as { project_id: string; provider: string }
  db.prepare("INSERT INTO quota_reservations (id, project_id, attempt_id, provider, units, state, reserved_at_ms) VALUES (?, ?, ?, ?, 1, 'reserved', ?)").run(randomUUID(), task.project_id, attemptId, task.provider, nowMs)
  return { ok: true }
}

export function closeReservation(db: DatabaseSync, attemptId: string, nowMs: number): void {
  db.prepare("UPDATE quota_reservations SET state = CASE WHEN EXISTS (SELECT 1 FROM workers WHERE attempt_id = ?) THEN 'settled' ELSE 'released' END, closed_at_ms = ? WHERE attempt_id = ? AND state = 'reserved'").run(attemptId, nowMs, attemptId)
}
