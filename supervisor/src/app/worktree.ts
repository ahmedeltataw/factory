import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export interface EnsureWorktreeConfig {
  stateDir: string
  repoPath: string
  baseRef: string
}

const ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function canonicalPath(path: string): string {
  let existing = resolve(path)
  const missing: string[] = []
  while (!existsSync(existing)) {
    try { lstatSync(existing); break } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const parent = dirname(existing)
    if (parent === existing) break
    missing.unshift(existing.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)))
    existing = parent
  }
  const canonical = resolve(realpathSync.native(existing), ...missing)
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

/**
 * Ensures a worktree exists for a given task on branch `factory/task/<taskId>`
 * branching from `baseRef`.
 *
 * Enforces lexical and physical path containment, and validates that an existing
 * worktree's top level and git common dir strictly belong to the configured repository
 * before performing any reset or clean operations.
 */
export async function ensureWorktree(
  config: EnsureWorktreeConfig,
  taskId: string,
): Promise<string> {
  // 1. Validate taskId format
  if (!taskId || !ID_REGEX.test(taskId)) {
    throw new Error(`worktree: invalid taskId "${taskId}"`)
  }

  // 2. Physical stateDir containment check for worktrees root
  const stateDir = resolve(config.stateDir)
  mkdirSync(stateDir, { recursive: true })
  const realStateDir = canonicalPath(stateDir)

  const worktreesDir = resolve(stateDir, 'worktrees')

  // Check if worktreesDir exists as a symlink/junction escaping stateDir
  if (existsSync(worktreesDir)) {
    const realWorktrees = canonicalPath(worktreesDir)
    const relWorktrees = relative(realStateDir, realWorktrees)
    if (
      !relWorktrees ||
      relWorktrees.startsWith('..') ||
      isAbsolute(relWorktrees) ||
      relWorktrees.split(sep).includes('..')
    ) {
      throw new Error(`worktree: worktrees directory "${worktreesDir}" escapes stateDir "${stateDir}"`)
    }
  }

  mkdirSync(worktreesDir, { recursive: true })
  const realWorktreesDir = canonicalPath(worktreesDir)
  const relWorktrees = relative(realStateDir, realWorktreesDir)
  if (
    !relWorktrees ||
    relWorktrees.startsWith('..') ||
    isAbsolute(relWorktrees) ||
    relWorktrees.split(sep).includes('..')
  ) {
    throw new Error(`worktree: worktrees directory "${worktreesDir}" escapes stateDir "${stateDir}"`)
  }

  // 3. Target path containment check
  const targetPath = resolve(worktreesDir, taskId)
  const relLexical = relative(worktreesDir, targetPath)
  if (
    !relLexical ||
    relLexical.startsWith('..') ||
    isAbsolute(relLexical) ||
    relLexical.split(sep).includes('..')
  ) {
    throw new Error(`worktree: invalid taskId "${taskId}" escapes worktrees directory`)
  }

  // Resolve the nearest existing parent when the target has not been created yet.
  const realTargetPath = canonicalPath(targetPath)
  const relPhysical = relative(realWorktreesDir, realTargetPath)
  if (
    !relPhysical ||
    relPhysical.startsWith('..') ||
    isAbsolute(relPhysical) ||
    relPhysical.split(sep).includes('..')
  ) {
    throw new Error(`worktree: physical containment violation for target "${targetPath}"`)
  }

  const branch = `factory/task/${taskId}`

  if (existsSync(targetPath)) {
    // Verify git branch
    let currentBranch: string
    try {
      currentBranch = execFileSync('git', ['branch', '--show-current'], {
        cwd: targetPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
    } catch (error) {
      throw new Error(`worktree: directory "${targetPath}" is not a valid git worktree: ${error}`)
    }

    if (currentBranch !== branch) {
      throw new Error(
        `worktree: existing worktree at "${targetPath}" is on branch "${currentBranch}", expected "${branch}"`,
      )
    }

    // Verify rev-parse --show-toplevel realpath equals realTargetPath
    let topLevel: string
    try {
      topLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: targetPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
    } catch (error) {
      throw new Error(`worktree: failed to get git show-toplevel for "${targetPath}": ${error}`)
    }

    if (canonicalPath(topLevel) !== realTargetPath) {
      throw new Error(
        `worktree: show-toplevel "${topLevel}" does not match target path "${targetPath}"`,
      )
    }

    // Verify canonical git common-dir of target matches canonical common-dir of configured repo
    let targetCommonDirRaw: string
    try {
      targetCommonDirRaw = execFileSync('git', ['rev-parse', '--git-common-dir'], {
        cwd: targetPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
    } catch (error) {
      throw new Error(`worktree: failed to get git common-dir for "${targetPath}": ${error}`)
    }
    const targetCommonDir = resolve(targetPath, targetCommonDirRaw)

    let repoCommonDirRaw: string
    try {
      repoCommonDirRaw = execFileSync('git', ['rev-parse', '--git-common-dir'], {
        cwd: config.repoPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
    } catch (error) {
      throw new Error(`worktree: failed to get git common-dir for configured repo "${config.repoPath}": ${error}`)
    }
    const repoCommonDir = resolve(config.repoPath, repoCommonDirRaw)

    if (canonicalPath(targetCommonDir) !== canonicalPath(repoCommonDir)) {
      throw new Error(
        `worktree: common dir "${targetCommonDir}" does not belong to configured repo "${config.repoPath}"`,
      )
    }

    // Safe to reset dirty tracked files and remove untracked files
    execFileSync('git', ['reset', '--hard', 'HEAD'], {
      cwd: targetPath,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    execFileSync('git', ['clean', '-fdx'], {
      cwd: targetPath,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    return targetPath
  }

  // Prune any stale worktree entries in git metadata
  try {
    execFileSync('git', ['worktree', 'prune'], {
      cwd: config.repoPath,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    // Ignore prune errors
  }

  let branchExists = false
  try {
    const branches = execFileSync('git', ['branch', '--list', branch], {
      cwd: config.repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    branchExists = branches.length > 0
  } catch {
    branchExists = false
  }

  if (branchExists) {
    execFileSync('git', ['worktree', 'add', targetPath, branch], {
      cwd: config.repoPath,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } else {
    execFileSync('git', ['worktree', 'add', '-b', branch, targetPath, config.baseRef], {
      cwd: config.repoPath,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }

  return targetPath
}
