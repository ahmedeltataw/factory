import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { openStore } from '../../supervisor/src/app/store.ts'
import { formatStatus, readStatus, type Status } from '../../supervisor/src/app/status.ts'

const cli = join(process.cwd(), 'supervisor/src/cli/main.ts')
const stamp = '2026-01-01T00:00:00.000Z'
const run = (dir: string, ...args: string[]) => spawnSync(process.execPath, [cli, 'status', '--state-dir', dir, ...args], { cwd: dir, encoding: 'utf8', timeout: 10000 })
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const walSize = (path: string) => existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'factory-m4-status-'))
  try {
    const db = openStore(join(dir, 'state.sqlite'))
    try {
      db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run('p', 'Project', stamp)
      db.prepare('INSERT INTO project_config (project_id, repo_path, base_ref, created_at) VALUES (?, ?, ?, ?)').run('p', dir, 'main', stamp)
      const command = db.prepare('INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
      const task = db.prepare('INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, max_attempts, timeout_ms, attempt_base, not_before_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      const rows = [
        ['holder-a', 'progress', ['Src'], 3, null, 0, 0],
        ['holder-b', 'progress', ['docs/api'], 3, null, 0, 0],
        ['holder-c', 'progress', ['other'], 3, null, 0, 0],
        ['ready', 'ready', ['docs', 'src/ui'], 7, 4500, 2, 987654],
        ['boundary', 'ready', ['src2'], 3, null, 0, 0],
        ['finished', 'done', ['src'], 3, null, 0, 0],
      ] as const
      for (const [id, status, scope, max, timeout, base, backoff] of rows) {
        command.run(`cmd-${id}`, 'p', 'task.create', '{}', stamp)
        task.run(id, 'p', `cmd-${id}`, `Title ${id}`, status, stamp, stamp, JSON.stringify(scope), max, timeout, base, backoff)
      }
      const attempt = db.prepare('INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at, deadline_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      attempt.run('a3', 'ready', 3, 'failed', 75, 'transient', 1, stamp, stamp, 123456)
      attempt.run('a4', 'ready', 4, 'interrupted', null, 'timeout', 1, stamp, stamp, null)
      db.prepare('INSERT INTO outbox (id, idempotency_key, kind, payload_json, status, tries, next_attempt_ms, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('out-1', 'failed-key', 'evidence.commit', '{}', 'failed', 19, 0, 'failure details', stamp, stamp)
      db.prepare('INSERT INTO outbox (id, idempotency_key, kind, payload_json, status, tries, next_attempt_ms, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('out-2', 'pending-key', 'other', '{}', 'pending', 1, 0, 'not failed', stamp, stamp)
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally { db.close() }
    return dir
  } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error }
}
function withFixture(fn: (dir: string) => void) {
  const dir = fixture()
  try { fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

it('CHK-M4-07-a: JSON includes v6 fields and reads one read-only snapshot', () => withFixture(dir => {
  const exec = vi.spyOn(DatabaseSync.prototype, 'exec')
  const originalPrepare = DatabaseSync.prototype.prepare
  const inTransaction: boolean[] = []
  const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) { inTransaction.push(this.isTransaction); return originalPrepare.call(this, sql) })
  try {
    const status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 }) as any
    expect(exec.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT'])
    expect(inTransaction.length).toBeGreaterThan(0)
    expect(inTransaction.every(Boolean)).toBe(true)
    const task = status.tasks.find((t: any) => t.id === 'ready')
    expect(task).toMatchObject({ scope: ['docs', 'src/ui'], maxAttempts: 7, timeoutMs: 4500, notBeforeMs: 987654, blockedBy: expect.arrayContaining(['holder-a', 'holder-b']) })
    expect(task.attempts).toEqual([expect.objectContaining({ no: 3, errorClass: 'transient', deadlineMs: 123456 }), expect.objectContaining({ no: 4, errorClass: 'timeout', deadlineMs: null })])
    expect(status.outbox).toMatchObject({ pending: 1, failed: 1, failedRows: [{ key: 'failed-key', kind: 'evidence.commit', tries: 19, lastError: 'failure details' }] })
    const result = run(dir, '--json')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ tasks: expect.arrayContaining([expect.objectContaining({ id: 'ready', scope: ['docs', 'src/ui'], maxAttempts: 7, timeoutMs: 4500, notBeforeMs: 987654 })]), outbox: status.outbox })
  } finally { prepare.mockRestore(); exec.mockRestore() }
}))

it('CHK-M4-07-b: Arabic view shows the new facts and retry budget', () => withFixture(dir => {
  const result = run(dir)
  expect(result.status).toBe(0)
  expect(result.stdout).toMatch(/[\u0600-\u06ff]/)
  for (const fact of ['src/ui', 'docs', '4500', '987654', '123456', 'failed-key', 'evidence.commit', '19', 'failure details']) expect(result.stdout).toContain(fact)
  const status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 }) as any
  status.tasks = [status.tasks.find((task: any) => task.id === 'ready')]
  const readyView = formatStatus(status as Status)
  expect(readyView).toContain('holder-a')
  expect(readyView).toContain('holder-b')
  // Two attempts since attempt_base=2, out of a budget of seven.
  expect(result.stdout).toMatch(/2\s*\/\s*7/)
}))

