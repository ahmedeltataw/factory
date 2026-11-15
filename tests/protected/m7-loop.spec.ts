import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openStore } from '../../supervisor/src/app/store.ts'
import { acquireSupervisor, type SupervisorLeaseHandle } from '../../supervisor/src/app/supervisor-lease.ts'
import { runTick, type LoopDeps } from '../../supervisor/src/app/supervisor-loop.ts'
import { finishAttempt, reconcileWorkers, failExhaustedEffects, scheduleAttempt } from '../../supervisor/src/app/recovery.ts'
import { parseFault, type FaultName } from '../../supervisor/src/app/faults.ts'
import { check, closeReservation, reserve } from '../../supervisor/src/app/quota.ts'
import { createEffectHandlers } from '../../supervisor/src/app/outbox.ts'

type ScheduleAttemptFn = (
  db: DatabaseSync,
  handle: SupervisorLeaseHandle,
  taskId: string,
  stateDir: string,
  nowMs: number,
) => { ok: true } | { ok: false; reason: 'quota' | 'budget' | 'max-attempts' }

type ReserveFn = (
  db: DatabaseSync,
  handle: SupervisorLeaseHandle,
  taskId: string,
  attemptId: string,
  nowMs: number,
) => { ok: true } | { ok: false; reason: 'quota' | 'budget'; retryAtMs: number | null } | void

const schedule = scheduleAttempt as unknown as ScheduleAttemptFn
const doReserve = reserve as unknown as ReserveFn

const directories: string[] = []

function makeTempDir(prefix = 'factory-m7-loop-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  directories.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of directories.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    } catch {}
  }
})

function createGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  spawnSync('git', ['init', dir], { stdio: 'ignore', timeout: 15000 })
  spawnSync('git', ['-C', dir, '-c', 'user.name=Factory Test', '-c', 'user.email=factory@example.test', 'config', 'core.autocrlf', 'false'], { stdio: 'ignore' })
  writeFileSync(join(dir, 'README.md'), '# test\n', 'utf8')
  spawnSync('git', ['-C', dir, '-c', 'user.name=Factory Test', '-c', 'user.email=factory@example.test', 'add', '.'], { stdio: 'ignore' })
  spawnSync('git', ['-C', dir, '-c', 'user.name=Factory Test', '-c', 'user.email=factory@example.test', 'commit', '-m', 'initial commit'], { stdio: 'ignore' })
  spawnSync('git', ['-C', dir, 'branch', '-M', 'main'], { stdio: 'ignore' })
}

function setupEnvironment(stateDir: string, projectId = 'p1'): { db: DatabaseSync; repoDir: string } {
  const repoDir = join(stateDir, 'repo')
  createGitRepo(repoDir)
  const dbPath = join(stateDir, 'state.sqlite')
  const db = openStore(dbPath)
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000')
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, 'Project', 'now')").run(projectId)
  db.prepare("INSERT INTO project_config (project_id, repo_path, base_ref, created_at) VALUES (?, ?, 'main', 'now')").run(projectId, repoDir)
  db.prepare("INSERT INTO phases (project_id, name, ord, status, opened_at) VALUES (?, 'intake', 1, 'open', 'now')").run(projectId)
  db.prepare("INSERT INTO phases (project_id, name, ord, status) VALUES (?, 'development', 2, 'locked')").run(projectId)
  db.prepare("INSERT INTO phases (project_id, name, ord, status) VALUES (?, 'qa', 3, 'locked')").run(projectId)
  db.prepare("INSERT INTO phases (project_id, name, ord, status) VALUES (?, 'devops', 4, 'locked')").run(projectId)
  db.prepare("INSERT INTO phases (project_id, name, ord, status) VALUES (?, 'handover', 5, 'locked')").run(projectId)
  return { db, repoDir }
}

