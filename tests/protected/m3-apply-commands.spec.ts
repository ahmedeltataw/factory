import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import { applyPendingCommands } from '../../supervisor/src/app/apply-commands.ts'
import { appendCommand } from '../../supervisor/src/app/commands.ts'
import { openStore } from '../../supervisor/src/app/store.ts'
import { acquireSupervisor, LeaseLostError, type SupervisorLeaseHandle } from '../../supervisor/src/app/supervisor-lease.ts'

interface TestContext {
  readonly stateDir: string
  readonly dbPath: string
  readonly db: DatabaseSync
  readonly handle: SupervisorLeaseHandle
}

const activeContexts: TestContext[] = []
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

function cleanupContext(ctx: TestContext): void {
  try {
    ctx.handle.release(Date.now())
  } catch {
    // Release may throw LeaseLostError if displaced, but releases OS lock in finally
  }
  try {
    ctx.db.close()
  } catch {
    // ignore if already closed
  }
}

function setupTestEnv(): TestContext {
  const stateDir = mkdtempSync(join(tmpdir(), 'factory-apply-state-'))
  directories.push(stateDir)
  const dbPath = join(stateDir, 'state.sqlite')
  let db: DatabaseSync | undefined
  let handle: SupervisorLeaseHandle | undefined
  try {
    db = openStore(dbPath)
    handle = acquireSupervisor(db, stateDir, { nowMs: 1000, staleAfterMs: 300000 })
    db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'Test Project', '2026-11-10T00:00:00.000Z')").run()
    const ctx: TestContext = { stateDir, dbPath, db, handle }
    activeContexts.push(ctx)
    return ctx
  } catch (err) {
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
    throw err
  }
}

