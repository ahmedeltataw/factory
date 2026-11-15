import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openStore } from '../supervisor/src/app/store.ts'
import { budgetState, budgetUsage, check, reserve, closeReservation } from '../supervisor/src/app/quota.ts'

const directories: string[] = []
function createStore(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'factory-m7-04-'))
  directories.push(dir)
  return openStore(join(dir, 'state.sqlite'))
}

afterEach(() => {
  for (const dir of directories.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    } catch {}
  }
})

function createProject(db: DatabaseSync, id: string): void {
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, 'Project', 'now')").run(id)
}

function createTask(db: DatabaseSync, id: string, projectId: string, phase = 'development'): void {
  const commandId = randomUUID()
  db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES (?, ?, 'task.create', '{}', 'now')").run(commandId, projectId)
  db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, phase, created_at, updated_at) VALUES (?, ?, ?, ?, 'ready', ?, 'now', 'now')").run(id, projectId, commandId, id, phase)
}

let attemptSeq = 1
function createReservation(db: DatabaseSync, id: string, projectId: string, taskId: string, state: 'reserved' | 'settled' | 'released', status = 'failed'): void {
  const attNo = attemptSeq++
  db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation, started_at) VALUES (?, ?, ?, ?, 1, 'now')").run(`a-${id}`, taskId, attNo, status)
  db.prepare("INSERT INTO quota_reservations (id, project_id, attempt_id, provider, units, state, reserved_at_ms, closed_at_ms) VALUES (?, ?, ?, 'default', 1, ?, 1000, ?)").run(id, projectId, `a-${id}`, state, state === 'reserved' ? null : 1001)
}

function setCap(db: DatabaseSync, projectId: string, level: 'project' | 'phase' | 'task', key: string, capUnits: number): void {
  db.prepare("INSERT INTO budget_caps (project_id, level, key, cap_units, updated_at) VALUES (?, ?, ?, ?, 'now')").run(projectId, level, key, capUnits)
}

