import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import {
  TaskStatusSchema,
  AttemptStatusSchema,
  WorkerStateSchema,
  OutboxStatusSchema,
  CommandOutcomeSchema,
  type TaskStatus,
  type AttemptStatus,
  type WorkerState,
} from './domain.ts'
import { parseScope, scopesOverlap } from '../core/scope.ts'
import {
  PHASES,
  planDispatch,
  type PhaseName,
  type DispatchTask,
  type PhaseInfo,
} from '../core/graph.ts'

/** Storage schema version this status reader supports: the M4 storage schema (v6) / M5 (v7). */
const SCHEMA_VERSION = 7

export type LeaseState = 'active' | 'released'
export type LeaseFreshness = 'fresh' | 'stale' | 'future' | 'not-applicable'
export type PhaseStatus = 'locked' | 'open' | 'done'
export type TaskWaitingReason = 'phase-locked' | 'deps' | 'scope' | 'backoff'

export interface Lease {
  readonly ownerId: string
  readonly generation: number
  readonly heartbeatMs: number
  readonly state: LeaseState
  readonly freshness: LeaseFreshness
  readonly takeover?: string
}

export interface CommandsSummary {
  readonly recorded: number
  readonly applied: number
  readonly rejected: number
  readonly pending: number
}

export interface OutboxFailedRow {
  readonly key: string
  readonly kind: string
  readonly tries: number
  readonly lastError: string | null
}

export interface OutboxSummary {
  readonly pending: number
  readonly done: number
  readonly failed: number
  readonly failedRows: readonly OutboxFailedRow[]
}

export interface TaskAttemptWorker {
  readonly pid: number | null
  readonly state: WorkerState
  readonly heartbeatMs: number | null
}

export interface EvidenceFile {
  readonly path: string
  readonly sha256: string
}

export interface TaskAttemptEvidence {
  readonly headSha: string
  readonly files: readonly EvidenceFile[]
}

export interface TaskAttempt {
  readonly no: number
  readonly status: AttemptStatus
  readonly exitCode: number | null
  readonly worker: TaskAttemptWorker | null
  readonly evidence: TaskAttemptEvidence | null
  readonly errorClass: string | null
  readonly deadlineMs: number | null
}

export interface PhaseTaskCounts {
  readonly ready: number
  readonly progress: number
  readonly blocked: number
  readonly failed: number
  readonly done: number
  readonly dropped: number
}

export interface PhaseStatusItem {
  readonly name: string
  readonly ord: number
  readonly status: PhaseStatus
  readonly openedAt: string | null
  readonly closedAt: string | null
  readonly tasks: PhaseTaskCounts
}

export interface TaskWaiting {
  readonly reason: TaskWaitingReason
  readonly on: readonly string[]
}

export interface TaskStatusItem {
  readonly id: string
  readonly title: string
  readonly status: TaskStatus
  readonly attempts: readonly TaskAttempt[]
  readonly scope: readonly string[]
  readonly maxAttempts: number
  readonly timeoutMs: number | null
  readonly notBeforeMs: number
  readonly blockedBy: readonly string[]
  readonly phase: string
  readonly dependsOn: readonly string[]
  readonly waiting: TaskWaiting | null
}

export interface Status {
  readonly schemaVersion: 7
  readonly recordedCommandCount: number
  readonly lease: null | Lease
  readonly commands?: CommandsSummary
  readonly tasks?: readonly TaskStatusItem[]
  readonly outbox?: OutboxSummary
  readonly phases: readonly PhaseStatusItem[]
}

