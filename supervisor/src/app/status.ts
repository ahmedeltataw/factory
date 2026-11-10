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

/** Storage schema version this status reader supports: the M3 storage schema (v5). */
const SCHEMA_VERSION = 6

export type LeaseState = 'active' | 'released'
export type LeaseFreshness = 'fresh' | 'stale' | 'future' | 'not-applicable'

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

export interface OutboxSummary {
  readonly pending: number
  readonly done: number
  readonly failed: number
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
}

export interface TaskStatusItem {
  readonly id: string
  readonly title: string
  readonly status: TaskStatus
  readonly attempts: readonly TaskAttempt[]
}

export interface Status {
  readonly schemaVersion: 6
  readonly recordedCommandCount: number
  readonly lease: null | Lease
  readonly commands?: CommandsSummary
  readonly tasks?: readonly TaskStatusItem[]
  readonly outbox?: OutboxSummary
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
      if (tableNames.has('outbox')) {
        const outboxRows = db.prepare('SELECT status, payload_json FROM outbox').all() as Array<{
          readonly status: unknown
          readonly payload_json: unknown
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
          else if (row.status === 'failed') outboxFailed++
        }
      }
      const outbox: OutboxSummary = {
        pending: outboxPending,
        done: outboxDone,
        failed: outboxFailed,
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

      const attemptsByTaskId = new Map<string, TaskAttempt[]>()
      if (tableNames.has('attempts')) {
        const attemptRows = db.prepare('SELECT id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at FROM attempts ORDER BY attempt_no ASC').all() as Array<{
          readonly id: unknown
          readonly task_id: unknown
          readonly attempt_no: unknown
          readonly status: unknown
          readonly exit_code: unknown
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
          const attemptItem: TaskAttempt = {
            no: a.attempt_no,
            status: a.status as AttemptStatus,
            exitCode: a.exit_code === null ? null : Number(a.exit_code),
            worker: workersByAttemptId.get(a.id) ?? null,
            evidence: evidenceByAttemptId.get(a.id) ?? null,
          }
          let list = attemptsByTaskId.get(a.task_id)
          if (!list) {
            list = []
            attemptsByTaskId.set(a.task_id, list)
          }
          list.push(attemptItem)
        }
      }

      const tasks: TaskStatusItem[] = []
      if (tableNames.has('tasks')) {
        const taskRows = db.prepare('SELECT id, project_id, created_by_command, title, status FROM tasks ORDER BY created_at ASC, id ASC').all() as Array<{
          readonly id: unknown
          readonly title: unknown
          readonly status: unknown
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
          tasks.push({
            id: t.id,
            title: t.title,
            status: t.status as TaskStatus,
            attempts: attemptsByTaskId.get(t.id) ?? [],
          })
        }
      }

      db.exec('COMMIT')

      const statusObj: Status = hasV5Tables
        ? {
            schemaVersion: SCHEMA_VERSION,
            recordedCommandCount,
            lease,
            commands,
            tasks,
            outbox,
          }
        : {
            schemaVersion: SCHEMA_VERSION,
            recordedCommandCount,
            lease,
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
  }

  const tasks = (status as { readonly tasks?: readonly TaskStatusItem[] }).tasks
  if (tasks !== undefined && tasks.length > 0) {
    for (const task of tasks) {
      lines.push(`المهمة: المعرف=${task.id}, العنوان="${task.title}", الحالة=${taskStatusLabel(task.status)}`)
      for (const attempt of task.attempts) {
        lines.push(
          `المحاولة #${attempt.no}: الحالة=${attemptStatusLabel(attempt.status)}${attempt.exitCode !== null ? `, رمز الخروج=${attempt.exitCode}` : ''}`,
        )
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
