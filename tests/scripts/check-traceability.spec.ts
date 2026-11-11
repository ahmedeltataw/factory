// CHK-M1-03-c: traceability — CHK ids of the card section must be covered by
// the evidence record (pass, or not-run with deferred_to).
import path from 'node:path'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { fixturePath, runScript } from './helpers.ts'

const specMd = (name: string) => fixturePath('check-traceability', name)

describe('check-traceability', () => {
  it('passes when every CHK id of the card section has a pass result', () => {
    const run = runScript('check-traceability.mjs', [
      '--spec',
      specMd('spec.md'),
      '--card',
      'M1-T',
      '--evidence',
      specMd('evidence-pass.json'),
    ])
    expect(run.status).toBe(0)
    expect(run.stdout.trim()).toContain('OK')
  })

  it('counts not-run with deferred_to as covered', () => {
    const run = runScript('check-traceability.mjs', [
      '--spec',
      specMd('spec.md'),
      '--card',
      'M1-T',
      '--evidence',
      specMd('evidence-deferred.json'),
    ])
    expect(run.status).toBe(0)
    expect(run.stdout.trim()).toContain('OK')
  })

  it('fails when a CHK id has no evidence entry', () => {
    const run = runScript('check-traceability.mjs', [
      '--spec',
      specMd('spec.md'),
      '--card',
      'M1-T',
      '--evidence',
      specMd('evidence-missing.json'),
    ])
    expect(run.status).toBe(1)
    expect(run.stdout.trim()).toMatch(/^FAIL: .*CHK-M1-T-b/)
  })

  it('does not count a fail result as pass', () => {
    const run = runScript('check-traceability.mjs', [
      '--spec',
      specMd('spec.md'),
      '--card',
      'M1-T',
      '--evidence',
      specMd('evidence-fail.json'),
    ])
    expect(run.status).toBe(1)
    expect(run.stdout.trim()).toMatch(/^FAIL: .*CHK-M1-T-b/)
  })

  it('ignores CHK ids from other cards', () => {
    const run = runScript('check-traceability.mjs', [
      '--spec',
      specMd('spec.md'),
      '--card',
      'M1-T',
      '--evidence',
      specMd('evidence-other.json'),
    ])
    expect(run.status).toBe(1)
    expect(run.stdout.trim()).toMatch(/^FAIL: .*CHK-M1-T-a/)
  })

  it('fails when the card section is missing from the spec', () => {
    const run = runScript('check-traceability.mjs', [
      '--spec',
      specMd('spec.md'),
      '--card',
      'M1-Z',
      '--evidence',
      specMd('evidence-pass.json'),
    ])
    expect(run.status).toBe(1)
    expect(run.stdout.trim()).toMatch(/^FAIL: .*not found/)
  })

  it('fails when the card section contains no CHK ids', () => {
    const run = runScript('check-traceability.mjs', [
      '--spec',
      specMd('spec.md'),
      '--card',
      'M1-V',
      '--evidence',
      specMd('evidence-pass.json'),
    ])
    expect(run.status).toBe(1)
    expect(run.stdout.trim()).toMatch(/^FAIL: /)
  })

  it('fails when the evidence file does not exist', () => {
    const run = runScript('check-traceability.mjs', [
      '--spec',
      specMd('spec.md'),
      '--card',
      'M1-T',
      '--evidence',
      specMd('no-such-evidence.json'),
    ])
    expect(run.status).toBe(1)
    expect(run.stdout.trim()).toMatch(/^FAIL: /)
  })

  it('fails when flags are missing', () => {
    const run = runScript('check-traceability.mjs', ['--spec', specMd('spec.md')])
    expect(run.status).toBe(1)
    expect(run.stdout.trim()).toMatch(/^FAIL: /)
  })

  it('does not end the section at a #### sub-heading', () => {
    const run = runScript('check-traceability.mjs', [
      '--spec',
      specMd('spec-subheading.md'),
      '--card',
      'M1-W',
      '--evidence',
      specMd('evidence-subheading.json'),
    ])
    expect(run.status).toBe(0)
    expect(run.stdout.trim()).toContain('OK (2 check(s) covered)')
  })

  it('rejects --all combined with other flags', () => {
    const run = runScript('check-traceability.mjs', [
      '--all',
      '--spec',
      specMd('spec.md'),
    ])
    expect(run.status).toBe(1)
    expect(run.stdout.trim()).toMatch(/^FAIL: --all cannot be combined/)
  })
})

