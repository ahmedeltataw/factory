import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { finishAttempt, readCompletion, readWorker, reconcileWorkers } from '../supervisor/src/app/recovery.ts'
import { openStore } from '../supervisor/src/app/store.ts'
import { acquireSupervisor } from '../supervisor/src/app/supervisor-lease.ts'
import { runTick } from '../supervisor/src/app/supervisor-loop.ts'
import type { DatabaseSync } from 'node:sqlite'

const roots: string[] = []
function seed(db: DatabaseSync, id: string, status = 'progress', generation = 1): void {
  db.prepare("INSERT OR IGNORE INTO projects (id,name,created_at) VALUES ('p','p','t')").run()
  db.prepare("INSERT OR IGNORE INTO project_config (project_id,repo_path,base_ref,created_at) VALUES ('p','missing','main','t')").run()
  db.prepare("INSERT INTO commands (id,project_id,kind,payload_json,created_at) VALUES (?,'p','task.create','{}','t')").run(`c${id}`)
  db.prepare("INSERT INTO command_outcomes (command_id,outcome,lease_generation,applied_at) VALUES (?,'applied',1,'t')").run(`c${id}`)
  db.prepare("INSERT INTO tasks (id,project_id,created_by_command,title,status,created_at,updated_at) VALUES (?,'p',?, ?,?,'t','t')").run(id, `c${id}`, id, status)
  db.prepare("INSERT INTO attempts (id,task_id,attempt_no,status,lease_generation) VALUES (?, ?,1,'pending',?)").run(`a${id}`, id, generation)
}
function effect(db: DatabaseSync, kind: string, id: string, tries = 0): void {
  db.prepare("INSERT INTO outbox (id,idempotency_key,kind,payload_json,status,tries,next_attempt_ms,created_at,updated_at) VALUES (?, ?, ?, ?, 'pending', ?,0,'t','t')").run(`${kind}:${id}`, `${kind}:${id}`, kind, JSON.stringify({ attemptId: id }), tries)
}
const loopDeps = (stateDir: string) => ({ stateDir, spawnWorker: () => { throw new Error('unexpected spawn') }, killTree: async () => ({ result: 'not-running' as const }), isAlive: () => false, readResult: () => undefined })
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
it('rejects malformed worker identities and result records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm306-read-')); roots.push(dir)
  expect(readWorker(dir)).toBeUndefined()
  expect(readCompletion(dir)).toBeUndefined()
  writeFileSync(join(dir, 'worker.json'), '{"pid":0,"nonce":"x"}')
  writeFileSync(join(dir, 'result.json'), '{"exitCode":1.5}')
  expect(readWorker(dir)).toBeUndefined()
  expect(readCompletion(dir)).toBeUndefined()
  writeFileSync(join(dir, 'worker.json'), '{"pid":123,"nonce":"x"}')
  writeFileSync(join(dir, 'result.json'), '{"exitCode":2}')
  expect(readWorker(dir)).toEqual({ pid: 123, nonce: 'x' })
  expect(readCompletion(dir)).toEqual({ exitCode: 2 })
})
it('supersedes an old unrecorded spawn and checks late identities only in the bounded window', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm306-old-')); roots.push(dir)
  const db = openStore(join(dir, 'state.sqlite'))
  const first = acquireSupervisor(db, dir, { nowMs: 1000, staleAfterMs: 100 })
  db.prepare("INSERT INTO projects (id,name,created_at) VALUES ('p','p','t')").run()
  db.prepare("INSERT INTO commands (id,project_id,kind,payload_json,created_at) VALUES ('c','p','task.create','{}','t')").run()
  db.prepare("INSERT INTO tasks (id,project_id,created_by_command,title,status,created_at,updated_at) VALUES ('t','p','c','t','progress','t','t')").run()
  db.prepare("INSERT INTO attempts (id,task_id,attempt_no,status,lease_generation,started_at) VALUES ('a','t',1,'pending',1,'t')").run()
  db.prepare("INSERT INTO outbox (id,idempotency_key,kind,payload_json,status,tries,next_attempt_ms,created_at,updated_at) VALUES ('o','attempt.start:a','attempt.start','{}','pending',0,0,'t','t')").run()
  first.release(1000)
  const handle = acquireSupervisor(db, dir, { nowMs: 1100, staleAfterMs: 100 })
  const calls: number[] = []
  const deps = { stateDir: dir, staleAfterMs: 100, killTree: async (pid: number) => { calls.push(pid); return { result: 'identity-mismatch' as const } } }
  try {
    expect((await reconcileWorkers(db, handle, deps, 1200)).lostCount).toBe(1)
    expect(db.prepare("SELECT status FROM outbox WHERE id='o'").get()?.status).toBe('done')
    expect(db.prepare("SELECT status FROM attempts WHERE id='a'").get()?.status).toBe('interrupted')
    const run = join(dir, 'runs', 'a'); mkdirSync(run, { recursive: true })
    writeFileSync(join(run, 'worker.json'), JSON.stringify({ pid: 42, nonce: 'n' }))
    await reconcileWorkers(db, handle, deps, 1250)
    await reconcileWorkers(db, handle, deps, 1300)
    expect(calls).toEqual([42])
    expect(JSON.parse(readFileSync(join(run, 'worker.json'), 'utf8')).pid).toBe(42)
  } finally { handle.release(1400); db.close() }
})

