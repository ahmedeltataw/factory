import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { appendCommand } from '../../supervisor/src/app/commands.ts'
import { applyPendingCommands } from '../../supervisor/src/app/apply-commands.ts'
import { acquireSupervisor } from '../../supervisor/src/app/supervisor-lease.ts'
import { enqueue, runDue } from '../../supervisor/src/app/outbox.ts'
import { formatStatus, readStatus, type Status } from '../../supervisor/src/app/status.ts'
import { openStore } from '../../supervisor/src/app/store.ts'

const ASCII_WHITESPACE = 'char(32, 9, 10, 13, 12, 11)'

const V7_DDL = [
  'CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL)',
  'CREATE INDEX projects_name_idx ON projects(name)',
  `CREATE TABLE commands (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id, ${ASCII_WHITESPACE})) > 0),
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT CHECK (length(trim(project_id, ${ASCII_WHITESPACE})) > 0),
    kind TEXT NOT NULL CHECK (length(trim(kind, ${ASCII_WHITESPACE})) > 0),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL
  )`,
  `CREATE TRIGGER commands_no_update BEFORE UPDATE ON commands BEGIN SELECT RAISE(ABORT, 'commands are append-only'); END`,
  `CREATE TRIGGER commands_no_delete BEFORE DELETE ON commands BEGIN SELECT RAISE(ABORT, 'commands are append-only'); END`,
  `CREATE TRIGGER commands_no_replace BEFORE INSERT ON commands WHEN EXISTS (SELECT 1 FROM commands WHERE id = NEW.id) BEGIN SELECT RAISE(IGNORE); END`,
  `CREATE TABLE supervisor_lease (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    owner_id TEXT NOT NULL CHECK (length(trim(owner_id, ${ASCII_WHITESPACE})) > 0),
    generation INTEGER NOT NULL CHECK (generation > 0),
    heartbeat_ms INTEGER NOT NULL CHECK (heartbeat_ms >= 0),
    status TEXT NOT NULL CHECK (status IN ('active', 'released'))
  )`,
  `CREATE TABLE project_config (project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id), repo_path TEXT NOT NULL, base_ref TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE command_outcomes (command_id TEXT PRIMARY KEY NOT NULL REFERENCES commands(id), outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'rejected')), reason TEXT, lease_generation INTEGER NOT NULL, applied_at TEXT NOT NULL)`,
  `CREATE TABLE tasks (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id),
    created_by_command TEXT NOT NULL UNIQUE REFERENCES commands(id),
    title TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped', 'done')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    scope_json TEXT NOT NULL DEFAULT '["."]' CHECK (json_valid(scope_json)),
    max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
    timeout_ms INTEGER CHECK (timeout_ms IS NULL OR timeout_ms BETWEEN 1000 AND 86400000),
    attempt_base INTEGER NOT NULL DEFAULT 0 CHECK (attempt_base >= 0),
    not_before_ms INTEGER NOT NULL DEFAULT 0 CHECK (not_before_ms >= 0)
  )`,
  `CREATE TABLE attempts (
    id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    attempt_no INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'interrupted', 'killed')),
    exit_code INTEGER,
    error_class TEXT,
    lease_generation INTEGER NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    deadline_ms INTEGER CHECK (deadline_ms IS NULL OR deadline_ms >= 0),
    UNIQUE(task_id, attempt_no)
  )`,
  `CREATE UNIQUE INDEX attempts_one_live_per_task ON attempts(task_id) WHERE status IN ('pending', 'running')`,
  `CREATE TABLE workers (attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES attempts(id), nonce TEXT NOT NULL UNIQUE, pid INTEGER, state TEXT NOT NULL CHECK (state IN ('starting', 'running', 'exited', 'killed', 'lost')), worktree_path TEXT NOT NULL, heartbeat_ms INTEGER, started_at TEXT, ended_at TEXT)`,
  `CREATE TABLE outbox (id TEXT PRIMARY KEY NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')), tries INTEGER NOT NULL, next_attempt_ms INTEGER NOT NULL, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE evidence (attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES attempts(id), base_sha TEXT NOT NULL, head_sha TEXT NOT NULL, files_json TEXT NOT NULL, stdout_sha256 TEXT NOT NULL, stderr_sha256 TEXT NOT NULL, recorded_at TEXT NOT NULL)`,
  `CREATE TRIGGER command_outcomes_no_update BEFORE UPDATE ON command_outcomes BEGIN SELECT RAISE(ABORT, 'command_outcomes are append-only'); END`,
  `CREATE TRIGGER command_outcomes_no_delete BEFORE DELETE ON command_outcomes BEGIN SELECT RAISE(ABORT, 'command_outcomes are append-only'); END`,
  `CREATE TRIGGER evidence_no_update BEFORE UPDATE ON evidence BEGIN SELECT RAISE(ABORT, 'evidence is immutable'); END`,
  `CREATE TRIGGER evidence_no_delete BEFORE DELETE ON evidence BEGIN SELECT RAISE(ABORT, 'evidence is immutable'); END`,

    `CREATE TABLE phases (project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL CHECK (name IN ('intake','development','qa','devops','handover')), ord INTEGER NOT NULL CHECK (ord BETWEEN 1 AND 5), status TEXT NOT NULL CHECK (status IN ('locked','open','done')), opened_at TEXT, closed_at TEXT, PRIMARY KEY (project_id, name), UNIQUE (project_id, ord), CHECK (ord = CASE name WHEN 'intake' THEN 1 WHEN 'development' THEN 2 WHEN 'qa' THEN 3 WHEN 'devops' THEN 4 WHEN 'handover' THEN 5 END))`,
    `CREATE UNIQUE INDEX phases_one_open ON phases(project_id) WHERE status = 'open'`,
    `CREATE TRIGGER phases_no_delete BEFORE DELETE ON phases BEGIN SELECT RAISE(ABORT, 'phases are permanent'); END`,
    `ALTER TABLE tasks ADD COLUMN phase TEXT NOT NULL DEFAULT 'intake' CHECK (phase IN ('intake','development','qa','devops','handover'))`,
    `CREATE TABLE task_deps (task_id TEXT NOT NULL REFERENCES tasks(id), depends_on TEXT NOT NULL REFERENCES tasks(id), PRIMARY KEY (task_id, depends_on), CHECK (task_id <> depends_on))`,
    `CREATE TRIGGER task_deps_no_update BEFORE UPDATE ON task_deps BEGIN SELECT RAISE(ABORT, 'task_deps are immutable'); END`,
    `CREATE TRIGGER task_deps_no_delete BEFORE DELETE ON task_deps BEGIN SELECT RAISE(ABORT, 'task_deps are immutable'); END`,
  `PRAGMA user_version = 7`,
]


