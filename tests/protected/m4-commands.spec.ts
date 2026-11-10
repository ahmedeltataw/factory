import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { applyPendingCommands } from '../../supervisor/src/app/apply-commands.ts'
import { appendCommand, CommandConflictError } from '../../supervisor/src/app/commands.ts'
import { openStore } from '../../supervisor/src/app/store.ts'
import { acquireSupervisor, type SupervisorLeaseHandle } from '../../supervisor/src/app/supervisor-lease.ts'

const ARABIC_REGEX = /[\u0600-\u06ff]/
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const cliPath = join(process.cwd(), 'supervisor/src/cli/main.ts')
function runCli(...args: string[]) {
  const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', timeout: 15000 })
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    throw new Error(`CLI execution timed out after 15000ms: factory ${args.join(' ')}`)
  }
  return result
}

function createGitRepo(dir: string): void {
  execFileSync('git', ['init', dir], { stdio: 'ignore' })
  execFileSync(
    'git',
    [
      '-C',
      dir,
      '-c',
      'user.name=Factory Test',
      '-c',
      'user.email=factory@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'initial commit',
    ],
    { stdio: 'ignore' },
  )
}

function ensureSchemaV6(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  const v = Number(row?.user_version ?? 0)
  if (v < 6) {
    db.exec('ALTER TABLE tasks ADD COLUMN scope_json TEXT NOT NULL DEFAULT \'["."]\' CHECK (json_valid(scope_json))')
    db.exec('ALTER TABLE tasks ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10)')
    db.exec('ALTER TABLE tasks ADD COLUMN timeout_ms INTEGER CHECK (timeout_ms IS NULL OR timeout_ms BETWEEN 1000 AND 86400000)')
    db.exec('ALTER TABLE tasks ADD COLUMN attempt_base INTEGER NOT NULL DEFAULT 0 CHECK (attempt_base >= 0)')
    db.exec('ALTER TABLE tasks ADD COLUMN not_before_ms INTEGER NOT NULL DEFAULT 0 CHECK (not_before_ms >= 0)')
    db.exec('ALTER TABLE attempts ADD COLUMN deadline_ms INTEGER CHECK (deadline_ms IS NULL OR deadline_ms >= 0)')
    db.exec('PRAGMA user_version = 6')
  }
}

interface TestContext {
  readonly stateDir: string
  readonly dbPath: string
  readonly db: DatabaseSync
  readonly handle: SupervisorLeaseHandle
}

const activeContexts: TestContext[] = []
const directories: string[] = []

function makeTempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

function safeRemoveDir(dir: string): void {
  const maxRetries = 10
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (err) {
      if (attempt === maxRetries) {
        throw new Error(`Failed to remove directory ${dir} after ${maxRetries} attempts: ${String(err)}`)
      }
      const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
      Atomics.wait(waitBuffer, 0, 0, 50)
    }
  }
}

function cleanupContext(ctx: TestContext): void {
  try {
    ctx.handle.release(Date.now())
  } catch {
    // Release may throw LeaseLostError if displaced, but releases OS lock in finally
  }
  try {
    ctx.db.close()
  } catch {
    // ignore if already closed
  }
}

function setupTestEnv(): TestContext {
  const stateDir = makeTempDir('factory-test-state-')
  const dbPath = join(stateDir, 'state.sqlite')
  let db: DatabaseSync | undefined
  let handle: SupervisorLeaseHandle | undefined
  try {
    db = openStore(dbPath)
    ensureSchemaV6(db)
    handle = acquireSupervisor(db, stateDir, { nowMs: 1000, staleAfterMs: 300000 })
    db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'Test Project', '2026-11-10T00:00:00.000Z')").run()
    db.prepare("INSERT INTO project_config (project_id, repo_path, base_ref, created_at) VALUES ('p1', '/repo', 'main', '2026-11-10T00:00:00.000Z')").run()
    const ctx: TestContext = { stateDir, dbPath, db, handle }
    activeContexts.push(ctx)
    return ctx
  } catch (err) {
    if (handle) {
      try {
        handle.release(Date.now())
      } catch {
        // ignore
      }
    }
    if (db) {
      try {
        db.close()
      } catch {
        // ignore
      }
    }
    throw err
  }
}

function setupCliEnv(): { stateDir: string; repoDir: string; dbPath: string } {
  const stateDir = makeTempDir('factory-cli-state-')
  const repoDir = makeTempDir('factory-cli-repo-')
  createGitRepo(repoDir)
  const initRes = runCli('init', '--state-dir', stateDir, '--repo', repoDir)
  expect(initRes.status).toBe(0)
  const dbPath = join(stateDir, 'state.sqlite')
  const db = new DatabaseSync(dbPath)
  try {
    ensureSchemaV6(db)
  } finally {
    db.close()
  }
  return { stateDir, repoDir, dbPath }
}

