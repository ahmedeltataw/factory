import { describe, expect, it } from 'vitest'
import { parseScope, scopesOverlap, pathInScope } from '../supervisor/src/core/scope.ts'

describe('M4-02 focused scope unit tests', () => {
  describe('parseScope reject reason paths and boundaries', () => {
    it('rejects non-array inputs with correct reason', () => {
      expect(parseScope(null)).toEqual({ ok: false, reason: 'scope must be an array' })
      expect(parseScope(undefined)).toEqual({ ok: false, reason: 'scope must be an array' })
      expect(parseScope(123)).toEqual({ ok: false, reason: 'scope must be an array' })
      expect(parseScope('src')).toEqual({ ok: false, reason: 'scope must be an array' })
      expect(parseScope({})).toEqual({ ok: false, reason: 'scope must be an array' })
      expect(parseScope(true)).toEqual({ ok: false, reason: 'scope must be an array' })
    })

    it('rejects array length boundaries (0 and 33) and accepts 1 and 32', () => {
      expect(parseScope([])).toEqual({ ok: false, reason: 'scope array must not be empty' })
      expect(parseScope(['a'])).toEqual({ ok: true, scope: ['a'] })

      const entries32 = Array.from({ length: 32 }, (_, i) => `item${String(i).padStart(2, '0')}`)
      expect(parseScope(entries32)).toEqual({ ok: true, scope: entries32.sort() })

      const entries33 = Array.from({ length: 33 }, (_, i) => `item${String(i).padStart(2, '0')}`)
      expect(parseScope(entries33)).toEqual({ ok: false, reason: 'scope array must contain at most 32 entries' })
    })

    it('rejects non-string entries', () => {
      expect(parseScope([123])).toEqual({ ok: false, reason: 'scope entry must be a string' })
      expect(parseScope([null])).toEqual({ ok: false, reason: 'scope entry must be a string' })
      expect(parseScope([undefined])).toEqual({ ok: false, reason: 'scope entry must be a string' })
      expect(parseScope([{}])).toEqual({ ok: false, reason: 'scope entry must be a string' })
      expect(parseScope([true])).toEqual({ ok: false, reason: 'scope entry must be a string' })
    })

    it('rejects entry length boundaries (0 and 201) and accepts 1 and 200', () => {
      expect(parseScope([''])).toEqual({ ok: false, reason: 'scope entry must not be empty' })
      expect(parseScope(['x'])).toEqual({ ok: true, scope: ['x'] })
      expect(parseScope(['x'.repeat(200)])).toEqual({ ok: true, scope: ['x'.repeat(200)] })
      expect(parseScope(['x'.repeat(201)])).toEqual({ ok: false, reason: 'scope entry must not exceed 200 characters' })
    })

    it('rejects ill-formed UTF-16 surrogates', () => {
      expect(parseScope(['\ud800'])).toEqual({ ok: false, reason: 'scope entry must be well-formed UTF-16' })
      expect(parseScope(['\udc00'])).toEqual({ ok: false, reason: 'scope entry must be well-formed UTF-16' })
    })

    it('checks control character boundaries: U+0000, U+001F, U+0020 ok, U+007F', () => {
      expect(parseScope(['\u0000'])).toEqual({ ok: false, reason: 'scope entry must not contain control characters' })
      expect(parseScope(['a\u0000b'])).toEqual({ ok: false, reason: 'scope entry must not contain control characters' })
      expect(parseScope(['\u001f'])).toEqual({ ok: false, reason: 'scope entry must not contain control characters' })
      expect(parseScope(['a\u001fb'])).toEqual({ ok: false, reason: 'scope entry must not contain control characters' })
      expect(parseScope(['\u007f'])).toEqual({ ok: false, reason: 'scope entry must not contain control characters' })
      expect(parseScope(['a\u007fb'])).toEqual({ ok: false, reason: 'scope entry must not contain control characters' })

      // U+0020 (space) is valid printable ASCII when not at segment edges
      expect(parseScope(['a b'])).toEqual({ ok: true, scope: ['a b'] })
      expect(parseScope(['a b/c'])).toEqual({ ok: true, scope: ['a b/c'] })
      expect(parseScope(['foo bar/baz qux'])).toEqual({ ok: true, scope: ['foo bar/baz qux'] })
    })

    it('checks printable ASCII boundaries: U+007D ok, U+0080 non-ASCII', () => {
      // U+007D ('}') is valid printable ASCII
      expect(parseScope(['a}b'])).toEqual({ ok: true, scope: ['a}b'] })
      expect(parseScope(['a{b|c}d'])).toEqual({ ok: true, scope: ['a{b|c}d'] })

      // U+0080 and above are non-ASCII and must be rejected
      expect(parseScope(['\u0080'])).toEqual({ ok: false, reason: 'scope entry must contain printable ASCII only' })
      expect(parseScope(['a\u0080b'])).toEqual({ ok: false, reason: 'scope entry must contain printable ASCII only' })
      expect(parseScope(['é/file'])).toEqual({ ok: false, reason: 'scope entry must contain printable ASCII only' })
      expect(parseScope(['😀'])).toEqual({ ok: false, reason: 'scope entry must contain printable ASCII only' })
    })

    it('rejects tilde ~ (short-name 8.3 alias) with dedicated reason', () => {
      expect(parseScope(['~'])).toEqual({ ok: false, reason: 'scope entry must not contain ~' })
      expect(parseScope(['a~b'])).toEqual({ ok: false, reason: 'scope entry must not contain ~' })
      expect(parseScope(['LONGDI~1'])).toEqual({ ok: false, reason: 'scope entry must not contain ~' })
      expect(parseScope(['a/~b'])).toEqual({ ok: false, reason: 'scope entry must not contain ~' })
      expect(parseScope(['a/b~'])).toEqual({ ok: false, reason: 'scope entry must not contain ~' })
      // U+007E is ~
      expect(parseScope(['\u007e'])).toEqual({ ok: false, reason: 'scope entry must not contain ~' })
    })

    it('rejects forbidden characters \\, :, *, ?, [, ]', () => {
      expect(parseScope(['a\\b'])).toEqual({ ok: false, reason: 'scope entry must not contain forbidden characters' })
      expect(parseScope(['a:b'])).toEqual({ ok: false, reason: 'scope entry must not contain forbidden characters' })
      expect(parseScope(['a*b'])).toEqual({ ok: false, reason: 'scope entry must not contain forbidden characters' })
      expect(parseScope(['a?b'])).toEqual({ ok: false, reason: 'scope entry must not contain forbidden characters' })
      expect(parseScope(['a[b'])).toEqual({ ok: false, reason: 'scope entry must not contain forbidden characters' })
      expect(parseScope(['a]b'])).toEqual({ ok: false, reason: 'scope entry must not contain forbidden characters' })
    })

    it('rejects leading and trailing slashes', () => {
      expect(parseScope(['/a'])).toEqual({ ok: false, reason: 'scope entry must not start with /' })
      expect(parseScope(['a/'])).toEqual({ ok: false, reason: 'scope entry must not end with /' })
      expect(parseScope(['/'])).toEqual({ ok: false, reason: 'scope entry must not start with /' })
    })

    it('rejects invalid segment shapes: empty, dot, dot-dot, leading/trailing space, trailing dot, .git', () => {
      // Empty segments
      expect(parseScope(['a//b'])).toEqual({ ok: false, reason: 'scope entry must not contain empty segments' })

      // Dot segments
      expect(parseScope(['a/./b'])).toEqual({ ok: false, reason: 'scope entry must not contain dot segments' })
      expect(parseScope(['./a'])).toEqual({ ok: false, reason: 'scope entry must not contain dot segments' })
      expect(parseScope(['a/.'])).toEqual({ ok: false, reason: 'scope entry must not contain dot segments' })

      // Dot-dot segments
      expect(parseScope(['a/../b'])).toEqual({ ok: false, reason: 'scope entry must not contain dot-dot segments' })
      expect(parseScope(['..'])).toEqual({ ok: false, reason: 'scope entry must not contain dot-dot segments' })
      expect(parseScope(['../a'])).toEqual({ ok: false, reason: 'scope entry must not contain dot-dot segments' })
      expect(parseScope(['a/..'])).toEqual({ ok: false, reason: 'scope entry must not contain dot-dot segments' })

      // Leading space in segment
      expect(parseScope([' a'])).toEqual({ ok: false, reason: 'scope entry segment must not start with space' })
      expect(parseScope(['a/ b'])).toEqual({ ok: false, reason: 'scope entry segment must not start with space' })
      expect(parseScope([' a/b'])).toEqual({ ok: false, reason: 'scope entry segment must not start with space' })
      expect(parseScope(['a/ b/c'])).toEqual({ ok: false, reason: 'scope entry segment must not start with space' })

      // Trailing space in segment
      expect(parseScope(['a '])).toEqual({ ok: false, reason: 'scope entry segment must not end with space' })
      expect(parseScope(['a /b'])).toEqual({ ok: false, reason: 'scope entry segment must not end with space' })
      expect(parseScope(['a/b '])).toEqual({ ok: false, reason: 'scope entry segment must not end with space' })
      expect(parseScope(['.git '])).toEqual({ ok: false, reason: 'scope entry segment must not end with space' })
      expect(parseScope(['a/b /c'])).toEqual({ ok: false, reason: 'scope entry segment must not end with space' })

      // Trailing dot in segment
      expect(parseScope(['README.md.'])).toEqual({ ok: false, reason: 'scope entry segment must not end with dot' })
      expect(parseScope(['a.'])).toEqual({ ok: false, reason: 'scope entry segment must not end with dot' })
      expect(parseScope(['a/b.'])).toEqual({ ok: false, reason: 'scope entry segment must not end with dot' })
      expect(parseScope(['a./b'])).toEqual({ ok: false, reason: 'scope entry segment must not end with dot' })
      expect(parseScope(['a/b./c'])).toEqual({ ok: false, reason: 'scope entry segment must not end with dot' })

      // .git segments
      expect(parseScope(['.git'])).toEqual({ ok: false, reason: 'scope entry must not contain .git segments' })
      expect(parseScope(['.GIT'])).toEqual({ ok: false, reason: 'scope entry must not contain .git segments' })
      expect(parseScope(['.Git'])).toEqual({ ok: false, reason: 'scope entry must not contain .git segments' })
      expect(parseScope(['.giT'])).toEqual({ ok: false, reason: 'scope entry must not contain .git segments' })
      expect(parseScope(['a/.git/b'])).toEqual({ ok: false, reason: 'scope entry must not contain .git segments' })
      expect(parseScope(['a/.GIT/b'])).toEqual({ ok: false, reason: 'scope entry must not contain .git segments' })
    })

    it('accepts segments with embedded dots like a/..b and a/.gitignore', () => {
      expect(parseScope(['a/..b'])).toEqual({ ok: true, scope: ['a/..b'] })
      expect(parseScope(['..b'])).toEqual({ ok: true, scope: ['..b'] })
      expect(parseScope(['..b/c'])).toEqual({ ok: true, scope: ['..b/c'] })
      expect(parseScope(['a/.gitignore', 'a/..b', 'a b/c'])).toEqual({
        ok: true,
        scope: ['a b/c', 'a/..b', 'a/.gitignore'],
      })
    })

    it('handles dot absorption and valid dot entry', () => {
      expect(parseScope(['.'])).toEqual({ ok: true, scope: ['.'] })
      expect(parseScope(['.', '.'])).toEqual({ ok: true, scope: ['.'] })
      expect(parseScope(['a', '.'])).toEqual({ ok: true, scope: ['.'] })
      expect(parseScope(['.', 'a'])).toEqual({ ok: true, scope: ['.'] })
      expect(parseScope(['.', 'invalid/../entry'])).toEqual({ ok: false, reason: 'scope entry must not contain dot-dot segments' })
      expect(parseScope(['.', 'README.md.'])).toEqual({ ok: false, reason: 'scope entry segment must not end with dot' })
      expect(parseScope(['.', 'LONGDI~1'])).toEqual({ ok: false, reason: 'scope entry must not contain ~' })
    })

    it('deduplicates, removes covered subpaths, and sorts in code unit order', () => {
      expect(parseScope(['a', 'a'])).toEqual({ ok: true, scope: ['a'] })
      expect(parseScope(['a', 'a/b'])).toEqual({ ok: true, scope: ['a'] })
      expect(parseScope(['a/b', 'a/b/c'])).toEqual({ ok: true, scope: ['a/b'] })
      expect(parseScope(['a', 'a/b/c'])).toEqual({ ok: true, scope: ['a'] })
      expect(parseScope(['a', 'ab'])).toEqual({ ok: true, scope: ['a', 'ab'] })
      expect(parseScope(['ab', 'a'])).toEqual({ ok: true, scope: ['a', 'ab'] })
      expect(parseScope(['a', 'A/b'])).toEqual({ ok: true, scope: ['A/b', 'a'] })
      expect(parseScope(['b', 'a'])).toEqual({ ok: true, scope: ['a', 'b'] })
      expect(parseScope(['z', 'A'])).toEqual({ ok: true, scope: ['A', 'z'] })
      expect(parseScope(['z', 'a/b/c', 'B', 'a', 'z', 'a/b', 'ab', 'a-b', 'A/b'])).toEqual({
        ok: true,
        scope: ['A/b', 'B', 'a', 'a-b', 'ab', 'z'],
      })
    })
  })

  describe('scopesOverlap', () => {
    it('returns false for empty scopes', () => {
      expect(scopesOverlap([], [])).toBe(false)
      expect(scopesOverlap(['a'], [])).toBe(false)
      expect(scopesOverlap([], ['a'])).toBe(false)
      expect(scopesOverlap(['.'], [])).toBe(false)
      expect(scopesOverlap([], ['.'])).toBe(false)
    })

    it('returns true when either scope contains .', () => {
      expect(scopesOverlap(['.'], ['.'])).toBe(true)
      expect(scopesOverlap(['.'], ['src/a'])).toBe(true)
      expect(scopesOverlap(['src/a'], ['.'])).toBe(true)
    })

    it('detects equal entries case-insensitively for ASCII A-Z boundaries', () => {
      expect(scopesOverlap(['a'], ['a'])).toBe(true)
      expect(scopesOverlap(['A'], ['a'])).toBe(true)
      expect(scopesOverlap(['a'], ['A'])).toBe(true)
      expect(scopesOverlap(['Z'], ['z'])).toBe(true)
      expect(scopesOverlap(['z'], ['Z'])).toBe(true)
      expect(scopesOverlap(['a'], ['b'])).toBe(false)
      expect(scopesOverlap(['@'], ['@'])).toBe(true)
      expect(scopesOverlap(['`'], ['`'])).toBe(true)
    })

    it('detects prefix overlap only at slash boundaries', () => {
      expect(scopesOverlap(['a'], ['a/b'])).toBe(true)
      expect(scopesOverlap(['a/b'], ['a'])).toBe(true)
      expect(scopesOverlap(['A'], ['a/b'])).toBe(true)
      expect(scopesOverlap(['a/b'], ['A'])).toBe(true)
      expect(scopesOverlap(['SRC/A'], ['src/a/b'])).toBe(true)
      expect(scopesOverlap(['src/a/b'], ['SRC/A'])).toBe(true)
      expect(scopesOverlap(['a'], ['ab'])).toBe(false)
      expect(scopesOverlap(['ab'], ['a'])).toBe(false)
      expect(scopesOverlap(['src/a'], ['src/ab'])).toBe(false)
      expect(scopesOverlap(['src/ab'], ['src/a'])).toBe(false)
      expect(scopesOverlap(['src/a'], ['other/a'])).toBe(false)
      expect(scopesOverlap(['other', 'SRC/A'], ['none', 'src/a/x'])).toBe(true)
    })

    it('does not lowercase non-ASCII characters', () => {
      expect(scopesOverlap(['É'], ['é'])).toBe(false)
    })
  })

  describe('pathInScope', () => {
    it('returns true for . scope', () => {
      expect(pathInScope('anything', ['.'])).toBe(true)
      expect(pathInScope('src/a/b.ts', ['.'])).toBe(true)
      expect(pathInScope('', ['.'])).toBe(true)
    })

    it('returns false for empty scope', () => {
      expect(pathInScope('src/a', [])).toBe(false)
    })

    it('matches exact entries and subpaths with slash boundary case-sensitively', () => {
      expect(pathInScope('src/a', ['src/a'])).toBe(true)
      expect(pathInScope('src/a/file', ['src/a'])).toBe(true)
      expect(pathInScope('src/a/b/c', ['src/a'])).toBe(true)

      expect(pathInScope('src/ab', ['src/a'])).toBe(false)
      expect(pathInScope('src/ab/x', ['src/a'])).toBe(false)
      expect(pathInScope('src', ['src/a'])).toBe(false)
      expect(pathInScope('other', ['src/a'])).toBe(false)
      expect(pathInScope('other/file', ['src/a', 'other'])).toBe(true)
      expect(pathInScope('elsewhere', ['src/a', 'other'])).toBe(false)

      expect(pathInScope('SRC/a', ['src/a'])).toBe(false)
      expect(pathInScope('src/A', ['src/a'])).toBe(false)
      expect(pathInScope('SRC/a/file', ['src/a'])).toBe(false)
      expect(pathInScope('src/a/File', ['src/a'])).toBe(true)
    })
  })
})
