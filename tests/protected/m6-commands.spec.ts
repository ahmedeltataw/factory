import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { openStore } from '../../supervisor/src/app/store.ts'
import { applyPendingCommands } from '../../supervisor/src/app/apply-commands.ts'
import { acquireSupervisor } from '../../supervisor/src/app/supervisor-lease.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'm6-commands-')); dirs.push(dir)
  const db = openStore(join(dir, 'state.sqlite'))
  db.exec("INSERT INTO projects VALUES ('p1','Project','2026-01-01'); INSERT INTO project_config VALUES ('p1','/repo','main','2026-01-01')")
  return { dir, db }
}
function cli(dir: string, action: string, ...args: string[]) {
  return spawnSync(process.execPath, [join(process.cwd(), 'supervisor/src/cli/main.ts'), 'github', action, '--state-dir', dir, ...args], { encoding: 'utf8', timeout: 15000 })
}
function seed(db: DatabaseSync, id: string, status = 'pending', project = 'p1', scope = '["src"]') {
  const basis = JSON.stringify({ policyVersion: 1, policyHash: 'a'.repeat(64), actorId: 7, repo: 'owner/repo', issue: 42, eventId: id, kind: 'issue.opened' })
  db.prepare(`INSERT INTO github_events (event_id,project_id,repo,kind,actor_id,actor_login,issue,status,reason,title,scope_json,basis_json,text,text_trust,text_sha256,event_at,received_at) VALUES (?,?,'owner/repo','issue.opened',7,'alice',42,?,?,?,?,?,'body','untrusted',?,'2026-01-01','2026-01-01')`)
    .run(id, project, status, status === 'ignored' ? 'ignored' : null, status === 'ignored' ? null : 'Fix login', status === 'ignored' ? null : scope, status === 'ignored' ? null : basis, 'a'.repeat(64))
}
function apply(db: DatabaseSync, dir: string) {
  const handle = acquireSupervisor(db, dir, { nowMs: Date.now(), staleAfterMs: 300000 })
  try { applyPendingCommands(db, handle) } finally { handle.release(Date.now()) }
}
function command(dir: string, action: string, event: string, id = randomUUID(), extra: string[] = []) {
  const result = cli(dir, action, '--event', event, '--command-id', id, ...extra)
  expect(result.status).toBe(0)
  return id
}
function outcome(db: DatabaseSync, id: string) { return db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get(id) }
function snapshot(db: DatabaseSync) { return { events: db.prepare('SELECT * FROM github_events').all(), tasks: db.prepare('SELECT * FROM tasks').all(), deps: db.prepare('SELECT * FROM task_deps').all() } }

it('CHK-M6-04-a: approval creates the task and event link, rejection sanitizes the reason', () => {
  const { db, dir } = setup()
  try {
    db.exec("INSERT INTO phases (project_id,name,ord,status) VALUES ('p1','development',2,'open')")
    seed(db, '123'); seed(db, '124')
    const id = command(dir, 'approve', '123')
    const reject = command(dir, 'reject', '124', randomUUID(), ['--reason', '  hello\u0001   world \u202e' + '😀'.repeat(210)])
    expect(JSON.parse((db.prepare('SELECT payload_json FROM commands WHERE id=?').get(id) as {payload_json:string}).payload_json)).toEqual({ eventId: '123' })
    expect(db.prepare('SELECT kind FROM commands WHERE id=?').get(id)).toEqual({ kind: 'github.approve' })
    expect(db.prepare('SELECT kind FROM commands WHERE id=?').get(reject)).toEqual({ kind: 'github.reject' })
    expect(JSON.parse((db.prepare('SELECT payload_json FROM commands WHERE id=?').get(reject) as {payload_json:string}).payload_json)).toEqual({ eventId: '124', reason: '  hello\u0001   world \u202e' + '😀'.repeat(210) })
    apply(db, dir)
    expect(outcome(db, id)).toEqual({ outcome: 'applied', reason: null })
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Record<string, unknown>
    expect(task).toMatchObject({ id, project_id: 'p1', created_by_command: id, title: 'Fix login', scope_json: '["src"]', phase: 'development', status: 'ready' })
    expect(task).not.toHaveProperty('source')
    expect(db.prepare('SELECT * FROM task_deps WHERE task_id=?').all(id)).toEqual([])
    const event = db.prepare('SELECT status, task_id, decided_by_command, decided_at, repo, issue, event_id FROM github_events WHERE event_id=?').get('123') as Record<string, unknown>
    expect(event).toMatchObject({ status: 'approved', task_id: id, decided_by_command: id, repo: 'owner/repo', issue: 42, event_id: '123' })
    expect(typeof event.decided_at).toBe('string')
    expect(db.prepare('SELECT status, reason, task_id, decided_by_command FROM github_events WHERE event_id=?').get('124')).toEqual({ status: 'rejected', reason: 'hello world ' + '😀'.repeat(188), task_id: null, decided_by_command: reject })
    expect(outcome(db, reject)).toEqual({ outcome: 'applied', reason: null })
  } finally { db.close() }
})

it('CHK-M6-04-a: rejection without a reason stores and applies null', () => {
  const { db, dir } = setup()
  try {
    seed(db, '125')
    const id = command(dir, 'reject', '125')
    expect(JSON.parse((db.prepare('SELECT payload_json FROM commands WHERE id=?').get(id) as {payload_json:string}).payload_json)).toEqual({ eventId: '125', reason: null })
    apply(db, dir)
    expect(outcome(db, id)).toEqual({ outcome: 'applied', reason: null })
    expect(db.prepare('SELECT status, reason FROM github_events WHERE event_id=?').get('125')).toEqual({ status: 'rejected', reason: null })
  } finally { db.close() }
})

