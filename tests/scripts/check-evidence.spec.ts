// CHK-M1-03-d: evidence record validation — negative tests for every rule.
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fixturePath, runScript } from './helpers.ts'

const record = (name: string) => fixturePath('check-evidence', name, 'record.json')

const failingCases = [
  'missing-field',
  'empty-checks',
  'missing-id',
  'missing-result',
  'bad-result',
  'fail-result',
  'not-run-no-deferred',
]

describe('check-evidence', () => {
  it('passes on a valid record', () => {
    const run = runScript('check-evidence.mjs', [record('valid')])
    expect(run.status).toBe(0)
    expect(run.stdout.trim()).toContain('OK')
  })

  it('passes on a record with not-run + deferred_to', () => {
    const run = runScript('check-evidence.mjs', [record('deferred-valid')])
    expect(run.status).toBe(0)
    expect(run.stdout.trim()).toContain('OK')
  })

  it('passes on several valid records at once', () => {
    const run = runScript('check-evidence.mjs', [record('valid'), record('deferred-valid')])
    expect(run.status).toBe(0)
    expect(run.stdout.trim()).toContain('OK')
  })

  it.each(failingCases)('fails on fixture %s', (name) => {
    const run = runScript('check-evidence.mjs', [record(name)])
    expect(run.status).toBe(1)
    const lines = run.stdout.trimEnd().split('\n')
    // one-line failure reason, no extra output
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^FAIL: /)
  })

  it('fails on a missing file', () => {
    const run = runScript('check-evidence.mjs', [fixturePath('check-evidence', 'absent.json')])
    expect(run.status).toBe(1)
    expect(run.stdout.trim()).toMatch(/^FAIL: /)
  })

  it('fails with no arguments', () => {
    const run = runScript('check-evidence.mjs', [])
    expect(run.status).toBe(1)
    expect(run.stdout.trim()).toMatch(/^FAIL: /)
  })
})
