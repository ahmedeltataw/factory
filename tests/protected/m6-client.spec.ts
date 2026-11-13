import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import type { GitHubPort } from '../../supervisor/src/sources/github/ports.ts'

const clientPath = '../../supervisor/src/sources/github/client.ts'
async function client(apiUrl: string): Promise<GitHubPort> {
  const module = await import(clientPath) as { createGitHubClient(options: { token: string; apiUrl?: string }): GitHubPort }
  return module.createGitHubClient({ token: 'test-token', apiUrl })
}
type Reply = { status: number; headers?: Record<string, string>; body?: string }
async function server() {
  const replies: Reply[] = [], requests: { method?: string; url?: string; headers: IncomingHttpHeaders }[] = []
  const instance = createServer((req, res: ServerResponse) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers })
    const reply = replies.shift() ?? { status: 500 }
    res.writeHead(reply.status, reply.headers); res.end(reply.body)
  })
  instance.listen(0, '127.0.0.1'); await once(instance, 'listening')
  const address = instance.address()
  if (!address || typeof address === 'string') throw new Error('Missing server address')
  return { url: `http://127.0.0.1:${address.port}`, replies, requests, close: async () => { instance.closeAllConnections(); await new Promise<void>((resolve, reject) => instance.close(error => error ? reject(error) : resolve())) } }
}
const poll = (port: GitHubPort, etag: string | null = null) => port.poll({ repo: 'owner/name', etag })
const errorResult = (result: Awaited<ReturnType<typeof poll>>, retryable: boolean) => {
  expect(result.kind).toBe('error')
  if (result.kind === 'error') { expect(result.retryable).toBe(retryable); expect(typeof result.message).toBe('string') }
}

it('CHK-M6-06-a: requests, pages, and response mapping', async () => {
  const s = await server(), other = await server()
  try {
    const c = await client(s.url)
    s.replies.push(
      { status: 200, headers: { etag: '"first"', 'x-poll-interval': '120', link: `<${s.url}/page2>; rel="next"` }, body: '[{"id":1}]' },
      { status: 200, headers: { etag: '"second"', link: `<${s.url}/page3>; rel="next"` }, body: '[{"id":2}]' },
      { status: 200, headers: { link: `<${s.url}/page4>; rel="next"` }, body: '[{"id":3}]' },
    )
    expect(await poll(c)).toEqual({ kind: 'events', etag: '"first"', pollAfterMs: 120000, events: [{ id: 1 }, { id: 2 }, { id: 3 }] })
    expect(s.requests.map(r => [r.method, r.url])).toEqual([['GET', '/repos/owner/name/events?per_page=100'], ['GET', '/page2'], ['GET', '/page3']])
    for (const request of s.requests) {
      expect(request.headers.authorization).toBe('Bearer test-token')
      expect(request.headers.accept).toBe('application/vnd.github+json')
      expect(request.headers['x-github-api-version']).toBe('2022-11-28')
      expect(request.headers['user-agent']).toBeTruthy()
      expect(request.headers['if-none-match']).toBeUndefined()
    }
    s.replies.push({ status: 304, headers: { etag: '"old"', 'x-poll-interval': '1' } })
    expect(await poll(c, '"old"')).toEqual({ kind: 'not-modified', etag: '"old"', pollAfterMs: 60000 })
    expect(s.requests.at(-1)?.headers['if-none-match']).toBe('"old"')
    s.replies.push({ status: 200, headers: { etag: '"cross"', 'x-poll-interval': '1', link: `<${other.url}/next>; rel="next"` }, body: '[]' })
    expect(await poll(c)).toEqual({ kind: 'events', etag: '"cross"', pollAfterMs: 60000, events: [] })
    expect(other.requests).toHaveLength(0)
    for (const status of [403, 429]) {
      for (const reset of [undefined, 'nonsense', '1']) {
        s.replies.push({ status, headers: { 'x-ratelimit-remaining': '0', ...(reset ? { 'x-ratelimit-reset': reset } : {}) } })
        expect(await poll(c)).toEqual({ kind: 'rate-limited', retryAfterMs: 60000 })
      }
      s.replies.push({ status, headers: { 'x-ratelimit-remaining': '0', 'retry-after': '120' } })
      expect(await poll(c)).toEqual({ kind: 'rate-limited', retryAfterMs: 120000 })
      const reset = Math.floor(Date.now() / 1000) + 180
      s.replies.push({ status, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } })
      const limited = await poll(c)
      expect(limited.kind).toBe('rate-limited')
      if (limited.kind === 'rate-limited') { expect(limited.retryAfterMs).toBeGreaterThanOrEqual(178000); expect(limited.retryAfterMs).toBeLessThanOrEqual(180000) }
    }
    for (const status of [500, 503, 401, 403, 404]) { s.replies.push({ status }); errorResult(await poll(c), status >= 500) }
    s.replies.push({ status: 200, body: 'not json' }); errorResult(await poll(c), false)
    s.replies.push({ status: 200, body: `[${'0,'.repeat(500000)}0]` })
    const accepted = await poll(c)
    expect(accepted.kind).toBe('events')
    if (accepted.kind === 'events') expect(accepted.events).toHaveLength(500001)
    s.replies.push({ status: 200, body: `[${'0,'.repeat(3000000)}0]` }); errorResult(await poll(c), false)
  } finally { await s.close(); await other.close() }
  const closed = await server(); const c = await client(closed.url); await closed.close(); errorResult(await poll(c), true)
}, 30000)

it('CHK-M6-06-b: rejects unsafe hosts and never follows redirects', async () => {
  const module = await import(clientPath) as { createGitHubClient(options: { token: string; apiUrl?: string }): GitHubPort }
  expect(() => module.createGitHubClient({ token: 'x' })).not.toThrow()
  for (const apiUrl of ['https://example.com', 'http://example.com', 'http://api.github.com']) expect(() => module.createGitHubClient({ token: 'x', apiUrl })).toThrow()
  for (const apiUrl of ['https://api.github.com', 'http://127.0.0.1:1234', 'http://localhost:1234']) expect(() => module.createGitHubClient({ token: 'x', apiUrl })).not.toThrow()
  const source = await server(), target = await server()
  try {
    const c = await client(source.url)
    for (const status of [301, 302]) { source.replies.push({ status, headers: { location: `${target.url}/redirected` } }); expect((await poll(c)).kind).toBe('error') }
    expect(target.requests).toHaveLength(0)
  } finally { await source.close(); await target.close() }
})