afterEach(() => {
  const errors: unknown[] = []
  for (const ctx of activeContexts.splice(0)) {
    try {
      cleanupContext(ctx)
    } catch (err) {
      errors.push(err)
    }
  }
  for (const directory of directories.splice(0)) {
    try {
      safeRemoveDir(directory)
    } catch (err) {
      errors.push(err)
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Cleanup failed to release resources or remove directories')
  }
})

describe('M4-03 task options and apply contract', () => {
  it('CHK-M4-03-a: task create with --scope, --max-attempts, --timeout-ms stores normalized payload and apply writes new columns', () => {
    const { stateDir, dbPath } = setupCliEnv()

    const res = runCli(
      'task',
      'create',
      '--state-dir',
      stateDir,
      '--title',
      'Task with all options',
      '--scope',
      'src/b',
      '--scope',
      'src/a',
      '--max-attempts',
      '5',
      '--timeout-ms',
      '10000',
    )
    expect(res.status).toBe(0)
    const lines = res.stdout.trim().split(/\r?\n/)
    expect(lines[0]).toMatch(new RegExp(`^created ${UUID_REGEX.source.slice(1, -1)}$`, 'i'))
    expect(lines.length).toBeGreaterThanOrEqual(2)
    expect(lines[1]).toMatch(ARABIC_REGEX)
    const cmdId = lines[0]!.slice('created '.length)

    const db = new DatabaseSync(dbPath)
    try {
      const row = db.prepare('SELECT kind, payload_json FROM commands WHERE id = ?').get(cmdId) as { kind: string; payload_json: string } | undefined
      expect(row).toBeDefined()
      expect(row?.kind).toBe('task.create')
      const payload = JSON.parse(row!.payload_json) as {
        title: string
        scope: string[]
        maxAttempts: number
        timeoutMs: number | null
      }
      expect(payload.title).toBe('Task with all options')
      expect(payload.scope).toEqual(['src/a', 'src/b'])
      expect(payload.maxAttempts).toBe(5)
      expect(payload.timeoutMs).toBe(10000)

      const handle = acquireSupervisor(db, stateDir, { nowMs: 2000, staleAfterMs: 300000 })
      try {
        applyPendingCommands(db, handle)
      } finally {
        handle.release(Date.now())
      }

      const outcome = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get(cmdId) as { outcome: string; reason: string | null } | undefined
      expect(outcome).toBeDefined()
      expect(outcome?.outcome).toBe('applied')
      expect(outcome?.reason).toBeNull()

      const task = db.prepare('SELECT id, title, status, scope_json, max_attempts, timeout_ms, attempt_base, not_before_ms FROM tasks WHERE id = ?').get(cmdId) as {
        id: string
        title: string
        status: string
        scope_json: string
        max_attempts: number
        timeout_ms: number | null
        attempt_base: number
        not_before_ms: number
      } | undefined
      expect(task).toBeDefined()
      expect(task?.id).toBe(cmdId)
      expect(task?.title).toBe('Task with all options')
      expect(task?.status).toBe('ready')
      expect(JSON.parse(task!.scope_json)).toEqual(['src/a', 'src/b'])
      expect(task?.max_attempts).toBe(5)
      expect(task?.timeout_ms).toBe(10000)
      expect(task?.attempt_base).toBe(0)
      expect(task?.not_before_ms).toBe(0)
    } finally {
      db.close()
    }
  })

  it('CHK-M4-03-a: task create without optional flags stores defaults and apply writes default columns', () => {
    const { stateDir, dbPath } = setupCliEnv()

    const res = runCli('task', 'create', '--state-dir', stateDir, '--title', 'Task with defaults')
    expect(res.status).toBe(0)
    const lines = res.stdout.trim().split(/\r?\n/)
    expect(lines[0]).toMatch(new RegExp(`^created ${UUID_REGEX.source.slice(1, -1)}$`, 'i'))
    expect(lines.length).toBeGreaterThanOrEqual(2)
    expect(lines[1]).toMatch(ARABIC_REGEX)
    const cmdId = lines[0]!.slice('created '.length)

    const db = new DatabaseSync(dbPath)
    try {
      const row = db.prepare('SELECT payload_json FROM commands WHERE id = ?').get(cmdId) as { payload_json: string }
      const payload = JSON.parse(row.payload_json) as {
        title: string
        scope: string[]
        maxAttempts: number
        timeoutMs: number | null
      }
      expect(payload.title).toBe('Task with defaults')
      expect(payload.scope).toEqual(['.'])
      expect(payload.maxAttempts).toBe(3)
      expect(payload.timeoutMs).toBeNull()

      const handle = acquireSupervisor(db, stateDir, { nowMs: 2000, staleAfterMs: 300000 })
      try {
        applyPendingCommands(db, handle)
      } finally {
        handle.release(Date.now())
      }

      const outcome = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get(cmdId) as { outcome: string; reason: string | null }
      expect(outcome.outcome).toBe('applied')
      expect(outcome.reason).toBeNull()

      const task = db.prepare('SELECT scope_json, max_attempts, timeout_ms, attempt_base, not_before_ms FROM tasks WHERE id = ?').get(cmdId) as {
        scope_json: string
        max_attempts: number
        timeout_ms: number | null
        attempt_base: number
        not_before_ms: number
      }
      expect(JSON.parse(task.scope_json)).toEqual(['.'])
      expect(task.max_attempts).toBe(3)
      expect(task.timeout_ms).toBeNull()
      expect(task.attempt_base).toBe(0)
      expect(task.not_before_ms).toBe(0)
    } finally {
      db.close()
    }
  })

  it('CHK-M4-03-a: task create normalizes scope: covered entries removed and . absorbs all', () => {
    const { stateDir, dbPath } = setupCliEnv()

    // 1. Entry covered by another entry removed (src/a covers src/a/b)
    const res1 = runCli('task', 'create', '--state-dir', stateDir, '--title', 'Covered test', '--scope', 'src/a/b', '--scope', 'src/a')
    expect(res1.status).toBe(0)
    const id1 = res1.stdout.trim().split(/\r?\n/)[0]!.slice('created '.length)

    // 2. '.' absorbs all entries
    const res2 = runCli('task', 'create', '--state-dir', stateDir, '--title', 'Dot absorbs test', '--scope', 'src/a', '--scope', '.')
    expect(res2.status).toBe(0)
    const id2 = res2.stdout.trim().split(/\r?\n/)[0]!.slice('created '.length)

    const db = new DatabaseSync(dbPath)
    try {
      const row1 = db.prepare('SELECT payload_json FROM commands WHERE id = ?').get(id1) as { payload_json: string }
      expect(JSON.parse(row1.payload_json).scope).toEqual(['src/a'])

      const row2 = db.prepare('SELECT payload_json FROM commands WHERE id = ?').get(id2) as { payload_json: string }
      expect(JSON.parse(row2.payload_json).scope).toEqual(['.'])
    } finally {
      db.close()
    }
  })
})

describe('M4-03 CLI validation and reject classes', () => {
  const parseScopeRejectCases: Array<{ label: string; scope: string }> = [
    { label: 'parent directory traversal ../x', scope: '../x' },
    { label: 'parent directory traversal inside path a/../b', scope: 'a/../b' },
    { label: 'current directory segment ./a', scope: './a' },
    { label: 'current directory segment inside path a/./b', scope: 'a/./b' },
    { label: 'backslash a\\b', scope: 'a\\b' },
    { label: '.git root segment', scope: '.git' },
    { label: '.GIT case-insensitive segment', scope: '.GIT' },
    { label: '.git inside path a/.git/b', scope: 'a/.git/b' },
    { label: 'leading slash /abs', scope: '/abs' },
    { label: 'trailing slash dir/', scope: 'dir/' },
    { label: 'empty segment a//b', scope: 'a//b' },
    { label: 'glob asterisk a*', scope: 'a*' },
    { label: 'glob question mark a?', scope: 'a?' },
    { label: 'opening bracket a[b', scope: 'a[b' },
    { label: 'closing bracket a]b', scope: 'a]b' },
    { label: 'colon c:foo', scope: 'c:foo' },
    { label: 'tilde 8.3 short name LONGDI~1', scope: 'LONGDI~1' },
    { label: 'segment ending in dot README.md.', scope: 'README.md.' },
    { label: 'segment starting with space a/ b', scope: 'a/ b' },
    { label: 'segment ending with space dir /a', scope: 'dir /a' },
    { label: 'empty entry', scope: '' },
    { label: 'entry longer than 200 characters', scope: 'a'.repeat(201) },
    { label: 'non-ASCII latin accent in segment é/x', scope: 'é/x' },
    { label: 'non-ASCII latin accent src/é', scope: 'src/é' },
    { label: 'non-ASCII emoji src/🚀', scope: 'src/🚀' },
    { label: 'lone surrogate U+D800', scope: '\uD800' },
    { label: 'control character U+0001', scope: 'src/\u0001' },
    { label: 'control character newline', scope: 'src/\n' },
  ]

  for (const { label, scope } of parseScopeRejectCases) {
    it(`CHK-M4-03-b: invalid --scope (${label}) exits 2 with Arabic usage and writes no commands row`, () => {
      const { stateDir, dbPath } = setupCliEnv()

      const res = runCli('task', 'create', '--state-dir', stateDir, '--title', 'Bad Scope Test', '--scope', scope)
      expect(res.status).toBe(2)
      expect(res.stderr).toMatch(ARABIC_REGEX)

      const db = new DatabaseSync(dbPath)
      try {
        expect(db.prepare('SELECT COUNT(*) as c FROM commands').get()).toEqual({ c: 0 })
      } finally {
        db.close()
      }
    })
  }

  it('CHK-M4-03-b: --scope exceeding 32 entries exits 2 with Arabic usage and writes no commands row', () => {
    const { stateDir, dbPath } = setupCliEnv()
    const scopeArgs: string[] = []
    for (let i = 1; i <= 33; i++) {
      scopeArgs.push('--scope', `dir${i}`)
    }

    const res = runCli('task', 'create', '--state-dir', stateDir, '--title', 'Too Many Scopes', ...scopeArgs)
    expect(res.status).toBe(2)
    expect(res.stderr).toMatch(ARABIC_REGEX)

    const db = new DatabaseSync(dbPath)
    try {
      expect(db.prepare('SELECT COUNT(*) as c FROM commands').get()).toEqual({ c: 0 })
    } finally {
      db.close()
    }
  })

  const invalidNumericCases: Array<{ label: string; flags: string[] }> = [
    { label: '--max-attempts 0', flags: ['--max-attempts', '0'] },
    { label: '--max-attempts 11', flags: ['--max-attempts', '11'] },
    { label: '--max-attempts negative', flags: ['--max-attempts', '-1'] },
    { label: '--max-attempts non-integer string', flags: ['--max-attempts', 'abc'] },
    { label: '--max-attempts float', flags: ['--max-attempts', '3.5'] },
    { label: 'repeated --max-attempts', flags: ['--max-attempts', '3', '--max-attempts', '4'] },
    { label: '--timeout-ms 999', flags: ['--timeout-ms', '999'] },
    { label: '--timeout-ms 86400001', flags: ['--timeout-ms', '86400001'] },
    { label: '--timeout-ms 0', flags: ['--timeout-ms', '0'] },
    { label: '--timeout-ms non-integer string', flags: ['--timeout-ms', 'abc'] },
    { label: '--timeout-ms float', flags: ['--timeout-ms', '5000.5'] },
    { label: 'repeated --timeout-ms', flags: ['--timeout-ms', '2000', '--timeout-ms', '3000'] },
    { label: 'repeated --title', flags: ['--title', 'title1', '--title', 'title2'] },
    {
      label: 'repeated --command-id',
      flags: [
        '--command-id',
        '00000000-0000-4000-8000-000000000001',
        '--command-id',
        '00000000-0000-4000-8000-000000000002',
      ],
    },
    { label: 'repeated --state-dir with same directory', flags: ['--state-dir', '__SAME_STATE_DIR__'] },
  ]

  for (const { label, flags } of invalidNumericCases) {
    it(`CHK-M4-03-b: invalid flag (${label}) exits 2 with Arabic usage and writes no commands row`, () => {
      const { stateDir, dbPath } = setupCliEnv()

      const resolvedFlags = flags.map((f) => (f === '__SAME_STATE_DIR__' ? stateDir : f))
      const baseArgs = resolvedFlags.includes('--title') ? [] : ['--title', 'Flag Test']
      const res = runCli('task', 'create', '--state-dir', stateDir, ...baseArgs, ...resolvedFlags)
      expect(res.status).toBe(2)
      expect(res.stderr).toMatch(ARABIC_REGEX)

      const db = new DatabaseSync(dbPath)
      try {
        expect(db.prepare('SELECT COUNT(*) as c FROM commands').get()).toEqual({ c: 0 })
      } finally {
        db.close()
      }
    })
  }

  it('CHK-M4-03-b: repeated single-value flag --state-dir with same directory exits 2 with Arabic usage and writes no commands row', () => {
    const { stateDir, dbPath } = setupCliEnv()

    const res = runCli('task', 'create', '--state-dir', stateDir, '--state-dir', stateDir, '--title', 'Repeated State Dir')
    expect(res.status).toBe(2)
    expect(res.stderr).toMatch(ARABIC_REGEX)

    const db = new DatabaseSync(dbPath)
    try {
      expect(db.prepare('SELECT COUNT(*) as c FROM commands').get()).toEqual({ c: 0 })
    } finally {
      db.close()
    }
  })
})

describe('M4-03 CLI command-id duplicate and conflict rules', () => {
  it('CHK-M4-03-c: same --command-id with same normalized payload reports duplicate; different scope or options exits 1', () => {
    const { stateDir, dbPath } = setupCliEnv()
    const customId = 'b1b2c3d4-e5f6-4789-abcd-ef0123456789'

    // 1. Initial creation
    const res1 = runCli(
      'task',
      'create',
      '--state-dir',
      stateDir,
      '--title',
      'Duplicate test',
      '--scope',
      'src/b',
      '--scope',
      'src/a',
      '--command-id',
      customId,
    )
    expect(res1.status).toBe(0)
    const lines1 = res1.stdout.trim().split(/\r?\n/)
    expect(lines1[0]).toBe(`created ${customId}`)
    expect(lines1[1]).toMatch(ARABIC_REGEX)

    // 2. Re-run with same normalized payload (different order + duplicate entry) -> duplicate
    const res2 = runCli(
      'task',
      'create',
      '--state-dir',
      stateDir,
      '--title',
      'Duplicate test',
      '--scope',
      'src/a',
      '--scope',
      'src/b',
      '--scope',
      'src/a',
      '--command-id',
      customId,
    )
    expect(res2.status).toBe(0)
    const lines2 = res2.stdout.trim().split(/\r?\n/)
    expect(lines2[0]).toBe(`duplicate ${customId}`)
    expect(lines2[1]).toMatch(ARABIC_REGEX)

    // Verify commands table still has exactly 1 row
    const db = new DatabaseSync(dbPath)
    try {
      expect(db.prepare('SELECT COUNT(*) as c FROM commands WHERE id = ?').get(customId)).toEqual({ c: 1 })
    } finally {
      db.close()
    }

    // 3. Re-run with different scope -> exit 1
    const res3 = runCli(
      'task',
      'create',
      '--state-dir',
      stateDir,
      '--title',
      'Duplicate test',
      '--scope',
      'other/path',
      '--command-id',
      customId,
    )
    expect(res3.status).toBe(1)
    expect(res3.stderr).toMatch(ARABIC_REGEX)

    // 4. Re-run with different maxAttempts -> exit 1
    const res4 = runCli(
      'task',
      'create',
      '--state-dir',
      stateDir,
      '--title',
      'Duplicate test',
      '--scope',
      'src/a',
      '--scope',
      'src/b',
      '--max-attempts',
      '5',
      '--command-id',
      customId,
    )
    expect(res4.status).toBe(1)
    expect(res4.stderr).toMatch(ARABIC_REGEX)

    // 5. Re-run with different timeoutMs -> exit 1
    const res5 = runCli(
      'task',
      'create',
      '--state-dir',
      stateDir,
      '--title',
      'Duplicate test',
      '--scope',
      'src/a',
      '--scope',
      'src/b',
      '--timeout-ms',
      '5000',
      '--command-id',
      customId,
    )
    expect(res5.status).toBe(1)
    expect(res5.stderr).toMatch(ARABIC_REGEX)
  })
})

describe('M4-03 command apply payload validation', () => {
  it('CHK-M4-03-d: legacy {"title"} command row applied with defaults; invalid scope or out-of-range numbers rejected with reason, no task', () => {
    const ctx = setupTestEnv()
    const { db, handle } = ctx

    // 1. Legacy M3 payload without new keys
    appendCommand(db, {
      id: 'cmd-legacy-1',
      projectId: 'p1',
      kind: 'task.create',
      payloadJson: JSON.stringify({ title: 'Legacy M3 Task' }),
      createdAt: '2026-11-10T00:01:00.000Z',
    })

    // 2. Invalid payloads inserted directly to simulate legacy/invalid DB records
    const invalidPayloads: Array<{ id: string; payload?: unknown; payloadJson?: string; desc: string }> = [
      { id: 'cmd-bad-scope-1', payload: { title: 'Bad 1', scope: ['../escape'], maxAttempts: 3, timeoutMs: null }, desc: 'invalid scope path' },
      { id: 'cmd-bad-scope-2', payload: { title: 'Bad 2', scope: 'not-an-array', maxAttempts: 3, timeoutMs: null }, desc: 'scope not an array' },
      { id: 'cmd-bad-scope-3', payload: { title: 'Bad 3', scope: [], maxAttempts: 3, timeoutMs: null }, desc: 'empty scope array' },
      { id: 'cmd-bad-scope-4', payload: { title: 'Bad 4', scope: Array.from({ length: 33 }, (_, i) => `s${i}`), maxAttempts: 3, timeoutMs: null }, desc: 'scope with 33 entries' },
      { id: 'cmd-bad-scope-tilde', payload: { title: 'Bad tilde', scope: ['LONGDI~1'], maxAttempts: 3, timeoutMs: null }, desc: 'scope with tilde' },
      { id: 'cmd-bad-scope-dot-end', payload: { title: 'Bad dot end', scope: ['README.md.'], maxAttempts: 3, timeoutMs: null }, desc: 'scope with segment ending in dot' },
      { id: 'cmd-bad-scope-accent', payload: { title: 'Bad accent', scope: ['é/x'], maxAttempts: 3, timeoutMs: null }, desc: 'scope with non-ASCII é/x' },
      {
        id: 'cmd-bad-scope-lone-surrogate',
        payloadJson: '{"title":"Bad surrogate","scope":["src/\\uD800"],"maxAttempts":3,"timeoutMs":null}',
        desc: 'scope with JSON-escaped lone surrogate',
      },
      { id: 'cmd-bad-max-1', payload: { title: 'Bad 5', scope: ['.'], maxAttempts: 0, timeoutMs: null }, desc: 'maxAttempts 0' },
      { id: 'cmd-bad-max-2', payload: { title: 'Bad 6', scope: ['.'], maxAttempts: 11, timeoutMs: null }, desc: 'maxAttempts 11' },
      { id: 'cmd-bad-max-3', payload: { title: 'Bad 7', scope: ['.'], maxAttempts: 'three', timeoutMs: null }, desc: 'maxAttempts non-integer' },
      { id: 'cmd-bad-max-4', payload: { title: 'Bad 8', scope: ['.'], maxAttempts: 2.5, timeoutMs: null }, desc: 'maxAttempts float' },
      { id: 'cmd-bad-timeout-1', payload: { title: 'Bad 9', scope: ['.'], maxAttempts: 3, timeoutMs: 999 }, desc: 'timeoutMs 999' },
      { id: 'cmd-bad-timeout-2', payload: { title: 'Bad 10', scope: ['.'], maxAttempts: 3, timeoutMs: 86400001 }, desc: 'timeoutMs 86400001' },
      { id: 'cmd-bad-timeout-3', payload: { title: 'Bad 11', scope: ['.'], maxAttempts: 3, timeoutMs: 'short' }, desc: 'timeoutMs string' },
      { id: 'cmd-bad-timeout-4', payload: { title: 'Bad 12', scope: ['.'], maxAttempts: 3, timeoutMs: 5000.5 }, desc: 'timeoutMs float' },
      { id: 'cmd-bad-title-1', payload: { scope: ['.'], maxAttempts: 3, timeoutMs: null }, desc: 'missing title' },
      { id: 'cmd-bad-title-2', payload: { title: '   ', scope: ['.'], maxAttempts: 3, timeoutMs: null }, desc: 'blank title' },
      { id: 'cmd-bad-non-object-1', payload: 'just a string', desc: 'payload is JSON string' },
      { id: 'cmd-bad-non-object-2', payload: 12345, desc: 'payload is JSON number' },
    ]

    let timeIndex = 2
    for (const item of invalidPayloads) {
      appendCommand(db, {
        id: item.id,
        projectId: 'p1',
        kind: 'task.create',
        payloadJson: item.payloadJson ?? JSON.stringify(item.payload),
        createdAt: `2026-11-10T00:${String(Math.floor(timeIndex / 60)).padStart(2, '0')}:${String(timeIndex % 60).padStart(2, '0')}.000Z`,
      })
      timeIndex++
    }

    // 3. Valid command with unnormalized scope (unsorted, duplicate, covered entries) inserted directly
    appendCommand(db, {
      id: 'cmd-unnormalized-scope-1',
      projectId: 'p1',
      kind: 'task.create',
      payloadJson: JSON.stringify({
        title: 'Unnormalized Scope Task',
        scope: ['src/a/b', 'src/a', 'b', 'b', 'a'],
        maxAttempts: 4,
        timeoutMs: 5000,
      }),
      createdAt: `2026-11-10T00:${String(Math.floor(timeIndex / 60)).padStart(2, '0')}:${String(timeIndex % 60).padStart(2, '0')}.000Z`,
    })
    timeIndex++

    // 4. Valid command with unnormalized scope where '.' absorbs all entries
    appendCommand(db, {
      id: 'cmd-unnormalized-scope-dot',
      projectId: 'p1',
      kind: 'task.create',
      payloadJson: JSON.stringify({
        title: 'Dot Absorbs Unnormalized Task',
        scope: ['z', 'src/a', '.', 'a'],
        maxAttempts: 3,
        timeoutMs: null,
      }),
      createdAt: `2026-11-10T00:${String(Math.floor(timeIndex / 60)).padStart(2, '0')}:${String(timeIndex % 60).padStart(2, '0')}.000Z`,
    })
    timeIndex++

    applyPendingCommands(db, handle)

    // Legacy command: applied with defaults
    const legacyOutcome = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get('cmd-legacy-1') as { outcome: string; reason: string | null }
    expect(legacyOutcome).toBeDefined()
    expect(legacyOutcome.outcome).toBe('applied')
    expect(legacyOutcome.reason).toBeNull()

    const legacyTask = db.prepare('SELECT title, status, scope_json, max_attempts, timeout_ms, attempt_base, not_before_ms FROM tasks WHERE id = ?').get('cmd-legacy-1') as {
      title: string
      status: string
      scope_json: string
      max_attempts: number
      timeout_ms: number | null
      attempt_base: number
      not_before_ms: number
    }
    expect(legacyTask.title).toBe('Legacy M3 Task')
    expect(legacyTask.status).toBe('ready')
    expect(JSON.parse(legacyTask.scope_json)).toEqual(['.'])
    expect(legacyTask.max_attempts).toBe(3)
    expect(legacyTask.timeout_ms).toBeNull()
    expect(legacyTask.attempt_base).toBe(0)
    expect(legacyTask.not_before_ms).toBe(0)

    // Invalid payloads: rejected with reason, no task row created
    for (const item of invalidPayloads) {
      const outcome = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get(item.id) as { outcome: string; reason: string | null }
      expect(outcome, `Expected outcome for ${item.id} (${item.desc})`).toBeDefined()
      expect(outcome.outcome, `Expected outcome rejected for ${item.id} (${item.desc})`).toBe('rejected')
      expect(typeof outcome.reason, `Expected non-empty reason for ${item.id} (${item.desc})`).toBe('string')
      expect(outcome.reason!.trim().length).toBeGreaterThan(0)

      const taskCount = db.prepare('SELECT COUNT(*) as c FROM tasks WHERE id = ?').get(item.id) as { c: number }
      expect(taskCount.c, `No task should be created for ${item.id} (${item.desc})`).toBe(0)
    }

    // Direct command with unnormalized scope: apply normalizes scope_json (unsorted, duplicates, covered resolved)
    const unnormOutcome = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get('cmd-unnormalized-scope-1') as { outcome: string; reason: string | null }
    expect(unnormOutcome).toBeDefined()
    expect(unnormOutcome.outcome).toBe('applied')
    expect(unnormOutcome.reason).toBeNull()

    const unnormTask = db.prepare('SELECT scope_json, max_attempts, timeout_ms FROM tasks WHERE id = ?').get('cmd-unnormalized-scope-1') as {
      scope_json: string
      max_attempts: number
      timeout_ms: number | null
    }
    expect(unnormTask).toBeDefined()
    expect(JSON.parse(unnormTask.scope_json)).toEqual(['a', 'b', 'src/a'])
    expect(unnormTask.max_attempts).toBe(4)
    expect(unnormTask.timeout_ms).toBe(5000)

    // Direct command with unnormalized scope containing '.': apply normalizes scope_json to ['.']
    const dotOutcome = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get('cmd-unnormalized-scope-dot') as { outcome: string; reason: string | null }
    expect(dotOutcome).toBeDefined()
    expect(dotOutcome.outcome).toBe('applied')
    expect(dotOutcome.reason).toBeNull()

    const dotTask = db.prepare('SELECT scope_json FROM tasks WHERE id = ?').get('cmd-unnormalized-scope-dot') as { scope_json: string }
    expect(dotTask).toBeDefined()
    expect(JSON.parse(dotTask.scope_json)).toEqual(['.'])
  })
})

describe('M4-03 task retry command and apply semantics', () => {
  it('CHK-M4-03-e: task retry CLI records command and enforces duplicate and conflict rules', () => {
    const { stateDir, dbPath } = setupCliEnv()
    const customId = 'e1e2e3e4-1111-4111-8111-123456789abc'

    // Initial task retry
    const res1 = runCli('task', 'retry', '--state-dir', stateDir, '--task', 'task-target-1', '--command-id', customId)
    expect(res1.status).toBe(0)
    const lines1 = res1.stdout.trim().split(/\r?\n/)
    expect(lines1[0]).toBe(`created ${customId}`)
    expect(lines1[1]).toMatch(ARABIC_REGEX)

    const db = new DatabaseSync(dbPath)
    try {
      const row = db.prepare('SELECT kind, payload_json FROM commands WHERE id = ?').get(customId) as { kind: string; payload_json: string }
      expect(row.kind).toBe('task.retry')
      expect(JSON.parse(row.payload_json)).toEqual({ taskId: 'task-target-1' })
    } finally {
      db.close()
    }

    // Re-run with exact same taskId -> duplicate
    const res2 = runCli('task', 'retry', '--state-dir', stateDir, '--task', 'task-target-1', '--command-id', customId)
    expect(res2.status).toBe(0)
    const lines2 = res2.stdout.trim().split(/\r?\n/)
    expect(lines2[0]).toBe(`duplicate ${customId}`)
    expect(lines2[1]).toMatch(ARABIC_REGEX)

    // Re-run with different taskId -> exit 1
    const res3 = runCli('task', 'retry', '--state-dir', stateDir, '--task', 'task-different', '--command-id', customId)
    expect(res3.status).toBe(1)
    expect(res3.stderr).toMatch(ARABIC_REGEX)

    // Argument errors -> exit 2
    const res4 = runCli('task', 'retry', '--state-dir', stateDir)
    expect(res4.status).toBe(2)
    expect(res4.stderr).toMatch(ARABIC_REGEX)

    const res5 = runCli('task', 'retry', '--state-dir', stateDir, '--task', 'task-1', '--task', 'task-2')
    expect(res5.status).toBe(2)
    expect(res5.stderr).toMatch(ARABIC_REGEX)

    const res6 = runCli('task', 'retry', '--state-dir', stateDir, '--state-dir', stateDir, '--task', 'task-1')
    expect(res6.status).toBe(2)
    expect(res6.stderr).toMatch(ARABIC_REGEX)
  })

  it('CHK-M4-03-e: apply task.retry on failed task sets ready, attempt_base = max(attempt_no), not_before_ms 0; other statuses rejected', () => {
    const ctx = setupTestEnv()
    const { db, handle } = ctx

    // 1. Failed task with attempts 1 and 2 (MAX attempt_no is 2)
    db.prepare(`
      INSERT INTO commands (id, project_id, kind, payload_json, created_at)
      VALUES ('c-fail-attempts', 'p1', 'task.create', '{"title":"Failed with attempts"}', '2026-11-10T00:00:00.000Z')
    `).run()
    db.prepare(`
      INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at)
      VALUES ('c-fail-attempts', 'applied', null, 1, '2026-11-10T00:00:00.500Z')
    `).run()
    db.prepare(`
      INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, attempt_base, not_before_ms)
      VALUES ('task-fail-attempts', 'p1', 'c-fail-attempts', 'Failed with attempts', 'failed', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:01.000Z', 0, 5000)
    `).run()
    db.prepare(`
      INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at)
      VALUES
        ('att-1', 'task-fail-attempts', 1, 'failed', 75, 'transient', 1, '2026-11-10T00:00:01.000Z', '2026-11-10T00:00:02.000Z'),
        ('att-2', 'task-fail-attempts', 2, 'failed', 1, 'exit', 1, '2026-11-10T00:00:03.000Z', '2026-11-10T00:00:04.000Z')
    `).run()

    // 2. Failed task with 0 attempts (MAX attempt_no is 0)
    db.prepare(`
      INSERT INTO commands (id, project_id, kind, payload_json, created_at)
      VALUES ('c-fail-no-attempts', 'p1', 'task.create', '{"title":"Failed no attempts"}', '2026-11-10T00:00:00.000Z')
    `).run()
    db.prepare(`
      INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at)
      VALUES ('c-fail-no-attempts', 'applied', null, 1, '2026-11-10T00:00:00.500Z')
    `).run()
    db.prepare(`
      INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, attempt_base, not_before_ms)
      VALUES ('task-fail-no-attempts', 'p1', 'c-fail-no-attempts', 'Failed no attempts', 'failed', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:01.000Z', 0, 1000)
    `).run()

    // 3. Other statuses: done, dropped, progress, ready, waiting, blocked
    const otherStatuses = ['done', 'dropped', 'progress', 'ready', 'waiting', 'blocked'] as const
    for (const st of otherStatuses) {
      db.prepare(`
        INSERT INTO commands (id, project_id, kind, payload_json, created_at)
        VALUES ('c-st-${st}', 'p1', 'task.create', '{"title":"Task ${st}"}', '2026-11-10T00:00:00.000Z')
      `).run()
      db.prepare(`
        INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at)
        VALUES ('c-st-${st}', 'applied', null, 1, '2026-11-10T00:00:00.500Z')
      `).run()
      db.prepare(`
        INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, attempt_base, not_before_ms)
        VALUES ('task-${st}', 'p1', 'c-st-${st}', 'Task ${st}', '${st}', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:01.000Z', 0, 0)
      `).run()
    }

    // Enqueue retry commands
    appendCommand(db, {
      id: 'retry-fail-attempts',
      projectId: 'p1',
      kind: 'task.retry',
      payloadJson: JSON.stringify({ taskId: 'task-fail-attempts' }),
      createdAt: '2026-11-10T00:01:00.000Z',
    })
    appendCommand(db, {
      id: 'retry-fail-no-attempts',
      projectId: 'p1',
      kind: 'task.retry',
      payloadJson: JSON.stringify({ taskId: 'task-fail-no-attempts' }),
      createdAt: '2026-11-10T00:01:01.000Z',
    })
    for (const st of otherStatuses) {
      appendCommand(db, {
        id: `retry-${st}`,
        projectId: 'p1',
        kind: 'task.retry',
        payloadJson: JSON.stringify({ taskId: `task-${st}` }),
        createdAt: '2026-11-10T00:01:02.000Z',
      })
    }
    appendCommand(db, {
      id: 'retry-unknown',
      projectId: 'p1',
      kind: 'task.retry',
      payloadJson: JSON.stringify({ taskId: 'task-does-not-exist' }),
      createdAt: '2026-11-10T00:01:03.000Z',
    })

    applyPendingCommands(db, handle)

    // Verify task-fail-attempts: status ready, attempt_base 2, not_before_ms 0, applied
    const outcome1 = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get('retry-fail-attempts') as { outcome: string; reason: string | null }
    expect(outcome1.outcome).toBe('applied')
    expect(outcome1.reason).toBeNull()
    const task1 = db.prepare('SELECT status, attempt_base, not_before_ms FROM tasks WHERE id = ?').get('task-fail-attempts') as { status: string; attempt_base: number; not_before_ms: number }
    expect(task1.status).toBe('ready')
    expect(task1.attempt_base).toBe(2)
    expect(task1.not_before_ms).toBe(0)

    // Verify task-fail-no-attempts: status ready, attempt_base 0, not_before_ms 0, applied
    const outcome2 = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get('retry-fail-no-attempts') as { outcome: string; reason: string | null }
    expect(outcome2.outcome).toBe('applied')
    expect(outcome2.reason).toBeNull()
    const task2 = db.prepare('SELECT status, attempt_base, not_before_ms FROM tasks WHERE id = ?').get('task-fail-no-attempts') as { status: string; attempt_base: number; not_before_ms: number }
    expect(task2.status).toBe('ready')
    expect(task2.attempt_base).toBe(0)
    expect(task2.not_before_ms).toBe(0)

    // Verify other statuses: rejected, task status unchanged
    for (const st of otherStatuses) {
      const outcome = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get(`retry-${st}`) as { outcome: string; reason: string | null }
      expect(outcome.outcome).toBe('rejected')
      expect(typeof outcome.reason).toBe('string')
      expect(outcome.reason!.trim().length).toBeGreaterThan(0)
      const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(`task-${st}`) as { status: string }
      expect(task.status).toBe(st)
    }

    // Verify unknown task: rejected
    const outcomeUnknown = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get('retry-unknown') as { outcome: string; reason: string | null }
    expect(outcomeUnknown.outcome).toBe('rejected')
    expect(typeof outcomeUnknown.reason).toBe('string')
    expect(outcomeUnknown.reason!.trim().length).toBeGreaterThan(0)
  })
})

describe('M4-03 property test', () => {
  it('CHK-M4-03-f: random create/retry/kill command sequences with random apply runs give at most one outcome per command and attempt_base never decreases', () => {
    type Action =
      | { readonly type: 'create'; readonly idSlot: number; readonly title: string; readonly scope: string[]; readonly maxAttempts: number; readonly timeoutMs: number | null }
      | { readonly type: 'retry'; readonly idSlot: number; readonly targetSlot: number }
      | { readonly type: 'kill'; readonly idSlot: number; readonly targetSlot: number }
      | { readonly type: 'advance'; readonly targetSlot: number; readonly newStatus: 'ready' | 'progress' | 'failed' | 'done'; readonly addAttempt: boolean }
      | { readonly type: 'apply' }

    const taskIds = ['prop-task-1', 'prop-task-2', 'prop-task-3']

    const actionArbitrary: fc.Arbitrary<Action> = fc.oneof(
      fc.record({
        type: fc.constant('create' as const),
        idSlot: fc.integer({ min: 0, max: taskIds.length - 1 }),
        title: fc.string({ minLength: 1, maxLength: 15 }),
        scope: fc.constantFrom<string[]>(['.'], ['src'], ['src/a', 'src/b']),
        maxAttempts: fc.integer({ min: 1, max: 10 }),
        timeoutMs: fc.constantFrom<number | null>(null, 2000, 10000),
      }),
      fc.record({
        type: fc.constant('retry' as const),
        idSlot: fc.integer({ min: 0, max: taskIds.length - 1 }),
        targetSlot: fc.integer({ min: 0, max: taskIds.length - 1 }),
      }),
      fc.record({
        type: fc.constant('kill' as const),
        idSlot: fc.integer({ min: 0, max: taskIds.length - 1 }),
        targetSlot: fc.integer({ min: 0, max: taskIds.length - 1 }),
      }),
      fc.record({
        type: fc.constant('advance' as const),
        targetSlot: fc.integer({ min: 0, max: taskIds.length - 1 }),
        newStatus: fc.constantFrom<'ready' | 'progress' | 'failed' | 'done'>('ready', 'progress', 'failed', 'done'),
        addAttempt: fc.boolean(),
      }),
      fc.record({
        type: fc.constant('apply' as const),
      }),
    )

    fc.assert(
      fc.property(fc.array(actionArbitrary, { minLength: 4, maxLength: 16 }), (actions) => {
        const stateDir = makeTempDir('factory-prop-state-')
        const dbPath = join(stateDir, 'state.sqlite')
        let db: DatabaseSync | undefined
        let handle: SupervisorLeaseHandle | undefined

        try {
          db = openStore(dbPath)
          ensureSchemaV6(db)
          handle = acquireSupervisor(db, stateDir, { nowMs: 1000, staleAfterMs: 300000 })
          db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'Prop Project', '2026-11-10T00:00:00.000Z')").run()
          db.prepare("INSERT INTO project_config (project_id, repo_path, base_ref, created_at) VALUES ('p1', '/repo', 'main', '2026-11-10T00:00:00.000Z')").run()

          const lastAttemptBase = new Map<string, number>()
          const createdCommandExpectedScope = new Map<string, string[]>()
          let timeSeq = 1
          let attemptCounter = 1

          // Guarantee an exercised retry that raises attempt_base before checking subsequent monotonicity
          const seedTaskId = 'prop-task-seed'
          appendCommand(db, {
            id: seedTaskId,
            projectId: 'p1',
            kind: 'task.create',
            payloadJson: JSON.stringify({
              title: 'Guaranteed Seed Task',
              scope: ['src'],
              maxAttempts: 5,
              timeoutMs: null,
            }),
            createdAt: '2026-11-10T00:00:01.000Z',
          })
          applyPendingCommands(db, handle)

          // Seed task fails with 2 attempts
          db.prepare("UPDATE tasks SET status = 'failed', updated_at = '2026-11-10T00:00:02.000Z' WHERE id = ?").run(seedTaskId)
          db.prepare(`
            INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at)
            VALUES ('att-seed-1', ?, 1, 'failed', 75, 'transient', 1, '2026-11-10T00:00:02.000Z', '2026-11-10T00:00:02.100Z')
          `).run(seedTaskId)
          db.prepare(`
            INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at)
            VALUES ('att-seed-2', ?, 2, 'failed', 75, 'transient', 1, '2026-11-10T00:00:02.200Z', '2026-11-10T00:00:02.300Z')
          `).run(seedTaskId)

          // Retry the seed task
          appendCommand(db, {
            id: 'cmd-seed-retry',
            projectId: 'p1',
            kind: 'task.retry',
            payloadJson: JSON.stringify({ taskId: seedTaskId }),
            createdAt: '2026-11-10T00:00:03.000Z',
          })
          applyPendingCommands(db, handle)

          const seedOutcome = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get('cmd-seed-retry') as { outcome: string; reason: string | null }
          expect(seedOutcome.outcome).toBe('applied')
          expect(seedOutcome.reason).toBeNull()

          const seedTask = db.prepare('SELECT status, attempt_base FROM tasks WHERE id = ?').get(seedTaskId) as { status: string; attempt_base: number }
          expect(seedTask.status).toBe('ready')
          expect(seedTask.attempt_base).toBe(2)
          lastAttemptBase.set(seedTaskId, 2)
          timeSeq = 10

          for (const action of actions) {
            const timestamp = `2026-11-10T00:${String(Math.floor(timeSeq / 60)).padStart(2, '0')}:${String(timeSeq % 60).padStart(2, '0')}.000Z`
            timeSeq++

            if (action.type === 'create') {
              const cmdId = taskIds[action.idSlot]!
              try {
                appendCommand(db, {
                  id: cmdId,
                  projectId: 'p1',
                  kind: 'task.create',
                  payloadJson: JSON.stringify({
                    title: action.title,
                    scope: action.scope,
                    maxAttempts: action.maxAttempts,
                    timeoutMs: action.timeoutMs,
                  }),
                  createdAt: timestamp,
                })
                if (!createdCommandExpectedScope.has(cmdId)) {
                  createdCommandExpectedScope.set(cmdId, action.scope)
                }
              } catch (err) {
                if (err instanceof CommandConflictError) {
                  // Expected when same command id is appended with different payload
                } else {
                  throw err
                }
              }
            } else if (action.type === 'retry') {
              const cmdId = `retry-${timeSeq}`
              const targetTaskId = action.targetSlot === 0 ? seedTaskId : taskIds[action.targetSlot]!
              try {
                appendCommand(db, {
                  id: cmdId,
                  projectId: 'p1',
                  kind: 'task.retry',
                  payloadJson: JSON.stringify({ taskId: targetTaskId }),
                  createdAt: timestamp,
                })
              } catch (err) {
                if (err instanceof CommandConflictError) {
                  // Expected conflict
                } else {
                  throw err
                }
              }
            } else if (action.type === 'kill') {
              const cmdId = `kill-${timeSeq}`
              const targetTaskId = action.targetSlot === 0 ? seedTaskId : taskIds[action.targetSlot]!
              try {
                appendCommand(db, {
                  id: cmdId,
                  projectId: 'p1',
                  kind: 'task.kill',
                  payloadJson: JSON.stringify({ taskId: targetTaskId }),
                  createdAt: timestamp,
                })
              } catch (err) {
                if (err instanceof CommandConflictError) {
                  // Expected conflict
                } else {
                  throw err
                }
              }
            } else if (action.type === 'advance') {
              const targetTaskId = action.targetSlot === 0 ? seedTaskId : taskIds[action.targetSlot]!
              const taskRow = db.prepare('SELECT status FROM tasks WHERE id = ?').get(targetTaskId) as { status: string } | undefined
              if (taskRow) {
                db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(action.newStatus, timestamp, targetTaskId)
                if (action.addAttempt) {
                  const maxAtt = (db.prepare('SELECT MAX(attempt_no) as m FROM attempts WHERE task_id = ?').get(targetTaskId) as { m: number | null }).m ?? 0
                  const nextAtt = maxAtt + 1
                  db.prepare(`
                    INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at)
                    VALUES (?, ?, ?, 'failed', 75, 'transient', 1, ?, ?)
                  `).run(`att-${attemptCounter++}`, targetTaskId, nextAtt, timestamp, timestamp)
                }
              }
            } else if (action.type === 'apply') {
              applyPendingCommands(db, handle)

              // Verify invariant 1: at most one outcome per command in command_outcomes
              const outcomeCounts = db.prepare(`
                SELECT command_id, COUNT(*) as c FROM command_outcomes GROUP BY command_id HAVING c > 1
              `).all() as Array<{ command_id: string; c: number }>
              expect(outcomeCounts).toHaveLength(0)

              // Verify invariant 2: attempt_base never decreases
              const tasks = db.prepare('SELECT id, attempt_base, scope_json, max_attempts FROM tasks').all() as Array<{
                id: string
                attempt_base: number
                scope_json: string
                max_attempts: number
              }>
              for (const t of tasks) {
                const prev = lastAttemptBase.get(t.id) ?? 0
                expect(t.attempt_base).toBeGreaterThanOrEqual(prev)
                lastAttemptBase.set(t.id, t.attempt_base)

                // Additional invariant checks: max_attempts between 1 and 10, valid json
                expect(t.max_attempts).toBeGreaterThanOrEqual(1)
                expect(t.max_attempts).toBeLessThanOrEqual(10)
                expect(Array.isArray(JSON.parse(t.scope_json))).toBe(true)

                // Verify task written scope matches normalized payload
                const expectedScope = createdCommandExpectedScope.get(t.id)
                if (expectedScope) {
                  const normalizedExpected = expectedScope.includes('.') ? ['.'] : expectedScope
                  expect(JSON.parse(t.scope_json)).toEqual(normalizedExpected)
                }
              }
            }
          }

          // Final apply to drain any remaining commands
          applyPendingCommands(db, handle)

          // Assert final command/outcome correspondence
          const allCommands = db.prepare('SELECT id FROM commands ORDER BY id').all() as Array<{ id: string }>
          const allOutcomes = db.prepare('SELECT command_id, outcome, reason FROM command_outcomes ORDER BY command_id').all() as Array<{
            command_id: string
            outcome: string
            reason: string | null
          }>

          expect(allCommands.length).toBeGreaterThan(0)
          expect(allOutcomes.length).toBe(allCommands.length)
          const commandIdSet = new Set(allCommands.map((c) => c.id))
          const outcomeIdSet = new Set(allOutcomes.map((o) => o.command_id))
          expect(outcomeIdSet).toEqual(commandIdSet)

          const finalOutcomeCounts = db.prepare(`
            SELECT command_id, COUNT(*) as c FROM command_outcomes GROUP BY command_id HAVING c > 1
          `).all() as Array<{ command_id: string; c: number }>
          expect(finalOutcomeCounts).toHaveLength(0)

          for (const o of allOutcomes) {
            expect(['applied', 'rejected']).toContain(o.outcome)
            if (o.outcome === 'rejected') {
              expect(typeof o.reason).toBe('string')
              expect(o.reason!.trim().length).toBeGreaterThan(0)
            } else {
              expect(o.reason).toBeNull()
            }
          }

          const finalTasks = db.prepare('SELECT id, attempt_base, scope_json FROM tasks').all() as Array<{
            id: string
            attempt_base: number
            scope_json: string
          }>
          expect(finalTasks.length).toBeGreaterThan(0)

          for (const t of finalTasks) {
            const prev = lastAttemptBase.get(t.id) ?? 0
            expect(t.attempt_base).toBeGreaterThanOrEqual(prev)
            const expectedScope = createdCommandExpectedScope.get(t.id)
            if (expectedScope) {
              const normalizedExpected = expectedScope.includes('.') ? ['.'] : expectedScope
              expect(JSON.parse(t.scope_json)).toEqual(normalizedExpected)
            }
          }

          // Invariant: guaranteed retry raised attempt_base > 0 and it remained monotonic throughout
          expect(lastAttemptBase.get(seedTaskId)).toBeGreaterThanOrEqual(2)
        } finally {
          if (handle) {
            try {
              handle.release(Date.now())
            } catch {
              // ignore
            }
          }
          if (db) {
            try {
              db.close()
            } catch {
              // ignore
            }
          }
        }
      }),
      { numRuns: 20 },
    )
  }, 60000)
})
