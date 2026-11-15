import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { openStore } from '../../supervisor/src/app/store.ts'
import { budgetUsage } from '../../supervisor/src/app/quota.ts'
import { formatStatus, readStatus, type Status } from '../../supervisor/src/app/status.ts'

type Additions = { limits: null | { maxParallel: number; running: number; waitingSlots: number }; quota: null | { windows: Array<{ provider: string; windowMs: number; maxUnits: number; used: number; resetsAt: string | null }> }; budget: null | { caps: Array<{ level: string; key: string; cap: number; used: number; pct: number; state: string; source: string }> }; dispatch: string }
const dirs: string[] = []
const nowMs = 100000
const options = { nowMs, staleAfterMs: 500 }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'factory-m7-status-')); dirs.push(dir)
  const db = openStore(join(dir, 'state.sqlite'))
  db.prepare("INSERT INTO projects (id,name,created_at) VALUES ('p','Project','now')").run()
  db.prepare("INSERT INTO project_config (project_id,repo_path,base_ref,created_at) VALUES ('p',?,'main','now')").run(dir)
  const phase = db.prepare('INSERT INTO phases (project_id,name,ord,status,opened_at) VALUES (?,?,?,?,?)')
  ;['intake','development','qa','devops','handover'].forEach((name, i) => phase.run('p', name, i + 1, i === 0 ? 'open' : 'locked', i === 0 ? 'now' : null))
  return { dir, db }
}
function task(db: DatabaseSync, id: string, status = 'ready', provider = 'default', phase = 'intake') {
  db.prepare("INSERT INTO commands (id,project_id,kind,payload_json,created_at) VALUES (?,'p','task.create','{}','now')").run(`c-${id}`)
  db.prepare("INSERT INTO tasks (id,project_id,created_by_command,title,status,created_at,updated_at,scope_json,phase,provider) VALUES (?,'p',?,? ,?,'now','now',?,?,?)").run(id, `c-${id}`, id, status, JSON.stringify([id]), phase, provider)
}
function reservation(db: DatabaseSync, n: number, taskId: string, provider: string, state: string, time: number) {
  db.prepare("INSERT INTO attempts (id,task_id,attempt_no,status,lease_generation) VALUES (?,?,?,'pending',1)").run(`a${n}`, taskId, n + 1)
  db.prepare("INSERT INTO quota_reservations (id,project_id,attempt_id,provider,units,state,reserved_at_ms) VALUES (?,'p',?,?,1,?,?)").run(`r${n}`, `a${n}`, provider, state, time)
}
function snapshot(dir: string): Status & Additions { return readStatus(dir, options) as Status & Additions }
function dump(db: DatabaseSync) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>
  return JSON.stringify(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]))
}

it('CHK-M7-07-a: empty tables expose null additions and open dispatch', () => {
  const { dir, db } = fixture()
  try { expect(snapshot(dir)).toMatchObject({ limits: null, quota: null, budget: null, dispatch: 'open' }) } finally { db.close() }
})

it('CHK-M7-07-a: exact additions, window boundary, ordered caps and read-only snapshot', () => {
  const { dir, db } = fixture()
  try {
    task(db, 'running', 'progress', 'alpha'); task(db, 'waiting'); task(db, 'old', 'done', 'alpha'); task(db, 'released', 'done', 'alpha')
    reservation(db, 1, 'running', 'alpha', 'reserved', 99000)
    reservation(db, 2, 'old', 'alpha', 'settled', 90000)
    reservation(db, 3, 'released', 'alpha', 'released', 99500)
    db.exec("INSERT INTO project_limits VALUES ('p',1,'now'); INSERT INTO quota_windows VALUES ('p','zeta',10000,10,'now'),('p','alpha',10000,10,'now'); INSERT INTO budget_caps VALUES ('p','task','running',10,'now'),('p','phase','intake',20,'now'),('p','project','',30,'now')")
    const before = dump(db); const status = snapshot(dir)
    expect(status.limits).toEqual({ maxParallel: 1, running: 1, waitingSlots: 1 })
    expect(status.quota).toEqual({ windows: [{ provider: 'alpha', windowMs: 10000, maxUnits: 10, used: 1, resetsAt: new Date(109000).toISOString() }, { provider: 'zeta', windowMs: 10000, maxUnits: 10, used: 0, resetsAt: null }] })
    expect(status.budget).toEqual({ caps: budgetUsage(db, 'p').map(row => ({ ...row, source: 'counted' })) })
    expect(status.tasks?.find(t => t.id === 'waiting')?.waiting).toEqual({ reason: 'slots', on: ['running'] })
    expect(status.dispatch).toBe('open'); expect(dump(db)).toBe(before)
  } finally { db.close() }
})

