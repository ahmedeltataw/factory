import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { openStore } from '../../supervisor/src/app/store.ts'
import { budgetState, budgetUsage, check } from '../../supervisor/src/app/quota.ts'

const directories: string[] = []
function store(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'factory-m7-budget-'))
  directories.push(dir)
  return openStore(join(dir, 'state.sqlite'))
}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})
function project(db: DatabaseSync, id: string): void {
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, 'Project', 'now')").run(id)
}
function task(db: DatabaseSync, id: string, projectId: string, phase: string): void {
  const commandId = randomUUID()
  db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES (?, ?, 'task.create', '{}', 'now')").run(commandId, projectId)
  db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, phase, created_at, updated_at) VALUES (?, ?, ?, ?, 'ready', ?, 'now', 'now')").run(id, projectId, commandId, id, phase)
}
function reservation(db: DatabaseSync, id: string, projectId: string, taskId: string, state: 'reserved' | 'settled' | 'released', status = 'pending'): void {
  db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation, started_at) VALUES (?, ?, 1, ?, 1, 'now')").run(`a-${id}`, taskId, status)
  db.prepare("INSERT INTO quota_reservations (id, project_id, attempt_id, provider, units, state, reserved_at_ms, closed_at_ms) VALUES (?, ?, ?, 'default', 1, ?, 1000, ?)").run(id, projectId, `a-${id}`, state, state === 'reserved' ? null : 1001)
}
function cap(db: DatabaseSync, projectId: string, level: 'project' | 'phase' | 'task', key: string, value: number): void {
  db.prepare("INSERT INTO budget_caps (project_id, level, key, cap_units, updated_at) VALUES (?, ?, ?, ?, 'now')").run(projectId, level, key, value)
}
const refused = { ok: false, reason: 'budget', retryAtMs: null }