function createTask(
  db: DatabaseSync,
  taskId: string,
  projectId = 'p1',
  options: {
    status?: string
    provider?: string
    phase?: string
    scope?: string[]
    maxAttempts?: number
    notBeforeMs?: number
  } = {},
): void {
  const commandId = randomUUID()
  db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES (?, ?, 'task.create', '{}', 'now')").run(commandId, projectId)
  db.prepare("INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at) VALUES (?, 'applied', NULL, 1, 'now')").run(commandId)
  db.prepare(`
    INSERT INTO tasks (
      id, project_id, created_by_command, title, status, phase, scope_json, max_attempts, not_before_ms, provider, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'now', 'now')
  `).run(
    taskId,
    projectId,
    commandId,
    `Task ${taskId}`,
    options.status ?? 'ready',
    options.phase ?? 'intake',
    JSON.stringify(options.scope ?? [taskId]),
    options.maxAttempts ?? 3,
    options.notBeforeMs ?? 0,
    options.provider ?? 'default',
  )
}

function createAttempt(
  db: DatabaseSync,
  attemptId: string,
  taskId: string,
  options: {
    attemptNo?: number
    status?: string
    generation?: number
    deadlineMs?: number | null
  } = {},
): void {
  db.prepare(`
    INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation, started_at, deadline_ms)
    VALUES (?, ?, ?, ?, ?, 'now', ?)
  `).run(
    attemptId,
    taskId,
    options.attemptNo ?? 1,
    options.status ?? 'pending',
    options.generation ?? 1,
    options.deadlineMs ?? null,
  )
}

function insertReservation(
  db: DatabaseSync,
  id: string,
  projectId: string,
  attemptId: string,
  provider: string,
  state: 'reserved' | 'settled' | 'released',
  reservedAtMs: number,
  closedAtMs: number | null = null,
): void {
  db.prepare(`
    INSERT INTO quota_reservations (
      id, project_id, attempt_id, provider, units, state, reserved_at_ms, closed_at_ms
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
  `).run(id, projectId, attemptId, provider, state, reservedAtMs, closedAtMs)
}

function createTestDeps(options: {
  stateDir: string
  spawnWorker?: LoopDeps['spawnWorker']
  isAlive?: LoopDeps['isAlive']
  readResult?: LoopDeps['readResult']
  killTree?: LoopDeps['killTree']
}): LoopDeps {
  return {
    stateDir: options.stateDir,
    staleAfterMs: 300000,
    spawnWorker: options.spawnWorker ?? (async ({ attemptId }) => ({ pid: 100, nonce: `nonce-${attemptId}` })),
    isAlive: options.isAlive ?? (() => true),
    readResult: options.readResult ?? (() => undefined),
    killTree: options.killTree ?? (async () => ({ result: 'killed' as const })),
  }
}

