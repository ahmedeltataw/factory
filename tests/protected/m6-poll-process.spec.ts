import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { openStore } from '../../supervisor/src/app/store.ts'
import { parsePolicy } from '../../supervisor/src/sources/github/gate.ts'

const ARABIC_REGEX = /[\u0600-\u06ff]/
const cliPath = join(process.cwd(), 'supervisor/src/cli/main.ts')

interface TrackedSupervisorChild {
  readonly child: ChildProcess
  readonly marker: string
  readonly pid: number
  getStdout(): string
  getStderr(): string
}

interface FakeServerInstance {
  server: Server
  url: string
  close: () => Promise<void>
}

interface CliResult {
  status: number | null
  stdout: string
  stderr: string
}

const tempDirs: string[] = []
const spawnedSupervisorChildren: TrackedSupervisorChild[] = []
const activeServers: FakeServerInstance[] = []
const activeNonces = new Set<string>()

function getTempDir(prefix = 'm6-poll-proc-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function safeRemoveDir(dir: string): void {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      return
    } catch (err) {
      if (attempt === 10) throw err
      const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
      Atomics.wait(waitBuffer, 0, 0, 50)
    }
  }
}

function createGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  spawnSync('git', ['init', dir], { stdio: 'ignore', timeout: 15000 })
  spawnSync('git', ['-C', dir, '-c', 'user.name=Factory Test', '-c', 'user.email=factory@example.test', 'config', 'core.autocrlf', 'false'], { stdio: 'ignore' })
  writeFileSync(join(dir, 'README.md'), '# test\n', 'utf8')
  spawnSync('git', ['-C', dir, '-c', 'user.name=Factory Test', '-c', 'user.email=factory@example.test', 'add', '.'], { stdio: 'ignore' })
  spawnSync('git', ['-C', dir, '-c', 'user.name=Factory Test', '-c', 'user.email=factory@example.test', 'commit', '-m', 'initial commit'], { stdio: 'ignore' })
}

function cleanTestEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  for (const key of [
    'FACTORY_FAULT',
    'FACTORY_GITHUB_TOKEN',
    'FACTORY_GITHUB_API_URL',
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'GITHUB_PAT',
    'NODE_OPTIONS',
  ]) {
    delete env[key]
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  return env
}

function powershell(script: string): string {
  const run = () => spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; " + script],
    { encoding: 'utf8', timeout: 30000, windowsHide: true },
  )
  let result = run()
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') result = run()
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr?.trim() || 'PowerShell failed')
  }
  return result.stdout.trim()
}

function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return true
    return false
  }
}

function getCommandLineForPid(pid: number, retries = 3): { status: 'found'; command: string } | { status: 'not-found' } | { status: 'error'; error: Error } {
  if (!pid || pid <= 0 || !isProcessAlive(pid)) return { status: 'not-found' }

  let lastError: Error | undefined
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      if (process.platform === 'win32') {
        const script = `$records = @(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -Property ProcessId,CommandLine | ForEach-Object {
          $command = if ($null -eq $_.CommandLine) { '' } else { [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($_.CommandLine)) }
          @{ ProcessId = $_.ProcessId; CommandLine = $command }
        }); ConvertTo-Json -InputObject $records -Compress`
        const json = powershell(script)
        if (!json || json.trim() === '' || json.trim() === '[]') {
          if (!isProcessAlive(pid)) return { status: 'not-found' }
        } else {
          const parsed = JSON.parse(json) as Array<{ ProcessId: number; CommandLine: string }> | { ProcessId: number; CommandLine: string }
          const list = Array.isArray(parsed) ? parsed : [parsed]
          const rec = list.find((r) => r && r.ProcessId === pid)
          if (rec && typeof rec.CommandLine === 'string' && rec.CommandLine.length > 0) {
            const bytes = Buffer.from(rec.CommandLine, 'base64')
            return { status: 'found', command: bytes.toString('utf16le') }
          }
          if (!isProcessAlive(pid)) return { status: 'not-found' }
        }
      } else {
        let cmd = ''
        try {
          const res = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
            encoding: 'utf8',
            timeout: 10000,
          })
          if (res.status === 0 && res.stdout) {
            cmd = res.stdout.trim()
          }
        } catch {}

        if (!cmd) {
          try {
            cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
          } catch (e) {
            if (!isProcessAlive(pid)) return { status: 'not-found' }
            throw e
          }
        }

        try {
          const env = readFileSync(`/proc/${pid}/environ`, 'utf8')
          if (env) {
            cmd += '\0' + env
          }
        } catch {}

        if (cmd.length > 0) {
          return { status: 'found', command: cmd }
        }
        if (!isProcessAlive(pid)) return { status: 'not-found' }
        throw new Error(`Process query returned empty command line for living PID ${pid}`)
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (!isProcessAlive(pid)) return { status: 'not-found' }
      if (attempt < retries) {
        const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
        Atomics.wait(waitBuffer, 0, 0, 50 * attempt)
      }
    }
  }

  if (!isProcessAlive(pid)) return { status: 'not-found' }
  return { status: 'error', error: lastError ?? new Error(`Failed to resolve command line for PID ${pid}`) }
}