it('runs all tick phases in order for an idle lease', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm306-idle-')); roots.push(dir)
  const db = openStore(join(dir, 'state.sqlite'))
  const handle = acquireSupervisor(db, dir, { nowMs: 1000, staleAfterMs: 100 })
  const { runTick } = await import('../supervisor/src/app/supervisor-loop.ts')
  const phases: string[] = []
  try {
    const result = await runTick(db, handle, {
      stateDir: dir, onPhase: (phase) => phases.push(phase),
      spawnWorker: () => { throw new Error('unexpected spawn') },
      killTree: async () => ({ result: 'not-running' }),
      isAlive: () => false, readResult: () => undefined,
    }, 1100)
    expect(result.idle).toBe(true)
    expect(phases).toEqual(['recover-outbox', 'reconcile-workers', 'apply-commands', 'dispatch-tasks', 'worker-liveness', 'lease-heartbeat'])
    expect(db.prepare('SELECT heartbeat_ms FROM supervisor_lease').get()?.heartbeat_ms).toBe(1100)
  } finally { handle.release(1200); db.close() }
})

it('fails a task at the retry limit without scheduling another attempt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm306-limit-')); roots.push(dir)
  const db = openStore(join(dir, 'state.sqlite'))
  const handle = acquireSupervisor(db, dir, { nowMs: 1000, staleAfterMs: 100 })
  const { MAX_ATTEMPTS, scheduleAttempt } = await import('../supervisor/src/app/recovery.ts')
  const { fencedWrite } = await import('../supervisor/src/app/fence.ts')
  try {
    db.prepare("INSERT INTO projects (id,name,created_at) VALUES ('p','p','t')").run()
    db.prepare("INSERT INTO commands (id,project_id,kind,payload_json,created_at) VALUES ('c','p','task.create','{}','t')").run()
    db.prepare("INSERT INTO tasks (id,project_id,created_by_command,title,status,created_at,updated_at) VALUES ('t','p','c','t','ready','t','t')").run()
    for (let i = 1; i <= MAX_ATTEMPTS; i++) db.prepare("INSERT INTO attempts (id,task_id,attempt_no,status,lease_generation) VALUES (?,'t',?,'interrupted',1)").run(`a${i}`, i)
    fencedWrite(db, handle, () => scheduleAttempt(db, handle, 't', dir, 1100))
    expect(db.prepare("SELECT status FROM tasks WHERE id='t'").get()?.status).toBe('failed')
    expect(db.prepare('SELECT COUNT(*) AS n FROM attempts').get()?.n).toBe(MAX_ATTEMPTS)
    expect(db.prepare('SELECT COUNT(*) AS n FROM outbox').get()?.n).toBe(0)
  } finally { handle.release(1200); db.close() }
})

it('reconciliation leaves unrelated due effects untouched and supersedes interrupted setup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm306-isolate-')); roots.push(dir)
  const db = openStore(join(dir, 'state.sqlite'))
  const old = acquireSupervisor(db, dir, { nowMs: 1000, staleAfterMs: 100 })
  seed(db, 'lost'); seed(db, 'complete'); seed(db, 'other', 'progress', 2)
  effect(db, 'worktree.ensure', 'alost'); effect(db, 'attempt.start', 'alost')
  effect(db, 'attempt.start', 'acomplete'); effect(db, 'attempt.kill', 'aother')
  const run = join(dir, 'runs', 'acomplete'); mkdirSync(run, { recursive: true }); writeFileSync(join(run, 'result.json'), '{"exitCode":0}')
  old.release(1000)
  const handle = acquireSupervisor(db, dir, { nowMs: 1100, staleAfterMs: 100 })
  try {
    await reconcileWorkers(db, handle, loopDeps(dir), 1200)
    expect(db.prepare("SELECT status FROM outbox WHERE id='worktree.ensure:alost'").get()?.status).toBe('done')
    expect(db.prepare("SELECT status FROM outbox WHERE id='attempt.start:acomplete'").get()?.status).toBe('done')
    expect(db.prepare("SELECT status, tries, next_attempt_ms FROM outbox WHERE id='attempt.kill:aother'").get()).toMatchObject({ status: 'pending', tries: 0, next_attempt_ms: 0 })
    expect(db.prepare("SELECT status FROM outbox WHERE idempotency_key='evidence.commit:acomplete'").get()?.status).toBe('pending')
    expect(db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status='pending' AND kind='attempt.start' AND tries=0").get()?.n).toBe(1)
  } finally { handle.release(1300); db.close() }
})