it('CHK-M7-07-a: quota and budget waits set dispatch with budget precedence', () => {
  const { dir, db } = fixture()
  try {
    task(db, 'used-q', 'done', 'q'); task(db, 'used-b', 'done', 'b'); task(db, 'quota', 'ready', 'q'); task(db, 'budget', 'ready', 'b')
    reservation(db, 1, 'used-q', 'q', 'settled', 99000); reservation(db, 2, 'used-b', 'b', 'settled', 99000)
    db.exec("INSERT INTO quota_windows VALUES ('p','q',10000,1,'now'); INSERT INTO budget_caps VALUES ('p','task','budget',1,'now')")
    // The task cap must be consumed by the same task.
    reservation(db, 3, 'budget', 'b', 'settled', 99000)
    let status = snapshot(dir)
    expect(status.tasks?.find(t => t.id === 'quota')?.waiting).toEqual({ reason: 'quota', on: [] })
    expect(status.tasks?.find(t => t.id === 'budget')?.waiting).toEqual({ reason: 'budget', on: [] })
    expect(status.dispatch).toBe('paused-budget')
    db.exec("DELETE FROM budget_caps WHERE level='task'")
    status = snapshot(dir); expect(status.dispatch).toBe('waiting-quota')
    db.exec("DELETE FROM quota_windows WHERE provider='q'")
    expect(snapshot(dir).dispatch).toBe('open')
  } finally { db.close() }
})

it('CHK-M7-07-b: real usage crosses every threshold and a lowered cap exceeds 100 percent', () => {
  const { dir, db } = fixture()
  try {
    task(db, 'used', 'done'); db.exec("INSERT INTO budget_caps VALUES ('p','project','',100,'now'); INSERT INTO quota_windows VALUES ('p','default',10000,200,'now')")
    const boundaries = new Map([[69,'ok'],[70,'warn'],[89,'warn'],[90,'fallback-needed'],[99,'fallback-needed'],[100,'stop']])
    for (let n = 1; n <= 100; n++) {
      reservation(db, n, 'used', 'default', n % 2 ? 'reserved' : 'settled', 99000 + n)
      const state = boundaries.get(n)
      if (state) {
        const status = snapshot(dir)
        expect(status.budget?.caps).toEqual([{ level: 'project', key: '', cap: 100, used: n, pct: n, state, source: 'counted' }])
        expect(status.quota?.windows[0]?.resetsAt).toBe(new Date(109001).toISOString())
      }
    }
    db.exec("UPDATE budget_caps SET cap_units=50 WHERE level='project'")
    expect(snapshot(dir).budget?.caps[0]).toEqual({ level: 'project', key: '', cap: 50, used: 100, pct: 200, state: 'stop', source: 'counted' })
  } finally { db.close() }
})

it.each([
  ['budget level', "INSERT INTO budget_caps VALUES ('p','bad','',1,'now')"],
  ['negative cap', "INSERT INTO budget_caps VALUES ('p','project','',-1,'now')"],
  ['zero max', "INSERT INTO quota_windows VALUES ('p','x',1000,0,'now')"],
  ['fractional max', "INSERT INTO quota_windows VALUES ('p','x',1000,1.5,'now')"],
  ['zero window', "INSERT INTO quota_windows VALUES ('p','x',0,1,'now')"],
  ['fractional window', "INSERT INTO quota_windows VALUES ('p','x',1000.5,1,'now')"],
  ['zero parallel', "INSERT INTO project_limits VALUES ('p',0,'now')"],
  ['reservation state', "INSERT INTO quota_reservations VALUES ('bad','p','a1','default',1,'bad',99000,NULL)"],
])('CHK-M7-07-b: malformed %s is rejected', (_name, sql) => {
  const { dir, db } = fixture()
  try {
    task(db, 'used', 'done'); db.prepare("INSERT INTO attempts (id,task_id,attempt_no,status,lease_generation) VALUES ('a1','used',1,'pending',1)").run()
    db.exec('PRAGMA ignore_check_constraints = ON'); db.exec(sql)
    expect(() => snapshot(dir)).toThrow()
  } finally { db.close() }
})

it('CHK-M7-07-c: Arabic output presents facts without remaining or token wording', () => {
  const { dir, db } = fixture()
  try {
    task(db, 'used', 'done'); reservation(db, 1, 'used', 'default', 'settled', 99000)
    db.exec("INSERT INTO project_limits VALUES ('p',3,'now'); INSERT INTO quota_windows VALUES ('p','default',10000,7,'now'); INSERT INTO budget_caps VALUES ('p','project','',4,'now')")
    const status = snapshot(dir); const text = formatStatus(status); const json = JSON.stringify(status)
    for (const fact of ['4', '7', '1', '25', new Date(109000).toISOString()]) expect(text).toContain(fact)
    expect(text).toMatch(/\u0645\u0641\u062a\u0648\u062d/)
    for (const word of ['\u0645\u062a\u0628\u0642', '\u0627\u0644\u0645\u062a\u0628\u0642\u064a', '\u0631\u0645\u0648\u0632', '\u062a\u0648\u0643\u0646']) expect(text).not.toContain(word)
    for (const key of ['limits', 'quota', 'budget']) { expect(json).toContain(`"${key}"`); expect(text).not.toContain(key) }
  } finally { db.close() }
})
