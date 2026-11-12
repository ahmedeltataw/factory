import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { applyPendingCommands } from '../../supervisor/src/app/apply-commands.ts'
import { appendCommand, CommandConflictError, type Command } from '../../supervisor/src/app/commands.ts'
import { openStore } from '../../supervisor/src/app/store.ts'
import { acquireSupervisor, type SupervisorLeaseHandle } from '../../supervisor/src/app/supervisor-lease.ts'

const PHASES = ['intake', 'development', 'qa', 'devops', 'handover'] as const
type PhaseName = (typeof PHASES)[number]

function phaseOrd(name: string): number {
  switch (name) {
    case 'intake':
      return 1
    case 'development':
      return 2
    case 'qa':
      return 3
    case 'devops':
      return 4
    case 'handover':
      return 5
    default:
      return 0
  }
}

function ensureSchemaV7(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  const v = Number(row?.user_version ?? 0)
  if (v < 6) {
    db.exec('ALTER TABLE tasks ADD COLUMN scope_json TEXT NOT NULL DEFAULT \'["."]\' CHECK (json_valid(scope_json))')
    db.exec('ALTER TABLE tasks ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10)')
    db.exec('ALTER TABLE tasks ADD COLUMN timeout_ms INTEGER CHECK (timeout_ms IS NULL OR timeout_ms BETWEEN 1000 AND 86400000)')
    db.exec('ALTER TABLE tasks ADD COLUMN attempt_base INTEGER NOT NULL DEFAULT 0 CHECK (attempt_base >= 0)')
    db.exec('ALTER TABLE tasks ADD COLUMN not_before_ms INTEGER NOT NULL DEFAULT 0 CHECK (not_before_ms >= 0)')
    db.exec('ALTER TABLE attempts ADD COLUMN deadline_ms INTEGER CHECK (deadline_ms IS NULL OR deadline_ms >= 0)')
    db.exec('PRAGMA user_version = 6')
  }
  if (v < 7) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS phases (
        project_id TEXT NOT NULL REFERENCES projects(id),
        name TEXT NOT NULL CHECK (name IN ('intake','development','qa','devops','handover')),
        ord INTEGER NOT NULL CHECK (ord BETWEEN 1 AND 5),
        status TEXT NOT NULL CHECK (status IN ('locked','open','done')),
        opened_at TEXT,
        closed_at TEXT,
        PRIMARY KEY (project_id, name),
        UNIQUE (project_id, ord),
        CHECK (ord = CASE name WHEN 'intake' THEN 1 WHEN 'development' THEN 2 WHEN 'qa' THEN 3 WHEN 'devops' THEN 4 WHEN 'handover' THEN 5 END)
      )
    `)
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS phases_one_open ON phases(project_id) WHERE status = 'open'`)
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS phases_no_delete BEFORE DELETE ON phases
      BEGIN SELECT RAISE(ABORT, 'phases are permanent'); END
    `)
    const pragmaTasks = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
    if (!pragmaTasks.some((c) => c.name === 'phase')) {
      db.exec(`ALTER TABLE tasks ADD COLUMN phase TEXT NOT NULL DEFAULT 'intake' CHECK (phase IN ('intake','development','qa','devops','handover'))`)
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_deps (
        task_id TEXT NOT NULL REFERENCES tasks(id),
        depends_on TEXT NOT NULL REFERENCES tasks(id),
        PRIMARY KEY (task_id, depends_on),
        CHECK (task_id <> depends_on)
      )
    `)
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS task_deps_no_update BEFORE UPDATE ON task_deps
      BEGIN SELECT RAISE(ABORT, 'task_deps are immutable'); END
    `)
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS task_deps_no_delete BEFORE DELETE ON task_deps
      BEGIN SELECT RAISE(ABORT, 'task_deps are immutable'); END
    `)
    db.exec('PRAGMA user_version = 7')
  }
}

function seedProjectPhases(db: DatabaseSync, projectId: string, openedAt = '2026-11-10T00:00:00.000Z'): void {
  const existing = db.prepare('SELECT COUNT(*) as c FROM phases WHERE project_id = ?').get(projectId) as { c: number }
  if (existing.c === 0) {
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
}

const directories: string[] = []

function safeRemoveDir(dir: string): void {
  const maxRetries = 10
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (err) {
      if (attempt === maxRetries) {
        throw new Error(`Failed to remove directory ${dir} after ${maxRetries} attempts: ${String(err)}`)
      }
      const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
      Atomics.wait(waitBuffer, 0, 0, 50)
    }
  }
}

