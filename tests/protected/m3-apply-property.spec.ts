import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import { applyPendingCommands } from '../../supervisor/src/app/apply-commands.ts'
import { appendCommand, CommandConflictError, type Command } from '../../supervisor/src/app/commands.ts'
import { openStore } from '../../supervisor/src/app/store.ts'
import { acquireSupervisor, type SupervisorLeaseHandle } from '../../supervisor/src/app/supervisor-lease.ts'

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
  | { readonly type: 'create'; readonly idSlot: number; readonly title: string; readonly variant: 'normal' | 'duplicate' | 'conflict' | 'malformed' }
  | {
      readonly type: 'advance_task'
      readonly targetSlot: number
      readonly newStatus: 'ready' | 'waiting' | 'blocked' | 'progress' | 'done' | 'failed' | 'dropped'
      readonly attemptStatus: 'none' | 'pending' | 'running' | 'succeeded' | 'failed'
    }
  | { readonly type: 'kill'; readonly idSlot: number; readonly targetSlot: number; readonly targetMode: 'existing' | 'unknown'; readonly variant: 'normal' | 'duplicate' | 'conflict' }
  | { readonly type: 'apply' }
  | { readonly type: 'crash_apply' }

const idSlots = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']

const actionArbitrary: fc.Arbitrary<Action> = fc.oneof(
  fc.record({
    type: fc.constant('create' as const),
    idSlot: fc.integer({ min: 0, max: idSlots.length - 1 }),
    title: fc.string({ minLength: 1, maxLength: 20 }),
    variant: fc.constantFrom<'normal' | 'duplicate' | 'conflict' | 'malformed'>('normal', 'duplicate', 'conflict', 'malformed'),
  }),
  fc.record({
    type: fc.constant('advance_task' as const),
    targetSlot: fc.integer({ min: 0, max: idSlots.length - 1 }),
    newStatus: fc.constantFrom<'ready' | 'waiting' | 'blocked' | 'progress' | 'done' | 'failed' | 'dropped'>('ready', 'waiting', 'blocked', 'progress', 'done', 'failed', 'dropped'),
    attemptStatus: fc.constantFrom<'none' | 'pending' | 'running' | 'succeeded' | 'failed'>('none', 'pending', 'running', 'succeeded', 'failed'),
  }),
  fc.record({
    type: fc.constant('kill' as const),
    idSlot: fc.integer({ min: 0, max: idSlots.length - 1 }),
    targetSlot: fc.integer({ min: 0, max: idSlots.length - 1 }),
    targetMode: fc.constantFrom<'existing' | 'unknown'>('existing', 'unknown'),
    variant: fc.constantFrom<'normal' | 'duplicate' | 'conflict'>('normal', 'duplicate', 'conflict'),
  }),
  fc.record({
    type: fc.constant('apply' as const),
  }),
  fc.record({
    type: fc.constant('crash_apply' as const),
  }),
)