describe('check-traceability --all', () => {
  const allRoot = (name: string) => fixturePath('check-traceability', name)

  it('lists pending cards but still rejects failing or missing evidence', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'traceability-'))
    try {
      mkdirSync(path.join(root, 'docs', 'milestones'), { recursive: true })
      mkdirSync(path.join(root, '.factory', 'evidence', 'M4-PASS'), { recursive: true })
      writeFileSync(path.join(root, 'docs', 'milestones', 'M4.md'),
        '### M4-PASS\nCHK-M4-PASS-a\n### M4-PENDING\nCHK-M4-PENDING-a\n')
      const evidence = path.join(root, '.factory', 'evidence', 'M4-PASS', '1.json')
      writeFileSync(evidence, JSON.stringify({ card: 'M4-PASS', attempt: 1, checks: [{ id: 'CHK-M4-PASS-a', result: 'pass' }] }))
      const args = ['--all', '--require-passing', '--present-only']
      const passing = runScript('check-traceability.mjs', args, { cwd: root })
      expect(passing.status).toBe(0)
      expect(passing.stdout).toContain('PENDING: M4-PENDING')
      writeFileSync(evidence, JSON.stringify({ card: 'M4-PASS', attempt: 1, checks: [{ id: 'CHK-M4-PASS-a', result: 'fail' }] }))
      const failing = runScript('check-traceability.mjs', args, { cwd: root })
      expect(failing.status).toBe(1)
      expect(failing.stdout).toContain('M4-PASS')
      mkdirSync(path.join(root, '.factory', 'evidence', 'M4-PENDING'))
      const empty = runScript('check-traceability.mjs', args, { cwd: root })
      expect(empty.status).toBe(1)
      expect(empty.stdout).toContain('missing evidence record for card M4-PENDING')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects --present-only without --all', () => {
    const run = runScript('check-traceability.mjs', ['--present-only'])
    expect(run.status).toBe(1)
    expect(run.stdout).toContain('--present-only can only be used with --all')
  })

  it('fails when one checked card has an uncovered check (fixture: pass + fail + section-less card)', () => {
    const run = runScript('check-traceability.mjs', ['--all'], { cwd: allRoot('all') })
    expect(run.status).toBe(1)
    const output = run.stdout.trim()
    // the failing card is named with its uncovered check id
    expect(output).toMatch(/^FAIL: ALL-F: /)
    expect(output).toContain('CHK-ALL-F-a')
    // the record with the highest attempt is used (attempt 2, a fail result)
    expect(output).toMatch(/^FAIL: ALL-F: 1 check\(s\) without pass result/)
    // the passing card was checked (cards are listed in sorted order)
    expect(output).toContain('checked 2 card(s): ALL-F, ALL-P')
    // the card without a spec section is skipped and listed
    expect(output).toContain('skipped: ALL-S')
  })

  it('passes when every checked card is covered', () => {
    const run = runScript('check-traceability.mjs', ['--all'], { cwd: allRoot('all-pass') })
    expect(run.status).toBe(0)
    const output = run.stdout.trim()
    expect(output).toMatch(/^OK /)
    expect(output).toContain('checked 1 card(s): ALL-P')
    expect(output).toContain('skipped: ALL-S')
  })

  it('fails when no fixture docs/milestones directory exists', () => {
    const run = runScript('check-traceability.mjs', ['--all'], {
      cwd: fixturePath('check-forbidden-imports', 'clean'),
    })
    expect(run.status).toBe(1)
    expect(run.stdout.trim()).toMatch(/^FAIL: cannot read docs[\\/]milestones/)
  })
})
