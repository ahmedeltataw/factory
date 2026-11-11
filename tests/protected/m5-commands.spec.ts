import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { applyPendingCommands } from '../../supervisor/src/app/apply-commands.ts'
import { appendCommand, CommandConflictError } from '../../supervisor/src/app/commands.ts'
import { openStore } from '../../supervisor/src/app/store.ts'
import { acquireSupervisor, type SupervisorLeaseHandle } from '../../supervisor/src/app/supervisor-lease.ts'
import { parseDeps } from '../../supervisor/src/core/graph.ts'

const ARABIC_REGEX = /[\u0600-\u06ff]/
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const PHASES = ['intake', 'development', 'qa', 'devops', 'handover'] as const
type PhaseName = (typeof PHASES)[number]

function phaseOrd(name: string): number {
  switch (name) {
    case 'intake':
      return 1
    case 'development':
      return 2
    case 'qa':
      return 3
    case 'devops':
      return 4
    case 'handover':
      return 5
    default:
      return 0
  }
}

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

function ensureSchemaV7(db: DatabaseSync): void {
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
  if (v < 7) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS phases (
        project_id TEXT NOT NULL REFERENCES projects(id),
        name TEXT NOT NULL CHECK (name IN ('intake','development','qa','devops','handover')),
        ord INTEGER NOT NULL CHECK (ord BETWEEN 1 AND 5),
        status TEXT NOT NULL CHECK (status IN ('locked','open','done')),
        opened_at TEXT,
        closed_at TEXT,
        PRIMARY KEY (project_id, name),
        UNIQUE (project_id, ord),
        CHECK (ord = CASE name WHEN 'intake' THEN 1 WHEN 'development' THEN 2 WHEN 'qa' THEN 3 WHEN 'devops' THEN 4 WHEN 'handover' THEN 5 END)
      )
    `)
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS phases_one_open ON phases(project_id) WHERE status = 'open'`)
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS phases_no_delete BEFORE DELETE ON phases
      BEGIN SELECT RAISE(ABORT, 'phases are permanent'); END
    `)
    const pragmaTasks = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
    if (!pragmaTasks.some((c) => c.name === 'phase')) {
      db.exec(`ALTER TABLE tasks ADD COLUMN phase TEXT NOT NULL DEFAULT 'intake' CHECK (phase IN ('intake','development','qa','devops','handover'))`)
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_deps (
        task_id TEXT NOT NULL REFERENCES tasks(id),
        depends_on TEXT NOT NULL REFERENCES tasks(id),
        PRIMARY KEY (task_id, depends_on),
        CHECK (task_id <> depends_on)
      )
    `)
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS task_deps_no_update BEFORE UPDATE ON task_deps
      BEGIN SELECT RAISE(ABORT, 'task_deps are immutable'); END
    `)
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS task_deps_no_delete BEFORE DELETE ON task_deps
      BEGIN SELECT RAISE(ABORT, 'task_deps are immutable'); END
    `)
    db.exec('PRAGMA user_version = 7')
  }
}

