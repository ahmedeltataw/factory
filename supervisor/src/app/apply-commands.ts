import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { fencedWrite } from './fence.ts'
import type { SupervisorLeaseHandle } from './supervisor-lease.ts'
import { parseScope } from '../core/scope.ts'
import { PHASES, parseDeps, phaseOrd, type PhaseName } from '../core/graph.ts'
import { sanitizeLine } from '../sources/github/event.ts'

interface PendingCommand { id: string; project_id: string; kind: string; payload_json: string; created_at: string }

interface CreateTaskParams {
  readonly id: string
  readonly projectId: string
  readonly createdByCommand: string
  readonly title: unknown
  readonly scope: unknown
  readonly maxAttempts: unknown
  readonly timeoutMs: unknown
  readonly phase: unknown
  readonly deps: unknown
  readonly createdAt: string
  readonly now: string
}

function createTask(db: DatabaseSync, params: CreateTaskParams): string | null {
  const scope = parseScope(params.scope)
  const maxAttempts = params.maxAttempts
  const timeoutMs = params.timeoutMs
  const phase = params.phase === undefined ? null : params.phase
  const deps = parseDeps(params.deps === undefined ? [] : params.deps)
  if (
    (phase !== null && (typeof phase !== 'string' || !PHASES.includes(phase as PhaseName))) ||
    !deps.ok ||
    typeof params.title !== 'string' ||
    !params.title.trim() ||
    !params.title.isWellFormed() ||
    !scope.ok ||
    typeof maxAttempts !== 'number' ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 10 ||
    (timeoutMs !== null && (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 86400000))
  ) {
    return 'invalid command or payload'
  }
  const selected = phase === null
    ? db.prepare("SELECT name, status FROM phases WHERE project_id = ? AND status = 'open'").get(params.projectId)
    : db.prepare('SELECT name, status FROM phases WHERE project_id = ? AND name = ?').get(params.projectId, phase)
  const target = selected as { name: string; status: string } | undefined
  const phaseLess = !target && !db.prepare('SELECT 1 FROM phases WHERE project_id = ? LIMIT 1').get(params.projectId)
  if (phaseLess && phase === null && deps.deps.length === 0) {
    db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, max_attempts, timeout_ms) VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?)")
      .run(params.id, params.projectId, params.createdByCommand, params.title, params.createdAt, params.now, JSON.stringify(scope.scope), maxAttempts, timeoutMs)
    return null
  }
  if (!target || target.status === 'done') return 'phase is not available'
  for (const dep of deps.deps) {
    const task = db.prepare('SELECT project_id, status, phase FROM tasks WHERE id = ?').get(dep) as { project_id: string; status: string; phase: string } | undefined
    if (!task || task.project_id !== params.projectId || task.status === 'dropped' || phaseOrd(task.phase) > phaseOrd(target.name)) {
      return `invalid dependency: ${dep}`
    }
  }
  db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, max_attempts, timeout_ms, phase) VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?)")
    .run(params.id, params.projectId, params.createdByCommand, params.title, params.createdAt, params.now, JSON.stringify(scope.scope), maxAttempts, timeoutMs, target.name)
  for (const dep of deps.deps) db.prepare('INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)').run(params.id, dep)
  return null
}

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
        reason = createTask(db, {
          id: command.id,
          projectId: command.project_id,
          createdByCommand: command.id,
          title: object.title,
          scope: legacy ? ['.'] : object.scope,
          maxAttempts: legacy ? 3 : object.maxAttempts,
          timeoutMs: legacy ? null : object.timeoutMs,
          phase: object.phase,
          deps: object.deps,
          createdAt: command.created_at,
          now,
        })
      } else if (command.kind === 'github.approve') {
        if (typeof object.eventId !== 'string' || !/^[0-9]{1,20}$/.test(object.eventId)) {
          reason = 'invalid command or payload'
        } else {
          const eventRow = db.prepare('SELECT event_id, status, title, scope_json FROM github_events WHERE project_id = ? AND event_id = ?')
            .get(command.project_id, object.eventId) as { event_id: string; status: string; title: string | null; scope_json: string | null } | undefined
          if (!eventRow) {
            reason = 'unknown event'
          } else if (eventRow.status !== 'pending') {
            reason = 'event is not pending'
          } else {
            let eventScope: unknown
            try { eventScope = JSON.parse(eventRow.scope_json ?? '') } catch { eventScope = null }
            reason = createTask(db, {
              id: command.id,
              projectId: command.project_id,
              createdByCommand: command.id,
              title: eventRow.title,
              scope: eventScope,
              maxAttempts: 3,
              timeoutMs: null,
              phase: null,
              deps: [],
              createdAt: command.created_at,
              now,
            })
            if (reason === null) {
              db.prepare("UPDATE github_events SET status = 'approved', task_id = ?, decided_at = ?, decided_by_command = ? WHERE project_id = ? AND event_id = ?")
                .run(command.id, now, command.id, command.project_id, eventRow.event_id)
            }
          }
        }
      } else if (command.kind === 'github.reject') {
        if (
          typeof object.eventId !== 'string' ||
          !/^[0-9]{1,20}$/.test(object.eventId) ||
          (object.reason !== undefined && object.reason !== null && typeof object.reason !== 'string')
        ) {
          reason = 'invalid command or payload'
        } else {
          const eventRow = db.prepare('SELECT event_id, status FROM github_events WHERE project_id = ? AND event_id = ?')
            .get(command.project_id, object.eventId) as { event_id: string; status: string } | undefined
          if (!eventRow) {
            reason = 'unknown event'
          } else if (eventRow.status !== 'pending') {
            reason = 'event is not pending'
          } else {
            const sanitizedReason = typeof object.reason === 'string' ? sanitizeLine(object.reason) : null
            db.prepare("UPDATE github_events SET status = 'rejected', reason = ?, decided_at = ?, decided_by_command = ? WHERE project_id = ? AND event_id = ?")
              .run(sanitizedReason, now, command.id, command.project_id, eventRow.event_id)
          }
        }
      } else if (command.kind === 'phase.advance' && typeof object.phase === 'string' && PHASES.includes(object.phase as PhaseName)) {
        const phase = db.prepare('SELECT ord, status FROM phases WHERE project_id = ? AND name = ?').get(command.project_id, object.phase) as { ord: number; status: string } | undefined
        if (!phase || phase.status !== 'open') reason = 'phase is not open'
        else if (db.prepare("SELECT 1 FROM tasks WHERE project_id = ? AND phase = ? AND status NOT IN ('done', 'dropped') LIMIT 1").get(command.project_id, object.phase)) reason = 'phase has unfinished tasks'
        else {
          db.prepare("UPDATE phases SET status = 'done', closed_at = ? WHERE project_id = ? AND name = ?").run(now, command.project_id, object.phase)
          db.prepare("UPDATE phases SET status = 'open', opened_at = ? WHERE project_id = ? AND ord = ? AND status = 'locked'").run(now, command.project_id, phase.ord + 1)
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
