import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ensureWorktree } from '../supervisor/src/app/worktree.ts'

it('creates and reuses a worktree through a Windows 8.3 state path', async (context) => {
  if (process.platform !== 'win32') {
    console.log('Skipping 8.3 path test: Windows only')
    context.skip()
    return
  }
  const root = mkdtempSync(join(tmpdir(), 'factory-m3-short-path-'))
  try {
    const stateDir = join(root, 'long state directory name')
    const repoPath = join(root, 'repo')
    mkdirSync(stateDir)
    mkdirSync(repoPath)
    const result = spawnSync('cmd.exe', ['/d', '/c', `for %I in ("${stateDir}") do @echo %~sI`], {
      encoding: 'utf8', windowsVerbatimArguments: true,
    })
    expect(result.status, result.stderr).toBe(0)
    const shortStateDir = result.stdout.trim()
    if (shortStateDir.toLowerCase() === stateDir.toLowerCase()) {
      console.log('Skipping 8.3 path test: volume did not provide a short spelling')
      context.skip()
      return
    }
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' }).trim()
    git('init')
    writeFileSync(join(repoPath, 'base.txt'), 'base\n')
    git('add', '.')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'base')
    const config = { repoPath, stateDir: shortStateDir, baseRef: git('rev-parse', 'HEAD') }
    const path = await ensureWorktree(config, 'short-path')
    writeFileSync(join(path, 'dirty.txt'), 'dirty')
    expect(await ensureWorktree(config, 'short-path')).toBe(path)
    expect(git('-C', path, 'status', '--porcelain')).toBe('')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
