/*
 * JSON contract: existing {schemaVersion, recordedCommandCount, lease} plus
 * commands {recorded, applied, rejected, pending}, tasks [{id, title, status,
 * attempts [{no, status, exitCode, worker {pid, state, heartbeatMs} | null,
 * evidence {headSha, files [{path, sha256}]} | null}]}], outbox {pending, done, failed}.
 * Lease retains {ownerId, generation, heartbeatMs, state, freshness}; both views
 * expose takeover evidence ownerId:generation:heartbeatMs. A stale worker is
 * described as suspect. As in M2, Arabic output contains Arabic and the same
 * facts, without exposing command payloads. Each domain enum value must have a
 * nonempty, distinct Arabic label within that enum; wording is not prescribed.
 */
import childProcess from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { openStore } from '../../supervisor/src/app/store.ts'
import { appendCommand } from '../../supervisor/src/app/commands.ts'
import { applyPendingCommands } from '../../supervisor/src/app/apply-commands.ts'
import { acquireSupervisor } from '../../supervisor/src/app/supervisor-lease.ts'
import { enqueue, runDue } from '../../supervisor/src/app/outbox.ts'
import { readStatus, formatStatus, type Status } from '../../supervisor/src/app/status.ts'
import { TaskStatusSchema, AttemptStatusSchema, WorkerStateSchema, OutboxStatusSchema, CommandOutcomeSchema } from '../../supervisor/src/app/domain.ts'

const stamp = '2026-01-01T00:00:00.000Z'
const cli = join(process.cwd(), 'supervisor/src/cli/main.ts')
function run(dir: string, ...args: string[]) {
  return spawnSync(process.execPath, [cli, 'status', '--state-dir', dir, ...args], { encoding: 'utf8', timeout: 10000 })
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'factory-m3-status-'))
  try {
    const db = openStore(join(dir, 'state.sqlite'))
    db.prepare('INSERT INTO projects VALUES (?, ?, ?)').run('project', 'Project', stamp)
    db.prepare('INSERT INTO project_config VALUES (?, ?, ?, ?)').run('project', process.cwd(), 'main', stamp)
    db.close()
    return dir
  } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error }
}
function seed(dir: string) {
  const db = openStore(join(dir, 'state.sqlite'))
  try {
    const project = db.prepare('SELECT project_id FROM project_config').get() as { project_id: string }
    const handle = acquireSupervisor(db, dir, { nowMs: 1000, staleAfterMs: 500 })
    try {
    const add = (id: string, kind: string, payload: unknown) => appendCommand(db, { id, projectId: project.project_id, kind, payloadJson: JSON.stringify(payload), createdAt: stamp })
    add('task-one', 'task.create', { title: 'Example task' })
    add('bad-command', 'task.kill', { taskId: 'missing' })
    add('bad-command-2', 'task.kill', { taskId: 'missing' })
    applyPendingCommands(db, handle)
    add('pending-2', 'task.create', { title: 'pending' })
    add('pending-3', 'task.create', { title: 'pending' })
    add('pending-command', 'task.create', { title: 'private-payload' })
    enqueue(db, handle, { idempotencyKey: 'pending', kind: 'pending', payloadJson: '{}', nowMs: 1000 })
    enqueue(db, handle, { idempotencyKey: 'done', kind: 'done', payloadJson: '{}', nowMs: 1000 })
    for (const [id, status] of [['done-2', 'done'], ['failed-1', 'failed'], ['failed-2', 'failed'], ['failed-3', 'failed']]) db.prepare('INSERT INTO outbox VALUES (?, ?, ?, ?, ?, 0, 1000, NULL, ?, ?)').run(id!, id!, 'extra', '{}', status!, stamp, stamp)
    return { db, handle }
    } catch (error) { handle.release(1000); throw error }
  } catch (error) { db.close(); throw error }
}
function counts(db: DatabaseSync) {
  return Object.fromEntries(['projects', 'project_config', 'commands', 'command_outcomes', 'tasks', 'attempts', 'workers', 'outbox', 'evidence', 'supervisor_lease'].map(table => [table, db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()]))
}

