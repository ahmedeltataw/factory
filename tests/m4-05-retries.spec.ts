import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openStore } from '../supervisor/src/app/store.ts'
import { acquireSupervisor } from '../supervisor/src/app/supervisor-lease.ts'
import { enqueue, runDue } from '../supervisor/src/app/outbox.ts'
import { retryTask, scheduleAttempt } from '../supervisor/src/app/recovery.ts'

it('backs off outbox failures and stops at the retry limit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm405-outbox-'))
  const db = openStore(join(dir, 'state.sqlite'))
  const handle = acquireSupervisor(db, dir, { nowMs: 1, staleAfterMs: 10000 })
  try {
    enqueue(db, handle, { idempotencyKey: 'x', kind: 'x', payloadJson: '{}', nowMs: 1 })
    const handlers = { x: () => { throw new Error('failed') } }
    expect(await runDue(db, handle, handlers, 100)).toEqual({ done: 0, failed: 0, retried: 1 })
    expect(db.prepare('SELECT status, tries, next_attempt_ms FROM outbox').get()).toMatchObject({ status: 'pending', tries: 1, next_attempt_ms: 1100 })
    expect(await runDue(db, handle, handlers, 1099)).toEqual({ done: 0, failed: 0, retried: 0 })
    expect(await runDue(db, handle, handlers, 1100)).toEqual({ done: 0, failed: 0, retried: 1 })
    expect(db.prepare('SELECT tries, next_attempt_ms FROM outbox').get()).toMatchObject({ tries: 2, next_attempt_ms: 3100 })
    expect(await runDue(db, handle, handlers, 3100)).toEqual({ done: 0, failed: 1, retried: 0 })
    expect(db.prepare('SELECT status, tries, last_error FROM outbox').get()).toMatchObject({ status: 'failed', tries: 3, last_error: 'failed' })
    enqueue(db, handle, { idempotencyKey: 'cap', kind: 'x', payloadJson: '{}', nowMs: 1 })
    db.prepare("UPDATE outbox SET tries = 20 WHERE idempotency_key = 'cap'").run()
    await runDue(db, handle, handlers, 4000)
    expect(db.prepare("SELECT next_attempt_ms FROM outbox WHERE idempotency_key = 'cap'").get()).toMatchObject({ next_attempt_ms: 34000 })
  } finally { handle.release(5000); db.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('enforces retry budget, delay, and attempt base when scheduling', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm405-retry-'))
  const db = openStore(join(dir, 'state.sqlite'))
  const handle = acquireSupervisor(db, dir, { nowMs: 1, staleAfterMs: 10000 })
  try {
    db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p', 'P', 'now')").run()
    db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c', 'p', 'task.create', '{}', 'now')").run()
    db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, max_attempts, attempt_base) VALUES ('t', 'p', 'c', 'T', 'progress', 'now', 'now', 2, 3)").run()
    db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation) VALUES ('a', 't', 4, 'failed', 1)").run()
    retryTask(db, 't', 'a', 100)
    expect(db.prepare("SELECT status, not_before_ms FROM tasks WHERE id = 't'").get()).toMatchObject({ status: 'ready', not_before_ms: 1100 })
    scheduleAttempt(db, handle, 't', dir, 1099)
    expect(db.prepare('SELECT COUNT(*) AS n FROM attempts').get()).toMatchObject({ n: 1 })
    scheduleAttempt(db, handle, 't', dir, 1100)
    expect(db.prepare('SELECT attempt_no, status FROM attempts WHERE attempt_no = 5').get()).toMatchObject({ attempt_no: 5, status: 'pending' })
    const start = db.prepare("SELECT payload_json FROM outbox WHERE kind = 'attempt.start'").get() as { payload_json: string }
    expect(JSON.parse(start.payload_json).env).toEqual({ FACTORY_ATTEMPT_NO: '5' })
    const attempt = db.prepare('SELECT id FROM attempts WHERE attempt_no = 5').get() as { id: string }
    retryTask(db, 't', attempt.id, 2000)
    expect(db.prepare("SELECT status, not_before_ms FROM tasks WHERE id = 't'").get()).toMatchObject({ status: 'failed', not_before_ms: 0 })
  } finally { handle.release(3000); db.close(); rmSync(dir, { recursive: true, force: true }) }
})
