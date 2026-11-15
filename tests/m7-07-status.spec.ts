import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openStore } from '../supervisor/src/app/store.ts'
import { readStatus, formatStatus, type Status } from '../supervisor/src/app/status.ts'

const dirs: string[] = []
const nowMs = 100000
const options = { nowMs, staleAfterMs: 500 }

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'factory-m7-07-test-'))
  dirs.push(dir)
  const db = openStore(join(dir, 'state.sqlite'))
  db.prepare("INSERT INTO projects (id,name,created_at) VALUES ('p','Project','now')").run()
  db.prepare("INSERT INTO project_config (project_id,repo_path,base_ref,created_at) VALUES ('p',?,'main','now')").run(dir)
  const phase = db.prepare('INSERT INTO phases (project_id,name,ord,status,opened_at) VALUES (?,?,?,?,?)')
  ;['intake', 'development', 'qa', 'devops', 'handover'].forEach((name, i) =>
    phase.run('p', name, i + 1, i === 0 ? 'open' : 'locked', i === 0 ? 'now' : null),
  )
  return { dir, db }
}

function task(db: DatabaseSync, id: string, status = 'ready', provider = 'default', phase = 'intake') {
  db.prepare("INSERT INTO commands (id,project_id,kind,payload_json,created_at) VALUES (?,'p','task.create','{}','now')").run(`c-${id}`)
  db.prepare("INSERT INTO tasks (id,project_id,created_by_command,title,status,created_at,updated_at,scope_json,phase,provider) VALUES (?,'p',?,? ,?,'now','now',?,?,?)").run(
    id,
    `c-${id}`,
    id,
    status,
    JSON.stringify([id]),
    phase,
    provider,
  )
}

function reservation(db: DatabaseSync, n: number, taskId: string, provider: string, state: string, time: number) {
  db.prepare("INSERT INTO attempts (id,task_id,attempt_no,status,lease_generation) VALUES (?,?,?,?,1)").run(`a${n}`, taskId, n + 1, 'pending')
  db.prepare("INSERT INTO quota_reservations (id,project_id,attempt_id,provider,units,state,reserved_at_ms) VALUES (?,'p',?,?,1,?,?)").run(
    `r${n}`,
    `a${n}`,
    provider,
    state,
    time,
  )
}

