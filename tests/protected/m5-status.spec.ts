import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { openStore } from '../../supervisor/src/app/store.ts'
import { formatStatus, readStatus, type Status } from '../../supervisor/src/app/status.ts'
import { planDispatch } from '../../supervisor/src/core/graph.ts'

const stamp = '2026-01-01T00:00:00.000Z'
const closed = '2026-01-02T00:00:00.000Z'
const nowMs = 1000
const cli = join(process.cwd(), 'supervisor/src/cli/main.ts')
const run = (dir: string) => spawnSync(process.execPath, [cli, 'status', '--state-dir', dir, '--json'], { encoding: 'utf8', timeout: 10000 })
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const phases = [
  { name: 'intake', ord: 1, status: 'done', openedAt: stamp, closedAt: closed },
  { name: 'development', ord: 2, status: 'open', openedAt: closed, closedAt: null },
  { name: 'qa', ord: 3, status: 'locked', openedAt: null, closedAt: null },
  { name: 'devops', ord: 4, status: 'locked', openedAt: null, closedAt: null },
  { name: 'handover', ord: 5, status: 'locked', openedAt: null, closedAt: null },
] as const
const rows = [
  { id: 'done-z', status: 'done', phase: 'intake', deps: [], scope: ['done-z'], notBeforeMs: 0 },
  { id: 'unfinished-b', status: 'failed', phase: 'development', deps: [], scope: ['b'], notBeforeMs: 0 },
  { id: 'unfinished-a', status: 'failed', phase: 'development', deps: [], scope: ['a'], notBeforeMs: 0 },
  { id: 'blocked', status: 'blocked', phase: 'development', deps: [], scope: ['blocked'], notBeforeMs: 0 },
  { id: 'progress', status: 'progress', phase: 'development', deps: [], scope: ['progress'], notBeforeMs: 0 },
  { id: 'dropped', status: 'dropped', phase: 'intake', deps: [], scope: ['dropped'], notBeforeMs: 0 },
  { id: 'locked', status: 'ready', phase: 'qa', deps: [], scope: ['locked'], notBeforeMs: 0 },
  { id: 'deps', status: 'ready', phase: 'development', deps: ['done-z', 'unfinished-b', 'unfinished-a'], scope: ['deps'], notBeforeMs: 0 },
  { id: 'first', status: 'ready', phase: 'development', deps: [], scope: ['shared'], notBeforeMs: 0 },
  { id: 'scope', status: 'ready', phase: 'development', deps: [], scope: ['shared/child'], notBeforeMs: 0 },
  { id: 'backoff', status: 'ready', phase: 'development', deps: [], scope: ['backoff'], notBeforeMs: 9000000000000 },
] as const

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'factory-m5-status-'))
  try {
    const db = openStore(join(dir, 'state.sqlite'))
    try {
      db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run('p', 'Project', stamp)
      db.prepare('INSERT INTO project_config (project_id, repo_path, base_ref, created_at) VALUES (?, ?, ?, ?)').run('p', dir, 'main', stamp)
      const phase = db.prepare('INSERT INTO phases (project_id, name, ord, status, opened_at, closed_at) VALUES (?, ?, ?, ?, ?, ?)')
      for (const p of [...phases].reverse()) phase.run('p', p.name, p.ord, p.status, p.openedAt, p.closedAt)
      const command = db.prepare('INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
      const task = db.prepare('INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, not_before_ms, phase) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      const dep = db.prepare('INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)')
      for (const row of rows) {
        command.run(`cmd-${row.id}`, 'p', 'task.create', '{}', stamp)
        task.run(row.id, 'p', `cmd-${row.id}`, `Title ${row.id}`, row.status, stamp, stamp, JSON.stringify(row.scope), row.notBeforeMs, row.phase)
        for (const id of row.deps) dep.run(row.id, id)
      }
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally { db.close() }
    return dir
  } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error }
}
function withFixture(fn: (dir: string) => void) {
  const dir = fixture()
  try { fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}
const counts = (ready: number, progress: number, blocked: number, failed: number, done: number, dropped: number) => ({ ready, progress, blocked, failed, done, dropped })

it('CHK-M5-07-a: phases and task graph are read in order without writes', () => withFixture(dir => {
  const path = join(dir, 'state.sqlite')
  const before = hash(path)
  const status = readStatus(dir, { nowMs, staleAfterMs: 500 }) as any
  const result = run(dir)
  expect(result.status).toBe(0)
  const json = JSON.parse(result.stdout)
  const expected = phases.map((phase, i) => ({ ...phase, tasks: [counts(0, 0, 0, 0, 1, 1), counts(4, 1, 1, 2, 0, 0), counts(1, 0, 0, 0, 0, 0), counts(0, 0, 0, 0, 0, 0), counts(0, 0, 0, 0, 0, 0)][i] }))
  expect(status.schemaVersion).toBe(7)
  expect(json.schemaVersion).toBe(7)
  expect(status.phases).toEqual(expected)
  expect(json.phases).toEqual(expected)
  for (const row of rows) {
    expect(status.tasks.find((t: any) => t.id === row.id)).toMatchObject({ phase: row.phase, dependsOn: [...row.deps].sort(), waiting: row.status === 'ready' && row.id !== 'first' ? expect.anything() : null })
    expect(json.tasks.find((t: any) => t.id === row.id)).toMatchObject({ phase: row.phase, dependsOn: [...row.deps].sort() })
  }
  expect(hash(path)).toBe(before)
  const db = new DatabaseSync(path, { readOnly: true })
  try { expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 7 }) } finally { db.close() }
}))