const directories: string[] = []
function databaseDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-m6-schema-'))
  directories.push(dir)
  return dir
}
function databasePath(): string { return join(databaseDir(), 'state.sqlite') }
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function fixture(path: string): void {
  const db = new DatabaseSync(path)
  try {
    for (const sql of V7_DDL) db.exec(sql)
    db.exec(`
      INSERT INTO projects (id,name,created_at) VALUES ('p','Project','now');
      INSERT INTO project_config (project_id,repo_path,base_ref,created_at) VALUES ('p','/repo','main','now');
      INSERT INTO commands (id,project_id,kind,payload_json,created_at) VALUES ('c1','p','task.create','{}','now'),('c2','p','task.create','{}','now');
      INSERT INTO command_outcomes (command_id,outcome,reason,lease_generation,applied_at) VALUES ('c1','applied',NULL,1,'now');
      INSERT INTO phases (project_id,name,ord,status,opened_at,closed_at) VALUES ('p','intake',1,'open','now',NULL);
      INSERT INTO tasks (id,project_id,created_by_command,title,status,created_at,updated_at,scope_json,max_attempts,timeout_ms,attempt_base,not_before_ms,phase) VALUES ('t1','p','c1','First','ready','now','now','["src"]',3,NULL,0,0,'intake'),('t2','p','c2','Second','ready','now','now','["test"]',3,NULL,0,0,'intake');
      INSERT INTO task_deps (task_id,depends_on) VALUES ('t2','t1');
      INSERT INTO attempts (id,task_id,attempt_no,status,exit_code,error_class,lease_generation,started_at,ended_at,deadline_ms) VALUES ('a','t1',1,'running',NULL,NULL,1,'now',NULL,NULL);
      INSERT INTO workers (attempt_id,nonce,pid,state,worktree_path,heartbeat_ms,started_at,ended_at) VALUES ('a','nonce',123,'running','/work',42,'now',NULL);
      INSERT INTO outbox (id,idempotency_key,kind,payload_json,status,tries,next_attempt_ms,last_error,created_at,updated_at) VALUES ('o','key','test','{}','pending',0,0,NULL,'now','now');
      INSERT INTO evidence (attempt_id,base_sha,head_sha,files_json,stdout_sha256,stderr_sha256,recorded_at) VALUES ('a','base','head','[]','out','err','now');
    `)
  } finally { db.close() }
}
const oldTables = ['projects','project_config','commands','command_outcomes','supervisor_lease','phases','tasks','task_deps','attempts','workers','outbox','evidence']
function snapshot(db: DatabaseSync) { return Object.fromEntries(oldTables.map(name => [name, db.prepare(`SELECT * FROM ${name}`).all()])) }