it('CHK-M6-04-a: a failure after task insertion rolls back the whole approval', () => {
  const { db, dir } = setup()
  try {
    seed(db, '123'); const id = command(dir, 'approve', '123')
    // An AFTER INSERT trigger aborts after SQLite inserts the task, inside the apply transaction.
    db.exec("CREATE TRIGGER fail_after_task AFTER INSERT ON tasks BEGIN SELECT RAISE(ABORT, 'injected'); END")
    expect(() => apply(db, dir)).toThrow()
    expect(db.prepare('SELECT * FROM tasks').all()).toEqual([])
    expect(outcome(db, id)).toBeUndefined()
    expect(db.prepare('SELECT status, task_id, decided_at, decided_by_command FROM github_events WHERE event_id=?').get('123')).toEqual({ status: 'pending', task_id: null, decided_at: null, decided_by_command: null })
  } finally { db.close() }
})

it('CHK-M6-04-b: event validation and command idempotency', () => {
  const { db, dir } = setup()
  try {
    for (const args of [[], ['--event',''], ['--event','x'], ['--event','1'.repeat(21)], ['--event','1','--event','2']]) {
      const res = cli(dir, 'approve', ...args)
      expect(res.status).toBe(2); expect(res.stderr + res.stdout).toMatch(/[\u0600-\u06ff]/)
      expect(db.prepare('SELECT * FROM commands').all()).toEqual([])
    }
    const boundary = '12345678901234567890'
    const boundaryId = command(dir, 'approve', boundary)
    expect(JSON.parse((db.prepare('SELECT payload_json FROM commands WHERE id=?').get(boundaryId) as {payload_json:string}).payload_json)).toEqual({ eventId: boundary })
    const id = randomUUID()
    expect(cli(dir, 'approve', '--event', '123', '--command-id', id).status).toBe(0)
    const duplicate = cli(dir, 'approve', '--event', '123', '--command-id', id)
    expect(duplicate.status).toBe(0); expect(duplicate.stdout).toMatch(/\bduplicate\b/)
    expect(cli(dir, 'approve', '--event', '124', '--command-id', id).status).toBe(1)
    expect(db.prepare('SELECT id FROM commands WHERE id=?').all(id)).toEqual([{ id }])
    expect(db.prepare('SELECT count(*) AS count FROM commands').get()).toEqual({ count: 2 })
  } finally { db.close() }
})

it('CHK-M6-04-c: unknown, foreign, and decided events cannot be decided again', () => {
  const { db, dir } = setup()
  try {
    db.exec("INSERT INTO projects VALUES ('p2','Other','2026-01-01')")
    seed(db, '2', 'pending', 'p2'); seed(db, '3', 'ignored'); seed(db, '4', 'approved'); seed(db, '5', 'rejected'); seed(db, '6')
    for (const [event, reason] of [['1','unknown event'],['2','unknown event'],['3','event is not pending'],['4','event is not pending'],['5','event is not pending']]) {
      const before = snapshot(db); const id = command(dir, 'approve', event!)
      apply(db, dir); expect(outcome(db, id)).toEqual({ outcome: 'rejected', reason }); expect(snapshot(db)).toEqual(before)
    }
    const first = command(dir, 'approve', '6'); apply(db, dir); expect(outcome(db, first)).toEqual({ outcome: 'applied', reason: null })
    for (const action of ['approve', 'reject']) {
      const before = snapshot(db); const id = command(dir, action, '6'); apply(db, dir)
      expect(outcome(db, id)).toEqual({ outcome: 'rejected', reason: 'event is not pending' }); expect(snapshot(db)).toEqual(before)
    }
  } finally { db.close() }
})

it('CHK-M6-04-d: phase-less projects use the default; completed phases reject', () => {
  const { db, dir } = setup()
  try {
    seed(db, '1'); const first = command(dir, 'approve', '1'); apply(db, dir)
    expect(outcome(db, first)).toEqual({ outcome: 'applied', reason: null })
    expect(db.prepare('SELECT phase FROM tasks WHERE id=?').get(first)).toEqual({ phase: 'intake' })
    db.exec("INSERT INTO phases (project_id,name,ord,status) VALUES ('p1','handover',5,'done')")
    seed(db, '2'); const second = command(dir, 'approve', '2'); apply(db, dir)
    expect(outcome(db, second)).toEqual({ outcome: 'rejected', reason: 'phase is not available' })
    expect(db.prepare('SELECT status,task_id FROM github_events WHERE event_id=?').get('2')).toEqual({ status: 'pending', task_id: null })
    expect(db.prepare('SELECT id FROM tasks WHERE id=?').get(second)).toBeUndefined()
  } finally { db.close() }
})

it('CHK-M6-04-f: invalid stored scope rejects through the task apply path', () => {
  const { db, dir } = setup()
  try {
    seed(db, '1', 'pending', 'p1', '["../escape"]')
    const id = command(dir, 'approve', '1'); apply(db, dir)
    expect(outcome(db, id)).toEqual({ outcome: 'rejected', reason: 'invalid command or payload' })
    expect(db.prepare('SELECT id FROM tasks WHERE id=?').get(id)).toBeUndefined()
    expect(db.prepare('SELECT status,task_id,decided_at,decided_by_command FROM github_events WHERE event_id=?').get('1')).toEqual({ status: 'pending', task_id: null, decided_at: null, decided_by_command: null })
  } finally { db.close() }
})