describe('M7-04 unit tests for budget caps and thresholds', () => {
  describe('budgetState', () => {
    it('floor prevents premature warning or stop at fractional percentages', () => {
      // 69.9% must floor to 69 -> 'ok'
      expect(budgetState(699, 1000)).toEqual({ pct: 69, state: 'ok' })
      // 70.0% -> 70 -> 'warn'
      expect(budgetState(700, 1000)).toEqual({ pct: 70, state: 'warn' })
      // 89.9% must floor to 89 -> 'warn'
      expect(budgetState(899, 1000)).toEqual({ pct: 89, state: 'warn' })
      // 90.0% -> 90 -> 'fallback-needed'
      expect(budgetState(900, 1000)).toEqual({ pct: 90, state: 'fallback-needed' })
      // 99.9% must floor to 99 -> 'fallback-needed'
      expect(budgetState(999, 1000)).toEqual({ pct: 99, state: 'fallback-needed' })
      // 100.0% -> 100 -> 'stop'
      expect(budgetState(1000, 1000)).toEqual({ pct: 100, state: 'stop' })
      // >100% -> 'stop'
      expect(budgetState(150, 100)).toEqual({ pct: 150, state: 'stop' })
    })

    it('exact boundaries', () => {
      expect(budgetState(0, 10)).toEqual({ pct: 0, state: 'ok' })
      expect(budgetState(6, 10)).toEqual({ pct: 60, state: 'ok' })
      expect(budgetState(7, 10)).toEqual({ pct: 70, state: 'warn' })
      expect(budgetState(8, 10)).toEqual({ pct: 80, state: 'warn' })
      expect(budgetState(9, 10)).toEqual({ pct: 90, state: 'fallback-needed' })
      expect(budgetState(10, 10)).toEqual({ pct: 100, state: 'stop' })
      expect(budgetState(11, 10)).toEqual({ pct: 110, state: 'stop' })
    })
  })

  describe('budgetUsage', () => {
    it('returns empty array when project has no caps', () => {
      const db = createStore()
      try {
        createProject(db, 'p-empty')
        expect(budgetUsage(db, 'p-empty')).toEqual([])
      } finally {
        db.close()
      }
    })

    it('returns caps with 0 usage when no reservations exist', () => {
      const db = createStore()
      try {
        createProject(db, 'p1')
        setCap(db, 'p1', 'project', '', 5)
        setCap(db, 'p1', 'phase', 'development', 3)
        setCap(db, 'p1', 'task', 't1', 2)

        expect(budgetUsage(db, 'p1')).toEqual([
          { level: 'project', key: '', cap: 5, used: 0, pct: 0, state: 'ok' },
          { level: 'phase', key: 'development', cap: 3, used: 0, pct: 0, state: 'ok' },
          { level: 'task', key: 't1', cap: 2, used: 0, pct: 0, state: 'ok' },
        ])
      } finally {
        db.close()
      }
    })

    it('orders levels project -> phase -> task and sorts keys alphabetically', () => {
      const db = createStore()
      try {
        createProject(db, 'p1')
        // Insert in reverse / mixed order
        setCap(db, 'p1', 'task', 'z-task', 10)
        setCap(db, 'p1', 'task', 'a-task', 10)
        setCap(db, 'p1', 'phase', 'qa', 10)
        setCap(db, 'p1', 'phase', 'development', 10)
        setCap(db, 'p1', 'project', '', 10)

        const rows = budgetUsage(db, 'p1')
        expect(rows.map((r) => `${r.level}:${r.key}`)).toEqual([
          'project:',
          'phase:development',
          'phase:qa',
          'task:a-task',
          'task:z-task',
        ])
      } finally {
        db.close()
      }
    })

    it('accurately counts reserved + settled and excludes released', () => {
      const db = createStore()
      try {
        createProject(db, 'p1')
        createTask(db, 't1', 'p1', 'development')
        createTask(db, 't2', 'p1', 'development')

        createReservation(db, 'r1', 'p1', 't1', 'reserved')
        createReservation(db, 'r2', 'p1', 't1', 'settled')
        createReservation(db, 'r3', 'p1', 't2', 'released')

        setCap(db, 'p1', 'project', '', 10)
        setCap(db, 'p1', 'phase', 'development', 10)
        setCap(db, 'p1', 'task', 't1', 10)
        setCap(db, 'p1', 'task', 't2', 10)

        expect(budgetUsage(db, 'p1')).toEqual([
          { level: 'project', key: '', cap: 10, used: 2, pct: 20, state: 'ok' },
          { level: 'phase', key: 'development', cap: 10, used: 2, pct: 20, state: 'ok' },
          { level: 'task', key: 't1', cap: 10, used: 2, pct: 20, state: 'ok' },
          { level: 'task', key: 't2', cap: 10, used: 0, pct: 0, state: 'ok' },
        ])
      } finally {
        db.close()
      }
    })
  })

  describe('check and reserve integration', () => {
    it('throws when task does not exist', () => {
      const db = createStore()
      try {
        expect(() => check(db, 'nonexistent', 1000)).toThrow('unknown task: nonexistent')
      } finally {
        db.close()
      }
    })

    it('stops when used + 1 > cap and permits when used + 1 <= cap', () => {
      const db = createStore()
      try {
        createProject(db, 'p1')
        createTask(db, 't1', 'p1', 'development')
        setCap(db, 'p1', 'task', 't1', 2)

        // 0 used -> used + 1 = 1 <= 2 -> ok
        expect(check(db, 't1', 1000)).toEqual({ ok: true })

        createReservation(db, 'r1', 'p1', 't1', 'reserved')
        // 1 used -> used + 1 = 2 <= 2 -> ok
        expect(check(db, 't1', 1000)).toEqual({ ok: true })

        createReservation(db, 'r2', 'p1', 't1', 'settled')
        // 2 used -> used + 1 = 3 > 2 -> refused
        expect(check(db, 't1', 1000)).toEqual({ ok: false, reason: 'budget', retryAtMs: null })
      } finally {
        db.close()
      }
    })

    it('reserve respects budget check and prevents over-budget insertion', () => {
      const db = createStore()
      try {
        createProject(db, 'p1')
        createTask(db, 't1', 'p1', 'development')
        setCap(db, 'p1', 'task', 't1', 1)

        const fakeHandle = { leaseGeneration: 1 } as any
        db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation, started_at) VALUES ('att-1', 't1', 1, 'failed', 1, 'now')").run()
        const first = reserve(db, fakeHandle, 't1', 'att-1', 1000)
        expect(first).toEqual({ ok: true })

        db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation, started_at) VALUES ('att-2', 't1', 2, 'pending', 1, 'now')").run()
        const second = reserve(db, fakeHandle, 't1', 'att-2', 1000)
        expect(second).toEqual({ ok: false, reason: 'budget', retryAtMs: null })

        const count = db.prepare('SELECT count(*) as count FROM quota_reservations').get() as { count: number }
        expect(count.count).toBe(1)
      } finally {
        db.close()
      }
    })

    it('regression: reservation for task in another project is not counted in p1 budgetUsage or check across scopes', () => {
      const db = createStore()
      try {
        createProject(db, 'p1')
        createProject(db, 'p2')

        // Task and attempt in p2
        createTask(db, 't-p2', 'p2', 'development')
        db.prepare(
          "INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation, started_at) VALUES ('a-p2', 't-p2', 1, 'running', 1, 'now')"
        ).run()

        // Foreign reservation row with project_id p1 pointing at that p2 task (explicit columns; FKs allow it)
        db.prepare(
          "INSERT INTO quota_reservations (id, project_id, attempt_id, provider, units, state, reserved_at_ms, closed_at_ms) VALUES ('r-foreign', 'p1', 'a-p2', 'default', 1, 'reserved', 1000, null)"
        ).run()

        // p1 tasks: t-p1 has a normal reservation, t-p1-next has none
        createTask(db, 't-p1', 'p1', 'development')
        db.prepare(
          "INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation, started_at) VALUES ('a-p1', 't-p1', 1, 'running', 1, 'now')"
        ).run()
        // Normal p1 reservation
        db.prepare(
          "INSERT INTO quota_reservations (id, project_id, attempt_id, provider, units, state, reserved_at_ms, closed_at_ms) VALUES ('r-p1', 'p1', 'a-p1', 'default', 1, 'reserved', 1000, null)"
        ).run()

        createTask(db, 't-p1-next', 'p1', 'development')

        // Caps for p1 across project, phase, and task scopes
        setCap(db, 'p1', 'project', '', 2)
        setCap(db, 'p1', 'phase', 'development', 2)
        setCap(db, 'p1', 'task', 't-p1', 1)
        setCap(db, 'p1', 'task', 't-p2', 1)

        // 1. budgetUsage for p1:
        // - project: cap 2, used 1 (r-p1 counts; r-foreign does not count)
        // - phase development: cap 2, used 1 (r-p1 counts; r-foreign does not count)
        // - task t-p1: cap 1, used 1 (normal p1 reservation counts)
        // - task t-p2: cap 1, used 0 (r-foreign does not count for task scope)
        expect(budgetUsage(db, 'p1')).toEqual([
          { level: 'project', key: '', cap: 2, used: 1, pct: 50, state: 'ok' },
          { level: 'phase', key: 'development', cap: 2, used: 1, pct: 50, state: 'ok' },
          { level: 'task', key: 't-p1', cap: 1, used: 1, pct: 100, state: 'stop' },
          { level: 'task', key: 't-p2', cap: 1, used: 0, pct: 0, state: 'ok' },
        ])

        // 2. check for p1:
        // Task scope: normal p1 reservation on t-p1 is counted -> used (1) + 1 = 2 > cap (1) -> refused
        expect(check(db, 't-p1', 1000)).toEqual({ ok: false, reason: 'budget', retryAtMs: null })

        // Project and phase scopes: for t-p1-next, used is 1 (only r-p1), so used (1) + 1 = 2 <= cap (2) -> allowed
        // (If r-foreign was counted, used would be 2, and 2 + 1 = 3 > 2 -> would have been refused)
        expect(check(db, 't-p1-next', 1000)).toEqual({ ok: true })

        // When project and phase caps are 1, check on t-p1-next is refused because normal r-p1 counts (used=1)
        db.prepare("UPDATE budget_caps SET cap_units = 1 WHERE project_id = 'p1' AND level = 'project'").run()
        expect(check(db, 't-p1-next', 1000)).toEqual({ ok: false, reason: 'budget', retryAtMs: null })

        db.prepare("UPDATE budget_caps SET cap_units = 2 WHERE project_id = 'p1' AND level = 'project'").run()
        db.prepare("UPDATE budget_caps SET cap_units = 1 WHERE project_id = 'p1' AND level = 'phase'").run()
        expect(check(db, 't-p1-next', 1000)).toEqual({ ok: false, reason: 'budget', retryAtMs: null })
      } finally {
        db.close()
      }
    })
  })
})
