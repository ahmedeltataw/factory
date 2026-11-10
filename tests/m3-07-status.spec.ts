import childProcess from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  readStatus,
  formatStatus,
  type Status,
  type CommandsSummary,
  type OutboxSummary,
  type TaskStatusItem,
} from '../supervisor/src/app/status.ts'
import { openStore } from '../supervisor/src/app/store.ts'
import { appendCommand } from '../supervisor/src/app/commands.ts'
import { acquireSupervisor } from '../supervisor/src/app/supervisor-lease.ts'
import {
  TaskStatusSchema,
  AttemptStatusSchema,
  WorkerStateSchema,
  OutboxStatusSchema,
  CommandOutcomeSchema,
  type TaskStatus,
  type AttemptStatus,
  type WorkerState,
} from '../supervisor/src/app/domain.ts'

const dirs: string[] = []
function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-m3-07-test-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const stamp = '2026-11-10T00:00:00.000Z'

function seedV5(dir: string) {
  const db = openStore(join(dir, 'state.sqlite'))
  try {
    db.prepare('INSERT INTO projects VALUES (?, ?, ?)').run('proj-1', 'Project 1', stamp)
    db.prepare('INSERT INTO project_config VALUES (?, ?, ?, ?)').run('proj-1', process.cwd(), 'main', stamp)
    const handle = acquireSupervisor(db, dir, { nowMs: 1000, staleAfterMs: 500 })
    try {
      appendCommand(db, { id: 'cmd-1', projectId: 'proj-1', kind: 'task.create', payloadJson: '{"title":"Task 1","secret":"hidden"}', createdAt: stamp })
      appendCommand(db, { id: 'cmd-2', projectId: 'proj-1', kind: 'task.create', payloadJson: '{"title":"Task 2"}', createdAt: stamp })
      appendCommand(db, { id: 'cmd-3', projectId: 'proj-1', kind: 'task.kill', payloadJson: '{"taskId":"Task 1"}', createdAt: stamp })

      db.prepare("INSERT INTO command_outcomes VALUES ('cmd-1', 'applied', NULL, 1, ?)").run(stamp)
      db.prepare("INSERT INTO command_outcomes VALUES ('cmd-3', 'rejected', 'already completed', 1, ?)").run(stamp)

      db.prepare("INSERT INTO tasks VALUES ('t-1', 'proj-1', 'cmd-1', 'Task 1', 'progress', ?, ?)").run(stamp, stamp)
      db.prepare("INSERT INTO attempts VALUES ('att-1', 't-1', 1, 'running', NULL, NULL, 1, ?, NULL)").run(stamp)
      db.prepare("INSERT INTO workers VALUES ('att-1', 'nonce-secret-1', 9999, 'running', '/worktree/t-1', 1000, ?, NULL)").run(stamp)
      db.prepare("INSERT INTO evidence VALUES ('att-1', 'base-sha', 'head-sha-123', ?, 'out-hash', 'err-hash', ?)").run(
        JSON.stringify([{ path: 'src/main.ts', sha256: 'beefcafe1234' }]),
        stamp,
      )

      db.prepare("INSERT INTO outbox VALUES ('out-1', 'key-1', 'attempt.start', '{}', 'pending', 0, 1000, NULL, ?, ?)").run(stamp, stamp)
      db.prepare("INSERT INTO outbox VALUES ('out-2', 'key-2', 'attempt.kill', '{}', 'done', 1, 1000, NULL, ?, ?)").run(stamp, stamp)
      db.prepare("INSERT INTO outbox VALUES ('out-3', 'key-3', 'evidence.commit', '{}', 'failed', 3, 1000, 'boom', ?, ?)").run(stamp, stamp)

      return { db, handle }
    } catch (err) {
      handle.release(1000)
      throw err
    }
  } catch (err) {
    db.close()
    throw err
  }
}