function checkProcessIdentity(pid: number, markerOrNonce: string): { alive: boolean; matches: boolean } {
  if (!isProcessAlive(pid)) return { alive: false, matches: false }
  const res = getCommandLineForPid(pid)
  if (res.status === 'not-found') return { alive: false, matches: false }
  if (res.status === 'error') {
    throw new Error(`Unresolved identity check for PID ${pid}: ${res.error.message}`)
  }
  return { alive: true, matches: res.command.includes(markerOrNonce) }
}

function isProcessAliveWithNonce(pid: number, markerOrNonce: string): boolean {
  const check = checkProcessIdentity(pid, markerOrNonce)
  return check.alive && check.matches
}

async function waitForProcessDeath(
  pid: number,
  timeoutMs = 15000,
  markerOrNonce?: string,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    if (markerOrNonce) {
      const check = checkProcessIdentity(pid, markerOrNonce)
      if (!check.alive || !check.matches) return true
    }
    await delay(50)
  }
  if (!isProcessAlive(pid)) return true
  if (markerOrNonce) {
    const check = checkProcessIdentity(pid, markerOrNonce)
    return !check.alive || !check.matches
  }
  return false
}

async function killSupervisorSafely(item: TrackedSupervisorChild, timeoutMs = 15000): Promise<void> {
  const { child, marker, pid } = item
  if (!pid) return

  const handleRunning = child.exitCode === null && child.signalCode === null
  if (handleRunning) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
        timeout: 10000,
        stdio: 'ignore',
        windowsHide: true,
      })
    } else {
      try { child.kill('SIGKILL') } catch {}
    }

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if ((child.exitCode !== null || child.signalCode !== null) && !isProcessAlive(pid)) {
        break
      }
      await delay(50)
    }

    if (child.exitCode === null && child.signalCode === null) {
      throw new Error(`Supervisor process PID ${pid} (marker ${marker}) failed to terminate within ${timeoutMs}ms`)
    }
  }

  if (isProcessAlive(pid)) {
    throw new Error(`Supervisor process PID ${pid} (marker ${marker}) child handle exited or not provably ours, but process is still alive`)
  }
}

function processesWithNonces(nonces: string[]): Array<{ pid: number; nonce: string }> {
  if (!nonces.length) return []
  if (process.platform === 'win32') {
    const run = () => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; $p=@(Get-CimInstance Win32_Process -Property ProcessId,CommandLine | Where-Object { $_.CommandLine } | ForEach-Object { @{ ProcessId = $_.ProcessId; CommandLine = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($_.CommandLine)) } }); ConvertTo-Json -InputObject $p -Compress"],
    { encoding: 'utf8', timeout: 30000, windowsHide: true })
    let query = run()
    if ((query.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') query = run()
    if (query.error || query.status !== 0) throw new Error(query.error?.message || query.stderr)
    const rows = JSON.parse(query.stdout) as Array<{ ProcessId: number; CommandLine: string }>
    return rows.flatMap((row) => {
      if (typeof row.CommandLine !== 'string') return []
      const bytes = Buffer.from(row.CommandLine, 'base64')
      const command = bytes.toString('utf16le')
      return nonces.filter((nonce) => command.includes(nonce)).map((nonce) => ({ pid: row.ProcessId, nonce }))
    })
  }
  const query = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 10000 })
  if (query.error || query.status !== 0) throw new Error(query.error?.message || query.stderr)
  return query.stdout.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/)
    return match ? nonces.filter((nonce) => match[2]!.includes(nonce)).map((nonce) => ({ pid: Number(match[1]), nonce })) : []
  })
}

function findPidsByNonces(nonces: string[]): number[] {
  const validNonces = nonces.filter((n) => typeof n === 'string' && n.trim().length > 0)
  if (validNonces.length === 0) return []
  return Array.from(
    new Set(
      processesWithNonces(validNonces)
        .map((p) => p.pid)
        .filter((pid) => pid !== process.pid),
    ),
  )
}

async function cleanupNonces(nonces: Iterable<string>, timeoutMs = 25000): Promise<void> {
  const nonceList = Array.from(new Set(Array.from(nonces).filter((n) => typeof n === 'string' && n.length > 0)))
  if (nonceList.length === 0) return

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const survivors = findPidsByNonces(nonceList)
    if (survivors.length === 0) break
    for (const pid of survivors) {
      if (pid === process.pid) continue
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { timeout: 10000, stdio: 'ignore', windowsHide: true })
      } else {
        try { process.kill(pid, 'SIGKILL') } catch {}
      }
    }
    await delay(150)
  }

  const remaining = findPidsByNonces(nonceList)
  if (remaining.length > 0) {
    throw new Error(
      `Cleanup failed to terminate matching processes for nonces [${nonceList.join(', ')}]. Survivors: ${remaining.join(', ')}`,
    )
  }
  for (const n of nonceList) activeNonces.delete(n)
}

