import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  formatStatus,
  readStatus,
  type Status,
  type PhaseStatus,
} from '../supervisor/src/app/status.ts'
import { openStore } from '../supervisor/src/app/store.ts'
import { PHASES } from '../supervisor/src/core/graph.ts'

const cli = join(process.cwd(), 'supervisor/src/cli/main.ts')
const stamp = '2026-01-01T00:00:00.000Z'
const closed = '2026-01-02T00:00:00.000Z'

const dirs: string[] = []
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-m5-07-unit-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function seedProject(db: DatabaseSync, projectId = 'p') {
  db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(projectId, 'Project', stamp)
  db.prepare('INSERT INTO project_config (project_id, repo_path, base_ref, created_at) VALUES (?, ?, ?, ?)').run(projectId, '/dummy', 'main', stamp)
  const phase = db.prepare('INSERT INTO phases (project_id, name, ord, status, opened_at, closed_at) VALUES (?, ?, ?, ?, ?, ?)')
  phase.run(projectId, 'intake', 1, 'open', stamp, null)
  phase.run(projectId, 'development', 2, 'locked', null, null)
  phase.run(projectId, 'qa', 3, 'locked', null, null)
  phase.run(projectId, 'devops', 4, 'locked', null, null)
  phase.run(projectId, 'handover', 5, 'locked', null, null)
}

function insertCommand(db: DatabaseSync, id = 'cmd-1', projectId = 'p') {
  db.prepare('INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)').run(id, projectId, 'task.create', '{}', stamp)
}

