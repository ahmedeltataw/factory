function toAsciiLower(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code >= 65 && code <= 90) {
      out += String.fromCharCode(code + 32)
    } else {
      out += s.charAt(i)
    }
  }
  return out
}

function isReservedDeviceName(base: string): boolean {
  const low = toAsciiLower(base)
  if (low === 'con' || low === 'prn' || low === 'aux' || low === 'nul') {
    return true
  }
  if (low.length === 4) {
    const prefix = low.slice(0, 3)
    if (prefix === 'com' || prefix === 'lpt') {
      const digit = low.charAt(3)
      if (digit >= '1' && digit <= '9') {
        return true
      }
    }
  }
  return false
}

export function parseScope(input: unknown): { ok: true; scope: string[] } | { ok: false; reason: string } {
  if (!Array.isArray(input)) {
    return { ok: false, reason: 'scope must be an array' }
  }
  if (input.length < 1) {
    return { ok: false, reason: 'scope array must not be empty' }
  }
  if (input.length > 32) {
    return { ok: false, reason: 'scope array must contain at most 32 entries' }
  }

  for (const entry of input) {
    if (typeof entry !== 'string') {
      return { ok: false, reason: 'scope entry must be a string' }
    }
    if (entry.length < 1) {
      return { ok: false, reason: 'scope entry must not be empty' }
    }
    if (entry.length > 200) {
      return { ok: false, reason: 'scope entry must not exceed 200 characters' }
    }
    if (!entry.isWellFormed()) {
      return { ok: false, reason: 'scope entry must be well-formed UTF-16' }
    }
    for (let i = 0; i < entry.length; i++) {
      const code = entry.charCodeAt(i)
      if (code < 0x20 || code === 0x7f) {
        return { ok: false, reason: 'scope entry must not contain control characters' }
      }
      if (code >= 0x80) {
        return { ok: false, reason: 'scope entry must contain printable ASCII only' }
      }
      const ch = entry.charAt(i)
      if (ch === '~') {
        return { ok: false, reason: 'scope entry must not contain ~' }
      }
      if (ch === '\\' || ch === ':' || ch === '*' || ch === '?' || ch === '[' || ch === ']') {
        return { ok: false, reason: 'scope entry must not contain forbidden characters' }
      }
    }
    if (entry.startsWith('/')) {
      return { ok: false, reason: 'scope entry must not start with /' }
    }
    if (entry.endsWith('/')) {
      return { ok: false, reason: 'scope entry must not end with /' }
    }
    if (entry !== '.') {
      const segments = entry.split('/')
      for (const seg of segments) {
        if (seg.length === 0) {
          return { ok: false, reason: 'scope entry must not contain empty segments' }
        }
        if (seg === '.') {
          return { ok: false, reason: 'scope entry must not contain dot segments' }
        }
        if (seg === '..') {
          return { ok: false, reason: 'scope entry must not contain dot-dot segments' }
        }
        if (seg.startsWith(' ')) {
          return { ok: false, reason: 'scope entry segment must not start with space' }
        }
        if (seg.endsWith(' ')) {
          return { ok: false, reason: 'scope entry segment must not end with space' }
        }
        if (seg.endsWith('.')) {
          return { ok: false, reason: 'scope entry segment must not end with dot' }
        }
        const dotIdx = seg.indexOf('.')
        const base = dotIdx === -1 ? seg : seg.slice(0, dotIdx)
        if (isReservedDeviceName(base)) {
          return { ok: false, reason: 'scope entry must not contain Windows reserved device names' }
        }
        if (toAsciiLower(seg) === '.git') {
          return { ok: false, reason: 'scope entry must not contain .git segments' }
        }
      }
    }
  }

  if (input.includes('.')) {
    return { ok: true, scope: ['.'] }
  }

  const unique = Array.from(new Set(input as string[]))
  const filtered = unique.filter((entry) => {
    for (const other of unique) {
      if (other !== entry && entry.startsWith(other + '/')) {
        return false
      }
    }
    return true
  })
  filtered.sort()

  return { ok: true, scope: filtered }
}

export function scopesOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) {
    return false
  }
  for (const ea of a) {
    if (ea === '.') return true
  }
  for (const eb of b) {
    if (eb === '.') return true
  }
  for (const ea of a) {
    const lowA = toAsciiLower(ea)
    for (const eb of b) {
      const lowB = toAsciiLower(eb)
      if (lowA === lowB || lowA.startsWith(lowB + '/') || lowB.startsWith(lowA + '/')) {
        return true
      }
    }
  }
  return false
}

export function pathInScope(path: string, scope: string[]): boolean {
  for (const entry of scope) {
    if (entry === '.' || path === entry || path.startsWith(entry + '/')) {
      return true
    }
  }
  return false
}