it('CHK-M3-07-a: JSON reports command, task and outbox facts without writing', async () => {
  const dir = fixture()
  try {
    const { db, handle } = seed(dir)
    try {
      await runDue(db, handle, { done: () => {} }, 1000)
      db.exec("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at) VALUES ('attempt-1', 'task-one', 1, 'succeeded', 0, NULL, 1, NULL, NULL); INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at) VALUES ('attempt-2', 'task-one', 2, 'running', NULL, NULL, 1, NULL, NULL); INSERT INTO workers VALUES ('attempt-1', 'nonce-1', 12345, 'exited', '/work', 42, NULL, NULL); INSERT INTO evidence VALUES ('attempt-1', 'base', 'head-sha', '[{\"path\":\"src/a.ts\",\"sha256\":\"abc123\"}]', 'out', 'err', 'now')")
      const before = counts(db)
      const lease = db.prepare('SELECT * FROM supervisor_lease').get()
      const result = run(dir, '--json')
      expect(result.status).toBe(0)
      const status = JSON.parse(result.stdout)
      expect(Object.keys(status).sort()).toEqual(['commands', 'lease', 'outbox', 'recordedCommandCount', 'schemaVersion', 'tasks'].sort())
      expect(status.schemaVersion).toBe(6)
      expect(status.recordedCommandCount).toBe(6)
      expect(status.commands).toEqual({ recorded: 6, applied: 1, rejected: 2, pending: 3 })
      expect(status.tasks).toEqual( [{ id: 'task-one', title: 'Example task', status: 'ready', attempts: [{ no: 1, status: 'succeeded', exitCode: 0, worker: { pid: 12345, state: 'exited', heartbeatMs: 42 }, evidence: { headSha: 'head-sha', files: [{ path: 'src/a.ts', sha256: 'abc123' }] } }, { no: 2, status: 'running', exitCode: null, worker: null, evidence: null }] }])
      expect(status.outbox).toEqual({ pending: 1, done: 2, failed: 3 })
      expect(result.stdout).not.toContain('private-payload')
      expect(result.stdout).not.toContain('nonce-1')
      expect(counts(db)).toEqual(before)
      expect(db.prepare('SELECT * FROM supervisor_lease').get()).toEqual(lease)
    } finally { try { handle.release(1000) } finally { db.close() } }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 20000)

it('CHK-M3-07-b: Arabic view includes task and count facts without command payloads', () => {
  const dir = fixture()
  try {
    const { db, handle } = seed(dir)
    try {
      db.exec(`INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at) VALUES ('a', 'task-one', 1, 'succeeded', 7, NULL, 1, NULL, NULL); INSERT INTO workers VALUES ('a', 'nonce-1', 12345, 'exited', '/work', 42, NULL, NULL); INSERT INTO evidence VALUES ('a', 'base', 'head-sha', '[{"path":"src/a.ts","sha256":"abc123"}]', 'out', 'err', 'now')`)
      const result = run(dir)
      expect(result.status).toBe(0)
      expect(result.stdout).toMatch(/[\u0600-\u06ff]/)
      for (const fact of ['12345', '42', 'head-sha', 'src/a.ts', 'abc123', '7']) expect(result.stdout).toContain(fact)
      expect(result.stdout).toContain('Example task')
      expect(result.stdout).toContain('task-one')
      expect(result.stdout).toContain('6')
      expect(result.stdout).not.toContain('private-payload')
      expect(result.stdout).not.toContain('nonce-1')
    } finally { try { handle.release(1000) } finally { db.close() } }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 20000)

it('CHK-M3-07-a: reads all status facts in one read-only transaction', () => {
  const dir = fixture()
  try {
    const { db, handle } = seed(dir)
    const original = DatabaseSync.prototype.exec
    const exec = vi.spyOn(DatabaseSync.prototype, 'exec')
    let readOnly = false
    exec.mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === 'BEGIN') {
        try { original.call(this, "CREATE TABLE status_must_not_write (id INTEGER)") } catch { readOnly = true }
      }
      return original.call(this, sql)
    })
    const originalPrepare = DatabaseSync.prototype.prepare
    const transactions: boolean[] = []
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
      transactions.push(this.isTransaction)
      return originalPrepare.call(this, sql)
    })
    try {
      const status = readStatus(dir, { nowMs: 2000, staleAfterMs: 500 }) as unknown as { commands: unknown; tasks: unknown; outbox: unknown }
      expect(transactions.length).toBeGreaterThan(0)
      expect(transactions.every(Boolean)).toBe(true)
      expect(status.commands).toEqual({ recorded: 6, applied: 1, rejected: 2, pending: 3 })
      expect(status.tasks).toEqual([{ id: 'task-one', title: 'Example task', status: 'ready', attempts: [] }])
      expect(status.outbox).toEqual({ pending: 2, done: 1, failed: 3 })
      expect(readOnly).toBe(true)
      expect(exec.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT'])
    } finally { prepare.mockRestore(); exec.mockRestore(); try { handle.release(1000) } finally { db.close() } }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

const extractCountLabel = (clause: string) => clause.replace(/\b42\b/, '').trim().replace(/[:=]$/, '').replace(/^.*:/, '').trim()

it('extracts counter labels from supported formats', () => {
  for (const sample of ['label: 42', 'header: label: 42', 'label 42']) {
    expect(extractCountLabel(sample)).toBe('label')
  }
})

it('CHK-M3-07-b: every displayed enum value has a distinct Arabic label', () => {
  const base = { schemaVersion: 6, recordedCommandCount: 0, lease: null, commands: { recorded: 0, applied: 0, rejected: 0, pending: 0 }, outbox: { pending: 0, done: 0, failed: 0 }, tasks: [{ id: 'task', title: 'title', status: 'ready', attempts: [{ no: 1, status: 'succeeded', exitCode: 0, worker: { pid: 12345, state: 'running', heartbeatMs: 1 }, evidence: null }] }] }
  const cases: Array<[readonly string[], (s: typeof base, v: string) => void]> = [
    [TaskStatusSchema.options, (s, v) => { s.tasks[0]!.status = v }],
    [AttemptStatusSchema.options, (s, v) => { s.tasks[0]!.attempts[0]!.status = v }],
    [WorkerStateSchema.options, (s, v) => { s.tasks[0]!.attempts[0]!.worker.state = v }],
  ]
  for (const [values, set] of cases) {
    const outputs = values.map(value => { const s = structuredClone(base); set(s, value); return formatStatus(s as unknown as Status) })
    // Remove the shared prefix and suffix so fixed labels in count summaries remain visible.
    let prefix = 0
    while (outputs.every(o => prefix < o.length && o[prefix] === outputs[0]![prefix])) prefix++
    let suffix = 0
    while (outputs.every(o => suffix < o.length - prefix && o[o.length - 1 - suffix] === outputs[0]![outputs[0]!.length - 1 - suffix])) suffix++
    const labels = outputs.map(o => o.slice(prefix, o.length - suffix))
    labels.forEach((label, index) => {
      expect(label).toMatch(/[\u0600-\u06ff]/)
      expect(label).not.toContain(values[index]!)
    })
    expect(new Set(labels).size).toBe(values.length)
  }
  for (const [values, section] of [[OutboxStatusSchema.options, 'outbox'], [CommandOutcomeSchema.options, 'commands']] as const) {
    const labels = values.map(value => {
      const s = structuredClone(base)
      s.tasks = []
      if (section === 'outbox') s.outbox[value as keyof typeof s.outbox] = 42
      else s.commands[value as 'applied' | 'rejected'] = 42
      const clause = formatStatus(s as unknown as Status).split(/[\n,\u060c;|]+/).find(part => /\b42\b/.test(part)) ?? ''
      const label = extractCountLabel(clause)
      expect(label).toMatch(/[\u0600-\u06ff]/)
      expect(label).not.toContain(value)
      return label
    })
    expect(new Set(labels).size).toBe(values.length)
  }
})

it('CHK-M3-07-c: persisted stale live PID is suspect without process probes', () => {
  const dir = fixture()
  try {
    const { db, handle } = seed(dir)
    try {
      db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at) VALUES ('live', 'task-one', 1, 'running', NULL, NULL, 1, NULL, NULL)").run()
      db.prepare("INSERT INTO workers VALUES ('live', 'live-nonce', ?, 'running', '/work', 1000, NULL, NULL)").run(process.pid)
      const kill = vi.spyOn(process, 'kill')
      const spawns = (['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync'] as const).map(name => vi.spyOn(childProcess, name))
      try {
        const fresh = readStatus(dir, { nowMs: 1200, staleAfterMs: 500 })
        expect(formatStatus(fresh)).not.toMatch(/\u0645\u0634\u0628\u0648\u0647|\u0627\u0634\u062a\u0628\u0627\u0647|\u0645\u0634\u062a\u0628\u0647/)
        const status = readStatus(dir, { nowMs: 2000, staleAfterMs: 500 })
        const text = formatStatus(status)
        expect((status as unknown as { tasks: Array<{ attempts: Array<{ worker: { state: string } }> }> }).tasks[0]?.attempts[0]?.worker?.state).toBe('running')
        expect(text).not.toMatch(/\u0645\u064a\u062a|dead/i)
        expect.soft(text).toContain(String(process.pid))
        expect.soft(text).toMatch(/\u0645\u0634\u0628\u0648\u0647|\u0627\u0634\u062a\u0628\u0627\u0647|\u0645\u0634\u062a\u0628\u0647/)
        expect.soft(kill).not.toHaveBeenCalled()
        for (const spy of spawns) expect.soft(spy).not.toHaveBeenCalled()
      } finally { kill.mockRestore(); for (const spy of spawns) spy.mockRestore() }
      db.prepare('UPDATE workers SET heartbeat_ms = ? WHERE attempt_id = ?').run(Date.now() - 5000, 'live')
      const result = run(dir, '--stale-after-ms', '500')
      expect(result.status).toBe(0)
      expect(result.stdout).not.toMatch(/\u0645\u064a\u062a|dead/i)
      expect(result.stdout).toContain(String(process.pid))
      expect(result.stdout).toMatch(/\u0645\u0634\u0628\u0648\u0647|\u0627\u0634\u062a\u0628\u0627\u0647|\u0645\u0634\u062a\u0628\u0647/)
      const freshCli = run(dir, '--stale-after-ms', '600000')
      expect(freshCli.status).toBe(0)
      expect(freshCli.stdout).not.toMatch(/\u0645\u0634\u0628\u0648\u0647|\u0627\u0634\u062a\u0628\u0627\u0647|\u0645\u0634\u062a\u0628\u0647/)
    } finally { try { handle.release(1000) } finally { db.close() } }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('CHK-M3-07-d: rejects unknown task status', () => {
  const dir = fixture()
  try {
    const { db, handle } = seed(dir)
    try {
      db.exec("PRAGMA ignore_check_constraints = ON; UPDATE tasks SET status = 'unknown' WHERE id = 'task-one'")
      const result = run(dir, '--json')
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('\u0628\u064a\u0627\u0646\u0627\u062a \u0642\u0627\u0639\u062f\u0629 \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a \u063a\u064a\u0631 \u0635\u0627\u0644\u062d\u0629')
    } finally { try { handle.release(1000) } finally { db.close() } }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('CHK-M3-07-d: rejects malformed evidence JSON', () => {
  const dir = fixture()
  try {
    const { db, handle } = seed(dir)
    try {
      db.exec("INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at) VALUES ('a', 'task-one', 1, 'succeeded', 0, NULL, 1, NULL, NULL); INSERT INTO evidence VALUES ('a', 'base', 'head', '{bad', 'out', 'err', 'now')")
      const result = run(dir, '--json')
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('\u0628\u064a\u0627\u0646\u0627\u062a \u0642\u0627\u0639\u062f\u0629 \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a \u063a\u064a\u0631 \u0635\u0627\u0644\u062d\u0629')
    } finally { try { handle.release(1000) } finally { db.close() } }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it.each([
  ['attempt status', "INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at) VALUES ('a', 'task-one', 1, 'unknown', NULL, NULL, 1, NULL, NULL)"],
  ['worker state', "INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at) VALUES ('a', 'task-one', 1, 'succeeded', 0, NULL, 1, NULL, NULL); INSERT INTO workers VALUES ('a', 'nonce', 1, 'unknown', '/work', 1, NULL, NULL)"],
  ['outbox status', "UPDATE outbox SET status = 'unknown' WHERE idempotency_key = 'pending'"],
  ['command outcome', "INSERT INTO command_outcomes VALUES ('pending-command', 'unknown', NULL, 1, 'now')"],
  ['evidence schema', `INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at) VALUES ('a', 'task-one', 1, 'succeeded', 0, NULL, 1, NULL, NULL); INSERT INTO evidence VALUES ('a', 'base', 'head', '[{"path":123}]', 'out', 'err', 'now')`],
])('CHK-M3-07-d: rejects invalid %s', (_name, sql) => {
  const dir = fixture()
  try {
    const { db, handle } = seed(dir)
    try {
      db.exec('PRAGMA ignore_check_constraints = ON')
      db.exec(sql)
      const result = run(dir, '--json')
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('\u0628\u064a\u0627\u0646\u0627\u062a \u0642\u0627\u0639\u062f\u0629 \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a \u063a\u064a\u0631 \u0635\u0627\u0644\u062d\u0629')
    } finally { try { handle.release(1000) } finally { db.close() } }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('CHK-M3-07-d: rejects a v4 database', () => {
  const dir = fixture()
  try {
    const db = openStore(join(dir, 'state.sqlite'))
    try {
      db.exec('PRAGMA user_version = 4')
      const result = run(dir, '--json')
      expect(result.status).toBe(1)
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 4 })
      expect(result.stderr).toContain('\u0625\u0635\u062f\u0627\u0631 \u0645\u062e\u0637\u0637 \u0642\u0627\u0639\u062f\u0629 \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a \u063a\u064a\u0631 \u0645\u062f\u0639\u0648\u0645')
    } finally { db.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('CHK-M3-07-e: both views contain exact lease takeover evidence', () => {
  const dir = fixture()
  try {
    const { db, handle } = seed(dir)
    try {
      const token = `${handle.ownerId}:${handle.generation}:1000`
      const json = run(dir, '--json')
      const human = run(dir)
      expect(json.status).toBe(0)
      expect(human.status).toBe(0)
      expect(json.stdout).toContain(token)
      expect(human.stdout).toContain(token)
      expect(readStatus(dir, { nowMs: 2000, staleAfterMs: 500 }).lease).toMatchObject({ ownerId: handle.ownerId, generation: handle.generation, heartbeatMs: 1000 })
    } finally { try { handle.release(1000) } finally { db.close() } }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 20000)