it('CHK-M6-02-a: fresh and v7 databases upgrade without data loss and preserve constraints', () => {
  const fresh = openStore(databasePath())
  try { expect(fresh.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 }) } finally { fresh.close() }
  const path = databasePath(); fixture(path)
  const before = new DatabaseSync(path); const rows = snapshot(before); before.close()
  for (let pass = 0; pass < 2; pass++) {
    const db = openStore(path)
    try {
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 })
      expect(snapshot(db)).toEqual(rows)
      expect(db.prepare('SELECT * FROM github_events').all()).toEqual([])
      expect(db.prepare('SELECT * FROM github_cursor').all()).toEqual([])
      expect(() => db.exec("UPDATE commands SET kind='x' WHERE id='c1'")).toThrow()
      expect(() => db.exec("DELETE FROM command_outcomes WHERE command_id='c1'")).toThrow()
      expect(() => db.exec("UPDATE evidence SET head_sha='x' WHERE attempt_id='a'")).toThrow()
      expect(() => db.exec("DELETE FROM phases WHERE project_id='p'")).toThrow()
      expect(() => db.exec("DELETE FROM task_deps WHERE task_id='t2'")).toThrow()
      expect(() => db.exec("INSERT INTO phases (project_id,name,ord,status) VALUES ('p','development',2,'open')")).toThrow()
      expect(() => db.exec("INSERT INTO attempts (id,task_id,attempt_no,status,lease_generation) VALUES ('a2','t1',2,'pending',1)")).toThrow()
    } finally { db.close() }
  }
})

