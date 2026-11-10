import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

const ARABIC_REGEX = /[\u0600-\u06ff]/
const UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

function normalizeFsPath(p: string): string {
  const resolved = resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

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

const cliPath = join(process.cwd(), 'supervisor/src/cli/main.ts')
function runCli(...args: string[]) {
  const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', timeout: 15000 })
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    throw new Error(`CLI execution timed out after 15000ms: factory ${args.join(' ')}`)
  }
  return result
}

function getDatabaseSnapshot(db: DatabaseSync): Record<string, Array<Record<string, unknown>>> {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC")
    .all() as Array<{ name: string }>
  const snapshot: Record<string, Array<Record<string, unknown>>> = {}
  for (const { name } of tables) {
    const rows = db.prepare(`SELECT * FROM ${name}`).all() as Array<Record<string, unknown>>
    rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    snapshot[name] = rows
  }
  return snapshot
}

function seedRepresentativeDomainState(db: DatabaseSync): void {
  const project = db.prepare('SELECT id FROM projects').get() as { id: string }
  const projectId = project.id

  // 1. Existing commands
  db.prepare(`
    INSERT INTO commands (id, project_id, kind, payload_json, created_at)
    VALUES
      ('cmd-seed-1', ?, 'task.create', '{"title":"Seeded Task 1"}', '2026-11-10T00:00:01.000Z'),
      ('cmd-seed-2', ?, 'task.create', '{"title":"Seeded Task 2"}', '2026-11-10T00:00:02.000Z')
  `).run(projectId, projectId)

  // 2. Existing command outcomes
  db.prepare(`
    INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at)
    VALUES
      ('cmd-seed-1', 'applied', null, 1, '2026-11-10T00:00:03.000Z'),
      ('cmd-seed-2', 'applied', null, 1, '2026-11-10T00:00:04.000Z')
  `).run()

  // 3. Existing tasks in representative states
  db.prepare(`
    INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at)
    VALUES
      ('cmd-seed-1', ?, 'cmd-seed-1', 'Seeded Task 1', 'progress', '2026-11-10T00:00:01.000Z', '2026-11-10T00:00:03.000Z'),
      ('cmd-seed-2', ?, 'cmd-seed-2', 'Seeded Task 2', 'ready', '2026-11-10T00:00:02.000Z', '2026-11-10T00:00:04.000Z')
  `).run(projectId, projectId)

  // 4. Existing attempt
  db.prepare(`
    INSERT INTO attempts (id, task_id, attempt_no, status, exit_code, error_class, lease_generation, started_at, ended_at)
    VALUES
      ('att-seed-1', 'cmd-seed-1', 1, 'running', null, null, 1, '2026-11-10T00:00:05.000Z', null)
  `).run()

  // 5. Existing worker
  db.prepare(`
    INSERT INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at, ended_at)
    VALUES
      ('att-seed-1', 'nonce-seed-1234', 99999, 'running', '/tmp/seeded-worktree', 5000, '2026-11-10T00:00:05.000Z', null)
  `).run()

  // 6. Existing outbox row
  db.prepare(`
    INSERT INTO outbox (id, idempotency_key, kind, payload_json, status, tries, next_attempt_ms, last_error, created_at, updated_at)
    VALUES
      ('outbox-seed-1', 'attempt.kill:att-seed-old', 'attempt.kill', '{"attemptId":"att-seed-old"}', 'pending', 0, 0, null, '2026-11-10T00:00:06.000Z', '2026-11-10T00:00:06.000Z')
  `).run()

  // 7. Existing evidence row
  db.prepare(`
    INSERT INTO evidence (attempt_id, base_sha, head_sha, files_json, stdout_sha256, stderr_sha256, recorded_at)
    VALUES
      ('att-seed-1', 'base-sha-123', 'head-sha-456', '[]', 'sha-out', 'sha-err', '2026-11-10T00:00:07.000Z')
  `).run()
}