afterEach(() => {
  const errors: unknown[] = []
  for (const ctx of activeContexts.splice(0)) {
    try {
      cleanupContext(ctx)
    } catch (err) {
      errors.push(err)
    }
  }
  for (const directory of directories.splice(0)) {
    try {
      safeRemoveDir(directory)
    } catch (err) {
      errors.push(err)
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Cleanup failed to release resources or remove directories')
  }
})

const workerSource = `
const { parentPort, workerData } = require('node:worker_threads')
;(async () => {
  const { openStore } = await import(workerData.store)
  const { applyPendingCommands } = await import(workerData.applyCommands)
  const db = openStore(workerData.dbPath)
  try {
    parentPort.postMessage({ type: 'ready' })
    const gate = new Int32Array(workerData.gate)
    Atomics.wait(gate, 0, 0, 10000)
    if (Atomics.load(gate, 0) !== 1) throw new Error('race gate timed out')
    applyPendingCommands(db, workerData.handle)
    parentPort.postMessage({ type: 'done' })
  } finally {
    db.close()
  }
})().catch(error => {
  parentPort.postMessage({ type: 'error', message: String(error && error.stack ? error.stack : error) })
})
`

describe('M3-02 applyPendingCommands happy path and idempotency', () => {
  it('CHK-M3-02-c: writes task row ready and command_outcomes row in one fenced transaction per command', () => {
    const { db, handle } = setupTestEnv()

    appendCommand(db, {
      id: 'cmd-create-1',
      projectId: 'p1',
      kind: 'task.create',
      payloadJson: JSON.stringify({ title: 'Task Alpha' }),
      createdAt: '2026-11-10T00:01:00.000Z',
    })
    appendCommand(db, {
      id: 'cmd-create-2',
      projectId: 'p1',
      kind: 'task.create',
      payloadJson: JSON.stringify({ title: 'Task Beta' }),
      createdAt: '2026-11-10T00:02:00.000Z',
    })

    applyPendingCommands(db, handle)

    // 1. Check tasks table: task id equals command id per frozen contract
    const tasks = db.prepare('SELECT id, project_id, created_by_command, title, status, created_at, updated_at FROM tasks ORDER BY created_at ASC').all() as Array<{
      id: string
      project_id: string
      created_by_command: string
      title: string
      status: string
      created_at: string
      updated_at: string
    }>
    expect(tasks).toHaveLength(2)

    const task1 = tasks.find((t) => t.created_by_command === 'cmd-create-1')
    expect(task1).toBeDefined()
    expect(task1?.id).toBe('cmd-create-1')
    expect(task1?.project_id).toBe('p1')
    expect(task1?.title).toBe('Task Alpha')
    expect(task1?.status).toBe('ready')
    expect(Number.isNaN(new Date(task1!.created_at).getTime())).toBe(false)
    expect(Number.isNaN(new Date(task1!.updated_at).getTime())).toBe(false)

    const task2 = tasks.find((t) => t.created_by_command === 'cmd-create-2')
    expect(task2).toBeDefined()
    expect(task2?.id).toBe('cmd-create-2')
    expect(task2?.project_id).toBe('p1')
    expect(task2?.title).toBe('Task Beta')
    expect(task2?.status).toBe('ready')

    // 2. Check command_outcomes table: applied outcomes have reason NULL per frozen contract
    const outcomes = db.prepare('SELECT command_id, outcome, reason, lease_generation, applied_at FROM command_outcomes').all() as Array<{
      command_id: string
      outcome: string
      reason: string | null
      lease_generation: number
      applied_at: string
    }>
    expect(outcomes).toHaveLength(2)

    const outcome1 = outcomes.find((o) => o.command_id === 'cmd-create-1')
    expect(outcome1).toBeDefined()
    expect(outcome1?.outcome).toBe('applied')
    expect(outcome1?.lease_generation).toBe(handle.generation)
    expect(outcome1?.reason).toBeNull()
    expect(Number.isNaN(new Date(outcome1!.applied_at).getTime())).toBe(false)

    const outcome2 = outcomes.find((o) => o.command_id === 'cmd-create-2')
    expect(outcome2).toBeDefined()
    expect(outcome2?.outcome).toBe('applied')
    expect(outcome2?.lease_generation).toBe(handle.generation)
    expect(outcome2?.reason).toBeNull()
    expect(Number.isNaN(new Date(outcome2!.applied_at).getTime())).toBe(false)
  })

  it('CHK-M3-02-c: repeated applyPendingCommands is idempotent and creates no duplicate tasks or outcomes', () => {
    const { db, handle } = setupTestEnv()

    appendCommand(db, {
      id: 'cmd-repeat-1',
      projectId: 'p1',
      kind: 'task.create',
      payloadJson: JSON.stringify({ title: 'Idempotent Task' }),
      createdAt: '2026-11-10T00:01:00.000Z',
    })

    // Run once
    applyPendingCommands(db, handle)

    const initialTasks = db.prepare('SELECT id, created_by_command, title, status FROM tasks').all()
    const initialOutcomes = db.prepare('SELECT command_id, outcome, reason, lease_generation FROM command_outcomes').all()
    expect(initialTasks).toHaveLength(1)
    expect(initialOutcomes).toHaveLength(1)

    // Run second and third time
    applyPendingCommands(db, handle)
    applyPendingCommands(db, handle)

    const currentTasks = db.prepare('SELECT id, created_by_command, title, status FROM tasks').all()
    const currentOutcomes = db.prepare('SELECT command_id, outcome, reason, lease_generation FROM command_outcomes').all()
    expect(currentTasks).toEqual(initialTasks)
    expect(currentOutcomes).toEqual(initialOutcomes)
  })

  it('CHK-M3-02-c: writes effect in one fenced transaction per command so earlier commands stay committed on mid-batch failure without assuming processing order', () => {
    const { db, handle } = setupTestEnv()

    appendCommand(db, {
      id: 'cmd-batch-1',
      projectId: 'p1',
      kind: 'task.create',
      payloadJson: JSON.stringify({ title: 'Batch Task 1' }),
      createdAt: '2026-11-10T00:01:00.000Z',
    })
    appendCommand(db, {
      id: 'cmd-batch-2',
      projectId: 'p1',
      kind: 'task.create',
      payloadJson: JSON.stringify({ title: 'Batch Task 2' }),
      createdAt: '2026-11-10T00:02:00.000Z',
    })

    let commitCount = 0
    const origExec = DatabaseSync.prototype.exec
    DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
      if (/COMMIT/i.test(sql)) {
        commitCount++
        if (commitCount === 2) {
          // Throw during the second command's transaction commit to simulate a crash mid-batch
          throw new Error('Injected failure during second command commit')
        }
      }
      return origExec.call(this, sql)
    }

    try {
      expect(() => applyPendingCommands(db, handle)).toThrow('Injected failure during second command commit')
    } finally {
      DatabaseSync.prototype.exec = origExec
    }

    // Exactly one command must have committed its complete effect and outcome pair, regardless of processing order
    const tasksAfterFailure = db.prepare('SELECT id, created_by_command, title, status FROM tasks').all() as Array<{
      id: string
      created_by_command: string
      title: string
      status: string
    }>
    const outcomesAfterFailure = db.prepare('SELECT command_id, outcome, reason FROM command_outcomes').all() as Array<{
      command_id: string
      outcome: string
      reason: string | null
    }>

    expect(tasksAfterFailure).toHaveLength(1)
    expect(outcomesAfterFailure).toHaveLength(1)

    const survivingCommandId = outcomesAfterFailure[0]!.command_id
    expect(['cmd-batch-1', 'cmd-batch-2']).toContain(survivingCommandId)
    expect(tasksAfterFailure[0]!.created_by_command).toBe(survivingCommandId)
    expect(tasksAfterFailure[0]!.id).toBe(survivingCommandId)
    expect(tasksAfterFailure[0]!.status).toBe('ready')
    expect(outcomesAfterFailure[0]!.outcome).toBe('applied')
    expect(outcomesAfterFailure[0]!.reason).toBeNull()

    // Re-running applyPendingCommands picks up and applies the remaining command without duplicating the surviving one
    applyPendingCommands(db, handle)

    const finalTasks = db.prepare('SELECT id, created_by_command, title, status FROM tasks ORDER BY created_by_command ASC').all() as Array<{
      id: string
      created_by_command: string
      title: string
      status: string
    }>
    expect(finalTasks).toHaveLength(2)
    expect(finalTasks[0]).toMatchObject({ id: 'cmd-batch-1', created_by_command: 'cmd-batch-1', title: 'Batch Task 1', status: 'ready' })
    expect(finalTasks[1]).toMatchObject({ id: 'cmd-batch-2', created_by_command: 'cmd-batch-2', title: 'Batch Task 2', status: 'ready' })

    const finalOutcomes = db.prepare('SELECT command_id, outcome, reason FROM command_outcomes ORDER BY command_id ASC').all() as Array<{
      command_id: string
      outcome: string
      reason: string | null
    }>
    expect(finalOutcomes).toHaveLength(2)
    expect(finalOutcomes[0]).toMatchObject({ command_id: 'cmd-batch-1', outcome: 'applied', reason: null })
    expect(finalOutcomes[1]).toMatchObject({ command_id: 'cmd-batch-2', outcome: 'applied', reason: null })
  })

  const KILL_TASK_STATES = ['ready', 'waiting', 'blocked', 'progress', 'done', 'failed', 'dropped'] as const
  const ATTEMPT_SCENARIOS = ['none', 'pending', 'running', 'terminal_succeeded'] as const

  const killTableCases = KILL_TASK_STATES.flatMap((taskState) =>
    ATTEMPT_SCENARIOS.map((attemptScenario) => ({
      taskState,
      attemptScenario,
      isKillable: ['ready', 'waiting', 'blocked', 'progress'].includes(taskState),
      hasActiveAttempt: attemptScenario === 'pending' || attemptScenario === 'running',
    })),
  )

  it.each(killTableCases)(
    'CHK-M3-02-c / CHK-M3-02-d: task kill for task in "$taskState" with "$attemptScenario" attempt -> verifies outcome, task status, and outbox rows together',
    ({ taskState, attemptScenario, isKillable, hasActiveAttempt }) => {
      const { db, handle } = setupTestEnv()
      const createCmdId = `cmd-create-${taskState}-${attemptScenario}`
      const killCmdId = `cmd-kill-${taskState}-${attemptScenario}`
      const taskId = createCmdId
      const attemptId = `att-${taskState}-${attemptScenario}`

      // 1. Create task first
      appendCommand(db, {
        id: createCmdId,
        projectId: 'p1',
        kind: 'task.create',
        payloadJson: JSON.stringify({ title: `Task ${taskState} ${attemptScenario}` }),
        createdAt: '2026-11-10T00:01:00.000Z',
      })
      applyPendingCommands(db, handle)

      // 2. Transition task to target state
      if (taskState !== 'ready') {
        db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(taskState, taskId)
      }

      // 3. Setup attempt if needed
      if (attemptScenario === 'pending' || attemptScenario === 'running') {
        db.prepare(`
          INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation, started_at)
          VALUES (?, ?, 1, ?, ?, '2026-11-10T00:01:30.000Z')
        `).run(attemptId, taskId, attemptScenario, handle.generation)
      } else if (attemptScenario === 'terminal_succeeded') {
        db.prepare(`
          INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation, started_at, ended_at)
          VALUES (?, ?, 1, 'succeeded', ?, '2026-11-10T00:01:30.000Z', '2026-11-10T00:02:00.000Z')
        `).run(attemptId, taskId, handle.generation)
      }

      const outboxBefore = (db.prepare('SELECT id FROM outbox').all() as Array<{ id: string }>).length

      // 4. Append and apply task.kill
      appendCommand(db, {
        id: killCmdId,
        projectId: 'p1',
        kind: 'task.kill',
        payloadJson: JSON.stringify({ taskId }),
        createdAt: '2026-11-10T00:03:00.000Z',
      })
      applyPendingCommands(db, handle)

      // 5. Query and assert outcome, task status, and outbox rows together
      const outcome = db.prepare('SELECT command_id, outcome, reason, lease_generation FROM command_outcomes WHERE command_id = ?').get(killCmdId) as {
        command_id: string
        outcome: string
        reason: string | null
        lease_generation: number
      } | undefined
      expect(outcome).toBeDefined()
      expect(outcome?.command_id).toBe(killCmdId)
      expect(outcome?.lease_generation).toBe(handle.generation)

      const task = db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(taskId) as { id: string; status: string }
      expect(task).toBeDefined()

      const outboxRows = db.prepare("SELECT id, idempotency_key, kind, payload_json, status FROM outbox WHERE idempotency_key = ?").all(`attempt.kill:${attemptId}`) as Array<{
        id: string
        idempotency_key: string
        kind: string
        payload_json: string
        status: string
      }>

      if (isKillable) {
        // Killable task (ready|waiting|blocked|progress):
        // Outcome must be applied (reason null)
        expect(outcome?.outcome).toBe('applied')
        expect(outcome?.reason).toBeNull()

        // Task status becomes dropped in same transaction
        expect(task.status).toBe('dropped')

        // For each of its pending|running attempts, an outbox row is enqueued
        if (hasActiveAttempt) {
          expect(outboxRows).toHaveLength(1)
          const row = outboxRows[0]!
          expect(row.kind).toBe('attempt.kill')
          expect(row.status).toBe('pending')
          expect(JSON.parse(row.payload_json)).toEqual({ attemptId })
        } else {
          expect(outboxRows).toHaveLength(0)
        }
      } else {
        // Non-killable terminal task (done|failed|dropped):
        // Outcome must be rejected (reason non-empty string)
        expect(outcome?.outcome).toBe('rejected')
        expect(typeof outcome?.reason).toBe('string')
        expect(outcome?.reason?.length).toBeGreaterThan(0)

        // Task status remains unchanged
        expect(task.status).toBe(taskState)

        // No outbox rows enqueued
        expect(outboxRows).toHaveLength(0)
      }

      // Verify no extra outbox rows were written
      const outboxAfter = (db.prepare('SELECT id FROM outbox').all() as Array<{ id: string }>).length
      expect(outboxAfter).toBe(outboxBefore + (isKillable && hasActiveAttempt ? 1 : 0))
    },
  )

  it('CHK-M3-02-c: task.kill failure mid-transaction rolls back task status, outbox row, and outcome together', () => {
    const { db, handle } = setupTestEnv()

    // Create a task
    appendCommand(db, {
      id: 'cmd-create-rollback-target',
      projectId: 'p1',
      kind: 'task.create',
      payloadJson: JSON.stringify({ title: 'Task for Rollback Test' }),
      createdAt: '2026-11-10T00:01:00.000Z',
    })
    applyPendingCommands(db, handle)

    const taskId = 'cmd-create-rollback-target'
    db.prepare(`
      INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation, started_at)
      VALUES ('att-rb-1', ?, 1, 'running', ?, '2026-11-10T00:01:30.000Z')
    `).run(taskId, handle.generation)

    appendCommand(db, {
      id: 'cmd-kill-rollback',
      projectId: 'p1',
      kind: 'task.kill',
      payloadJson: JSON.stringify({ taskId }),
      createdAt: '2026-11-10T00:02:00.000Z',
    })

    // Injected failure during the kill command's commit
    const origExec = DatabaseSync.prototype.exec
    DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
      if (/COMMIT/i.test(sql)) {
        throw new Error('Injected kill commit failure')
      }
      return origExec.call(this, sql)
    }

    try {
      expect(() => applyPendingCommands(db, handle)).toThrow('Injected kill commit failure')
    } finally {
      DatabaseSync.prototype.exec = origExec
    }

    // Rollback verification: task remains ready, no outbox row, no outcome
    const taskAfterRollback = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }
    expect(taskAfterRollback.status).toBe('ready')

    const outboxAfterRollback = db.prepare("SELECT COUNT(*) as count FROM outbox WHERE idempotency_key = 'attempt.kill:att-rb-1'").get() as { count: number }
    expect(outboxAfterRollback.count).toBe(0)

    const outcomeAfterRollback = db.prepare("SELECT COUNT(*) as count FROM command_outcomes WHERE command_id = 'cmd-kill-rollback'").get() as { count: number }
    expect(outcomeAfterRollback.count).toBe(0)

    // Retry apply: both effect and outcome succeed durably
    applyPendingCommands(db, handle)

    const finalTask = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }
    expect(finalTask.status).toBe('dropped')

    const finalOutbox = db.prepare("SELECT COUNT(*) as count FROM outbox WHERE idempotency_key = 'attempt.kill:att-rb-1'").get() as { count: number }
    expect(finalOutbox.count).toBe(1)

    const finalOutcome = db.prepare("SELECT outcome, reason FROM command_outcomes WHERE command_id = 'cmd-kill-rollback'").get() as { outcome: string; reason: string | null }
    expect(finalOutcome.outcome).toBe('applied')
    expect(finalOutcome.reason).toBeNull()
  })

  it('CHK-M3-02-c: concurrent apply calls on separate connections yield exactly one effect and outcome per command', async () => {
    const { dbPath, db, handle } = setupTestEnv()

    for (let i = 1; i <= 5; i++) {
      appendCommand(db, {
        id: `cmd-concurrent-${i}`,
        projectId: 'p1',
        kind: 'task.create',
        payloadJson: JSON.stringify({ title: `Concurrent Task ${i}` }),
        createdAt: `2026-11-10T00:0${i}:00.000Z`,
      })
    }

    const gate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
    const workerData = {
      dbPath,
      gate: gate.buffer,
      handle: { ownerId: handle.ownerId, generation: handle.generation },
      store: pathToFileURL(join(process.cwd(), 'supervisor/src/app/store.ts')).href,
      applyCommands: pathToFileURL(join(process.cwd(), 'supervisor/src/app/apply-commands.ts')).href,
    }

    const workers = [
      new Worker(workerSource, { eval: true, workerData }),
      new Worker(workerSource, { eval: true, workerData }),
    ]
    let readyCount = 0

    try {
      await Promise.all(
        workers.map(
          (worker) =>
            new Promise<void>((resolve, reject) => {
              worker.on('error', reject)
              worker.on('exit', (code) => {
                if (code !== 0) reject(new Error(`worker exited with code ${code}`))
              })
              worker.on('message', (message: { type: string; message?: string }) => {
                if (message.type === 'ready') {
                  readyCount++
                  if (readyCount === workers.length) {
                    Atomics.store(gate, 0, 1)
                    Atomics.notify(gate, 0)
                  }
                } else if (message.type === 'done') {
                  resolve()
                } else if (message.type === 'error') {
                  reject(new Error(message.message ?? 'Unknown worker error'))
                }
              })
            }),
        ),
      )

      // Verification on the main connection: exactly 5 tasks and 5 outcomes
      const taskCount = db.prepare('SELECT COUNT(*) as count FROM tasks').get() as { count: number }
      const outcomeCount = db.prepare('SELECT COUNT(*) as count FROM command_outcomes').get() as { count: number }
      expect(taskCount.count).toBe(5)
      expect(outcomeCount.count).toBe(5)

      for (let i = 1; i <= 5; i++) {
        const cmdId = `cmd-concurrent-${i}`
        const task = db.prepare('SELECT id, created_by_command, title, status FROM tasks WHERE created_by_command = ?').get(cmdId) as {
          id: string
          created_by_command: string
          title: string
          status: string
        } | undefined
        expect(task, `Expected task for ${cmdId}`).toBeDefined()
        expect(task?.id).toBe(cmdId)
        expect(task?.title).toBe(`Concurrent Task ${i}`)
        expect(task?.status).toBe('ready')

        const outcome = db.prepare('SELECT command_id, outcome, reason, lease_generation FROM command_outcomes WHERE command_id = ?').get(cmdId) as {
          command_id: string
          outcome: string
          reason: string | null
          lease_generation: number
        } | undefined
        expect(outcome, `Expected outcome for ${cmdId}`).toBeDefined()
        expect(outcome?.outcome).toBe('applied')
        expect(outcome?.reason).toBeNull()
        expect(outcome?.lease_generation).toBe(handle.generation)
      }
    } finally {
      Atomics.store(gate, 0, 1)
      Atomics.notify(gate, 0)
      await Promise.all(workers.map((w) => w.terminate()))
    }
  }, 25000)
})