describe('M5-07 status unit and mutation tests', () => {
  describe('validation of arguments and database headers', () => {
    it('validates stateDir argument', () => {
      expect(() => readStatus('', { nowMs: 1000, staleAfterMs: 500 })).toThrow(/stateDir must be a non-empty string/)
      expect(() => readStatus('   ', { nowMs: 1000, staleAfterMs: 500 })).toThrow(/stateDir must be a non-empty string/)
      expect(() => readStatus(null as any, { nowMs: 1000, staleAfterMs: 500 })).toThrow(/stateDir must be a non-empty string/)
    })

    it('validates nowMs argument', () => {
      const dir = makeDir()
      openStore(join(dir, 'state.sqlite')).close()
      expect(() => readStatus(dir, { nowMs: -1, staleAfterMs: 500 })).toThrow(/nowMs must be a nonnegative safe integer/)
      expect(() => readStatus(dir, { nowMs: 1.5, staleAfterMs: 500 })).toThrow(/nowMs must be a nonnegative safe integer/)
      expect(() => readStatus(dir, { nowMs: NaN, staleAfterMs: 500 })).toThrow(/nowMs must be a nonnegative safe integer/)
      expect(() => readStatus(dir, { nowMs: null as any, staleAfterMs: 500 })).toThrow(/nowMs must be a nonnegative safe integer/)
    })

    it('validates staleAfterMs argument', () => {
      const dir = makeDir()
      openStore(join(dir, 'state.sqlite')).close()
      expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 0 })).toThrow(/staleAfterMs must be a positive safe integer/)
      expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: -10 })).toThrow(/staleAfterMs must be a positive safe integer/)
      expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 1.5 })).toThrow(/staleAfterMs must be a positive safe integer/)
      expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: null as any })).toThrow(/staleAfterMs must be a positive safe integer/)
    })

    it('validates unsupported user_version', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        db.exec('PRAGMA user_version = 8')
      } finally {
        db.close()
      }
      expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow(/unsupported schema version 8/)
    })

    it('validates corrupted command count', () => {
      const dir = makeDir()
      openStore(join(dir, 'state.sqlite')).close()
      const originalPrepare = DatabaseSync.prototype.prepare
      const spy = (DatabaseSync.prototype.prepare = function (sql: string, ...rest: any[]) {
        if (sql.includes('COUNT(*) AS count FROM commands')) {
          return { get: () => ({ count: -1 }) } as any
        }
        return originalPrepare.call(this, sql, ...rest)
      })
      try {
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow(/command count is not a nonnegative safe integer/)
      } finally {
        DatabaseSync.prototype.prepare = originalPrepare
      }
    })
  })

  describe('lease validation and freshness', () => {
    it('handles corrupt supervisor_lease with multiple rows', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        db.exec("PRAGMA ignore_check_constraints = ON")
        db.exec("INSERT INTO supervisor_lease VALUES (1, 'o1', 1, 500, 'active'), (2, 'o2', 2, 600, 'active')")
      } finally {
        db.close()
      }
      expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow(/corrupt supervisor_lease table/)
    })

    it('rejects malformed supervisor_lease row fields', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        db.exec("PRAGMA ignore_check_constraints = ON")

        // bad owner_id (empty)
        db.exec("INSERT INTO supervisor_lease VALUES (1, '', 1, 500, 'active')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow(/malformed supervisor_lease row/)
        db.exec("DELETE FROM supervisor_lease")

        // bad generation (0)
        db.exec("INSERT INTO supervisor_lease VALUES (1, 'o1', 0, 500, 'active')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow(/malformed supervisor_lease row/)
        db.exec("DELETE FROM supervisor_lease")

        // bad heartbeat_ms (-1)
        db.exec("INSERT INTO supervisor_lease VALUES (1, 'o1', 1, -1, 'active')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow(/malformed supervisor_lease row/)
        db.exec("DELETE FROM supervisor_lease")

        // bad status
        db.exec("INSERT INTO supervisor_lease VALUES (1, 'o1', 1, 500, 'invalid')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow(/malformed supervisor_lease row/)
      } finally {
        db.close()
      }
    })

    it('classifies all lease freshness states', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        // released -> not-applicable
        db.exec("INSERT INTO supervisor_lease VALUES (1, 'o1', 1, 500, 'released')")
        let status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
        expect(status.lease?.freshness).toBe('not-applicable')
        expect(formatStatus(status)).toContain('غير منطبق')
        db.exec("DELETE FROM supervisor_lease")

        // future: heartbeatMs > nowMs
        db.exec("INSERT INTO supervisor_lease VALUES (1, 'o1', 1, 2000, 'active')")
        status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
        expect(status.lease?.freshness).toBe('future')
        expect(formatStatus(status)).toContain('في المستقبل')
        db.exec("DELETE FROM supervisor_lease")

        // stale: nowMs - heartbeatMs >= staleAfterMs (1000 - 400 = 600 >= 500)
        db.exec("INSERT INTO supervisor_lease VALUES (1, 'o1', 1, 400, 'active')")
        status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
        expect(status.lease?.freshness).toBe('stale')
        expect(formatStatus(status)).toContain('قديم')
        db.exec("DELETE FROM supervisor_lease")

        // fresh: nowMs - heartbeatMs < staleAfterMs (1000 - 800 = 200 < 500)
        db.exec("INSERT INTO supervisor_lease VALUES (1, 'o1', 1, 800, 'active')")
        status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
        expect(status.lease?.freshness).toBe('fresh')
        expect(formatStatus(status)).toContain('حديث')
      } finally {
        db.close()
      }
    })
  })

  describe('command outcomes and outbox validation', () => {
    it('detects outcomes count exceeding recorded commands', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        seedProject(db)
        db.exec("PRAGMA foreign_keys = OFF")
        db.exec("INSERT INTO command_outcomes VALUES ('c1', 'applied', NULL, 1, '2026-01-01')")
      } finally {
        db.close()
      }
      expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow(/command outcome count exceeds recorded commands/)
    })

    it('validates outbox status and payload_json format', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        seedProject(db)
        db.exec("INSERT INTO outbox VALUES ('o1', 'k1', 'kind', 'not-json', 'pending', 0, 0, NULL, 'now', 'now')")
        expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow(/malformed outbox payload_json/)
      } finally {
        db.close()
      }
    })
  })

  describe('phases and tasks validation and computation', () => {
    it('rejects partial phase rows for a project', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        seedProject(db)
        db.exec("DROP TRIGGER phases_no_delete")
        db.exec("DELETE FROM phases WHERE project_id = 'p' AND name IN ('handover', 'devops')")
      } finally {
        db.close()
      }
      expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow(/project has missing phase row/)
    })

    it('rejects duplicate or corrupt phase names or ords', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        seedProject(db)
        db.exec("DROP TRIGGER phases_no_delete")
        db.exec("DROP TABLE phases")
        db.exec("CREATE TABLE phases (project_id TEXT, name TEXT, ord INTEGER, status TEXT, opened_at TEXT, closed_at TEXT)")
        // Insert 5 rows with corrupt names
        db.exec(`
          INSERT INTO phases (project_id, name, ord, status, opened_at, closed_at) VALUES
            ('p', 'intake', 1, 'done', 'now', 'now'),
            ('p', 'development', 2, 'open', 'now', NULL),
            ('p', 'qa', 3, 'locked', NULL, NULL),
            ('p', 'devops', 4, 'locked', NULL, NULL),
            ('p', 'corrupt', 5, 'locked', NULL, NULL)
        `)
      } finally {
        db.close()
      }
      expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow(/malformed phase row/)
    })

    it('rejects more than one open phase', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        seedProject(db)
        db.exec("DROP INDEX phases_one_open")
        db.exec("UPDATE phases SET status = 'open' WHERE name = 'qa'")
      } finally {
        db.close()
      }
      expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow(/more than one open phase/)
    })

    it('rejects invalid task phase', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        seedProject(db)
        insertCommand(db, 'c1')
        db.exec("PRAGMA ignore_check_constraints = ON")
        db.exec("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, phase) VALUES ('t1', 'p', 'c1', 'T1', 'ready', 'now', 'now', '[\".\"]', 'invalid-phase')")
      } finally {
        db.close()
      }
      expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow(/invalid task phase invalid-phase/)
    })

    it('rejects task_deps pointing to missing tasks', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        seedProject(db)
        insertCommand(db, 'c1')
        db.exec("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, phase) VALUES ('t1', 'p', 'c1', 'T1', 'ready', 'now', 'now', '[\".\"]', 'intake')")
        db.exec("PRAGMA foreign_keys = OFF")
        db.exec("INSERT INTO task_deps VALUES ('t1', 'missing')")
      } finally {
        db.close()
      }
      expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow(/task_deps row points to a missing task/)
    })

    it('counts all task statuses accurately per phase', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        seedProject(db)
        for (let i = 1; i <= 6; i++) insertCommand(db, `c${i}`)
        const insertTask = db.prepare('INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, phase) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        insertTask.run('t-ready', 'p', 'c1', 'Ready', 'ready', stamp, stamp, '["a"]', 'intake')
        insertTask.run('t-prog', 'p', 'c2', 'Progress', 'progress', stamp, stamp, '["b"]', 'intake')
        insertTask.run('t-block', 'p', 'c3', 'Blocked', 'blocked', stamp, stamp, '["c"]', 'intake')
        insertTask.run('t-fail', 'p', 'c4', 'Failed', 'failed', stamp, stamp, '["d"]', 'intake')
        insertTask.run('t-done', 'p', 'c5', 'Done', 'done', stamp, stamp, '["e"]', 'intake')
        insertTask.run('t-drop', 'p', 'c6', 'Dropped', 'dropped', stamp, stamp, '["f"]', 'intake')
      } finally {
        db.close()
      }
      const status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
      const intakePhase = status.phases.find(p => p.name === 'intake')!
      expect(intakePhase.tasks).toEqual({
        ready: 1,
        progress: 1,
        blocked: 1,
        failed: 1,
        done: 1,
        dropped: 1,
      })
    })

    it('computes blockedBy independently from waiting and handles disjoint scopes', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        seedProject(db)
        for (let i = 1; i <= 5; i++) insertCommand(db, `c${i}`)
        const insertTask = db.prepare('INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, phase) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        insertTask.run('prog-1', 'p', 'c1', 'P1', 'progress', stamp, stamp, '["src"]', 'development')
        insertTask.run('prog-2', 'p', 'c2', 'P2', 'progress', stamp, stamp, '["docs"]', 'development')
        insertTask.run('ready-src', 'p', 'c3', 'R1', 'ready', stamp, stamp, '["src/api"]', 'development')
        insertTask.run('ready-docs', 'p', 'c4', 'R2', 'ready', stamp, stamp, '["docs/faq"]', 'development')
        insertTask.run('ready-disjoint', 'p', 'c5', 'R3', 'ready', stamp, stamp, '["other"]', 'development')
      } finally {
        db.close()
      }
      const status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
      const r1 = status.tasks!.find(t => t.id === 'ready-src')!
      const r2 = status.tasks!.find(t => t.id === 'ready-docs')!
      const r3 = status.tasks!.find(t => t.id === 'ready-disjoint')!
      expect(r1.blockedBy).toEqual(['prog-1'])
      expect(r2.blockedBy).toEqual(['prog-2'])
      expect(r3.blockedBy).toEqual([])
    })

    it('correctly handles blocked tasks in planDispatch where waiting becomes null', () => {
      const dir = makeDir()
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        seedProject(db)
        insertCommand(db, 'c1')
        insertCommand(db, 'c2')
        const insertTask = db.prepare('INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, phase) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        insertTask.run('t-dropped', 'p', 'c1', 'Dropped', 'dropped', stamp, stamp, '["a"]', 'intake')
        // t-ready depends on dropped -> planDispatch puts it in block, so waiting is null
        insertTask.run('t-ready', 'p', 'c2', 'Ready on dropped', 'ready', stamp, stamp, '["b"]', 'intake')
        db.prepare('INSERT INTO task_deps VALUES (?, ?)').run('t-ready', 't-dropped')
      } finally {
        db.close()
      }
      const status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
      const readyTask = status.tasks!.find(t => t.id === 't-ready')!
      expect(readyTask.dependsOn).toEqual(['t-dropped'])
      expect(readyTask.waiting).toBeNull()
    })
  })

  describe('formatStatus comprehensive rendering', () => {
    it('renders all enum values and status labels', () => {
      const allPhases: PhaseStatus[] = ['locked', 'open', 'done']
      const formattedPhases = allPhases.map(s => {
        const dummy: Status = {
          schemaVersion: 7,
          recordedCommandCount: 1,
          lease: null,
          phases: [{ name: 'intake', ord: 1, status: s, openedAt: null, closedAt: null, tasks: { ready: 0, progress: 0, blocked: 0, failed: 0, done: 0, dropped: 0 } }],
        }
        return formatStatus(dummy)
      })
      expect(formattedPhases[0]).toContain('مقفلة')
      expect(formattedPhases[1]).toContain('مفتوحة')
      expect(formattedPhases[2]).toContain('مكتملة')
    })

    it('renders phase openedAt, closedAt, and task counts in Arabic view', () => {
      const dummy: Status = {
        schemaVersion: 7,
        recordedCommandCount: 1,
        lease: null,
        phases: [
          {
            name: 'development',
            ord: 2,
            status: 'open',
            openedAt: '2026-01-01T12:00:00.000Z',
            closedAt: null,
            tasks: {
              ready: 3,
              progress: 2,
              blocked: 1,
              failed: 4,
              done: 5,
              dropped: 6,
            },
          },
          {
            name: 'intake',
            ord: 1,
            status: 'done',
            openedAt: '2026-01-01T00:00:00.000Z',
            closedAt: '2026-01-01T12:00:00.000Z',
            tasks: {
              ready: 0,
              progress: 0,
              blocked: 0,
              failed: 0,
              done: 1,
              dropped: 0,
            },
          },
        ],
      }

      const text = formatStatus(dummy)
      const lines = text.split(/\r?\n/)
      const devLine = lines.find(l => l.includes('development'))!
      expect(devLine).toBe(
        'المرحلة: development (الترتيب=2)، الحالة=مفتوحة (المرحلة المفتوحة)، وقت الفتح=2026-01-01T12:00:00.000Z، وقت الإغلاق=غير محدد، المهام: جاهزة=3، قيد التقدم=2، محظورة=1، فاشلة=4، مكتملة=5، متروكة=6',
      )

      const intakeLine = lines.find(l => l.includes('intake'))!
      expect(intakeLine).toBe(
        'المرحلة: intake (الترتيب=1)، الحالة=مكتملة، وقت الفتح=2026-01-01T00:00:00.000Z، وقت الإغلاق=2026-01-01T12:00:00.000Z، المهام: جاهزة=0، قيد التقدم=0، محظورة=0، فاشلة=0، مكتملة=1، متروكة=0',
      )
    })

    it('handles phase with null dates and default task counts when omitted', () => {
      const dummy: Status = {
        schemaVersion: 7,
        recordedCommandCount: 1,
        lease: null,
        phases: [
          {
            name: 'qa',
            ord: 3,
            status: 'locked',
            openedAt: null,
            closedAt: null,
            tasks: undefined as any,
          },
        ],
      }
      const text = formatStatus(dummy)
      expect(text).toContain(
        'المرحلة: qa (الترتيب=3)، الحالة=مقفلة، وقت الفتح=غير محدد، وقت الإغلاق=غير محدد، المهام: جاهزة=0، قيد التقدم=0، محظورة=0، فاشلة=0، مكتملة=0، متروكة=0',
      )
    })

    it('renders waiting reason labels with and without target items', () => {
      const reasons = ['phase-locked', 'deps', 'scope', 'backoff', 'custom-reason'] as const
      for (const reason of reasons) {
        const dummy: Status = {
          schemaVersion: 7,
          recordedCommandCount: 1,
          lease: null,
          phases: [],
          tasks: [
            {
              id: 't1',
              title: 'Task 1',
              status: 'ready',
              scope: ['src'],
              maxAttempts: 3,
              timeoutMs: 2000,
              notBeforeMs: 100,
              blockedBy: ['t0'],
              phase: 'intake',
              dependsOn: ['t0'],
              waiting: { reason: reason as any, on: ['t0'] },
              attempts: [],
            },
          ],
        }
        const text = formatStatus(dummy)
        expect(text).toContain('المهمة تعتمد على: t0')
        expect(text).toContain('المهمة محظورة بواسطة: t0')
        expect(text).toContain('سبب الانتظار:')
        expect(text).toContain('(t0)')
      }
    })

    it('renders task attempts with evidence and suspect workers', () => {
      const dummy: Status = {
        schemaVersion: 7,
        recordedCommandCount: 1,
        lease: null,
        phases: [],
        tasks: [
          {
            id: 't1',
            title: 'Task 1',
            status: 'progress',
            scope: ['src'],
            maxAttempts: 3,
            timeoutMs: 2000,
            notBeforeMs: 100,
            blockedBy: [],
            phase: 'intake',
            dependsOn: [],
            waiting: null,
            attempts: [
              {
                no: 1,
                status: 'running',
                exitCode: null,
                errorClass: 'transient',
                deadlineMs: 99999,
                worker: Object.defineProperty(
                  { pid: 1234, state: 'running', heartbeatMs: 500 },
                  'isSuspect',
                  { value: true, enumerable: false }
                ),
                evidence: {
                  headSha: 'abc1234',
                  files: [{ path: 'file.txt', sha256: 'deadbeef' }],
                },
              },
            ],
          },
        ],
      }
      const text = formatStatus(dummy)
      expect(text).toContain('(مشبوه)')
      expect(text).toContain('التغيير=abc1234')
      expect(text).toContain('file.txt (deadbeef)')
    })
  })
})
