// CHK-M1-03-e: scope check — protected dirs/files fail, in-scope paths pass.
// --base mode is also exercised on throwaway git repos in a temp dir.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { fixturePath, runScript, sha256 } from './helpers.ts'

const pathsFile = (name: string) => fixturePath('check-scope', `${name}.txt`)

const failingCases = ['docs', 'deep', 'protected', 'schemas', 'factory', 'licenses', 'manifest', 'notice', 'license', 'mixed']

interface TempGitRepo {
  dir: string
  base: string
}

function initGitRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'm1-03-scope-'))
  const git = (args: readonly string[]): ReturnType<typeof spawnSync> =>
    spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  git(['init', '-q', '-b', 'main'])
  git(['-c', 'user.email=builder@example.invalid', '-c', 'user.name=Builder', 'commit', '--allow-empty', '-q', '-m', 'seed'])
  return dir
}

function commitAll(dir: string, message: string): void {
  spawnSync('git', ['-C', dir, 'add', '-A'], { encoding: 'utf8' })
  spawnSync(
    'git',
    ['-C', dir, '-c', 'user.email=builder@example.invalid', '-c', 'user.name=Builder', 'commit', '-q', '-m', message],
    { encoding: 'utf8' },
  )
}

function headSha(dir: string): string {
  const res = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  return String(res.stdout ?? '').trim()
}

const tempDirs: string[] = []

function makeRepo(): TempGitRepo {
  const dir = initGitRepo()
  tempDirs.push(dir)
  return { dir, base: headSha(dir) }
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('check-scope --paths', () => {
  it('passes on an in-scope paths file', () => {
    const run = runScript('check-scope.mjs', ['--paths', pathsFile('ok')])
    expect(run.status).toBe(0)
    expect(run.stdout.trim()).toContain('OK')
  })

  it.each(failingCases)('fails on %s paths file', (name) => {
    const run = runScript('check-scope.mjs', ['--paths', pathsFile(name)])
    expect(run.status).toBe(1)
    const lines = run.stdout.trimEnd().split('\n')
    // one-line failure reason, no extra output
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^FAIL: /)
  })

  it('lists the offending paths in the failure reason', () => {
    const run = runScript('check-scope.mjs', ['--paths', pathsFile('mixed')])
    expect(run.status).toBe(1)
    expect(run.stdout.trim()).toContain('tests/protected/secret.spec.ts')
  })

  it('fails on a missing paths file', () => {
    const run = runScript('check-scope.mjs', ['--paths', fixturePath('check-scope', 'absent.txt')])
    expect(run.status).toBe(1)
    expect(run.stdout.trim()).toMatch(/^FAIL: /)
  })
})

describe('check-scope --base', () => {
  it('fails when the diff touches tests/protected', () => {
    const repo = makeRepo()
    mkdirSync(path.join(repo.dir, 'tests', 'protected'), { recursive: true })
    writeFileSync(path.join(repo.dir, 'tests', 'protected', 'core.spec.ts'), '// CHK\n')
    commitAll(repo.dir, 'oops protected')
    const run = runScript('check-scope.mjs', ['--base', repo.base], { cwd: repo.dir })
    expect(run.status).toBe(1)
    expect(run.stdout.trim()).toContain('tests/protected/core.spec.ts')
  })

  it('passes when the diff stays in scope', () => {
    const repo = makeRepo()
    mkdirSync(path.join(repo.dir, 'scripts'), { recursive: true })
    writeFileSync(path.join(repo.dir, 'scripts', 'ok.mjs'), `export const ok = ${'1'}\n`)
    commitAll(repo.dir, 'in scope')
    const run = runScript('check-scope.mjs', ['--base', repo.base], { cwd: repo.dir })
    expect(run.status).toBe(0)
    expect(run.stdout.trim()).toContain('OK')
  })

  it('fails on a docs diff', () => {
    const repo = makeRepo()
    mkdirSync(path.join(repo.dir, 'docs'), { recursive: true })
    writeFileSync(path.join(repo.dir, 'docs', 'note.md'), `#${sha256('note')}\n`)
    commitAll(repo.dir, 'oops docs')
    const run = runScript('check-scope.mjs', ['--base', repo.base], { cwd: repo.dir })
    expect(run.status).toBe(1)
    expect(run.stdout.trim()).toContain('docs/note.md')
  })

  it('fails when the diff is empty and no changes exist', () => {
    // empty diff -> pass with zero paths
    const repo = makeRepo()
    const run = runScript('check-scope.mjs', ['--base', repo.base], { cwd: repo.dir })
    expect(run.status).toBe(0)
    expect(run.stdout.trim()).toContain('OK')
  })

  it('fails on a base ref that does not exist', () => {
    const repo = makeRepo()
    const run = runScript('check-scope.mjs', ['--base', 'no-such-ref'], { cwd: repo.dir })
    expect(run.status).toBe(1)
    expect(run.stdout.trim()).toMatch(/^FAIL: git diff failed/)
  })
})