export interface ReadStatusOptions {
  readonly nowMs: number
  readonly staleAfterMs: number
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

interface LeaseRow {
  readonly id: unknown
  readonly owner_id: unknown
  readonly generation: unknown
  readonly heartbeat_ms: unknown
  readonly status: unknown
}

function isLeaseRow(value: unknown): value is LeaseRow & {
  readonly id: 1
  readonly owner_id: string
  readonly generation: number
  readonly heartbeat_ms: number
  readonly status: LeaseState
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as LeaseRow
  return (
    row.id === 1 &&
    typeof row.owner_id === 'string' &&
    row.owner_id.trim().length > 0 &&
    Number.isSafeInteger(row.generation as number) &&
    (row.generation as number) > 0 &&
    Number.isSafeInteger(row.heartbeat_ms as number) &&
    (row.heartbeat_ms as number) >= 0 &&
    (row.status === 'active' || row.status === 'released')
  )
}

/** Classify an active lease heartbeat without treating freshness as proof of liveness. */
function heartbeatFreshness(
  state: LeaseState,
  heartbeatMs: number,
  nowMs: number,
  staleAfterMs: number,
): LeaseFreshness {
  if (state === 'released') return 'not-applicable'
  if (heartbeatMs > nowMs) return 'future'
  if (nowMs - heartbeatMs >= staleAfterMs) return 'stale'
  return 'fresh'
}

/**
 * Read a single read-only snapshot of the supervisor status from an existing v5 database.
 * Opens the database in SQLite read-only mode: never migrates, never writes,
 * never reads command payloads or worker nonces, never probes or kills PIDs,
 * and always closes its connection.
 */
export function readStatus(stateDir: string, options: ReadStatusOptions): Status {
  if (typeof stateDir !== 'string' || stateDir.trim().length === 0) {
    throw new Error('status: stateDir must be a non-empty string')
  }

  const nowMs = options?.nowMs
  const staleAfterMs = options?.staleAfterMs
  if (!isNonnegativeSafeInteger(nowMs)) throw new Error('status: nowMs must be a nonnegative safe integer')
  if (!isPositiveSafeInteger(staleAfterMs)) throw new Error('status: staleAfterMs must be a positive safe integer')

  const path = join(stateDir, 'state.sqlite')
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 })
  try {
    db.exec('BEGIN')
    try {
      const versionRow = db.prepare('PRAGMA user_version').get() as { readonly user_version?: number } | undefined
      const userVersion = Number(versionRow?.user_version)
      if (userVersion !== SCHEMA_VERSION) {
        throw new Error(`status: unsupported schema version ${userVersion}`)
      }

      const countRow = db
        .prepare('SELECT COUNT(*) AS count FROM commands')
        .get() as { readonly count?: unknown } | undefined
      if (!isNonnegativeSafeInteger(countRow?.count)) {
        throw new Error('status: command count is not a nonnegative safe integer')
      }
      const recordedCommandCount = countRow.count

      const masterRows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ readonly name: unknown }>
      const tableNames = new Set(masterRows.map(r => String(r.name)))
      const hasV5Tables = tableNames.has('command_outcomes') || tableNames.has('tasks') || tableNames.has('outbox')

      const leaseRows = db
        .prepare('SELECT id, owner_id, generation, heartbeat_ms, status FROM supervisor_lease LIMIT 2')
        .all()

      let lease: null | Lease = null
      if (leaseRows.length === 0) {
        lease = null
      } else if (leaseRows.length === 1) {
        const leaseRow = leaseRows[0]
        if (!isLeaseRow(leaseRow)) {
          throw new Error('status: malformed supervisor_lease row')
        }
        const leaseObj: Lease = {
          ownerId: leaseRow.owner_id,
          generation: leaseRow.generation,
          heartbeatMs: leaseRow.heartbeat_ms,
          state: leaseRow.status,
          freshness: heartbeatFreshness(leaseRow.status, leaseRow.heartbeat_ms, nowMs, staleAfterMs),
          ...(hasV5Tables
            ? { takeover: `${leaseRow.owner_id}:${leaseRow.generation}:${leaseRow.heartbeat_ms}` }
            : {}),
        }
        lease = leaseObj
      } else {
        throw new Error('status: corrupt supervisor_lease table')
      }

      let appliedCount = 0
      let rejectedCount = 0
      if (tableNames.has('command_outcomes')) {
        const outcomeRows = db.prepare('SELECT outcome, COUNT(*) AS count FROM command_outcomes GROUP BY outcome').all() as Array<{ readonly outcome: unknown; readonly count: unknown }>
        for (const row of outcomeRows) {
          if (!CommandOutcomeSchema.safeParse(row.outcome).success) {
            throw new Error(`status: invalid command outcome ${String(row.outcome)}`)
          }
          const count = Number(row.count)
          if (!isNonnegativeSafeInteger(count)) {
            throw new Error('status: malformed command outcome count')
          }
          if (row.outcome === 'applied') appliedCount = count
          else if (row.outcome === 'rejected') rejectedCount = count
        }
      }
      const pendingCount = recordedCommandCount - (appliedCount + rejectedCount)
      if (pendingCount < 0) {
        throw new Error('status: command outcome count exceeds recorded commands')
      }
      const commands: CommandsSummary = {
        recorded: recordedCommandCount,
        applied: appliedCount,
        rejected: rejectedCount,
        pending: pendingCount,
      }

      let outboxPending = 0
      let outboxDone = 0
      let outboxFailed = 0
      const failedRows: OutboxFailedRow[] = []
      if (tableNames.has('outbox')) {
        const outboxRows = db.prepare('SELECT id, idempotency_key, kind, payload_json, status, tries, next_attempt_ms, last_error FROM outbox').all() as Array<{
          readonly id: unknown
          readonly idempotency_key: unknown
          readonly kind: unknown
          readonly payload_json: unknown
          readonly status: unknown
          readonly tries: unknown
          readonly next_attempt_ms: unknown
          readonly last_error: unknown
        }>
        for (const row of outboxRows) {
          if (!OutboxStatusSchema.safeParse(row.status).success) {
            throw new Error(`status: invalid outbox status ${String(row.status)}`)
          }
          if (typeof row.payload_json !== 'string') {
            throw new Error('status: invalid outbox payload_json')
          }
          try {
            JSON.parse(row.payload_json)
          } catch {
            throw new Error('status: malformed outbox payload_json')
          }
          if (row.status === 'pending') outboxPending++
          else if (row.status === 'done') outboxDone++
          else if (row.status === 'failed') {
            outboxFailed++
            failedRows.push({
              key: String(row.idempotency_key),
              kind: String(row.kind),
              tries: Number(row.tries),
              lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
            })
          }
        }
      }

      const workersByAttemptId = new Map<string, TaskAttemptWorker>()
      if (tableNames.has('workers')) {
        const workerRows = db.prepare('SELECT attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at, ended_at FROM workers').all() as Array<{
          readonly attempt_id: unknown
          readonly nonce: unknown
          readonly pid: unknown
          readonly state: unknown
          readonly worktree_path: unknown
          readonly heartbeat_ms: unknown
          readonly started_at: unknown
          readonly ended_at: unknown
        }>
        for (const w of workerRows) {
          if (typeof w.attempt_id !== 'string' || w.attempt_id.trim().length === 0) {
            throw new Error('status: invalid worker attempt_id')
          }
          if (!WorkerStateSchema.safeParse(w.state).success) {
            throw new Error(`status: invalid worker state ${String(w.state)}`)
          }
          if (w.pid !== null && (!Number.isSafeInteger(w.pid as number) || (w.pid as number) <= 0)) {
            throw new Error('status: invalid worker pid')
          }
          if (w.heartbeat_ms !== null && (!Number.isSafeInteger(w.heartbeat_ms as number) || (w.heartbeat_ms as number) < 0)) {
            throw new Error('status: invalid worker heartbeat_ms')
          }
          const workerState = w.state as WorkerState
          const pid = w.pid === null ? null : Number(w.pid)
          const heartbeatMs = w.heartbeat_ms === null ? null : Number(w.heartbeat_ms)
          const isSuspect = (workerState === 'starting' || workerState === 'running') &&
            heartbeatMs !== null &&
            (nowMs - heartbeatMs >= staleAfterMs)

          const workerObj: TaskAttemptWorker = {
            pid,
            state: workerState,
            heartbeatMs,
          }
          Object.defineProperty(workerObj, 'isSuspect', {
            value: isSuspect,
            enumerable: false,
            writable: true,
            configurable: true,
          })
          workersByAttemptId.set(w.attempt_id, workerObj)
        }
      }

      const evidenceByAttemptId = new Map<string, TaskAttemptEvidence>()
      if (tableNames.has('evidence')) {
        const evidenceRows = db.prepare('SELECT attempt_id, base_sha, head_sha, files_json, stdout_sha256, stderr_sha256, recorded_at FROM evidence').all() as Array<{
          readonly attempt_id: unknown
          readonly head_sha: unknown
          readonly files_json: unknown
        }>
        for (const e of evidenceRows) {
          if (typeof e.attempt_id !== 'string' || e.attempt_id.trim().length === 0) {
            throw new Error('status: invalid evidence attempt_id')
          }
          if (typeof e.head_sha !== 'string' || e.head_sha.trim().length === 0) {
            throw new Error('status: invalid evidence head_sha')
          }
          if (typeof e.files_json !== 'string') {
            throw new Error('status: invalid evidence files_json')
          }
          let parsedFiles: unknown
          try {
            parsedFiles = JSON.parse(e.files_json)
          } catch {
            throw new Error('status: malformed evidence files_json')
          }
          if (!Array.isArray(parsedFiles)) {
            throw new Error('status: evidence files_json must be an array')
          }
          const files: EvidenceFile[] = []
          for (const item of parsedFiles) {
            if (item === null || typeof item !== 'object') {
              throw new Error('status: invalid evidence file entry')
            }
            const pathVal = (item as { readonly path?: unknown }).path
            const shaVal = (item as { readonly sha256?: unknown }).sha256
            if (typeof pathVal !== 'string' || typeof shaVal !== 'string') {
              throw new Error('status: invalid evidence file entry schema')
            }
            files.push({ path: pathVal, sha256: shaVal })
          }
          evidenceByAttemptId.set(e.attempt_id, {
            headSha: e.head_sha,
            files,
          })
        }
      }

      const outbox: OutboxSummary = {
        pending: outboxPending,
        done: outboxDone,
        failed: outboxFailed,
        failedRows,
      }

      const attemptsByTaskId = new Map<string, TaskAttempt[]>()
      if (tableNames.has('attempts')) {
        const attemptRows = db
          .prepare(
            'SELECT id, task_id, attempt_no, status, exit_code, error_class, deadline_ms FROM attempts ORDER BY attempt_no ASC',
          )
          .all() as Array<{
            readonly id: unknown
            readonly task_id: unknown
            readonly attempt_no: unknown
            readonly status: unknown
            readonly exit_code: unknown
            readonly error_class: unknown
            readonly deadline_ms: unknown
          }>
        for (const a of attemptRows) {
          if (typeof a.id !== 'string' || a.id.trim().length === 0) {
            throw new Error('status: invalid attempt id')
          }
          if (typeof a.task_id !== 'string' || a.task_id.trim().length === 0) {
            throw new Error('status: invalid attempt task_id')
          }
          if (!isPositiveSafeInteger(a.attempt_no)) {
            throw new Error('status: invalid attempt_no')
          }
          if (!AttemptStatusSchema.safeParse(a.status).success) {
            throw new Error(`status: invalid attempt status ${String(a.status)}`)
          }
          if (a.exit_code !== null && !Number.isSafeInteger(a.exit_code as number)) {
            throw new Error('status: invalid attempt exit_code')
          }
          if (a.error_class !== null && typeof a.error_class !== 'string') {
            throw new Error('status: invalid attempt error_class')
          }
          if (
            a.deadline_ms !== null &&
            (!Number.isSafeInteger(a.deadline_ms as number) || (a.deadline_ms as number) < 0)
          ) {
            throw new Error('status: invalid attempt deadline_ms')
          }
          const attemptItem: TaskAttempt = {
            no: a.attempt_no,
            status: a.status as AttemptStatus,
            exitCode: a.exit_code === null ? null : Number(a.exit_code),
            worker: workersByAttemptId.get(a.id) ?? null,
            evidence: evidenceByAttemptId.get(a.id) ?? null,
            errorClass: a.error_class === null ? null : String(a.error_class),
            deadlineMs: a.deadline_ms === null ? null : Number(a.deadline_ms),
          }
          let list = attemptsByTaskId.get(a.task_id)
          if (!list) {
            list = []
            attemptsByTaskId.set(a.task_id, list)
          }
          list.push(attemptItem)
        }
      }

      interface LoadedPhaseRow {
        name: PhaseName
        ord: number
        status: PhaseStatus
        opened_at: string | null
        closed_at: string | null
      }
      const loadedPhases: LoadedPhaseRow[] = []

      if (tableNames.has('phases')) {
        const phaseProjects = db
          .prepare('SELECT project_id, COUNT(*) AS count FROM phases GROUP BY project_id')
          .all() as Array<{ readonly project_id: unknown; readonly count: unknown }>
        for (const row of phaseProjects) {
          const c = Number(row.count)
          if (c > 0 && c !== 5) {
            throw new Error('status: project has missing phase row')
          }
        }

        if (tableNames.has('projects')) {
          const projectRows = db.prepare('SELECT id FROM projects').all() as Array<{ readonly id: unknown }>
          for (const pr of projectRows) {
            const pId = String(pr.id)
            const pCountRow = db.prepare('SELECT COUNT(*) AS count FROM phases WHERE project_id = ?').get(pId) as {
              readonly count?: unknown
            }
            const c = Number(pCountRow?.count ?? 0)
            if (c > 0 && c !== 5) {
              throw new Error('status: project has missing phase row')
            }
          }
        }

        let targetProjectId: string | null = null
        if (tableNames.has('project_config')) {
          const cfg = db.prepare('SELECT project_id FROM project_config LIMIT 1').get() as
            | { readonly project_id?: unknown }
            | undefined
          if (cfg?.project_id && typeof cfg.project_id === 'string') {
            targetProjectId = cfg.project_id
          }
        }
        if (!targetProjectId && tableNames.has('projects')) {
          const pr = db.prepare('SELECT id FROM projects LIMIT 1').get() as { readonly id?: unknown } | undefined
          if (pr?.id && typeof pr.id === 'string') {
            targetProjectId = pr.id
          }
        }
        if (!targetProjectId && phaseProjects.length > 0) {
          targetProjectId = String(phaseProjects[0]!.project_id)
        }

        if (targetProjectId) {
          const rows = db
            .prepare('SELECT name, ord, status, opened_at, closed_at FROM phases WHERE project_id = ? ORDER BY ord ASC')
            .all(targetProjectId) as Array<{
              readonly name: unknown
              readonly ord: unknown
              readonly status: unknown
              readonly opened_at: unknown
              readonly closed_at: unknown
            }>
          if (rows.length === 5) {
            let openCount = 0
            for (let i = 0; i < 5; i++) {
              const row = rows[i]!
              const expectedName = PHASES[i]
              const expectedOrd = i + 1
              if (
                row.name !== expectedName ||
                row.ord !== expectedOrd ||
                (row.status !== 'locked' && row.status !== 'open' && row.status !== 'done') ||
                (row.opened_at !== null && typeof row.opened_at !== 'string') ||
                (row.closed_at !== null && typeof row.closed_at !== 'string')
              ) {
                throw new Error('status: malformed phase row')
              }
              if (row.status === 'open') openCount++
              loadedPhases.push({
                name: row.name as PhaseName,
                ord: row.ord as number,
                status: row.status as PhaseStatus,
                opened_at: row.opened_at === null ? null : String(row.opened_at),
                closed_at: row.closed_at === null ? null : String(row.closed_at),
              })
            }
            if (openCount > 1) {
              throw new Error('status: more than one open phase')
            }
          } else if (rows.length > 0) {
            throw new Error('status: project has missing phase row')
          }
        }
      }

      const depsByTaskId = new Map<string, string[]>()
      if (tableNames.has('task_deps')) {
        if (!tableNames.has('tasks')) {
          const tdRow = db.prepare('SELECT 1 FROM task_deps LIMIT 1').get()
          if (tdRow) throw new Error('status: task_deps row points to a missing task')
        } else {
          const badDep = db.prepare(`
            SELECT 1 FROM task_deps td
            WHERE NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = td.task_id)
               OR NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = td.depends_on)
            LIMIT 1
          `).get()
          if (badDep) {
            throw new Error('status: task_deps row points to a missing task')
          }
        }

        const depRows = db
          .prepare('SELECT task_id, depends_on FROM task_deps ORDER BY depends_on ASC')
          .all() as Array<{
            readonly task_id: unknown
            readonly depends_on: unknown
          }>
        for (const dep of depRows) {
          if (typeof dep.task_id !== 'string' || typeof dep.depends_on !== 'string') {
            throw new Error('status: invalid task_deps row')
          }
          let list = depsByTaskId.get(dep.task_id)
          if (!list) {
            list = []
            depsByTaskId.set(dep.task_id, list)
          }
          list.push(dep.depends_on)
        }
      }

      const tasks: TaskStatusItem[] = []
      if (tableNames.has('tasks')) {
        const taskColumns = new Set(
          (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ readonly name: unknown }>).map((c) =>
            String(c.name),
          ),
        )
        const hasPhaseColumn = taskColumns.has('phase')

        const taskRows = db
          .prepare(
            hasPhaseColumn
              ? 'SELECT rowid, id, title, status, scope_json, max_attempts, timeout_ms, attempt_base, not_before_ms, phase FROM tasks ORDER BY created_at ASC, rowid ASC'
              : 'SELECT rowid, id, title, status, scope_json, max_attempts, timeout_ms, attempt_base, not_before_ms FROM tasks ORDER BY created_at ASC, rowid ASC',
          )
          .all() as Array<{
            readonly rowid: unknown
            readonly id: unknown
            readonly title: unknown
            readonly status: unknown
            readonly scope_json: unknown
            readonly max_attempts: unknown
            readonly timeout_ms: unknown
            readonly attempt_base: unknown
            readonly not_before_ms: unknown
            readonly phase?: unknown
          }>
        for (const t of taskRows) {
          if (typeof t.id !== 'string' || t.id.trim().length === 0) {
            throw new Error('status: invalid task id')
          }
          if (typeof t.title !== 'string') {
            throw new Error('status: invalid task title')
          }
          if (!TaskStatusSchema.safeParse(t.status).success) {
            throw new Error(`status: invalid task status ${String(t.status)}`)
          }
          if (typeof t.scope_json !== 'string') {
            throw new Error('status: invalid scope_json')
          }
          let parsedScopeJson: unknown
          try {
            parsedScopeJson = JSON.parse(t.scope_json)
          } catch {
            throw new Error('status: malformed scope_json')
          }
          const scopeRes = parseScope(parsedScopeJson)
          if (!scopeRes.ok) {
            throw new Error(`status: invalid scope in task ${String(t.id)}: ${scopeRes.reason}`)
          }
          const scope = scopeRes.scope

          if (
            !Number.isSafeInteger(t.max_attempts as number) ||
            (t.max_attempts as number) < 1 ||
            (t.max_attempts as number) > 10
          ) {
            throw new Error('status: invalid task max_attempts')
          }
          const maxAttempts = Number(t.max_attempts)

          if (
            t.timeout_ms !== null &&
            (!Number.isSafeInteger(t.timeout_ms as number) ||
              (t.timeout_ms as number) < 1000 ||
              (t.timeout_ms as number) > 86400000)
          ) {
            throw new Error('status: invalid task timeout_ms')
          }
          const timeoutMs = t.timeout_ms === null ? null : Number(t.timeout_ms)

          if (!Number.isSafeInteger(t.attempt_base as number) || (t.attempt_base as number) < 0) {
            throw new Error('status: invalid task attempt_base')
          }
          const attemptBase = Number(t.attempt_base)

          if (!Number.isSafeInteger(t.not_before_ms as number) || (t.not_before_ms as number) < 0) {
            throw new Error('status: invalid task not_before_ms')
          }
          const notBeforeMs = Number(t.not_before_ms)

          let phaseName = 'intake'
          if (hasPhaseColumn && t.phase !== undefined && t.phase !== null) {
            if (typeof t.phase !== 'string' || !PHASES.includes(t.phase as PhaseName)) {
              throw new Error(`status: invalid task phase ${String(t.phase)}`)
            }
            phaseName = t.phase
          }

          const dependsOn = [...(depsByTaskId.get(t.id as string) ?? [])].sort()

          const taskItem: TaskStatusItem = {
            id: t.id as string,
            title: t.title as string,
            status: t.status as TaskStatus,
            scope,
            maxAttempts,
            timeoutMs,
            notBeforeMs,
            blockedBy: [],
            phase: phaseName,
            dependsOn,
            waiting: null,
            attempts: attemptsByTaskId.get(t.id as string) ?? [],
          }
          Object.defineProperty(taskItem, 'attemptBase', {
            value: attemptBase,
            enumerable: false,
            writable: true,
            configurable: true,
          })
          tasks.push(taskItem)
        }

        const progressTasks = tasks.filter((t) => t.status === 'progress')
        for (const task of tasks) {
          if (task.status === 'ready') {
            const blockedBy = progressTasks
              .filter((p) => p.id !== task.id && scopesOverlap(task.scope as string[], p.scope as string[]))
              .map((p) => p.id)
            ;(task as { blockedBy: readonly string[] }).blockedBy = blockedBy
          }
        }

        const dispatchTasks: DispatchTask[] = tasks.map((task) => ({
          id: task.id,
          status: task.status,
          phase: task.phase,
          deps: [...task.dependsOn],
          scope: [...task.scope],
          notBeforeMs: task.notBeforeMs,
        }))

        const dispatchPhases: PhaseInfo[] = loadedPhases.length === 5
          ? loadedPhases.map((p) => ({ name: p.name, status: p.status }))
          : PHASES.map((name) => ({ name, status: 'open' }))

        const plan = planDispatch({
          nowMs,
          phases: dispatchPhases,
          tasks: dispatchTasks,
        })

        for (const task of tasks) {
          if (task.status === 'ready') {
            const waitEntry = plan.wait.find((w) => w.id === task.id)
            ;(task as { waiting: TaskWaiting | null }).waiting = waitEntry
              ? { reason: waitEntry.reason, on: waitEntry.on }
              : null
          } else {
            ;(task as { waiting: TaskWaiting | null }).waiting = null
          }
        }
      }

      const phaseTasksCounts = new Map<string, { ready: number; progress: number; blocked: number; failed: number; done: number; dropped: number }>()
      for (const p of PHASES) {
        phaseTasksCounts.set(p, { ready: 0, progress: 0, blocked: 0, failed: 0, done: 0, dropped: 0 })
      }

      for (const t of tasks) {
        const counts = phaseTasksCounts.get(t.phase)
        if (counts) {
          if (t.status === 'ready') counts.ready++
          else if (t.status === 'progress') counts.progress++
          else if (t.status === 'blocked') counts.blocked++
          else if (t.status === 'failed') counts.failed++
          else if (t.status === 'done') counts.done++
          else if (t.status === 'dropped') counts.dropped++
        }
      }

      const phasesList: PhaseStatusItem[] = loadedPhases.map((p) => ({
        name: p.name,
        ord: p.ord,
        status: p.status,
        openedAt: p.opened_at,
        closedAt: p.closed_at,
        tasks: phaseTasksCounts.get(p.name) ?? { ready: 0, progress: 0, blocked: 0, failed: 0, done: 0, dropped: 0 },
      }))

      db.exec('COMMIT')

      const statusObj: Status = hasV5Tables
        ? {
            schemaVersion: SCHEMA_VERSION,
            recordedCommandCount,
            lease,
            commands,
            tasks,
            outbox,
            phases: phasesList,
          }
        : {
            schemaVersion: SCHEMA_VERSION,
            recordedCommandCount,
            lease,
            phases: [],
          }
      return statusObj
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* the failed statement may already have ended the transaction */ }
      throw error
    }
  } finally {
    db.close()
  }
}

