// CHK-M1-03-g: Windows-flavoured paths must behave like POSIX paths —
// backslash separators in the paths file and lower-case drive letters in --root.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { fixturePath, lowercaseDrive, runScript } from './helpers.ts'

const tempDirs: string[] = []
const scratchFile = (name: string, content: string): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'm1-03-winpaths-'))
  tempDirs.push(dir)
  const file = path.join(dir, name)
  writeFileSync(file, content)
  return file
}

const absolute = (rel: string) => path.resolve(rel)

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('check-scope with Windows separators', () => {
  it('fails on docs\\x.md', () => {
    const run = runScript('check-scope.mjs', [
      '--paths',
      scratchFile('docs.txt', 'docs\\x.md\n'),
    ])
    expect(run.status).toBe(1)
    expect(run.stdout.trim()).toContain('docs/x.md')
  })

  it('fails on tests\\protected\\a.ts', () => {
    const run = runScript('check-scope.mjs', [
      '--paths',
      scratchFile('protected.txt', 'tests\\protected\\a.ts\n'),
    ])
    expect(run.status).toBe(1)
    expect(run.stdout.trim()).toContain('tests/protected/a.ts')
  })

  it('passes on scripts\\ok.mjs', () => {
    const run = runScript('check-scope.mjs', [
      '--paths',
      scratchFile('ok.txt', 'scripts\\ok.mjs\n'),
    ])
    expect(run.status).toBe(0)
    expect(run.stdout.trim()).toContain('OK')
  })
})

describe('check-forbidden-imports with lower-case drive letter', () => {
  it('clean fixture: same result for lower-case and upper-case drive', () => {
    const upper = absolute(fixturePath('check-forbidden-imports', 'clean'))
    const lower = lowercaseDrive(upper)
    expect(lower.slice(0, 2)).toBe(lower.slice(0, 2).toLowerCase())
    for (const rootArg of [lower, upper]) {
      const run = runScript('check-forbidden-imports.mjs', ['--root', rootArg])
      expect(run.status).toBe(0)
      expect(run.stdout.trim()).toContain('OK')
    }
  })

  it('failing fixture: same result for lower-case and upper-case drive', () => {
    const upper = absolute(fixturePath('check-forbidden-imports', 'bad-deepseek'))
    const lower = lowercaseDrive(upper)
    for (const rootArg of [lower, upper]) {
      const run = runScript('check-forbidden-imports.mjs', ['--root', rootArg])
      expect(run.status).toBe(1)
      expect(run.stdout.trim()).toMatch(/^FAIL: /)
    }
  })
})
