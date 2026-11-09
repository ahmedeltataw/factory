import path from 'node:path'
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
  expect(runScript('check-traceability.mjs', ['--all', '--require-passing'], { cwd: root }).status).toBe(0)
  expect(runScript('check-traceability.mjs', [...cardArgs('evidence-missing.json'), '--require-passing']).status).toBe(1)
})