function harvestRunDirectories(stateDirOrRoot: string): void {
  const candidateDirs = [join(stateDirOrRoot, 'runs'), join(stateDirOrRoot, 'state', 'runs')]
  for (const runsDir of candidateDirs) {
    if (!existsSync(runsDir)) continue
    for (const entry of readdirSync(runsDir)) {
      const workerJsonPath = join(runsDir, entry, 'worker.json')
      if (existsSync(workerJsonPath)) {
        const raw = readFileSync(workerJsonPath, 'utf8')
        const data = JSON.parse(raw) as { nonce?: string }
        if (data && typeof data.nonce === 'string' && data.nonce.length > 0) {
          activeNonces.add(data.nonce)
        } else {
          throw new Error(`Worker metadata at "${workerJsonPath}" lacks valid nonce`)
        }
      }
    }
  }
}

function harvestDbWorkers(dbPath: string): void {
  if (!existsSync(dbPath)) return
  const db = openStore(dbPath)
  try {
    const rows = db.prepare('SELECT nonce FROM workers').all() as Array<{ nonce: string }>
    for (const row of rows) {
      if (row && typeof row.nonce === 'string' && row.nonce.length > 0) {
        activeNonces.add(row.nonce)
      }
    }
  } finally {
    db.close()
  }
}

function runCliAsync(
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number },
): Promise<CliResult> {
  const marker = `factory-cli-${randomUUID()}`
  const cwd = options?.cwd ?? getTempDir()
  const timeoutMs = options?.timeoutMs ?? 25000
  const env = options?.env ?? cleanTestEnv()

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [`--title=${marker}`, cliPath, ...args],
      {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          FACTORY_SUPERVISOR_MARKER: marker,
          ...env,
        },
      },
    )

    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })

    const tracked: TrackedSupervisorChild = {
      child,
      marker,
      pid: child.pid!,
      getStdout: () => stdout,
      getStderr: () => stderr,
    }
    if (child.pid) spawnedSupervisorChildren.push(tracked)

    let timer: NodeJS.Timeout | undefined
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killSupervisorSafely(tracked).catch(() => {})
        reject(new Error(`CLI timed out after ${timeoutMs}ms: factory ${args.join(' ')}\nStderr: ${stderr}`))
      }, timeoutMs)
    }

    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ status: code, stdout, stderr })
    })

    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(err)
    })
  })
}

function spawnCli(
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; cwd?: string },
): TrackedSupervisorChild {
  const marker = `factory-supervisor-${randomUUID()}`
  const cwd = options?.cwd ?? getTempDir()
  const env = options?.env ?? cleanTestEnv()
  const child = spawn(
    process.execPath,
    [`--title=${marker}`, cliPath, ...args],
    {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        FACTORY_SUPERVISOR_MARKER: marker,
        ...env,
      },
    },
  )

  let stdoutBuffer = ''
  let stderrBuffer = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuffer += chunk.toString('utf8')
  })

  const tracked: TrackedSupervisorChild = {
    child,
    marker,
    pid: child.pid!,
    getStdout: () => stdoutBuffer,
    getStderr: () => stderrBuffer,
  }

  if (child.pid) {
    spawnedSupervisorChildren.push(tracked)
  }
  return tracked
}

function createFakeServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<FakeServerInstance> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      const instance: FakeServerInstance = {
        server,
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((res) => {
          server.closeAllConnections?.()
          server.close(() => res())
        }),
      }
      activeServers.push(instance)
      resolve(instance)
    })
    server.on('error', reject)
  })
}

function writePolicy(path: string, policy: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify(policy, null, 2), 'utf8')
}

function defaultPolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    repos: [
      { name: 'owner/repo', labels: ['factory'], scope: ['.'] },
    ],
    actors: [
      { id: 1, login: 'alice' },
    ],
    command: '/factory task',
    maxPendingPerRepo: 10,
    ...overrides,
  }
}

function makeIssueCommentEvent(
  id: string,
  repo: string,
  actorId: number,
  actorLogin: string,
  commentBody: string,
  labels: string[] = ['factory'],
): Record<string, unknown> {
  return {
    id,
    type: 'IssueCommentEvent',
    actor: { id: actorId, login: actorLogin, type: 'User' },
    repo: { name: repo },
    payload: {
      action: 'created',
      issue: {
        number: 42,
        title: 'Issue title',
        body: 'Issue body',
        labels: labels.map((name) => ({ name })),
      },
      comment: {
        body: commentBody,
      },
    },
    created_at: '2026-11-13T00:00:00.000Z',
  }
}