afterEach(() => {
  const errors: unknown[] = []
  for (const directory of directories.splice(0)) {
    try {
      safeRemoveDir(directory)
    } catch (err) {
      errors.push(err)
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Cleanup failed to remove temporary directories')
  }
})

describe('M3-02 CLI init contract', () => {
  it('CHK-M3-02-a: init creates state.sqlite with one project, project_config and releases the lease', () => {
    const stateDir = makeTempDir('factory-test-state-')
    const repoDir = makeTempDir('factory-test-repo-')
    createGitRepo(repoDir)

    const dbPath = join(stateDir, 'state.sqlite')
    expect(existsSync(dbPath)).toBe(false)

    const result = runCli('init', '--state-dir', stateDir, '--repo', repoDir)
    expect(result.status).toBe(0)
    expect(existsSync(dbPath)).toBe(true)

    const db = new DatabaseSync(dbPath)
    try {
      // 1. Projects table has exactly one project
      const projects = db.prepare('SELECT id, name, created_at FROM projects').all() as Array<{
        id: string
        name: string
        created_at: string
      }>
      expect(projects).toHaveLength(1)
      const project = projects[0]!
      expect(typeof project.id).toBe('string')
      expect(project.id.trim().length).toBeGreaterThan(0)
      expect(typeof project.name).toBe('string')
      expect(project.name.trim().length).toBeGreaterThan(0)
      expect(Number.isNaN(new Date(project.created_at).getTime())).toBe(false)

      // 2. Project_config table has exactly one row referencing the project and repo
      const configs = db.prepare('SELECT project_id, repo_path, base_ref, created_at FROM project_config').all() as Array<{
        project_id: string
        repo_path: string
        base_ref: string
        created_at: string
      }>
      expect(configs).toHaveLength(1)
      const config = configs[0]!
      expect(config.project_id).toBe(project.id)
      expect(isAbsolute(config.repo_path)).toBe(true)
      expect(normalizeFsPath(config.repo_path)).toBe(normalizeFsPath(repoDir))
      expect(typeof config.base_ref).toBe('string')
      expect(config.base_ref.trim().length).toBeGreaterThan(0)
      expect(Number.isNaN(new Date(config.created_at).getTime())).toBe(false)

      // 3. Supervisor lease row exists with status released
      const lease = db.prepare('SELECT id, owner_id, generation, heartbeat_ms, status FROM supervisor_lease WHERE id = 1').get() as {
        id: number
        owner_id: string
        generation: number
        heartbeat_ms: number
        status: string
      } | undefined
      expect(lease).toBeDefined()
      expect(lease?.status).toBe('released')
      expect(Number(lease?.generation)).toBeGreaterThanOrEqual(1)
      expect(typeof lease?.owner_id).toBe('string')
      expect(lease?.owner_id.trim().length).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })

  it('CHK-M3-02-a: re-run init with same repo exits 0 and changes nothing (complete logical database snapshot identical)', () => {
    const stateDir = makeTempDir('factory-test-state-')
    const repoDir = makeTempDir('factory-test-repo-')
    createGitRepo(repoDir)

    const dbPath = join(stateDir, 'state.sqlite')

    const firstRun = runCli('init', '--state-dir', stateDir, '--repo', repoDir)
    expect(firstRun.status).toBe(0)

    let snapshotBefore: Record<string, Array<Record<string, unknown>>>
    const db1 = new DatabaseSync(dbPath)
    try {
      snapshotBefore = getDatabaseSnapshot(db1)
    } finally {
      db1.close()
    }

    // Re-run init with the exact same repo
    const secondRun = runCli('init', '--state-dir', stateDir, '--repo', repoDir)
    expect(secondRun.status).toBe(0)

    const db2 = new DatabaseSync(dbPath)
    try {
      const snapshotAfter = getDatabaseSnapshot(db2)
      // Complete snapshot comparison: every table, row, and column (including lease heartbeat) is unchanged
      expect(snapshotAfter).toEqual(snapshotBefore)
    } finally {
      db2.close()
    }
  })

  it('CHK-M3-02-a: init with missing repo path exits 1 with Arabic error and no writes', () => {
    const stateDir = makeTempDir('factory-test-state-')
    const missingRepo = join(makeTempDir('factory-missing-'), 'does-not-exist')
    const dbPath = join(stateDir, 'state.sqlite')

    const result = runCli('init', '--state-dir', stateDir, '--repo', missingRepo)
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(ARABIC_REGEX)
    expect(existsSync(dbPath)).toBe(false)
  })

  it('CHK-M3-02-a: init with non-git repo path exits 1 with Arabic error and no writes', () => {
    const stateDir = makeTempDir('factory-test-state-')
    const nonGitDir = makeTempDir('factory-non-git-')
    const dbPath = join(stateDir, 'state.sqlite')

    const result = runCli('init', '--state-dir', stateDir, '--repo', nonGitDir)
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(ARABIC_REGEX)
    expect(existsSync(dbPath)).toBe(false)
  })

  it('CHK-M3-02-a: re-run init on initialized state-dir with different repo exits 1 with Arabic error and changes nothing (complete snapshot)', () => {
    const stateDir = makeTempDir('factory-test-state-')
    const repoA = makeTempDir('factory-repo-a-')
    createGitRepo(repoA)

    const initA = runCli('init', '--state-dir', stateDir, '--repo', repoA)
    expect(initA.status).toBe(0)

    const repoB = makeTempDir('factory-repo-b-')
    createGitRepo(repoB)

    const dbPath = join(stateDir, 'state.sqlite')
    let snapshotBefore: Record<string, Array<Record<string, unknown>>>
    const dbBefore = new DatabaseSync(dbPath)
    try {
      snapshotBefore = getDatabaseSnapshot(dbBefore)
    } finally {
      dbBefore.close()
    }

    const initB = runCli('init', '--state-dir', stateDir, '--repo', repoB)
    expect(initB.status).toBe(1)
    expect(initB.stderr).toMatch(ARABIC_REGEX)

    const dbAfter = new DatabaseSync(dbPath)
    try {
      const snapshotAfter = getDatabaseSnapshot(dbAfter)
      // Logical database snapshot must be completely unmodified
      expect(snapshotAfter).toEqual(snapshotBefore)
    } finally {
      dbAfter.close()
    }
  })
})

describe('M3-02 CLI task commands contract', () => {
  it('CHK-M3-02-b: task create appends only a commands row and prints command id without running supervisor', () => {
    const stateDir = makeTempDir('factory-test-state-')
    const repoDir = makeTempDir('factory-test-repo-')
    createGitRepo(repoDir)

    expect(runCli('init', '--state-dir', stateDir, '--repo', repoDir).status).toBe(0)

    const dbPath = join(stateDir, 'state.sqlite')
    let snapshotBefore: Record<string, Array<Record<string, unknown>>>
    const dbBefore = new DatabaseSync(dbPath)
    try {
      seedRepresentativeDomainState(dbBefore)
      snapshotBefore = getDatabaseSnapshot(dbBefore)
      expect(snapshotBefore['tasks']!.length).toBeGreaterThan(0)
      expect(snapshotBefore['attempts']!.length).toBeGreaterThan(0)
    } finally {
      dbBefore.close()
    }

    const result = runCli('task', 'create', '--state-dir', stateDir, '--title', 'Implement slice')
    expect(result.status).toBe(0)

    // Frozen contract: first stdout line is exactly `created <commandId>`, followed by an Arabic line
    const stdoutLines = result.stdout.trim().split(/\r?\n/)
    expect(stdoutLines[0]).toMatch(new RegExp(`^created ${UUID_REGEX.source}$`, 'i'))
    expect(stdoutLines.length).toBeGreaterThanOrEqual(2)
    expect(stdoutLines[1]).toMatch(ARABIC_REGEX)

    const commandId = stdoutLines[0]!.slice('created '.length)

    const dbAfter = new DatabaseSync(dbPath)
    try {
      const snapshotAfter = getDatabaseSnapshot(dbAfter)

      // Complete snapshot verification: every table EXCEPT commands is completely identical
      for (const table of Object.keys(snapshotBefore)) {
        if (table !== 'commands') {
          expect(snapshotAfter[table], `Table ${table} should remain identical`).toEqual(snapshotBefore[table])
        }
      }

      // Commands table has exactly one row added
      const beforeCommands = snapshotBefore['commands'] ?? []
      const afterCommands = snapshotAfter['commands'] ?? []
      expect(afterCommands).toHaveLength(beforeCommands.length + 1)

      const appendedRow = afterCommands.find((r) => r.id === commandId)
      expect(appendedRow).toBeDefined()
      expect(appendedRow?.kind).toBe('task.create')

      const project = dbAfter.prepare('SELECT id FROM projects').get() as { id: string }
      expect(appendedRow?.project_id).toBe(project.id)

      const payload = JSON.parse(String(appendedRow?.payload_json ?? '{}')) as { title?: string }
      expect(payload.title).toBe('Implement slice')
    } finally {
      dbAfter.close()
    }
  })

  it('CHK-M3-02-b: task create with explicit command-id appends command and reports duplicate with printed ID on re-run with same args', () => {
    const stateDir = makeTempDir('factory-test-state-')
    const repoDir = makeTempDir('factory-test-repo-')
    createGitRepo(repoDir)

    expect(runCli('init', '--state-dir', stateDir, '--repo', repoDir).status).toBe(0)

    const customId = 'a1b2c3d4-1111-4111-8111-123456789abc'
    const firstRun = runCli('task', 'create', '--state-dir', stateDir, '--title', 'Fix bug', '--command-id', customId)
    expect(firstRun.status).toBe(0)

    // Frozen contract: first stdout line is exactly `created <commandId>`, followed by Arabic
    const firstLines = firstRun.stdout.trim().split(/\r?\n/)
    expect(firstLines[0]).toBe(`created ${customId}`)
    expect(firstLines.length).toBeGreaterThanOrEqual(2)
    expect(firstLines[1]).toMatch(ARABIC_REGEX)

    const dbPath = join(stateDir, 'state.sqlite')
    let snapshotAfterFirst: Record<string, Array<Record<string, unknown>>>
    const db1 = new DatabaseSync(dbPath)
    try {
      expect(db1.prepare('SELECT COUNT(*) as count FROM commands WHERE id = ?').get(customId)).toMatchObject({ count: 1 })
      snapshotAfterFirst = getDatabaseSnapshot(db1)
    } finally {
      db1.close()
    }

    // Re-run with the exact same command-id and same title: must exit 0, print duplicate <id>, and report duplicate
    const secondRun = runCli('task', 'create', '--state-dir', stateDir, '--title', 'Fix bug', '--command-id', customId)
    expect(secondRun.status).toBe(0)

    // Frozen contract: first stdout line is exactly `duplicate <commandId>`, followed by Arabic
    const secondLines = secondRun.stdout.trim().split(/\r?\n/)
    expect(secondLines[0]).toBe(`duplicate ${customId}`)
    expect(secondLines.length).toBeGreaterThanOrEqual(2)
    expect(secondLines[1]).toMatch(ARABIC_REGEX)
    // Observable discriminator: duplicate line differs from creation line
    expect(secondLines[0]).not.toBe(firstLines[0])

    const db2 = new DatabaseSync(dbPath)
    try {
      const snapshotAfterSecond = getDatabaseSnapshot(db2)
      // Complete snapshot verification: no additional row added and nothing changed
      expect(snapshotAfterSecond).toEqual(snapshotAfterFirst)
      expect(db2.prepare('SELECT COUNT(*) as count FROM commands').get()).toMatchObject({ count: 1 })
    } finally {
      db2.close()
    }
  })

  it('CHK-M3-02-b: task create with same command-id but different title exits 1 with Arabic error and leaves DB unchanged', () => {
    const stateDir = makeTempDir('factory-test-state-')
    const repoDir = makeTempDir('factory-test-repo-')
    createGitRepo(repoDir)

    expect(runCli('init', '--state-dir', stateDir, '--repo', repoDir).status).toBe(0)

    const customId = 'c2d3e4f5-2222-4222-8222-234567890def'
    const firstRun = runCli('task', 'create', '--state-dir', stateDir, '--title', 'First Title', '--command-id', customId)
    expect(firstRun.status).toBe(0)

    const dbPath = join(stateDir, 'state.sqlite')
    let snapshotBeforeConflict: Record<string, Array<Record<string, unknown>>>
    const dbBefore = new DatabaseSync(dbPath)
    try {
      snapshotBeforeConflict = getDatabaseSnapshot(dbBefore)
    } finally {
      dbBefore.close()
    }

    // Re-run with the same command-id but conflicting title
    const conflictRun = runCli('task', 'create', '--state-dir', stateDir, '--title', 'Conflicting Title', '--command-id', customId)
    expect(conflictRun.status).toBe(1)
    expect(conflictRun.stderr).toMatch(ARABIC_REGEX)

    const dbAfter = new DatabaseSync(dbPath)
    try {
      const snapshotAfterConflict = getDatabaseSnapshot(dbAfter)
      expect(snapshotAfterConflict).toEqual(snapshotBeforeConflict)

      const row = dbAfter.prepare('SELECT payload_json FROM commands WHERE id = ?').get(customId) as { payload_json: string }
      const payload = JSON.parse(row.payload_json) as { title: string }
      expect(payload.title).toBe('First Title')
    } finally {
      dbAfter.close()
    }
  })

  it('CHK-M3-02-b: task kill appends only a commands row and prints command id without running supervisor', () => {
    const stateDir = makeTempDir('factory-test-state-')
    const repoDir = makeTempDir('factory-test-repo-')
    createGitRepo(repoDir)

    expect(runCli('init', '--state-dir', stateDir, '--repo', repoDir).status).toBe(0)

    const dbPath = join(stateDir, 'state.sqlite')
    let snapshotBefore: Record<string, Array<Record<string, unknown>>>
    const dbBefore = new DatabaseSync(dbPath)
    try {
      seedRepresentativeDomainState(dbBefore)
      snapshotBefore = getDatabaseSnapshot(dbBefore)
      expect(snapshotBefore['tasks']!.length).toBeGreaterThan(0)
      expect(snapshotBefore['attempts']!.length).toBeGreaterThan(0)
    } finally {
      dbBefore.close()
    }

    const targetTaskId = 'cmd-seed-1'
    const killResult = runCli('task', 'kill', '--state-dir', stateDir, '--task', targetTaskId)
    expect(killResult.status).toBe(0)

    // Frozen contract: first stdout line is exactly `created <commandId>`, followed by an Arabic line
    const stdoutLines = killResult.stdout.trim().split(/\r?\n/)
    expect(stdoutLines[0]).toMatch(new RegExp(`^created ${UUID_REGEX.source}$`, 'i'))
    expect(stdoutLines.length).toBeGreaterThanOrEqual(2)
    expect(stdoutLines[1]).toMatch(ARABIC_REGEX)

    const commandId = stdoutLines[0]!.slice('created '.length)

    const dbAfter = new DatabaseSync(dbPath)
    try {
      const snapshotAfter = getDatabaseSnapshot(dbAfter)

      // Complete snapshot verification: only commands table is touched
      for (const table of Object.keys(snapshotBefore)) {
        if (table !== 'commands') {
          expect(snapshotAfter[table], `Table ${table} should remain identical`).toEqual(snapshotBefore[table])
        }
      }

      const beforeCommands = snapshotBefore['commands'] ?? []
      const afterCommands = snapshotAfter['commands'] ?? []
      expect(afterCommands).toHaveLength(beforeCommands.length + 1)

      const appendedRow = afterCommands.find((r) => r.id === commandId)
      expect(appendedRow).toBeDefined()
      expect(appendedRow?.kind).toBe('task.kill')

      // Assert project association and parsed payload shape { taskId: expectedTarget }
      const project = dbAfter.prepare('SELECT id FROM projects').get() as { id: string }
      expect(appendedRow?.project_id).toBe(project.id)

      const payload = JSON.parse(String(appendedRow?.payload_json ?? '{}'))
      expect(payload).toEqual({ taskId: targetTaskId })
    } finally {
      dbAfter.close()
    }
  })

  it('CHK-M3-02-b: task kill duplicate reports duplicate with printed ID and conflicting kill preserves command row', () => {
    const stateDir = makeTempDir('factory-test-state-')
    const repoDir = makeTempDir('factory-test-repo-')
    createGitRepo(repoDir)

    expect(runCli('init', '--state-dir', stateDir, '--repo', repoDir).status).toBe(0)

    const killCommandId = 'd3e4f5a6-3333-4333-8333-345678901abc'
    const firstKill = runCli('task', 'kill', '--state-dir', stateDir, '--task', 'task-001', '--command-id', killCommandId)
    expect(firstKill.status).toBe(0)

    // Frozen contract: first stdout line is exactly `created <commandId>`, followed by Arabic
    const firstKillLines = firstKill.stdout.trim().split(/\r?\n/)
    expect(firstKillLines[0]).toBe(`created ${killCommandId}`)
    expect(firstKillLines.length).toBeGreaterThanOrEqual(2)
    expect(firstKillLines[1]).toMatch(ARABIC_REGEX)

    const dbPath = join(stateDir, 'state.sqlite')
    let snapshotAfterFirst: Record<string, Array<Record<string, unknown>>>
    let storedKillRow: Record<string, unknown>
    const db1 = new DatabaseSync(dbPath)
    try {
      snapshotAfterFirst = getDatabaseSnapshot(db1)
      expect(snapshotAfterFirst['commands']).toHaveLength(1)
      storedKillRow = { ...snapshotAfterFirst['commands']![0]! }
      expect(storedKillRow.id).toBe(killCommandId)
      expect(storedKillRow.kind).toBe('task.kill')

      // Assert project association and parsed payload shape
      const project = db1.prepare('SELECT id FROM projects').get() as { id: string }
      expect(storedKillRow.project_id).toBe(project.id)
      const parsedPayload = JSON.parse(String(storedKillRow.payload_json ?? '{}'))
      expect(parsedPayload).toEqual({ taskId: 'task-001' })
    } finally {
      db1.close()
    }

    // Re-run with identical arguments -> duplicate reports exit 0, prints duplicate <id>, and reports duplicate in Arabic
    const duplicateKill = runCli('task', 'kill', '--state-dir', stateDir, '--task', 'task-001', '--command-id', killCommandId)
    expect(duplicateKill.status).toBe(0)

    // Frozen contract: first stdout line is exactly `duplicate <commandId>`, followed by Arabic
    const duplicateLines = duplicateKill.stdout.trim().split(/\r?\n/)
    expect(duplicateLines[0]).toBe(`duplicate ${killCommandId}`)
    expect(duplicateLines.length).toBeGreaterThanOrEqual(2)
    expect(duplicateLines[1]).toMatch(ARABIC_REGEX)
    // Observable discriminator: duplicate line differs from creation line
    expect(duplicateLines[0]).not.toBe(firstKillLines[0])

    const db2 = new DatabaseSync(dbPath)
    try {
      const snapshotAfterDup = getDatabaseSnapshot(db2)
      expect(snapshotAfterDup).toEqual(snapshotAfterFirst)
      expect(db2.prepare('SELECT COUNT(*) as count FROM commands').get()).toMatchObject({ count: 1 })
      const currentRow = db2.prepare('SELECT * FROM commands WHERE id = ?').get(killCommandId) as Record<string, unknown>
      expect(currentRow).toEqual(storedKillRow)
    } finally {
      db2.close()
    }

    // Re-run with same command-id but different task id -> conflict exits 1 with Arabic error and preserves row
    const conflictKill = runCli('task', 'kill', '--state-dir', stateDir, '--task', 'task-002', '--command-id', killCommandId)
    expect(conflictKill.status).toBe(1)
    expect(conflictKill.stderr).toMatch(ARABIC_REGEX)

    const db3 = new DatabaseSync(dbPath)
    try {
      const snapshotAfterConflict = getDatabaseSnapshot(db3)
      expect(snapshotAfterConflict).toEqual(snapshotAfterFirst)
      expect(db3.prepare('SELECT COUNT(*) as count FROM commands').get()).toMatchObject({ count: 1 })
      const currentRow = db3.prepare('SELECT * FROM commands WHERE id = ?').get(killCommandId) as Record<string, unknown>
      expect(currentRow).toEqual(storedKillRow)
    } finally {
      db3.close()
    }

    // Re-run with same command-id under task create -> conflict exits 1 with Arabic error and preserves row
    const crossKindConflict = runCli('task', 'create', '--state-dir', stateDir, '--title', 'Cross Kind Conflict', '--command-id', killCommandId)
    expect(crossKindConflict.status).toBe(1)
    expect(crossKindConflict.stderr).toMatch(ARABIC_REGEX)

    const db4 = new DatabaseSync(dbPath)
    try {
      const snapshotAfterCross = getDatabaseSnapshot(db4)
      expect(snapshotAfterCross).toEqual(snapshotAfterFirst)
      expect(db4.prepare('SELECT COUNT(*) as count FROM commands').get()).toMatchObject({ count: 1 })
      const currentRow = db4.prepare('SELECT * FROM commands WHERE id = ?').get(killCommandId) as Record<string, unknown>
      expect(currentRow).toEqual(storedKillRow)
    } finally {
      db4.close()
    }
  })

  it('CHK-M3-02-b: task commands exit 1 with Arabic error when state database does not exist', () => {
    const stateDir = makeTempDir('factory-uninitialized-')

    const createResult = runCli('task', 'create', '--state-dir', stateDir, '--title', 'Should Fail')
    expect(createResult.status).toBe(1)
    expect(createResult.stderr).toMatch(ARABIC_REGEX)

    const killResult = runCli('task', 'kill', '--state-dir', stateDir, '--task', 'task-any')
    expect(killResult.status).toBe(1)
    expect(killResult.stderr).toMatch(ARABIC_REGEX)
  })
})

describe('M3-02 CLI argument validation contract', () => {
  it('CHK-M3-02-f: exits 2 with Arabic usage on missing or invalid CLI arguments', () => {
    const validDir = makeTempDir('factory-arg-test-')
    const validRepo = makeTempDir('factory-arg-repo-')
    createGitRepo(validRepo)

    const badInvocations: string[][] = [
      // No arguments or unknown top-level command
      [],
      ['unknown-command'],
      ['init-typo'],
      // init argument errors
      ['init'],
      ['init', '--state-dir', validDir], // missing --repo
      ['init', '--repo', validRepo], // missing --state-dir
      ['init', '--state-dir'], // missing value
      ['init', '--state-dir', validDir, '--repo'], // missing value
      ['init', '--state-dir', '--repo', validRepo], // value starts with dash
      ['init', '--state-dir', validDir, '--repo', validRepo, '--unknown-option'],
      ['init', '--state-dir', validDir, '--state-dir', validDir, '--repo', validRepo], // duplicate option
      ['init', '--state-dir', validDir, '--repo', validRepo, '--repo', validRepo], // duplicate option
      // task argument errors
      ['task'],
      ['task', 'unknown-subcommand'],
      ['task', 'create'],
      ['task', 'create', '--state-dir', validDir], // missing --title
      ['task', 'create', '--title', 'Some Task'], // missing --state-dir
      ['task', 'create', '--state-dir', validDir, '--title', ''], // blank title
      ['task', 'create', '--state-dir', validDir, '--title', 'Valid', '--command-id', 'invalid-uuid'],
      ['task', 'create', '--state-dir', validDir, '--title', 'Valid', '--command-id'], // missing value
      ['task', 'create', '--state-dir', validDir, '--title', 'T1', '--title', 'T2'], // duplicate option
      ['task', 'create', '--state-dir', validDir, '--title', 'T1', '--extra'],
      ['task', 'kill'],
      ['task', 'kill', '--state-dir', validDir], // missing --task
      ['task', 'kill', '--task', 'task-1'], // missing --state-dir
      ['task', 'kill', '--state-dir', validDir, '--task', ''], // blank task id
      ['task', 'kill', '--state-dir', validDir, '--task', 't1', '--command-id', 'not-a-uuid'],
      ['task', 'kill', '--state-dir', validDir, '--task', 't1', '--extra-flag'],
    ]

    for (const args of badInvocations) {
      const res = runCli(...args)
      expect(
        res.status,
        `Expected exit 2 for: factory ${args.join(' ')}, but got status ${res.status}. Output: ${res.stdout}\nStderr: ${res.stderr}`,
      ).toBe(2)
      // Assert Arabic text in stderr
      expect(
        res.stderr,
        `Expected Arabic usage in stderr for: factory ${args.join(' ')}`,
      ).toMatch(ARABIC_REGEX)
      // Assert recognizable usage structure (usage keywords, program name 'factory', or option flags synopsis)
      const combinedOutput = `${res.stdout}\n${res.stderr}`
      expect(
        combinedOutput,
        `Expected recognizable usage structure for: factory ${args.join(' ')}`,
      ).toMatch(/factory|--state-dir|--repo|--title|--task|<[^>]+>|\[[^\]]+\]/i)
    }
  })
})
