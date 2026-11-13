import type { GitHubPort, PollResult } from './ports.ts'

const MAX_BODY_BYTES = 5 * 1024 * 1024 // 5 MB
const MIN_WAIT_MS = 60000
const MAX_WAIT_MS = 86400000 // 24 hours
const DIGITS_ONLY = /^\d+$/
const REPO_SEGMENT_REGEX = /^[A-Za-z0-9_.-]+$/

function redact(str: string, token: string): string {
  if (!token || !str) return str
  return str.replaceAll(token, '[redacted]')
}

const MAX_NESTING_DEPTH = 64

class NestingDepthError extends Error {
  constructor() {
    super('Response body exceeds nesting depth limit')
  }
}

function redactDecoded(val: unknown, token: string, depth = 0): unknown {
  if (depth > MAX_NESTING_DEPTH) {
    throw new NestingDepthError()
  }
  if (typeof val === 'string') {
    return redact(val, token)
  }
  if (Array.isArray(val)) {
    for (let i = 0; i < val.length; i++) {
      val[i] = redactDecoded(val[i], token, depth + 1)
    }
    return val
  }
  if (val !== null && typeof val === 'object') {
    const obj = val as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const key of Object.getOwnPropertyNames(obj)) {
      const newKey = redact(key, token)
      Object.defineProperty(result, newKey, {
        value: redactDecoded(obj[key], token, depth + 1),
        writable: true,
        enumerable: true,
        configurable: true,
      })
    }
    return result
  }
  return val
}

function parseRateLimit(res: Response): number {
  const retryAfter = res.headers.get('retry-after')
  if (retryAfter !== null && DIGITS_ONLY.test(retryAfter)) {
    const sec = Number(retryAfter)
    if (Number.isFinite(sec)) {
      const ms = sec * 1000
      if (Number.isFinite(ms)) {
        return Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, ms))
      }
    }
  }
  const resetHeader = res.headers.get('x-ratelimit-reset')
  if (resetHeader !== null && DIGITS_ONLY.test(resetHeader)) {
    const resetSec = Number(resetHeader)
    if (Number.isFinite(resetSec)) {
      const resetMs = resetSec * 1000
      if (Number.isFinite(resetMs)) {
        const diffMs = resetMs - Date.now()
        if (Number.isFinite(diffMs) && diffMs >= MIN_WAIT_MS) {
          return Math.min(MAX_WAIT_MS, diffMs)
        }
      }
    }
  }
  return MIN_WAIT_MS
}

function parsePollInterval(header: string | null): number {
  if (header !== null && DIGITS_ONLY.test(header)) {
    const sec = Number(header)
    if (Number.isFinite(sec)) {
      const ms = sec * 1000
      if (Number.isFinite(ms)) {
        return Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, ms))
      }
    }
  }
  return MIN_WAIT_MS
}

function parseNextLink(linkHeader: string | null, currentUrl: string): string | null {
  if (!linkHeader) return null
  const entries = linkHeader.split(',')
  for (const entry of entries) {
    const parts = entry.split(';')
    if (parts.length < 2) continue
    const urlMatch = parts[0]!.trim().match(/^<([^>]+)>$/)
    if (!urlMatch) continue
    const href = urlMatch[1]!
    let isNext = false
    for (let i = 1; i < parts.length; i++) {
      const relMatch = parts[i]!.trim().match(/^rel=["']?([^"']+)["']?$/i)
      if (relMatch && relMatch[1]!.toLowerCase() === 'next') {
        isNext = true
        break
      }
    }
    if (isNext) {
      try {
        const resolved = new URL(href, currentUrl)
        const current = new URL(currentUrl)
        if (resolved.origin === current.origin) {
          return resolved.toString()
        }
      } catch {
        // invalid URL ignored
      }
    }
  }
  return null
}

async function readBodyWithCap(res: Response, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false; reason: 'oversized' | 'transport' | 'invalid-utf8' }> {
  if (!res.body) {
    return { ok: true, text: '' }
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        totalBytes += value.byteLength
        if (totalBytes > maxBytes) {
          try { await reader.cancel() } catch {}
          return { ok: false, reason: 'oversized' }
        }
        chunks.push(value)
      }
    }
  } catch {
    return { ok: false, reason: 'transport' }
  } finally {
    try { reader.releaseLock() } catch {}
  }
  const concatenated = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    concatenated.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(concatenated)
    return { ok: true, text }
  } catch {
    return { ok: false, reason: 'invalid-utf8' }
  }
}

function isValidRepo(repo: unknown): boolean {
  if (typeof repo !== 'string') return false
  const segments = repo.split('/')
  if (segments.length !== 2) return false
  return segments.every((seg) => REPO_SEGMENT_REGEX.test(seg) && seg !== '.' && seg !== '..')
}