describe('M7-04 budget contracts', () => {
  it('CHK-M7-04-a: full task, phase and project caps gate only their scopes', () => {
    const db = store()
    try {
      project(db, 'p1')
      task(db, 't1', 'p1', 'development')
      task(db, 't2', 'p1', 'development')
      task(db, 't3', 'p1', 'qa')
      reservation(db, 'r1', 'p1', 't1', 'reserved')
      cap(db, 'p1', 'project', '', 2)
      cap(db, 'p1', 'task', 't1', 1)
      expect(check(db, 't1', 2000)).toEqual(refused)
      expect(check(db, 't2', 2000)).toEqual({ ok: true })
      db.prepare("DELETE FROM budget_caps WHERE level = 'task'").run()
      cap(db, 'p1', 'phase', 'development', 1)
      expect(check(db, 't2', 2000)).toEqual(refused)
      expect(check(db, 't3', 2000)).toEqual({ ok: true })
      db.prepare("DELETE FROM budget_caps WHERE level = 'phase'").run()
      db.prepare("UPDATE budget_caps SET cap_units = 1 WHERE level = 'project'").run()
      expect(check(db, 't3', 2000)).toEqual(refused)
    } finally { db.close() }
  })

  it('CHK-M7-04-b: threshold boundaries, floor, and monotonicity', () => {
    for (const [used, capValue, pct, state] of [
      [69, 100, 69, 'ok'], [70, 100, 70, 'warn'], [89, 100, 89, 'warn'],
      [90, 100, 90, 'fallback-needed'], [99, 100, 99, 'fallback-needed'],
      [100, 100, 100, 'stop'], [101, 100, 101, 'stop'], [2, 3, 66, 'ok'],
      [3, 3, 100, 'stop'], [5, 7, 71, 'warn'], [0, 1, 0, 'ok'], [1, 1, 100, 'stop'],
    ] as const) expect(budgetState(used, capValue)).toEqual({ pct, state })
    const states = ['ok', 'warn', 'fallback-needed', 'stop']
    fc.assert(fc.property(fc.integer({ min: 0, max: 100000 }), fc.integer({ min: 0, max: 100000 }), fc.integer({ min: 1, max: 100000 }), (a, b, capValue) => {
      const low = Math.min(a, b)
      const high = Math.max(a, b)
      for (const used of [low, high]) {
        const pct = Math.floor(100 * used / capValue)
        const state = pct >= 100 ? 'stop' : pct >= 90 ? 'fallback-needed' : pct >= 70 ? 'warn' : 'ok'
        expect(budgetState(used, capValue)).toEqual({ pct, state })
      }
      expect(states.indexOf(budgetState(low, capValue).state)).toBeLessThanOrEqual(states.indexOf(budgetState(high, capValue).state))
    }))
  })

  it('CHK-M7-04-c: lowering and raising a cap preserves attempts and reservations', () => {
    const db = store()
    try {
      project(db, 'p1')
      task(db, 't1', 'p1', 'development')
      task(db, 't2', 'p1', 'development')
      task(db, 'next', 'p1', 'development')
      reservation(db, 'r1', 'p1', 't1', 'reserved', 'running')
      reservation(db, 'r2', 'p1', 't2', 'settled', 'failed')
      cap(db, 'p1', 'project', '', 3)
      const attempts = db.prepare('SELECT * FROM attempts ORDER BY id').all()
      const reservations = db.prepare('SELECT * FROM quota_reservations ORDER BY id').all()
      db.prepare("UPDATE budget_caps SET cap_units = 1 WHERE project_id = 'p1'").run()
      expect(check(db, 'next', 2000)).toEqual(refused)
      expect(db.prepare('SELECT * FROM attempts ORDER BY id').all()).toEqual(attempts)
      expect(db.prepare('SELECT * FROM quota_reservations ORDER BY id').all()).toEqual(reservations)
      db.prepare("UPDATE budget_caps SET cap_units = 3 WHERE project_id = 'p1'").run()
      expect(check(db, 'next', 2000)).toEqual({ ok: true })
      expect(db.prepare('SELECT * FROM attempts ORDER BY id').all()).toEqual(attempts)
      expect(db.prepare('SELECT * FROM quota_reservations ORDER BY id').all()).toEqual(reservations)
    } finally { db.close() }
  })

  it('CHK-M7-04-d: released is excluded while settled failed and reserved count', () => {
    const db = store()
    try {
      project(db, 'p1')
      for (const id of ['released', 'failed', 'reserved', 'next']) task(db, id, 'p1', 'intake')
      reservation(db, 'r1', 'p1', 'released', 'released', 'failed')
      reservation(db, 'r2', 'p1', 'failed', 'settled', 'failed')
      reservation(db, 'r3', 'p1', 'reserved', 'reserved')
      cap(db, 'p1', 'project', '', 3)
      expect(check(db, 'next', 2000)).toEqual({ ok: true })
      expect(budgetUsage(db, 'p1')).toEqual([{ level: 'project', key: '', cap: 3, used: 2, pct: 66, state: 'ok' }])
      db.prepare("UPDATE budget_caps SET cap_units = 2 WHERE project_id = 'p1'").run()
      expect(check(db, 'next', 2000)).toEqual(refused)
    } finally { db.close() }
  })

  it('CHK-M7-04-e: usage is scoped by key and project and ordered by level and key', () => {
    const db = store()
    try {
      for (const id of ['p1', 'p2', 'empty']) project(db, id)
      task(db, 'dev-a', 'p1', 'development')
      task(db, 'dev-b', 'p1', 'development')
      task(db, 'qa-a', 'p1', 'qa')
      task(db, 'other', 'p2', 'development')
      reservation(db, 'r1', 'p1', 'dev-a', 'reserved')
      reservation(db, 'r2', 'p1', 'dev-b', 'settled', 'failed')
      reservation(db, 'r3', 'p1', 'qa-a', 'reserved')
      reservation(db, 'r4', 'p2', 'other', 'reserved')
      cap(db, 'p1', 'task', 'qa-a', 2)
      cap(db, 'p1', 'phase', 'qa', 2)
      cap(db, 'p1', 'task', 'dev-a', 1)
      cap(db, 'p1', 'project', '', 4)
      cap(db, 'p1', 'phase', 'development', 2)
      cap(db, 'p2', 'project', '', 2)
      cap(db, 'p2', 'phase', 'development', 2)
      expect(budgetUsage(db, 'p1')).toEqual([
        { level: 'project', key: '', cap: 4, used: 3, pct: 75, state: 'warn' },
        { level: 'phase', key: 'development', cap: 2, used: 2, pct: 100, state: 'stop' },
        { level: 'phase', key: 'qa', cap: 2, used: 1, pct: 50, state: 'ok' },
        { level: 'task', key: 'dev-a', cap: 1, used: 1, pct: 100, state: 'stop' },
        { level: 'task', key: 'qa-a', cap: 2, used: 1, pct: 50, state: 'ok' },
      ])
      expect(budgetUsage(db, 'p2')).toEqual([
        { level: 'project', key: '', cap: 2, used: 1, pct: 50, state: 'ok' },
        { level: 'phase', key: 'development', cap: 2, used: 1, pct: 50, state: 'ok' },
      ])
      expect(budgetUsage(db, 'empty')).toEqual([])
    } finally { db.close() }
  })
})