describe('M3-02 applyPendingCommands rejections and stale lease contract', () => {
  it('CHK-M3-02-d: task.kill for unknown task records rejected outcome with non-empty reason and no domain change', () => {
    const { db, handle } = setupTestEnv()

    appendCommand(db, {
      id: 'cmd-kill-unknown',
      projectId: 'p1',
      kind: 'task.kill',
      payloadJson: JSON.stringify({ taskId: 'nonexistent-task-id' }),
      createdAt: '2026-11-10T00:01:00.000Z',
    })

    applyPendingCommands(db, handle)

    const outcome = db.prepare("SELECT command_id, outcome, reason FROM command_outcomes WHERE command_id = 'cmd-kill-unknown'").get() as {
      command_id: string
      outcome: string
      reason: string | null
    } | undefined
    expect(outcome).toBeDefined()
    expect(outcome?.outcome).toBe('rejected')
    expect(typeof outcome?.reason).toBe('string')
    expect(outcome?.reason?.length).toBeGreaterThan(0)

    // No tasks created or modified
    expect(db.prepare('SELECT COUNT(*) as count FROM tasks').get()).toMatchObject({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) as count FROM outbox').get()).toMatchObject({ count: 0 })
  })

  it.each(['done', 'failed', 'dropped'] as const)(
    'CHK-M3-02-d: task.kill for terminal task (%s) records rejected outcome with non-empty reason and no domain change',
    (terminalStatus) => {
      const { db, handle } = setupTestEnv()
      const taskId = `cmd-task-${terminalStatus}`

      // 1. Create a task and transition to terminal status
      appendCommand(db, {
        id: taskId,
        projectId: 'p1',
        kind: 'task.create',
        payloadJson: JSON.stringify({ title: `Terminal ${terminalStatus} Task` }),
        createdAt: '2026-11-10T00:01:00.000Z',
      })
      applyPendingCommands(db, handle)

      db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(terminalStatus, taskId)

      // Add a terminal attempt to verify it remains untouched
      db.prepare(`
        INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation, started_at, ended_at)
        VALUES ('att-term-1', ?, 1, 'succeeded', ?, '2026-11-10T00:01:30.000Z', '2026-11-10T00:01:50.000Z')
      `).run(taskId, handle.generation)

      // 2. Kill the terminal task
      const killCmdId = `cmd-kill-${terminalStatus}`
      appendCommand(db, {
        id: killCmdId,
        projectId: 'p1',
        kind: 'task.kill',
        payloadJson: JSON.stringify({ taskId }),
        createdAt: '2026-11-10T00:02:00.000Z',
      })

      applyPendingCommands(db, handle)

      const outcome = db.prepare('SELECT outcome, reason, lease_generation FROM command_outcomes WHERE command_id = ?').get(killCmdId) as {
        outcome: string
        reason: string | null
        lease_generation: number
      } | undefined
      expect(outcome).toBeDefined()
      expect(outcome?.outcome).toBe('rejected')
      expect(typeof outcome?.reason).toBe('string')
      expect(outcome?.reason?.length).toBeGreaterThan(0)
      expect(outcome?.lease_generation).toBe(handle.generation)

      // Task status remains terminal; no outbox row enqueued
      const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }
      expect(task.status).toBe(terminalStatus)
      expect(db.prepare('SELECT COUNT(*) as count FROM outbox').get()).toMatchObject({ count: 0 })
    },
  )

  it('CHK-M3-02-d: malformed payload in task.create records rejected outcome with non-empty reason and no domain change', () => {
    const { db, handle } = setupTestEnv()

    const malformedCommands = [
      { id: 'cmd-malformed-empty', payload: '{}' },
      { id: 'cmd-malformed-blank-title', payload: '{"title":"   "}' },
      { id: 'cmd-malformed-numeric-title', payload: '{"title":12345}' },
      { id: 'cmd-malformed-array-payload', payload: '[]' },
    ]

    for (let i = 0; i < malformedCommands.length; i++) {
      const item = malformedCommands[i]!
      appendCommand(db, {
        id: item.id,
        projectId: 'p1',
        kind: 'task.create',
        payloadJson: item.payload,
        createdAt: `2026-11-10T00:0${i + 1}:00.000Z`,
      })
    }

    applyPendingCommands(db, handle)

    for (const item of malformedCommands) {
      const outcome = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get(item.id) as {
        outcome: string
        reason: string | null
      } | undefined
      expect(outcome, `Expected outcome for ${item.id}`).toBeDefined()
      expect(outcome?.outcome).toBe('rejected')
      expect(typeof outcome?.reason).toBe('string')
      expect(outcome?.reason?.length).toBeGreaterThan(0)
    }

    // No domain change: tasks table remains empty
    expect(db.prepare('SELECT COUNT(*) as count FROM tasks').get()).toMatchObject({ count: 0 })
  })

  it('CHK-M3-02-d: malformed payload in task.kill records rejected outcome with non-empty reason and unchanged seeded domain state', () => {
    const { db, handle } = setupTestEnv()

    // Seed domain state: an active running task with an attempt and an outbox entry
    const seedTaskId = 'cmd-seed-task'
    appendCommand(db, {
      id: seedTaskId,
      projectId: 'p1',
      kind: 'task.create',
      payloadJson: JSON.stringify({ title: 'Seeded Running Task' }),
      createdAt: '2026-11-10T00:00:01.000Z',
    })
    applyPendingCommands(db, handle)

    db.prepare("UPDATE tasks SET status = 'progress' WHERE id = ?").run(seedTaskId)
    db.prepare(`
      INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation, started_at)
      VALUES ('att-seed-1', ?, 1, 'running', ?, '2026-11-10T00:00:02.000Z')
    `).run(seedTaskId, handle.generation)
    db.prepare(`
      INSERT INTO outbox (id, idempotency_key, kind, payload_json, status, tries, next_attempt_ms, last_error, created_at, updated_at)
      VALUES ('outbox-seed-1', 'attempt.kill:att-existing', 'attempt.kill', '{"attemptId":"att-existing"}', 'pending', 0, 0, null, '2026-11-10T00:00:03.000Z', '2026-11-10T00:00:03.000Z')
    `).run()

    const initialTasks = db.prepare('SELECT * FROM tasks').all()
    const initialAttempts = db.prepare('SELECT * FROM attempts').all()
    const initialOutbox = db.prepare('SELECT * FROM outbox').all()

    const malformedKillCommands = [
      { id: 'cmd-kill-malformed-empty', payload: '{}' },
      { id: 'cmd-kill-malformed-array', payload: '[]' },
      { id: 'cmd-kill-malformed-numeric-id', payload: '{"taskId":123}' },
      { id: 'cmd-kill-malformed-blank-id', payload: '{"taskId":"   "}' },
      { id: 'cmd-kill-malformed-boolean-id', payload: '{"taskId":true}' },
      { id: 'cmd-kill-malformed-null-id', payload: '{"taskId":null}' },
    ]

    for (let i = 0; i < malformedKillCommands.length; i++) {
      const item = malformedKillCommands[i]!
      appendCommand(db, {
        id: item.id,
        projectId: 'p1',
        kind: 'task.kill',
        payloadJson: item.payload,
        createdAt: `2026-11-10T00:0${i + 1}:00.000Z`,
      })
    }

    applyPendingCommands(db, handle)

    for (const item of malformedKillCommands) {
      const outcome = db.prepare('SELECT outcome, reason, lease_generation FROM command_outcomes WHERE command_id = ?').get(item.id) as {
        outcome: string
        reason: string | null
        lease_generation: number
      } | undefined
      expect(outcome, `Expected outcome for ${item.id}`).toBeDefined()
      expect(outcome?.outcome).toBe('rejected')
      expect(typeof outcome?.reason).toBe('string')
      expect(outcome?.reason?.length).toBeGreaterThan(0)
      expect(outcome?.lease_generation).toBe(handle.generation)
    }

    // Unchanged seeded domain state: tasks, attempts, and outbox remain identical
    expect(db.prepare('SELECT * FROM tasks').all()).toEqual(initialTasks)
    expect(db.prepare('SELECT * FROM attempts').all()).toEqual(initialAttempts)
    expect(db.prepare('SELECT * FROM outbox').all()).toEqual(initialOutbox)
  })

  it('CHK-M3-02-d: unknown command kind records rejected outcome with non-empty reason and no domain change', () => {
    const { db, handle } = setupTestEnv()

    appendCommand(db, {
      id: 'cmd-unknown-kind',
      projectId: 'p1',
      kind: 'unsupported.action',
      payloadJson: JSON.stringify({ foo: 'bar' }),
      createdAt: '2026-11-10T00:01:00.000Z',
    })

    applyPendingCommands(db, handle)

    const outcome = db.prepare("SELECT outcome, reason FROM command_outcomes WHERE command_id = 'cmd-unknown-kind'").get() as {
      outcome: string
      reason: string | null
    } | undefined
    expect(outcome).toBeDefined()
    expect(outcome?.outcome).toBe('rejected')
    expect(typeof outcome?.reason).toBe('string')
    expect(outcome?.reason?.length).toBeGreaterThan(0)

    expect(db.prepare('SELECT COUNT(*) as count FROM tasks').get()).toMatchObject({ count: 0 })
  })

  it('CHK-M3-02-d: stale-generation handle throws LeaseLostError and applies nothing without leaking OS lease handle', () => {
    const { db, handle } = setupTestEnv()

    appendCommand(db, {
      id: 'cmd-stale-test',
      projectId: 'p1',
      kind: 'task.create',
      payloadJson: JSON.stringify({ title: 'Task Under Stale Lease' }),
      createdAt: '2026-11-10T00:01:00.000Z',
    })

    // Displace generation in the database
    db.prepare('UPDATE supervisor_lease SET generation = generation + 1 WHERE id = 1').run()

    expect(() => applyPendingCommands(db, handle)).toThrow(LeaseLostError)

    // Nothing was applied: no outcomes and no tasks
    expect(db.prepare('SELECT COUNT(*) as count FROM command_outcomes').get()).toMatchObject({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) as count FROM tasks').get()).toMatchObject({ count: 0 })
  })

  it('CHK-M3-02-d: displaced owner or released lease throws LeaseLostError and applies nothing without leaking OS lease handle', () => {
    const { db, handle } = setupTestEnv()

    appendCommand(db, {
      id: 'cmd-released-lease-test',
      projectId: 'p1',
      kind: 'task.create',
      payloadJson: JSON.stringify({ title: 'Task Under Released Lease' }),
      createdAt: '2026-11-10T00:01:00.000Z',
    })

    // Mark lease released in database
    db.prepare("UPDATE supervisor_lease SET status = 'released' WHERE id = 1").run()

    expect(() => applyPendingCommands(db, handle)).toThrow(LeaseLostError)

    expect(db.prepare('SELECT COUNT(*) as count FROM command_outcomes').get()).toMatchObject({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) as count FROM tasks').get()).toMatchObject({ count: 0 })
  })
})