function freshnessLabel(freshness: LeaseFreshness): string {
  switch (freshness) {
    case 'fresh':
      return 'حديث (لا يشكل دليلاً على أن العملية قيد التشغيل)'
    case 'stale':
      return 'قديم'
    case 'future':
      return 'في المستقبل'
    case 'not-applicable':
      return 'غير منطبق (تم تحرير الملكية)'
  }
}

function taskStatusLabel(status: TaskStatus): string {
  switch (status) {
    case 'progress':
      return 'قيد التقدم'
    case 'waiting':
      return 'قيد الانتظار'
    case 'ready':
      return 'جاهزة'
    case 'blocked':
      return 'محظورة'
    case 'failed':
      return 'فاشلة'
    case 'dropped':
      return 'متروكة'
    case 'done':
      return 'مكتملة'
  }
}

function attemptStatusLabel(status: AttemptStatus): string {
  switch (status) {
    case 'pending':
      return 'معلقة'
    case 'running':
      return 'قيد التشغيل'
    case 'succeeded':
      return 'ناجحة'
    case 'failed':
      return 'أخفقت'
    case 'interrupted':
      return 'مقاطعة'
    case 'killed':
      return 'تم إنهاؤها'
  }
}

function workerStateLabel(state: WorkerState): string {
  switch (state) {
    case 'starting':
      return 'قيد البدء'
    case 'running':
      return 'يعمل'
    case 'exited':
      return 'خرج'
    case 'killed':
      return 'تم إنهاؤه'
    case 'lost':
      return 'مفقود'
  }
}