it('CHK-M6-02-b: migration failure rolls back and future version is refused unchanged', () => {
  const path = databasePath(); fixture(path)
  const original = DatabaseSync.prototype.exec
  const prepare = DatabaseSync.prototype.prepare
  let statements = 0; let injected = false
  DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
    const version = this.isTransaction ? (prepare.call(this, 'PRAGMA user_version').get() as { user_version: number }).user_version : 0
    if (!injected && version === 7 && !/^\s*(?:BEGIN|COMMIT|ROLLBACK|PRAGMA)\b/i.test(sql)) {
      if (statements === 1) { injected = true; throw new Error('injected migration-8 failure') }
      const result = original.call(this, sql); statements++; return result
    }
    return original.call(this, sql)
  }
  let opened: DatabaseSync | undefined
  try { expect(() => { opened = openStore(path) }).toThrow('injected migration-8 failure') }
  finally { opened?.close(); DatabaseSync.prototype.exec = original }
  expect(injected).toBe(true); expect(statements).toBe(1)
  const check = new DatabaseSync(path)
  try {
    expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: 7 })
    expect(check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('github_events','github_cursor')").all()).toEqual([])
  } finally { check.close() }
  const futurePath = databasePath(); const future = new DatabaseSync(futurePath)
  future.exec("CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES ('preserved'); PRAGMA user_version = 9"); future.close()
  const hash = () => createHash('sha256').update(readFileSync(futurePath)).digest('hex')
  const before = hash()
  let futureOpened: DatabaseSync | undefined
  try { expect(() => { futureOpened = openStore(futurePath) }).toThrow() } finally { futureOpened?.close() }
  expect(hash()).toBe(before)
  const probe = new DatabaseSync(futurePath)
  try { expect(probe.prepare('PRAGMA user_version').get()).toEqual({ user_version: 9 }); expect(probe.prepare('SELECT * FROM future_data').all()).toEqual([{ value: 'preserved' }]) } finally { probe.close() }
})

