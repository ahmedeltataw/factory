// CHK-M1-03-c: traceability — CHK ids of the card section must be covered by
// the evidence record (pass, or not-run with deferred_to).
import path from 'node:path'
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
})
