import { createServer, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { createGitHubClient } from '../supervisor/src/sources/github/client.ts'
import { killTree, spawnWorker } from '../supervisor/src/app/process-tree.ts'

type Reply = { status: number; headers?: Record<string, string>; body?: string | Buffer }
async function createTestServer() {
  const replies: Reply[] = []
  const requests: { method?: string; url?: string; headers: Record<string, unknown> }[] = []
  const instance = createServer((req, res: ServerResponse) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers })
    const reply = replies.shift() ?? { status: 500 }
    res.writeHead(reply.status, reply.headers)
    res.end(reply.body)
  })
  instance.listen(0, '127.0.0.1')
  await once(instance, 'listening')
  const address = instance.address()
  if (!address || typeof address === 'string') throw new Error('Missing server address')
  return {
    url: `http://127.0.0.1:${address.port}`,
    replies,
    requests,
    close: async () => {
      instance.closeAllConnections()
      await new Promise<void>((resolve, reject) => instance.close((err) => (err ? reject(err) : resolve())))
    },
  }
}

describe('client.ts additional coverage and mutation defense', () => {
  it('validates constructor options and URL formatting', () => {
    // @ts-expect-error invalid options
    expect(() => createGitHubClient()).toThrow()
    // @ts-expect-error invalid token
    expect(() => createGitHubClient({ token: 123 })).toThrow()
    expect(() => createGitHubClient({ token: 'tok', apiUrl: 'invalid-url' })).toThrow()
    expect(() => createGitHubClient({ token: 'tok', apiUrl: 'ftp://127.0.0.1' })).toThrow()
    expect(() => createGitHubClient({ token: 'tok', apiUrl: 'https://other.com' })).toThrowError(
      'createGitHubClient: disallowed host',
    )
    expect(() => createGitHubClient({ token: 'tok', apiUrl: 'http://127.0.0.1:8080/api/v3/' })).toThrowError(
      'createGitHubClient: non-root apiUrl path is disallowed',
    )
    expect(() => createGitHubClient({ token: 'tok', apiUrl: 'http://127.0.0.1:8080/' })).not.toThrow()
    expect(() => createGitHubClient({ token: 'tok', apiUrl: 'http://127.0.0.1:8080' })).not.toThrow()
  })

  it('validates input.repo before making requests (item 4)', async () => {
    const s = await createTestServer()
    try {
      const c = createGitHubClient({ token: 'tok', apiUrl: s.url })
      const invalidRepos = [
        '.',
        '..',
        'single',
        'owner/..',
        '../repo',
        'owner/.',
        './repo',
        'owner/repo/extra',
        '/owner/repo',
        'owner/repo/',
        'owner//repo',
        'owner/repo?param=1',
        'owner/repo#hash',
        'owner/repo$',
        'owner/repo spaces',
      ]
      for (const repo of invalidRepos) {
        const res = await c.poll({ repo, etag: null })
        expect(res).toEqual({
          kind: 'error',
          retryable: false,
          message: 'Invalid repository name',
        })
      }
      expect(s.requests).toHaveLength(0)

      s.replies.push({ status: 200, body: '[]' })
      const okRes = await c.poll({ repo: 'valid-owner/valid.repo_1', etag: null })
      expect(okRes.kind).toBe('events')
      expect(s.requests).toHaveLength(1)
      expect(s.requests[0]?.url).toBe('/repos/valid-owner/valid.repo_1/events?per_page=100')
    } finally {
      await s.close()
    }
  })

  it('redacts token in response body before JSON.parse (item 2)', async () => {
    const s = await createTestServer()
    try {
      const secret = 'canary-secret-token-xyz'
      const c = createGitHubClient({ token: secret, apiUrl: s.url })
      s.replies.push({
        status: 200,
        headers: { etag: `"${secret}"` },
        body: JSON.stringify([{ id: 1, text: `echo:${secret}` }]),
      })
      const res = await c.poll({ repo: 'owner/repo', etag: null })
      expect(res).toEqual({
        kind: 'events',
        etag: '"[redacted]"',
        pollAfterMs: 60000,
        events: [{ id: 1, text: 'echo:[redacted]' }],
      })
    } finally {
      await s.close()
    }
  })

  it('handles response stream transport failure as retryable error (item 7)', async () => {
    let socketToDestroy: { destroy(): void } | undefined
    const serverInstance = createServer((req, res) => {
      socketToDestroy = req.socket
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('[{"id": 1},')
      setTimeout(() => {
        req.socket.destroy()
      }, 50)
    })
    serverInstance.listen(0, '127.0.0.1')
    await once(serverInstance, 'listening')
    const addr = serverInstance.address()
    if (!addr || typeof addr === 'string') throw new Error('Missing address')
    try {
      const c = createGitHubClient({ token: 'tok', apiUrl: `http://127.0.0.1:${addr.port}` })
      const res = await c.poll({ repo: 'owner/repo', etag: null })
      expect(res).toEqual({
        kind: 'error',
        retryable: true,
        message: 'Network error during GitHub request',
      })
    } finally {
      serverInstance.closeAllConnections()
      if (socketToDestroy) {
        try { socketToDestroy.destroy() } catch {}
      }
      await new Promise<void>((resolve, reject) => serverInstance.close((err) => (err ? reject(err) : resolve())))
    }
  })

  it('handles invalid UTF-8 as non-retryable error (item 7)', async () => {
    const s = await createTestServer()
    try {
      const c = createGitHubClient({ token: 'tok', apiUrl: s.url })
      s.replies.push({
        status: 200,
        body: Buffer.from([0xff, 0xfe, 0xfd]),
      })
      const res = await c.poll({ repo: 'owner/repo', etag: null })
      expect(res).toEqual({
        kind: 'error',
        retryable: false,
        message: 'Response body is not valid UTF-8',
      })
    } finally {
      await s.close()
    }
  })

  it('handles response not array as non-retryable error', async () => {
    const s = await createTestServer()
    try {
      const c = createGitHubClient({ token: 'tok', apiUrl: s.url })
      s.replies.push({ status: 200, body: '{"not":"array"}' })
      const res = await c.poll({ repo: 'owner/repo', etag: null })
      expect(res).toEqual({
        kind: 'error',
        retryable: false,
        message: 'Response body is not a JSON array',
      })
    } finally {
      await s.close()
    }
  })

  it('handles Link header malformed entries gracefully', async () => {
    const s = await createTestServer()
    try {
      const c = createGitHubClient({ token: 'tok', apiUrl: s.url })
      s.replies.push({
        status: 200,
        headers: {
          etag: '"first"',
          link: `invalid-link, <${s.url}/page2>; invalid-rel, <http://other-domain.com/next>; rel="next"`,
        },
        body: '[{"id":1}]',
      })
      const res = await c.poll({ repo: 'owner/repo', etag: null })
      expect(res).toEqual({
        kind: 'events',
        etag: '"first"',
        pollAfterMs: 60000,
        events: [{ id: 1 }],
      })
    } finally {
      await s.close()
    }
  })

  it('handles rate-limit retry-after and reset calculation edge cases (item 6)', async () => {
    const s = await createTestServer()
    try {
      const c = createGitHubClient({ token: 'tok', apiUrl: s.url })
      // retry-after < 60s floors to 60000
      s.replies.push({
        status: 429,
        headers: { 'retry-after': '10' },
      })
      const res1 = await c.poll({ repo: 'owner/repo', etag: null })
      expect(res1).toEqual({ kind: 'rate-limited', retryAfterMs: 60000 })

      // retry-after invalid (non-digits) falls back to 60000
      s.replies.push({
        status: 429,
        headers: { 'retry-after': '9999999999junk' },
      })
      const res2 = await c.poll({ repo: 'owner/repo', etag: null })
      expect(res2).toEqual({ kind: 'rate-limited', retryAfterMs: 60000 })

      // x-ratelimit-reset invalid (non-digits) falls back to 60000
      s.replies.push({
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '9999999999junk' },
      })
      const res3 = await c.poll({ repo: 'owner/repo', etag: null })
      expect(res3).toEqual({ kind: 'rate-limited', retryAfterMs: 60000 })

      // retry-after large value capped at 24 hours (86400000 ms)
      s.replies.push({
        status: 429,
        headers: { 'retry-after': '999999999' },
      })
      const res4 = await c.poll({ repo: 'owner/repo', etag: null })
      expect(res4).toEqual({ kind: 'rate-limited', retryAfterMs: 86400000 })

      // x-poll-interval invalid falls back to 60000
      s.replies.push({
        status: 200,
        headers: { 'x-poll-interval': '9999999999junk' },
        body: '[]',
      })
      const res5 = await c.poll({ repo: 'owner/repo', etag: null })
      expect(res5).toEqual({ kind: 'events', etag: '', pollAfterMs: 60000, events: [] })

      // x-poll-interval large value capped at 86400000 ms
      s.replies.push({
        status: 200,
        headers: { 'x-poll-interval': '999999999' },
        body: '[]',
      })
      const res6 = await c.poll({ repo: 'owner/repo', etag: null })
      expect(res6).toEqual({ kind: 'events', etag: '', pollAfterMs: 86400000, events: [] })
    } finally {
      await s.close()
    }
  })

  it('handles error in subsequent pagination gracefully', async () => {
    const s = await createTestServer()
    try {
      const c = createGitHubClient({ token: 'tok', apiUrl: s.url })
      s.replies.push(
        { status: 200, headers: { link: `<${s.url}/page2>; rel="next"` }, body: '[{"id":1}]' },
        { status: 500 },
      )
      const res = await c.poll({ repo: 'owner/repo', etag: null })
      expect(res.kind).toBe('error')
      if (res.kind === 'error') {
        expect(res.retryable).toBe(true)
      }
    } finally {
      await s.close()
    }
  })

  it('redacts token in decoded strings and object keys post-parse including escaped forms', async () => {
    const s = await createTestServer()
    try {
      const secret = 'canary-secret'
      const c = createGitHubClient({ token: secret, apiUrl: s.url })
      // Raw JSON body where token is represented with \u0063 ('c') so pre-parse regex doesn't match
      const body = '[{"id": 1, "\\u0063anary-secret_key": "\\u0063anary-secret_val", "nested": {"arr": ["\\u0063anary-secret_str"]}}]'
      s.replies.push({
        status: 200,
        headers: { etag: '"safe-etag"' },
        body,
      })
      const res = await c.poll({ repo: 'owner/repo', etag: null })
      expect(res).toEqual({
        kind: 'events',
        etag: '"safe-etag"',
        pollAfterMs: 60000,
        events: [
          {
            id: 1,
            '[redacted]_key': '[redacted]_val',
            nested: {
              arr: ['[redacted]_str'],
            },
          },
        ],
      })
    } finally {
      await s.close()
    }
  })

  it('maps x-ratelimit-remaining = 0 on 200 and 304 responses to rate-limited, but 304 without it stays not-modified', async () => {
    const s = await createTestServer()
    try {
      const c = createGitHubClient({ token: 'tok', apiUrl: s.url })
      // 200 with remaining 0
      s.replies.push({
        status: 200,
        headers: { 'x-ratelimit-remaining': '0', 'retry-after': '90' },
        body: '[{"id": 1}]',
      })
      const res200 = await c.poll({ repo: 'owner/repo', etag: null })
      expect(res200).toEqual({ kind: 'rate-limited', retryAfterMs: 90000 })

      // 304 with remaining 0 returns rate-limited
      s.replies.push({
        status: 304,
        headers: { etag: '"etag-304"', 'x-ratelimit-remaining': '0', 'retry-after': '90', 'x-poll-interval': '60' },
      })
      const res304Limited = await c.poll({ repo: 'owner/repo', etag: '"etag-304"' })
      expect(res304Limited).toEqual({ kind: 'rate-limited', retryAfterMs: 90000 })

      // 304 without remaining 0 stays not-modified
      s.replies.push({
        status: 304,
        headers: { etag: '"etag-304"', 'x-poll-interval': '60' },
      })
      const res304Ok = await c.poll({ repo: 'owner/repo', etag: '"etag-304"' })
      expect(res304Ok).toEqual({ kind: 'not-modified', etag: '"etag-304"', pollAfterMs: 60000 })
    } finally {
      await s.close()
    }
  })

  it('does not invoke __proto__ setter and keeps __proto__ as own data property without prototype pollution', async () => {
    const s = await createTestServer()
    try {
      const c = createGitHubClient({ token: 'tok', apiUrl: s.url })
      s.replies.push({
        status: 200,
        headers: { etag: '"safe-etag"' },
        body: '[{"id": 1, "__proto__": {"polluted": true, "type": "IssuesEvent"}}]',
      })
      const res = await c.poll({ repo: 'owner/repo', etag: null })
      expect(res.kind).toBe('events')
      if (res.kind === 'events') {
        expect(res.events).toHaveLength(1)
        const event = res.events[0] as Record<string, unknown>
        expect(event.id).toBe(1)
        expect(Object.getPrototypeOf(event)).toBe(Object.prototype)
        expect(Object.hasOwn(event, '__proto__')).toBe(true)
        expect((event as unknown as { polluted?: unknown }).polluted).toBeUndefined()
        expect((event as unknown as { type?: unknown }).type).toBeUndefined()
        expect((Object.prototype as unknown as { polluted?: unknown }).polluted).toBeUndefined()
      }
    } finally {
      delete (Object.prototype as unknown as { polluted?: unknown }).polluted
      await s.close()
    }
  })

  it('returns non-retryable error when response body exceeds nesting depth limit', async () => {
    const s = await createTestServer()
    try {
      const c = createGitHubClient({ token: 'tok', apiUrl: s.url })

      // 100 000 levels of nested brackets (within 5 MB: ~200 KB)
      const deep100k = '['.repeat(100000) + ']'.repeat(100000)
      s.replies.push({ status: 200, body: deep100k })
      const res100k = await c.poll({ repo: 'owner/repo', etag: null })
      expect(res100k.kind).toBe('error')
      if (res100k.kind === 'error') {
        expect(res100k.retryable).toBe(false)
        expect(typeof res100k.message).toBe('string')
        expect(res100k.message).toBe('Response body exceeds nesting depth limit')
      }

      // Valid nested JSON parsed by JSON.parse (> 64 depth limit, e.g. 100 levels)
      let deep = '{"id": 1}'
      for (let i = 0; i < 100; i++) {
        deep = `{"nested": ${deep}}`
      }
      s.replies.push({ status: 200, body: `[${deep}]` })
      const resDeep = await c.poll({ repo: 'owner/repo', etag: null })
      expect(resDeep.kind).toBe('error')
      if (resDeep.kind === 'error') {
        expect(resDeep.retryable).toBe(false)
        expect(resDeep.message).toBe('Response body exceeds nesting depth limit')
      }
    } finally {
      await s.close()
    }
  })

  it('removes token environment variables case-insensitively without mutating caller env (item 1)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'm6-06-env-test-'))
    const cwd = join(root, 'cwd'), runDir = join(root, 'run')
    mkdirSync(cwd); mkdirSync(runDir)
    const controlledKeys: Record<string, string> = {
      github_token: 'secret1',
      Github_Token: 'secret2',
      FACTORY_GITHUB_TOKEN: 'secret3',
      factory_github_token: 'secret4',
      GH_TOKEN: 'secret5',
      gh_token: 'secret6',
      GITHUB_PAT: 'secret7',
      github_pat: 'secret8',
      OTHER_VAR: 'preserved',
      FAKE_PRINT_ENV: '1',
      FAKE_EXIT_CODE: '0',
    }
    const callerEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...controlledKeys,
    }
    const spawned = spawnWorker({ cwd, runDir, taskId: 'env-test', attemptId: randomUUID(), env: callerEnv })
    try {
      for (const [key, value] of Object.entries(controlledKeys)) {
        expect(callerEnv[key]).toBe(value)
      }
      const deadline = Date.now() + 10000
      const stdoutFile = join(runDir, 'stdout.log')
      while (Date.now() < deadline) {
        if (existsSync(stdoutFile) && readFileSync(stdoutFile, 'utf8').includes('ENV_KEYS ')) break
        await delay(50)
      }
      const log = readFileSync(stdoutFile, 'utf8')
      const lines = log.split(/\r?\n/).filter((line) => line.startsWith('ENV_KEYS '))
      expect(lines).toHaveLength(1)
      const keys = JSON.parse(lines[0]!.slice('ENV_KEYS '.length)) as string[]
      for (const k of keys) {
        const u = k.toUpperCase()
        expect(['FACTORY_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_PAT']).not.toContain(u)
      }
      expect(keys).toContain('OTHER_VAR')
    } finally {
      await killTree(spawned.pid, spawned.nonce)
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })
})