it('CHK-M6-02-c: event and cursor constraints and transitions', () => {
  const db = openStore(databasePath())
  try {
    db.exec("INSERT INTO projects (id,name,created_at) VALUES ('p','Project','now'),('p2','Other','now'); INSERT INTO commands (id,project_id,kind,payload_json,created_at) VALUES ('cmd','p','task.create','{}','now'); INSERT INTO tasks (id,project_id,created_by_command,title,status,created_at,updated_at) VALUES ('task','p','cmd','Task','ready','now','now')")
    const insert = db.prepare(`INSERT INTO github_events (event_id,project_id,repo,kind,actor_id,actor_login,issue,status,reason,title,scope_json,basis_json,text,text_trust,text_sha256,event_at,received_at) VALUES (?, 'p', 'owner/repo', ?, 1, 'actor', 1, ?, NULL, ?, ?, '{}', 'text', ?, 'hash', 'now', 'now')`)
    const add = (id: string, kind = 'issue.opened', status = 'pending', title: string | null = 'Title', scope: string | null = '["src"]', trust = 'untrusted') => insert.run(id, kind, status, title, scope, trust)
    expect(() => add('bad-kind','bad')).toThrow()
    expect(() => add('bad-status','issue.opened','bad')).toThrow()
    expect(() => add('bad-trust','issue.opened','pending','Title','[]','trusted')).toThrow()
    expect(() => add('missing-title','issue.opened','pending',null)).toThrow()
    expect(() => add('empty-title','issue.opened','pending','')).toThrow()
    expect(() => add('missing-scope','issue.opened','pending','Title',null)).toThrow()
    expect(() => add('empty-scope','issue.opened','pending','Title','')).toThrow()
    add('1'); add('2'); add('3'); add('4')
    db.exec("INSERT INTO github_events (event_id,project_id,repo,kind,actor_id,actor_login,issue,status,reason,title,scope_json,basis_json,text,text_trust,text_sha256,event_at,received_at) VALUES ('ignored','p','owner/repo','issue.opened',1,'actor',1,'ignored','not allowed',NULL,NULL,NULL,'text','untrusted','hash','now','now')")
    expect(db.prepare("SELECT status,reason,title,scope_json FROM github_events WHERE project_id='p' AND event_id='ignored'").get()).toEqual({status:'ignored',reason:'not allowed',title:null,scope_json:null})
    expect(() => db.exec("UPDATE github_events SET reason='changed' WHERE project_id='p' AND event_id='ignored'")).toThrow()
    const immutableAssignments = ["repo='other/repo'", "kind='issue.comment'", 'actor_id=2', "actor_login='other'", 'issue=2', "text='other'", "text_trust='trusted'", "text_sha256='other'", "event_at='later'", "received_at='later'", "title='other'", "scope_json='[\"other\"]'", "basis_json='{\"other\":true}'"]
    for (const assignment of immutableAssignments) {
      expect(() => db.exec(`UPDATE github_events SET status='rejected', reason='declined', decided_at='now', decided_by_command='cmd', ${assignment} WHERE project_id='p' AND event_id='3'`)).toThrow()
    }
    db.exec("UPDATE github_events SET status='rejected', reason='declined', decided_at='now', decided_by_command='cmd' WHERE project_id='p' AND event_id='3'")
    expect(db.prepare("SELECT status,reason,decided_at,decided_by_command FROM github_events WHERE project_id='p' AND event_id='3'").get()).toEqual({status:'rejected',reason:'declined',decided_at:'now',decided_by_command:'cmd'})
    expect(() => add('1')).toThrow()
    expect(() => db.exec("DELETE FROM github_events WHERE event_id='1'")).toThrow()
    expect(() => db.exec("UPDATE github_events SET status='ignored' WHERE event_id='1'")).toThrow()
    expect(() => db.exec("UPDATE github_events SET status='approved' WHERE event_id='1'")).toThrow()
    expect(() => db.exec("UPDATE github_events SET status='rejected', text='changed' WHERE event_id='1'")).toThrow()
    expect(() => db.exec("UPDATE github_events SET status='rejected', title='changed' WHERE event_id='1'")).toThrow()
    expect(() => db.exec("UPDATE github_events SET reason='changed' WHERE event_id='1'")).toThrow()
    for (const column of ['scope_json', 'basis_json', 'event_id']) expect(() => db.exec(`UPDATE github_events SET status='rejected', ${column}='changed' WHERE event_id='1'`)).toThrow()
    db.exec("UPDATE github_events SET status='approved', task_id='task', decided_at='now', decided_by_command='cmd' WHERE event_id='1'")
    db.exec("UPDATE github_events SET status='rejected', reason='declined', decided_at='now', decided_by_command='cmd' WHERE event_id='2'")
    expect(db.prepare("SELECT status,task_id FROM github_events WHERE event_id IN ('1','2') ORDER BY event_id").all()).toEqual([{status:'approved',task_id:'task'},{status:'rejected',task_id:null}])
    expect(db.prepare("SELECT reason FROM github_events WHERE event_id='2'").get()).toEqual({reason:'declined'})
    for (const id of ['1', '2']) for (const assignment of ["status='pending'", "reason='changed'", "text='changed'", "title='changed'", "scope_json='changed'", "basis_json='changed'", "event_id='changed'", "project_id='p2'", "repo='changed'", "kind='issue.comment'", "actor_id=2", "actor_login='changed'", "issue=2", "text_trust='untrusted'", "text_sha256='changed'", "event_at='changed'", "received_at='changed'", "decided_at='changed'", "decided_by_command=NULL", id === '1' ? "task_id=NULL" : "task_id='task'"]) expect(() => db.exec(`UPDATE github_events SET ${assignment} WHERE event_id='${id}'`)).toThrow()
    db.exec("INSERT INTO github_events (event_id,project_id,repo,kind,actor_id,actor_login,issue,status,reason,title,scope_json,basis_json,text,text_trust,text_sha256,event_at,received_at) VALUES ('1','p2','owner/repo','issue.opened',1,'actor',1,'pending',NULL,'Title','[]','{}','text','untrusted','hash','now','now')")
    expect(db.prepare("SELECT project_id FROM github_events WHERE event_id='1' ORDER BY project_id").all()).toEqual([{project_id:'p'},{project_id:'p2'}])
    expect(() => db.exec("INSERT INTO github_cursor (project_id,repo,next_poll_ms,updated_at) VALUES ('missing','owner/repo',1,'now')")).toThrow()
    db.exec("INSERT INTO github_cursor (project_id,repo,etag,next_poll_ms,error,updated_at) VALUES ('p','owner/repo',NULL,1,'problem','now')")
    expect(db.prepare("SELECT error FROM github_cursor WHERE project_id='p'").get()).toEqual({error:'problem'})
    db.exec("INSERT INTO github_cursor (project_id,repo,etag,next_poll_ms,error,updated_at) VALUES ('p','owner/repo','tag',2,NULL,'later') ON CONFLICT(project_id,repo) DO UPDATE SET etag=excluded.etag,next_poll_ms=excluded.next_poll_ms,error=excluded.error,updated_at=excluded.updated_at")
    expect(db.prepare("SELECT etag,next_poll_ms,error,updated_at FROM github_cursor WHERE project_id='p'").get()).toEqual({etag:'tag',next_poll_ms:2,error:null,updated_at:'later'})
  } finally { db.close() }
})

  it('CHK-M6-02-d: status on a v8 DB with M5-shaped data gives the M5 output with schemaVersion 8', async () => {
    const dir = databaseDir()
    const path = join(dir, 'state.sqlite')
    const db = openStore(path)
    try {
      db.prepare("INSERT INTO projects VALUES ('p1', 'Project', '2026-11-10T00:00:00.000Z')").run()
      db.prepare("INSERT INTO project_config VALUES ('p1', ?, 'main', '2026-11-10T00:00:00.000Z')").run(process.cwd())

      db.exec("INSERT INTO phases (project_id,name,ord,status,opened_at,closed_at) VALUES ('p1','intake',1,'open','2026-11-10T00:00:00.000Z',NULL), ('p1','development',2,'locked',NULL,NULL), ('p1','qa',3,'locked',NULL,NULL), ('p1','devops',4,'locked',NULL,NULL), ('p1','handover',5,'locked',NULL,NULL)")

      const handle = acquireSupervisor(db, dir, { nowMs: 1000, staleAfterMs: 500 })
      try {
        const add = (id: string, kind: string, payload: unknown) =>
          appendCommand(db, { id, projectId: 'p1', kind, payloadJson: JSON.stringify(payload), createdAt: '2026-11-10T00:00:00.000Z' })

        add('task-one', 'task.create', { title: 'Example task' })
        add('bad-command', 'task.kill', { taskId: 'missing' })
        add('bad-command-2', 'task.kill', { taskId: 'missing' })
        applyPendingCommands(db, handle)
        add('pending-2', 'task.create', { title: 'pending' })
        add('pending-3', 'task.create', { title: 'pending' })
        add('pending-command', 'task.create', { title: 'private-payload' })

        enqueue(db, handle, { idempotencyKey: 'pending', kind: 'pending', payloadJson: '{}', nowMs: 1000 })
        enqueue(db, handle, { idempotencyKey: 'done', kind: 'done', payloadJson: '{}', nowMs: 1000 })
        for (const [id, status] of [
          ['done-2', 'done'],
          ['failed-1', 'failed'],
          ['failed-2', 'failed'],
          ['failed-3', 'failed'],
        ]) {
          db.prepare('INSERT INTO outbox VALUES (?, ?, ?, ?, ?, 0, 1000, NULL, ?, ?)').run(id!, id!, 'extra', '{}', status!, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')
        }

        await runDue(db, handle, { done: () => {} }, 1000)

        db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at) VALUES ('attempt-1', 'task-one', 1, 'succeeded', 0, NULL, 1, NULL, NULL)").run()
        db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at) VALUES ('attempt-2', 'task-one', 2, 'running', NULL, NULL, 1, NULL, NULL)").run()
        db.prepare("INSERT INTO workers VALUES ('attempt-1', 'nonce-1', 12345, 'exited', '/work', 42, NULL, NULL)").run()
        db.prepare("INSERT INTO evidence VALUES ('attempt-1', 'base', 'head-sha', '[{\"path\":\"src/a.ts\",\"sha256\":\"abc123\"}]', 'out', 'err', 'now')").run()

        const expectedStatus = {
          phases: [
            { name: 'intake', ord: 1, status: 'open', openedAt: '2026-11-10T00:00:00.000Z', closedAt: null, tasks: { ready: 1, progress: 0, blocked: 0, failed: 0, done: 0, dropped: 0 } },
            { name: 'development', ord: 2, status: 'locked', openedAt: null, closedAt: null, tasks: { ready: 0, progress: 0, blocked: 0, failed: 0, done: 0, dropped: 0 } },
            { name: 'qa', ord: 3, status: 'locked', openedAt: null, closedAt: null, tasks: { ready: 0, progress: 0, blocked: 0, failed: 0, done: 0, dropped: 0 } },
            { name: 'devops', ord: 4, status: 'locked', openedAt: null, closedAt: null, tasks: { ready: 0, progress: 0, blocked: 0, failed: 0, done: 0, dropped: 0 } },
            { name: 'handover', ord: 5, status: 'locked', openedAt: null, closedAt: null, tasks: { ready: 0, progress: 0, blocked: 0, failed: 0, done: 0, dropped: 0 } },
          ],
          schemaVersion: 8,
          recordedCommandCount: 6,
          commands: { recorded: 6, applied: 1, rejected: 2, pending: 3 },
          lease: {
            ownerId: handle.ownerId,
            generation: 1,
            heartbeatMs: 1000,
            state: 'active',
            freshness: 'stale',
            takeover: `${handle.ownerId}:1:1000`,
          },
          tasks: [
            {
              id: 'task-one',
              title: 'Example task',
              status: 'ready',
              scope: ['.'],
              maxAttempts: 3,
              timeoutMs: null,
              notBeforeMs: 0,
              blockedBy: [],
              phase: 'intake',
              dependsOn: [],
              waiting: null,
              attempts: [
                {
                  no: 1,
                  status: 'succeeded',
                  exitCode: 0,
                  errorClass: null,
                  deadlineMs: null,
                  worker: { pid: 12345, state: 'exited', heartbeatMs: 42 },
                  evidence: { headSha: 'head-sha', files: [{ path: 'src/a.ts', sha256: 'abc123' }] },
                },
                {
                  no: 2,
                  status: 'running',
                  exitCode: null,
                  errorClass: null,
                  deadlineMs: null,
                  worker: null,
                  evidence: null,
                },
              ],
            },
          ],
          outbox: { pending: 1, done: 2, failed: 3, failedRows: [{ key: 'failed-1', kind: 'extra', tries: 0, lastError: null }, { key: 'failed-2', kind: 'extra', tries: 0, lastError: null }, { key: 'failed-3', kind: 'extra', tries: 0, lastError: null }] },
          github: null,
        }

        const status = readStatus(dir, { nowMs: 2000, staleAfterMs: 500 }) as unknown as Record<string, unknown>
        expect(status).toEqual(expectedStatus)

        const arabic = formatStatus(status as unknown as Status)
        expect(arabic).toContain('إصدار المخطط: 8')
        expect(arabic).toContain('عدد الأوامر المسجلة: 6')
        expect(arabic).toContain('Example task')
        expect(arabic).toContain('task-one')
        expect(arabic).toContain('12345')
        expect(arabic).toContain('head-sha')
        expect(arabic).toContain('src/a.ts')
        expect(arabic).not.toContain('private-payload')
        expect(arabic).not.toContain('nonce-1')

        const cliPath = join(process.cwd(), 'supervisor/src/cli/main.ts')
        const cliResult = spawnSync(process.execPath, [cliPath, 'status', '--state-dir', dir, '--json'], {
          encoding: 'utf8',
          timeout: 10000,
        })
        expect(cliResult.status).toBe(0)
        const cliJson = JSON.parse(cliResult.stdout)
        expect(Object.keys(cliJson).sort()).toEqual(['commands', 'github', 'lease', 'outbox', 'phases', 'recordedCommandCount', 'schemaVersion', 'tasks'].sort())
        expect(cliJson).toEqual(expectedStatus)
        expect(cliResult.stdout).not.toContain('private-payload')
        expect(cliResult.stdout).not.toContain('nonce-1')
      } finally {
        try {
          handle.release(1000)
        } catch {
          // ignore
        }
      }
    } finally {
      db.close()
    }
  })
