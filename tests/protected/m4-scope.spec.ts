// Frozen signatures:
// parseScope(input: unknown): { ok: true; scope: string[] } | { ok: false; reason: string }
// scopesOverlap(a: string[], b: string[]): boolean
// pathInScope(path: string, scope: string[]): boolean
import { describe, expect, it } from 'vitest'
import { parseScope, scopesOverlap, pathInScope } from '../../supervisor/src/core/scope.ts'

describe('M4-02 scope contract', () => {
  it('CHK-M4-02-a accepts boundaries and normalizes entries', () => {
    const entries = Array.from({ length: 32 }, (_, i) => `item${String(i).padStart(2, '0')}`)
    expect(parseScope(entries)).toEqual({ ok: true, scope: entries })
    expect(parseScope(['x'.repeat(200)])).toEqual({ ok: true, scope: ['x'.repeat(200)] })
    expect(parseScope(['z', 'a/b/c', 'B', 'a', 'z', 'a/b', 'ab', 'a-b', 'A/b'])).toEqual({
      ok: true, scope: ['A/b', 'B', 'a', 'a-b', 'ab', 'z'],
    })
    expect(parseScope(['z', '.', 'a/b'])).toEqual({ ok: true, scope: ['.'] })
    expect(parseScope(['a/.gitignore', 'a/...', 'é/😀'])).toEqual({
      ok: true, scope: ['a/...', 'a/.gitignore', 'é/😀'],
    })
  })

  it.each<[string, unknown]>([
    ['not an array', 'src'], ['zero entries', []],
    ['33 entries', Array.from({ length: 33 }, (_, i) => `p${i}`)],
    ['non-string', ['src', 1]], ['empty entry', ['']], ['201 units', ['x'.repeat(201)]],
    ['lone high surrogate', ['\ud800']], ['lone low surrogate', ['\udc00']],
    ['control U+0000', ['a\u0000b']], ['control U+001F', ['a\u001fb']],
    ['control U+007F', ['a\u007fb']], ['backslash', ['a\\b']], ['colon', ['a:b']],
    ['asterisk', ['a*b']], ['question mark', ['a?b']], ['opening bracket', ['a[b']],
    ['closing bracket', ['a]b']], ['leading slash', ['/a']], ['trailing slash', ['a/']],
    ['empty segment', ['a//b']], ['dot segment', ['a/./b']],
    ['dot-dot segment', ['a/../b']], ['.git segment', ['a/.git/b']],
    ['.GIT segment', ['.GIT/config']], ['bare .git', ['.git']],
    ['whole dot-dot', ['..']], ['leading dot segment', ['./a']],
    ['trailing dot segment', ['a/.']], ['leading dot-dot segment', ['../a']],
    ['trailing dot-dot segment', ['a/..']], ['dot with invalid entry', ['.', '../bad']],
  ])('CHK-M4-02-b rejects %s with a reason', (_label, input) => {
    const result = parseScope(input)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('Expected rejection')
    expect(typeof result.reason).toBe('string')
    expect(result.reason.length).toBeGreaterThan(0)
  })

  it.each<[string[], string[], boolean]>([
    [['src/a'], ['src/a'], true], [['src/a'], ['src/a/b'], true],
    [['src/a/b'], ['src/a'], true], [['.'], ['src/a'], true],
    [['src/a'], ['.'], true], [['SRC/A'], ['src/a/b'], true],
    [['SRC/A'], ['src/a'], true], [['src/a/b'], ['SRC/A'], true],
    [['src/a'], ['src/ab'], false], [['src/a'], ['other/a'], false],
    [['other', 'SRC/A'], ['none', 'src/a/x'], true],
  ])('CHK-M4-02-c overlap %j and %j is %s', (a, b, expected) => {
    expect(scopesOverlap(a, b)).toBe(expected)
  })

  it.each<[string, string[], boolean]>([
    ['src/a', ['.'], true], ['src/a', ['src/a'], true],
    ['src/a/file', ['src/a'], true], ['src/ab/x', ['src/a'], false],
    ['src', ['src/a'], false], ['SRC/a/file', ['src/a'], false],
    ['src/A', ['src/a'], false], ['other/file', ['src/a', 'other'], true],
    ['elsewhere', ['src/a', 'other'], false],
  ])('CHK-M4-02-d path %s in %j is %s', (path, scope, expected) => {
    expect(pathInScope(path, scope)).toBe(expected)
  })
})
