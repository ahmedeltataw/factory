// CHK-M1-03-b: forbidden-import scan — positive and negative fixtures.
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fixturePath, runScript } from './helpers.ts'

const failingCases = [
  'bad-deepseek',
  'bad-cordis',
  'bad-feishu',
  'bad-dsh-prefix',
  'bad-dynamic',
  'bad-export-star',
  'bad-template-dynamic',
  'bad-multiline',
  'bad-regex-block',
  'bad-regex-line',
  'core-nodefs',
  'core-zod',
  'core-parent',
]

const okCases = ['ok-comment', 'ok-plain-string', 'ok-dynamic-interpolated', 'ok-regex-import']

describe('check-forbidden-imports', () => {
  it('passes on the clean fixture', () => {
    const run = runScript('check-forbidden-imports.mjs', [
      '--root',
      fixturePath('check-forbidden-imports', 'clean'),
    ])
    expect(run.status).toBe(0)
    expect(run.stdout.trim()).toContain('OK')
  })

  it.each(okCases)('passes on fixture %s (comment/string/dynamic-literal are not imports)', (dir) => {
    const run = runScript('check-forbidden-imports.mjs', [
      '--root',
      fixturePath('check-forbidden-imports', dir),
    ])
    expect(run.status).toBe(0)
    expect(run.stdout.trim()).toContain('OK')
  })

  it.each(failingCases)('fails on fixture %s', (dir) => {
    const run = runScript('check-forbidden-imports.mjs', [
      '--root',
      fixturePath('check-forbidden-imports', dir),
    ])
    expect(run.status).toBe(1)
    const lines = run.stdout.trimEnd().split('\n')
    // one-line failure reason, no extra output
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^FAIL: .+/)
  })

  it('fails when --root is missing its value', () => {
    const run = runScript('check-forbidden-imports.mjs', ['--root'])
    expect(run.status).toBe(1)
    expect(run.stdout.trim()).toMatch(/^FAIL: /)
  })
})
