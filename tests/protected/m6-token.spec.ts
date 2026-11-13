import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { openStore } from '../../supervisor/src/app/store.ts'
import { killTree, spawnWorker } from '../../supervisor/src/app/process-tree.ts'
import type { Policy } from '../../supervisor/src/sources/github/gate.ts'
import type { GitHubPort, PollResult } from '../../supervisor/src/sources/github/ports.ts'

const clientPath = '../../supervisor/src/sources/github/client.ts'
const ingestPath = '../../supervisor/src/sources/github/ingest.ts'
const secretKeys = ['FACTORY_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_PAT']
function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)])
}
function noSecret(value: unknown, token: string): void {
  const seen = new Set<unknown>()
  function inspect(item: unknown): void {
    if (typeof item === 'string') { expect(item.includes(token)).toBe(false); return }
    if (!item || typeof item !== 'object' || seen.has(item)) return
    seen.add(item)
    for (const key of Object.getOwnPropertyNames(item)) inspect((item as Record<string, unknown>)[key])
  }
  inspect(value)
}

it('CHK-M6-06-c: client failures and persisted poll results never disclose the canary', async () => {
  const token = `canary-${randomUUID()}`, root = mkdtempSync(join(tmpdir(), 'factory-m6-token-'))
  const prior = process.env.FACTORY_GITHUB_TOKEN
  process.env.FACTORY_GITHUB_TOKEN = token
  let status = 500, body = token
  const server = createServer((_req, res) => { res.writeHead(status, status === 302 ? { location: `/echo-${token}` } : {}); res.end(body) })
  let db: DatabaseSync | undefined
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const addr = server.address(); if (!addr || typeof addr === 'string') throw new Error('Missing address')
    const mod = await import(clientPath) as { createGitHubClient(options: { token: string; apiUrl: string }): GitHubPort }
    const ingest = await import(ingestPath) as { createIngestState(): { errors: Map<string, number>; stopped: Set<string> }; ingestPoll(db: DatabaseSync, projectId: string, policy: Policy, repo: string, result: PollResult, nowMs: number, state: { errors: Map<string, number>; stopped: Set<string> }): unknown }
    const c = mod.createGitHubClient({ token, apiUrl: `http://127.0.0.1:${addr.port}` })
    const dbPath = join(root, 'state.sqlite'); db = openStore(dbPath)
    db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run('project', 'project', '2026-01-01')
    const policy: Policy = { version: 1, repos: [{ name: 'owner/name', labels: ['allowed'], scope: ['src'] }], actors: [{ id: 1, login: 'actor' }], command: '/factory', maxPendingPerRepo: 5 }
    for (const code of [500, 401, 302, 200]) {
      status = code; body = token
      let result: PollResult
      try { result = await c.poll({ repo: 'owner/name', etag: null }) } catch (error) { noSecret(error, token); throw error }
      expect(result.kind).toBe('error'); noSecret(result, token)
      ingest.ingestPoll(db, 'project', policy, 'owner/name', result, Date.now(), ingest.createIngestState())
      expect(db.prepare('SELECT COUNT(*) AS count FROM github_cursor').get()?.count).toBe(1)
      expect(existsSync(`${dbPath}-wal`)).toBe(true)
      for (const path of files(root)) expect(readFileSync(path).includes(Buffer.from(token))).toBe(false)
    }
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = async () => { throw new Error(token, { cause: new Error(token) }) }
      try { const result = await c.poll({ repo: 'owner/name', etag: null }); noSecret(result, token); expect(result.kind).toBe('error') }
      catch (error) { noSecret(error, token); throw error }
    } finally { globalThis.fetch = originalFetch }
  } finally {
    db?.close(); server.closeAllConnections(); if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    if (prior === undefined) delete process.env.FACTORY_GITHUB_TOKEN; else process.env.FACTORY_GITHUB_TOKEN = prior
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}, 30000)

function alive(pid: number): boolean { try { process.kill(pid, 0); return true } catch { return false } }
async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) { if (check()) return; await delay(25) }
  throw new Error('Worker did not finish before deadline')
}
function envKeys(log: string, label: string): string[] {
  const lines = log.split(/\r?\n/).filter(line => line.startsWith(`${label} `))
  expect(lines).toHaveLength(1)
  return JSON.parse(lines[0]!.slice(label.length + 1)) as string[]
}

it('CHK-M6-06-d: worker and grandchild exclude secrets for default and supplied environments', async () => {
  const changed = [...secretKeys, 'FAKE_PRINT_ENV', 'FAKE_EXIT_CODE', 'FACTORY_M6_OTHER']
  const previous = new Map(changed.map(key => [key, process.env[key]]))
  const root = mkdtempSync(join(tmpdir(), 'factory-m6-worker-'))
  try {
    for (const key of secretKeys) process.env[key] = `secret-${randomUUID()}`
    process.env.FAKE_PRINT_ENV = '1'; process.env.FAKE_EXIT_CODE = '7'; process.env.FACTORY_M6_OTHER = 'present'
    for (const mode of ['default', 'process', 'explicit', 'child']) {
      const cwd = join(root, `${mode}-cwd`), runDir = join(root, `${mode}-run`); mkdirSync(cwd); mkdirSync(runDir)
      const env = mode === 'default' ? undefined : mode === 'process' ? process.env : { ...process.env, FAKE_PRINT_ENV: mode === 'child' ? 'child' : '1' }
      const spawned = spawnWorker({ cwd, runDir, taskId: `task-${mode}`, attemptId: randomUUID(), ...(env ? { env } : {}) })
      let grandchildPid = 0
      try {
        await waitUntil(() => existsSync(join(runDir, 'result.json')))
        const worker = JSON.parse(readFileSync(join(runDir, 'worker.json'), 'utf8')) as { pid: number; nonce: string; grandchildPid: number }
        expect(worker.pid).toBe(spawned.pid); expect(worker.nonce).toBe(spawned.nonce); grandchildPid = worker.grandchildPid
        expect(JSON.parse(readFileSync(join(runDir, 'result.json'), 'utf8'))).toEqual({ exitCode: 7 })
        const log = readFileSync(join(runDir, 'stdout.log'), 'utf8')
        for (const label of mode === 'child' ? ['ENV_KEYS', 'ENV_KEYS_CHILD'] : ['ENV_KEYS']) {
          const keys = envKeys(log, label)
          expect(keys).toEqual([...keys].sort())
          for (const key of secretKeys) expect(keys.includes(key)).toBe(false)
          expect(keys.includes('FACTORY_M6_OTHER')).toBe(true)
          expect(keys.includes('FAKE_EXIT_CODE')).toBe(true)
        }
        await waitUntil(() => !alive(spawned.pid) && !alive(grandchildPid))
      } finally {
        const workerFile = join(runDir, 'worker.json')
        if (existsSync(workerFile)) {
          const worker = JSON.parse(readFileSync(workerFile, 'utf8')) as { pid: number; nonce: string; grandchildPid?: number }
          if (worker.pid === spawned.pid && worker.nonce === spawned.nonce) grandchildPid = worker.grandchildPid ?? 0
        }
        for (const pid of [spawned.pid, grandchildPid]) if (pid > 0 && alive(pid)) {
          const killed = await killTree(pid, spawned.nonce)
          if (killed.result !== 'killed' && killed.result !== 'not-running') throw new Error(`Worker cleanup failed: ${killed.result}`)
        }
        expect(alive(spawned.pid)).toBe(false)
        if (grandchildPid > 0) expect(alive(grandchildPid)).toBe(false)
      }
    }
  } finally {
    for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}, 90000)
