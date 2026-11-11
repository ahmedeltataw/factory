import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openStore } from '../supervisor/src/app/store.ts'
import { formatStatus, readStatus, type Status } from '../supervisor/src/app/status.ts'

const cli = join(process.cwd(), 'supervisor/src/cli/main.ts')
const stamp = '2026-01-01T00:00:00.000Z'
const run = (dir: string, ...args: string[]) =>
  spawnSync(process.execPath, [cli, 'status', '--state-dir', dir, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 10000,
  })

function createFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'factory-m4-07-unit-'))
  const db = openStore(join(dir, 'state.sqlite'))
  try {
    db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run('p1', 'Project 1', stamp)
    db.prepare('INSERT INTO project_config (project_id, repo_path, base_ref, created_at) VALUES (?, ?, ?, ?)').run(
      'p1',
      dir,
      'main',
      stamp,
    )
    const cmd = db.prepare('INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
    const task = db.prepare(
      'INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json, max_attempts, timeout_ms, attempt_base, not_before_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )

    // Progress tasks holding scopes
    cmd.run('cmd-h1', 'p1', 'task.create', '{}', stamp)
    task.run('holder-1', 'p1', 'cmd-h1', 'Holder 1', 'progress', stamp, stamp, JSON.stringify(['src']), 3, null, 0, 0)

    cmd.run('cmd-h2', 'p1', 'task.create', '{}', stamp)
    task.run('holder-2', 'p1', 'cmd-h2', 'Holder 2', 'progress', stamp, stamp, JSON.stringify(['docs']), 3, null, 0, 0)

    // Ready task overlapping holder-1 and holder-2
    cmd.run('cmd-r1', 'p1', 'task.create', '{}', stamp)
    task.run('ready-1', 'p1', 'cmd-r1', 'Ready 1', 'ready', stamp, stamp, JSON.stringify(['src/ui', 'docs/api']), 5, 3000, 1, 555000)

    // Ready task disjoint from everything
    cmd.run('cmd-r2', 'p1', 'task.create', '{}', stamp)
    task.run('ready-2', 'p1', 'cmd-r2', 'Ready 2', 'ready', stamp, stamp, JSON.stringify(['tools']), 3, null, 0, 0)

    // Done task
    cmd.run('cmd-d1', 'p1', 'task.create', '{}', stamp)
    task.run('done-1', 'p1', 'cmd-d1', 'Done 1', 'done', stamp, stamp, JSON.stringify(['src']), 3, null, 0, 0)

    // Attempts for ready-1
    const attempt = db.prepare(
      'INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at, deadline_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    attempt.run('att-1', 'ready-1', 1, 'failed', 75, 'transient', 1, stamp, stamp, 111222)
    attempt.run('att-2', 'ready-1', 2, 'interrupted', null, 'timeout', 1, stamp, stamp, 333444)

    // Outbox entries
    db.prepare(
      'INSERT INTO outbox (id, idempotency_key, kind, payload_json, status, tries, next_attempt_ms, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('o1', 'key-fail-1', 'evidence.commit', '{}', 'failed', 3, 0, 'network error', stamp, stamp)

    db.prepare(
      'INSERT INTO outbox (id, idempotency_key, kind, payload_json, status, tries, next_attempt_ms, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('o2', 'key-pend-1', 'task.start', '{}', 'pending', 1, 0, null, stamp, stamp)
  } finally {
    db.close()
  }
  return dir
}

describe('M4-07 unit tests', () => {
  it('CHK-M4-07-a: reads v6 task, attempt and outbox fields via readStatus and CLI --json', () => {
    const dir = createFixture()
    try {
      const status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 }) as Status
      expect(status.schemaVersion).toBe(7)
      const tasks = status.tasks!
      const ready1 = tasks.find((t) => t.id === 'ready-1')!
      expect(ready1.scope).toEqual(['docs/api', 'src/ui'])
      expect(ready1.maxAttempts).toBe(5)
      expect(ready1.timeoutMs).toBe(3000)
      expect(ready1.notBeforeMs).toBe(555000)
      expect(ready1.blockedBy).toEqual(expect.arrayContaining(['holder-1', 'holder-2']))
      expect(ready1.attempts).toHaveLength(2)
      expect(ready1.attempts[0]).toMatchObject({ no: 1, errorClass: 'transient', deadlineMs: 111222 })
      expect(ready1.attempts[1]).toMatchObject({ no: 2, errorClass: 'timeout', deadlineMs: 333444 })

      expect(status.outbox).toMatchObject({
        pending: 1,
        failed: 1,
        failedRows: [{ key: 'key-fail-1', kind: 'evidence.commit', tries: 3, lastError: 'network error' }],
      })

      const res = run(dir, '--json')
      expect(res.status).toBe(0)
      const json = JSON.parse(res.stdout)
      expect(json.tasks.find((t: any) => t.id === 'ready-1')).toMatchObject({
        scope: ['docs/api', 'src/ui'],
        maxAttempts: 5,
        timeoutMs: 3000,
        notBeforeMs: 555000,
        blockedBy: expect.arrayContaining(['holder-1', 'holder-2']),
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('CHK-M4-07-b: formats Arabic view with scope, budget, deadlines, and error_class labels', () => {
    const dir = createFixture()
    try {
      const res = run(dir)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('src/ui')
      expect(res.stdout).toContain('docs/api')
      expect(res.stdout).toContain('3000')
      expect(res.stdout).toContain('555000')
      expect(res.stdout).toContain('111222')
      expect(res.stdout).toContain('key-fail-1')
      expect(res.stdout).toContain('network error')
      // Budget: attempt_base is 1, attempts 1 and 2 exist (no > 1 is 1 attempt), max is 5 -> 1 / 5
      expect(res.stdout).toMatch(/1\s*\/\s*5/)

      // Error class labels test
      const status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
      const forLabels = structuredClone(status) as any
      forLabels.tasks = [forLabels.tasks.find((t: any) => t.id === 'ready-1')]
      forLabels.tasks[0].attempts = [forLabels.tasks[0].attempts[0]]

      forLabels.tasks[0].attempts[0].errorClass = 'scope-violation'
      expect(formatStatus(forLabels)).toContain('انتهاك النطاق')

      forLabels.tasks[0].attempts[0].errorClass = 'exit'
      expect(formatStatus(forLabels)).toContain('خروج غير صفري')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('CHK-M4-07-c: blockedBy is computed properly and empty for non-ready tasks', () => {
    const dir = createFixture()
    try {
      const status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 }) as Status
      const tasks = status.tasks!

      expect(tasks.find((t) => t.id === 'ready-1')!.blockedBy).toEqual(
        expect.arrayContaining(['holder-1', 'holder-2']),
      )
      expect(tasks.find((t) => t.id === 'ready-2')!.blockedBy).toEqual([])
      expect(tasks.find((t) => t.id === 'holder-1')!.blockedBy).toEqual([])
      expect(tasks.find((t) => t.id === 'holder-2')!.blockedBy).toEqual([])
      expect(tasks.find((t) => t.id === 'done-1')!.blockedBy).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('CHK-M4-07-d: watch CLI flag validation rejects invalid intervals and count', () => {
    const dir = createFixture()
    try {
      expect(run(dir, '--interval-ms', '1000').status).toBe(2)
      expect(run(dir, '--count', '5').status).toBe(2)
      expect(run(dir, '--watch', '--interval-ms', '199').status).toBe(2)
      expect(run(dir, '--watch', '--interval-ms', '60001').status).toBe(2)
      expect(run(dir, '--watch', '--count', '0').status).toBe(2)
      expect(run(dir, '--watch', '--count', '-1').status).toBe(2)
      expect(run(dir, '--watch', '--count', 'abc').status).toBe(2)
      expect(run(dir, '--watch', '--interval-ms', 'abc').status).toBe(2)
      expect(run(dir, '--watch', '--watch').status).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('CHK-M4-07-e: malformed scope_json stored in task row causes exit code 1', () => {
    const dir = createFixture()
    try {
      const db = openStore(join(dir, 'state.sqlite'))
      try {
        db.prepare("UPDATE tasks SET scope_json = '[\"../x\"]' WHERE id = 'ready-1'").run()
      } finally {
        db.close()
      }

      const res = run(dir, '--json')
      expect(res.status).toBe(1)
      expect(res.stderr).toContain('بيانات قاعدة البيانات غير صالحة')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