describe('M3-07 Status Reader and Formatter', () => {
  it('reads status facts in a single read-only transaction without mutations', () => {
    const dir = fixtureDir()
    const { db, handle } = seedV5(dir)
    try {
      const countsBefore = {
        commands: (db.prepare('SELECT COUNT(*) AS n FROM commands').get() as { n: number }).n,
        command_outcomes: (db.prepare('SELECT COUNT(*) AS n FROM command_outcomes').get() as { n: number }).n,
        tasks: (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n,
        attempts: (db.prepare('SELECT COUNT(*) AS n FROM attempts').get() as { n: number }).n,
        workers: (db.prepare('SELECT COUNT(*) AS n FROM workers').get() as { n: number }).n,
        outbox: (db.prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }).n,
        evidence: (db.prepare('SELECT COUNT(*) AS n FROM evidence').get() as { n: number }).n,
        lease: db.prepare('SELECT * FROM supervisor_lease').get(),
      }

      const execSpy = vi.spyOn(DatabaseSync.prototype, 'exec')
      const transactions: boolean[] = []
      const originalPrepare = DatabaseSync.prototype.prepare
      const prepareSpy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
        transactions.push(this.isTransaction)
        return originalPrepare.call(this, sql)
      })

      const status = readStatus(dir, { nowMs: 1200, staleAfterMs: 500 })

      expect(transactions.length).toBeGreaterThan(0)
      expect(transactions.every(Boolean)).toBe(true)
      expect(execSpy.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT'])

      // Validate commands summary
      const commands = (status as { commands?: CommandsSummary }).commands
      expect(commands).toEqual({
        recorded: 3,
        applied: 1,
        rejected: 1,
        pending: 1,
      })

      // Validate outbox summary
      const outbox = (status as { outbox?: OutboxSummary }).outbox
      expect(outbox).toEqual({
        pending: 1,
        done: 1,
        failed: 1,
      })

      // Validate tasks
      const tasks = (status as { tasks?: readonly TaskStatusItem[] }).tasks
      expect(tasks).toEqual([
        {
          id: 't-1',
          title: 'Task 1',
          status: 'progress',
          attempts: [
            {
              no: 1,
              status: 'running',
              exitCode: null,
              worker: {
                pid: 9999,
                state: 'running',
                heartbeatMs: 1000,
              },
              evidence: {
                headSha: 'head-sha-123',
                files: [{ path: 'src/main.ts', sha256: 'beefcafe1234' }],
              },
            },
          ],
        },
      ])

      // DB remains completely unchanged
      expect((db.prepare('SELECT COUNT(*) AS n FROM commands').get() as { n: number }).n).toBe(countsBefore.commands)
      expect(db.prepare('SELECT * FROM supervisor_lease').get()).toEqual(countsBefore.lease)
    } finally {
      try { handle.release(1200) } finally { db.close() }
    }
  })

  it('marks stale workers as suspect without probing or killing PIDs', () => {
    const dir = fixtureDir()
    const { db, handle } = seedV5(dir)
    try {
      const killSpy = vi.spyOn(process, 'kill')
      const childSpies = (['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync'] as const).map(m => vi.spyOn(childProcess, m))

      // Fresh worker: nowMs 1200 - heartbeat 1000 = 200 < staleAfterMs 500
      const freshStatus = readStatus(dir, { nowMs: 1200, staleAfterMs: 500 })
      const freshText = formatStatus(freshStatus)
      const freshWorkerLine = freshText.split('\n').find(l => l.includes('9999')) ?? ''
      expect(freshWorkerLine).not.toMatch(/مشبوه|اشتباه|مشتبه/)
      expect(freshWorkerLine).not.toMatch(/ميت|dead/i)

      // Stale worker: nowMs 2000 - heartbeat 1000 = 1000 >= staleAfterMs 500
      const staleStatus = readStatus(dir, { nowMs: 2000, staleAfterMs: 500 })
      const staleText = formatStatus(staleStatus)
      expect(staleText).toMatch(/مشبوه/)
      const staleWorkerLine = staleText.split('\n').find(l => l.includes('9999')) ?? ''
      expect(staleWorkerLine).not.toMatch(/ميت|dead/i)
      expect(staleText).toContain('9999')

      // Ensure no PID probing occurred
      expect(killSpy).not.toHaveBeenCalled()
      for (const spy of childSpies) expect(spy).not.toHaveBeenCalled()
    } finally {
      try { handle.release(2000) } finally { db.close() }
    }
  })

  it('exposes lease takeover evidence in both JSON serialization and human Arabic view', () => {
    const dir = fixtureDir()
    const { db, handle } = seedV5(dir)
    try {
      const token = `${handle.ownerId}:${handle.generation}:1000`
      const status = readStatus(dir, { nowMs: 1200, staleAfterMs: 500 })

      // In JSON view (JSON.stringify via toJSON)
      const jsonStr = JSON.stringify(status)
      expect(jsonStr).toContain(token)
      const parsed = JSON.parse(jsonStr)
      expect(parsed.lease.takeover).toBe(token)

      // In Arabic human view
      const humanText = formatStatus(status)
      expect(humanText).toContain(token)
      expect(humanText).toContain('دليل الاستحواذ=')
    } finally {
      try { handle.release(1200) } finally { db.close() }
    }
  })

  it('rejects unsupported v4 database', () => {
    const dir = fixtureDir()
    const db = openStore(join(dir, 'state.sqlite'))
    try {
      db.exec('PRAGMA user_version = 4')
      expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow(/unsupported schema version 4/i)
    } finally {
      db.close()
    }
  })

  it('rejects invalid enum values in v5 rows', () => {
    const dir = fixtureDir()
    const { db, handle } = seedV5(dir)
    try {
      db.exec('PRAGMA ignore_check_constraints = ON')

      db.exec("UPDATE tasks SET status = 'bogus' WHERE id = 't-1'")
      expect(() => readStatus(dir, { nowMs: 1200, staleAfterMs: 500 })).toThrow(/invalid task status/i)
      db.exec("UPDATE tasks SET status = 'progress' WHERE id = 't-1'")

      db.exec("UPDATE attempts SET status = 'bogus' WHERE id = 'att-1'")
      expect(() => readStatus(dir, { nowMs: 1200, staleAfterMs: 500 })).toThrow(/invalid attempt status/i)
      db.exec("UPDATE attempts SET status = 'running' WHERE id = 'att-1'")

      db.exec("UPDATE workers SET state = 'bogus' WHERE attempt_id = 'att-1'")
      expect(() => readStatus(dir, { nowMs: 1200, staleAfterMs: 500 })).toThrow(/invalid worker state/i)
      db.exec("UPDATE workers SET state = 'running' WHERE attempt_id = 'att-1'")

      db.exec("UPDATE outbox SET status = 'bogus' WHERE id = 'out-1'")
      expect(() => readStatus(dir, { nowMs: 1200, staleAfterMs: 500 })).toThrow(/invalid outbox status/i)
      db.exec("UPDATE outbox SET status = 'pending' WHERE id = 'out-1'")

      db.exec("INSERT INTO command_outcomes VALUES ('cmd-2', 'bogus', NULL, 1, 'now')")
      expect(() => readStatus(dir, { nowMs: 1200, staleAfterMs: 500 })).toThrow(/invalid command outcome/i)
    } finally {
      try { handle.release(1200) } finally { db.close() }
    }
  })

  it('rejects malformed evidence JSON and schema', () => {
    // Invalid JSON syntax
    {
      const dir = fixtureDir()
      const { db, handle } = seedV5(dir)
      try {
        db.exec("INSERT INTO attempts VALUES ('att-bad-1', 't-1', 2, 'succeeded', 0, NULL, 1, 'now', NULL); INSERT INTO evidence VALUES ('att-bad-1', 'base', 'head', '{bad json', 'out', 'err', 'now')")
        expect(() => readStatus(dir, { nowMs: 1200, staleAfterMs: 500 })).toThrow(/malformed evidence/i)
      } finally {
        try { handle.release(1200) } finally { db.close() }
      }
    }

    // Not an array
    {
      const dir = fixtureDir()
      const { db, handle } = seedV5(dir)
      try {
        db.exec("INSERT INTO attempts VALUES ('att-bad-2', 't-1', 2, 'succeeded', 0, NULL, 1, 'now', NULL); INSERT INTO evidence VALUES ('att-bad-2', 'base', 'head', '{\"path\":\"a\"}', 'out', 'err', 'now')")
        expect(() => readStatus(dir, { nowMs: 1200, staleAfterMs: 500 })).toThrow(/must be an array/i)
      } finally {
        try { handle.release(1200) } finally { db.close() }
      }
    }

    // Invalid element schema
    {
      const dir = fixtureDir()
      const { db, handle } = seedV5(dir)
      try {
        db.exec("INSERT INTO attempts VALUES ('att-bad-3', 't-1', 2, 'succeeded', 0, NULL, 1, 'now', NULL); INSERT INTO evidence VALUES ('att-bad-3', 'base', 'head', '[{\"path\": 123}]', 'out', 'err', 'now')")
        expect(() => readStatus(dir, { nowMs: 1200, staleAfterMs: 500 })).toThrow(/invalid evidence file entry/i)
      } finally {
        try { handle.release(1200) } finally { db.close() }
      }
    }
  })

  it('never exposes command payloads or worker nonces', () => {
    const dir = fixtureDir()
    const { db, handle } = seedV5(dir)
    try {
      const status = readStatus(dir, { nowMs: 1200, staleAfterMs: 500 })
      const jsonStr = JSON.stringify(status)
      const humanText = formatStatus(status)

      expect(jsonStr).not.toContain('hidden')
      expect(jsonStr).not.toContain('nonce-secret-1')
      expect(humanText).not.toContain('hidden')
      expect(humanText).not.toContain('nonce-secret-1')
    } finally {
      try { handle.release(1200) } finally { db.close() }
    }
  })

  it('every enum value has a distinct Arabic label', () => {
    const base = {
      schemaVersion: 5 as const,
      recordedCommandCount: 0,
      lease: null,
      commands: { recorded: 0, applied: 0, rejected: 0, pending: 0 },
      outbox: { pending: 0, done: 0, failed: 0 },
      tasks: [
        {
          id: 'task',
          title: 'title',
          status: 'ready' as TaskStatus,
          attempts: [
            {
              no: 1,
              status: 'succeeded' as AttemptStatus,
              exitCode: 0,
              worker: { pid: 12345, state: 'running' as WorkerState, heartbeatMs: 1 },
              evidence: null,
            },
          ],
        },
      ],
    }

    // TaskStatus
    const taskOutputs = TaskStatusSchema.options.map(v => {
      const s = structuredClone(base)
      s.tasks[0]!.status = v
      return formatStatus(s as unknown as Status)
    })
    expect(new Set(taskOutputs).size).toBe(TaskStatusSchema.options.length)
    for (const out of taskOutputs) expect(out).toMatch(/[\u0600-\u06ff]/)

    // AttemptStatus
    const attemptOutputs = AttemptStatusSchema.options.map(v => {
      const s = structuredClone(base)
      s.tasks[0]!.attempts[0]!.status = v
      return formatStatus(s as unknown as Status)
    })
    expect(new Set(attemptOutputs).size).toBe(AttemptStatusSchema.options.length)
    for (const out of attemptOutputs) expect(out).toMatch(/[\u0600-\u06ff]/)

    // WorkerState
    const workerOutputs = WorkerStateSchema.options.map(v => {
      const s = structuredClone(base)
      s.tasks[0]!.attempts[0]!.worker.state = v
      return formatStatus(s as unknown as Status)
    })
    expect(new Set(workerOutputs).size).toBe(WorkerStateSchema.options.length)
    for (const out of workerOutputs) expect(out).toMatch(/[\u0600-\u06ff]/)

    // OutboxStatus
    const outboxOutputs = OutboxStatusSchema.options.map(v => {
      const s = structuredClone(base)
      s.tasks = []
      s.outbox[v] = 42
      return formatStatus(s as unknown as Status)
    })
    expect(new Set(outboxOutputs).size).toBe(OutboxStatusSchema.options.length)
    for (const out of outboxOutputs) expect(out).toMatch(/[\u0600-\u06ff]/)

    // CommandOutcome
    const cmdOutputs = CommandOutcomeSchema.options.map(v => {
      const s = structuredClone(base)
      s.tasks = []
      s.commands[v] = 42
      return formatStatus(s as unknown as Status)
    })
    expect(new Set(cmdOutputs).size).toBe(CommandOutcomeSchema.options.length)
    for (const out of cmdOutputs) expect(out).toMatch(/[\u0600-\u06ff]/)
  })

  it('supports databases without v5 tables while preserving M2 contract', () => {
    const dir = fixtureDir()
    const db = new DatabaseSync(join(dir, 'state.sqlite'))
    try {
      db.exec(`
        CREATE TABLE commands (id TEXT PRIMARY KEY, payload_json TEXT);
        INSERT INTO commands VALUES ('c1', 'payload1'), ('c2', 'payload2');
        CREATE TABLE supervisor_lease (id INTEGER PRIMARY KEY, owner_id TEXT, generation INTEGER, heartbeat_ms INTEGER, status TEXT);
        INSERT INTO supervisor_lease VALUES (1, 'legacy-owner', 1, 500, 'active');
        PRAGMA user_version = 5;
      `)
    } finally {
      db.close()
    }

    const status = readStatus(dir, { nowMs: 600, staleAfterMs: 500 })
    expect(status).toEqual({
      schemaVersion: 5,
      recordedCommandCount: 2,
      lease: {
        ownerId: 'legacy-owner',
        generation: 1,
        heartbeatMs: 500,
        state: 'active',
        freshness: 'fresh',
      },
    })
  })

  it('rejects malformed outbox payload_json with exit 1 and malformed-data message via CLI', () => {
    const dir = fixtureDir()
    const { db, handle } = seedV5(dir)
    try {
      db.exec("INSERT INTO outbox VALUES ('out-bad-json', 'key-bad-json', 'attempt.start', '{bad json', 'pending', 0, 1000, NULL, 'now', 'now')")

      expect(() => readStatus(dir, { nowMs: 1200, staleAfterMs: 500 })).toThrow(/malformed outbox payload_json/i)

      const cli = join(process.cwd(), 'supervisor/src/cli/main.ts')
      const result = childProcess.spawnSync(
        process.execPath,
        [cli, 'status', '--state-dir', dir, '--json'],
        { encoding: 'utf8', timeout: 10000 },
      )
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('بيانات قاعدة البيانات غير صالحة أو تعذرت قراءتها')
      expect(result.stderr).toContain('malformed outbox payload_json')
      expect(result.stderr).not.toContain('{bad json')
      expect(result.stdout).not.toContain('{bad json')

      const humanResult = childProcess.spawnSync(
        process.execPath,
        [cli, 'status', '--state-dir', dir],
        { encoding: 'utf8', timeout: 10000 },
      )
      expect(humanResult.status).toBe(1)
      expect(humanResult.stderr).toContain('بيانات قاعدة البيانات غير صالحة أو تعذرت قراءتها')
      expect(humanResult.stderr).toContain('malformed outbox payload_json')
      expect(humanResult.stderr).not.toContain('{bad json')
      expect(humanResult.stdout).not.toContain('{bad json')
    } finally {
      try { handle.release(1200) } finally { db.close() }
    }
  })

  it('renders commands summary in Arabic view even when all commands are pending', () => {
    const dir = fixtureDir()
    const db = openStore(join(dir, 'state.sqlite'))
    let handle: ReturnType<typeof acquireSupervisor> | undefined
    try {
      db.prepare('INSERT INTO projects VALUES (?, ?, ?)').run('proj-1', 'Project 1', stamp)
      db.prepare('INSERT INTO project_config VALUES (?, ?, ?, ?)').run('proj-1', process.cwd(), 'main', stamp)
      handle = acquireSupervisor(db, dir, { nowMs: 1000, staleAfterMs: 500 })
      appendCommand(db, { id: 'cmd-1', projectId: 'proj-1', kind: 'task.create', payloadJson: '{"title":"T1"}', createdAt: stamp })
      appendCommand(db, { id: 'cmd-2', projectId: 'proj-1', kind: 'task.create', payloadJson: '{"title":"T2"}', createdAt: stamp })
      appendCommand(db, { id: 'cmd-3', projectId: 'proj-1', kind: 'task.create', payloadJson: '{"title":"T3"}', createdAt: stamp })
    } finally {
      if (handle) handle.release(1200)
      db.close()
    }

    const status = readStatus(dir, { nowMs: 1200, staleAfterMs: 500 })
    expect(status.commands).toEqual({
      recorded: 3,
      applied: 0,
      rejected: 0,
      pending: 3,
    })

    const arabicText = formatStatus(status)
    expect(arabicText).toContain('الأوامر:')
    expect(arabicText).toContain('مُنفَّذة: 0')
    expect(arabicText).toContain('مرفوضة: 0')
    expect(arabicText).toContain('معلقة: 3')

    const cli = join(process.cwd(), 'supervisor/src/cli/main.ts')
    const cliResult = childProcess.spawnSync(
      process.execPath,
      [cli, 'status', '--state-dir', dir],
      { encoding: 'utf8', timeout: 10000 },
    )
    expect(cliResult.status).toBe(0)
    expect(cliResult.stdout).toContain('الأوامر:')
    expect(cliResult.stdout).toContain('مُنفَّذة: 0')
    expect(cliResult.stdout).toContain('مرفوضة: 0')
    expect(cliResult.stdout).toContain('معلقة: 3')
  })
})