describe('M3-02 applyPendingCommands property tests', () => {
  it('CHK-M3-02-e: random interleavings of duplicate/conflicting appends, apply runs, and mid-batch crashes preserve task and outcome invariants', () => {
    fc.assert(
      fc.property(fc.array(actionArbitrary, { minLength: 5, maxLength: 20 }), (actions) => {
        const stateDir = mkdtempSync(join(tmpdir(), 'factory-property-'))
        directories.push(stateDir)
        const dbPath = join(stateDir, 'state.sqlite')

        let db: DatabaseSync | undefined
        let handle: SupervisorLeaseHandle | undefined

        try {
          db = openStore(dbPath)
          handle = acquireSupervisor(db, stateDir, { nowMs: 1000, staleAfterMs: 300000 })
          db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'Property Project', '2026-11-10T00:00:00.000Z')").run()

          interface ModelTask {
            id: string
            title: string
            status: 'ready' | 'waiting' | 'blocked' | 'progress' | 'done' | 'failed' | 'dropped'
            activeAttemptId: string | null
          }

          const modelTasks = new Map<string, ModelTask>()
          const storedCommands = new Map<string, Command>()
          const pendingCommandQueue: Command[] = []
          const validCreateIds = new Set<string>()
          const malformedCreateIds = new Set<string>()
          const expectedKillOutcomes = new Map<string, { outcome: 'applied' | 'rejected'; targetTaskId: string; activeAttemptId: string | null }>()
          const expectedOutboxKeys = new Set<string>()

          const applyModelPending = () => {
            while (pendingCommandQueue.length > 0) {
              const cmd = pendingCommandQueue.shift()!
              if (cmd.kind === 'task.create') {
                if (validCreateIds.has(cmd.id)) {
                  const payload = JSON.parse(cmd.payloadJson) as { title: string }
                  modelTasks.set(cmd.id, {
                    id: cmd.id,
                    title: payload.title,
                    status: 'ready',
                    activeAttemptId: null,
                  })
                }
              } else if (cmd.kind === 'task.kill') {
                const payload = JSON.parse(cmd.payloadJson) as { taskId: string }
                const targetId = payload.taskId
                if (modelTasks.has(targetId)) {
                  const task = modelTasks.get(targetId)!
                  if (['ready', 'waiting', 'blocked', 'progress'].includes(task.status)) {
                    expectedKillOutcomes.set(cmd.id, {
                      outcome: 'applied',
                      targetTaskId: targetId,
                      activeAttemptId: task.activeAttemptId,
                    })
                    if (task.activeAttemptId) {
                      expectedOutboxKeys.add(`attempt.kill:${task.activeAttemptId}`)
                    }
                    task.status = 'dropped'
                    task.activeAttemptId = null
                  } else {
                    expectedKillOutcomes.set(cmd.id, {
                      outcome: 'rejected',
                      targetTaskId: targetId,
                      activeAttemptId: null,
                    })
                  }
                } else {
                  expectedKillOutcomes.set(cmd.id, {
                    outcome: 'rejected',
                    targetTaskId: targetId,
                    activeAttemptId: null,
                  })
                }
              }
            }
          }

          let timeSeq = 1

          for (const action of actions) {
            const timestamp = `2026-11-10T00:${String(Math.floor(timeSeq / 60)).padStart(2, '0')}:${String(timeSeq % 60).padStart(2, '0')}.000Z`
            timeSeq++

            if (action.type === 'create') {
              const commandId = idSlots[action.idSlot]!

              if (action.variant === 'duplicate' && storedCommands.has(commandId)) {
                // Reuse the entire original command for duplicate assertion
                const original = storedCommands.get(commandId)!
                const res = appendCommand(db, original)
                expect(res).toBe('duplicate')
              } else if (action.variant === 'conflict' && storedCommands.has(commandId)) {
                // Same ID with conflicting payload or kind must throw CommandConflictError
                const original = storedCommands.get(commandId)!
                const conflictCmd: Command = {
                  ...original,
                  payloadJson: JSON.stringify({ title: `Conflict-${action.title}` }),
                }
                expect(() => appendCommand(db!, conflictCmd)).toThrow(CommandConflictError)
              } else if (storedCommands.has(commandId)) {
                // An ID already stored receiving a new command with a new timestamp is an expected conflict
                const conflictCmd: Command = {
                  id: commandId,
                  projectId: 'p1',
                  kind: 'task.create',
                  payloadJson: action.variant === 'malformed' ? '{}' : JSON.stringify({ title: action.title }),
                  createdAt: timestamp,
                }
                expect(() => appendCommand(db!, conflictCmd)).toThrow(CommandConflictError)
              } else {
                // Fresh command ID: assert 'created'
                const payloadJson = action.variant === 'malformed' ? '{}' : JSON.stringify({ title: action.title })
                const cmd: Command = {
                  id: commandId,
                  projectId: 'p1',
                  kind: 'task.create',
                  payloadJson,
                  createdAt: timestamp,
                }
                const res = appendCommand(db, cmd)
                expect(res).toBe('created')
                storedCommands.set(commandId, cmd)
                pendingCommandQueue.push(cmd)

                if (action.variant === 'malformed' || action.title.trim().length === 0) {
                  malformedCreateIds.add(commandId)
                } else {
                  validCreateIds.add(commandId)
                }
              }
            } else if (action.type === 'advance_task') {
              applyPendingCommands(db, handle)
              applyModelPending()

              if (modelTasks.size > 0) {
                const taskList = Array.from(modelTasks.values())
                const task = taskList[action.targetSlot % taskList.length]!

                db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(action.newStatus, task.id)
                task.status = action.newStatus

                // Terminate any active attempt first to respect UNIQUE constraint
                db.prepare("UPDATE attempts SET status = 'failed' WHERE task_id = ? AND status IN ('pending', 'running')").run(task.id)

                if (action.attemptStatus === 'pending' || action.attemptStatus === 'running') {
                  const attId = `att-${task.id}-${timeSeq}`
                  db.prepare(`
                    INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation, started_at)
                    VALUES (?, ?, ?, ?, ?, '2026-11-10T00:00:00.000Z')
                    ON CONFLICT(task_id, attempt_no) DO UPDATE SET status = excluded.status
                  `).run(attId, task.id, timeSeq, action.attemptStatus, handle.generation)
                  task.activeAttemptId = attId
                } else if (action.attemptStatus === 'succeeded' || action.attemptStatus === 'failed') {
                  const attId = `att-${task.id}-${timeSeq}`
                  db.prepare(`
                    INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation, started_at, ended_at)
                    VALUES (?, ?, ?, ?, ?, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:01.000Z')
                    ON CONFLICT(task_id, attempt_no) DO UPDATE SET status = excluded.status
                  `).run(attId, task.id, timeSeq, action.attemptStatus, handle.generation)
                  task.activeAttemptId = null
                } else {
                  task.activeAttemptId = null
                }
              }
            } else if (action.type === 'kill') {
              // Run applyPendingCommands after each batch of creates before generating kills that depend on them,
              // so no command-ordering assumption between creates and kills is needed.
              applyPendingCommands(db, handle)
              applyModelPending()

              const commandId = idSlots[action.idSlot]!

              // Resolve target through existing modeled tasks
              let targetTaskId: string
              if (action.targetMode === 'existing') {
                if (modelTasks.size > 0) {
                  const taskIds = Array.from(modelTasks.keys())
                  targetTaskId = taskIds[action.targetSlot % taskIds.length]!
                } else if (validCreateIds.size > 0) {
                  const existingIds = Array.from(validCreateIds)
                  targetTaskId = existingIds[action.targetSlot % existingIds.length]!
                } else {
                  targetTaskId = `nonexistent-task-${action.targetSlot}`
                }
              } else {
                targetTaskId = `nonexistent-task-${action.targetSlot}`
              }

              if (action.variant === 'duplicate' && storedCommands.has(commandId)) {
                const original = storedCommands.get(commandId)!
                const res = appendCommand(db, original)
                expect(res).toBe('duplicate')
              } else if (action.variant === 'conflict' && storedCommands.has(commandId)) {
                const original = storedCommands.get(commandId)!
                const conflictCmd: Command = {
                  ...original,
                  payloadJson: JSON.stringify({ taskId: `conflict-target-${timeSeq}` }),
                }
                expect(() => appendCommand(db!, conflictCmd)).toThrow(CommandConflictError)
              } else if (storedCommands.has(commandId)) {
                const conflictCmd: Command = {
                  id: commandId,
                  projectId: 'p1',
                  kind: 'task.kill',
                  payloadJson: JSON.stringify({ taskId: targetTaskId }),
                  createdAt: timestamp,
                }
                expect(() => appendCommand(db!, conflictCmd)).toThrow(CommandConflictError)
              } else {
                const cmd: Command = {
                  id: commandId,
                  projectId: 'p1',
                  kind: 'task.kill',
                  payloadJson: JSON.stringify({ taskId: targetTaskId }),
                  createdAt: timestamp,
                }
                const res = appendCommand(db, cmd)
                expect(res).toBe('created')
                storedCommands.set(commandId, cmd)
                pendingCommandQueue.push(cmd)
              }
            } else if (action.type === 'apply') {
              applyPendingCommands(db, handle)
              applyModelPending()
            } else if (action.type === 'crash_apply') {
              // Guarantee pending commands exist so the injection point is reached
              const pendingRow = db.prepare(`
                SELECT COUNT(*) as count FROM commands c
                WHERE NOT EXISTS (SELECT 1 FROM command_outcomes o WHERE o.command_id = c.id)
              `).get() as { count: number }

              if (pendingRow.count === 0) {
                const padId = `crash-pad-${timeSeq}`
                const padCmd: Command = {
                  id: padId,
                  projectId: 'p1',
                  kind: 'task.create',
                  payloadJson: JSON.stringify({ title: `Pad Task ${timeSeq}` }),
                  createdAt: timestamp,
                }
                const padRes = appendCommand(db, padCmd)
                expect(padRes).toBe('created')
                storedCommands.set(padId, padCmd)
                validCreateIds.add(padId)
                pendingCommandQueue.push(padCmd)
              }

              const INJECTED_CRASH_ERR = 'Injected crash mid-batch'
              let injected = false
              const origExec = DatabaseSync.prototype.exec
              DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
                if (/COMMIT/i.test(sql) && !injected) {
                  injected = true
                  throw new Error(INJECTED_CRASH_ERR)
                }
                return origExec.call(this, sql)
              }

              let caughtError: unknown = null
              try {
                applyPendingCommands(db, handle)
              } catch (err) {
                caughtError = err
              } finally {
                DatabaseSync.prototype.exec = origExec
              }

              // Assert injection occurred and recognized only the injected error
              expect(injected, 'crash injection must have fired').toBe(true)
              expect((caughtError as Error)?.message).toBe(INJECTED_CRASH_ERR)

              // Reopen connection and re-acquire lease to verify durable state before retrying
              try {
                handle.release(Date.now())
              } catch {
                // ignore
              }
              db.close()

              db = openStore(dbPath)
              handle = acquireSupervisor(db, stateDir, { nowMs: 2000 + timeSeq * 1000, staleAfterMs: 300000 })

              // Verify durable effects and outcomes survived uncorrupted
              const durableOutcomes = db.prepare('SELECT command_id, outcome, reason FROM command_outcomes').all() as Array<{
                command_id: string
                outcome: string
                reason: string | null
              }>
              for (const o of durableOutcomes) {
                expect(storedCommands.has(o.command_id)).toBe(true)
                if (o.outcome === 'applied') {
                  expect(o.reason).toBeNull()
                } else {
                  expect(typeof o.reason).toBe('string')
                  expect(o.reason!.length).toBeGreaterThan(0)
                }
              }

              // Retry applyPendingCommands
              applyPendingCommands(db, handle)
              applyModelPending()
            }
          }

          // Final flush: apply all remaining pending commands
          applyPendingCommands(db, handle)
          applyModelPending()

          // Invariant 1: Task count equals distinct valid accepted task.create commands
          const taskRows = db.prepare('SELECT id, created_by_command, title, status FROM tasks').all() as Array<{
            id: string
            created_by_command: string
            title: string
            status: string
          }>
          expect(taskRows.length).toBe(validCreateIds.size)
          expect(taskRows.length).toBe(modelTasks.size)

          // Invariant 2: Every task's ID equals its created_by_command, and status MATCHES modeled state
          for (const task of taskRows) {
            expect(task.id).toBe(task.created_by_command)
            expect(validCreateIds.has(task.created_by_command)).toBe(true)
            expect(modelTasks.has(task.id)).toBe(true)
            const modelTask = modelTasks.get(task.id)!
            expect(task.status, `Task ${task.id} status should match modeled state`).toBe(modelTask.status)
          }

          // Invariant 3: Exactly one outcome per stored command, matching modeled expectation
          const outcomes = db.prepare('SELECT command_id, outcome, reason, lease_generation FROM command_outcomes').all() as Array<{
            command_id: string
            outcome: string
            reason: string | null
            lease_generation: number
          }>
          const outcomeCommandIds = outcomes.map((o) => o.command_id)
          const uniqueOutcomeIds = new Set(outcomeCommandIds)
          expect(uniqueOutcomeIds.size).toBe(outcomes.length)
          expect(outcomes.length).toBe(storedCommands.size)

          for (const outcome of outcomes) {
            expect(storedCommands.has(outcome.command_id)).toBe(true)
            expect(outcome.lease_generation).toBeGreaterThanOrEqual(1)

            if (validCreateIds.has(outcome.command_id)) {
              expect(outcome.outcome).toBe('applied')
              expect(outcome.reason).toBeNull()
            } else if (malformedCreateIds.has(outcome.command_id)) {
              expect(outcome.outcome).toBe('rejected')
              expect(typeof outcome.reason).toBe('string')
              expect(outcome.reason!.length).toBeGreaterThan(0)
            } else if (expectedKillOutcomes.has(outcome.command_id)) {
              const expectedKill = expectedKillOutcomes.get(outcome.command_id)!
              expect(outcome.outcome, `Outcome for kill command ${outcome.command_id} targeting ${expectedKill.targetTaskId} should match modeled result`).toBe(expectedKill.outcome)
              if (expectedKill.outcome === 'applied') {
                expect(outcome.reason).toBeNull()
              } else {
                expect(typeof outcome.reason).toBe('string')
                expect(outcome.reason!.length).toBeGreaterThan(0)
              }
            }
          }

          // Invariant 4: Outbox rows match modeled expected kill attempts
          const outboxRows = db.prepare('SELECT idempotency_key, kind, payload_json, status FROM outbox').all() as Array<{
            idempotency_key: string
            kind: string
            payload_json: string
            status: string
          }>
          for (const expectedKey of expectedOutboxKeys) {
            const found = outboxRows.find((r) => r.idempotency_key === expectedKey)
            expect(found, `Expected outbox row ${expectedKey} to exist`).toBeDefined()
            expect(found?.kind).toBe('attempt.kill')
            expect(found?.status).toBe('pending')
            const attemptId = expectedKey.slice('attempt.kill:'.length)
            expect(JSON.parse(found!.payload_json)).toEqual({ attemptId })
          }
          const attemptKillOutboxRows = outboxRows.filter((r) => r.kind === 'attempt.kill')
          expect(attemptKillOutboxRows.length).toBe(expectedOutboxKeys.size)
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
      { numRuns: 25 },
    )
  }, 40000)
})