it.each(['worktree.ensure', 'attempt.start', 'evidence.commit'])('fails attempt and task after terminal %s failure', async (kind) => {
  const dir = mkdtempSync(join(tmpdir(), 'm306-failed-')); roots.push(dir)
  const db = openStore(join(dir, 'state.sqlite')); const handle = acquireSupervisor(db, dir, { nowMs: 1000, staleAfterMs: 100 })
  seed(db, 'x')
  if (kind === 'evidence.commit') {
    finishAttempt(db, handle, { id: 'ax', task_id: 'x', worktree_path: null }, dir, 0, 1000)
    db.prepare("UPDATE outbox SET tries=2 WHERE idempotency_key='evidence.commit:ax'").run()
  } else effect(db, kind, 'ax', 2)
  if (kind === 'worktree.ensure') effect(db, 'attempt.start', 'ax')
  try {
    const result = await runTick(db, handle, loopDeps(dir), 1100)
    expect(result.idle).toBe(true)
    expect(db.prepare("SELECT status,error_class,ended_at FROM attempts WHERE id='ax'").get()).toMatchObject({ status: 'failed', error_class: `outbox:${kind}`, ended_at: expect.any(String) })
    expect(db.prepare("SELECT status FROM tasks WHERE id='x'").get()?.status).toBe('failed')
    expect(db.prepare("SELECT COUNT(*) AS n FROM evidence WHERE attempt_id='ax'").get()?.n).toBe(0)
    expect(db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status='pending'").get()?.n).toBe(0)
  } finally { handle.release(1200); db.close() }
})

it('rejects a displaced lease before killing a worker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm306-fence-')); roots.push(dir)
  const db = openStore(join(dir, 'state.sqlite')); const old = acquireSupervisor(db, dir, { nowMs: 1000, staleAfterMs: 100 })
  seed(db, 'x'); const run = join(dir, 'runs', 'ax'); mkdirSync(run, { recursive: true }); writeFileSync(join(run, 'worker.json'), '{"pid":42,"nonce":"n"}')
  old.release(1000); const handle = acquireSupervisor(db, dir, { nowMs: 1100, staleAfterMs: 100 })
  let calls = 0
  try {
    await expect(reconcileWorkers(db, old, { stateDir: dir, killTree: async () => { calls++; return { result: 'killed' } } }, 1200)).rejects.toMatchObject({ name: 'LeaseLostError' })
    expect(calls).toBe(0)
  } finally { handle.release(1300); db.close() }
})

it('kills using worker.json when no worker pid was recorded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm306-kill-')); roots.push(dir)
  const db = openStore(join(dir, 'state.sqlite')); const handle = acquireSupervisor(db, dir, { nowMs: 1000, staleAfterMs: 100 })
  seed(db, 'x', 'dropped'); effect(db, 'attempt.kill', 'ax')
  const run = join(dir, 'runs', 'ax'); mkdirSync(run, { recursive: true }); writeFileSync(join(run, 'worker.json'), '{"pid":42,"nonce":"n"}')
  const calls: unknown[] = []
  try {
    await runTick(db, handle, { ...loopDeps(dir), killTree: async (pid, nonce) => { calls.push([pid, nonce]); return { result: 'killed' } } }, 1100)
    expect(calls[0]).toEqual([42, 'n'])
    expect(db.prepare("SELECT status FROM attempts WHERE id='ax'").get()?.status).toBe('killed')
  } finally { handle.release(1200); db.close() }
})

it('rechecks late identities for killed dropped attempts only within the window', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm306-dropped-')); roots.push(dir)
  const db = openStore(join(dir, 'state.sqlite')); const old = acquireSupervisor(db, dir, { nowMs: 1000, staleAfterMs: 100 })
  seed(db, 'x', 'dropped'); old.release(1000); const handle = acquireSupervisor(db, dir, { nowMs: 1100, staleAfterMs: 100 })
  const calls: number[] = []; const deps = { stateDir: dir, staleAfterMs: 100, killTree: async (pid: number) => { calls.push(pid); return { result: 'killed' as const } } }
  try {
    await reconcileWorkers(db, handle, deps, 1200)
    const run = join(dir, 'runs', 'ax'); mkdirSync(run, { recursive: true }); writeFileSync(join(run, 'worker.json'), '{"pid":42,"nonce":"n"}')
    await reconcileWorkers(db, handle, deps, 1250); await reconcileWorkers(db, handle, deps, 1300)
    expect(calls).toEqual([42])
    expect(db.prepare("SELECT status FROM tasks WHERE id='x'").get()?.status).toBe('dropped')
  } finally { handle.release(1400); db.close() }
})
