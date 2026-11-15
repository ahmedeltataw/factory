import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { openStore } from '../../supervisor/src/app/store.ts'
import { acquireSupervisor, type SupervisorLeaseHandle } from '../../supervisor/src/app/supervisor-lease.ts'
import { check, reserve, closeReservation } from '../../supervisor/src/app/quota.ts'
import { scheduleAttempt } from '../../supervisor/src/app/recovery.ts'

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

function makeStateDir(prefix = 'factory-m7-quota-'): string {
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

function setupProject(db: DatabaseSync, projectId = 'p1', repoDir = '/repo'): void {
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, 'Project', 'now')").run(projectId)
  db.prepare("INSERT INTO project_config (project_id, repo_path, base_ref, created_at) VALUES (?, ?, 'main', 'now')").run(projectId, repoDir)
  db.prepare("INSERT INTO phases (project_id, name, ord, status, opened_at) VALUES (?, 'intake', 1, 'open', 'now')").run(projectId)
  db.prepare("INSERT INTO phases (project_id, name, ord, status) VALUES (?, 'development', 2, 'locked')").run(projectId)
  db.prepare("INSERT INTO phases (project_id, name, ord, status) VALUES (?, 'qa', 3, 'locked')").run(projectId)
  db.prepare("INSERT INTO phases (project_id, name, ord, status) VALUES (?, 'devops', 4, 'locked')").run(projectId)
  db.prepare("INSERT INTO phases (project_id, name, ord, status) VALUES (?, 'handover', 5, 'locked')").run(projectId)
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
  } = {},
): void {
  db.prepare(`
    INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation, started_at)
    VALUES (?, ?, ?, ?, ?, 'now')
  `).run(
    attemptId,
    taskId,
    options.attemptNo ?? 1,
    options.status ?? 'pending',
    options.generation ?? 1,
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

describe('M7-03 quota ledger contracts', () => {
  it('CHK-M7-03-a: reserve/settle/release table: window boundary, exact max_units, per-provider isolation, release/settle, duplicate rejection, retryAtMs and budget null', () => {
    const dir = makeStateDir()
    const dbPath = join(dir, 'state.sqlite')
    const db = openStore(dbPath)
    try {
      setupProject(db, 'p1')
      const handle = acquireSupervisor(db, dir, { nowMs: 1000, staleAfterMs: 300000 })

      // 1. Window boundary: a reservation made exactly window_ms ago no longer counts
      // Window is 5000ms, max_units is 1
      db.prepare("INSERT INTO quota_windows (project_id, provider, window_ms, max_units, updated_at) VALUES ('p1', 'default', 5000, 1, 'now')").run()
      createTask(db, 't1', 'p1', { provider: 'default' })
      createAttempt(db, 'a1', 't1')
      insertReservation(db, 'r1', 'p1', 'a1', 'default', 'settled', 1000)

      // At nowMs = 5999 (1000 > 5999 - 5000 = 999): reservation still counts
      expect(check(db, 't1', 5999)).toEqual({ ok: false, reason: 'quota', retryAtMs: 6000 })

      // At nowMs = 6000 (1000 > 6000 - 5000 = 1000 is FALSE): reservation no longer counts
      expect(check(db, 't1', 6000)).toEqual({ ok: true })

      // 2. Exact max_units accepted and max_units + 1 refused
      db.prepare("UPDATE quota_windows SET window_ms = 10000, max_units = 2 WHERE project_id = 'p1' AND provider = 'default'").run()
      db.prepare("DELETE FROM quota_reservations WHERE id = 'r1'").run()

      createTask(db, 't2', 'p1', { provider: 'default' })
      createAttempt(db, 'a2', 't2')
      createTask(db, 't3', 'p1', { provider: 'default' })
      createAttempt(db, 'a3', 't3')

      // First unit accepted
      expect(check(db, 't1', 1000)).toEqual({ ok: true })
      const res1 = doReserve(db, handle, 't1', 'a1', 1000)
      if (res1) expect(res1).toEqual({ ok: true })
      expect(db.prepare("SELECT state FROM quota_reservations WHERE attempt_id = 'a1'").get()).toEqual({ state: 'reserved' })

      // Second unit accepted
      expect(check(db, 't2', 1000)).toEqual({ ok: true })
      const res2 = doReserve(db, handle, 't2', 'a2', 1000)
      if (res2) expect(res2).toEqual({ ok: true })
      expect(db.prepare("SELECT state FROM quota_reservations WHERE attempt_id = 'a2'").get()).toEqual({ state: 'reserved' })

      // Third unit (max_units + 1) refused
      const checkFull = check(db, 't3', 1000)
      expect(checkFull).toEqual({ ok: false, reason: 'quota', retryAtMs: 11000 })
      let thirdRefused = false
      try {
        const res3 = doReserve(db, handle, 't3', 'a3', 1000)
        if (res3 && res3.ok === false) thirdRefused = true
      } catch {
        thirdRefused = true
      }
      expect(thirdRefused).toBe(true)
      expect(db.prepare("SELECT 1 FROM quota_reservations WHERE attempt_id = 'a3'").get()).toBeUndefined()

      // 3. Per-provider isolation
      db.prepare("INSERT INTO quota_windows (project_id, provider, window_ms, max_units, updated_at) VALUES ('p1', 'other', 10000, 1, 'now')").run()
      createTask(db, 't-other', 'p1', { provider: 'other' })
      createAttempt(db, 'a-other', 't-other')

      // 'default' is full, but 'other' has available capacity
      expect(check(db, 't3', 1000)).toEqual({ ok: false, reason: 'quota', retryAtMs: 11000 })
      expect(check(db, 't-other', 1000)).toEqual({ ok: true })
      const resOther = doReserve(db, handle, 't-other', 'a-other', 1000)
      if (resOther) expect(resOther).toEqual({ ok: true })
      expect(db.prepare("SELECT state FROM quota_reservations WHERE attempt_id = 'a-other'").get()).toEqual({ state: 'reserved' })

      // 4. Release frees the unit
      // Currently 'other' provider has 1/1 used. Release it:
      closeReservation(db, 'a-other', 1500)
      expect(db.prepare("SELECT state, closed_at_ms FROM quota_reservations WHERE attempt_id = 'a-other'").get()).toEqual({
        state: 'released',
        closed_at_ms: 1500,
      })
      // 'other' is now free again
      createTask(db, 't-other2', 'p1', { provider: 'other' })
      createAttempt(db, 'a-other2', 't-other2')
      expect(check(db, 't-other2', 1500)).toEqual({ ok: true })

      // 5. Settle keeps it
      // Create a worker for 'a-other2', reserve it, then closeReservation:
      doReserve(db, handle, 't-other2', 'a-other2', 1500)
      db.prepare("INSERT INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at) VALUES ('a-other2', 'n1', 111, 'running', '/w', 1500, 'now')").run()
      closeReservation(db, 'a-other2', 2000)
      expect(db.prepare("SELECT state, closed_at_ms FROM quota_reservations WHERE attempt_id = 'a-other2'").get()).toEqual({
        state: 'settled',
        closed_at_ms: 2000,
      })
      // Settle keeps the unit counted in the window
      createTask(db, 't-other3', 'p1', { provider: 'other' })
      expect(check(db, 't-other3', 2000)).toEqual({ ok: false, reason: 'quota', retryAtMs: 11500 })

      // 6. A second reserve for one attempt is rejected
      let duplicateRejected = false
      try {
        const dupRes = doReserve(db, handle, 't1', 'a1', 1000)
        if (dupRes && dupRes.ok === false) duplicateRejected = true
      } catch {
        duplicateRejected = true
      }
      expect(duplicateRejected).toBe(true)

      // 7. retryAtMs = when oldest counted reservation leaves window
      // 'default' provider window is 10000ms.
      // Reset reservations to known times: r1 at 2000, r2 at 4000
      db.prepare("DELETE FROM quota_reservations WHERE project_id = 'p1' AND provider = 'default'").run()
      insertReservation(db, 'r-old', 'p1', 'a1', 'default', 'settled', 2000)
      insertReservation(db, 'r-new', 'p1', 'a2', 'default', 'settled', 4000)
      // At nowMs = 5000, both count (max_units = 2). Oldest is 2000, leaves at 2000 + 10000 = 12000.
      expect(check(db, 't3', 5000)).toEqual({ ok: false, reason: 'quota', retryAtMs: 12000 })

      // 8. Null for budget
      db.prepare("INSERT INTO budget_caps (project_id, level, key, cap_units, updated_at) VALUES ('p1', 'project', '', 2, 'now')").run()
      // Usage is 2 (r-old, r-new), cap is 2. Next attempt would be 3 > 2.
      // Clear quota window so quota check passes and budget check triggers:
      db.prepare("DELETE FROM quota_windows WHERE project_id = 'p1'").run()
      expect(check(db, 't3', 5000)).toEqual({ ok: false, reason: 'budget', retryAtMs: null })
    } finally {
      db.close()
    }
  })

  it('CHK-M7-03-f: scheduleAttempt leaves exactly one reservation row carrying the new attempt id; a failed check leaves no attempt row and the task ready; a task over max_attempts fails with no reservation', () => {
    const dir = makeStateDir()
    const dbPath = join(dir, 'state.sqlite')
    const db = openStore(dbPath)
    try {
      setupProject(db, 'p1')
      const handle = acquireSupervisor(db, dir, { nowMs: 1000, staleAfterMs: 300000 })

      // 1. Successful scheduleAttempt leaves exactly one reservation row carrying the new attempt id
      createTask(db, 't-success', 'p1', { provider: 'default' })
      const resSuccess = schedule(db, handle, 't-success', dir, 1000)
      expect(resSuccess).toEqual({ ok: true })

      const attemptRow = db.prepare("SELECT id, status FROM attempts WHERE task_id = 't-success'").get() as { id: string; status: string }
      expect(attemptRow).toBeDefined()
      expect(attemptRow.status).toBe('pending')

      const reservations = db.prepare("SELECT * FROM quota_reservations WHERE attempt_id = ?").all(attemptRow.id) as Array<{ attempt_id: string; provider: string; units: number; state: string; reserved_at_ms: number }>
      expect(reservations.length).toBe(1)
      expect(reservations[0]).toMatchObject({
        attempt_id: attemptRow.id,
        provider: 'default',
        units: 1,
        state: 'reserved',
        reserved_at_ms: 1000,
      })

      const taskRow = db.prepare("SELECT status FROM tasks WHERE id = 't-success'").get() as { status: string }
      expect(taskRow.status).toBe('progress')

      // 2. A failed check leaves no attempt row and the task ready
      db.prepare("INSERT INTO quota_windows (project_id, provider, window_ms, max_units, updated_at) VALUES ('p1', 'capped', 10000, 1, 'now')").run()
      createTask(db, 't-capped-1', 'p1', { provider: 'capped' })
      const resCap1 = schedule(db, handle, 't-capped-1', dir, 1000)
      expect(resCap1).toEqual({ ok: true })

      createTask(db, 't-capped-2', 'p1', { provider: 'capped' })
      const resCap2 = schedule(db, handle, 't-capped-2', dir, 1000)
      expect(resCap2).toEqual({ ok: false, reason: 'quota' })

      const cap2Attempts = db.prepare("SELECT * FROM attempts WHERE task_id = 't-capped-2'").all()
      expect(cap2Attempts).toEqual([])

      const cap2Task = db.prepare("SELECT status FROM tasks WHERE id = 't-capped-2'").get() as { status: string }
      expect(cap2Task.status).toBe('ready')

      const cap2Reservations = db.prepare("SELECT * FROM quota_reservations r JOIN attempts a ON a.id = r.attempt_id WHERE a.task_id = 't-capped-2'").all()
      expect(cap2Reservations).toEqual([])

      // 3. A task over max_attempts fails with no reservation
      createTask(db, 't-exhausted', 'p1', { maxAttempts: 2 })
      createAttempt(db, 'a-ex-1', 't-exhausted', { attemptNo: 1, status: 'failed' })
      createAttempt(db, 'a-ex-2', 't-exhausted', { attemptNo: 2, status: 'failed' })

      const resExhausted = schedule(db, handle, 't-exhausted', dir, 1000)
      expect(resExhausted).toEqual({ ok: false, reason: 'max-attempts' })

      const exhaustedTask = db.prepare("SELECT status FROM tasks WHERE id = 't-exhausted'").get() as { status: string }
      expect(exhaustedTask.status).toBe('failed')

      const exhaustedAttempts = db.prepare("SELECT * FROM attempts WHERE task_id = 't-exhausted'").all()
      expect(exhaustedAttempts.length).toBe(2)

      const exhaustedReservations = db.prepare("SELECT * FROM quota_reservations r JOIN attempts a ON a.id = r.attempt_id WHERE a.task_id = 't-exhausted' AND a.attempt_no = 3").all()
      expect(exhaustedReservations).toEqual([])
    } finally {
      db.close()
    }
  })

  it('CHK-M7-03-i: property: check agrees with reserve for the same DB state over random windows, caps, usage and times; and loop gates map equals tasks reserve would refuse', () => {
    const reservationArb = fc.record({
      state: fc.constantFrom('reserved' as const, 'settled' as const, 'released' as const),
      offsetMs: fc.integer({ min: -20000, max: 0 }),
      withWorker: fc.boolean(),
    })

    fc.assert(
      fc.property(
        fc.integer({ min: 1000, max: 15000 }), // windowMs
        fc.integer({ min: 1, max: 4 }),        // maxUnits
        fc.integer({ min: 20000, max: 50000 }), // nowMs
        fc.array(reservationArb, { maxLength: 8 }),
        fc.option(fc.integer({ min: 1, max: 6 }), { nil: null }), // optional budget cap
        (windowMs, maxUnits, nowMs, rawReservations, budgetCap) => {
          const dir = makeStateDir()
          const dbPath = join(dir, 'state.sqlite')
          const db = openStore(dbPath)
          try {
            setupProject(db, 'p1')
            const handle = acquireSupervisor(db, dir, { nowMs, staleAfterMs: 300000 })

            db.prepare("INSERT INTO quota_windows (project_id, provider, window_ms, max_units, updated_at) VALUES ('p1', 'default', ?, ?, 'now')").run(windowMs, maxUnits)
            if (budgetCap !== null) {
              db.prepare("INSERT INTO budget_caps (project_id, level, key, cap_units, updated_at) VALUES ('p1', 'project', '', ?, 'now')").run(budgetCap)
            }

            // Populate existing reservations
            rawReservations.forEach((res, i) => {
              const tid = `t-seed-${i}`
              const aid = `a-seed-${i}`
              createTask(db, tid, 'p1', { provider: 'default' })
              createAttempt(db, aid, tid, { status: res.state === 'reserved' ? 'pending' : 'succeeded' })
              if (res.withWorker) {
                db.prepare("INSERT INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at) VALUES (?, ?, ?, 'running', '/w', ?, 'now')").run(aid, `nonce-${i}`, 1000 + i, nowMs + res.offsetMs)
              }
              insertReservation(db, `r-seed-${i}`, 'p1', aid, 'default', res.state, nowMs + res.offsetMs, res.state === 'reserved' ? null : nowMs + res.offsetMs + 100)
            })

            // Target task to test
            const targetTaskId = 't-target'
            const targetAttemptId = 'a-target'
            createTask(db, targetTaskId, 'p1', { provider: 'default' })
            createAttempt(db, targetAttemptId, targetTaskId, { status: 'pending' })

            // 1. check agrees with reserve for the same DB state
            const checkResult = check(db, targetTaskId, nowMs)

            let reserveResult: { ok: true } | { ok: false; reason: 'quota' | 'budget'; retryAtMs: number | null } | void = undefined
            let threw = false
            try {
              reserveResult = doReserve(db, handle, targetTaskId, targetAttemptId, nowMs)
            } catch {
              threw = true
            }

            if (checkResult.ok) {
              expect(threw).toBe(false)
              if (reserveResult) expect(reserveResult).toEqual({ ok: true })
              const row = db.prepare("SELECT * FROM quota_reservations WHERE attempt_id = ?").get(targetAttemptId) as { state: string; units: number } | undefined
              expect(row).toBeDefined()
              expect(row?.state).toBe('reserved')
              expect(row?.units).toBe(1)
            } else {
              if (!threw && reserveResult) {
                expect(reserveResult.ok).toBe(false)
                if (reserveResult.ok === false) {
                  expect(reserveResult.reason).toBe(checkResult.reason)
                  expect(reserveResult.retryAtMs).toBe(checkResult.retryAtMs)
                }
              }
              const row = db.prepare("SELECT * FROM quota_reservations WHERE attempt_id = ?").get(targetAttemptId)
              expect(row).toBeUndefined()
            }

            // 2. Set of tasks loop puts in gates equals set of tasks reserve would refuse
            const batchTasks = ['t-b1', 't-b2', 't-b3']
            batchTasks.forEach((id) => createTask(db, id, 'p1', { provider: 'default' }))

            const loopGates: Record<string, { reason: 'quota' | 'budget'; retryAtMs: number | null }> = {}
            for (const id of batchTasks) {
              const c = check(db, id, nowMs)
              if (!c.ok) loopGates[id] = { reason: c.reason, retryAtMs: c.retryAtMs }
            }

            for (const id of batchTasks) {
              const aid = `a-${id}`
              createAttempt(db, aid, id, { status: 'pending' })
              const isGated = Boolean(loopGates[id])
              let refused = false
              try {
                const r = doReserve(db, handle, id, aid, nowMs)
                if (r && r.ok === false) refused = true
              } catch {
                refused = true
              }
              expect(refused).toBe(isGated)
              // Clean up test reservation so next in loop sees same initial state
              db.prepare("DELETE FROM quota_reservations WHERE attempt_id = ?").run(aid)
              db.prepare("DELETE FROM attempts WHERE id = ?").run(aid)
            }
          } finally {
            db.close()
          }
        },
      ),
      { numRuns: 50 },
    )
  })

  it('CHK-M7-03-h: property: after any random sequence of start, finish, timeout, lost, kill, exhausted events no reserved row belongs to an attempt in a terminal status', () => {
    type Event =
      | { kind: 'start' }
      | { kind: 'finish'; code: number }
      | { kind: 'timeout' }
      | { kind: 'lost' }
      | { kind: 'kill' }
      | { kind: 'exhausted' }

    const eventArb = fc.record({
      kind: fc.constantFrom('start' as const, 'finish' as const, 'timeout' as const, 'lost' as const, 'kill' as const, 'exhausted' as const),
      code: fc.constantFrom(0, 1, 75),
    })

    fc.assert(
      fc.property(fc.array(eventArb, { minLength: 1, maxLength: 20 }), (events) => {
        const dir = makeStateDir()
        const dbPath = join(dir, 'state.sqlite')
        const db = openStore(dbPath)
        try {
          setupProject(db, 'p1')
          const handle = acquireSupervisor(db, dir, { nowMs: 1000, staleAfterMs: 300000 })

          createTask(db, 't-fuzz', 'p1', { provider: 'default' })

          let activeAttemptId: string | null = null
          let attemptNo = 0
          let currentTime = 1000

          for (const ev of events as Event[]) {
            currentTime += 1000

            if (ev.kind === 'start') {
              if (!activeAttemptId) {
                attemptNo++
                activeAttemptId = `a-fuzz-${attemptNo}`
                createAttempt(db, activeAttemptId, 't-fuzz', { attemptNo, status: 'pending' })
                doReserve(db, handle, 't-fuzz', activeAttemptId, currentTime)
              }
            } else if (activeAttemptId) {
              const attempt = db.prepare("SELECT status FROM attempts WHERE id = ?").get(activeAttemptId) as { status: string }
              if (['pending', 'running'].includes(attempt.status)) {
                switch (ev.kind) {
                  case 'finish': {
                    db.prepare("INSERT OR IGNORE INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at) VALUES (?, ?, ?, 'running', '/w', ?, 'now')").run(activeAttemptId, `nonce-${activeAttemptId}`, 2000, currentTime)
                    db.prepare("UPDATE attempts SET status = ?, exit_code = ?, ended_at = 'now' WHERE id = ?").run(ev.code === 0 ? 'succeeded' : 'failed', ev.code, activeAttemptId)
                    closeReservation(db, activeAttemptId, currentTime)
                    activeAttemptId = null
                    break
                  }
                  case 'timeout': {
                    db.prepare("INSERT OR IGNORE INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at) VALUES (?, ?, ?, 'running', '/w', ?, 'now')").run(activeAttemptId, `nonce-${activeAttemptId}`, 2000, currentTime)
                    db.prepare("UPDATE workers SET state = 'lost', ended_at = 'now' WHERE attempt_id = ?").run(activeAttemptId)
                    db.prepare("UPDATE attempts SET status = 'interrupted', error_class = 'timeout', ended_at = 'now' WHERE id = ?").run(activeAttemptId)
                    closeReservation(db, activeAttemptId, currentTime)
                    activeAttemptId = null
                    break
                  }
                  case 'lost': {
                    db.prepare("INSERT OR IGNORE INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at) VALUES (?, ?, ?, 'running', '/w', ?, 'now')").run(activeAttemptId, `nonce-${activeAttemptId}`, 2000, currentTime)
                    db.prepare("UPDATE workers SET state = 'lost', ended_at = 'now' WHERE attempt_id = ?").run(activeAttemptId)
                    db.prepare("UPDATE attempts SET status = 'interrupted', error_class = 'lost', ended_at = 'now' WHERE id = ?").run(activeAttemptId)
                    closeReservation(db, activeAttemptId, currentTime)
                    activeAttemptId = null
                    break
                  }
                  case 'kill': {
                    db.prepare("UPDATE attempts SET status = 'killed', ended_at = 'now' WHERE id = ?").run(activeAttemptId)
                    closeReservation(db, activeAttemptId, currentTime)
                    activeAttemptId = null
                    break
                  }
                  case 'exhausted': {
                    db.prepare("UPDATE attempts SET status = 'failed', error_class = 'outbox:attempt.start', ended_at = 'now' WHERE id = ?").run(activeAttemptId)
                    closeReservation(db, activeAttemptId, currentTime)
                    activeAttemptId = null
                    break
                  }
                }
              }
            }

            // Invariant verification at every step of the lifecycle:
            // No reserved row belongs to an attempt in a terminal status
            const violations = db.prepare(`
              SELECT r.id, r.attempt_id, a.status, r.state
              FROM quota_reservations r
              JOIN attempts a ON a.id = r.attempt_id
              WHERE a.status IN ('succeeded', 'failed', 'interrupted', 'killed')
                AND r.state = 'reserved'
            `).all()
            expect(violations).toEqual([])
          }
        } finally {
          db.close()
        }
      }),
      { numRuns: 50 },
    )
  })
})