function seedProjectPhases(db: DatabaseSync, projectId: string, openedAt = '2026-11-10T00:00:00.000Z'): void {
  const existing = db.prepare('SELECT COUNT(*) as c FROM phases WHERE project_id = ?').get(projectId) as { c: number }
  if (existing.c === 0) {
    const phases = [
      { name: 'intake', ord: 1, status: 'open', opened_at: openedAt, closed_at: null },
      { name: 'development', ord: 2, status: 'locked', opened_at: null, closed_at: null },
      { name: 'qa', ord: 3, status: 'locked', opened_at: null, closed_at: null },
      { name: 'devops', ord: 4, status: 'locked', opened_at: null, closed_at: null },
      { name: 'handover', ord: 5, status: 'locked', opened_at: null, closed_at: null },
    ]
    for (const p of phases) {
      db.prepare(`
        INSERT OR IGNORE INTO phases (project_id, name, ord, status, opened_at, closed_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(projectId, p.name, p.ord, p.status, p.opened_at, p.closed_at)
    }
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
    ensureSchemaV7(db)
    handle = acquireSupervisor(db, stateDir, { nowMs: 1000, staleAfterMs: 300000 })
    db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'Test Project', '2026-11-10T00:00:00.000Z')").run()
    db.prepare("INSERT INTO project_config (project_id, repo_path, base_ref, created_at) VALUES ('p1', '/repo', 'main', '2026-11-10T00:00:00.000Z')").run()
    seedProjectPhases(db, 'p1')
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
    ensureSchemaV7(db)
    const project = db.prepare('SELECT project_id FROM project_config LIMIT 1').get() as { project_id: string } | undefined
    if (project) {
      seedProjectPhases(db, project.project_id)
    }
  } finally {
    db.close()
  }
  return { stateDir, repoDir, dbPath }
}

function snapshotDomain(db: DatabaseSync, ignoreCommandId?: string) {
  return {
    tasks: db.prepare('SELECT * FROM tasks ORDER BY id').all(),
    task_deps: db.prepare('SELECT * FROM task_deps ORDER BY task_id, depends_on').all(),
    phases: db.prepare('SELECT * FROM phases ORDER BY project_id, ord').all(),
    outcomes: (
      ignoreCommandId
        ? db.prepare('SELECT * FROM command_outcomes WHERE command_id <> ? ORDER BY command_id').all(ignoreCommandId)
        : db.prepare('SELECT * FROM command_outcomes ORDER BY command_id').all()
    ),
  }
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

describe('M5-05 CHK-M5-05-a: task create payload normalization and apply', () => {
  it('CHK-M5-05-a: task create with --phase and repeated --after stores normalized payload with deduped and sorted deps, and apply writes tasks.phase and task_deps rows', () => {
    const { stateDir, dbPath } = setupCliEnv()

    // Seed dependencies A and B in project before running apply
    const dbPre = new DatabaseSync(dbPath)
    try {
      dbPre.exec('PRAGMA foreign_keys = ON')
      const project = dbPre.prepare('SELECT project_id FROM project_config LIMIT 1').get() as { project_id: string }
      dbPre.prepare(`
        INSERT INTO commands (id, project_id, kind, payload_json, created_at)
        VALUES
          ('c-dep-a', ?, 'task.create', '{"title":"Dep A"}', '2026-11-10T00:00:00.000Z'),
          ('c-dep-b', ?, 'task.create', '{"title":"Dep B"}', '2026-11-10T00:00:00.100Z')
      `).run(project.project_id, project.project_id)
      dbPre.prepare(`
        INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at)
        VALUES
          ('c-dep-a', 'applied', null, 1, '2026-11-10T00:00:00.500Z'),
          ('c-dep-b', 'applied', null, 1, '2026-11-10T00:00:00.500Z')
      `).run()
      dbPre.prepare(`
        INSERT INTO tasks (id, project_id, created_by_command, title, status, phase, created_at, updated_at)
        VALUES
          ('task-A', ?, 'c-dep-a', 'Dep A', 'done', 'intake', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:01.000Z'),
          ('task-B', ?, 'c-dep-b', 'Dep B', 'ready', 'qa', '2026-11-10T00:00:00.100Z', '2026-11-10T00:00:01.100Z')
      `).run(project.project_id, project.project_id)
    } finally {
      dbPre.close()
    }

    const res = runCli(
      'task',
      'create',
      '--state-dir',
      stateDir,
      '--title',
      'Task with phase and deps',
      '--phase',
      'qa',
      '--after',
      'task-A',
      '--after',
      'task-B',
      '--after',
      'task-A',
    )
    expect(res.status).toBe(0)
    const lines = res.stdout.trim().split(/\r?\n/)
    expect(lines[0]).toMatch(new RegExp(`^created ${UUID_REGEX.source.slice(1, -1)}$`, 'i'))
    expect(lines.length).toBeGreaterThanOrEqual(2)
    expect(lines[1]).toMatch(ARABIC_REGEX)
    const cmdId = lines[0]!.slice('created '.length)

    const db = new DatabaseSync(dbPath)
    try {
      db.exec('PRAGMA foreign_keys = ON')
      const row = db.prepare('SELECT kind, payload_json FROM commands WHERE id = ?').get(cmdId) as { kind: string; payload_json: string } | undefined
      expect(row).toBeDefined()
      expect(row?.kind).toBe('task.create')

      const payload = JSON.parse(row!.payload_json)
      expect(payload).toEqual({
        title: 'Task with phase and deps',
        scope: ['.'],
        maxAttempts: 3,
        timeoutMs: null,
        phase: 'qa',
        deps: ['task-A', 'task-B'],
      })

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

      const task = db.prepare('SELECT id, title, status, phase FROM tasks WHERE id = ?').get(cmdId) as {
        id: string
        title: string
        status: string
        phase: string
      } | undefined
      expect(task).toBeDefined()
      expect(task?.phase).toBe('qa')
      expect(task?.status).toBe('ready')

      const taskDeps = db.prepare('SELECT task_id, depends_on FROM task_deps WHERE task_id = ? ORDER BY depends_on').all(cmdId) as Array<{
        task_id: string
        depends_on: string
      }>
      expect(taskDeps).toEqual([
        { task_id: cmdId, depends_on: 'task-A' },
        { task_id: cmdId, depends_on: 'task-B' },
      ])
    } finally {
      db.close()
    }
  })

  it('CHK-M5-05-a: task create without --phase and --after stores phase null and deps [], and apply assigns the open phase with no task_deps', () => {
    const { stateDir, dbPath } = setupCliEnv()

    const res = runCli('task', 'create', '--state-dir', stateDir, '--title', 'Task with defaults')
    expect(res.status).toBe(0)
    const lines = res.stdout.trim().split(/\r?\n/)
    expect(lines[0]).toMatch(new RegExp(`^created ${UUID_REGEX.source.slice(1, -1)}$`, 'i'))
    expect(lines[1]).toMatch(ARABIC_REGEX)
    const cmdId = lines[0]!.slice('created '.length)

    const db = new DatabaseSync(dbPath)
    try {
      db.exec('PRAGMA foreign_keys = ON')
      const row = db.prepare('SELECT payload_json FROM commands WHERE id = ?').get(cmdId) as { payload_json: string }
      const payload = JSON.parse(row.payload_json)
      expect(payload).toEqual({
        title: 'Task with defaults',
        scope: ['.'],
        maxAttempts: 3,
        timeoutMs: null,
        phase: null,
        deps: [],
      })

      const handle = acquireSupervisor(db, stateDir, { nowMs: 2000, staleAfterMs: 300000 })
      try {
        applyPendingCommands(db, handle)
      } finally {
        handle.release(Date.now())
      }

      const outcome = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get(cmdId) as { outcome: string; reason: string | null }
      expect(outcome.outcome).toBe('applied')
      expect(outcome.reason).toBeNull()

      const task = db.prepare('SELECT phase FROM tasks WHERE id = ?').get(cmdId) as { phase: string }
      // The open phase was 'intake', so the task row gets phase 'intake'
      expect(task.phase).toBe('intake')

      const taskDeps = db.prepare('SELECT COUNT(*) as c FROM task_deps WHERE task_id = ?').get(cmdId) as { c: number }
      expect(taskDeps.c).toBe(0)
    } finally {
      db.close()
    }
  })

  it('CHK-M5-05-a: task create with phase null assigns whatever phase is currently open when applied', () => {
    const ctx = setupTestEnv()
    const { db, handle } = ctx

    // Advance project phase: intake -> done, development -> open
    db.prepare("UPDATE phases SET status = 'done', closed_at = '2026-11-10T00:01:00.000Z' WHERE project_id = 'p1' AND name = 'intake'").run()
    db.prepare("UPDATE phases SET status = 'open', opened_at = '2026-11-10T00:01:00.000Z' WHERE project_id = 'p1' AND name = 'development'").run()

    appendCommand(db, {
      id: 'cmd-phase-null-dev',
      projectId: 'p1',
      kind: 'task.create',
      payloadJson: JSON.stringify({
        title: 'Task during development phase',
        scope: ['.'],
        maxAttempts: 3,
        timeoutMs: null,
        phase: null,
        deps: [],
      }),
      createdAt: '2026-11-10T00:02:00.000Z',
    })

    applyPendingCommands(db, handle)

    const outcome = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get('cmd-phase-null-dev') as { outcome: string; reason: string | null }
    expect(outcome.outcome).toBe('applied')
    expect(outcome.reason).toBeNull()

    const task = db.prepare('SELECT phase FROM tasks WHERE id = ?').get('cmd-phase-null-dev') as { phase: string }
    expect(task.phase).toBe('development')
  })
})

describe('M5-05 CHK-M5-05-b: CLI argument validation, reject classes, and duplicate/conflict enforcement', () => {
  const invalidPhaseCases: Array<{ label: string; flags: string[] }> = [
    { label: 'unknown phase name', flags: ['--phase', 'unknown'] },
    { label: 'uppercase phase name QA', flags: ['--phase', 'QA'] },
    { label: 'empty string phase', flags: ['--phase', ''] },
    { label: 'whitespace phase', flags: ['--phase', '   '] },
    { label: 'missing phase value at end', flags: ['--phase'] },
  ]

  for (const { label, flags } of invalidPhaseCases) {
    it(`CHK-M5-05-b: invalid --phase (${label}) exits 2 with Arabic usage and writes no commands row`, () => {
      const { stateDir, dbPath } = setupCliEnv()

      const res = runCli('task', 'create', '--state-dir', stateDir, '--title', 'Bad Phase Test', ...flags)
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

  it('CHK-M5-05-b: repeated --phase flag exits 2 with Arabic usage and writes no commands row', () => {
    const { stateDir, dbPath } = setupCliEnv()

    const res1 = runCli('task', 'create', '--state-dir', stateDir, '--title', 'Repeated Phase 1', '--phase', 'intake', '--phase', 'development')
    expect(res1.status).toBe(2)
    expect(res1.stderr).toMatch(ARABIC_REGEX)

    const res2 = runCli('task', 'create', '--state-dir', stateDir, '--title', 'Repeated Phase 2', '--phase', 'qa', '--phase', 'qa')
    expect(res2.status).toBe(2)
    expect(res2.stderr).toMatch(ARABIC_REGEX)

    const db = new DatabaseSync(dbPath)
    try {
      expect(db.prepare('SELECT COUNT(*) as c FROM commands').get()).toEqual({ c: 0 })
    } finally {
      db.close()
    }
  })

  const parseDepsRejectCases: Array<{ label: string; afterArgs: string[] }> = [
    { label: 'exceeding 32 entries (33 entries)', afterArgs: Array.from({ length: 33 }, (_, i) => ['--after', `dep-${i}`]).flat() },
    { label: 'empty string entry', afterArgs: ['--after', ''] },
    { label: 'whitespace only entry', afterArgs: ['--after', '   '] },
    { label: 'entry longer than 200 characters (201 chars)', afterArgs: ['--after', 'a'.repeat(201)] },
  ]

  for (const { label, afterArgs } of parseDepsRejectCases) {
    it(`CHK-M5-05-b: invalid --after (${label}) exits 2 with Arabic usage and writes no commands row`, () => {
      const { stateDir, dbPath } = setupCliEnv()

      const res = runCli('task', 'create', '--state-dir', stateDir, '--title', 'Bad After Test', ...afterArgs)
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

  it('CHK-M5-05-b: parseDeps rejects malformed Unicode with a reason (tested in-process)', () => {
    const r1 = parseDeps(['\uD800'])
    expect(r1.ok).toBe(false)
    if (r1.ok) throw new Error('lone surrogate accepted')
    expect(typeof r1.reason).toBe('string')
    expect(r1.reason.length).toBeGreaterThan(0)

    const r2 = parseDeps(['\uDC00'])
    expect(r2.ok).toBe(false)
    if (r2.ok) throw new Error('lone surrogate accepted')
    expect(typeof r2.reason).toBe('string')
    expect(r2.reason.length).toBeGreaterThan(0)

    const r3 = parseDeps(['valid-dep', '\uD800'])
    expect(r3.ok).toBe(false)
    if (r3.ok) throw new Error('lone surrogate accepted')
    expect(typeof r3.reason).toBe('string')
    expect(r3.reason.length).toBeGreaterThan(0)
  })

  it('CHK-M5-05-b: task create duplicate with reordered deps outputs duplicate; different deps or phase with same command-id exits 1', () => {
    const { stateDir, dbPath } = setupCliEnv()
    const customId = 'a1a2a3a4-b5b6-4c7d-8e9f-0123456789ab'

    // 1. Initial creation with deps B and A
    const res1 = runCli(
      'task',
      'create',
      '--state-dir',
      stateDir,
      '--title',
      'Dep Order Test',
      '--phase',
      'qa',
      '--after',
      'B',
      '--after',
      'A',
      '--command-id',
      customId,
    )
    expect(res1.status).toBe(0)
    const lines1 = res1.stdout.trim().split(/\r?\n/)
    expect(lines1[0]).toBe(`created ${customId}`)
    expect(lines1[1]).toMatch(ARABIC_REGEX)

    // 2. Re-run with deps in another order (A, B) -> duplicate
    const res2 = runCli(
      'task',
      'create',
      '--state-dir',
      stateDir,
      '--title',
      'Dep Order Test',
      '--phase',
      'qa',
      '--after',
      'A',
      '--after',
      'B',
      '--command-id',
      customId,
    )
    expect(res2.status).toBe(0)
    const lines2 = res2.stdout.trim().split(/\r?\n/)
    expect(lines2[0]).toBe(`duplicate ${customId}`)
    expect(lines2[1]).toMatch(ARABIC_REGEX)

    // 3. Re-run with repeated deps (B, A, B) -> duplicate
    const res3 = runCli(
      'task',
      'create',
      '--state-dir',
      stateDir,
      '--title',
      'Dep Order Test',
      '--phase',
      'qa',
      '--after',
      'B',
      '--after',
      'A',
      '--after',
      'B',
      '--command-id',
      customId,
    )
    expect(res3.status).toBe(0)
    const lines3 = res3.stdout.trim().split(/\r?\n/)
    expect(lines3[0]).toBe(`duplicate ${customId}`)
    expect(lines3[1]).toMatch(ARABIC_REGEX)

    // Verify commands table still has exactly 1 row
    const db = new DatabaseSync(dbPath)
    try {
      expect(db.prepare('SELECT COUNT(*) as c FROM commands WHERE id = ?').get(customId)).toEqual({ c: 1 })
    } finally {
      db.close()
    }

    // 4. Re-run with different deps -> exit 1
    const res4 = runCli(
      'task',
      'create',
      '--state-dir',
      stateDir,
      '--title',
      'Dep Order Test',
      '--phase',
      'qa',
      '--after',
      'A',
      '--after',
      'C',
      '--command-id',
      customId,
    )
    expect(res4.status).toBe(1)
    expect(res4.stderr).toMatch(ARABIC_REGEX)

    // 5. Re-run with different phase -> exit 1
    const res5 = runCli(
      'task',
      'create',
      '--state-dir',
      stateDir,
      '--title',
      'Dep Order Test',
      '--phase',
      'devops',
      '--after',
      'A',
      '--after',
      'B',
      '--command-id',
      customId,
    )
    expect(res5.status).toBe(1)
    expect(res5.stderr).toMatch(ARABIC_REGEX)
  })

  it('CHK-M5-05-b: phase advance CLI argument validation and duplicate/conflict enforcement', () => {
    const { stateDir, dbPath } = setupCliEnv()
    const customAdvId = 'c1c2c3c4-d5d6-4e7f-8a9b-0123456789cd'

    // Missing --phase -> exit 2
    const resMissingPhase = runCli('phase', 'advance', '--state-dir', stateDir)
    expect(resMissingPhase.status).toBe(2)
    expect(resMissingPhase.stderr).toMatch(ARABIC_REGEX)

    // Missing --state-dir -> exit 2
    const resMissingDir = runCli('phase', 'advance', '--phase', 'intake')
    expect(resMissingDir.status).toBe(2)
    expect(resMissingDir.stderr).toMatch(ARABIC_REGEX)

    // Invalid --phase name -> exit 2
    const resInvalidPhase = runCli('phase', 'advance', '--state-dir', stateDir, '--phase', 'invalid-phase')
    expect(resInvalidPhase.status).toBe(2)
    expect(resInvalidPhase.stderr).toMatch(ARABIC_REGEX)

    // Repeated --phase -> exit 2
    const resRepeatedPhase = runCli('phase', 'advance', '--state-dir', stateDir, '--phase', 'intake', '--phase', 'development')
    expect(resRepeatedPhase.status).toBe(2)
    expect(resRepeatedPhase.stderr).toMatch(ARABIC_REGEX)

    // Repeated --state-dir -> exit 2
    const resRepeatedDir = runCli('phase', 'advance', '--state-dir', stateDir, '--state-dir', stateDir, '--phase', 'intake')
    expect(resRepeatedDir.status).toBe(2)
    expect(resRepeatedDir.stderr).toMatch(ARABIC_REGEX)

    // Valid command creation
    const resCreate = runCli('phase', 'advance', '--state-dir', stateDir, '--phase', 'intake', '--command-id', customAdvId)
    expect(resCreate.status).toBe(0)
    const linesCreate = resCreate.stdout.trim().split(/\r?\n/)
    expect(linesCreate[0]).toBe(`created ${customAdvId}`)
    expect(linesCreate[1]).toMatch(ARABIC_REGEX)

    const db = new DatabaseSync(dbPath)
    try {
      const row = db.prepare('SELECT kind, payload_json FROM commands WHERE id = ?').get(customAdvId) as { kind: string; payload_json: string }
      expect(row).toBeDefined()
      expect(row.kind).toBe('phase.advance')
      expect(JSON.parse(row.payload_json)).toEqual({ phase: 'intake' })
    } finally {
      db.close()
    }

    // Duplicate command with exact same payload
    const resDup = runCli('phase', 'advance', '--state-dir', stateDir, '--phase', 'intake', '--command-id', customAdvId)
    expect(resDup.status).toBe(0)
    const linesDup = resDup.stdout.trim().split(/\r?\n/)
    expect(linesDup[0]).toBe(`duplicate ${customAdvId}`)
    expect(linesDup[1]).toMatch(ARABIC_REGEX)

    // Conflicting command with different phase -> exit 1
    const resConflict = runCli('phase', 'advance', '--state-dir', stateDir, '--phase', 'development', '--command-id', customAdvId)
    expect(resConflict.status).toBe(1)
    expect(resConflict.stderr).toMatch(ARABIC_REGEX)
  })
})

describe('M5-05 CHK-M5-05-c: command apply rejection rules and legacy M4 payloads', () => {
  it('CHK-M5-05-c: apply rejects with reason and writes nothing when dep is missing', () => {
    const ctx = setupTestEnv()
    const { db, handle } = ctx

    appendCommand(db, {
      id: 'cmd-dep-missing',
      projectId: 'p1',
      kind: 'task.create',
      payloadJson: JSON.stringify({
        title: 'Dep missing task',
        scope: ['.'],
        maxAttempts: 3,
        timeoutMs: null,
        phase: 'intake',
        deps: ['non-existent-dep-task'],
      }),
      createdAt: '2026-11-10T00:01:00.000Z',
    })

    const before = snapshotDomain(db, 'cmd-dep-missing')
    applyPendingCommands(db, handle)
    const after = snapshotDomain(db, 'cmd-dep-missing')
    expect(after).toEqual(before)

    const outcome = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get('cmd-dep-missing') as { outcome: string; reason: string | null }
    expect(outcome.outcome).toBe('rejected')
    expect(typeof outcome.reason).toBe('string')
    expect(outcome.reason!.length).toBeGreaterThan(0)

    expect(db.prepare('SELECT COUNT(*) as c FROM tasks WHERE id = ?').get('cmd-dep-missing')).toEqual({ c: 0 })
    expect(db.prepare('SELECT COUNT(*) as c FROM task_deps WHERE task_id = ?').get('cmd-dep-missing')).toEqual({ c: 0 })
  })

  it('CHK-M5-05-c: apply rejects with reason and writes nothing when dep is in another project', () => {
    const ctx = setupTestEnv()
    const { db, handle } = ctx

    // Seed second project 'p2' with its own task
    db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p2', 'Project Two', '2026-11-10T00:00:00.000Z')").run()
    db.prepare("INSERT INTO project_config (project_id, repo_path, base_ref, created_at) VALUES ('p2', '/repo2', 'main', '2026-11-10T00:00:00.000Z')").run()
    seedProjectPhases(db, 'p2')

    db.prepare(`
      INSERT INTO commands (id, project_id, kind, payload_json, created_at)
      VALUES ('c-p2-task', 'p2', 'task.create', '{"title":"P2 Task"}', '2026-11-10T00:00:01.000Z')
    `).run()
    db.prepare(`
      INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at)
      VALUES ('c-p2-task', 'applied', null, 1, '2026-11-10T00:00:01.500Z')
    `).run()
    db.prepare(`
      INSERT INTO tasks (id, project_id, created_by_command, title, status, phase, created_at, updated_at)
      VALUES ('task-in-p2', 'p2', 'c-p2-task', 'P2 Task', 'done', 'intake', '2026-11-10T00:00:01.000Z', '2026-11-10T00:00:02.000Z')
    `).run()

    // Command in p1 specifying dep from p2
    appendCommand(db, {
      id: 'cmd-dep-other-proj',
      projectId: 'p1',
      kind: 'task.create',
      payloadJson: JSON.stringify({
        title: 'Cross project dep task',
        scope: ['.'],
        maxAttempts: 3,
        timeoutMs: null,
        phase: 'intake',
        deps: ['task-in-p2'],
      }),
      createdAt: '2026-11-10T00:01:00.000Z',
    })

    const before = snapshotDomain(db, 'cmd-dep-other-proj')
    applyPendingCommands(db, handle)
    const after = snapshotDomain(db, 'cmd-dep-other-proj')
    expect(after).toEqual(before)

    const outcome = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get('cmd-dep-other-proj') as { outcome: string; reason: string | null }
    expect(outcome.outcome).toBe('rejected')
    expect(typeof outcome.reason).toBe('string')
    expect(outcome.reason!.length).toBeGreaterThan(0)

    expect(db.prepare('SELECT COUNT(*) as c FROM tasks WHERE id = ?').get('cmd-dep-other-proj')).toEqual({ c: 0 })
    expect(db.prepare('SELECT COUNT(*) as c FROM task_deps WHERE task_id = ?').get('cmd-dep-other-proj')).toEqual({ c: 0 })
  })

  it('CHK-M5-05-c: apply rejects with reason and writes nothing when dep is dropped', () => {
    const ctx = setupTestEnv()
    const { db, handle } = ctx

    // Seed dropped task in p1
    db.prepare(`
      INSERT INTO commands (id, project_id, kind, payload_json, created_at)
      VALUES ('c-dropped', 'p1', 'task.create', '{"title":"Dropped Task"}', '2026-11-10T00:00:00.000Z')
    `).run()
    db.prepare(`
      INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at)
      VALUES ('c-dropped', 'applied', null, 1, '2026-11-10T00:00:00.500Z')
    `).run()
    db.prepare(`
      INSERT INTO tasks (id, project_id, created_by_command, title, status, phase, created_at, updated_at)
      VALUES ('task-dropped', 'p1', 'c-dropped', 'Dropped Task', 'dropped', 'intake', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:01.000Z')
    `).run()

    appendCommand(db, {
      id: 'cmd-dep-dropped',
      projectId: 'p1',
      kind: 'task.create',
      payloadJson: JSON.stringify({
        title: 'Dep dropped task',
        scope: ['.'],
        maxAttempts: 3,
        timeoutMs: null,
        phase: 'intake',
        deps: ['task-dropped'],
      }),
      createdAt: '2026-11-10T00:01:00.000Z',
    })

    const before = snapshotDomain(db, 'cmd-dep-dropped')
    applyPendingCommands(db, handle)
    const after = snapshotDomain(db, 'cmd-dep-dropped')
    expect(after).toEqual(before)

    const outcome = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get('cmd-dep-dropped') as { outcome: string; reason: string | null }
    expect(outcome.outcome).toBe('rejected')
    expect(typeof outcome.reason).toBe('string')
    expect(outcome.reason!.length).toBeGreaterThan(0)

    expect(db.prepare('SELECT COUNT(*) as c FROM tasks WHERE id = ?').get('cmd-dep-dropped')).toEqual({ c: 0 })
    expect(db.prepare('SELECT COUNT(*) as c FROM task_deps WHERE task_id = ?').get('cmd-dep-dropped')).toEqual({ c: 0 })
  })

  it('CHK-M5-05-c: apply rejects with reason and writes nothing when dep is in a later phase', () => {
    const ctx = setupTestEnv()
    const { db, handle } = ctx

    // Seed task in 'qa' phase (ord 3)
    db.prepare(`
      INSERT INTO commands (id, project_id, kind, payload_json, created_at)
      VALUES ('c-qa-task', 'p1', 'task.create', '{"title":"QA Task"}', '2026-11-10T00:00:00.000Z')
    `).run()
    db.prepare(`
      INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at)
      VALUES ('c-qa-task', 'applied', null, 1, '2026-11-10T00:00:00.500Z')
    `).run()
    db.prepare(`
      INSERT INTO tasks (id, project_id, created_by_command, title, status, phase, created_at, updated_at)
      VALUES ('task-in-qa', 'p1', 'c-qa-task', 'QA Task', 'ready', 'qa', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:01.000Z')
    `).run()

    // Command specifies phase 'intake' (ord 1) which is before 'qa' (ord 3)
    appendCommand(db, {
      id: 'cmd-dep-later-phase',
      projectId: 'p1',
      kind: 'task.create',
      payloadJson: JSON.stringify({
        title: 'Dep later phase task',
        scope: ['.'],
        maxAttempts: 3,
        timeoutMs: null,
        phase: 'intake',
        deps: ['task-in-qa'],
      }),
      createdAt: '2026-11-10T00:01:00.000Z',
    })

    const before = snapshotDomain(db, 'cmd-dep-later-phase')
    applyPendingCommands(db, handle)
    const after = snapshotDomain(db, 'cmd-dep-later-phase')
    expect(after).toEqual(before)

    const outcome = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get('cmd-dep-later-phase') as { outcome: string; reason: string | null }
    expect(outcome.outcome).toBe('rejected')
    expect(typeof outcome.reason).toBe('string')
    expect(outcome.reason!.length).toBeGreaterThan(0)

    expect(db.prepare('SELECT COUNT(*) as c FROM tasks WHERE id = ?').get('cmd-dep-later-phase')).toEqual({ c: 0 })
    expect(db.prepare('SELECT COUNT(*) as c FROM task_deps WHERE task_id = ?').get('cmd-dep-later-phase')).toEqual({ c: 0 })
  })

  it('CHK-M5-05-c: apply rejects with reason and writes nothing when named phase is done', () => {
    const ctx = setupTestEnv()
    const { db, handle } = ctx

    // Set 'intake' to 'done' and 'development' to 'open'
    db.prepare("UPDATE phases SET status = 'done', closed_at = '2026-11-10T00:01:00.000Z' WHERE project_id = 'p1' AND name = 'intake'").run()
    db.prepare("UPDATE phases SET status = 'open', opened_at = '2026-11-10T00:01:00.000Z' WHERE project_id = 'p1' AND name = 'development'").run()

    // Command specifying named phase 'intake' which is already done
    appendCommand(db, {
      id: 'cmd-named-phase-done',
      projectId: 'p1',
      kind: 'task.create',
      payloadJson: JSON.stringify({
        title: 'Task for done phase',
        scope: ['.'],
        maxAttempts: 3,
        timeoutMs: null,
        phase: 'intake',
        deps: [],
      }),
      createdAt: '2026-11-10T00:02:00.000Z',
    })

    const before = snapshotDomain(db, 'cmd-named-phase-done')
    applyPendingCommands(db, handle)
    const after = snapshotDomain(db, 'cmd-named-phase-done')
    expect(after).toEqual(before)

    const outcome = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get('cmd-named-phase-done') as { outcome: string; reason: string | null }
    expect(outcome.outcome).toBe('rejected')
    expect(typeof outcome.reason).toBe('string')
    expect(outcome.reason!.length).toBeGreaterThan(0)

    expect(db.prepare('SELECT COUNT(*) as c FROM tasks WHERE id = ?').get('cmd-named-phase-done')).toEqual({ c: 0 })
    expect(db.prepare('SELECT COUNT(*) as c FROM task_deps WHERE task_id = ?').get('cmd-named-phase-done')).toEqual({ c: 0 })
  })

  it('CHK-M5-05-c: apply rejects with reason and writes nothing when no phase is open', () => {
    const ctx = setupTestEnv()
    const { db, handle } = ctx

    // Mark all phases done so no phase is open
    db.prepare("UPDATE phases SET status = 'done', closed_at = '2026-11-10T00:01:00.000Z' WHERE project_id = 'p1'").run()

    // Command with phase null (defaults to open phase, but none is open)
    appendCommand(db, {
      id: 'cmd-no-open-phase',
      projectId: 'p1',
      kind: 'task.create',
      payloadJson: JSON.stringify({
        title: 'Task when no phase open',
        scope: ['.'],
        maxAttempts: 3,
        timeoutMs: null,
        phase: null,
        deps: [],
      }),
      createdAt: '2026-11-10T00:02:00.000Z',
    })

    const before = snapshotDomain(db, 'cmd-no-open-phase')
    applyPendingCommands(db, handle)
    const after = snapshotDomain(db, 'cmd-no-open-phase')
    expect(after).toEqual(before)

    const outcome = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get('cmd-no-open-phase') as { outcome: string; reason: string | null }
    expect(outcome.outcome).toBe('rejected')
    expect(typeof outcome.reason).toBe('string')
    expect(outcome.reason!.length).toBeGreaterThan(0)

    expect(db.prepare('SELECT COUNT(*) as c FROM tasks WHERE id = ?').get('cmd-no-open-phase')).toEqual({ c: 0 })
    expect(db.prepare('SELECT COUNT(*) as c FROM task_deps WHERE task_id = ?').get('cmd-no-open-phase')).toEqual({ c: 0 })
  })

  it('CHK-M5-05-c: apply rejects with reason when valid dep is followed by an invalid dep kind, leaving no partial task_deps rows and leaving domain state intact', () => {
    const ctx = setupTestEnv()
    const { db, handle } = ctx

    // 1. Seed valid dep in p1 (intake, done)
    db.prepare(`
      INSERT INTO commands (id, project_id, kind, payload_json, created_at)
      VALUES ('c-valid-dep', 'p1', 'task.create', '{"title":"Valid Dep"}', '2026-11-10T00:00:00.000Z')
    `).run()
    db.prepare(`
      INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at)
      VALUES ('c-valid-dep', 'applied', null, 1, '2026-11-10T00:00:00.500Z')
    `).run()
    db.prepare(`
      INSERT INTO tasks (id, project_id, created_by_command, title, status, phase, created_at, updated_at)
      VALUES ('valid-dep-1', 'p1', 'c-valid-dep', 'Valid Dep', 'done', 'intake', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:01.000Z')
    `).run()

    // 2. Seed project p2 and a task in p2
    db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p2', 'Project Two', '2026-11-10T00:00:00.000Z')").run()
    db.prepare("INSERT INTO project_config (project_id, repo_path, base_ref, created_at) VALUES ('p2', '/repo2', 'main', '2026-11-10T00:00:00.000Z')").run()
    seedProjectPhases(db, 'p2')
    db.prepare(`
      INSERT INTO commands (id, project_id, kind, payload_json, created_at)
      VALUES ('c-p2-task', 'p2', 'task.create', '{"title":"P2 Task"}', '2026-11-10T00:00:01.000Z')
    `).run()
    db.prepare(`
      INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at)
      VALUES ('c-p2-task', 'applied', null, 1, '2026-11-10T00:00:01.500Z')
    `).run()
    db.prepare(`
      INSERT INTO tasks (id, project_id, created_by_command, title, status, phase, created_at, updated_at)
      VALUES ('task-in-p2', 'p2', 'c-p2-task', 'P2 Task', 'done', 'intake', '2026-11-10T00:00:01.000Z', '2026-11-10T00:00:02.000Z')
    `).run()

    // 3. Seed dropped task in p1
    db.prepare(`
      INSERT INTO commands (id, project_id, kind, payload_json, created_at)
      VALUES ('c-dropped', 'p1', 'task.create', '{"title":"Dropped Task"}', '2026-11-10T00:00:00.000Z')
    `).run()
    db.prepare(`
      INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at)
      VALUES ('c-dropped', 'applied', null, 1, '2026-11-10T00:00:00.500Z')
    `).run()
    db.prepare(`
      INSERT INTO tasks (id, project_id, created_by_command, title, status, phase, created_at, updated_at)
      VALUES ('task-dropped', 'p1', 'c-dropped', 'Dropped Task', 'dropped', 'intake', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:01.000Z')
    `).run()

    // 4. Seed task in qa phase in p1
    db.prepare(`
      INSERT INTO commands (id, project_id, kind, payload_json, created_at)
      VALUES ('c-qa-task', 'p1', 'task.create', '{"title":"QA Task"}', '2026-11-10T00:00:00.000Z')
    `).run()
    db.prepare(`
      INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at)
      VALUES ('c-qa-task', 'applied', null, 1, '2026-11-10T00:00:00.500Z')
    `).run()
    db.prepare(`
      INSERT INTO tasks (id, project_id, created_by_command, title, status, phase, created_at, updated_at)
      VALUES ('task-in-qa', 'p1', 'c-qa-task', 'QA Task', 'ready', 'qa', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:01.000Z')
    `).run()

    const mixedDepCases = [
      { id: 'cmd-mix-missing', deps: ['valid-dep-1', 'missing-task-xyz'], desc: 'valid dep + missing dep' },
      { id: 'cmd-mix-other-proj', deps: ['valid-dep-1', 'task-in-p2'], desc: 'valid dep + other project dep' },
      { id: 'cmd-mix-dropped', deps: ['valid-dep-1', 'task-dropped'], desc: 'valid dep + dropped dep' },
      { id: 'cmd-mix-later-phase', deps: ['valid-dep-1', 'task-in-qa'], desc: 'valid dep + later phase dep' },
    ]

    for (const testCase of mixedDepCases) {
      appendCommand(db, {
        id: testCase.id,
        projectId: 'p1',
        kind: 'task.create',
        payloadJson: JSON.stringify({
          title: `Task with ${testCase.desc}`,
          scope: ['.'],
          maxAttempts: 3,
          timeoutMs: null,
          phase: 'intake',
          deps: testCase.deps,
        }),
        createdAt: '2026-11-10T00:01:00.000Z',
      })

      const before = snapshotDomain(db, testCase.id)
      applyPendingCommands(db, handle)
      const after = snapshotDomain(db, testCase.id)

      expect(after, `domain rows must be unchanged for ${testCase.desc}`).toEqual(before)

      const outcome = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get(testCase.id) as { outcome: string; reason: string | null }
      expect(outcome.outcome, `outcome for ${testCase.desc}`).toBe('rejected')
      expect(typeof outcome.reason).toBe('string')
      expect(outcome.reason!.length).toBeGreaterThan(0)

      expect(db.prepare('SELECT COUNT(*) as c FROM tasks WHERE id = ?').get(testCase.id)).toEqual({ c: 0 })
      // Critical check: no partial task_deps rows written!
      expect(db.prepare('SELECT COUNT(*) as c FROM task_deps WHERE task_id = ?').get(testCase.id), `no partial task_deps rows for ${testCase.desc}`).toEqual({ c: 0 })
    }
  })

  it('CHK-M5-05-c: M4 payload without phase or deps is applied with the open phase and no task_deps', () => {
    const ctx = setupTestEnv()
    const { db, handle } = ctx

    // Set 'development' as open phase
    db.prepare("UPDATE phases SET status = 'done', closed_at = '2026-11-10T00:01:00.000Z' WHERE project_id = 'p1' AND name = 'intake'").run()
    db.prepare("UPDATE phases SET status = 'open', opened_at = '2026-11-10T00:01:00.000Z' WHERE project_id = 'p1' AND name = 'development'").run()

    // M4 payload (has scope, maxAttempts, timeoutMs, but NO phase and NO deps)
    appendCommand(db, {
      id: 'cmd-m4-payload',
      projectId: 'p1',
      kind: 'task.create',
      payloadJson: JSON.stringify({
        title: 'M4 Payload Task',
        scope: ['src'],
        maxAttempts: 4,
        timeoutMs: 5000,
      }),
      createdAt: '2026-11-10T00:02:00.000Z',
    })

    // Legacy M3 payload (only title)
    appendCommand(db, {
      id: 'cmd-m3-legacy',
      projectId: 'p1',
      kind: 'task.create',
      payloadJson: JSON.stringify({
        title: 'M3 Legacy Task',
      }),
      createdAt: '2026-11-10T00:02:01.000Z',
    })

    applyPendingCommands(db, handle)

    const outcomeM4 = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get('cmd-m4-payload') as { outcome: string; reason: string | null }
    expect(outcomeM4.outcome).toBe('applied')
    expect(outcomeM4.reason).toBeNull()

    const taskM4 = db.prepare('SELECT phase, status, scope_json, max_attempts, timeout_ms FROM tasks WHERE id = ?').get('cmd-m4-payload') as {
      phase: string
      status: string
      scope_json: string
      max_attempts: number
      timeout_ms: number | null
    }
    expect(taskM4.phase).toBe('development')
    expect(taskM4.status).toBe('ready')
    expect(JSON.parse(taskM4.scope_json)).toEqual(['src'])
    expect(taskM4.max_attempts).toBe(4)
    expect(taskM4.timeout_ms).toBe(5000)
    expect(db.prepare('SELECT COUNT(*) as c FROM task_deps WHERE task_id = ?').get('cmd-m4-payload')).toEqual({ c: 0 })

    const outcomeM3 = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get('cmd-m3-legacy') as { outcome: string; reason: string | null }
    expect(outcomeM3.outcome).toBe('applied')
    expect(outcomeM3.reason).toBeNull()

    const taskM3 = db.prepare('SELECT phase, status, scope_json, max_attempts, timeout_ms FROM tasks WHERE id = ?').get('cmd-m3-legacy') as {
      phase: string
      status: string
      scope_json: string
      max_attempts: number
      timeout_ms: number | null
    }
    expect(taskM3.phase).toBe('development')
    expect(taskM3.status).toBe('ready')
    expect(JSON.parse(taskM3.scope_json)).toEqual(['.'])
    expect(taskM3.max_attempts).toBe(3)
    expect(taskM3.timeout_ms).toBeNull()
    expect(db.prepare('SELECT COUNT(*) as c FROM task_deps WHERE task_id = ?').get('cmd-m3-legacy')).toEqual({ c: 0 })
  })

  it('CHK-M5-05-c: malformed payload rejected with reason, writing no task and no task_deps', () => {
    const ctx = setupTestEnv()
    const { db, handle } = ctx

    const validBasePayload = {
      title: 'Valid Base Task',
      scope: ['.'],
      maxAttempts: 3,
      timeoutMs: null,
      phase: 'intake',
      deps: [],
    }

    const malformedPayloads: Array<{ id: string; payload: unknown; desc: string }> = [
      { id: 'cmd-mal-1', payload: { ...validBasePayload, phase: 'invalid-phase' }, desc: 'invalid phase' },
      { id: 'cmd-mal-2', payload: { ...validBasePayload, deps: 'not-an-array' }, desc: 'deps not an array' },
      { id: 'cmd-mal-3', payload: { ...validBasePayload, deps: [123] }, desc: 'deps containing non-string' },
      { id: 'cmd-mal-4', payload: { ...validBasePayload, deps: [''] }, desc: 'deps containing empty string' },
      { id: 'cmd-mal-5', payload: { ...validBasePayload, deps: ['   '] }, desc: 'deps containing whitespace only string' },
      { id: 'cmd-mal-6', payload: { ...validBasePayload, deps: ['a'.repeat(201)] }, desc: 'deps containing string > 200 chars' },
      { id: 'cmd-mal-7', payload: { ...validBasePayload, deps: ['\uD800'] }, desc: 'deps containing lone surrogate' },
      { id: 'cmd-mal-8', payload: { ...validBasePayload, deps: Array.from({ length: 33 }, (_, i) => `d${i}`) }, desc: 'deps exceeding 32 entries' },
    ]

    for (const item of malformedPayloads) {
      appendCommand(db, {
        id: item.id,
        projectId: 'p1',
        kind: 'task.create',
        payloadJson: JSON.stringify(item.payload),
        createdAt: '2026-11-10T00:03:00.000Z',
      })
    }

    const before = snapshotDomain(db)
    applyPendingCommands(db, handle)
    const after = snapshotDomain(db)

    for (const item of malformedPayloads) {
      const outcome = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get(item.id) as { outcome: string; reason: string | null }
      expect(outcome, `Outcome for ${item.id} (${item.desc})`).toBeDefined()
      expect(outcome.outcome).toBe('rejected')
      expect(typeof outcome.reason).toBe('string')
      expect(outcome.reason!.length).toBeGreaterThan(0)
      expect(db.prepare('SELECT COUNT(*) as c FROM tasks WHERE id = ?').get(item.id)).toEqual({ c: 0 })
      expect(db.prepare('SELECT COUNT(*) as c FROM task_deps WHERE task_id = ?').get(item.id)).toEqual({ c: 0 })
    }

    expect(after.tasks).toEqual(before.tasks)
    expect(after.task_deps).toEqual(before.task_deps)
    expect(after.phases).toEqual(before.phases)
  })
})

describe('M5-05 CHK-M5-05-d: phase advance rules and state transitions', () => {
  it('CHK-M5-05-d: phase advance rejected with "phase is not open" when the specified phase is locked or done', () => {
    const ctx = setupTestEnv()
    const { db, handle } = ctx

    // 1. Advance 'development' while 'intake' is the open phase -> rejected ('phase is not open')
    appendCommand(db, {
      id: 'cmd-adv-locked',
      projectId: 'p1',
      kind: 'phase.advance',
      payloadJson: JSON.stringify({ phase: 'development' }),
      createdAt: '2026-11-10T00:01:00.000Z',
    })

    applyPendingCommands(db, handle)

    const outcomeLocked = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get('cmd-adv-locked') as { outcome: string; reason: string | null }
    expect(outcomeLocked.outcome).toBe('rejected')
    expect(outcomeLocked.reason).toBe('phase is not open')

    // Verify intake is still open, development is still locked
    const pIntake = db.prepare("SELECT status FROM phases WHERE project_id = 'p1' AND name = 'intake'").get() as { status: string }
    expect(pIntake.status).toBe('open')
    const pDev = db.prepare("SELECT status FROM phases WHERE project_id = 'p1' AND name = 'development'").get() as { status: string }
    expect(pDev.status).toBe('locked')

    // 2. Mark intake done and development open, then attempt advancing intake -> rejected ('phase is not open')
    db.prepare("UPDATE phases SET status = 'done', closed_at = '2026-11-10T00:02:00.000Z' WHERE project_id = 'p1' AND name = 'intake'").run()
    db.prepare("UPDATE phases SET status = 'open', opened_at = '2026-11-10T00:02:00.000Z' WHERE project_id = 'p1' AND name = 'development'").run()

    appendCommand(db, {
      id: 'cmd-adv-done',
      projectId: 'p1',
      kind: 'phase.advance',
      payloadJson: JSON.stringify({ phase: 'intake' }),
      createdAt: '2026-11-10T00:03:00.000Z',
    })

    applyPendingCommands(db, handle)

    const outcomeDone = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get('cmd-adv-done') as { outcome: string; reason: string | null }
    expect(outcomeDone.outcome).toBe('rejected')
    expect(outcomeDone.reason).toBe('phase is not open')
  })

  const unfinishedStatuses = ['ready', 'progress', 'blocked', 'waiting', 'failed'] as const
  for (const st of unfinishedStatuses) {
    it(`CHK-M5-05-d: phase advance rejected with "phase has unfinished tasks" for each unfinished status (${st}) seeded directly in DB`, () => {
      const ctx = setupTestEnv()
      const { db, handle } = ctx

      // Seed an unfinished task directly in open phase 'intake'
      db.prepare(`
        INSERT INTO commands (id, project_id, kind, payload_json, created_at)
        VALUES ('c-unf-${st}', 'p1', 'task.create', '{"title":"Unfinished task ${st}"}', '2026-11-10T00:00:00.000Z')
      `).run()
      db.prepare(`
        INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at)
        VALUES ('c-unf-${st}', 'applied', null, 1, '2026-11-10T00:00:00.500Z')
      `).run()
      db.prepare(`
        INSERT INTO tasks (id, project_id, created_by_command, title, status, phase, created_at, updated_at)
        VALUES ('task-unf-${st}', 'p1', 'c-unf-${st}', 'Unfinished task ${st}', '${st}', 'intake', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:01.000Z')
      `).run()

      appendCommand(db, {
        id: `cmd-adv-unf-${st}`,
        projectId: 'p1',
        kind: 'phase.advance',
        payloadJson: JSON.stringify({ phase: 'intake' }),
        createdAt: '2026-11-10T00:01:00.000Z',
      })

      applyPendingCommands(db, handle)

      const outcome = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get(`cmd-adv-unf-${st}`) as { outcome: string; reason: string | null }
      expect(outcome.outcome).toBe('rejected')
      expect(outcome.reason).toBe('phase has unfinished tasks')

      // Phase intake remains open
      const pIntake = db.prepare("SELECT status, closed_at FROM phases WHERE project_id = 'p1' AND name = 'intake'").get() as { status: string; closed_at: string | null }
      expect(pIntake.status).toBe('open')
      expect(pIntake.closed_at).toBeNull()
    })
  }

  it('CHK-M5-05-d: unfinished tasks in other phases do not prevent advancing the open phase', () => {
    const ctx = setupTestEnv()
    const { db, handle } = ctx

    // Task in 'intake' is done
    db.prepare(`
      INSERT INTO commands (id, project_id, kind, payload_json, created_at)
      VALUES ('c-intake-done', 'p1', 'task.create', '{"title":"Done intake task"}', '2026-11-10T00:00:00.000Z')
    `).run()
    db.prepare(`
      INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at)
      VALUES ('c-intake-done', 'applied', null, 1, '2026-11-10T00:00:00.500Z')
    `).run()
    db.prepare(`
      INSERT INTO tasks (id, project_id, created_by_command, title, status, phase, created_at, updated_at)
      VALUES ('task-intake-done', 'p1', 'c-intake-done', 'Done intake task', 'done', 'intake', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:01.000Z')
    `).run()

    // Task in 'qa' is ready (qa is locked, not the open phase)
    db.prepare(`
      INSERT INTO commands (id, project_id, kind, payload_json, created_at)
      VALUES ('c-qa-ready', 'p1', 'task.create', '{"title":"Ready QA task"}', '2026-11-10T00:00:01.000Z')
    `).run()
    db.prepare(`
      INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at)
      VALUES ('c-qa-ready', 'applied', null, 1, '2026-11-10T00:00:01.500Z')
    `).run()
    db.prepare(`
      INSERT INTO tasks (id, project_id, created_by_command, title, status, phase, created_at, updated_at)
      VALUES ('task-qa-ready', 'p1', 'c-qa-ready', 'Ready QA task', 'ready', 'qa', '2026-11-10T00:00:01.000Z', '2026-11-10T00:00:01.000Z')
    `).run()

    appendCommand(db, {
      id: 'cmd-adv-intake-ok',
      projectId: 'p1',
      kind: 'phase.advance',
      payloadJson: JSON.stringify({ phase: 'intake' }),
      createdAt: '2026-11-10T00:02:00.000Z',
    })

    applyPendingCommands(db, handle)

    const outcome = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get('cmd-adv-intake-ok') as { outcome: string; reason: string | null }
    expect(outcome.outcome).toBe('applied')
    expect(outcome.reason).toBeNull()

    const pIntake = db.prepare("SELECT status FROM phases WHERE project_id = 'p1' AND name = 'intake'").get() as { status: string }
    expect(pIntake.status).toBe('done')
    const pDev = db.prepare("SELECT status FROM phases WHERE project_id = 'p1' AND name = 'development'").get() as { status: string }
    expect(pDev.status).toBe('open')
  })

  it('CHK-M5-05-d: phase advance applied when all tasks in phase are done or dropped, updating timestamps and opening next phase', () => {
    const ctx = setupTestEnv()
    const { db, handle } = ctx

    // Seed tasks in intake: one done and one dropped
    db.prepare(`
      INSERT INTO commands (id, project_id, kind, payload_json, created_at)
      VALUES
        ('c-fin-1', 'p1', 'task.create', '{"title":"Task Done"}', '2026-11-10T00:00:00.000Z'),
        ('c-fin-2', 'p1', 'task.create', '{"title":"Task Dropped"}', '2026-11-10T00:00:00.100Z')
    `).run()
    db.prepare(`
      INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at)
      VALUES
        ('c-fin-1', 'applied', null, 1, '2026-11-10T00:00:00.500Z'),
        ('c-fin-2', 'applied', null, 1, '2026-11-10T00:00:00.500Z')
    `).run()
    db.prepare(`
      INSERT INTO tasks (id, project_id, created_by_command, title, status, phase, created_at, updated_at)
      VALUES
        ('task-fin-1', 'p1', 'c-fin-1', 'Task Done', 'done', 'intake', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:01.000Z'),
        ('task-fin-2', 'p1', 'c-fin-2', 'Task Dropped', 'dropped', 'intake', '2026-11-10T00:00:00.100Z', '2026-11-10T00:00:01.100Z')
    `).run()

    appendCommand(db, {
      id: 'cmd-adv-intake',
      projectId: 'p1',
      kind: 'phase.advance',
      payloadJson: JSON.stringify({ phase: 'intake' }),
      createdAt: '2026-11-10T00:02:00.000Z',
    })

    applyPendingCommands(db, handle)

    const outcome = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get('cmd-adv-intake') as { outcome: string; reason: string | null }
    expect(outcome.outcome).toBe('applied')
    expect(outcome.reason).toBeNull()

    const pIntake = db.prepare("SELECT status, opened_at, closed_at FROM phases WHERE project_id = 'p1' AND name = 'intake'").get() as {
      status: string
      opened_at: string | null
      closed_at: string | null
    }
    expect(pIntake.status).toBe('done')
    expect(pIntake.opened_at).not.toBeNull()
    expect(pIntake.closed_at).not.toBeNull()

    const pDev = db.prepare("SELECT status, opened_at, closed_at FROM phases WHERE project_id = 'p1' AND name = 'development'").get() as {
      status: string
      opened_at: string | null
      closed_at: string | null
    }
    expect(pDev.status).toBe('open')
    expect(pDev.opened_at).not.toBeNull()
    expect(pDev.closed_at).toBeNull()

    const otherPhases = db.prepare("SELECT name, status FROM phases WHERE project_id = 'p1' AND name IN ('qa', 'devops', 'handover')").all() as Array<{ name: string; status: string }>
    for (const op of otherPhases) {
      expect(op.status).toBe('locked')
    }
  })

  it('CHK-M5-05-d: second advance with new command-id for the same phase is rejected with "phase is not open"', () => {
    const ctx = setupTestEnv()
    const { db, handle } = ctx

    // Advance intake successfully
    appendCommand(db, {
      id: 'cmd-adv-intake-first',
      projectId: 'p1',
      kind: 'phase.advance',
      payloadJson: JSON.stringify({ phase: 'intake' }),
      createdAt: '2026-11-10T00:01:00.000Z',
    })
    applyPendingCommands(db, handle)

    const outcome1 = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get('cmd-adv-intake-first') as { outcome: string; reason: string | null }
    expect(outcome1.outcome).toBe('applied')

    // Second advance for intake with a new command id
    appendCommand(db, {
      id: 'cmd-adv-intake-second',
      projectId: 'p1',
      kind: 'phase.advance',
      payloadJson: JSON.stringify({ phase: 'intake' }),
      createdAt: '2026-11-10T00:02:00.000Z',
    })
    applyPendingCommands(db, handle)

    const outcome2 = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get('cmd-adv-intake-second') as { outcome: string; reason: string | null }
    expect(outcome2.outcome).toBe('rejected')
    expect(outcome2.reason).toBe('phase is not open')
  })

  it('CHK-M5-05-d: advancing handover phase leaves no phase open, and further advances are rejected', () => {
    const ctx = setupTestEnv()
    const { db, handle } = ctx

    // Advance through intake -> development -> qa -> devops -> handover
    const phasesToAdvance = ['intake', 'development', 'qa', 'devops'] as const
    let seq = 1
    for (const ph of phasesToAdvance) {
      appendCommand(db, {
        id: `cmd-adv-seq-${ph}`,
        projectId: 'p1',
        kind: 'phase.advance',
        payloadJson: JSON.stringify({ phase: ph }),
        createdAt: `2026-11-10T00:0${seq++}:00.000Z`,
      })
      applyPendingCommands(db, handle)
      const res = db.prepare('SELECT outcome FROM command_outcomes WHERE command_id = ?').get(`cmd-adv-seq-${ph}`) as { outcome: string }
      expect(res.outcome).toBe('applied')
    }

    // Now handover must be open
    const pHandoverPre = db.prepare("SELECT status FROM phases WHERE project_id = 'p1' AND name = 'handover'").get() as { status: string }
    expect(pHandoverPre.status).toBe('open')

    // Advance handover
    appendCommand(db, {
      id: 'cmd-adv-handover',
      projectId: 'p1',
      kind: 'phase.advance',
      payloadJson: JSON.stringify({ phase: 'handover' }),
      createdAt: '2026-11-10T00:10:00.000Z',
    })
    applyPendingCommands(db, handle)

    const outcomeHandover = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get('cmd-adv-handover') as { outcome: string; reason: string | null }
    expect(outcomeHandover.outcome).toBe('applied')
    expect(outcomeHandover.reason).toBeNull()

    const pHandoverPost = db.prepare("SELECT status, closed_at FROM phases WHERE project_id = 'p1' AND name = 'handover'").get() as { status: string; closed_at: string | null }
    expect(pHandoverPost.status).toBe('done')
    expect(pHandoverPost.closed_at).not.toBeNull()

    // Advancing handover leaves NO phase open
    const openCount = db.prepare("SELECT COUNT(*) as c FROM phases WHERE project_id = 'p1' AND status = 'open'").get() as { c: number }
    expect(openCount.c).toBe(0)

    // Further advance attempt for handover with new command-id rejected
    appendCommand(db, {
      id: 'cmd-adv-after-handover',
      projectId: 'p1',
      kind: 'phase.advance',
      payloadJson: JSON.stringify({ phase: 'handover' }),
      createdAt: '2026-11-10T00:11:00.000Z',
    })
    applyPendingCommands(db, handle)

    const outcomeAfter = db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get('cmd-adv-after-handover') as { outcome: string; reason: string | null }
    expect(outcomeAfter.outcome).toBe('rejected')
    expect(outcomeAfter.reason).toBe('phase is not open')
  })
})
