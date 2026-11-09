import path from 'node:path'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { fixturePath, runScript } from '../scripts/helpers.ts'

const fixture = (...parts: string[]) => fixturePath('check-traceability', ...parts)
const cardArgs = (evidence: string) => ['--spec', fixture('spec.md'), '--card', 'M1-T', '--evidence', fixture(evidence)]

it('CHK-M1-TRACE-STRICT-a: a deferral covers planning but is not a passing result', () => {
  expect(runScript('check-traceability.mjs', cardArgs('evidence-deferred.json')).status).toBe(0)
  const strict = runScript('check-traceability.mjs', [...cardArgs('evidence-deferred.json'), '--require-passing'])
  expect(strict.status).toBe(1)
  expect(strict.stdout).toContain('CHK-M1-T-b')
})

it('CHK-M1-TRACE-STRICT-b: strict mode accepts passing evidence and works in all mode', () => {
  expect(runScript('check-traceability.mjs', [...cardArgs('evidence-pass.json'), '--require-passing']).status).toBe(0)
  const root = path.join(fixture('all-pass'))
  expect(runScript('check-traceability.mjs', ['--all', '--require-passing', '--card-prefix', 'ALL-P'], { cwd: root }).status).toBe(0)
  expect(runScript('check-traceability.mjs', ['--all', '--require-passing'], { cwd: root }).status).toBe(1)
  const scopedPlanning = runScript('check-traceability.mjs', ['--all', '--card-prefix', 'ALL-P'], { cwd: root })
  expect(scopedPlanning.status).toBe(0)
  expect(scopedPlanning.stdout).not.toContain('ALL-S')
  expect(runScript('check-traceability.mjs', [...cardArgs('evidence-missing.json'), '--require-passing']).status).toBe(1)
})

it('CHK-M1-TRACE-STRICT-b: strict all mode detects spec cards with no evidence directory', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'factory-trace-strict-'))
  try {
    cpSync(fixture('all-pass'), root, { recursive: true })
    rmSync(path.join(root, '.factory', 'evidence', 'ALL-S'), { recursive: true })
    appendFileSync(path.join(root, 'docs', 'milestones', 'M1P.md'), '\n### ALL-M Missing card\n- CHK-ALL-M-a: evidence is required.\n')
    const strict = runScript('check-traceability.mjs', ['--all', '--require-passing'], { cwd: root })
    expect(strict.status).toBe(1)
    expect(strict.stdout).toContain('ALL-M')
    expect(runScript('check-traceability.mjs', ['--all', '--require-passing', '--card-prefix', 'ALL-P'], { cwd: root }).status).toBe(0)
    expect(runScript('check-traceability.mjs', ['--all', '--require-passing', '--card-prefix', 'NO-SUCH-CARD'], { cwd: root }).status).toBe(1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('CHK-M1-TRACE-STRICT-b: a scoped card without checks cannot be skipped', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'factory-trace-no-checks-'))
  try {
    cpSync(fixture('all-pass'), root, { recursive: true })
    appendFileSync(path.join(root, 'docs', 'milestones', 'M1P.md'), '\n### ALL-X Missing checks\nNo checks listed.\n')
    const result = runScript('check-traceability.mjs', ['--all', '--require-passing', '--card-prefix', 'ALL-'], { cwd: root })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('ALL-X')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('CHK-M1-TRACE-STRICT-b: scoped evidence without a matching spec fails', () => {
  const root = path.join(fixture('all-pass'))
  const result = runScript('check-traceability.mjs', ['--all', '--require-passing', '--card-prefix', 'ALL-'], { cwd: root })
  expect(result.status).toBe(1)
  expect(result.stdout).toContain('ALL-S')
})

it('CHK-M1-TRACE-STRICT-b: strict mode rejects conflicting results for the same check', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'factory-trace-duplicates-'))
  try {
    const record = JSON.parse(readFileSync(fixture('evidence-pass.json'), 'utf8')) as { checks: Array<{ id: string; result: string }> }
    const id = record.checks[0]!.id
    record.checks.push({ id, result: 'fail' })
    const evidence = path.join(root, 'conflicting.json')
    writeFileSync(evidence, JSON.stringify(record))
    const result = runScript('check-traceability.mjs', ['--spec', fixture('spec.md'), '--card', 'M1-T', '--evidence', evidence, '--require-passing'])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain(id)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('CHK-M1-TRACE-STRICT-b: strict mode rejects corrupt and ambiguous attempt records', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'factory-trace-attempts-'))
  try {
    cpSync(fixture('all-pass'), root, { recursive: true })
    const dir = path.join(root, '.factory', 'evidence', 'ALL-P')
    writeFileSync(path.join(dir, '2.json'), '{')
    const corrupt = runScript('check-traceability.mjs', ['--all', '--require-passing', '--card-prefix', 'ALL-P'], { cwd: root })
    expect(corrupt.status).toBe(1)
    expect(corrupt.stdout).toContain('is not valid JSON')
    const original = readFileSync(path.join(dir, '1.json'), 'utf8')
    writeFileSync(path.join(dir, '2.json'), original)
    const duplicate = runScript('check-traceability.mjs', ['--all', '--require-passing', '--card-prefix', 'ALL-P'], { cwd: root })
    expect(duplicate.status).toBe(1)
    expect(duplicate.stdout).toContain('duplicate attempt 1 for card ALL-P')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('CHK-M2-06-b: strict all mode ignores step-0 evidence', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'factory-trace-step-'))
  try {
    cpSync(fixture('all-pass'), root, { recursive: true })
    rmSync(path.join(root, '.factory', 'evidence', 'ALL-S'), { recursive: true })
    const step = path.join(root, '.factory', 'evidence', 'step-0')
    mkdirSync(step)
    writeFileSync(path.join(step, '1.json'), '{')
    expect(runScript('check-traceability.mjs', ['--all', '--require-passing'], { cwd: root }).status).toBe(0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