function errorClassLabel(errorClass: string): string {
  if (errorClass.startsWith('outbox:')) return `خطأ صندوق الصادر: ${errorClass.slice('outbox:'.length)}`
  switch (errorClass) {
    case 'lost':
      return 'مفقود'
    case 'not-running':
      return 'غير قيد التشغيل'
    case 'identity-mismatch':
      return 'عدم تطابق الهوية'
    case 'killed':
      return 'تم إنهاؤه'
    case 'transient':
      return 'عابر'
    case 'timeout':
      return 'انتهاء المهلة'
    case 'scope-violation':
      return 'انتهاك النطاق'
    case 'exit':
      return 'خروج غير صفري'
    default:
      return errorClass
  }
}

function phaseStatusLabel(status: PhaseStatus): string {
  switch (status) {
    case 'open':
      return 'مفتوحة'
    case 'locked':
      return 'مقفلة'
    case 'done':
      return 'مكتملة'
  }
}

function waitingReasonLabel(reason: string): string {
  switch (reason) {
    case 'phase-locked':
      return 'المرحلة مقفلة'
    case 'deps':
      return 'انتظار الاعتماديات'
    case 'scope':
      return 'تعارض النطاق'
    case 'backoff':
      return 'فترة التراجع'
    default:
      return reason
  }
}