function findCanaryInDir(dir: string, canary: string, timeoutMs = 5000): string[] {
  const matches: string[] = []
  const canaryBuf = Buffer.from(canary, 'utf8')
  function walk(current: string) {
    if (!existsSync(current)) return
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile()) {
        const deadline = Date.now() + timeoutMs
        let content: Buffer | undefined
        while (Date.now() < deadline) {
          try {
            content = readFileSync(full)
            break
          } catch {
            const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
            Atomics.wait(waitBuffer, 0, 0, 50)
          }
        }
        if (!content) {
          throw new Error(`Failed to read file during canary scan within ${timeoutMs}ms: ${full}`)
        }
        if (content.includes(canaryBuf)) {
          matches.push(full)
        }
      }
    }
  }
  walk(dir)
  return matches
}

afterEach(async () => {
  const errors: string[] = []

  // 1. Close active fake HTTP servers
  for (const s of activeServers.splice(0)) {
    try {
      await s.close()
    } catch (err: unknown) {
      errors.push(`Server close error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 2. Safely kill and await all tracked supervisor children
  for (const s of spawnedSupervisorChildren.splice(0)) {
    try {
      await killSupervisorSafely(s, 10000)
    } catch (err: unknown) {
      errors.push(`Supervisor cleanup error (PID ${s.pid}): ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 3. Harvest worker nonces and terminate workers/grandchildren, checking for leaks
  for (const dir of tempDirs) {
    try {
      harvestRunDirectories(dir)
    } catch (err: unknown) {
      errors.push(`Harvest run directories error (${dir}): ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      const dbPath = join(dir, 'state.sqlite')
      harvestDbWorkers(dbPath)
    } catch (err: unknown) {
      errors.push(`Harvest db workers error (${dir}): ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      const nestedState = join(dir, 'state', 'state.sqlite')
      harvestDbWorkers(nestedState)
    } catch (err: unknown) {
      errors.push(`Harvest nested db workers error (${dir}): ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  try {
    await cleanupNonces(activeNonces, 25000)
  } catch (err: unknown) {
    errors.push(`Worker cleanup error: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 4. Safely remove temp directories and surface failures, retaining directories when cleanup remains unresolved
  const dirsToDelete = tempDirs.splice(0)
  if (errors.length === 0) {
    for (const dir of dirsToDelete) {
      try {
        safeRemoveDir(dir)
      } catch (err: unknown) {
        errors.push(`Temp dir cleanup error (${dir}): ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  } else {
    errors.push(`Retaining ${dirsToDelete.length} temporary directory(ies) due to unresolved cleanup failures: ${dirsToDelete.join(', ')}`)
  }

  if (errors.length > 0) {
    throw new Error(`Cleanup failed:\n${errors.join('\n')}`)
  }
})

describe('M6-05 real Supervisor processes with local fake GitHub server', () => {
  it('CHK-M6-05-b: startup exit 1 with Arabic message naming FACTORY_GITHUB_TOKEN and not the value when a policy exists and token is unset or empty', async () => {
    const root = getTempDir()
    const repoDir = join(root, 'repo')
    const stateDir = join(root, 'state')
    createGitRepo(repoDir)
    const initRes = await runCliAsync(['init', '--state-dir', stateDir, '--repo', repoDir])
    expect(initRes.status).toBe(0)

    const policyPath = join(stateDir, 'github-policy.json')
    writePolicy(policyPath, defaultPolicy())

    // 1. Token unset
    const resUnset = await runCliAsync(['start', '--state-dir', stateDir], {
      env: cleanTestEnv(),
    })
    expect(resUnset.status).toBe(1)
    expect(ARABIC_REGEX.test(resUnset.stderr)).toBe(true)
    expect(resUnset.stderr).toContain('FACTORY_GITHUB_TOKEN')

    // 2. Token empty string
    const resEmpty = await runCliAsync(['start', '--state-dir', stateDir], {
      env: cleanTestEnv({ FACTORY_GITHUB_TOKEN: '' }),
    })
    expect(resEmpty.status).toBe(1)
    expect(ARABIC_REGEX.test(resEmpty.stderr)).toBe(true)
    expect(resEmpty.stderr).toContain('FACTORY_GITHUB_TOKEN')
  })

  it('CHK-M6-05-b: invalid policy exit 1 with Arabic message and zod issue path; refused URL exit 1; paused policy error written to github_cursor', async () => {
    const root = getTempDir()
    const repoDir = join(root, 'repo')
    const stateDir = join(root, 'state')
    createGitRepo(repoDir)
    await runCliAsync(['init', '--state-dir', stateDir, '--repo', repoDir])

    const policyPath = join(stateDir, 'github-policy.json')
    const testEnv = cleanTestEnv({ FACTORY_GITHUB_TOKEN: 'valid-test-token' })

    const invalidScopes = [
      ['../escape'], // ..
      ['/absolute/path'], // absolute path
      [''], // empty segment
      ['foo/\u0646\u0637\u0627\u0642/bar'], // non-ASCII segment
    ]

    for (const scope of invalidScopes) {
      const p = defaultPolicy({
        repos: [{ name: 'owner/repo', labels: ['factory'], scope }],
      })
      const parsed = parsePolicy(p)
      expect(parsed.ok).toBe(false)
      const expectedReason = (parsed as { ok: false; reason: string }).reason

      writePolicy(policyPath, p)
      const res = await runCliAsync(['start', '--state-dir', stateDir], { env: testEnv })
      expect(res.status).toBe(1)
      expect(ARABIC_REGEX.test(res.stderr)).toBe(true)
      expect(res.stderr).toContain(expectedReason)
    }

    // Invalid actors (missing / empty)
    const pActors = defaultPolicy({ actors: [] })
    const parsedActors = parsePolicy(pActors)
    expect(parsedActors.ok).toBe(false)
    const expectedActorsReason = (parsedActors as { ok: false; reason: string }).reason

    writePolicy(policyPath, pActors)
    const resActors = await runCliAsync(['start', '--state-dir', stateDir], { env: testEnv })
    expect(resActors.status).toBe(1)
    expect(ARABIC_REGEX.test(resActors.stderr)).toBe(true)
    expect(resActors.stderr).toContain(expectedActorsReason)

    // Base URL guard: restore a valid policy first so policy validation passes, then verify refused URL exits 1 with stable refusal diagnostic without prescribing wording
    writePolicy(policyPath, defaultPolicy())
    const refusedEnv = cleanTestEnv({
      FACTORY_GITHUB_TOKEN: 'valid-test-token',
      FACTORY_GITHUB_API_URL: 'http://example.com',
    })
    const resRefused = await runCliAsync(['start', '--state-dir', stateDir], { env: refusedEnv })
    expect(resRefused.status).toBe(1)
    expect(resRefused.stderr.trim().length).toBeGreaterThan(0)
    const resRefused2 = await runCliAsync(['start', '--state-dir', stateDir], { env: refusedEnv })
    expect(resRefused2.status).toBe(1)
    expect(resRefused2.stderr).toBe(resRefused.stderr)

    // Paused policy error written to github_cursor: run Supervisor with valid policy so repo gets a cursor row, then make policy missing and wait until github_cursor.error equals 'policy: missing'
    writePolicy(policyPath, defaultPolicy())
    const serverInstance = await createFakeServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/vnd.github+json',
        'ETag': 'etag-init',
        'x-poll-interval': '60',
      })
      res.end('[]')
    })

    const supEnv = cleanTestEnv({
      FACTORY_GITHUB_API_URL: serverInstance.url,
      FACTORY_GITHUB_TOKEN: 'valid-test-token',
    })

    const supChild = spawnCli(
      ['start', '--state-dir', stateDir, '--heartbeat-ms', '50'],
      { env: supEnv },
    )

    const dbPath = join(stateDir, 'state.sqlite')
    const deadlineInit = Date.now() + 10000
    let cursorCreated = false
    while (Date.now() < deadlineInit) {
      try {
        const roDb = new DatabaseSync(dbPath, { readOnly: true, timeout: 1000 })
        try {
          const row = roDb.prepare('SELECT repo, error FROM github_cursor WHERE repo = ?').get('owner/repo') as { repo: string; error: string | null } | undefined
          if (row) {
            cursorCreated = true
            break
          }
        } finally {
          roDb.close()
        }
      } catch {
        // Retry on transient lock
      }
      await delay(50)
    }
    expect(cursorCreated).toBe(true)

    rmSync(policyPath, { force: true })

    const deadlineError = Date.now() + 10000
    let observedError: string | null = null
    while (Date.now() < deadlineError) {
      try {
        const roDb = new DatabaseSync(dbPath, { readOnly: true, timeout: 1000 })
        try {
          const row = roDb.prepare('SELECT error FROM github_cursor WHERE repo = ?').get('owner/repo') as { error: string | null } | undefined
          if (row?.error === 'policy: missing' || (row?.error && row.error.startsWith('policy: '))) {
            observedError = row.error
            break
          }
        } finally {
          roDb.close()
        }
      } catch {
        // Retry on transient lock
      }
      await delay(50)
    }
    expect(observedError).toBe('policy: missing')

    await killSupervisorSafely(supChild)
  })

  it('CHK-M6-05-d: hard kill between a poll result and its commit leaves no partial rows, after --takeover the same events are fetched again with the OLD stored ETag and give one row each', async () => {
    const root = getTempDir()
    const repoDir = join(root, 'repo')
    const stateDir = join(root, 'state')
    createGitRepo(repoDir)
    await runCliAsync(['init', '--state-dir', stateDir, '--repo', repoDir])

    const policyPath = join(stateDir, 'github-policy.json')
    writePolicy(policyPath, defaultPolicy())

    let pollCount = 0
    const requestsReceived: Array<{ url: string; ifNoneMatch: string | undefined }> = []

    const serverInstance = await createFakeServer((req, res) => {
      pollCount++
      const ifNoneMatch = typeof req.headers['if-none-match'] === 'string' ? req.headers['if-none-match'] : undefined
      requestsReceived.push({ url: req.url ?? '', ifNoneMatch })

      if (pollCount === 1) {
        // Round 1: first successful poll establishing a committed ETag
        const events = [
          makeIssueCommentEvent('5001', 'owner/repo', 1, 'alice', '/factory task Seed event 5001'),
        ]
        res.writeHead(200, {
          'Content-Type': 'application/vnd.github+json',
          'ETag': 'etag-committed-old',
          'x-poll-interval': '60',
        })
        res.end(JSON.stringify(events))
        return
      }

      // Round 2 (faulted) & Round 3 (takeover): return event 5001 and event 5002 with new ETag
      const events = [
        makeIssueCommentEvent('5001', 'owner/repo', 1, 'alice', '/factory task Seed event 5001'),
        makeIssueCommentEvent('5002', 'owner/repo', 1, 'alice', '/factory task New event 5002'),
      ]
      res.writeHead(200, {
        'Content-Type': 'application/vnd.github+json',
        'ETag': 'etag-new-v2',
        'x-poll-interval': '60',
      })
      res.end(JSON.stringify(events))
    })

    const env = cleanTestEnv({
      FACTORY_GITHUB_API_URL: serverInstance.url,
      FACTORY_GITHUB_TOKEN: 'token-test-500',
    })

    // Step 1: First successful round establishes a committed old ETag
    const sup1 = await runCliAsync(
      ['start', '--state-dir', stateDir, '--exit-when-idle', '--stale-after-ms', '300', '--heartbeat-ms', '50'],
      { env },
    )
    expect(sup1.status).toBe(0)
    expect(requestsReceived).toHaveLength(1)
    expect(requestsReceived[0]!.ifNoneMatch).toBeUndefined()

    const dbPath = join(stateDir, 'state.sqlite')
    const db1 = openStore(dbPath)
    try {
      const cursor1 = db1.prepare('SELECT etag, next_poll_ms FROM github_cursor WHERE repo = ?').get('owner/repo') as { etag: string; next_poll_ms: number }
      expect(cursor1.etag).toBe('etag-committed-old')

      const evCount = (db1.prepare('SELECT count(*) as cnt FROM github_events').get() as { cnt: number }).cnt
      expect(evCount).toBe(1)

      // Make the repo due for the second round
      db1.prepare('UPDATE github_cursor SET next_poll_ms = 0 WHERE repo = ?').run('owner/repo')
    } finally {
      db1.close()
    }

    // Step 2: Second round runs with FACTORY_FAULT=github-after-poll:
    // Process is hard-killed after poll receives events result and before ingestPoll commits it
    const faultedEnv = cleanTestEnv({
      FACTORY_GITHUB_API_URL: serverInstance.url,
      FACTORY_GITHUB_TOKEN: 'token-test-500',
      FACTORY_FAULT: 'github-after-poll',
    })

    const sup2Child = spawnCli(
      ['start', '--state-dir', stateDir, '--stale-after-ms', '300', '--heartbeat-ms', '50'],
      { env: faultedEnv },
    )

    // Wait for the faulted supervisor child to terminate
    const dead = await waitForProcessDeath(sup2Child.pid, 15000, sup2Child.marker)
    expect(dead).toBe(true)

    // Verify DB still holds old committed state (no partial rows for event 5002, ETag is still old)
    let leaseEvidence: { ownerId: string; generation: number; heartbeatMs: number }
    const db2 = openStore(dbPath)
    try {
      const cursor2 = db2.prepare('SELECT etag FROM github_cursor WHERE repo = ?').get('owner/repo') as { etag: string }
      expect(cursor2.etag).toBe('etag-committed-old')

      const eventsAfterFault = db2.prepare('SELECT event_id FROM github_events').all() as Array<{ event_id: string }>
      expect(eventsAfterFault).toHaveLength(1)
      expect(eventsAfterFault[0]!.event_id).toBe('5001')

      // Read lease to prepare takeover
      const lease = db2.prepare('SELECT owner_id, generation, heartbeat_ms FROM supervisor_lease WHERE id = 1').get() as {
        owner_id: string
        generation: number
        heartbeat_ms: number
      }
      expect(lease).toBeDefined()
      leaseEvidence = {
        ownerId: lease.owner_id,
        generation: lease.generation,
        heartbeatMs: lease.heartbeat_ms,
      }

      // Ensure repo is due for takeover startup
      db2.prepare('UPDATE github_cursor SET next_poll_ms = 0 WHERE repo = ?').run('owner/repo')
    } finally {
      db2.close()
    }

    // Step 3: Wait until the persisted heartbeat is stale (heartbeatMs + staleAfterMs - Date.now() + 50)
    const waitStaleMs = Math.max(0, leaseEvidence.heartbeatMs + 300 - Date.now() + 50)
    await delay(waitStaleMs)

    // Step 4: Start supervisor 3 with --takeover
    const takeoverArg = `${leaseEvidence.ownerId}:${leaseEvidence.generation}:${leaseEvidence.heartbeatMs}`
    const takeoverRes = await runCliAsync(
      ['start', '--state-dir', stateDir, '--takeover', takeoverArg, '--exit-when-idle', '--stale-after-ms', '300', '--heartbeat-ms', '50'],
      { env },
    )
    expect(takeoverRes.status).toBe(0)

    // Assert that the takeover poll resent the OLD stored ETag ('etag-committed-old')
    expect(requestsReceived.length).toBeGreaterThanOrEqual(3)
    const takeoverReq = requestsReceived[2]!
    expect(takeoverReq.ifNoneMatch).toBe('etag-committed-old')

    // Verify that after takeover, exactly one row exists for each event (deduped)
    const db3 = openStore(dbPath)
    try {
      const cursor3 = db3.prepare('SELECT etag FROM github_cursor WHERE repo = ?').get('owner/repo') as { etag: string }
      expect(cursor3.etag).toBe('etag-new-v2')

      const rows = db3.prepare('SELECT event_id, status FROM github_events ORDER BY event_id ASC').all() as Array<{ event_id: string; status: string }>
      expect(rows).toEqual([
        { event_id: '5001', status: 'pending' },
        { event_id: '5002', status: 'pending' },
      ])
    } finally {
      db3.close()
    }
  })

  it('CHK-M6-05-d: --exit-when-idle exits with pending events present and no due poll', async () => {
    const root = getTempDir()
    const repoDir = join(root, 'repo')
    const stateDir = join(root, 'state')
    createGitRepo(repoDir)
    await runCliAsync(['init', '--state-dir', stateDir, '--repo', repoDir])

    const policyPath = join(stateDir, 'github-policy.json')
    writePolicy(policyPath, defaultPolicy())

    const dbPath = join(stateDir, 'state.sqlite')
    const db = openStore(dbPath)
    try {
      const project = db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: string }
      db.prepare(`
        INSERT INTO github_events (event_id, project_id, repo, kind, actor_id, actor_login, issue, status, reason, title, scope_json, basis_json, text, text_trust, text_sha256, event_at, received_at)
        VALUES ('7001', ?, 'owner/repo', 'issue.opened', 1, 'alice', 1, 'pending', null, 'Pending task 7001', '["."]', '{}', 'body', 'untrusted', 'sha', '2026-11-13T00:00:00.000Z', '2026-11-13T00:00:00.000Z')
      `).run(project.id)
      db.prepare(`
        INSERT INTO github_cursor (project_id, repo, etag, next_poll_ms, error, updated_at)
        VALUES (?, 'owner/repo', 'e1', ?, null, '2026-11-13T00:00:00.000Z')
      `).run(project.id, Date.now() + 3600000)
    } finally {
      db.close()
    }

    const env = cleanTestEnv({
      FACTORY_GITHUB_TOKEN: 'valid-test-token',
    })

    const res = await runCliAsync(['start', '--state-dir', stateDir, '--exit-when-idle', '--heartbeat-ms', '50'], { env })
    expect(res.status).toBe(0)
  })

  it('CHK-M6-05-d: with a due poll runTick returns idle false and the process exits on a later tick', async () => {
    const root = getTempDir()
    const repoDir = join(root, 'repo')
    const stateDir = join(root, 'state')
    createGitRepo(repoDir)
    await runCliAsync(['init', '--state-dir', stateDir, '--repo', repoDir])

    const policyPath = join(stateDir, 'github-policy.json')
    writePolicy(policyPath, defaultPolicy())

    let pollCount = 0
    const serverInstance = await createFakeServer((_req, res) => {
      pollCount++
      res.writeHead(200, {
        'Content-Type': 'application/vnd.github+json',
        'ETag': 'etag-due-1',
        'x-poll-interval': '60',
      })
      res.end('[]')
    })

    const env = cleanTestEnv({
      FACTORY_GITHUB_API_URL: serverInstance.url,
      FACTORY_GITHUB_TOKEN: 'valid-test-token',
    })

    const res = await runCliAsync(['start', '--state-dir', stateDir, '--exit-when-idle', '--heartbeat-ms', '50'], { env })
    expect(res.status).toBe(0)
    expect(pollCount).toBe(1)
  })

  it('CHK-M6-05-e: real process: polls local server with ETag, ingests allowed comment, approve creates task finished by fake executor, request log verification, canary token isolation', async () => {
    const root = getTempDir()
    const repoDir = join(root, 'repo')
    const stateDir = join(root, 'state')
    createGitRepo(repoDir)
    const initRes = await runCliAsync(['init', '--state-dir', stateDir, '--repo', repoDir])
    expect(initRes.status).toBe(0)

    const canaryToken = 'ghp_CANARY_SECRET_TOKEN_DO_NOT_LEAK_xyz987654321'
    const policyPath = join(stateDir, 'github-policy.json')
    writePolicy(policyPath, defaultPolicy({
      repos: [{ name: 'owner/canary-repo', labels: ['factory'], scope: ['.'] }],
      actors: [{ id: 999, login: 'alice' }],
    }))

    const requestsLog: Array<{ method: string; url: string; auth: string | undefined; ifNoneMatch: string | undefined }> = []

    const serverInstance = await createFakeServer((req, res) => {
      const auth = typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : undefined
      const ifNoneMatch = typeof req.headers['if-none-match'] === 'string' ? req.headers['if-none-match'] : undefined
      requestsLog.push({
        method: req.method ?? '',
        url: req.url ?? '',
        auth,
        ifNoneMatch,
      })

      if (ifNoneMatch === 'canary-etag-v1') {
        res.writeHead(304, {
          'ETag': 'canary-etag-v1',
          'x-poll-interval': '60',
        })
        res.end()
        return
      }

      const events = [
        makeIssueCommentEvent('888001', 'owner/canary-repo', 999, 'alice', '/factory task Canary task to execute'),
      ]
      res.writeHead(200, {
        'Content-Type': 'application/vnd.github+json',
        'ETag': 'canary-etag-v1',
        'x-poll-interval': '60',
      })
      res.end(JSON.stringify(events))
    })

    const env = cleanTestEnv({
      FACTORY_GITHUB_API_URL: serverInstance.url,
      FACTORY_GITHUB_TOKEN: canaryToken,
    })

    // 1. Run supervisor with --exit-when-idle: polls fake server and ingests event
    const supervisor1 = await runCliAsync(['start', '--state-dir', stateDir, '--exit-when-idle', '--heartbeat-ms', '50'], { env })
    expect(supervisor1.status).toBe(0)

    const dbPath = join(stateDir, 'state.sqlite')
    const db = openStore(dbPath)
    try {
      const eventRow = db.prepare('SELECT event_id, status FROM github_events WHERE event_id = ?').get('888001') as { event_id: string; status: string } | undefined
      expect(eventRow).toBeDefined()
      expect(eventRow?.status).toBe('pending')
    } finally {
      db.close()
    }

    // 2. CLI approve creates a task
    const approveRes = await runCliAsync(['github', 'approve', '--state-dir', stateDir, '--event', '888001'], { env })
    expect(approveRes.status).toBe(0)

    // Force repo to be due so that supervisor2 executes a second poll round sending If-None-Match
    const dbDue = openStore(dbPath)
    try {
      dbDue.prepare("UPDATE github_cursor SET next_poll_ms = 0 WHERE repo = 'owner/canary-repo'").run()
    } finally {
      dbDue.close()
    }

    // 3. Run supervisor again with --exit-when-idle: performs second poll round and fake executor finishes the task done
    const supervisor2 = await runCliAsync(['start', '--state-dir', stateDir, '--exit-when-idle', '--heartbeat-ms', '50'], { env })
    expect(supervisor2.status).toBe(0)

    // Verify task reached 'done'
    const db2 = openStore(dbPath)
    try {
      const task = db2.prepare('SELECT status FROM tasks LIMIT 1').get() as { status: string } | undefined
      expect(task).toBeDefined()
      expect(task?.status).toBe('done')

      const approvedEvent = db2.prepare('SELECT status, task_id FROM github_events WHERE event_id = ?').get('888001') as { status: string; task_id: string | null }
      expect(approvedEvent.status).toBe('approved')
      expect(approvedEvent.task_id).toBeTruthy()
    } finally {
      db2.close()
    }

    // 4. Verify server request log: validate every recorded request against permitted method, path, and auth
    expect(requestsLog.length).toBeGreaterThanOrEqual(2)
    for (const req of requestsLog) {
      expect(req.method).toBe('GET')
      expect(req.url).toBe('/repos/owner/canary-repo/events?per_page=100')
      expect(req.auth).toBe(`Bearer ${canaryToken}`)
    }
    expect(requestsLog[0]!.ifNoneMatch).toBeUndefined()
    expect(requestsLog[1]!.ifNoneMatch).toBe('canary-etag-v1')

    // 5. Canary token isolation: canary appears nowhere in status, outputs, or state files
    const statusJsonRes = await runCliAsync(['status', '--state-dir', stateDir, '--json'], { env })
    expect(statusJsonRes.status).toBe(0)
    expect(statusJsonRes.stdout).not.toContain(canaryToken)
    expect(statusJsonRes.stderr).not.toContain(canaryToken)

    const statusTextRes = await runCliAsync(['status', '--state-dir', stateDir], { env })
    expect(statusTextRes.status).toBe(0)
    expect(statusTextRes.stdout).not.toContain(canaryToken)
    expect(statusTextRes.stderr).not.toContain(canaryToken)

    expect(supervisor1.stdout).not.toContain(canaryToken)
    expect(supervisor1.stderr).not.toContain(canaryToken)
    expect(supervisor2.stdout).not.toContain(canaryToken)
    expect(supervisor2.stderr).not.toContain(canaryToken)

    // Scan all state directory files recursively (db and WAL bytes included) with retry deadline
    const matches = findCanaryInDir(stateDir, canaryToken)
    expect(matches).toEqual([])
  })
})