describe('M7-07 Status unit tests', () => {
  it('reports null limits, quota, and budget when tables are empty and dispatch is open', () => {
    const { dir, db } = fixture()
    try {
      const status = readStatus(dir, options)
      expect(status.limits).toBeNull()
      expect(status.quota).toBeNull()
      expect(status.budget).toBeNull()
      expect(status.dispatch).toBe('open')
    } finally {
      db.close()
    }
  })

  it('computes limits running and waitingSlots accurately based on slots wait', () => {
    const { dir, db } = fixture()
    try {
      task(db, 'p1', 'progress', 'default')
      task(db, 'p2', 'progress', 'default')
      task(db, 'r1', 'ready', 'default')
      task(db, 'r2', 'ready', 'default')
      db.exec("INSERT INTO project_limits VALUES ('p', 2, 'now')")

      const status = readStatus(dir, options)
      expect(status.limits).toEqual({ maxParallel: 2, running: 2, waitingSlots: 2 })
      expect(status.tasks?.find(t => t.id === 'r1')?.waiting?.reason).toBe('slots')
      expect(status.tasks?.find(t => t.id === 'r2')?.waiting?.reason).toBe('slots')
      expect(status.dispatch).toBe('open')
    } finally {
      db.close()
    }
  })

  it('orders quota windows by provider and calculates resetsAt from oldest counted reservation', () => {
    const { dir, db } = fixture()
    try {
      task(db, 't1', 'done', 'beta')
      task(db, 't2', 'done', 'beta')
      task(db, 't3', 'done', 'alpha')
      // beta: window 5000, now 100000 -> boundary 95000
      reservation(db, 1, 't1', 'beta', 'settled', 96000)
      reservation(db, 2, 't2', 'beta', 'reserved', 98000)
      // alpha: window 10000, now 100000 -> boundary 90000
      reservation(db, 3, 't3', 'alpha', 'settled', 92000)

      db.exec("INSERT INTO quota_windows VALUES ('p','beta',5000,5,'now'),('p','alpha',10000,5,'now')")

      const status = readStatus(dir, options)
      expect(status.quota).toEqual({
        windows: [
          {
            provider: 'alpha',
            windowMs: 10000,
            maxUnits: 5,
            used: 1,
            resetsAt: new Date(92000 + 10000).toISOString(),
          },
          {
            provider: 'beta',
            windowMs: 5000,
            maxUnits: 5,
            used: 2,
            resetsAt: new Date(96000 + 5000).toISOString(),
          },
        ],
      })
    } finally {
      db.close()
    }
  })

  it('maps budget caps with proper order, threshold states, and counted source', () => {
    const { dir, db } = fixture()
    try {
      task(db, 't1', 'done', 'default', 'intake')
      reservation(db, 1, 't1', 'default', 'settled', 99000)

      db.exec("INSERT INTO budget_caps VALUES ('p','task','t1',2,'now'),('p','phase','intake',2,'now'),('p','project','',1,'now')")

      const status = readStatus(dir, options)
      expect(status.budget?.caps).toEqual([
        { level: 'project', key: '', cap: 1, used: 1, pct: 100, state: 'stop', source: 'counted' },
        { level: 'phase', key: 'intake', cap: 2, used: 1, pct: 50, state: 'ok', source: 'counted' },
        { level: 'task', key: 't1', cap: 2, used: 1, pct: 50, state: 'ok', source: 'counted' },
      ])
    } finally {
      db.close()
    }
  })

  it('rejects malformed records in all quota, limits, budget, and reservation tables', () => {
    const cases = [
      "INSERT INTO project_limits VALUES ('p', -1, 'now')",
      "INSERT INTO project_limits VALUES ('p', 0, 'now')",
      "INSERT INTO project_limits VALUES ('p', 1.2, 'now')",
      "INSERT INTO quota_windows VALUES ('p', 'x', 500, 1, 'now')",
      "INSERT INTO quota_windows VALUES ('p', 'x', 1000, 0, 'now')",
      "INSERT INTO quota_windows VALUES ('p', 'x', 1000, -5, 'now')",
      "INSERT INTO quota_windows VALUES ('p', 'x', 1000.5, 1, 'now')",
      "INSERT INTO budget_caps VALUES ('p', 'unknown', '', 1, 'now')",
      "INSERT INTO budget_caps VALUES ('p', 'project', '', 0, 'now')",
      "INSERT INTO budget_caps VALUES ('p', 'project', '', -10, 'now')",
      "INSERT INTO budget_caps VALUES ('p', 'project', '', 2.5, 'now')",
      "INSERT INTO quota_reservations VALUES ('r-bad', 'p', 'a1', 'default', 1, 'invalid', 99000, NULL)",
    ]

    for (const sql of cases) {
      const { dir, db } = fixture()
      try {
        task(db, 'used', 'done')
        db.prepare("INSERT INTO attempts (id,task_id,attempt_no,status,lease_generation) VALUES ('a1','used',1,'pending',1)").run()
        db.exec('PRAGMA ignore_check_constraints = ON')
        db.exec(sql)
        expect(() => readStatus(dir, options)).toThrow()
      } finally {
        db.close()
      }
    }
  })

  it('formats Arabic output without forbidden tokens and maintains single-line dispatch variation', () => {
    const { dir, db } = fixture()
    try {
      task(db, 'used', 'done')
      task(db, 'wait-task', 'ready')
      reservation(db, 1, 'used', 'default', 'settled', 99000)
      db.exec("INSERT INTO project_limits VALUES ('p', 4, 'now')")
      db.exec("INSERT INTO quota_windows VALUES ('p', 'default', 10000, 8, 'now')")
      db.exec("INSERT INTO budget_caps VALUES ('p', 'project', '', 5, 'now')")

      const status = readStatus(dir, options)
      const text = formatStatus(status)
      const json = JSON.stringify(status)

      // Verified facts present
      expect(text).toContain('4')
      expect(text).toContain('8')
      expect(text).toContain('5')
      expect(text).toContain('1')
      expect(text).toContain(new Date(109000).toISOString())

      // Forbidden words absent
      for (const word of ['متبق', 'المتبقي', 'رموز', 'توكن']) {
        expect(text).not.toContain(word)
      }

      // Forbidden English keys in human view
      for (const key of ['limits', 'quota', 'budget']) {
        expect(json).toContain(`"${key}"`)
        expect(text).not.toContain(key)
      }
    } finally {
      db.close()
    }
  })
})
