// M3-05 test interface and contract:
//
// Lead decisions for interface and fault behavior:
// 1. supervisor/src/app/faults.ts:
//    - export type FaultName = 'outbox-before-effect' | 'outbox-after-effect' | 'attempt-after-spawn'
//    - export const FAULT_NAMES: readonly FaultName[]
//    - export function parseFault(value: string | undefined): FaultName | undefined
//      Reads/parses string value; valid name -> FaultName; undefined or '' -> undefined; unknown -> throws Error.
//      Environment variable FACTORY_FAULT is read ONLY at CLI entry boundary and passed as an option.
//    - export function triggerFault(fault: FaultName): never
//      Abruptly terminates the process with process.kill(process.pid, 'SIGKILL') semantics,
//      bypassing finally blocks, exit handlers, and normal process cleanup.
//
// 2. supervisor/src/app/outbox.ts:
//    - export interface OutboxRow {
//        id: string
//        idempotency_key: string
//        kind: string
//        payload_json: string
//        status: 'pending' | 'done' | 'failed'
//        tries: number
//        next_attempt_ms: number
//        last_error: string | null
//        created_at: string
//        updated_at: string
//      }
//    - export interface EnqueueOptions {
//        idempotencyKey: string
//        kind: string
//        payloadJson: string
//        nowMs?: number
//      }
//    - export const MAX_TRIES: number
//    - export const BACKOFF_MS: number
//
//    - enqueueInTransaction(db: DatabaseSync, options: EnqueueOptions): OutboxRow
//      Inserts 'pending' row with tries = 0, initial eligibility at supplied time (next_attempt_ms <= nowMs),
//      last_error = null, created_at/updated_at ISO strings.
//      Must be called inside an active fencedWrite transaction alongside its cause.
//      If idempotencyKey already exists, returns the existing OutboxRow without modifying it.
//
//    - enqueue(db: DatabaseSync, handle: SupervisorLeaseHandle, options: EnqueueOptions): OutboxRow
//      Wraps fencedWrite(db, handle, () => enqueueInTransaction(db, options)).
//
//    - export type OutboxHandler = (
//        row: OutboxRow,
//        context: { idempotencyKey: string }
//      ) => void | Promise<void>
//
//    - export interface EffectHandlerDeps {
//        db: DatabaseSync
//        spawnWorker?: (options: {
//          runDir: string
//          cwd: string
//          taskId: string
//          attemptId: string
//          env?: Record<string, string>
//        }) => Promise<{ pid: number; nonce: string }> | { pid: number; nonce: string }
//        config?: EnsureWorktreeConfig
//      }
//
//    - export function createEffectHandlers(
//        deps: EffectHandlerDeps
//      ): Record<string, OutboxHandler>
//      Returns production handlers for kinds 'worktree.ensure', 'attempt.start', 'evidence.commit'.
//      - 'worktree.ensure': checks destination worktree first; idempotent on retry.
//      - 'attempt.start': checks destination worker state; avoids duplicate spawn if worker state is beyond 'starting'.
//      - 'evidence.commit': checks attempt trailer at worktree HEAD first; records immutable evidence row.
//
//    - runDue(
//        db: DatabaseSync,
//        handle: SupervisorLeaseHandle,
//        handlers: Record<string, OutboxHandler>,
//        nowMs: number,
//        options?: { fault?: FaultName }
//      ): Promise<{ done: number; failed: number; retried: number }>
//      Selects due 'pending' rows (next_attempt_ms <= nowMs). Processing order is not part of contract.
//      For each row:
//        1. If options?.fault === 'outbox-before-effect', triggers fault immediately.
//        2. Executes handlers[row.kind](row, { idempotencyKey: row.idempotency_key }).
//        3. If options?.fault === 'outbox-after-effect', triggers fault immediately.
//        4. On success: fencedWrite marks status 'done'.
//        5. On error: fencedWrite increments tries, sets next_attempt_ms = nowMs + BACKOFF_MS, last_error.
//           If tries >= MAX_TRIES, status becomes 'failed'.
//
// 3. Sentinels & Child verification:
//    - Tests prove abrupt termination via sentinels: child registers process.on('exit') and try/finally
//      to write sentinel files. If abrupt SIGKILL occurred, NEITHER sentinel file exists.
//    - spawnSync timeout/errors rejected explicitly (child.error must be undefined, child.signal !== 'SIGTERM').
//    - Non-crash child paths release held supervisor leases before closing connections.
//    - Exhausted cleanup retries rethrow rather than silently returning.
//    - Git commands use timeout 10000ms, GIT_TERMINAL_PROMPT=0, and core.hooksPath="".

import { execFileSync, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { commitAttempt, recordEvidence } from '../../supervisor/src/app/evidence.ts'
import { fencedWrite } from '../../supervisor/src/app/fence.ts'
import { openStore } from '../../supervisor/src/app/store.ts'
import {
  acquireSupervisor,
  LeaseLostError,
  type SupervisorLeaseHandle,
} from '../../supervisor/src/app/supervisor-lease.ts'
import { ensureWorktree, type EnsureWorktreeConfig } from '../../supervisor/src/app/worktree.ts'
import {
  BACKOFF_MS,
  createEffectHandlers,
  enqueue,
  enqueueInTransaction,
  MAX_TRIES,
  runDue,
  type EffectHandlerDeps,
  type OutboxHandler,
  type OutboxRow,
} from '../../supervisor/src/app/outbox.ts'
import {
  parseFault,
  type FaultName,
} from '../../supervisor/src/app/faults.ts'

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
  let lastError: unknown
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (err) {
      lastError = err
      if (attempt === maxRetries) {
        throw lastError
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
    // Release may throw LeaseLostError if displaced
  }
  try {
    ctx.db.close()
  } catch {
    // ignore
  }
}

function setupTestEnv(): TestContext {
  const stateDir = mkdtempSync(join(tmpdir(), 'factory-outbox-state-'))
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
      try { handle.release(Date.now()) } catch { /* ignore */ }
    }
    if (db) {
      try { db.close() } catch { /* ignore */ }
    }
    throw err
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c', 'user.name=Factory Test',
      '-c', 'user.email=factory@example.test',
      '-c', 'core.hooksPath=',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
    },
  ).trim()
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