it('CHK-M4-07-b: every new error class has a distinct Arabic rendering', () => withFixture(dir => {
  const base = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 }) as any
  const values = ['lost', 'not-running', 'identity-mismatch', 'killed', 'outbox:evidence.commit', 'outbox:worktree', 'transient', 'timeout', 'scope-violation', 'exit', 'unknown-class']
  const outputs = values.map(value => {
    const status = structuredClone(base)
    status.tasks = [status.tasks.find((task: any) => task.id === 'ready')]
    status.tasks[0].attempts = [status.tasks[0].attempts[0]]
    status.tasks[0].attempts[0].errorClass = value
    return formatStatus(status as Status)
  })
  let prefix = 0
  while (outputs.every(s => prefix < s.length && s[prefix] === outputs[0]![prefix])) prefix++
  let suffix = 0
  // Isolate the changing segment without requiring a particular Arabic word.
  while (outputs.every(s => suffix < s.length - prefix && s[s.length - 1 - suffix] === outputs[0]![outputs[0]!.length - 1 - suffix])) suffix++
  const labels = outputs.map(s => s.slice(prefix, s.length - suffix))
  labels.slice(0, -1).forEach((label, i) => { expect(label).toMatch(/[\u0600-\u06ff]/); expect(label).not.toContain(values[i]!) })
  expect(labels[4]).toContain('evidence.commit')
  expect(labels[5]).toContain('worktree')
  expect(labels.at(-1)).toBe('unknown-class')
  expect(new Set(labels).size).toBe(values.length)
}))

it('CHK-M4-07-c: blockers are exactly overlapping progress tasks only', () => withFixture(dir => {
  const result = run(dir, '--json')
  expect(result.status).toBe(0)
  const tasks = JSON.parse(result.stdout).tasks as Array<{ id: string; blockedBy: string[] }>
  const blockers = (id: string) => tasks.find(t => t.id === id)!.blockedBy
  expect([...blockers('ready')].sort()).toEqual(['holder-a', 'holder-b'])
  for (const id of ['holder-a', 'holder-b', 'holder-c', 'boundary', 'finished']) expect(blockers(id)).toEqual([])
}))

it.each([['--watch', '--interval-ms', '199'], ['--watch', '--interval-ms', '60001'], ['--watch', '--count', '0'], ['--count', '3']])('CHK-M4-07-d: invalid watch arguments exit 2: %s', (...args) => withFixture(dir => {
  const result = run(dir, ...args)
  expect(result.status).toBe(2)
}))

it('CHK-M4-07-d: watch emits three independent read-only snapshots', async () => {
  const dir = fixture()
  const path = join(dir, 'state.sqlite')
  try {
    // The only write between measurements is our explicit fixture update.
    const before = hash(path)
    const beforeWal = walSize(path)
    const child = spawn(process.execPath, [cli, 'status', '--state-dir', dir, '--watch', '--count', '3', '--interval-ms', '200', '--json'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let changed = false
    let afterWriteHash = ''
    let afterWriteWal = 0
    const timeout = setTimeout(() => child.kill(), 10000)
    const exit = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    try {
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
      child.stdout.setEncoding('utf8').on('data', chunk => {
        stdout += chunk
        if (!changed && stdout.includes('\n')) {
          changed = true
          const db = new DatabaseSync(path, { timeout: 5000 })
          try { db.prepare("UPDATE tasks SET not_before_ms = 123987 WHERE id = 'ready'").run(); db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } finally { db.close() }
          afterWriteHash = hash(path)
          afterWriteWal = walSize(path)
        }
      })
      expect(await exit, stderr).toBe(0)
      const lines = stdout.replace(/\r?\n$/, '').split(/\r?\n/)
      expect(lines).toHaveLength(3)
      const snapshots = lines.map(line => JSON.parse(line))
      const values = snapshots.map(s => s.tasks.find((t: any) => t.id === 'ready').notBeforeMs)
      expect(values[0]).toBe(987654)
      expect([987654, 123987]).toContain(values[1])
      expect(values[2]).toBe(123987)
      expect(changed).toBe(true)
      expect(hash(path)).toBe(afterWriteHash)
      expect(walSize(path)).toBeLessThanOrEqual(afterWriteWal)
      const db = new DatabaseSync(path, { readOnly: true })
      try { expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 6 }) } finally { db.close() }
      expect(before).not.toBe(afterWriteHash)
      expect(beforeWal).toBe(0)
    } finally { clearTimeout(timeout); child.kill(); await exit.catch(() => {}) }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 20000)

it('CHK-M4-07-e: valid JSON containing invalid scope is malformed data', () => withFixture(dir => {
  const db = openStore(join(dir, 'state.sqlite'))
  try { db.prepare('UPDATE tasks SET scope_json = ? WHERE id = ?').run('["../escape"]', 'ready') } finally { db.close() }
  const result = run(dir, '--json')
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('بيانات قاعدة البيانات غير صالحة')
}))