afterEach(() => {
  const errors: unknown[] = []
  for (const directory of directories.splice(0)) {
    try {
      safeRemoveDir(directory)
    } catch (err) {
      errors.push(err)
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Cleanup failed to remove temporary directories')
  }
})

type Action =
  | {
      readonly type: 'create'
      readonly idSlot: number
      readonly title: string
      readonly phase: 'intake' | 'development' | 'qa' | 'devops' | 'handover' | 'invalid' | null
      readonly depIndices: number[]
      readonly scope: string[]
      readonly maxAttempts: number
      readonly timeoutMs: number | null
    }
  | {
      readonly type: 'advance_phase'
      readonly idSlot: number
      readonly phase: 'intake' | 'development' | 'qa' | 'devops' | 'handover' | 'invalid'
    }
  | {
      readonly type: 'kill'
      readonly idSlot: number
      readonly targetSlot: number
    }
  | {
      readonly type: 'retry'
      readonly idSlot: number
      readonly targetSlot: number
    }
  | {
      readonly type: 'advance_task'
      readonly targetSlot: number
      readonly newStatus: 'ready' | 'progress' | 'failed' | 'done' | 'dropped'
    }
  | {
      readonly type: 'apply'
    }

const taskIds = ['prop-t1', 'prop-t2', 'prop-t3', 'prop-t4']

const actionArbitrary: fc.Arbitrary<Action> = fc.oneof(
  fc.record({
    type: fc.constant('create' as const),
    idSlot: fc.integer({ min: 0, max: taskIds.length - 1 }),
    title: fc.string({ minLength: 1, maxLength: 20 }),
    phase: fc.constantFrom<'intake' | 'development' | 'qa' | 'devops' | 'handover' | 'invalid' | null>(
      null,
      'intake',
      'development',
      'qa',
      'devops',
      'handover',
      'invalid',
    ),
    depIndices: fc.array(fc.integer({ min: 0, max: taskIds.length - 1 }), { maxLength: 3 }),
    scope: fc.constantFrom<string[]>(['.'], ['src'], ['src/a', 'src/b']),
    maxAttempts: fc.integer({ min: 1, max: 10 }),
    timeoutMs: fc.constantFrom<number | null>(null, 2000, 10000),
  }),
  fc.record({
    type: fc.constant('advance_phase' as const),
    idSlot: fc.integer({ min: 0, max: 8 }),
    phase: fc.constantFrom<'intake' | 'development' | 'qa' | 'devops' | 'handover' | 'invalid'>(
      'intake',
      'development',
      'qa',
      'devops',
      'handover',
      'invalid',
    ),
  }),
  fc.record({
    type: fc.constant('kill' as const),
    idSlot: fc.integer({ min: 0, max: 8 }),
    targetSlot: fc.integer({ min: 0, max: taskIds.length - 1 }),
  }),
  fc.record({
    type: fc.constant('retry' as const),
    idSlot: fc.integer({ min: 0, max: 8 }),
    targetSlot: fc.integer({ min: 0, max: taskIds.length - 1 }),
  }),
  fc.record({
    type: fc.constant('advance_task' as const),
    targetSlot: fc.integer({ min: 0, max: taskIds.length - 1 }),
    newStatus: fc.constantFrom<'ready' | 'progress' | 'failed' | 'done' | 'dropped'>('ready', 'progress', 'failed', 'done', 'dropped'),
  }),
  fc.record({
    type: fc.constant('apply' as const),
  }),
)

describe('M5-05 CHK-M5-05-e: property invariants for commands and apply', () => {
  it('CHK-M5-05-e: random sequences of create, kill, retry and advance commands preserve phase and dependency invariants', () => {
    let totalGeneratedApplied = 0

    fc.assert(
      fc.property(fc.array(actionArbitrary, { minLength: 6, maxLength: 20 }), (actions) => {
        const stateDir = mkdtempSync(join(tmpdir(), 'factory-prop-m5-'))
        directories.push(stateDir)
        const dbPath = join(stateDir, 'state.sqlite')

        let db: DatabaseSync | undefined
        let handle: SupervisorLeaseHandle | undefined

        try {
          db = openStore(dbPath)
          ensureSchemaV7(db)
          handle = acquireSupervisor(db, stateDir, { nowMs: 1000, staleAfterMs: 300000 })
          db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'Property Project', '2026-11-10T00:00:00.000Z')").run()
          db.prepare("INSERT INTO project_config (project_id, repo_path, base_ref, created_at) VALUES ('p1', '/repo', 'main', '2026-11-10T00:00:00.000Z')").run()
          seedProjectPhases(db, 'p1')

          // Track phase transitions across apply runs:
          // a done phase never becomes open/locked, an open phase only becomes done, a locked phase only becomes open; at most one open.
          const previousPhaseStatus = new Map<string, 'locked' | 'open' | 'done'>()
          for (const p of PHASES) {
            previousPhaseStatus.set(p, p === 'intake' ? 'open' : 'locked')
          }

          let timeSeq = 1

          // Guaranteed seed to exercise dependencies and phase advance in every run
          const seedTask1 = 'seed-task-1'
          appendCommand(db, {
            id: seedTask1,
            projectId: 'p1',
            kind: 'task.create',
            payloadJson: JSON.stringify({
              title: 'Seed Task 1',
              scope: ['.'],
              maxAttempts: 3,
              timeoutMs: null,
              phase: 'intake',
              deps: [],
            }),
            createdAt: '2026-11-10T00:00:01.000Z',
          })
          applyPendingCommands(db, handle)

          const outcome1 = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get(seedTask1) as {
            outcome: string
            reason: string | null
          } | undefined
          expect(outcome1?.outcome, 'seed task 1 command must be applied').toBe('applied')
          expect(outcome1?.reason).toBeNull()

          // Finish seed task 1 and advance intake phase to development
          db.prepare("UPDATE tasks SET status = 'done', updated_at = '2026-11-10T00:00:02.000Z' WHERE id = ?").run(seedTask1)
          appendCommand(db, {
            id: 'seed-cmd-adv-1',
            projectId: 'p1',
            kind: 'phase.advance',
            payloadJson: JSON.stringify({ phase: 'intake' }),
            createdAt: '2026-11-10T00:00:03.000Z',
          })
          applyPendingCommands(db, handle)

          const outcomeAdv = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get('seed-cmd-adv-1') as {
            outcome: string
            reason: string | null
          } | undefined
          expect(outcomeAdv?.outcome, 'seed phase advance command must be applied').toBe('applied')
          expect(outcomeAdv?.reason).toBeNull()

          const intakePhase = db.prepare("SELECT status FROM phases WHERE project_id = 'p1' AND name = 'intake'").get() as { status: string } | undefined
          expect(intakePhase?.status, 'intake phase must advance to done').toBe('done')
          const devPhase = db.prepare("SELECT status FROM phases WHERE project_id = 'p1' AND name = 'development'").get() as { status: string } | undefined
          expect(devPhase?.status, 'development phase must advance to open').toBe('open')

          // Seed task 2 in development phase with dep on seed task 1
          const seedTask2 = 'seed-task-2'
          appendCommand(db, {
            id: seedTask2,
            projectId: 'p1',
            kind: 'task.create',
            payloadJson: JSON.stringify({
              title: 'Seed Task 2',
              scope: ['.'],
              maxAttempts: 3,
              timeoutMs: null,
              phase: 'development',
              deps: [seedTask1],
            }),
            createdAt: '2026-11-10T00:00:04.000Z',
          })
          applyPendingCommands(db, handle)

          const outcome2 = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get(seedTask2) as {
            outcome: string
            reason: string | null
          } | undefined
          expect(outcome2?.outcome, 'seed task 2 command must be applied').toBe('applied')
          expect(outcome2?.reason).toBeNull()

          const depRows = db.prepare('SELECT task_id, depends_on FROM task_deps WHERE task_id = ?').all(seedTask2) as Array<{
            task_id: string
            depends_on: string
          }>
          expect(depRows.length, 'seed task 2 must create task_deps rows').toBe(1)
          expect(depRows[0]).toEqual({ task_id: seedTask2, depends_on: seedTask1 })

          timeSeq = 10

          const verifyInvariants = () => {
            // Invariant 1: At most one open phase and valid phase transitions across apply runs
            const allPhases = db!.prepare("SELECT name, ord, status, opened_at, closed_at FROM phases WHERE project_id = 'p1' ORDER BY ord").all() as Array<{
              name: string
              ord: number
              status: 'locked' | 'open' | 'done'
              opened_at: string | null
              closed_at: string | null
            }>
            expect(allPhases).toHaveLength(5)

            const openPhases = allPhases.filter((p) => p.status === 'open')
            expect(openPhases.length, 'at most one phase may be open').toBeLessThanOrEqual(1)

            // Check phase transitions across apply runs:
            // a done phase never becomes open/locked, an open phase only becomes done, a locked phase only becomes open
            for (const p of allPhases) {
              const prev = previousPhaseStatus.get(p.name)
              if (prev !== undefined) {
                if (prev === 'done') {
                  expect(p.status, `done phase ${p.name} never becomes open or locked`).toBe('done')
                } else if (prev === 'open') {
                  expect(p.status === 'open' || p.status === 'done', `open phase ${p.name} only becomes done, got ${p.status}`).toBe(true)
                } else if (prev === 'locked') {
                  expect(p.status === 'locked' || p.status === 'open', `locked phase ${p.name} only becomes open, got ${p.status}`).toBe(true)
                }
              }
              previousPhaseStatus.set(p.name, p.status)
            }

            // Invariant 2: Phases only move forward
            let openSeen = false
            let lastDoneOrd = 0
            for (const p of allPhases) {
              if (p.status === 'done') {
                expect(openSeen, 'done phase must come before open phase').toBe(false)
                expect(p.opened_at, 'done phase must have opened_at').not.toBeNull()
                expect(p.closed_at, 'done phase must have closed_at').not.toBeNull()
                expect(p.ord).toBe(lastDoneOrd + 1)
                lastDoneOrd = p.ord
              } else if (p.status === 'open') {
                expect(openSeen, 'at most one open phase seen in ordered traversal').toBe(false)
                expect(p.opened_at, 'open phase must have opened_at').not.toBeNull()
                expect(p.closed_at, 'open phase must not have closed_at').toBeNull()
                expect(p.ord).toBe(lastDoneOrd + 1)
                openSeen = true
              } else if (p.status === 'locked') {
                expect(p.opened_at, 'locked phase must not have opened_at').toBeNull()
                expect(p.closed_at, 'locked phase must not have closed_at').toBeNull()
              }
            }

            // Invariant 3: Every task_deps edge points to an older task in the same or an earlier phase
            const depEdges = db!.prepare(`
              SELECT
                d.task_id,
                d.depends_on,
                t1.phase as t_phase,
                t1.created_at as t_created,
                t1.rowid as t_rowid,
                t2.phase as dep_phase,
                t2.created_at as dep_created,
                t2.rowid as dep_rowid
              FROM task_deps d
              JOIN tasks t1 ON d.task_id = t1.id
              JOIN tasks t2 ON d.depends_on = t2.id
            `).all() as Array<{
              task_id: string
              depends_on: string
              t_phase: string
              t_created: string
              t_rowid: number
              dep_phase: string
              dep_created: string
              dep_rowid: number
            }>

            for (const edge of depEdges) {
              // phaseOrd(dep.phase) <= phaseOrd(task.phase)
              expect(
                phaseOrd(edge.dep_phase),
                `dep ${edge.depends_on} (phase ${edge.dep_phase}) must have phaseOrd <= task ${edge.task_id} (phase ${edge.t_phase})`,
              ).toBeLessThanOrEqual(phaseOrd(edge.t_phase))

              // Dep task must be older: created earlier or lower rowid
              const depTime = new Date(edge.dep_created).getTime()
              const taskTime = new Date(edge.t_created).getTime()
              const isOlder = depTime < taskTime || (depTime === taskTime && edge.dep_rowid < edge.t_rowid)
              expect(isOlder, `dep ${edge.depends_on} must be older than task ${edge.task_id}`).toBe(true)
            }

            // Invariant 4: No command gets two outcomes
            const duplicateOutcomes = db!.prepare(`
              SELECT command_id, COUNT(*) as c FROM command_outcomes GROUP BY command_id HAVING c > 1
            `).all() as Array<{ command_id: string; c: number }>
            expect(duplicateOutcomes).toHaveLength(0)

            const outcomes = db!.prepare('SELECT command_id, outcome, reason FROM command_outcomes').all() as Array<{
              command_id: string
              outcome: string
              reason: string | null
            }>
            for (const o of outcomes) {
              expect(['applied', 'rejected']).toContain(o.outcome)
              if (o.outcome === 'applied') {
                expect(o.reason).toBeNull()
              } else {
                expect(typeof o.reason).toBe('string')
                expect(o.reason!.length).toBeGreaterThan(0)
              }
            }
          }

          // Initial verification after seeding
          verifyInvariants()

          for (const action of actions) {
            const timestamp = `2026-11-10T00:${String(Math.floor(timeSeq / 60)).padStart(2, '0')}:${String(timeSeq % 60).padStart(2, '0')}.000Z`
            timeSeq++

            if (action.type === 'create') {
              const cmdId = taskIds[action.idSlot]!
              const targetDeps = action.depIndices.map((i) => taskIds[i]!)
              // May also include seed tasks as potential deps
              if (action.depIndices.includes(0)) targetDeps.push(seedTask1)
              const uniqueSortedDeps = Array.from(new Set(targetDeps)).sort()

              try {
                appendCommand(db, {
                  id: cmdId,
                  projectId: 'p1',
                  kind: 'task.create',
                  payloadJson: JSON.stringify({
                    title: action.title,
                    scope: action.scope,
                    maxAttempts: action.maxAttempts,
                    timeoutMs: action.timeoutMs,
                    phase: action.phase,
                    deps: uniqueSortedDeps,
                  }),
                  createdAt: timestamp,
                })
              } catch (err) {
                if (!(err instanceof CommandConflictError)) throw err
              }
            } else if (action.type === 'advance_phase') {
              const cmdId = `adv-${action.idSlot}-${timeSeq}`
              try {
                appendCommand(db, {
                  id: cmdId,
                  projectId: 'p1',
                  kind: 'phase.advance',
                  payloadJson: JSON.stringify({ phase: action.phase }),
                  createdAt: timestamp,
                })
              } catch (err) {
                if (!(err instanceof CommandConflictError)) throw err
              }
            } else if (action.type === 'kill') {
              const cmdId = `kill-${action.idSlot}-${timeSeq}`
              const targetId = taskIds[action.targetSlot]!
              try {
                appendCommand(db, {
                  id: cmdId,
                  projectId: 'p1',
                  kind: 'task.kill',
                  payloadJson: JSON.stringify({ taskId: targetId }),
                  createdAt: timestamp,
                })
              } catch (err) {
                if (!(err instanceof CommandConflictError)) throw err
              }
            } else if (action.type === 'retry') {
              const cmdId = `retry-${action.idSlot}-${timeSeq}`
              const targetId = taskIds[action.targetSlot]!
              try {
                appendCommand(db, {
                  id: cmdId,
                  projectId: 'p1',
                  kind: 'task.retry',
                  payloadJson: JSON.stringify({ taskId: targetId }),
                  createdAt: timestamp,
                })
              } catch (err) {
                if (!(err instanceof CommandConflictError)) throw err
              }
            } else if (action.type === 'advance_task') {
              const targetId = taskIds[action.targetSlot]!
              const taskRow = db.prepare('SELECT status FROM tasks WHERE id = ?').get(targetId) as { status: string } | undefined
              if (taskRow) {
                db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(action.newStatus, timestamp, targetId)
              }
            } else if (action.type === 'apply') {
              applyPendingCommands(db, handle)
              verifyInvariants()
            }
          }

          // Final flush to apply any remaining pending commands
          applyPendingCommands(db, handle)
          verifyInvariants()

          const genApplied = (db.prepare(`
            SELECT COUNT(*) as c FROM command_outcomes
            WHERE command_id NOT IN ('seed-task-1', 'seed-cmd-adv-1', 'seed-task-2') AND outcome = 'applied'
          `).get() as { c: number }).c
          totalGeneratedApplied += genApplied
        } finally {
          if (handle) {
            try {
              handle.release(Date.now())
            } catch {
              // ignore
            }
          }
          if (db) {
            try {
              db.close()
            } catch {
              // ignore
            }
          }
        }
      }),
      { numRuns: 20 },
    )
    expect(totalGeneratedApplied, 'at least some generated commands must be applied across property runs').toBeGreaterThan(0)
  }, 60000)
})