/**
 * Render status facts in Arabic text.
 * Stale heartbeat is described as suspect and never mistaken for a dead process.
 * Takeover evidence is exposed.
 * Command payloads and worker nonces are never included.
 */
export function formatStatus(status: Status): string {
  const lines: string[] = [
    `إصدار المخطط: ${status.schemaVersion}`,
    `عدد الأوامر المسجلة: ${status.recordedCommandCount}`,
  ]
  if (status.lease === null) {
    lines.push('الملكية: غير موجود')
  } else {
    const { ownerId, generation, heartbeatMs, state, freshness } = status.lease
    const stateLabel = state === 'active' ? 'نشط' : 'مُحرَّر'
    const takeoverEvidence =
      (status.lease as { readonly takeover?: string }).takeover ?? `${ownerId}:${generation}:${heartbeatMs}`
    lines.push(
      `الملكية: المالك="${ownerId}", الجيل=${generation}, وقت النبض (Unix timestamp)=${heartbeatMs} ميلي ثانية, الحالة=${stateLabel}, حداثة النبض=${freshnessLabel(freshness)}, دليل الاستحواذ=${takeoverEvidence}`,
    )
  }

  const commands = (status as { readonly commands?: CommandsSummary }).commands
  if (commands !== undefined) {
    lines.push(`الأوامر: مُنفَّذة: ${commands.applied}، مرفوضة: ${commands.rejected}، معلقة: ${commands.pending}`)
  }

  const outbox = (status as { readonly outbox?: OutboxSummary }).outbox
  if (outbox !== undefined && (outbox.pending > 0 || outbox.done > 0 || outbox.failed > 0)) {
    lines.push(`صندوق الصادر: قيد الانتظار: ${outbox.pending}، مُنجَزة: ${outbox.done}، فاشلة: ${outbox.failed}`)
    if (outbox.failedRows && outbox.failedRows.length > 0) {
      for (const row of outbox.failedRows) {
        lines.push(
          `صندوق الصادر (فاشل): المفتاح="${row.key}", النوع="${row.kind}", المحاولات=${row.tries}${row.lastError !== null ? `, الخطأ الأخير="${row.lastError}"` : ''}`,
        )
      }
    }
  }

  const phases = (status as { readonly phases?: readonly PhaseStatusItem[] }).phases
  if (phases !== undefined && phases.length > 0) {
    for (const phase of phases) {
      const stateLabel = phaseStatusLabel(phase.status)
      const openedAt = phase.openedAt ?? 'غير محدد'
      const closedAt = phase.closedAt ?? 'غير محدد'
      const counts = phase.tasks ?? {
        ready: 0,
        progress: 0,
        blocked: 0,
        failed: 0,
        done: 0,
        dropped: 0,
      }
      lines.push(
        `المرحلة: ${phase.name} (الترتيب=${phase.ord})، الحالة=${stateLabel}${phase.status === 'open' ? ' (المرحلة المفتوحة)' : ''}، وقت الفتح=${openedAt}، وقت الإغلاق=${closedAt}، المهام: جاهزة=${counts.ready}، قيد التقدم=${counts.progress}، محظورة=${counts.blocked}، فاشلة=${counts.failed}، مكتملة=${counts.done}، متروكة=${counts.dropped}`,
      )
    }
  }

  const tasks = (status as { readonly tasks?: readonly TaskStatusItem[] }).tasks
  if (tasks !== undefined && tasks.length > 0) {
    for (const task of tasks) {
      const isV6Task = task.scope !== undefined
      let taskLine = `المهمة: المعرف=${task.id}, العنوان="${task.title}", الحالة=${taskStatusLabel(task.status)}`
      if (isV6Task) {
        const attemptBase = (task as { readonly attemptBase?: number }).attemptBase ?? 0
        const attemptsUsed = task.attempts.filter(a => a.no > attemptBase).length
        const maxAttempts = task.maxAttempts ?? 3
        taskLine += `, النطاق=[${task.scope!.join(', ')}], ميزانية المحاولات=${attemptsUsed} / ${maxAttempts}`
        if (task.timeoutMs !== null && task.timeoutMs !== undefined) {
          taskLine += `, المهلة=${task.timeoutMs} ميلي ثانية`
        }
        if (task.notBeforeMs !== undefined && task.notBeforeMs !== null) {
          taskLine += `, وقت عدم البدء قبل=${task.notBeforeMs} ميلي ثانية`
        }
        if (task.phase) {
          taskLine += `, المرحلة=${task.phase}`
        }
      }
      lines.push(taskLine)
      if (task.dependsOn && task.dependsOn.length > 0) {
        lines.push(`المهمة تعتمد على: ${task.dependsOn.join(', ')}`)
      }
      if (isV6Task && task.blockedBy && task.blockedBy.length > 0) {
        lines.push(`المهمة محظورة بواسطة: ${task.blockedBy.join(', ')}`)
      }
      if (task.waiting) {
        lines.push(
          `سبب الانتظار: ${waitingReasonLabel(task.waiting.reason)}${task.waiting.on.length > 0 ? ` (${task.waiting.on.join(', ')})` : ''}`,
        )
      }
      for (const attempt of task.attempts) {
        let attemptLine = `المحاولة #${attempt.no}: الحالة=${attemptStatusLabel(attempt.status)}${attempt.exitCode !== null ? `, رمز الخروج=${attempt.exitCode}` : ''}`
        if (attempt.errorClass) {
          attemptLine += `, فئة الخطأ=${errorClassLabel(attempt.errorClass)}`
        }
        if (attempt.deadlineMs !== null && attempt.deadlineMs !== undefined) {
          attemptLine += `, الموعد النهائي=${attempt.deadlineMs} ميلي ثانية`
        }
        lines.push(attemptLine)
        if (attempt.worker) {
          const isSuspect = Boolean((attempt.worker as { readonly isSuspect?: boolean }).isSuspect)
          const suspectTag = isSuspect ? ' (مشبوه)' : ''
          lines.push(
            `العامل: المعرف=${attempt.worker.pid ?? 'غير محدد'}, الحالة=${workerStateLabel(attempt.worker.state)}${suspectTag}, وقت النبض=${attempt.worker.heartbeatMs ?? 'غير محدد'} ميلي ثانية`,
          )
        }
        if (attempt.evidence) {
          lines.push(`الأدلة: التغيير=${attempt.evidence.headSha}`)
          for (const file of attempt.evidence.files) {
            lines.push(`الملف: ${file.path} (${file.sha256})`)
          }
        }
      }
    }
  }

  return lines.join('\n')
}
