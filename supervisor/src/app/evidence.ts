import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'

export interface RecordEvidenceOptions {
  worktreePath: string
  baseSha: string
  stdoutPath: string
  stderrPath: string
  exitCode: number
}

const ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function hasAttemptTrailer(message: string, attemptId: string): boolean {
  for (const line of message.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('Factory-Attempt:')) {
      const value = trimmed.slice('Factory-Attempt:'.length).trim()
      if (value === attemptId) return true
    }
  }
  return false
}

function readLogFile(logPath: string, name: string): Buffer {
  if (!existsSync(logPath)) {
    throw new Error(`recordEvidence: missing ${name} log file at "${logPath}"`)
  }
  const stat = statSync(logPath)
  if (!stat.isFile()) {
    throw new Error(`recordEvidence: ${name} log at "${logPath}" is not a regular file`)
  }
  return readFileSync(logPath)
}

/**
 * Commits the current worktree state with a fixed supervisor identity,
 * --no-verify, and a `Factory-Attempt: <attemptId>` trailer.
 *
 * If HEAD already carries that trailer, returns the existing commit SHA
 * without creating a new commit.
 */
export async function commitAttempt(
  worktreePath: string,
  attemptId: string,
): Promise<string> {
  if (!ID_REGEX.test(attemptId)) {
    throw new Error(`commitAttempt: invalid attemptId "${attemptId}"`)
  }

  let currentHead: string | null = null
  try {
    currentHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch {
    currentHead = null
  }

  if (currentHead) {
    const commitMsg = execFileSync('git', ['log', '-1', '--format=%B', currentHead], {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (hasAttemptTrailer(commitMsg, attemptId)) {
      return currentHead
    }
  }

  // Stage all working tree changes
  execFileSync('git', ['add', '-A'], {
    cwd: worktreePath,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd: worktreePath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

  if (!status) {
    throw new Error(`commitAttempt: no changes to commit in worktree "${worktreePath}"`)
  }

  const message = `Attempt ${attemptId}\n\nFactory-Attempt: ${attemptId}\n`
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Factory Supervisor',
      '-c',
      'user.email=supervisor@factory.local',
      'commit',
      '--no-verify',
      '-m',
      message,
    ],
    {
      cwd: worktreePath,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  const newHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: worktreePath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

  return newHead
}

/**
 * Records attempt execution evidence in the database.
 *
 * Gates on successful execution (exitCode === 0, log files exist and are readable regular files, worktree changed).
 * Commit and database recording are atomic with respect to the success gate.
 * If evidence for this attempt was already recorded, returns the existing head SHA
 * without modifying the immutable evidence row.
 */
export async function recordEvidence(
  db: DatabaseSync,
  attemptId: string,
  options: RecordEvidenceOptions,
): Promise<string> {
  // 1. Validate attemptId format
  if (!ID_REGEX.test(attemptId)) {
    throw new Error(`recordEvidence: invalid attemptId "${attemptId}"`)
  }

  // 2. Success gate: exitCode must be zero
  if (options.exitCode !== 0) {
    throw new Error(`recordEvidence: process failed with nonzero exit code ${options.exitCode}`)
  }

  // 3. Success gate: stdout and stderr log files must exist, be regular files, and be readable BEFORE any commit
  const stdoutBytes = readLogFile(options.stdoutPath, 'stdout')
  const stderrBytes = readLogFile(options.stderrPath, 'stderr')

  // 4. Immutability check: if already recorded, return the recorded head SHA
  const existing = db
    .prepare('SELECT head_sha FROM evidence WHERE attempt_id = ?')
    .get(attemptId) as { head_sha: string } | undefined
  if (existing) {
    return existing.head_sha
  }

  // 5. Success gate: worktree must not be unchanged
  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd: options.worktreePath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

  const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: options.worktreePath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

  if (status.length === 0) {
    let hasTrailer = false
    if (currentHead && currentHead !== options.baseSha) {
      const commitMsg = execFileSync('git', ['log', '-1', '--format=%B', currentHead], {
        cwd: options.worktreePath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      hasTrailer = hasAttemptTrailer(commitMsg, attemptId)
    }
    if (!hasTrailer) {
      throw new Error(`recordEvidence: unchanged worktree for attempt "${attemptId}"`)
    }
  }

  // 6. Commit attempt and get HEAD SHA
  const headSha = await commitAttempt(options.worktreePath, attemptId)
  if (headSha === options.baseSha) {
    throw new Error(`recordEvidence: unchanged worktree, head SHA matches base SHA`)
  }

  // 7. Gather changed files between base and head using -z (NUL delimiter) to avoid quoting non-ASCII names
  const diffOutput = execFileSync(
    'git',
    [
      '-c',
      'core.quotepath=false',
      'diff',
      '--name-only',
      '-z',
      '--diff-filter=d',
      options.baseSha,
      headSha,
    ],
    {
      cwd: options.worktreePath,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  const diffStr = diffOutput.toString('utf8')
  const filePaths = diffStr.split('\0').filter((p) => p.length > 0)
  if (filePaths.length === 0) {
    throw new Error(`recordEvidence: unchanged worktree, no modified or added files`)
  }

  const files: Array<{ path: string; sha256: string }> = []
  for (const filePath of filePaths) {
    const posixPath = filePath.replace(/\\/g, '/')
    const bytes = execFileSync('git', ['show', `${headSha}:${filePath}`], {
      cwd: options.worktreePath,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const normalized = bytes.toString('utf8').replace(/\r\n/g, '\n')
    const fileSha256 = createHash('sha256').update(normalized, 'utf8').digest('hex')
    files.push({ path: posixPath, sha256: fileSha256 })
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  // 8. Hash stdout and stderr as raw bytes (from pre-validated buffers)
  const stdoutSha256 = createHash('sha256').update(stdoutBytes).digest('hex')
  const stderrSha256 = createHash('sha256').update(stderrBytes).digest('hex')

  // 9. Insert evidence row (immutable, insert-or-keep-first)
  const recordedAt = new Date().toISOString()
  try {
    db.prepare(`
      INSERT INTO evidence (attempt_id, base_sha, head_sha, files_json, stdout_sha256, stderr_sha256, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      attemptId,
      options.baseSha,
      headSha,
      JSON.stringify(files),
      stdoutSha256,
      stderrSha256,
      recordedAt,
    )
  } catch (error) {
    const recheck = db
      .prepare('SELECT head_sha FROM evidence WHERE attempt_id = ?')
      .get(attemptId) as { head_sha: string } | undefined
    if (recheck) {
      return recheck.head_sha
    }
    throw error
  }

  return headSha
}
