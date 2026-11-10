import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { openStore } from '../supervisor/src/app/store.ts'
import { ensureWorktree } from '../supervisor/src/app/worktree.ts'
import { commitAttempt, recordEvidence } from '../supervisor/src/app/evidence.ts'

const dirs: string[] = []
const executor = join(process.cwd(), 'supervisor/src/executors/fake-executor.ts')
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Factory Test', '-c', 'user.email=factory@example.test', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim()
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'factory-m3-unit-'))
  dirs.push(root)
  const repoPath = join(root, 'repo')
  const stateDir = join(root, 'state')
  mkdirSync(repoPath)
  mkdirSync(stateDir)
  git(repoPath, 'init')
  git(repoPath, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(repoPath, 'base.txt'), 'base\n')
  git(repoPath, 'add', '.')
  git(repoPath, 'commit', '-m', 'base')
  const baseSha = git(repoPath, 'rev-parse', 'HEAD')
  return { root, repoPath, stateDir, baseRef: baseSha, baseSha }
}

function database(stateDir: string, attempt = 'attempt-1') {
  const db = openStore(join(stateDir, 'state.sqlite'))
  db.prepare('INSERT INTO projects VALUES (?, ?, ?)').run('p', 'project', '2026-01-01')
  db.prepare('INSERT INTO commands VALUES (?, ?, ?, ?, ?)').run(
    'c',
    'p',
    'task.create',
    '{}',
    '2026-01-01',
  )
  db.prepare('INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'task-1',
    'p',
    'c',
    'task',
    'ready',
    '2026-01-01',
    '2026-01-01',
  )
  db.prepare(
    'INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation) VALUES (?, ?, ?, ?, ?)',
  ).run(attempt, 'task-1', 1, 'succeeded', 1)
  return db
}

function logs(root: string) {
  const stdoutPath = join(root, 'stdout.log')
  const stderrPath = join(root, 'stderr.log')
  writeFileSync(stdoutPath, 'unit stdout\n')
  writeFileSync(stderrPath, 'unit stderr\n')
  return { stdoutPath, stderrPath }
}

function tryCreateDirSymlink(target: string, path: string): boolean {
  try {
    const type = process.platform === 'win32' ? 'junction' : 'dir'
    symlinkSync(target, path, type)
    return true
  } catch (err: any) {
    if (err.code === 'EPERM') return false
    throw err
  }
}

function tryCreateFileSymlink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, 'file')
    return true
  } catch (err: any) {
    if (err.code === 'EPERM') return false
    throw err
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  }
})

