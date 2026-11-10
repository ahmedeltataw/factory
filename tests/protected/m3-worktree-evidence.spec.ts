// M3-03 test interface (the implementer owns these exports):
// ensureWorktree({ stateDir, repoPath, baseRef }, taskId) -> worktree path.
// commitAttempt(worktreePath, attemptId) -> head SHA.
// recordEvidence(db, attemptId, { worktreePath, baseSha, stdoutPath, stderrPath,
//   exitCode }) -> head SHA on success; rejects nonzero exits or missing output
//   (missing log files or an unchanged worktree); stdout/stderr hashes use raw bytes,
//   committing and recording atomically with respect to the success gate.
// fake-executor.ts argv: <taskId> <nonce> <runDir>; worker.json contains
// { pid, nonce, grandchildPid }. All entry points may be synchronous or async.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import { openStore } from '../../supervisor/src/app/store.ts'
import { ensureWorktree } from '../../supervisor/src/app/worktree.ts'
import { commitAttempt, recordEvidence } from '../../supervisor/src/app/evidence.ts'

const dirs: string[] = []
const executor = join(process.cwd(), 'supervisor/src/executors/fake-executor.ts')
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Factory Test', '-c', 'user.email=factory@example.test', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'factory-m3-worktree-'))
  dirs.push(root)
  const repoPath = join(root, 'repo')
  const stateDir = join(root, 'state')
  mkdirSync(repoPath); mkdirSync(stateDir)
  git(repoPath, 'init')
  git(repoPath, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(repoPath, 'base.txt'), 'base\n')
  git(repoPath, 'add', '.')
  git(repoPath, 'commit', '-m', 'base')
  const baseSha = git(repoPath, 'rev-parse', 'HEAD')
  writeFileSync(join(repoPath, 'later.txt'), 'later\n')
  git(repoPath, 'add', '.')
  git(repoPath, 'commit', '-m', 'later')
  return { root, repoPath, stateDir, baseRef: baseSha, baseSha }
}
function database(stateDir: string, attempt = 'attempt-1') {
  const db = openStore(join(stateDir, 'state.sqlite'))
  db.prepare('INSERT INTO projects VALUES (?, ?, ?)').run('p', 'project', '2026-01-01')
  db.prepare('INSERT INTO commands VALUES (?, ?, ?, ?, ?)').run('c', 'p', 'task.create', '{}', '2026-01-01')
  db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?)').run('task-1', 'p', 'c', 'task', 'ready', '2026-01-01', '2026-01-01')
  db.prepare('INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation) VALUES (?, ?, ?, ?, ?)').run(attempt, 'task-1', 1, 'succeeded', 1)
  return db
}
function logs(root: string) {
  const stdoutPath = join(root, 'stdout.log'); const stderrPath = join(root, 'stderr.log')
  writeFileSync(stdoutPath, 'standard output\n'); writeFileSync(stderrPath, 'standard error\n')
  return { stdoutPath, stderrPath }
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('M3-03 worktree and evidence', () => {
  it('CHK-M3-03-a: creates the base branch once and rejects a different branch and escaping task IDs', async () => {
    const f = fixture()
    const path = await ensureWorktree(f, 'task-1')
    expect(path).toBe(join(f.stateDir, 'worktrees', 'task-1'))
    expect(git(path, 'branch', '--show-current')).toBe('factory/task/task-1')
    expect(git(path, 'rev-parse', 'HEAD')).toBe(f.baseSha)
    const before = git(f.repoPath, 'worktree', 'list', '--porcelain')
    expect(await ensureWorktree(f, 'task-1')).toBe(path)
    expect(git(f.repoPath, 'worktree', 'list', '--porcelain')).toBe(before)
    expect(git(f.repoPath, 'branch', '--list', 'factory/task/task-1').split('\n')).toHaveLength(1)
    git(path, 'checkout', '-b', 'other-branch')
    await expect(Promise.resolve().then(() => ensureWorktree(f, 'task-1'))).rejects.toThrow()
    for (const taskId of ['../../escape', '../escape', '../worktrees-evil']) {
      await expect(Promise.resolve().then(() => ensureWorktree(f, taskId))).rejects.toThrow()
    }
    expect(existsSync(join(f.root, 'escape'))).toBe(false)
  })

  it('CHK-M3-03-b: executor identifies itself first, creates a child and deterministic output, and respects sleep and exit code', async () => {
    const f = fixture(); const cwd = join(f.root, 'cwd'); const runDir = join(f.root, 'run')
    mkdirSync(cwd); mkdirSync(runDir)
    const start = Date.now()
    const child = spawn(process.execPath, [executor, 'task-1', 'nonce-123', runDir], { cwd, env: { ...process.env, FAKE_SLEEP_MS: '1200', FAKE_EXIT_CODE: '7' }, stdio: 'ignore' })
    const childExit = new Promise<number | null>(resolve => {
      child.once('exit', resolve)
      child.once('error', () => resolve(null))
    })
    const grandchildPids = new Set<number>()
    const workerPath = join(runDir, 'worker.json')
    try {
      const deadline = Date.now() + 5000
      let worker: { pid: number; nonce: string; grandchildPid: number } | undefined
      while (Date.now() < deadline) {
        try {
          const candidate = JSON.parse(readFileSync(workerPath, 'utf8')) as typeof worker
          if (candidate && typeof candidate.grandchildPid === 'number') {
            worker = candidate
            grandchildPids.add(candidate.grandchildPid)
            break
          }
        } catch { /* wait for the complete payload */ }
        await delay(20)
      }
      expect(worker).toBeDefined()
      if (!worker) throw new Error('worker.json did not contain a complete worker')
      expect(worker.pid).toBe(child.pid); expect(worker.nonce).toBe('nonce-123')
      expect(worker.grandchildPid).toBeGreaterThan(0)
      expect(worker.grandchildPid).not.toBe(worker.pid)
      expect(() => process.kill(worker!.grandchildPid, 0)).not.toThrow()
      expect(child.exitCode).toBeNull()
      const code = await childExit
      expect(code).toBe(7); expect(Date.now() - start).toBeGreaterThanOrEqual(1000)
      const outputPath = join(cwd, 'factory-fake', 'task-1.txt')
      const output = readFileSync(outputPath, 'utf8')
      expect(output.length).toBeGreaterThan(0)
      rmSync(outputPath)
      rmSync(workerPath)
      const second = spawnSync(process.execPath, [executor, 'task-1', 'nonce-456', runDir], { cwd, env: { ...process.env, FAKE_SLEEP_MS: '0', FAKE_EXIT_CODE: '0' }, encoding: 'utf8', timeout: 10000 })
      if (existsSync(workerPath)) {
        const secondWorker = JSON.parse(readFileSync(workerPath, 'utf8')) as { grandchildPid: number }
        if (typeof secondWorker.grandchildPid === 'number') grandchildPids.add(secondWorker.grandchildPid)
      }
      expect(second.status).toBe(0)
      expect(readFileSync(outputPath, 'utf8')).toBe(output)
      expect(git(f.repoPath, 'status', '--porcelain')).toBe('')
      expect(existsSync(join(f.root, 'factory-fake'))).toBe(false)
    } finally {
      for (const pid of grandchildPids) { if (pid > 0) { try { process.kill(pid) } catch { /* already exited */ } } }
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await childExit
    }
  }, 20000)

  it('CHK-M3-03-c: commits without hooks and returns the same trailer-bearing commit on retry', async () => {
    const f = fixture(); const path = await ensureWorktree(f, 'task-1')
    git(f.repoPath, 'config', 'user.name', 'wrong-repo-user')
    git(f.repoPath, 'config', 'user.email', 'wrong-repo@example.test')
    const hook = join(f.repoPath, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    writeFileSync(join(path, 'new.txt'), 'new\n')
    const head = await commitAttempt(path, 'attempt-1')
    expect(head).toBe(git(path, 'rev-parse', 'HEAD'))
    expect(git(path, 'log', '-1', '--format=%B')).toMatch(/(?:^|\n)Factory-Attempt: attempt-1(?:\n|$)/)
    const identity = git(path, 'show', '-s', '--format=%an%n%ae%n%cn%n%ce', head).split('\n')
    expect(identity[0]).not.toBe('wrong-repo-user'); expect(identity[1]).not.toBe('wrong-repo@example.test')
    expect(identity[2]).not.toBe('wrong-repo-user'); expect(identity[3]).not.toBe('wrong-repo@example.test')
    writeFileSync(join(path, 'new.txt'), 'changed\n')
    expect(await commitAttempt(path, 'attempt-1')).toBe(head)
    expect(git(path, 'rev-list', '--count', `${f.baseSha}..HEAD`)).toBe('1')
    const secondHead = await commitAttempt(path, 'attempt-2')
    expect(secondHead).not.toBe(head)
    expect(secondHead).toBe(git(path, 'rev-parse', 'HEAD'))
    expect(git(path, 'log', '-1', '--format=%B')).toMatch(/(?:^|\n)Factory-Attempt: attempt-2(?:\n|$)/)
    expect(git(path, 'rev-list', '--count', `${f.baseSha}..HEAD`)).toBe('2')
  })

  it('CHK-M3-03-d: records reproducible hashes and preserves the first immutable row', async () => {
    const f = fixture(); const path = await ensureWorktree(f, 'task-1'); const db = database(f.stateDir)
    try {
      mkdirSync(join(path, 'sub'))
      writeFileSync(join(path, 'sub', 'result.txt'), 'one\r\ntwo\r\n')
      const options = { worktreePath: path, baseSha: f.baseSha, ...logs(f.root), exitCode: 0 }
      const head = await recordEvidence(db, 'attempt-1', options)
      const row = db.prepare('SELECT * FROM evidence WHERE attempt_id = ?').get('attempt-1') as { base_sha: string; head_sha: string; files_json: string; stdout_sha256: string; stderr_sha256: string }
      expect(row.base_sha).toBe(f.baseSha); expect(row.head_sha).toBe(head)
      const files = JSON.parse(row.files_json) as Array<{ path: string; sha256: string }>
      expect(files.map(file => file.path)).toEqual(['sub/result.txt'])
      for (const file of files) {
        const bytes = execFileSync('git', ['show', `${row.head_sha}:${file.path}`], { cwd: path })
        expect(file.sha256).toBe(hash(bytes.toString('utf8').replace(/\r\n/g, '\n')))
      }
      expect(row.stdout_sha256).toBe(hash(readFileSync(options.stdoutPath)))
      expect(row.stderr_sha256).toBe(hash(readFileSync(options.stderrPath)))
      writeFileSync(options.stdoutPath, 'changed')
      await recordEvidence(db, 'attempt-1', options)
      expect(db.prepare('SELECT * FROM evidence WHERE attempt_id = ?').get('attempt-1')).toEqual(row)
    } finally { db.close() }
  })

  it('CHK-M3-03-d: property: file hashes normalize CRLF to LF', async () => {
    const f = fixture(); const path = await ensureWorktree(f, 'task-1'); const db = database(f.stateDir)
    try {
      const options = { worktreePath: path, baseSha: f.baseSha, ...logs(f.root), exitCode: 0 }
      await fc.assert(fc.asyncProperty(fc.array(fc.stringMatching(/^[a-z0-9]{0,12}$/), { minLength: 2, maxLength: 8 }), async (lines) => {
        const id = `prop-${randomUUID()}`
        db.prepare('INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation) VALUES (?, ?, ?, ?, ?)').run(id, 'task-1', Number(db.prepare('SELECT count(*) AS n FROM attempts').get()!.n) + 1, 'succeeded', 1)
        const content = id + '\r\n' + lines.join('\r\n') + '\r\n'
        writeFileSync(join(path, 'property.txt'), content)
        await recordEvidence(db, id, options)
        const row = db.prepare('SELECT files_json FROM evidence WHERE attempt_id = ?').get(id) as { files_json: string }
        const file = (JSON.parse(row.files_json) as Array<{ path: string; sha256: string }>).find(item => item.path === 'property.txt')
        expect(file?.sha256).toBe(hash(content.replace(/\r\n/g, '\n')))
      }), { numRuns: 20 })
    } finally { db.close() }
  }, 30000)

  it('CHK-M3-03-e: failures leave no commit or evidence; reuse removes stale dirty files', async () => {
    const f = fixture(); const path = await ensureWorktree(f, 'task-1'); const db = database(f.stateDir)
    try {
      writeFileSync(join(path, 'stale.txt'), 'left by previous attempt')
      writeFileSync(join(path, 'base.txt'), 'staged change\n')
      git(path, 'add', 'base.txt')
      const options = { worktreePath: path, baseSha: f.baseSha, ...logs(f.root), exitCode: 9 }
      await expect(Promise.resolve().then(() => recordEvidence(db, 'attempt-1', options))).rejects.toThrow()
      expect(git(path, 'rev-parse', 'HEAD')).toBe(f.baseSha)
      expect(db.prepare('SELECT * FROM evidence').all()).toHaveLength(0)
      await expect(Promise.resolve().then(() => recordEvidence(db, 'attempt-1', { ...options, exitCode: 0, stdoutPath: join(f.root, 'missing') }))).rejects.toThrow()
      expect(git(path, 'rev-parse', 'HEAD')).toBe(f.baseSha)
      expect(db.prepare('SELECT * FROM evidence').all()).toHaveLength(0)
      await expect(Promise.resolve().then(() => recordEvidence(db, 'attempt-1', { ...options, exitCode: 0, stderrPath: join(f.root, 'missing') }))).rejects.toThrow()
      expect(git(path, 'rev-parse', 'HEAD')).toBe(f.baseSha)
      expect(db.prepare('SELECT * FROM evidence').all()).toHaveLength(0)
      expect(await ensureWorktree(f, 'task-1')).toBe(path)
      expect(existsSync(join(path, 'stale.txt'))).toBe(false)
      expect(readFileSync(join(path, 'base.txt'), 'utf8')).toBe('base\n')
      expect(git(path, 'status', '--porcelain')).toBe('')
      await expect(Promise.resolve().then(() => recordEvidence(db, 'attempt-1', { ...options, exitCode: 0 }))).rejects.toThrow()
      expect(git(path, 'rev-parse', 'HEAD')).toBe(f.baseSha)
      expect(db.prepare('SELECT * FROM evidence').all()).toHaveLength(0)
      writeFileSync(join(path, 'fresh.txt'), 'current')
      await recordEvidence(db, 'attempt-1', { ...options, exitCode: 0 })
      const row = db.prepare('SELECT files_json FROM evidence WHERE attempt_id = ?').get('attempt-1') as { files_json: string }
      expect((JSON.parse(row.files_json) as Array<{ path: string }>).map(file => file.path)).toEqual(['fresh.txt'])
    } finally { db.close() }
  })
})
