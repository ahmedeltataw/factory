import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { applyPendingCommands } from '../../supervisor/src/app/apply-commands.ts'
import { appendCommand } from '../../supervisor/src/app/commands.ts'
import { openStore } from '../../supervisor/src/app/store.ts'
import { acquireSupervisor } from '../../supervisor/src/app/supervisor-lease.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    } catch {}
  }
})

function seedProjectPhases(db: DatabaseSync, projectId: string, openedAt = '2026-01-01T00:00:00.000Z'): void {
  const phases = [
    { name: 'intake', ord: 1, status: 'open', opened_at: openedAt, closed_at: null },
    { name: 'development', ord: 2, status: 'locked', opened_at: null, closed_at: null },
    { name: 'qa', ord: 3, status: 'locked', opened_at: null, closed_at: null },
    { name: 'devops', ord: 4, status: 'locked', opened_at: null, closed_at: null },
    { name: 'handover', ord: 5, status: 'locked', opened_at: null, closed_at: null },
  ]
  for (const p of phases) {
    db.prepare(`
      INSERT OR IGNORE INTO phases (project_id, name, ord, status, opened_at, closed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(projectId, p.name, p.ord, p.status, p.opened_at, p.closed_at)
  }
}

function setup(projectId = 'p1') {
  const dir = mkdtempSync(join(tmpdir(), 'm7-commands-'))
  dirs.push(dir)
  const db = openStore(join(dir, 'state.sqlite'))
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000')
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, 'Project', '2026-01-01T00:00:00.000Z')").run(projectId)
  db.prepare("INSERT INTO project_config (project_id, repo_path, base_ref, created_at) VALUES (?, '/repo', 'main', '2026-01-01T00:00:00.000Z')").run(projectId)
  seedProjectPhases(db, projectId)
  return { dir, db }
}

function apply(db: DatabaseSync, dir: string): void {
  const handle = acquireSupervisor(db, dir, { nowMs: Date.now(), staleAfterMs: 300000 })
  try {
    applyPendingCommands(db, handle)
  } finally {
    handle.release(Date.now())
  }
}

function append(
  db: DatabaseSync,
  kind: string,
  payload: Record<string, unknown>,
  projectId = 'p1',
  id = randomUUID(),
  createdAt = new Date().toISOString(),
): string {
  appendCommand(db, {
    id,
    projectId,
    kind,
    payloadJson: JSON.stringify(payload),
    createdAt,
  })
  return id
}

function outcome(db: DatabaseSync, commandId: string): { outcome: string; reason: string | null } | undefined {
  return db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get(commandId) as
    | { outcome: string; reason: string | null }
    | undefined
}

function dumpNonCommandTables(db: DatabaseSync): Record<string, unknown[]> {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'commands' ORDER BY name")
    .all() as Array<{ name: string }>
  const dump: Record<string, unknown[]> = {}
  for (const { name } of tables) {
    dump[name] = db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()
  }
  return dump
}

describe('M7-06 Commands and CLI protected tests', () => {
  describe('CHK-M7-06-a: limits, quota, and budget commands apply once, overwrite, clear, and reject bad inputs', () => {
    it('CHK-M7-06-a: limits.set writes and overwrites project_limits row, limits.clear removes it (missing row is no-op), idempotent claim', () => {
      const { db, dir } = setup()
      try {
        const id1 = append(db, 'limits.set', { maxParallel: 4 })
        apply(db, dir)
        expect(outcome(db, id1)).toEqual({ outcome: 'applied', reason: null })
        const row1 = db.prepare('SELECT project_id, max_parallel, updated_at FROM project_limits WHERE project_id = ?').get('p1') as
          | { project_id: string; max_parallel: number; updated_at: string }
          | undefined
        expect(row1).toBeDefined()
        expect(row1?.project_id).toBe('p1')
        expect(row1?.max_parallel).toBe(4)
        expect(typeof row1?.updated_at).toBe('string')
        expect(Number.isNaN(new Date(row1!.updated_at).getTime())).toBe(false)

        // Set twice overwrites
        const id2 = append(db, 'limits.set', { maxParallel: 8 })
        apply(db, dir)
        expect(outcome(db, id2)).toEqual({ outcome: 'applied', reason: null })
        const row2 = db.prepare('SELECT project_id, max_parallel, updated_at FROM project_limits WHERE project_id = ?').get('p1') as
          | { project_id: string; max_parallel: number; updated_at: string }
          | undefined
        expect(row2?.max_parallel).toBe(8)
        expect(db.prepare('SELECT count(*) AS count FROM project_limits WHERE project_id = ?').get('p1')).toEqual({ count: 1 })

        // Idempotent claim: applying again with no new commands changes nothing
        apply(db, dir)
        expect(db.prepare('SELECT project_id, max_parallel FROM project_limits WHERE project_id = ?').get('p1')).toEqual({
          project_id: 'p1',
          max_parallel: 8,
        })
        expect(db.prepare('SELECT count(*) AS count FROM command_outcomes WHERE command_id IN (?, ?)').get(id1, id2)).toEqual({ count: 2 })

        // Clear removes the row
        const idClear1 = append(db, 'limits.clear', {})
        apply(db, dir)
        expect(outcome(db, idClear1)).toEqual({ outcome: 'applied', reason: null })
        expect(db.prepare('SELECT * FROM project_limits WHERE project_id = ?').get('p1')).toBeUndefined()

        // Clear of a missing row is a no-op, not a rejection
        const idClear2 = append(db, 'limits.clear', {})
        apply(db, dir)
        expect(outcome(db, idClear2)).toEqual({ outcome: 'applied', reason: null })
        expect(db.prepare('SELECT * FROM project_limits WHERE project_id = ?').get('p1')).toBeUndefined()
      } finally {
        db.close()
      }
    })

    it('CHK-M7-06-a: quota.set writes and overwrites quota_windows row, quota.clear removes it (missing row is no-op), idempotent claim', () => {
      const { db, dir } = setup()
      try {
        const id1 = append(db, 'quota.set', { provider: 'openai', windowMs: 60000, maxUnits: 10 })
        apply(db, dir)
        expect(outcome(db, id1)).toEqual({ outcome: 'applied', reason: null })
        const row1 = db.prepare('SELECT project_id, provider, window_ms, max_units, updated_at FROM quota_windows WHERE project_id = ? AND provider = ?').get('p1', 'openai') as
          | { project_id: string; provider: string; window_ms: number; max_units: number; updated_at: string }
          | undefined
        expect(row1).toBeDefined()
        expect(row1).toMatchObject({ project_id: 'p1', provider: 'openai', window_ms: 60000, max_units: 10 })
        expect(typeof row1?.updated_at).toBe('string')
        expect(Number.isNaN(new Date(row1!.updated_at).getTime())).toBe(false)

        // Set twice overwrites
        const id2 = append(db, 'quota.set', { provider: 'openai', windowMs: 30000, maxUnits: 20 })
        apply(db, dir)
        expect(outcome(db, id2)).toEqual({ outcome: 'applied', reason: null })
        const row2 = db.prepare('SELECT project_id, provider, window_ms, max_units, updated_at FROM quota_windows WHERE project_id = ? AND provider = ?').get('p1', 'openai') as
          | { project_id: string; provider: string; window_ms: number; max_units: number; updated_at: string }
          | undefined
        expect(row2).toMatchObject({ project_id: 'p1', provider: 'openai', window_ms: 30000, max_units: 20 })
        expect(db.prepare("SELECT count(*) AS count FROM quota_windows WHERE project_id = 'p1' AND provider = 'openai'").get()).toEqual({ count: 1 })

        // Idempotent claim
        apply(db, dir)
        expect(db.prepare('SELECT count(*) AS count FROM command_outcomes WHERE command_id IN (?, ?)').get(id1, id2)).toEqual({ count: 2 })

        // Clear removes the row
        const idClear1 = append(db, 'quota.clear', { provider: 'openai' })
        apply(db, dir)
        expect(outcome(db, idClear1)).toEqual({ outcome: 'applied', reason: null })
        expect(db.prepare("SELECT * FROM quota_windows WHERE project_id = 'p1' AND provider = 'openai'").get()).toBeUndefined()

        // Clear of a missing row is a no-op, not a rejection
        const idClear2 = append(db, 'quota.clear', { provider: 'openai' })
        apply(db, dir)
        expect(outcome(db, idClear2)).toEqual({ outcome: 'applied', reason: null })
        expect(db.prepare("SELECT * FROM quota_windows WHERE project_id = 'p1' AND provider = 'openai'").get()).toBeUndefined()
      } finally {
        db.close()
      }
    })

    it('CHK-M7-06-a: budget.set writes and overwrites budget_caps across project, phase, task levels, clear removes row (missing row is no-op)', () => {
      const { db, dir } = setup()
      try {
        // Seed task in p1
        db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c-seed', 'p1', 'task.create', '{}', '2026-01-01T00:00:00.000Z')").run()
        db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, phase, created_at, updated_at) VALUES ('t1', 'p1', 'c-seed', 'Task 1', 'ready', 'development', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run()

        // 1. Project level (key is stored as '')
        const idProj1 = append(db, 'budget.set', { level: 'project', cap: 50 })
        apply(db, dir)
        expect(outcome(db, idProj1)).toEqual({ outcome: 'applied', reason: null })
        const rowProj1 = db.prepare("SELECT project_id, level, key, cap_units, updated_at FROM budget_caps WHERE project_id = 'p1' AND level = 'project'").get() as
          | { project_id: string; level: string; key: string; cap_units: number; updated_at: string }
          | undefined
        expect(rowProj1).toMatchObject({ project_id: 'p1', level: 'project', key: '', cap_units: 50 })
        expect(typeof rowProj1?.updated_at).toBe('string')
        expect(Number.isNaN(new Date(rowProj1!.updated_at).getTime())).toBe(false)

        // Project level overwrite
        const idProj2 = append(db, 'budget.set', { level: 'project', cap: 100 })
        apply(db, dir)
        expect(outcome(db, idProj2)).toEqual({ outcome: 'applied', reason: null })
        const rowProj2 = db.prepare("SELECT cap_units FROM budget_caps WHERE project_id = 'p1' AND level = 'project'").get() as { cap_units: number }
        expect(rowProj2.cap_units).toBe(100)

        // Project level clear
        const idProjClear = append(db, 'budget.clear', { level: 'project' })
        apply(db, dir)
        expect(outcome(db, idProjClear)).toEqual({ outcome: 'applied', reason: null })
        expect(db.prepare("SELECT * FROM budget_caps WHERE project_id = 'p1' AND level = 'project'").get()).toBeUndefined()

        // Project level clear of missing row
        const idProjClear2 = append(db, 'budget.clear', { level: 'project' })
        apply(db, dir)
        expect(outcome(db, idProjClear2)).toEqual({ outcome: 'applied', reason: null })

        // 2. Phase level (key is phase name)
        const idPhase1 = append(db, 'budget.set', { level: 'phase', key: 'development', cap: 20 })
        apply(db, dir)
        expect(outcome(db, idPhase1)).toEqual({ outcome: 'applied', reason: null })
        const rowPhase1 = db.prepare("SELECT project_id, level, key, cap_units, updated_at FROM budget_caps WHERE project_id = 'p1' AND level = 'phase' AND key = 'development'").get() as
          | { project_id: string; level: string; key: string; cap_units: number; updated_at: string }
          | undefined
        expect(rowPhase1).toMatchObject({ project_id: 'p1', level: 'phase', key: 'development', cap_units: 20 })

        // Phase level overwrite
        const idPhase2 = append(db, 'budget.set', { level: 'phase', key: 'development', cap: 35 })
        apply(db, dir)
        expect(outcome(db, idPhase2)).toEqual({ outcome: 'applied', reason: null })
        const rowPhase2 = db.prepare("SELECT cap_units FROM budget_caps WHERE project_id = 'p1' AND level = 'phase' AND key = 'development'").get() as { cap_units: number }
        expect(rowPhase2.cap_units).toBe(35)

        // Phase level clear
        const idPhaseClear = append(db, 'budget.clear', { level: 'phase', key: 'development' })
        apply(db, dir)
        expect(outcome(db, idPhaseClear)).toEqual({ outcome: 'applied', reason: null })
        expect(db.prepare("SELECT * FROM budget_caps WHERE project_id = 'p1' AND level = 'phase' AND key = 'development'").get()).toBeUndefined()

        // Phase level clear of missing row is no-op
        const idPhaseClear2 = append(db, 'budget.clear', { level: 'phase', key: 'development' })
        apply(db, dir)
        expect(outcome(db, idPhaseClear2)).toEqual({ outcome: 'applied', reason: null })

        // 3. Task level (key is task id)
        const idTask1 = append(db, 'budget.set', { level: 'task', key: 't1', cap: 3 })
        apply(db, dir)
        expect(outcome(db, idTask1)).toEqual({ outcome: 'applied', reason: null })
        const rowTask1 = db.prepare("SELECT project_id, level, key, cap_units, updated_at FROM budget_caps WHERE project_id = 'p1' AND level = 'task' AND key = 't1'").get() as
          | { project_id: string; level: string; key: string; cap_units: number; updated_at: string }
          | undefined
        expect(rowTask1).toMatchObject({ project_id: 'p1', level: 'task', key: 't1', cap_units: 3 })

        // Task level overwrite
        const idTask2 = append(db, 'budget.set', { level: 'task', key: 't1', cap: 6 })
        apply(db, dir)
        expect(outcome(db, idTask2)).toEqual({ outcome: 'applied', reason: null })
        const rowTask2 = db.prepare("SELECT cap_units FROM budget_caps WHERE project_id = 'p1' AND level = 'task' AND key = 't1'").get() as { cap_units: number }
        expect(rowTask2.cap_units).toBe(6)

        // Task level clear
        const idTaskClear = append(db, 'budget.clear', { level: 'task', key: 't1' })
        apply(db, dir)
        expect(outcome(db, idTaskClear)).toEqual({ outcome: 'applied', reason: null })
        expect(db.prepare("SELECT * FROM budget_caps WHERE project_id = 'p1' AND level = 'task' AND key = 't1'").get()).toBeUndefined()

        // Task level clear of missing row is no-op
        const idTaskClear2 = append(db, 'budget.clear', { level: 'task', key: 't1' })
        apply(db, dir)
        expect(outcome(db, idTaskClear2)).toEqual({ outcome: 'applied', reason: null })
      } finally {
        db.close()
      }
    })

    it('CHK-M7-06-a: rejects bad input with named reasons (invalid-number, unknown-level, missing-key, key-not-allowed, unknown-key) and writes no table rows', () => {
      const { db, dir } = setup()
      try {
        // Seed second project p2 with a task in p2
        db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p2', 'Project Two', '2026-01-01T00:00:00.000Z')").run()
        db.prepare("INSERT INTO project_config (project_id, repo_path, base_ref, created_at) VALUES ('p2', '/repo2', 'main', '2026-01-01T00:00:00.000Z')").run()
        seedProjectPhases(db, 'p2')
        db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c-p2', 'p2', 'task.create', '{}', '2026-01-01T00:00:00.000Z')").run()
        db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, phase, created_at, updated_at) VALUES ('task-in-p2', 'p2', 'c-p2', 'P2 Task', 'ready', 'intake', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run()

        // Seed task-in-p1
        db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c-p1', 'p1', 'task.create', '{}', '2026-01-01T00:00:00.000Z')").run()
        db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, phase, created_at, updated_at) VALUES ('task-in-p1', 'p1', 'c-p1', 'P1 Task', 'ready', 'development', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run()

        const badCases: Array<{ kind: string; payload: Record<string, unknown>; expectedReason: string; label: string }> = [
          // invalid-number for limits.set
          { kind: 'limits.set', payload: { maxParallel: 0 }, expectedReason: 'invalid-number', label: 'limits.set maxParallel 0' },
          { kind: 'limits.set', payload: { maxParallel: -1 }, expectedReason: 'invalid-number', label: 'limits.set maxParallel negative' },
          { kind: 'limits.set', payload: { maxParallel: 1.5 }, expectedReason: 'invalid-number', label: 'limits.set maxParallel float' },
          { kind: 'limits.set', payload: { maxParallel: '2' }, expectedReason: 'invalid-number', label: 'limits.set maxParallel string' },
          { kind: 'limits.set', payload: { maxParallel: null }, expectedReason: 'invalid-number', label: 'limits.set maxParallel null' },

          // invalid-number for quota.set windowMs (< 1000, 0, negative, float, string, null)
          { kind: 'quota.set', payload: { provider: 'openai', windowMs: 999, maxUnits: 5 }, expectedReason: 'invalid-number', label: 'quota.set windowMs 999 (< 1000)' },
          { kind: 'quota.set', payload: { provider: 'openai', windowMs: 0, maxUnits: 5 }, expectedReason: 'invalid-number', label: 'quota.set windowMs 0' },
          { kind: 'quota.set', payload: { provider: 'openai', windowMs: -5000, maxUnits: 5 }, expectedReason: 'invalid-number', label: 'quota.set windowMs negative' },
          { kind: 'quota.set', payload: { provider: 'openai', windowMs: 1500.5, maxUnits: 5 }, expectedReason: 'invalid-number', label: 'quota.set windowMs float' },
          { kind: 'quota.set', payload: { provider: 'openai', windowMs: '5000', maxUnits: 5 }, expectedReason: 'invalid-number', label: 'quota.set windowMs string' },
          { kind: 'quota.set', payload: { provider: 'openai', windowMs: null, maxUnits: 5 }, expectedReason: 'invalid-number', label: 'quota.set windowMs null' },

          // invalid-number for quota.set maxUnits (0, negative, float, string, null)
          { kind: 'quota.set', payload: { provider: 'openai', windowMs: 5000, maxUnits: 0 }, expectedReason: 'invalid-number', label: 'quota.set maxUnits 0' },
          { kind: 'quota.set', payload: { provider: 'openai', windowMs: 5000, maxUnits: -2 }, expectedReason: 'invalid-number', label: 'quota.set maxUnits negative' },
          { kind: 'quota.set', payload: { provider: 'openai', windowMs: 5000, maxUnits: 3.5 }, expectedReason: 'invalid-number', label: 'quota.set maxUnits float' },
          { kind: 'quota.set', payload: { provider: 'openai', windowMs: 5000, maxUnits: '10' }, expectedReason: 'invalid-number', label: 'quota.set maxUnits string' },
          { kind: 'quota.set', payload: { provider: 'openai', windowMs: 5000, maxUnits: null }, expectedReason: 'invalid-number', label: 'quota.set maxUnits null' },

          // invalid-number for budget.set cap (0, negative, float, string, null)
          { kind: 'budget.set', payload: { level: 'project', cap: 0 }, expectedReason: 'invalid-number', label: 'budget.set cap 0' },
          { kind: 'budget.set', payload: { level: 'project', cap: -5 }, expectedReason: 'invalid-number', label: 'budget.set cap negative' },
          { kind: 'budget.set', payload: { level: 'project', cap: 2.5 }, expectedReason: 'invalid-number', label: 'budget.set cap float' },
          { kind: 'budget.set', payload: { level: 'project', cap: '100' }, expectedReason: 'invalid-number', label: 'budget.set cap string' },
          { kind: 'budget.set', payload: { level: 'project', cap: null }, expectedReason: 'invalid-number', label: 'budget.set cap null' },

          // unknown-level
          { kind: 'budget.set', payload: { level: 'actor', cap: 10 }, expectedReason: 'unknown-level', label: 'budget.set level actor' },
          { kind: 'budget.set', payload: { level: 'global', cap: 10 }, expectedReason: 'unknown-level', label: 'budget.set level global' },
          { kind: 'budget.set', payload: { level: 'PROJECT', cap: 10 }, expectedReason: 'unknown-level', label: 'budget.set level uppercase' },
          { kind: 'budget.clear', payload: { level: 'team' }, expectedReason: 'unknown-level', label: 'budget.clear level team' },

          // missing-key
          { kind: 'budget.set', payload: { level: 'phase', cap: 10 }, expectedReason: 'missing-key', label: 'budget.set phase without key' },
          { kind: 'budget.set', payload: { level: 'phase', key: '', cap: 10 }, expectedReason: 'missing-key', label: 'budget.set phase empty key' },
          { kind: 'budget.set', payload: { level: 'task', cap: 10 }, expectedReason: 'missing-key', label: 'budget.set task without key' },
          { kind: 'budget.set', payload: { level: 'task', key: '', cap: 10 }, expectedReason: 'missing-key', label: 'budget.set task empty key' },
          { kind: 'budget.clear', payload: { level: 'phase' }, expectedReason: 'missing-key', label: 'budget.clear phase without key' },
          { kind: 'budget.clear', payload: { level: 'task' }, expectedReason: 'missing-key', label: 'budget.clear task without key' },

          // key-not-allowed
          { kind: 'budget.set', payload: { level: 'project', key: 'development', cap: 10 }, expectedReason: 'key-not-allowed', label: 'budget.set project with phase key' },
          { kind: 'budget.set', payload: { level: 'project', key: 'foo', cap: 10 }, expectedReason: 'key-not-allowed', label: 'budget.set project with key' },
          { kind: 'budget.clear', payload: { level: 'project', key: 'development' }, expectedReason: 'key-not-allowed', label: 'budget.clear project with key' },

          // unknown-key
          { kind: 'budget.set', payload: { level: 'phase', key: 'nonexistent-phase', cap: 10 }, expectedReason: 'unknown-key', label: 'budget.set invalid phase name' },
          { kind: 'budget.set', payload: { level: 'phase', key: 'qa2', cap: 10 }, expectedReason: 'unknown-key', label: 'budget.set unregistered phase' },
          { kind: 'budget.set', payload: { level: 'task', key: 'nonexistent-task', cap: 10 }, expectedReason: 'unknown-key', label: 'budget.set nonexistent task' },
          { kind: 'budget.set', payload: { level: 'task', key: 'task-in-p2', cap: 10 }, expectedReason: 'unknown-key', label: 'budget.set task of another project' },
          { kind: 'budget.clear', payload: { level: 'phase', key: 'nonexistent-phase' }, expectedReason: 'unknown-key', label: 'budget.clear invalid phase name' },
          { kind: 'budget.clear', payload: { level: 'task', key: 'nonexistent-task' }, expectedReason: 'unknown-key', label: 'budget.clear nonexistent task' },
          { kind: 'budget.clear', payload: { level: 'task', key: 'task-in-p2' }, expectedReason: 'unknown-key', label: 'budget.clear task of another project' },
        ]

        for (const { kind, payload, expectedReason, label } of badCases) {
          const id = append(db, kind, payload)
          apply(db, dir)
          expect(outcome(db, id), `Failed on case: ${label}`).toEqual({ outcome: 'rejected', reason: expectedReason })
        }

        // A rejected command writes no table row
        expect(db.prepare('SELECT count(*) AS count FROM project_limits').get()).toEqual({ count: 0 })
        expect(db.prepare('SELECT count(*) AS count FROM quota_windows').get()).toEqual({ count: 0 })
        expect(db.prepare('SELECT count(*) AS count FROM budget_caps').get()).toEqual({ count: 0 })
      } finally {
        db.close()
      }
    })
  })

  describe('CHK-M7-06-b: command queueing while supervisor is stopped and sequential application', () => {
    it('CHK-M7-06-b: commands queue while supervisor is stopped (writer writes only to commands), then apply on start in order', () => {
      const { db, dir } = setup()
      try {
        // 1. Take a full dump of every other table before appending commands
        const beforeDump = dumpNonCommandTables(db)

        // 2. Write several commands while supervisor is stopped
        const idLimitsSet = append(db, 'limits.set', { maxParallel: 2 })
        const idQuotaSet = append(db, 'quota.set', { provider: 'anthropic', windowMs: 15000, maxUnits: 4 })
        const idBudgetProj = append(db, 'budget.set', { level: 'project', cap: 80 })
        const idTaskCreate = append(db, 'task.create', { title: 'Queued Task A', provider: 'default' })
        const idLimitsOverwrite = append(db, 'limits.set', { maxParallel: 6 })
        const idLimitsClear = append(db, 'limits.clear', {})

        // 3. Compare full dump of every other table before and after appending
        const afterDump = dumpNonCommandTables(db)
        expect(afterDump).toEqual(beforeDump)

        // 4. Verify only commands table has rows (and no outcomes yet)
        expect(db.prepare('SELECT count(*) AS count FROM commands').get()).toEqual({ count: 6 })
        expect(db.prepare('SELECT count(*) AS count FROM command_outcomes').get()).toEqual({ count: 0 })

        // 5. Run the apply step (supervisor starts)
        apply(db, dir)

        // 6. Verify they applied in order
        expect(outcome(db, idLimitsSet)).toEqual({ outcome: 'applied', reason: null })
        expect(outcome(db, idQuotaSet)).toEqual({ outcome: 'applied', reason: null })
        expect(outcome(db, idBudgetProj)).toEqual({ outcome: 'applied', reason: null })
        expect(outcome(db, idTaskCreate)).toEqual({ outcome: 'applied', reason: null })
        expect(outcome(db, idLimitsOverwrite)).toEqual({ outcome: 'applied', reason: null })
        expect(outcome(db, idLimitsClear)).toEqual({ outcome: 'applied', reason: null })

        // Final state reflects sequential execution:
        // limits was set to 2, then to 6, then cleared -> project_limits is empty
        expect(db.prepare('SELECT * FROM project_limits WHERE project_id = ?').get('p1')).toBeUndefined()

        // quota_windows has anthropic row
        const quotaRow = db.prepare("SELECT provider, window_ms, max_units FROM quota_windows WHERE project_id = 'p1' AND provider = 'anthropic'").get()
        expect(quotaRow).toEqual({ provider: 'anthropic', window_ms: 15000, max_units: 4 })

        // budget_caps has project row
        const budgetRow = db.prepare("SELECT level, key, cap_units FROM budget_caps WHERE project_id = 'p1' AND level = 'project'").get()
        expect(budgetRow).toEqual({ level: 'project', key: '', cap_units: 80 })

        // task row exists with created_by_command = idTaskCreate
        const taskRow = db.prepare('SELECT id, created_by_command, title, provider FROM tasks WHERE id = ?').get(idTaskCreate)
        expect(taskRow).toEqual({ id: idTaskCreate, created_by_command: idTaskCreate, title: 'Queued Task A', provider: 'default' })
      } finally {
        db.close()
      }
    })
  })

  describe('CHK-M7-06-c: task create --provider validation and rejection reasons table cases', () => {
    it('CHK-M7-06-c: task create --provider stores provider, default handling, unconfigured/invalid provider rejection, and preserved on clear', () => {
      const { db, dir } = setup()
      try {
        // 1. Absent flag stores 'default'
        const idNoFlag = append(db, 'task.create', { title: 'Task without provider flag' })
        apply(db, dir)
        expect(outcome(db, idNoFlag)).toEqual({ outcome: 'applied', reason: null })
        const taskNoFlag = db.prepare('SELECT id, provider FROM tasks WHERE id = ?').get(idNoFlag) as { id: string; provider: string }
        expect(taskNoFlag.provider).toBe('default')

        // 2. --provider default is always valid and stores 'default'
        const idExplicitDefault = append(db, 'task.create', { title: 'Task explicit default', provider: 'default' })
        apply(db, dir)
        expect(outcome(db, idExplicitDefault)).toEqual({ outcome: 'applied', reason: null })
        const taskExplicitDefault = db.prepare('SELECT id, provider FROM tasks WHERE id = ?').get(idExplicitDefault) as { id: string; provider: string }
        expect(taskExplicitDefault.provider).toBe('default')

        // 3. A provider with a quota_windows row in the project is valid
        append(db, 'quota.set', { provider: 'bedrock', windowMs: 10000, maxUnits: 5 })
        apply(db, dir)
        const idBedrock = append(db, 'task.create', { title: 'Task with bedrock provider', provider: 'bedrock' })
        apply(db, dir)
        expect(outcome(db, idBedrock)).toEqual({ outcome: 'applied', reason: null })
        const taskBedrock = db.prepare('SELECT id, provider FROM tasks WHERE id = ?').get(idBedrock) as { id: string; provider: string }
        expect(taskBedrock.provider).toBe('bedrock')

        // 4. An unconfigured provider is rejected with unknown-provider
        const idUnconfigured = append(db, 'task.create', { title: 'Task unconfigured', provider: 'unknown-provider' })
        apply(db, dir)
        expect(outcome(db, idUnconfigured)).toEqual({ outcome: 'rejected', reason: 'unknown-provider' })
        expect(db.prepare('SELECT id FROM tasks WHERE id = ?').get(idUnconfigured)).toBeUndefined()

        // 5. Provider name violating ^[a-z0-9][a-z0-9-]{0,31}$ is rejected with unknown-provider
        const invalidProviderNames = [
          { name: 'Default', label: 'uppercase Default' },
          { name: 'Claude', label: 'uppercase Claude' },
          { name: 'OPENAI', label: 'all uppercase' },
          { name: '', label: 'empty string' },
          { name: 'a'.repeat(33), label: '33 chars (exceeds 32)' },
          { name: '-leading-dash', label: 'leading dash' },
          { name: 'has space', label: 'contains space' },
          { name: 'provider_underscore', label: 'contains underscore' },
          { name: 'prov@ider', label: 'contains special char' },
        ]
        for (const { name, label } of invalidProviderNames) {
          const idInvalid = append(db, 'task.create', { title: `Task ${label}`, provider: name })
          apply(db, dir)
          expect(outcome(db, idInvalid), `Expected rejection for provider: ${label}`).toEqual({
            outcome: 'rejected',
            reason: 'unknown-provider',
          })
          expect(db.prepare('SELECT id FROM tasks WHERE id = ?').get(idInvalid)).toBeUndefined()
        }

        // 6. A provider whose window was cleared later keeps its existing tasks and becomes unlimited
        append(db, 'quota.clear', { provider: 'bedrock' })
        apply(db, dir)
        // quota window is gone
        expect(db.prepare("SELECT * FROM quota_windows WHERE project_id = 'p1' AND provider = 'bedrock'").get()).toBeUndefined()
        // Existing task is untouched and retains its provider
        const taskStillBedrock = db.prepare('SELECT id, provider, status FROM tasks WHERE id = ?').get(idBedrock) as {
          id: string
          provider: string
          status: string
        }
        expect(taskStillBedrock).toBeDefined()
        expect(taskStillBedrock.provider).toBe('bedrock')
        expect(taskStillBedrock.status).toBe('ready')
      } finally {
        db.close()
      }
    })

    const allRejectionReasonsTable = [
      {
        name: 'invalid-number: limits.set with non-positive integer',
        kind: 'limits.set',
        payload: { maxParallel: 0 },
        expectedReason: 'invalid-number',
      },
      {
        name: 'unknown-level: budget.set with invalid level',
        kind: 'budget.set',
        payload: { level: 'cluster', cap: 10 },
        expectedReason: 'unknown-level',
      },
      {
        name: 'missing-key: budget.set phase without key',
        kind: 'budget.set',
        payload: { level: 'phase', cap: 10 },
        expectedReason: 'missing-key',
      },
      {
        name: 'key-not-allowed: budget.set project with unexpected key',
        kind: 'budget.set',
        payload: { level: 'project', key: 'development', cap: 10 },
        expectedReason: 'key-not-allowed',
      },
      {
        name: 'unknown-key: budget.set phase with unregistered phase name',
        kind: 'budget.set',
        payload: { level: 'phase', key: 'nonexistent-phase', cap: 10 },
        expectedReason: 'unknown-key',
      },
      {
        name: 'unknown-provider: task.create with unconfigured provider',
        kind: 'task.create',
        payload: { title: 'Unknown provider task', provider: 'nonexistent-provider' },
        expectedReason: 'unknown-provider',
      },
    ]

    it.each(allRejectionReasonsTable)(
      'CHK-M7-06-c table case: $name records $expectedReason',
      ({ kind, payload, expectedReason }) => {
        const { db, dir } = setup()
        try {
          const id = append(db, kind, payload)
          apply(db, dir)
          expect(outcome(db, id)).toEqual({ outcome: 'rejected', reason: expectedReason })
        } finally {
          db.close()
        }
      },
    )
  })
})
