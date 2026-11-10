// Frozen signatures:
// parseScope(input: unknown): { ok: true; scope: string[] } | { ok: false; reason: string }
// scopesOverlap(a: string[], b: string[]): boolean
// pathInScope(path: string, scope: string[]): boolean
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parseScope, scopesOverlap, pathInScope } from '../../supervisor/src/core/scope.ts'
import { runScript } from '../scripts/helpers.ts'

const segment = fc.array(fc.constantFrom('a', 'b', 'A', 'B', '0', '_', '-'), { minLength: 1, maxLength: 5 })
  .map((chars) => chars.join(''))
const entry = fc.array(segment, { minLength: 1, maxLength: 3 }).map((parts) => parts.join('/'))
const entries = fc.array(fc.oneof({ weight: 19, arbitrary: entry }, { weight: 1, arbitrary: fc.constant('.') }), { minLength: 1, maxLength: 8 })

function normalized(input: string[]): string[] {
  const result = parseScope(input)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(`Valid generated scope rejected: ${result.reason}`)
  return result.scope
}

describe('M4-02 scope properties', () => {
  it('CHK-M4-02-e normalization is idempotent', () => {
    fc.assert(fc.property(entries, (input) => {
      const scope = normalized(input)
      expect(parseScope(scope)).toEqual({ ok: true, scope })
    }), { numRuns: 200 })
  })

  it('CHK-M4-02-e overlap is symmetric for independent and related scopes', () => {
    fc.assert(fc.property(entries, entries, entry, segment, (left, right, base, child) => {
      const a = normalized(left)
      const b = normalized(right)
      expect(scopesOverlap(a, b)).toBe(scopesOverlap(b, a))
      expect(scopesOverlap([base], [`${base}/${child}`])).toBe(true)
      expect(scopesOverlap([`${base}/${child}`], [base])).toBe(true)
    }), { numRuns: 200 })
  })

  it('CHK-M4-02-e shared included paths imply overlap', () => {
    fc.assert(fc.property(entry, segment, entries, entries, (base, child, left, right) => {
      const path = `${base}/${child}`
      const a = normalized([...left, base])
      const b = normalized([...right, path])
      expect(pathInScope(path, a)).toBe(true)
      expect(pathInScope(path, b)).toBe(true)
      expect(scopesOverlap(a, b)).toBe(true)
    }), { numRuns: 200 })
  })

  it('CHK-M4-02-e forbidden-imports passes on the repository', () => {
    const result = runScript('check-forbidden-imports.mjs')
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
  })
})