it('CHK-M5-07-b: waiting matches dispatch and blockedBy remains progress-only', () => withFixture(dir => {
  const status = readStatus(dir, { nowMs, staleAfterMs: 500 }) as any
  const plan = planDispatch({ nowMs, phases: phases.map(({ name, status }) => ({ name, status })), tasks: rows.map(row => ({ ...row, deps: [...row.deps], scope: [...row.scope] })) })
  const expected = [
    { id: 'locked', reason: 'phase-locked', on: ['qa'] },
    { id: 'deps', reason: 'deps', on: ['unfinished-a', 'unfinished-b'] },
    { id: 'scope', reason: 'scope', on: ['first'] },
    { id: 'backoff', reason: 'backoff', on: [] },
  ]
  expect(plan.wait).toEqual(expected)
  for (const task of status.tasks) {
    const wait = plan.wait.find((entry: { id: string; reason: string; on: string[] }) => entry.id === task.id)
    expect(task.waiting).toEqual(wait ? { reason: wait.reason, on: wait.on } : null)
  }
  expect(status.tasks.find((t: any) => t.id === 'scope')).toMatchObject({ blockedBy: [], waiting: { reason: 'scope', on: ['first'] } })
}))

it('CHK-M5-07-c: Arabic view shows phases, open phase, task phase and dependencies', () => withFixture(dir => {
  const status = readStatus(dir, { nowMs, staleAfterMs: 500 }) as any
  const output = formatStatus(status as Status)
  for (const phase of phases) expect(output).toContain(phase.name)
  const openLine = output.split(/\r?\n/).find(line => line.includes('development')) ?? ''
  const lockedLine = output.split(/\r?\n/).find(line => line.includes('devops')) ?? ''
  expect(openLine).toMatch(/[\u0600-\u06ff]/)
  expect(openLine.replace('development', '')).not.toBe(lockedLine.replace('devops', ''))
  status.tasks = [status.tasks.find((task: any) => task.id === 'deps')]
  const taskView = formatStatus(status as Status)
  for (const fact of ['deps', 'development', 'unfinished-a', 'unfinished-b', 'done-z']) expect(taskView).toContain(fact)
}))

it('CHK-M5-07-c: waiting reasons have distinct Arabic labels', () => withFixture(dir => {
  const base = readStatus(dir, { nowMs, staleAfterMs: 500 }) as any
  const values = ['phase-locked', 'deps', 'scope', 'backoff']
  const outputs = values.map(reason => {
    const status = structuredClone(base)
    status.tasks = [status.tasks.find((task: any) => task.id === 'scope')]
    status.tasks[0].waiting = { reason, on: [] }
    return formatStatus(status as Status)
  })
  let prefix = 0
  while (outputs.every(s => prefix < s.length && s[prefix] === outputs[0]![prefix])) prefix++
  let suffix = 0
  while (outputs.every(s => suffix < s.length - prefix && s[s.length - 1 - suffix] === outputs[0]![outputs[0]!.length - 1 - suffix])) suffix++
  const labels = outputs.map(s => s.slice(prefix, s.length - suffix))
  labels.forEach((label, i) => { expect(label).toMatch(/[\u0600-\u06ff]/); expect(label).not.toContain(values[i]!) })
  expect(new Set(labels).size).toBe(values.length)
}))

it.each([
  ['missing dependency', "INSERT INTO task_deps (task_id, depends_on) VALUES ('first', 'missing')"],
  ['missing phase', "DROP TRIGGER phases_no_delete; DELETE FROM phases WHERE project_id = 'p' AND name = 'handover'"],
])('CHK-M5-07-d: %s is malformed data', (_name, sql) => withFixture(dir => {
  const db = new DatabaseSync(join(dir, 'state.sqlite'))
  try { db.exec('PRAGMA foreign_keys = OFF'); db.exec(sql) } finally { db.close() }
  const result = run(dir)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('بيانات قاعدة البيانات غير صالحة')
}))