describe('M7-03 loop wiring contracts', () => {
  it('CHK-M7-03-b: loop with maxParallel 2 and 5 ready non-overlapping tasks never has more than 2 progress tasks and completing one starts the next', async () => {
    const stateDir = makeTempDir()
    const { db } = setupEnvironment(stateDir)
    try {
      const handle = acquireSupervisor(db, stateDir, { nowMs: 1000, staleAfterMs: 300000 })
      const deps = createTestDeps({ stateDir })

      // Set max_parallel = 2
      db.prepare("INSERT INTO project_limits (project_id, max_parallel, updated_at) VALUES ('p1', 2, 'now')").run()

      // 5 ready tasks with disjoint scopes
      for (let i = 1; i <= 5; i++) {
        createTask(db, `t${i}`, 'p1', { scope: [`dir-${i}`] })
      }

      // Tick 1 at nowMs = 1000: dispatch tasks
      await runTick(db, handle, deps, 1000)

      const progressCount1 = (db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = 'progress'").get() as { c: number }).c
      const readyCount1 = (db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = 'ready'").get() as { c: number }).c
      expect(progressCount1).toBe(2)
      expect(readyCount1).toBe(3)

      // Get one of the progress tasks and complete it
      const progressTasks = db.prepare("SELECT id FROM tasks WHERE status = 'progress' ORDER BY id").all() as Array<{ id: string }>
      expect(progressTasks.length).toBe(2)
      const finishedTaskId = progressTasks[0]!.id
      const attemptRow = db.prepare("SELECT id FROM attempts WHERE task_id = ?").get(finishedTaskId) as { id: string }

      // Complete finishedTaskId: finishAttempt with exit code 0
      finishAttempt(db, handle, { id: attemptRow.id, task_id: finishedTaskId, worktree_path: null }, stateDir, 0, 1500)
      db.prepare("UPDATE tasks SET status = 'done', updated_at = 'now' WHERE id = ?").run(finishedTaskId)

      // Tick 2 at nowMs = 2000: one slot freed, next ready task dispatches
      await runTick(db, handle, deps, 2000)

      const progressCount2 = (db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = 'progress'").get() as { c: number }).c
      const doneCount2 = (db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = 'done'").get() as { c: number }).c
      const readyCount2 = (db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = 'ready'").get() as { c: number }).c

      expect(progressCount2).toBe(2)
      expect(doneCount2).toBe(1)
      expect(readyCount2).toBe(2)
    } finally {
      db.close()
    }
  })

  it('CHK-M7-03-c: quota exhausted: the task stays ready, no attempt row, status wait quota with retryAtMs; after the window moves it dispatches; the loop is not idle while retryAtMs is set (a budget wait is idle)', async () => {
    const stateDir = makeTempDir()
    const { db } = setupEnvironment(stateDir)
    try {
      const handle = acquireSupervisor(db, stateDir, { nowMs: 1000, staleAfterMs: 300000 })
      const deps = createTestDeps({ stateDir })

      // Provider window: max_units = 1, window_ms = 10000
      db.prepare("INSERT INTO quota_windows (project_id, provider, window_ms, max_units, updated_at) VALUES ('p1', 'default', 10000, 1, 'now')").run()

      // Seed an existing settled reservation at nowMs = 2000 (leaves window at 12000)
      createTask(db, 't-seed', 'p1', { status: 'done', provider: 'default' })
      createAttempt(db, 'a-seed', 't-seed', { status: 'succeeded' })
      insertReservation(db, 'r-seed', 'p1', 'a-seed', 'default', 'settled', 2000, 2500)

      // Ready task to dispatch
      createTask(db, 't1', 'p1', { provider: 'default' })

      // 1. Tick at nowMs = 3000: quota is exhausted
      const tickQuota = await runTick(db, handle, deps, 3000)

      const taskRow1 = db.prepare("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string }
      expect(taskRow1.status).toBe('ready')

      const attempts1 = db.prepare("SELECT * FROM attempts WHERE task_id = 't1'").all()
      expect(attempts1).toEqual([])

      const checkState = check(db, 't1', 3000)
      expect(checkState).toEqual({ ok: false, reason: 'quota', retryAtMs: 12000 })

      // Quota wait with retryAtMs keeps the loop busy (not idle)
      expect(tickQuota.idle).toBe(false)

      // 2. Budget wait: idle rule test
      // Clear quota windows and insert a budget cap that is exhausted
      db.prepare("DELETE FROM quota_windows WHERE project_id = 'p1'").run()
      db.prepare("INSERT INTO budget_caps (project_id, level, key, cap_units, updated_at) VALUES ('p1', 'project', '', 1, 'now')").run()

      // At nowMs = 3000, r-seed counts 1 unit for project budget cap of 1
      const tickBudget = await runTick(db, handle, deps, 3000)

      const budgetCheck = check(db, 't1', 3000)
      expect(budgetCheck).toEqual({ ok: false, reason: 'budget', retryAtMs: null })

      // A budget wait has retryAtMs = null, so it does NOT keep loop busy (idle = true)
      expect(tickBudget.idle).toBe(true)

      // 3. After the window moves it dispatches
      // Restore quota window and remove budget cap
      db.prepare("DELETE FROM budget_caps WHERE project_id = 'p1'").run()
      db.prepare("INSERT INTO quota_windows (project_id, provider, window_ms, max_units, updated_at) VALUES ('p1', 'default', 10000, 1, 'now')").run()

      // At nowMs = 12001 (strictly past 12000 retryAtMs), reservation at 2000 leaves window
      const tickDispatched = await runTick(db, handle, deps, 12001)

      const taskRow2 = db.prepare("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string }
      expect(taskRow2.status).toBe('progress')

      const attempts2 = db.prepare("SELECT * FROM attempts WHERE task_id = 't1'").all()
      expect(attempts2.length).toBe(1)
      expect(tickDispatched.idle).toBe(false)
    } finally {
      db.close()
    }
  })

  it('CHK-M7-03-d: crash seam quota-after-reserve: restart reconciles to one attempt and one reserved row, no double count; a worker lost before start gives released', async () => {
    // 1. Fault name parsing
    expect(parseFault('quota-after-reserve')).toBe('quota-after-reserve')

    const stateDir = makeTempDir()
    const { db } = setupEnvironment(stateDir)
    try {
      const deps = createTestDeps({
        stateDir,
        killTree: async () => ({ result: 'not-running' as const }),
      })

      // Simulate crash seam: reserve committed in generation 1, attempt pending, worker NOT yet started
      const handle1 = acquireSupervisor(db, stateDir, { nowMs: 1000, staleAfterMs: 300000 })
      createTask(db, 't1', 'p1', { status: 'progress', provider: 'default' })
      createAttempt(db, 'a1', 't1', { attemptNo: 1, status: 'pending', generation: handle1.generation })
      insertReservation(db, 'r1', 'p1', 'a1', 'default', 'reserved', 1000)
      // Pending outbox effect for attempt.start
      db.prepare(`
        INSERT INTO outbox (id, idempotency_key, kind, payload_json, status, tries, next_attempt_ms, created_at, updated_at)
        VALUES ('o1', 'attempt.start:a1', 'attempt.start', ?, 'pending', 0, 0, 'now', 'now')
      `).run(JSON.stringify({ attemptId: 'a1', taskId: 't1' }))

      // Restart supervisor in generation 2
      handle1.release(2000)
      const handle2 = acquireSupervisor(db, stateDir, { nowMs: 2000, staleAfterMs: 300000 })
      await reconcileWorkers(db, handle2, deps, 2000)

      // Verification:
      // a. The worker lost before start gives 'released' on r1
      const oldRes = db.prepare("SELECT state, closed_at_ms FROM quota_reservations WHERE id = 'r1'").get() as { state: string; closed_at_ms: number }
      expect(oldRes.state).toBe('released')
      expect(oldRes.closed_at_ms).toBe(2000)

      const oldAttempt = db.prepare("SELECT status FROM attempts WHERE id = 'a1'").get() as { status: string }
      expect(['interrupted', 'killed']).toContain(oldAttempt.status)

      // b. Restart reconciles to exactly one live attempt and one 'reserved' row (no double count)
      const liveAttempts = db.prepare("SELECT id, status FROM attempts WHERE task_id = 't1' AND status IN ('pending', 'running')").all() as Array<{ id: string; status: string }>
      expect(liveAttempts.length).toBe(1)
      const newAttemptId = liveAttempts[0]!.id
      expect(newAttemptId).not.toBe('a1')

      const reservedRows = db.prepare("SELECT * FROM quota_reservations WHERE state = 'reserved'").all() as Array<{ attempt_id: string; state: string }>
      expect(reservedRows.length).toBe(1)
      expect(reservedRows[0]!.attempt_id).toBe(newAttemptId)
    } finally {
      db.close()
    }
  })

  it('CHK-M7-03-e: no limits configured: the loop behaves as in M6 (no gates, no slots; idle rule unchanged)', async () => {
    const stateDir = makeTempDir()
    const { db } = setupEnvironment(stateDir)
    try {
      const handle = acquireSupervisor(db, stateDir, { nowMs: 1000, staleAfterMs: 300000 })
      const deps = createTestDeps({ stateDir })

      // Empty project_limits, quota_windows, budget_caps
      expect(db.prepare("SELECT COUNT(*) as c FROM project_limits").get()).toEqual({ c: 0 })
      expect(db.prepare("SELECT COUNT(*) as c FROM quota_windows").get()).toEqual({ c: 0 })
      expect(db.prepare("SELECT COUNT(*) as c FROM budget_caps").get()).toEqual({ c: 0 })

      // Create ready tasks with disjoint scopes
      createTask(db, 't1', 'p1', { scope: ['dir-1'] })
      createTask(db, 't2', 'p1', { scope: ['dir-2'] })

      // Tick 1 dispatches both tasks without gates or slot limits
      const tick1 = await runTick(db, handle, deps, 1000)
      expect(tick1.idle).toBe(false)

      const tasksProgress = db.prepare("SELECT id FROM tasks WHERE status = 'progress' ORDER BY id").all() as Array<{ id: string }>
      expect(tasksProgress.map((t) => t.id)).toEqual(['t1', 't2'])

      // Direct scheduleAttempt callers keep working and succeed
      createTask(db, 't3', 'p1', { scope: ['dir-3'] })
      const resSchedule = schedule(db, handle, 't3', stateDir, 1000)
      expect(resSchedule).toEqual({ ok: true })
      expect((db.prepare("SELECT status FROM tasks WHERE id = 't3'").get() as { status: string }).status).toBe('progress')

      // Mark all attempts succeeded and tasks done
      db.prepare("UPDATE tasks SET status = 'done', updated_at = 'now' WHERE status = 'progress'").run()
      db.prepare("UPDATE outbox SET status = 'done', updated_at = 'now' WHERE status = 'pending'").run()

      // When no pending work, loop is idle
      const tickIdle = await runTick(db, handle, deps, 2000)
      expect(tickIdle.idle).toBe(true)
    } finally {
      db.close()
    }
  })

  it('CHK-M7-03-g: restart with a lost worker and exhausted quota: the old attempt is interrupted, its reservation settled, the task ready, no new attempt; with quota free: one new attempt and one new reserved row', async () => {
    const stateDir = makeTempDir()
    const { db } = setupEnvironment(stateDir)
    try {
      const deps = createTestDeps({
        stateDir,
        killTree: async () => ({ result: 'not-running' as const }),
        readResult: () => undefined,
      })

      // Quota window: max_units = 1, window_ms = 60000
      db.prepare("INSERT INTO quota_windows (project_id, provider, window_ms, max_units, updated_at) VALUES ('p1', 'default', 60000, 1, 'now')").run()

      // Generation 1: attempt was running with an active worker
      const handle1 = acquireSupervisor(db, stateDir, { nowMs: 1000, staleAfterMs: 300000 })
      createTask(db, 't1', 'p1', { status: 'progress', provider: 'default' })
      createAttempt(db, 'a1', 't1', { attemptNo: 1, status: 'running', generation: handle1.generation })
      db.prepare("INSERT INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at) VALUES ('a1', 'nonce-w1', 1234, 'running', '/w', 1000, 'now')").run()
      insertReservation(db, 'r1', 'p1', 'a1', 'default', 'reserved', 1000)

      // Restart supervisor in generation 2 at nowMs = 2000
      handle1.release(2000)
      const handle2 = acquireSupervisor(db, stateDir, { nowMs: 2000, staleAfterMs: 300000 })
      await reconcileWorkers(db, handle2, deps, 2000)

      // 1. Quota exhausted:
      // Old attempt is interrupted
      const attempt1 = db.prepare("SELECT status FROM attempts WHERE id = 'a1'").get() as { status: string }
      expect(attempt1.status).toBe('interrupted')

      // Reservation settled (because worker existed)
      const res1 = db.prepare("SELECT state, closed_at_ms FROM quota_reservations WHERE id = 'r1'").get() as { state: string; closed_at_ms: number }
      expect(res1.state).toBe('settled')
      expect(res1.closed_at_ms).toBe(2000)

      // Task is ready
      const task1 = db.prepare("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string }
      expect(task1.status).toBe('ready')

      // No new attempt created because quota is exhausted (1 unit settled in window <= 1 max_units)
      const attemptsCount1 = (db.prepare("SELECT COUNT(*) as c FROM attempts WHERE task_id = 't1'").get() as { c: number }).c
      expect(attemptsCount1).toBe(1)

      const reservedCount1 = (db.prepare("SELECT COUNT(*) as c FROM quota_reservations WHERE state = 'reserved'").get() as { c: number }).c
      expect(reservedCount1).toBe(0)

      // 2. With quota free: advance time past the 60000ms window (nowMs = 62000)
      const resFree = schedule(db, handle2, 't1', stateDir, 62000)
      expect(resFree).toEqual({ ok: true })

      // One new attempt created
      const attempts2 = db.prepare("SELECT id, status FROM attempts WHERE task_id = 't1' ORDER BY attempt_no").all() as Array<{ id: string; status: string }>
      expect(attempts2.length).toBe(2)
      expect(attempts2[1]!.status).toBe('pending')

      // Exactly one new reserved row
      const reservedRows2 = db.prepare("SELECT * FROM quota_reservations WHERE state = 'reserved'").all() as Array<{ attempt_id: string; state: string }>
      expect(reservedRows2.length).toBe(1)
      expect(reservedRows2[0]!.attempt_id).toBe(attempts2[1]!.id)
    } finally {
      db.close()
    }
  })

  it('CHK-M7-03-h: table part: kill running attempt gives settled, kill pending gives released, outbox-exhausted gives released, worker-liveness timeout and lost give settled, superseded attempt.start gives released', async () => {
    const stateDir = makeTempDir()
    const { db } = setupEnvironment(stateDir)
    try {
      const handle = acquireSupervisor(db, stateDir, { nowMs: 1000, staleAfterMs: 300000 })
      const deps = createTestDeps({ stateDir })
      const handlers = createEffectHandlers({ db, spawnWorker: deps.spawnWorker })

      // 1. Kill a running attempt gives settled and counts
      db.prepare("INSERT INTO quota_windows (project_id, provider, window_ms, max_units, updated_at) VALUES ('p1', 'p-kill-run', 10000, 1, 'now')").run()
      createTask(db, 't-kill-run', 'p1', { status: 'progress', provider: 'p-kill-run' })
      createAttempt(db, 'a-kill-run', 't-kill-run', { status: 'running', generation: handle.generation })
      db.prepare("INSERT INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at) VALUES ('a-kill-run', 'nonce-kr', 101, 'running', '/w', 1000, 'now')").run()
      insertReservation(db, 'r-kill-run', 'p1', 'a-kill-run', 'p-kill-run', 'reserved', 1000)
      db.prepare(`
        INSERT INTO outbox (id, idempotency_key, kind, payload_json, status, tries, next_attempt_ms, created_at, updated_at)
        VALUES ('o-kill-run', 'attempt.kill:a-kill-run', 'attempt.kill', ?, 'pending', 0, 1000, 'now', 'now')
      `).run(JSON.stringify({ attemptId: 'a-kill-run' }))

      await runTick(db, handle, deps, 1500)
      expect(db.prepare("SELECT status FROM attempts WHERE id = 'a-kill-run'").get()).toEqual({ status: 'killed' })
      expect(db.prepare("SELECT state FROM quota_reservations WHERE id = 'r-kill-run'").get()).toEqual({ state: 'settled' })
      // Settled counts against quota
      expect(check(db, 't-kill-run', 2000)).toEqual({ ok: false, reason: 'quota', retryAtMs: 11000 })

      // 2. Kill a pending attempt gives released and does not count
      db.prepare("INSERT INTO quota_windows (project_id, provider, window_ms, max_units, updated_at) VALUES ('p1', 'p-kill-pen', 10000, 1, 'now')").run()
      createTask(db, 't-kill-pen', 'p1', { status: 'progress', provider: 'p-kill-pen' })
      createAttempt(db, 'a-kill-pen', 't-kill-pen', { status: 'pending', generation: handle.generation })
      insertReservation(db, 'r-kill-pen', 'p1', 'a-kill-pen', 'p-kill-pen', 'reserved', 1000)
      db.prepare(`
        INSERT INTO outbox (id, idempotency_key, kind, payload_json, status, tries, next_attempt_ms, created_at, updated_at)
        VALUES ('o-kill-pen', 'attempt.kill:a-kill-pen', 'attempt.kill', ?, 'pending', 0, 1000, 'now', 'now')
      `).run(JSON.stringify({ attemptId: 'a-kill-pen' }))

      await runTick(db, handle, deps, 1600)
      expect(db.prepare("SELECT status FROM attempts WHERE id = 'a-kill-pen'").get()).toEqual({ status: 'killed' })
      expect(db.prepare("SELECT state FROM quota_reservations WHERE id = 'r-kill-pen'").get()).toEqual({ state: 'released' })
      // Released does not count against quota
      expect(check(db, 't-kill-pen', 2000)).toEqual({ ok: true })

      // 3. An outbox-exhausted attempt gives released
      createTask(db, 't-exhausted', 'p1', { status: 'progress', provider: 'default' })
      createAttempt(db, 'a-exhausted', 't-exhausted', { status: 'pending' })
      insertReservation(db, 'r-exhausted', 'p1', 'a-exhausted', 'default', 'reserved', 1000)
      db.prepare(`
        INSERT INTO outbox (id, idempotency_key, kind, payload_json, status, tries, next_attempt_ms, created_at, updated_at)
        VALUES ('o-ex', 'worktree.ensure:a-exhausted', 'worktree.ensure', '{}', 'failed', 3, 0, 'now', 'now')
      `).run()

      failExhaustedEffects(db, handle, 2000)
      expect(db.prepare("SELECT status FROM attempts WHERE id = 'a-exhausted'").get()).toEqual({ status: 'failed' })
      expect(db.prepare("SELECT state FROM quota_reservations WHERE id = 'r-exhausted'").get()).toEqual({ state: 'released' })

      // 4a. Worker-liveness timeout gives settled
      createTask(db, 't-timeout', 'p1', { status: 'progress', provider: 'default' })
      createAttempt(db, 'a-timeout', 't-timeout', { status: 'running', deadlineMs: 2000 })
      db.prepare("INSERT INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at) VALUES ('a-timeout', 'nonce-to', 201, 'running', '/w', 1000, 'now')").run()
      insertReservation(db, 'r-timeout', 'p1', 'a-timeout', 'default', 'reserved', 1000)

      // Tick at nowMs = 2500 (past deadline 2000)
      await runTick(db, handle, deps, 2500)
      expect(db.prepare("SELECT status, error_class FROM attempts WHERE id = 'a-timeout'").get()).toEqual({
        status: 'interrupted',
        error_class: 'timeout',
      })
      expect(db.prepare("SELECT state FROM quota_reservations WHERE id = 'r-timeout'").get()).toEqual({ state: 'settled' })

      // 4b. Lost worker gives settled
      createTask(db, 't-lost', 'p1', { status: 'progress', provider: 'default' })
      createAttempt(db, 'a-lost', 't-lost', { status: 'running' })
      db.prepare("INSERT INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at) VALUES ('a-lost', 'nonce-lost', 301, 'running', '/w', 1000, 'now')").run()
      insertReservation(db, 'r-lost', 'p1', 'a-lost', 'default', 'reserved', 1000)

      const lostDeps = createTestDeps({
        stateDir,
        isAlive: () => false,
        readResult: () => undefined,
      })
      await runTick(db, handle, lostDeps, 3000)
      expect(db.prepare("SELECT status, error_class FROM attempts WHERE id = 'a-lost'").get()).toEqual({
        status: 'interrupted',
        error_class: 'lost',
      })
      expect(db.prepare("SELECT state FROM quota_reservations WHERE id = 'r-lost'").get()).toEqual({ state: 'settled' })

      // 5. The superseded path of attempt.start gives released
      createTask(db, 't-superseded', 'p1', { status: 'dropped', provider: 'default' })
      createAttempt(db, 'a-superseded', 't-superseded', { status: 'pending', generation: handle.generation })
      insertReservation(db, 'r-superseded', 'p1', 'a-superseded', 'default', 'reserved', 1000)
      db.prepare(`
        INSERT INTO outbox (id, idempotency_key, kind, payload_json, status, tries, next_attempt_ms, created_at, updated_at)
        VALUES ('o-superseded', 'attempt.start:a-superseded', 'attempt.start', ?, 'pending', 0, 1000, 'now', 'now')
      `).run(JSON.stringify({ attemptId: 'a-superseded', taskId: 't-superseded' }))

      await runTick(db, handle, deps, 3200)
      expect(db.prepare("SELECT status FROM attempts WHERE id = 'a-superseded'").get()).toEqual({ status: 'interrupted' })
      expect(db.prepare("SELECT state FROM quota_reservations WHERE id = 'r-superseded'").get()).toEqual({ state: 'released' })
    } finally {
      db.close()
    }
  })
})