export function createGitHubClient(options: { token: string; apiUrl?: string }): GitHubPort {
  if (!options || typeof options.token !== 'string') {
    throw new Error('createGitHubClient: token is required')
  }
  const token = options.token
  const rawApiUrl = options.apiUrl ?? 'https://api.github.com'

  let parsedUrl: URL
  try {
    parsedUrl = new URL(rawApiUrl)
  } catch {
    throw new Error('createGitHubClient: invalid apiUrl')
  }

  const hostname = parsedUrl.hostname.toLowerCase()
  const protocol = parsedUrl.protocol.toLowerCase()

  if (hostname === 'api.github.com') {
    if (protocol !== 'https:') {
      throw new Error('createGitHubClient: api.github.com requires https')
    }
  } else if (hostname === '127.0.0.1' || hostname === 'localhost') {
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw new Error('createGitHubClient: local hosts require http or https')
    }
  } else {
    throw new Error('createGitHubClient: disallowed host')
  }

  if (parsedUrl.pathname !== '/' && parsedUrl.pathname !== '') {
    throw new Error('createGitHubClient: non-root apiUrl path is disallowed')
  }

  const baseUrl = parsedUrl.origin

  return {
    async poll(input: { repo: string; etag: string | null }): Promise<PollResult> {
      try {
        if (!isValidRepo(input.repo)) {
          return {
            kind: 'error',
            retryable: false,
            message: 'Invalid repository name',
          }
        }
        const initialUrl = `${baseUrl}/repos/${input.repo}/events?per_page=100`

        type StepResult =
          | { kind: 'continue'; events: unknown[]; nextUrl: string | null; etag?: string; pollAfterMs?: number }
          | { kind: 'done'; result: PollResult }

        async function fetchPage(url: string, sendEtag: string | null): Promise<StepResult> {
          const headers: Record<string, string> = {
            'authorization': `Bearer ${token}`,
            'accept': 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            'user-agent': 'factory-supervisor',
          }
          if (sendEtag) {
            headers['if-none-match'] = sendEtag
          }

          const res = await fetch(url, {
            method: 'GET',
            headers,
            redirect: 'manual',
          })

          const remaining = res.headers.get('x-ratelimit-remaining')
          const hasRetryAfter = res.headers.has('retry-after')
          if (remaining === '0' || res.status === 429 || (res.status === 403 && hasRetryAfter)) {
            try { if (res.body) await res.body.cancel() } catch {}
            return { kind: 'done', result: { kind: 'rate-limited', retryAfterMs: parseRateLimit(res) } }
          }

          if (res.status === 304) {
            const etag = res.headers.get('etag') ?? input.etag ?? ''
            const pollAfterMs = parsePollInterval(res.headers.get('x-poll-interval'))
            return { kind: 'done', result: { kind: 'not-modified', etag: redact(etag, token), pollAfterMs } }
          }

          if (res.status >= 300 && res.status < 400) {
            try { if (res.body) await res.body.cancel() } catch {}
            return {
              kind: 'done',
              result: {
                kind: 'error',
                retryable: false,
                message: `GitHub API redirect not followed (status ${res.status})`,
              },
            }
          }

          if (res.status !== 200) {
            try { if (res.body) await res.body.cancel() } catch {}
            return {
              kind: 'done',
              result: {
                kind: 'error',
                retryable: res.status >= 500,
                message: `GitHub API error (status ${res.status})`,
              },
            }
          }

          // 200 OK
          const bodyResult = await readBodyWithCap(res, MAX_BODY_BYTES)
          if (!bodyResult.ok) {
            if (bodyResult.reason === 'transport') {
              return { kind: 'done', result: { kind: 'error', retryable: true, message: 'Network error during GitHub request' } }
            }
            if (bodyResult.reason === 'oversized') {
              return { kind: 'done', result: { kind: 'error', retryable: false, message: 'Response body exceeds 5 MB limit' } }
            }
            if (bodyResult.reason === 'invalid-utf8') {
              return { kind: 'done', result: { kind: 'error', retryable: false, message: 'Response body is not valid UTF-8' } }
            }
            return { kind: 'done', result: { kind: 'error', retryable: false, message: 'Response body is not valid JSON' } }
          }

          const redactedText = redact(bodyResult.text, token)

          let parsed: unknown
          try {
            parsed = JSON.parse(redactedText)
          } catch (err) {
            const message = err instanceof RangeError
              ? 'Response body exceeds nesting depth limit'
              : 'Response body is not valid JSON'
            return { kind: 'done', result: { kind: 'error', retryable: false, message } }
          }

          if (!Array.isArray(parsed)) {
            return { kind: 'done', result: { kind: 'error', retryable: false, message: 'Response body is not a JSON array' } }
          }

          let sanitizedEvents: unknown[]
          try {
            sanitizedEvents = redactDecoded(parsed, token, 0) as unknown[]
          } catch (err) {
            if (err instanceof NestingDepthError) {
              return { kind: 'done', result: { kind: 'error', retryable: false, message: 'Response body exceeds nesting depth limit' } }
            }
            return { kind: 'done', result: { kind: 'error', retryable: false, message: 'Response body is not valid JSON' } }
          }

          const pageEtag = res.headers.get('etag') ?? ''
          const pollAfterMs = parsePollInterval(res.headers.get('x-poll-interval'))
          const nextUrl = parseNextLink(res.headers.get('link'), url)

          return {
            kind: 'continue',
            events: sanitizedEvents,
            nextUrl,
            etag: redact(pageEtag, token),
            pollAfterMs,
          }
        }

        const first = await fetchPage(initialUrl, input.etag)
        if (first.kind === 'done') {
          return first.result
        }

        const allEvents = first.events.slice()
        const firstEtag = first.etag ?? ''
        const firstPollAfterMs = first.pollAfterMs ?? 60000
        let nextUrl = first.nextUrl
        let pagesFollowed = 0

        while (nextUrl && pagesFollowed < 2) {
          pagesFollowed++
          const next = await fetchPage(nextUrl, null)
          if (next.kind === 'done') {
            return next.result
          }
          for (let i = 0; i < next.events.length; i++) {
            allEvents.push(next.events[i])
          }
          nextUrl = next.nextUrl
        }

        return {
          kind: 'events',
          etag: firstEtag,
          pollAfterMs: firstPollAfterMs,
          events: allEvents,
        }
      } catch {
        return {
          kind: 'error',
          retryable: true,
          message: 'Network error during GitHub request',
        }
      }
    },
  }
}