describe('M3-03 Unit / Contract tests', () => {
  it('ensureWorktree validates taskId format and enforces physical containment', async () => {
    const f = fixture()
    const path = await ensureWorktree(f, 'task-unit-1')
    expect(path).toBe(join(f.stateDir, 'worktrees', 'task-unit-1'))
    expect(git(path, 'branch', '--show-current')).toBe('factory/task/task-unit-1')

    // Second call is idempotent
    const pathAgain = await ensureWorktree(f, 'task-unit-1')
    expect(pathAgain).toBe(path)

    // Directory traversal attacks and invalid taskId names are rejected
    for (const bad of ['../escape', '../../escape', '..', '.', '', 'task/sub', 'evil*task', ' leading', '-bad']) {
      await expect(ensureWorktree(f, bad)).rejects.toThrow()
    }
  })

  it('ensureWorktree rejects redirected worktrees root escaping stateDir (skipped if EPERM)', async () => {
    const f = fixture()
    const outside = join(f.root, 'outside-worktrees')
    mkdirSync(outside)

    const worktreesDir = join(f.stateDir, 'worktrees')
    const created = tryCreateDirSymlink(outside, worktreesDir)
    if (!created) {
      return
    }

    await expect(ensureWorktree(f, 'task-redirect')).rejects.toThrow(/escapes stateDir/)
    expect(existsSync(join(outside, 'task-redirect'))).toBe(false)
  })

  it('ensureWorktree succeeds and supports reuse when repoPath is itself a linked worktree', async () => {
    const f = fixture()
    const linkedRepo = join(f.root, 'linked-repo')
    git(f.repoPath, 'worktree', 'add', '-b', 'linked-base-branch', linkedRepo, f.baseSha)

    const config = {
      stateDir: f.stateDir,
      repoPath: linkedRepo,
      baseRef: f.baseSha,
    }

    // 1. Initial creation from linked worktree
    const path = await ensureWorktree(config, 'task-from-linked')
    expect(path).toBe(join(f.stateDir, 'worktrees', 'task-from-linked'))
    expect(git(path, 'branch', '--show-current')).toBe('factory/task/task-from-linked')

    // 2. Reuse resets dirty state and passes canonical common-dir check
    writeFileSync(join(path, 'dirty.txt'), 'dirty content\n')
    const reusedPath = await ensureWorktree(config, 'task-from-linked')
    expect(reusedPath).toBe(path)
    expect(existsSync(join(path, 'dirty.txt'))).toBe(false)
    expect(git(path, 'status', '--porcelain')).toBe('')
  })

  it('commitAttempt handles empty changes and retry with same attempt trailer', async () => {
    const f = fixture()
    const path = await ensureWorktree(f, 'task-unit-2')

    // Invalid attemptId is rejected
    await expect(commitAttempt(path, '../evil')).rejects.toThrow()

    // Empty worktree throws
    await expect(commitAttempt(path, 'attempt-1')).rejects.toThrow()

    // Adding a file commits with trailer
    writeFileSync(join(path, 'hello.txt'), 'world\n')
    const head1 = await commitAttempt(path, 'attempt-1')
    expect(head1).toBe(git(path, 'rev-parse', 'HEAD'))
    expect(git(path, 'log', '-1', '--format=%B')).toContain('Factory-Attempt: attempt-1')

    // Retry with same attempt returns same head
    const headRetry = await commitAttempt(path, 'attempt-1')
    expect(headRetry).toBe(head1)

    // New attempt creates another commit
    writeFileSync(join(path, 'hello2.txt'), 'world2\n')
    const head2 = await commitAttempt(path, 'attempt-2')
    expect(head2).not.toBe(head1)
    expect(head2).toBe(git(path, 'rev-parse', 'HEAD'))
    expect(git(path, 'log', '-1', '--format=%B')).toContain('Factory-Attempt: attempt-2')
  })

  it('recordEvidence validates logs before commit, leaving HEAD and DB unchanged on failure', async () => {
    const f = fixture()
    const path = await ensureWorktree(f, 'task-1')
    const db = database(f.stateDir)

    try {
      const { stdoutPath, stderrPath } = logs(f.root)
      const options = { worktreePath: path, baseSha: f.baseSha, stdoutPath, stderrPath, exitCode: 0 }

      writeFileSync(join(path, 'change.txt'), 'pending work\n')

      // Missing stdout log leaves HEAD and evidence unchanged
      await expect(
        recordEvidence(db, 'attempt-1', { ...options, stdoutPath: join(f.root, 'missing.log') }),
      ).rejects.toThrow()
      expect(git(path, 'rev-parse', 'HEAD')).toBe(f.baseSha)
      expect(db.prepare('SELECT count(*) as count FROM evidence').get()).toEqual({ count: 0 })

      // Directory passed as stdout log leaves HEAD and evidence unchanged
      const dirAsLog = join(f.root, 'dir-as-log')
      mkdirSync(dirAsLog)
      await expect(
        recordEvidence(db, 'attempt-1', { ...options, stdoutPath: dirAsLog }),
      ).rejects.toThrow()
      expect(git(path, 'rev-parse', 'HEAD')).toBe(f.baseSha)
      expect(db.prepare('SELECT count(*) as count FROM evidence').get()).toEqual({ count: 0 })

      // Invalid attemptId leaves HEAD and evidence unchanged
      await expect(
        recordEvidence(db, '../../bad-id', options),
      ).rejects.toThrow()
      expect(git(path, 'rev-parse', 'HEAD')).toBe(f.baseSha)
      expect(db.prepare('SELECT count(*) as count FROM evidence').get()).toEqual({ count: 0 })

      // Valid execution records evidence successfully
      const head = await recordEvidence(db, 'attempt-1', options)
      expect(head).toBe(git(path, 'rev-parse', 'HEAD'))
      expect(db.prepare('SELECT count(*) as count FROM evidence').get()).toEqual({ count: 1 })
    } finally {
      db.close()
    }
  })

  it('recordEvidence supports Arabic filenames using NUL-delimited diff parsing', async () => {
    const f = fixture()
    const path = await ensureWorktree(f, 'task-1')
    const db = database(f.stateDir, 'attempt-arabic')

    try {
      const { stdoutPath, stderrPath } = logs(f.root)
      const options = { worktreePath: path, baseSha: f.baseSha, stdoutPath, stderrPath, exitCode: 0 }

      const arabicName = 'تقرير-نهائي.txt'
      const arabicContent = 'هذا ملف اختبار باللغة العربية\n'
      writeFileSync(join(path, arabicName), arabicContent)

      const head = await recordEvidence(db, 'attempt-arabic', options)
      expect(head).toBe(git(path, 'rev-parse', 'HEAD'))

      const row = db.prepare('SELECT * FROM evidence WHERE attempt_id = ?').get('attempt-arabic') as {
        files_json: string
        head_sha: string
      }
      const files = JSON.parse(row.files_json) as Array<{ path: string; sha256: string }>
      expect(files.some((file) => file.path === arabicName)).toBe(true)

      const arabicFile = files.find((file) => file.path === arabicName)!
      const gitBytes = execFileSync('git', ['show', `${head}:${arabicName}`], { cwd: path })
      expect(arabicFile.sha256).toBe(hash(gitBytes.toString('utf8').replace(/\r\n/g, '\n')))
    } finally {
      db.close()
    }
  })

  it('fake-executor validates taskId escaping and exits 2 without creating files', async () => {
    const f = fixture()
    const cwd = join(f.root, 'cwd')
    const runDir = join(f.root, 'run')
    mkdirSync(cwd)
    mkdirSync(runDir)

    const res = spawnSync(
      process.execPath,
      [executor, '../../escape', 'nonce-esc', runDir],
      { cwd, encoding: 'utf8' },
    )
    expect(res.status).toBe(2)
    expect(existsSync(join(cwd, '..', 'escape.txt'))).toBe(false)
    expect(existsSync(join(cwd, 'factory-fake'))).toBe(false)
  })

  it('fake-executor rejects factory-fake junction pointing outside cwd (skipped if EPERM)', () => {
    const f = fixture()
    const cwd = join(f.root, 'cwd')
    const outside = join(f.root, 'outside')
    const runDir = join(f.root, 'run')
    mkdirSync(cwd)
    mkdirSync(outside)
    mkdirSync(runDir)

    const fakeDir = join(cwd, 'factory-fake')
    const created = tryCreateDirSymlink(outside, fakeDir)
    if (!created) {
      return
    }

    const res = spawnSync(
      process.execPath,
      [executor, 'task-fake-junc', 'nonce-junc', runDir],
      { cwd, encoding: 'utf8' },
    )
    expect(res.status).toBe(2)
    expect(existsSync(join(outside, 'task-fake-junc.txt'))).toBe(false)
  })

  it('fake-executor rejects redirected taskId.txt symlink pointing outside (skipped if EPERM)', () => {
    const f = fixture()
    const cwd = join(f.root, 'cwd')
    const outside = join(f.root, 'outside')
    const runDir = join(f.root, 'run')
    mkdirSync(cwd)
    mkdirSync(outside)
    mkdirSync(runDir)

    const fakeDir = join(cwd, 'factory-fake')
    mkdirSync(fakeDir)
    const targetFile = join(outside, 'secret.txt')
    writeFileSync(targetFile, 'initial\n')

    const outputFile = join(fakeDir, 'task-sym.txt')
    const created = tryCreateFileSymlink(targetFile, outputFile)
    if (!created) {
      return
    }

    const res = spawnSync(
      process.execPath,
      [executor, 'task-sym', 'nonce-sym', runDir],
      { cwd, encoding: 'utf8' },
    )
    expect(res.status).toBe(2)
    expect(readFileSync(targetFile, 'utf8')).toBe('initial\n')
  })

  it('fake-executor rejects redirected worker.json symlink pointing outside (skipped if EPERM)', () => {
    const f = fixture()
    const cwd = join(f.root, 'cwd')
    const outside = join(f.root, 'outside')
    const runDir = join(f.root, 'run')
    mkdirSync(cwd)
    mkdirSync(outside)
    mkdirSync(runDir)

    const targetFile = join(outside, 'external-worker.json')
    writeFileSync(targetFile, 'original-external-content\n')

    const workerFile = join(runDir, 'worker.json')
    const created = tryCreateFileSymlink(targetFile, workerFile)
    if (!created) {
      return
    }

    const res = spawnSync(
      process.execPath,
      [executor, 'task-worker-sym', 'nonce-worker-sym', runDir],
      { cwd, encoding: 'utf8' },
    )
    expect(res.status).toBe(2)
    expect(readFileSync(targetFile, 'utf8')).toBe('original-external-content\n')
  })

  it('fake-executor stops grandchild on normal completion and grandchild exits on parent death', async () => {
    const f = fixture()
    const cwd = join(f.root, 'cwd')
    const runDir = join(f.root, 'run')
    mkdirSync(cwd)
    mkdirSync(runDir)

    // Case 1: Normal completion kills grandchild before exit
    const child = spawn(
      process.execPath,
      [executor, 'task-lifecycle', 'nonce-norm', runDir],
      { cwd, env: { ...process.env, FAKE_SLEEP_MS: '100', FAKE_EXIT_CODE: '0' }, stdio: 'ignore' },
    )
    const childExit = new Promise<number | null>((resolve) => {
      child.once('exit', resolve)
      child.once('error', () => resolve(null))
    })

    const workerPath = join(runDir, 'worker.json')
    let grandchildPid = 0
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      try {
        const candidate = JSON.parse(readFileSync(workerPath, 'utf8')) as { grandchildPid?: number }
        if (typeof candidate?.grandchildPid === 'number') {
          grandchildPid = candidate.grandchildPid
          break
        }
      } catch {
        // wait
      }
      await delay(20)
    }

    expect(grandchildPid).toBeGreaterThan(0)
    // Grandchild is alive while child sleeps
    expect(() => process.kill(grandchildPid, 0)).not.toThrow()

    // Wait for normal completion
    const exitCode = await childExit
    expect(exitCode).toBe(0)

    // Grandchild must have been stopped and awaited by the executor
    await delay(100)
    expect(() => process.kill(grandchildPid, 0)).toThrow()

    // Case 2: Parent death handling (grandchild detects dead parent and exits itself)
    rmSync(workerPath)
    const runDir2 = join(f.root, 'run2')
    mkdirSync(runDir2)
    const workerPath2 = join(runDir2, 'worker.json')

    const child2 = spawn(
      process.execPath,
      [executor, 'task-parent-death', 'nonce-death', runDir2],
      { cwd, env: { ...process.env, FAKE_SLEEP_MS: '10000', FAKE_EXIT_CODE: '0' }, stdio: 'ignore' },
    )
    const child2Exit = new Promise<number | null>((resolve) => {
      child2.once('exit', resolve)
      child2.once('error', () => resolve(null))
    })

    let grandchildPid2 = 0
    const deadline2 = Date.now() + 5000
    while (Date.now() < deadline2) {
      try {
        const candidate = JSON.parse(readFileSync(workerPath2, 'utf8')) as { grandchildPid?: number }
        if (typeof candidate?.grandchildPid === 'number') {
          grandchildPid2 = candidate.grandchildPid
          break
        }
      } catch {
        // wait
      }
      await delay(20)
    }

    expect(grandchildPid2).toBeGreaterThan(0)
    expect(() => process.kill(grandchildPid2, 0)).not.toThrow()

    // Abruptly kill the executor parent
    child2.kill('SIGTERM')
    await child2Exit

    // Grandchild should detect dead parent within its 200 ms check interval and exit
    await delay(500)
    expect(() => process.kill(grandchildPid2, 0)).toThrow()
  })
})