describe('M3-05 outbox contract', () => {
  describe('CHK-M3-05-a: outbox enqueue and transactional cause coupling', () => {
    it('CHK-M3-05-a: enqueueInTransaction writes outbox row in same fenced transaction as cause and commits both', () => {
      const { db, handle } = setupTestEnv()

      const now = '2026-11-10T00:00:00.000Z'
      const enqueuedRow = fencedWrite(db, handle, () => {
        db.prepare(
          "INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c1', 'p1', 'task.create', '{\"title\":\"Task 1\"}', ?)",
        ).run(now)
        db.prepare(
          "INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES ('t1', 'p1', 'c1', 'Task 1', 'ready', ?, ?)",
        ).run(now, now)

        return enqueueInTransaction(db, {
          idempotencyKey: 'task.ready:t1',
          kind: 'task.ready',
          payloadJson: JSON.stringify({ taskId: 't1' }),
          nowMs: 1000,
        })
      })

      expect(enqueuedRow).toMatchObject({
        idempotency_key: 'task.ready:t1',
        kind: 'task.ready',
        status: 'pending',
        tries: 0,
        last_error: null,
      })
      expect(enqueuedRow.next_attempt_ms).toBeLessThanOrEqual(1000)
      expect(typeof enqueuedRow.id).toBe('string')
      expect(enqueuedRow.payload_json).toBe(JSON.stringify({ taskId: 't1' }))

      // Verify task and outbox rows both committed and visible
      const task = db.prepare('SELECT id, status FROM tasks WHERE id = ?').get('t1') as { id: string; status: string } | undefined
      expect(task).toEqual({ id: 't1', status: 'ready' })

      const row = db.prepare('SELECT * FROM outbox WHERE idempotency_key = ?').get('task.ready:t1') as OutboxRow | undefined
      expect(row).toBeDefined()
      expect(row?.id).toBe(enqueuedRow.id)
      expect(row?.status).toBe('pending')
      expect(row?.tries).toBe(0)
    })

    it('CHK-M3-05-a: rollback leaves neither cause nor outbox row', () => {
      const { db, handle } = setupTestEnv()

      const now = '2026-11-10T00:00:00.000Z'
      expect(() => {
        fencedWrite(db, handle, () => {
          db.prepare(
            "INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c-roll', 'p1', 'task.create', '{\"title\":\"Rolled\"}', ?)",
          ).run(now)
          db.prepare(
            "INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES ('t-roll', 'p1', 'c-roll', 'Rolled', 'ready', ?, ?)",
          ).run(now, now)

          enqueueInTransaction(db, {
            idempotencyKey: 'task.ready:t-roll',
            kind: 'task.ready',
            payloadJson: JSON.stringify({ taskId: 't-roll' }),
            nowMs: 1000,
          })

          throw new Error('simulated failure after outbox enqueue')
        })
      }).toThrow('simulated failure after outbox enqueue')

      // Neither task nor outbox row must exist
      const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get('t-roll')
      expect(task).toBeUndefined()

      const outbox = db.prepare('SELECT id FROM outbox WHERE idempotency_key = ?').get('task.ready:t-roll')
      expect(outbox).toBeUndefined()
    })

    it('CHK-M3-05-a: enqueue helper opens its own fencedWrite and duplicate idempotency key returns existing row', () => {
      const { db, handle } = setupTestEnv()

      const first = enqueue(db, handle, {
        idempotencyKey: 'dup-test-key-1',
        kind: 'attempt.kill',
        payloadJson: JSON.stringify({ attemptId: 'att-1' }),
        nowMs: 1000,
      })
      expect(first.idempotency_key).toBe('dup-test-key-1')
      expect(first.status).toBe('pending')

      // Second enqueue with same idempotency key but different payload/kind
      const second = enqueue(db, handle, {
        idempotencyKey: 'dup-test-key-1',
        kind: 'attempt.different',
        payloadJson: JSON.stringify({ attemptId: 'att-different' }),
        nowMs: 2000,
      })

      expect(second.id).toBe(first.id)
      expect(second.idempotency_key).toBe(first.idempotency_key)
      expect(second.kind).toBe(first.kind)
      expect(second.payload_json).toBe(first.payload_json)
      expect(second.created_at).toBe(first.created_at)

      // Verify exactly one row in outbox table
      const rows = db.prepare('SELECT * FROM outbox WHERE idempotency_key = ?').all('dup-test-key-1')
      expect(rows).toHaveLength(1)
    })

    it('CHK-M3-05-a: enqueue throws LeaseLostError if lease handle is displaced', () => {
      const { db, handle } = setupTestEnv()

      // Displace lease by incrementing generation
      db.prepare('UPDATE supervisor_lease SET generation = generation + 1 WHERE id = 1').run()

      expect(() => {
        enqueue(db, handle, {
          idempotencyKey: 'displaced-key',
          kind: 'test.kind',
          payloadJson: '{}',
        })
      }).toThrow(LeaseLostError)

      expect(db.prepare('SELECT id FROM outbox WHERE idempotency_key = ?').get('displaced-key')).toBeUndefined()
    })
  })

  describe('CHK-M3-05-b: runDue processing, retry backoff, and terminal failure', () => {
    it('CHK-M3-05-b: runDue runs due pending rows with idempotency key, executes async handler, and marks done in fenced transaction', async () => {
      const { db, handle } = setupTestEnv()

      enqueue(db, handle, {
        idempotencyKey: 'due-1',
        kind: 'kind.a',
        payloadJson: JSON.stringify({ item: 1 }),
        nowMs: 1000,
      })
      enqueue(db, handle, {
        idempotencyKey: 'due-2',
        kind: 'kind.b',
        payloadJson: JSON.stringify({ item: 2 }),
        nowMs: 1000,
      })

      const executed: Array<{ kind: string; key: string; payload: unknown }> = []
      const handlers: Record<string, OutboxHandler> = {
        'kind.a': async (row, context) => {
          expect(context.idempotencyKey).toBe(row.idempotency_key)
          await new Promise((r) => setTimeout(r, 10))
          executed.push({ kind: row.kind, key: context.idempotencyKey, payload: JSON.parse(row.payload_json) })
        },
        'kind.b': (row, context) => {
          expect(context.idempotencyKey).toBe(row.idempotency_key)
          executed.push({ kind: row.kind, key: context.idempotencyKey, payload: JSON.parse(row.payload_json) })
        },
      }

      const result = await runDue(db, handle, handlers, 1500)
      expect(result).toEqual({ done: 2, failed: 0, retried: 0 })

      // Execution order is not constrained by contract; assert unordered set
      expect(executed).toHaveLength(2)
      expect(executed).toEqual(
        expect.arrayContaining([
          { kind: 'kind.a', key: 'due-1', payload: { item: 1 } },
          { kind: 'kind.b', key: 'due-2', payload: { item: 2 } },
        ]),
      )

      const r1 = db.prepare('SELECT status, tries, last_error FROM outbox WHERE idempotency_key = ?').get('due-1') as OutboxRow
      const r2 = db.prepare('SELECT status, tries, last_error FROM outbox WHERE idempotency_key = ?').get('due-2') as OutboxRow
      expect(r1.status).toBe('done')
      expect(r1.tries).toBe(0)
      expect(r1.last_error).toBeNull()
      expect(r2.status).toBe('done')
      expect(r2.tries).toBe(0)
    })

    it('CHK-M3-05-b: runDue ignores rows with next_attempt_ms in future and non-pending rows', async () => {
      const { db, handle } = setupTestEnv()

      // Row 1: pending but next_attempt_ms in future
      enqueue(db, handle, { idempotencyKey: 'future-1', kind: 'kind.due', payloadJson: '{}', nowMs: 1000 })
      db.prepare('UPDATE outbox SET next_attempt_ms = 5000 WHERE idempotency_key = ?').run('future-1')

      // Row 2: already done
      enqueue(db, handle, { idempotencyKey: 'done-1', kind: 'kind.due', payloadJson: '{}', nowMs: 1000 })
      db.prepare("UPDATE outbox SET status = 'done' WHERE idempotency_key = ?").run('done-1')

      // Row 3: already failed
      enqueue(db, handle, { idempotencyKey: 'failed-1', kind: 'kind.due', payloadJson: '{}', nowMs: 1000 })
      db.prepare("UPDATE outbox SET status = 'failed' WHERE idempotency_key = ?").run('failed-1')

      // Row 4: eligible due row
      enqueue(db, handle, { idempotencyKey: 'eligible-1', kind: 'kind.due', payloadJson: '{}', nowMs: 1000 })
      db.prepare('UPDATE outbox SET next_attempt_ms = 1000 WHERE idempotency_key = ?').run('eligible-1')

      const called: string[] = []
      const handlers: Record<string, OutboxHandler> = {
        'kind.due': (_row, { idempotencyKey }) => {
          called.push(idempotencyKey)
        },
      }

      const result = await runDue(db, handle, handlers, 2000)
      expect(result).toEqual({ done: 1, failed: 0, retried: 0 })
      expect(called).toEqual(['eligible-1'])
    })

    it('CHK-M3-05-b: on handler error, increments tries, sets next_attempt_ms with fixed BACKOFF_MS, sets last_error, and keeps status pending', async () => {
      const { db, handle } = setupTestEnv()

      expect(typeof BACKOFF_MS).toBe('number')
      expect(BACKOFF_MS).toBeGreaterThan(0)
      expect(typeof MAX_TRIES).toBe('number')
      expect(MAX_TRIES).toBeGreaterThan(1)

      enqueue(db, handle, {
        idempotencyKey: 'retry-key-1',
        kind: 'kind.fail',
        payloadJson: '{}',
        nowMs: 1000,
      })

      const handlers: Record<string, OutboxHandler> = {
        'kind.fail': () => {
          throw new Error('simulated destination failure')
        },
      }

      const now = 2000
      const result = await runDue(db, handle, handlers, now)
      expect(result).toEqual({ done: 0, failed: 0, retried: 1 })

      const row = db.prepare('SELECT * FROM outbox WHERE idempotency_key = ?').get('retry-key-1') as OutboxRow
      expect(row.status).toBe('pending')
      expect(row.tries).toBe(1)
      expect(row.next_attempt_ms).toBe(now + BACKOFF_MS)
      expect(row.last_error).toContain('simulated destination failure')

      // Calling runDue before backoff elapsed must skip this row
      const earlyResult = await runDue(db, handle, handlers, now + BACKOFF_MS - 1)
      expect(earlyResult).toEqual({ done: 0, failed: 0, retried: 0 })
      const rowStillOne = db.prepare('SELECT tries FROM outbox WHERE idempotency_key = ?').get('retry-key-1') as { tries: number }
      expect(rowStillOne.tries).toBe(1)
    })

    it('CHK-M3-05-b: after MAX_TRIES failures, row is marked failed and never retried', async () => {
      const { db, handle } = setupTestEnv()

      enqueue(db, handle, {
        idempotencyKey: 'exhaust-key',
        kind: 'kind.always-fails',
        payloadJson: '{}',
        nowMs: 1000,
      })

      let attemptsCount = 0
      const handlers: Record<string, OutboxHandler> = {
        'kind.always-fails': () => {
          attemptsCount++
          throw new Error(`failure attempt ${attemptsCount}`)
        },
      }

      let currentTime = 2000
      for (let i = 1; i < MAX_TRIES; i++) {
        const res = await runDue(db, handle, handlers, currentTime)
        expect(res).toEqual({ done: 0, failed: 0, retried: 1 })
        const r = db.prepare('SELECT status, tries FROM outbox WHERE idempotency_key = ?').get('exhaust-key') as OutboxRow
        expect(r.status).toBe('pending')
        expect(r.tries).toBe(i)
        currentTime += BACKOFF_MS
      }

      // Final attempt that reaches MAX_TRIES
      const finalRes = await runDue(db, handle, handlers, currentTime)
      expect(finalRes).toEqual({ done: 0, failed: 1, retried: 0 })

      const terminalRow = db.prepare('SELECT status, tries, last_error FROM outbox WHERE idempotency_key = ?').get('exhaust-key') as OutboxRow
      expect(terminalRow.status).toBe('failed')
      expect(terminalRow.tries).toBe(MAX_TRIES)
      expect(terminalRow.last_error).toContain(`failure attempt ${MAX_TRIES}`)

      // Subsequent runDue calls at any future time must never retry
      const futureRes = await runDue(db, handle, handlers, currentTime + 100000)
      expect(futureRes).toEqual({ done: 0, failed: 0, retried: 0 })
      expect(attemptsCount).toBe(MAX_TRIES)
    })

    it('CHK-M3-05-b: runDue throws LeaseLostError when lease handle is displaced', async () => {
      const { db, handle } = setupTestEnv()

      enqueue(db, handle, {
        idempotencyKey: 'lease-lost-key',
        kind: 'test.kind',
        payloadJson: '{}',
        nowMs: 1000,
      })

      // Displace lease
      db.prepare('UPDATE supervisor_lease SET generation = generation + 1 WHERE id = 1').run()

      await expect(
        runDue(db, handle, { 'test.kind': () => {} }, 2000),
      ).rejects.toThrow(LeaseLostError)
    })

    it('CHK-M3-05-b: unknown handler kind increments tries and sets last_error', async () => {
      const { db, handle } = setupTestEnv()

      enqueue(db, handle, {
        idempotencyKey: 'unhandled-kind-key',
        kind: 'no.such.handler',
        payloadJson: '{}',
        nowMs: 1000,
      })

      const res = await runDue(db, handle, {}, 2000)
      expect(res).toEqual({ done: 0, failed: 0, retried: 1 })

      const row = db.prepare('SELECT status, tries, last_error FROM outbox WHERE idempotency_key = ?').get('unhandled-kind-key') as OutboxRow
      expect(row.status).toBe('pending')
      expect(row.tries).toBe(1)
      expect(row.last_error).toMatch(/handler|no\.such\.handler/i)
    })
  })

  describe('CHK-M3-05-c: destination-key checks for effect kinds', () => {
    it('CHK-M3-05-c: evidence.commit checks attempt trailer at destination first and avoids duplicate commit', async () => {
      const root = mkdtempSync(join(tmpdir(), 'factory-chk-c-evidence-'))
      directories.push(root)
      const repoDir = join(root, 'repo')
      const wtDir = join(root, 'wt')
      mkdirSync(repoDir)
      mkdirSync(wtDir)

      git(repoDir, 'init')
      git(repoDir, 'config', 'core.autocrlf', 'false')
      writeFileSync(join(repoDir, 'base.txt'), 'base\n')
      git(repoDir, 'add', '.')
      git(repoDir, 'commit', '-m', 'base commit')
      const baseSha = git(repoDir, 'rev-parse', 'HEAD')

      git(repoDir, 'worktree', 'add', '-b', 'factory/task/t1', wtDir, baseSha)
      writeFileSync(join(wtDir, 'output.txt'), 'work done\n')

      const stdoutPath = join(root, 'stdout.log')
      const stderrPath = join(root, 'stderr.log')
      writeFileSync(stdoutPath, 'stdout data\n')
      writeFileSync(stderrPath, 'stderr data\n')

      const { db, handle } = setupTestEnv()
      const attemptId = 'attempt-trailer-test'

      db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c-att', 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run()
      db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES ('t1', 'p1', 'c-att', 'Task 1', 'ready', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')").run()
      db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation) VALUES (?, 't1', 1, 'succeeded', 1)").run(attemptId)

      enqueue(db, handle, {
        idempotencyKey: `evidence.commit:${attemptId}`,
        kind: 'evidence.commit',
        payloadJson: JSON.stringify({
          attemptId,
          worktreePath: wtDir,
          baseSha,
          stdoutPath,
          stderrPath,
          exitCode: 0,
        }),
        nowMs: 1000,
      })

      const handlers = createEffectHandlers({ db })

      // First run: commits the attempt and writes evidence row
      const res1 = await runDue(db, handle, handlers, 1500)
      expect(res1.done).toBe(1)

      const headSha1 = git(wtDir, 'rev-parse', 'HEAD')
      const commitCount1 = Number(git(wtDir, 'rev-list', '--count', 'HEAD'))
      const log1 = git(wtDir, 'log', '-1', '--format=%B')
      expect(log1).toContain(`Factory-Attempt: ${attemptId}`)

      const evRow1 = db.prepare('SELECT * FROM evidence WHERE attempt_id = ?').all(attemptId)
      expect(evRow1).toHaveLength(1)

      // Simulate retry by resetting outbox row to pending
      db.prepare("UPDATE outbox SET status = 'pending', next_attempt_ms = 0 WHERE idempotency_key = ?").run(`evidence.commit:${attemptId}`)

      // Second run: production handler checks destination trailer/evidence first and avoids duplicate commit
      const res2 = await runDue(db, handle, handlers, 2000)
      expect(res2.done).toBe(1)

      const headSha2 = git(wtDir, 'rev-parse', 'HEAD')
      const commitCount2 = Number(git(wtDir, 'rev-list', '--count', 'HEAD'))
      expect(headSha2).toBe(headSha1)
      expect(commitCount2).toBe(commitCount1)

      const evRow2 = db.prepare('SELECT * FROM evidence WHERE attempt_id = ?').all(attemptId)
      expect(evRow2).toHaveLength(1)
    })

    it('CHK-M3-05-c: worktree.ensure checks destination first and is idempotent on retry', async () => {
      const root = mkdtempSync(join(tmpdir(), 'factory-chk-c-wt-'))
      directories.push(root)
      const repoPath = join(root, 'repo')
      const stateDir = join(root, 'state')
      mkdirSync(repoPath)
      mkdirSync(stateDir)

      git(repoPath, 'init')
      git(repoPath, 'config', 'core.autocrlf', 'false')
      writeFileSync(join(repoPath, 'init.txt'), 'init\n')
      git(repoPath, 'add', '.')
      git(repoPath, 'commit', '-m', 'init')
      const baseRef = git(repoPath, 'rev-parse', 'HEAD')

      const { db, handle } = setupTestEnv()
      const taskId = 'task-wt-c'

      enqueue(db, handle, {
        idempotencyKey: `worktree.ensure:${taskId}`,
        kind: 'worktree.ensure',
        payloadJson: JSON.stringify({ taskId }),
        nowMs: 1000,
      })

      const handlers = createEffectHandlers({
        db,
        config: { stateDir, repoPath, baseRef },
      })

      const res1 = await runDue(db, handle, handlers, 1500)
      expect(res1.done).toBe(1)

      const expectedWtPath = join(stateDir, 'worktrees', taskId)
      expect(existsSync(expectedWtPath)).toBe(true)

      const wtListBefore = git(repoPath, 'worktree', 'list', '--porcelain')

      // Reset to pending and run again
      db.prepare("UPDATE outbox SET status = 'pending', next_attempt_ms = 0 WHERE idempotency_key = ?").run(`worktree.ensure:${taskId}`)

      const res2 = await runDue(db, handle, handlers, 2000)
      expect(res2.done).toBe(1)
      expect(existsSync(expectedWtPath)).toBe(true)

      const wtListAfter = git(repoPath, 'worktree', 'list', '--porcelain')
      expect(wtListAfter).toBe(wtListBefore)
    })

    it('CHK-M3-05-c: attempt.start checks destination worker state and avoids duplicate spawn if worker is beyond starting', async () => {
      const { db, handle } = setupTestEnv()

      const now = '2026-11-10T00:00:00.000Z'
      db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c-start', 'p1', 'task.create', '{}', ?)").run(now)
      db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES ('t-start', 'p1', 'c-start', 'Task', 'ready', ?, ?)").run(now, now)
      db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation) VALUES ('att-chk-c', 't-start', 1, 'pending', 1)").run()

      let spawnCounter = 0
      const spawnWorkerSpy = vi.fn().mockImplementation(async (opts: { attemptId: string }) => {
        spawnCounter++
        return { pid: 9999, nonce: `nonce-${opts.attemptId}` }
      })

      const handlers = createEffectHandlers({
        db,
        spawnWorker: spawnWorkerSpy,
      })

      enqueue(db, handle, {
        idempotencyKey: 'attempt.start:att-chk-c',
        kind: 'attempt.start',
        payloadJson: JSON.stringify({ attemptId: 'att-chk-c', taskId: 't-start' }),
        nowMs: 1000,
      })

      // Run 1: attempt has no worker row -> spawnWorker called
      const r1 = await runDue(db, handle, handlers, 1500)
      expect(r1.done).toBe(1)
      expect(spawnWorkerSpy).toHaveBeenCalledTimes(1)
      expect(spawnCounter).toBe(1)

      const workerRow = db.prepare('SELECT state FROM workers WHERE attempt_id = ?').get('att-chk-c') as { state: string } | undefined
      expect(workerRow).toBeDefined()

      // Reset to pending and run again
      db.prepare("UPDATE outbox SET status = 'pending', next_attempt_ms = 0 WHERE idempotency_key = ?").run('attempt.start:att-chk-c')

      // Ensure worker is in a state beyond 'starting' (e.g. 'running')
      db.prepare("UPDATE workers SET state = 'running' WHERE attempt_id = ?").run('att-chk-c')

      // Run 2: worker state is 'running' (beyond 'starting') -> production handler destination guard skips spawnWorker
      const r2 = await runDue(db, handle, handlers, 2000)
      expect(r2.done).toBe(1)
      expect(spawnWorkerSpy).toHaveBeenCalledTimes(1)
      expect(spawnCounter).toBe(1)

      // Test against other states beyond 'starting': 'exited', 'killed', 'lost'
      for (const terminalState of ['exited', 'killed', 'lost'] as const) {
        db.prepare('UPDATE workers SET state = ? WHERE attempt_id = ?').run(terminalState, 'att-chk-c')
        db.prepare("UPDATE outbox SET status = 'pending', next_attempt_ms = 0 WHERE idempotency_key = ?").run('attempt.start:att-chk-c')

        const rx = await runDue(db, handle, handlers, 2500)
        expect(rx.done).toBe(1)
        expect(spawnWorkerSpy).toHaveBeenCalledTimes(1)
        expect(spawnCounter).toBe(1)
      }
    })
  })

  describe('CHK-M3-05-d: injected crash recovery and exact-once destination effects', () => {
    // Child 1 script: runs with fault injection and sentinels to verify abrupt termination
    const childWorkerSource = `
import { writeFileSync } from 'node:fs';

const [
  storeUrl,
  leaseUrl,
  outboxUrl,
  faultsUrl,
  dbPath,
  stateDir,
  evidenceJsonPath,
  sentinelFinallyPath,
  sentinelExitPath,
  faultName,
  attemptId,
  wtDir,
  baseSha,
  stdoutPath,
  stderrPath,
] = process.argv.slice(2);

process.on('exit', () => {
  try {
    writeFileSync(sentinelExitPath, 'exit handler executed');
  } catch {}
});

const { openStore } = await import(storeUrl);
const { acquireSupervisor } = await import(leaseUrl);
const { enqueue, runDue, createEffectHandlers } = await import(outboxUrl);
const { parseFault } = await import(faultsUrl);

const parsedFault = parseFault(faultName);

let db;
let handle;
try {
  db = openStore(dbPath);
  handle = acquireSupervisor(db, stateDir, { nowMs: 1000, staleAfterMs: 1000 });
  writeFileSync(
    evidenceJsonPath,
    JSON.stringify({
      ownerId: handle.ownerId,
      generation: handle.generation,
      heartbeatMs: 1000,
    }),
  );

  enqueue(db, handle, {
    idempotencyKey: \`evidence.commit:\${attemptId}\`,
    kind: 'evidence.commit',
    payloadJson: JSON.stringify({
      attemptId,
      worktreePath: wtDir,
      baseSha,
      stdoutPath,
      stderrPath,
      exitCode: 0,
    }),
    nowMs: 1000,
  });

  const handlers = createEffectHandlers({ db });
  await runDue(db, handle, handlers, 1000, { fault: parsedFault });

  handle.release(1001);
  handle = null;
} finally {
  try {
    writeFileSync(sentinelFinallyPath, 'finally block executed');
  } catch {}
  if (handle) {
    try {
      handle.release(1001);
    } catch {}
  }
  if (db) {
    try {
      db.close();
    } catch {}
  }
}
`

    // Child 2 script: fresh bounded recovery process taking over the stale lease
    const childRecoverySource = `
import { readFileSync } from 'node:fs';

const [
  storeUrl,
  leaseUrl,
  outboxUrl,
  dbPath,
  stateDir,
  evidenceJsonPath,
  nowMsStr,
] = process.argv.slice(2);

const { openStore } = await import(storeUrl);
const { acquireSupervisor } = await import(leaseUrl);
const { runDue, createEffectHandlers } = await import(outboxUrl);

const childEvidence = JSON.parse(readFileSync(evidenceJsonPath, 'utf8'));
const nowMs = Number(nowMsStr);

let db;
let handle;
try {
  db = openStore(dbPath);
  handle = acquireSupervisor(db, stateDir, {
    nowMs,
    staleAfterMs: 1000,
    takeover: childEvidence,
  });

  const handlers = createEffectHandlers({ db });
  await runDue(db, handle, handlers, nowMs);

  handle.release(nowMs + 1);
  handle = null;
} finally {
  if (handle) {
    try {
      handle.release(nowMs + 1);
    } catch {}
  }
  if (db) {
    try {
      db.close();
    } catch {}
  }
}
`

    it('CHK-M3-05-d: child run with FACTORY_FAULT=outbox-after-effect dies after effect; fresh takeover process retries -> destination effect count exactly 1 and row is done', async () => {
      const stateDir = mkdtempSync(join(tmpdir(), 'factory-chk-d-after-'))
      directories.push(stateDir)
      const dbPath = join(stateDir, 'state.sqlite')
      const evidenceFile = join(stateDir, 'lease-evidence.json')
      const sentinelFinally = join(stateDir, 'sentinel-finally.txt')
      const sentinelExit = join(stateDir, 'sentinel-exit.txt')
      const childScript = join(stateDir, 'child.mjs')
      const childRecoveryScript = join(stateDir, 'child-recovery.mjs')
      writeFileSync(childScript, childWorkerSource)
      writeFileSync(childRecoveryScript, childRecoverySource)

      const repoDir = join(stateDir, 'repo')
      const wtDir = join(stateDir, 'wt')
      mkdirSync(repoDir)
      mkdirSync(wtDir)

      git(repoDir, 'init')
      git(repoDir, 'config', 'core.autocrlf', 'false')
      writeFileSync(join(repoDir, 'base.txt'), 'base\n')
      git(repoDir, 'add', '.')
      git(repoDir, 'commit', '-m', 'base commit')
      const baseSha = git(repoDir, 'rev-parse', 'HEAD')

      git(repoDir, 'worktree', 'add', '-b', 'factory/task/t-after', wtDir, baseSha)
      writeFileSync(join(wtDir, 'output.txt'), 'content after\n')

      const stdoutPath = join(stateDir, 'stdout.log')
      const stderrPath = join(stateDir, 'stderr.log')
      writeFileSync(stdoutPath, 'worker stdout\n')
      writeFileSync(stderrPath, 'worker stderr\n')

      const attemptId = 'att-after-1'
      const testKey = `evidence.commit:${attemptId}`

      // Initialize DB schema and prerequisite rows
      const initDb = openStore(dbPath)
      try {
        initDb.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'Project', '2026-11-10T00:00:00.000Z')").run()
        initDb.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c1', 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run()
        initDb.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES ('t-after', 'p1', 'c1', 'Task', 'ready', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')").run()
        initDb.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation) VALUES (?, 't-after', 1, 'succeeded', 1)").run(attemptId)
      } finally {
        initDb.close()
      }

      const storeUrl = pathToFileURL(join(process.cwd(), 'supervisor/src/app/store.ts')).href
      const leaseUrl = pathToFileURL(join(process.cwd(), 'supervisor/src/app/supervisor-lease.ts')).href
      const outboxUrl = pathToFileURL(join(process.cwd(), 'supervisor/src/app/outbox.ts')).href
      const faultsUrl = pathToFileURL(join(process.cwd(), 'supervisor/src/app/faults.ts')).href

      // 1. Run Child 1 with fault 'outbox-after-effect'
      const childResult = spawnSync(
        process.execPath,
        [
          childScript,
          storeUrl,
          leaseUrl,
          outboxUrl,
          faultsUrl,
          dbPath,
          stateDir,
          evidenceFile,
          sentinelFinally,
          sentinelExit,
          'outbox-after-effect',
          attemptId,
          wtDir,
          baseSha,
          stdoutPath,
          stderrPath,
        ],
        {
          timeout: 10000,
          encoding: 'utf8',
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        },
      )

      // Explicitly reject timeouts or spawn errors
      expect(childResult.error).toBeUndefined()
      expect(childResult.signal).not.toBe('SIGTERM')
      expect(childResult.status).not.toBe(0)

      // Sentinels: abrupt termination must NOT execute finally blocks or exit handlers
      expect(existsSync(sentinelFinally)).toBe(false)
      expect(existsSync(sentinelExit)).toBe(false)
      expect(existsSync(evidenceFile)).toBe(true)

      // With outbox-after-effect, the effect ran before the crash: commit with trailer exists
      const trailerCommitsBefore = git(wtDir, 'log', `--grep=^Factory-Attempt: ${attemptId}$`, '--format=%H')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
      expect(trailerCommitsBefore).toHaveLength(1)

      // Evidence row in DB exists, but outbox row is still 'pending'
      const verifyDb = openStore(dbPath)
      try {
        const evRows = verifyDb.prepare('SELECT * FROM evidence WHERE attempt_id = ?').all(attemptId)
        expect(evRows).toHaveLength(1)

        const pendingRow = verifyDb.prepare('SELECT status FROM outbox WHERE idempotency_key = ?').get(testKey) as { status: string } | undefined
        expect(pendingRow).toBeDefined()
        expect(pendingRow?.status).toBe('pending')
      } finally {
        verifyDb.close()
      }

      // 2. Run Child 2 (fresh bounded process taking over the stale lease)
      const child2Result = spawnSync(
        process.execPath,
        [
          childRecoveryScript,
          storeUrl,
          leaseUrl,
          outboxUrl,
          dbPath,
          stateDir,
          evidenceFile,
          '3000',
        ],
        {
          timeout: 10000,
          encoding: 'utf8',
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        },
      )

      expect(child2Result.error).toBeUndefined()
      expect(child2Result.signal).not.toBe('SIGTERM')
      expect(child2Result.status).toBe(0)

      // Destination effect count must be strictly 1 commit and 1 evidence row
      const trailerCommitsAfter = git(wtDir, 'log', `--grep=^Factory-Attempt: ${attemptId}$`, '--format=%H')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
      expect(trailerCommitsAfter).toHaveLength(1)

      const verifyDbAfter = openStore(dbPath)
      try {
        const evRowsAfter = verifyDbAfter.prepare('SELECT * FROM evidence WHERE attempt_id = ?').all(attemptId)
        expect(evRowsAfter).toHaveLength(1)

        const doneRow = verifyDbAfter.prepare('SELECT status, tries FROM outbox WHERE idempotency_key = ?').get(testKey) as OutboxRow
        expect(doneRow.status).toBe('done')
      } finally {
        verifyDbAfter.close()
      }
    })

    it('CHK-M3-05-d: child run with FACTORY_FAULT=outbox-before-effect dies before effect; fresh takeover process retries -> destination effect runs exactly once and row is done', async () => {
      const stateDir = mkdtempSync(join(tmpdir(), 'factory-chk-d-before-'))
      directories.push(stateDir)
      const dbPath = join(stateDir, 'state.sqlite')
      const evidenceFile = join(stateDir, 'lease-evidence.json')
      const sentinelFinally = join(stateDir, 'sentinel-finally.txt')
      const sentinelExit = join(stateDir, 'sentinel-exit.txt')
      const childScript = join(stateDir, 'child.mjs')
      const childRecoveryScript = join(stateDir, 'child-recovery.mjs')
      writeFileSync(childScript, childWorkerSource)
      writeFileSync(childRecoveryScript, childRecoverySource)

      const repoDir = join(stateDir, 'repo')
      const wtDir = join(stateDir, 'wt')
      mkdirSync(repoDir)
      mkdirSync(wtDir)

      git(repoDir, 'init')
      git(repoDir, 'config', 'core.autocrlf', 'false')
      writeFileSync(join(repoDir, 'base.txt'), 'base\n')
      git(repoDir, 'add', '.')
      git(repoDir, 'commit', '-m', 'base commit')
      const baseSha = git(repoDir, 'rev-parse', 'HEAD')

      git(repoDir, 'worktree', 'add', '-b', 'factory/task/t-before', wtDir, baseSha)
      writeFileSync(join(wtDir, 'output.txt'), 'content before\n')

      const stdoutPath = join(stateDir, 'stdout.log')
      const stderrPath = join(stateDir, 'stderr.log')
      writeFileSync(stdoutPath, 'worker stdout\n')
      writeFileSync(stderrPath, 'worker stderr\n')

      const attemptId = 'att-before-1'
      const testKey = `evidence.commit:${attemptId}`

      const initDb = openStore(dbPath)
      try {
        initDb.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'Project', '2026-11-10T00:00:00.000Z')").run()
        initDb.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c1', 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run()
        initDb.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES ('t-before', 'p1', 'c1', 'Task', 'ready', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')").run()
        initDb.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation) VALUES (?, 't-before', 1, 'succeeded', 1)").run(attemptId)
      } finally {
        initDb.close()
      }

      const storeUrl = pathToFileURL(join(process.cwd(), 'supervisor/src/app/store.ts')).href
      const leaseUrl = pathToFileURL(join(process.cwd(), 'supervisor/src/app/supervisor-lease.ts')).href
      const outboxUrl = pathToFileURL(join(process.cwd(), 'supervisor/src/app/outbox.ts')).href
      const faultsUrl = pathToFileURL(join(process.cwd(), 'supervisor/src/app/faults.ts')).href

      // 1. Run Child 1 with fault 'outbox-before-effect'
      const childResult = spawnSync(
        process.execPath,
        [
          childScript,
          storeUrl,
          leaseUrl,
          outboxUrl,
          faultsUrl,
          dbPath,
          stateDir,
          evidenceFile,
          sentinelFinally,
          sentinelExit,
          'outbox-before-effect',
          attemptId,
          wtDir,
          baseSha,
          stdoutPath,
          stderrPath,
        ],
        {
          timeout: 10000,
          encoding: 'utf8',
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        },
      )

      expect(childResult.error).toBeUndefined()
      expect(childResult.signal).not.toBe('SIGTERM')
      expect(childResult.status).not.toBe(0)

      // Sentinels: abrupt termination must NOT execute finally blocks or exit handlers
      expect(existsSync(sentinelFinally)).toBe(false)
      expect(existsSync(sentinelExit)).toBe(false)
      expect(existsSync(evidenceFile)).toBe(true)

      // With outbox-before-effect, child died BEFORE effect ran: no commit with trailer
      const trailerCommitsBefore = git(wtDir, 'log', `--grep=^Factory-Attempt: ${attemptId}$`, '--format=%H')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
      expect(trailerCommitsBefore).toHaveLength(0)

      const verifyDb = openStore(dbPath)
      try {
        const evRows = verifyDb.prepare('SELECT * FROM evidence WHERE attempt_id = ?').all(attemptId)
        expect(evRows).toHaveLength(0)

        const pendingRow = verifyDb.prepare('SELECT status FROM outbox WHERE idempotency_key = ?').get(testKey) as { status: string } | undefined
        expect(pendingRow).toBeDefined()
        expect(pendingRow?.status).toBe('pending')
      } finally {
        verifyDb.close()
      }

      // 2. Run Child 2 (fresh bounded process taking over the stale lease)
      const child2Result = spawnSync(
        process.execPath,
        [
          childRecoveryScript,
          storeUrl,
          leaseUrl,
          outboxUrl,
          dbPath,
          stateDir,
          evidenceFile,
          '3000',
        ],
        {
          timeout: 10000,
          encoding: 'utf8',
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        },
      )

      expect(child2Result.error).toBeUndefined()
      expect(child2Result.signal).not.toBe('SIGTERM')
      expect(child2Result.status).toBe(0)

      // Destination effect was applied exactly once on retry
      const trailerCommitsAfter = git(wtDir, 'log', `--grep=^Factory-Attempt: ${attemptId}$`, '--format=%H')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
      expect(trailerCommitsAfter).toHaveLength(1)

      const verifyDbAfter = openStore(dbPath)
      try {
        const evRowsAfter = verifyDbAfter.prepare('SELECT * FROM evidence WHERE attempt_id = ?').all(attemptId)
        expect(evRowsAfter).toHaveLength(1)

        const doneRow = verifyDbAfter.prepare('SELECT status, tries FROM outbox WHERE idempotency_key = ?').get(testKey) as OutboxRow
        expect(doneRow.status).toBe('done')
      } finally {
        verifyDbAfter.close()
      }
    })
  })

  describe('CHK-M3-05-f: fault configuration and validation', () => {
    it('CHK-M3-05-f: parseFault returns FaultName for valid values, undefined for unset/empty, and throws for unknown values', () => {
      // Valid known fault values
      expect(parseFault('outbox-before-effect')).toBe('outbox-before-effect')
      expect(parseFault('outbox-after-effect')).toBe('outbox-after-effect')
      expect(parseFault('attempt-after-spawn')).toBe('attempt-after-spawn')

      // Undefined or empty -> undefined (no fault)
      expect(parseFault(undefined)).toBeUndefined()
      expect(parseFault('')).toBeUndefined()

      // Unknown values must be refused / thrown
      expect(() => parseFault('unknown-fault')).toThrow(/fault/i)
      expect(() => parseFault('outbox-mid-effect')).toThrow(/fault/i)
      expect(() => parseFault('12345')).toThrow(/fault/i)
    })

    it('CHK-M3-05-f: unset FACTORY_FAULT / no fault option runs no fault path and does not kill process (spy)', async () => {
      const { db, handle } = setupTestEnv()

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit called')
      }) as unknown as (code?: string | number | null | undefined) => never)

      try {
        enqueue(db, handle, {
          idempotencyKey: 'spy-no-fault-key',
          kind: 'spy.kind',
          payloadJson: '{}',
          nowMs: 1000,
        })

        let handlerCalled = false
        const handlers: Record<string, OutboxHandler> = {
          'spy.kind': () => {
            handlerCalled = true
          },
        }

        const res = await runDue(db, handle, handlers, 2000, { fault: undefined })
        expect(res.done).toBe(1)
        expect(handlerCalled).toBe(true)
        expect(exitSpy).not.toHaveBeenCalled()

        const row = db.prepare('SELECT status FROM outbox WHERE idempotency_key = ?').get('spy-no-fault-key') as OutboxRow
        expect(row.status).toBe('done')
      } finally {
        exitSpy.mockRestore()
      }
    })
  })
})
