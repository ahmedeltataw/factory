import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { applyPendingCommands } from '../../supervisor/src/app/apply-commands.ts'
import { killTree } from '../../supervisor/src/app/process-tree.ts'
import { openStore } from '../../supervisor/src/app/store.ts'
import { acquireSupervisor } from '../../supervisor/src/app/supervisor-lease.ts'

const cliPath = join(process.cwd(), 'supervisor/src/cli/main.ts')
const directories: string[] = []
const activeNonces = new Set<string>()

interface TrackedSupervisorChild {
  readonly child: ChildProcess
  readonly pid: number
  readonly marker: string
}
const spawnedSupervisors: TrackedSupervisorChild[] = []

function getCommandLineForPid(pid: number): string | undefined {
  if (!pid || pid <= 0) return undefined
  try {
    if (process.platform === 'win32') {
      const res = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
        ],
        { encoding: 'utf8', timeout: 10000, windowsHide: true },
      )
      return res.status === 0 && res.stdout ? res.stdout.trim() : undefined
    } else {
      const res = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
        timeout: 10000,
      })
      return res.status === 0 && res.stdout ? res.stdout.trim() : undefined
    }
  } catch {
    return undefined
  }
}

function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForProcessDeath(pid: number, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await delay(50)
  }
  return !isProcessAlive(pid)
}

function processesWithNonces(nonces: string[]): Array<{ pid: number; nonce: string }> {
  const validNonces = nonces.filter((n) => typeof n === 'string' && n.length > 0)
  if (!validNonces.length) return []
  if (process.platform === 'win32') {
    const query = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$ErrorActionPreference='Stop'; $p=@(Get-CimInstance Win32_Process -Property ProcessId,CommandLine | Where-Object { $_.CommandLine } | ForEach-Object { @{ ProcessId = $_.ProcessId; CommandLine = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($_.CommandLine)) } }); ConvertTo-Json -InputObject $p -Compress",
      ],
      { encoding: 'utf8', timeout: 15000, windowsHide: true },
    )
    if (query.error || query.status !== 0) throw new Error(query.error?.message || query.stderr)
    const rows = JSON.parse(query.stdout) as Array<{ ProcessId: number; CommandLine: string }>
    return rows.flatMap((row) => {
      if (
        typeof row.CommandLine !== 'string' ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.CommandLine)
      ) {
        throw new Error('Invalid process command')
      }
      const bytes = Buffer.from(row.CommandLine, 'base64')
      if (bytes.length % 2 !== 0 || bytes.toString('base64') !== row.CommandLine) {
        throw new Error('Invalid process command')
      }
      const command = bytes.toString('utf16le')
      return validNonces.filter((nonce) => command.includes(nonce)).map((nonce) => ({ pid: row.ProcessId, nonce }))
    })
  }
  const query = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 10000 })
  if (query.error || query.status !== 0) throw new Error(query.error?.message || query.stderr)
  return query.stdout.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/)
    return match
      ? validNonces.filter((nonce) => match[2]!.includes(nonce)).map((nonce) => ({ pid: Number(match[1]), nonce }))
      : []
  })
}

function collectNoncesFromDatabases(): void {
  for (const root of directories) {
    const dbPath = join(root, 'state', 'state.sqlite')
    if (existsSync(dbPath)) {
      try {
        const db = openStore(dbPath)
        try {
          const rows = db.prepare('SELECT nonce FROM workers').all() as Array<{ nonce: string }>
          for (const r of rows) {
            if (r.nonce) activeNonces.add(r.nonce)
          }
        } finally {
          db.close()
        }
      } catch {
        // ignore DB read error on cleanup
      }
    }
  }
}

async function cleanupAllProcesses(timeoutMs = 25000): Promise<void> {
  // 1. Terminate tracked supervisors
  for (const s of spawnedSupervisors) {
    if (isProcessAlive(s.pid)) {
      const cmd = getCommandLineForPid(s.pid)
      if (cmd && cmd.includes(s.marker)) {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/T', '/F', '/PID', String(s.pid)], { timeout: 10000, windowsHide: true })
        } else {
          try { s.child.kill('SIGKILL') } catch {}
        }
      }
    }
  }
  spawnedSupervisors.length = 0

  // 2. Collect any remaining nonces from all DBs
  collectNoncesFromDatabases()

  // 3. Sweep workers by verified identity until empty or deadline
  const nonces = Array.from(activeNonces).filter((n) => typeof n === 'string' && n.length > 0)
  if (nonces.length > 0) {
    const deadline = Date.now() + timeoutMs
    let survivors: Array<{ pid: number; nonce: string }> = []
    while (Date.now() < deadline) {
      survivors = processesWithNonces(nonces)
      if (survivors.length === 0) break
      for (const s of survivors) {
        if (s.pid === process.pid) continue
        let killRes: { result: string } = { result: 'kill-failed' }
        try {
          killRes = await killTree(s.pid, s.nonce)
        } catch {}
        if (killRes.result !== 'identity-mismatch' && isProcessAlive(s.pid)) {
          const cmd = getCommandLineForPid(s.pid)
          if (cmd && cmd.includes(s.nonce)) {
            if (process.platform === 'win32') {
              spawnSync('taskkill', ['/T', '/F', '/PID', String(s.pid)], { timeout: 10000, windowsHide: true })
            } else {
              try { process.kill(s.pid, 'SIGKILL') } catch {}
            }
          }
        }
      }
      await delay(100)
    }

    survivors = processesWithNonces(nonces)
    if (survivors.length > 0) {
      throw new Error(`Cleanup failed to terminate all matching processes for nonces [${nonces.join(', ')}]. Survivors: ${survivors.map(s => s.pid).join(', ')}`)
    }
    activeNonces.clear()
  }
}

function safeRemoveDir(dir: string): void {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      return
    } catch (err) {
      if (attempt === 10) throw err
      const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
      Atomics.wait(waitBuffer, 0, 0, 50)
    }
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c', 'user.name=Factory Test',
      '-c', 'user.email=factory@example.test',
      '-c', 'core.hooksPath=',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
    },
  ).trim()
}

function createGitRepo(dir: string, initialFiles?: Record<string, string>): { baseSha: string } {
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', dir], { stdio: 'ignore', timeout: 15000 })
  git(dir, 'config', 'core.autocrlf', 'false')
  if (initialFiles) {
    for (const [rel, content] of Object.entries(initialFiles)) {
      const full = join(dir, rel)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content, 'utf8')
    }
  } else {
    writeFileSync(join(dir, 'README.md'), '# test\n', 'utf8')
  }
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'initial commit')
  const baseSha = git(dir, 'rev-parse', 'HEAD')
  return { baseSha }
}

function cleanTestEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of [
    'FACTORY_FAULT',
    'FAKE_FAIL_UNTIL_ATTEMPT',
    'FAKE_FAIL_CODE',
    'FAKE_HANG',
    'FAKE_WRITE',
    'FAKE_SLEEP_MS',
    'FAKE_EXIT_CODE',
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

function runCli(
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number },
) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options?.cwd,
    env: options?.env ?? cleanTestEnv(),
    encoding: 'utf8',
    timeout: options?.timeout ?? 45000,
    windowsHide: true,
  })
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    throw new Error(`CLI execution timed out after ${options?.timeout ?? 45000}ms: factory ${args.join(' ')}`)
  }
  return result
}

function parseCreatedTaskId(stdout: string): string {
  const match = stdout.match(/^created\s+([0-9a-f-]+)/im)
  const id = match?.[1]
  if (!id) throw new Error(`Failed to parse created task ID: ${stdout}`)
  return id
}

async function waitForWorkerPublication(
  runsDir: string,
  timeoutMs = 25000,
  excludeAttemptIds: Set<string> = new Set(),
): Promise<{ pid: number; nonce: string; grandchildPid: number; attemptId: string }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(runsDir)) {
      try {
        const attemptDirs = readdirSync(runsDir)
        for (const attId of attemptDirs) {
          if (excludeAttemptIds.has(attId)) continue
          const workerJsonPath = join(runsDir, attId, 'worker.json')
          if (existsSync(workerJsonPath)) {
            try {
              const raw = readFileSync(workerJsonPath, 'utf8')
              const data = JSON.parse(raw) as { pid: number; nonce: string; grandchildPid: number }
              if (
                data &&
                typeof data.pid === 'number' &&
                typeof data.nonce === 'string' &&
                typeof data.grandchildPid === 'number'
              ) {
                return { pid: data.pid, nonce: data.nonce, grandchildPid: data.grandchildPid, attemptId: attId }
              }
            } catch {}
          }
        }
      } catch {}
    }
    await delay(50)
  }
  throw new Error(`Worker identity was not published within ${timeoutMs}ms`)
}

afterEach(async () => {
  try {
    await cleanupAllProcesses()
  } finally {
    for (const dir of [...directories]) {
      try {
        safeRemoveDir(dir)
      } catch {
        // ignore
      }
    }
    directories.length = 0
  }
})

describe('M4-06 scope locks and scope enforcement', () => {
  it(
    'CHK-M4-06-a: overlapping scopes run sequentially, earlier task runs first, and disjoint scope runs concurrently',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'm4-06-a-'))
      directories.push(root)
      const repoDir = join(root, 'repo')
      const stateDir = join(root, 'state')
      const tempCwd = join(root, 'cwd')
      mkdirSync(tempCwd, { recursive: true })

      createGitRepo(repoDir)
      const initRes = runCli(['init', '--state-dir', stateDir, '--repo', repoDir], { cwd: tempCwd })
      expect(initRes.status).toBe(0)

      const task1Id = randomUUID()
      const create1 = runCli(['task', 'create', '--state-dir', stateDir, '--title', 'Task 1', '--scope', 'src', '--scope', `factory-fake/${task1Id}.txt`, '--command-id', task1Id], { cwd: tempCwd })
      expect(create1.status).toBe(0)

      const task2Id = randomUUID()
      const create2 = runCli(['task', 'create', '--state-dir', stateDir, '--title', 'Task 2', '--scope', 'src/a', '--scope', `factory-fake/${task2Id}.txt`, '--command-id', task2Id], { cwd: tempCwd })
      expect(create2.status).toBe(0)

      const task3Id = randomUUID()
      const create3 = runCli(['task', 'create', '--state-dir', stateDir, '--title', 'Task 3', '--scope', 'lib', '--scope', `factory-fake/${task3Id}.txt`, '--command-id', task3Id], { cwd: tempCwd })
      expect(create3.status).toBe(0)

      try {
        const startRes = runCli(
          ['start', '--state-dir', stateDir, '--exit-when-idle'],
          {
            cwd: tempCwd,
            env: cleanTestEnv({
              FAKE_SLEEP_MS: '1500',
            }),
            timeout: 60000,
          },
        )
        expect(startRes.status).toBe(0)

        const db = openStore(join(stateDir, 'state.sqlite'))
        try {
          const nonces = db.prepare('SELECT nonce FROM workers').all() as Array<{ nonce: string }>
          for (const n of nonces) activeNonces.add(n.nonce)

          const t1 = db.prepare('SELECT status FROM tasks WHERE id = ?').get(task1Id) as { status: string }
          const t2 = db.prepare('SELECT status FROM tasks WHERE id = ?').get(task2Id) as { status: string }
          const t3 = db.prepare('SELECT status FROM tasks WHERE id = ?').get(task3Id) as { status: string }
          expect(t1.status).toBe('done')
          expect(t2.status).toBe('done')
          expect(t3.status).toBe('done')

          const att1 = db.prepare('SELECT started_at, ended_at, status FROM attempts WHERE task_id = ?').get(task1Id) as { started_at: string; ended_at: string; status: string }
          const att2 = db.prepare('SELECT started_at, ended_at, status FROM attempts WHERE task_id = ?').get(task2Id) as { started_at: string; ended_at: string; status: string }
          const att3 = db.prepare('SELECT started_at, ended_at, status FROM attempts WHERE task_id = ?').get(task3Id) as { started_at: string; ended_at: string; status: string }
          expect(att1.status).toBe('succeeded')
          expect(att2.status).toBe('succeeded')
          expect(att3.status).toBe('succeeded')

          const w1 = db.prepare('SELECT started_at, ended_at FROM workers WHERE attempt_id = (SELECT id FROM attempts WHERE task_id = ?)').get(task1Id) as { started_at: string; ended_at: string }
          const w2 = db.prepare('SELECT started_at, ended_at FROM workers WHERE attempt_id = (SELECT id FROM attempts WHERE task_id = ?)').get(task2Id) as { started_at: string; ended_at: string }
          const w3 = db.prepare('SELECT started_at, ended_at FROM workers WHERE attempt_id = (SELECT id FROM attempts WHERE task_id = ?)').get(task3Id) as { started_at: string; ended_at: string }

          const start1 = Date.parse(att1.started_at)
          const end1 = Date.parse(att1.ended_at)
          const start2 = Date.parse(att2.started_at)
          const start3 = Date.parse(att3.started_at)
          const end3 = Date.parse(att3.ended_at)

          // Earlier task runs first:
          expect(start1).toBeLessThanOrEqual(start2)

          // Overlapping scopes do not overlap in running intervals:
          expect(end1).toBeLessThanOrEqual(start2)
          expect(Date.parse(w1.ended_at)).toBeLessThanOrEqual(Date.parse(w2.started_at))

          // Disjoint scope runs at the same time as the first task:
          expect(Math.max(start1, start3)).toBeLessThan(Math.min(end1, end3))
          expect(Math.max(Date.parse(w1.started_at), Date.parse(w3.started_at))).toBeLessThan(
            Math.min(Date.parse(w1.ended_at), Date.parse(w3.ended_at)),
          )
        } finally {
          db.close()
        }
      } finally {
        collectNoncesFromDatabases()
      }
    },
    90000,
  )

  it(
    'CHK-M4-06-b: FIFO ordering with reservation by skipped tasks',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'm4-06-b-fifo-'))
      directories.push(root)
      const repoDir = join(root, 'repo')
      const stateDir = join(root, 'state')
      const tempCwd = join(root, 'cwd')
      mkdirSync(tempCwd, { recursive: true })

      createGitRepo(repoDir)
      const initRes = runCli(['init', '--state-dir', stateDir, '--repo', repoDir], { cwd: tempCwd })
      expect(initRes.status).toBe(0)

      // Task A: scope 'src'
      const taskAId = randomUUID()
      const createA = runCli(['task', 'create', '--state-dir', stateDir, '--title', 'Task A', '--scope', 'src', '--scope', `factory-fake/${taskAId}.txt`, '--command-id', taskAId], { cwd: tempCwd })
      expect(createA.status).toBe(0)

      // Task B: scope 'docs'
      const taskBId = randomUUID()
      const createB = runCli(['task', 'create', '--state-dir', stateDir, '--title', 'Task B', '--scope', 'docs', '--scope', `factory-fake/${taskBId}.txt`, '--command-id', taskBId], { cwd: tempCwd })
      expect(createB.status).toBe(0)

      // Task C: scope 'src/x' and 'docs/y' (overlaps A on src, overlaps B on docs)
      const taskCId = randomUUID()
      const createC = runCli(['task', 'create', '--state-dir', stateDir, '--title', 'Task C', '--scope', 'src/x', '--scope', 'docs/y', '--scope', `factory-fake/${taskCId}.txt`, '--command-id', taskCId], { cwd: tempCwd })
      expect(createC.status).toBe(0)

      // Task D: scope 'lib' (disjoint from all)
      const taskDId = randomUUID()
      const createD = runCli(['task', 'create', '--state-dir', stateDir, '--title', 'Task D', '--scope', 'lib', '--scope', `factory-fake/${taskDId}.txt`, '--command-id', taskDId], { cwd: tempCwd })
      expect(createD.status).toBe(0)

      try {
        const startRes = runCli(
          ['start', '--state-dir', stateDir, '--exit-when-idle'],
          {
            cwd: tempCwd,
            env: cleanTestEnv({
              FAKE_SLEEP_MS: '1500',
            }),
            timeout: 60000,
          },
        )
        expect(startRes.status).toBe(0)

        const db = openStore(join(stateDir, 'state.sqlite'))
        try {
          const nonces = db.prepare('SELECT nonce FROM workers').all() as Array<{ nonce: string }>
          for (const n of nonces) activeNonces.add(n.nonce)

          const attA = db.prepare('SELECT id, started_at, ended_at FROM attempts WHERE task_id = ?').get(taskAId) as { id: string; started_at: string; ended_at: string }
          const attB = db.prepare('SELECT id, started_at, ended_at FROM attempts WHERE task_id = ?').get(taskBId) as { id: string; started_at: string; ended_at: string }
          const attC = db.prepare('SELECT id, started_at, ended_at FROM attempts WHERE task_id = ?').get(taskCId) as { id: string; started_at: string; ended_at: string }
          const attD = db.prepare('SELECT id, started_at, ended_at FROM attempts WHERE task_id = ?').get(taskDId) as { id: string; started_at: string; ended_at: string }

          const startA = Date.parse(attA.started_at)
          const endA = Date.parse(attA.ended_at)
          const startB = Date.parse(attB.started_at)
          const endB = Date.parse(attB.ended_at)
          const startC = Date.parse(attC.started_at)
          const startD = Date.parse(attD.started_at)
          const endD = Date.parse(attD.ended_at)

          // C never starts before both A and B have left progress:
          expect(startC).toBeGreaterThanOrEqual(endA)
          expect(startC).toBeGreaterThanOrEqual(endB)

          // Disjoint task D created after C starts without waiting for C:
          expect(startD).toBeLessThan(startC)
          expect(Math.max(startD, startA)).toBeLessThan(Math.min(endD, endA))
        } finally {
          db.close()
        }
      } finally {
        collectNoncesFromDatabases()
      }
    },
    90000,
  )

  it(
    'CHK-M4-06-b delayed evidence: scope locks remain held while evidence.commit is pending in outbox',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'm4-06-b-delay-'))
      directories.push(root)
      const repoDir = join(root, 'repo')
      const stateDir = join(root, 'state')
      const tempCwd = join(root, 'cwd')
      mkdirSync(tempCwd, { recursive: true })

      const { baseSha } = createGitRepo(repoDir)
      const initRes = runCli(['init', '--state-dir', stateDir, '--repo', repoDir], { cwd: tempCwd })
      expect(initRes.status).toBe(0)

      // Task A: scope 'src'
      const taskAId = randomUUID()
      const createA = runCli(['task', 'create', '--state-dir', stateDir, '--title', 'Task A', '--scope', 'src', '--scope', `factory-fake/${taskAId}.txt`, '--command-id', taskAId], { cwd: tempCwd })
      expect(createA.status).toBe(0)

      // Task B: scope 'src/sub' (overlaps Task A)
      const taskBId = randomUUID()
      const createB = runCli(['task', 'create', '--state-dir', stateDir, '--title', 'Task B', '--scope', 'src/sub', '--scope', `factory-fake/${taskBId}.txt`, '--command-id', taskBId], { cwd: tempCwd })
      expect(createB.status).toBe(0)

      // Task D: scope 'lib' (disjoint from Task A and B)
      const taskDId = randomUUID()
      const createD = runCli(['task', 'create', '--state-dir', stateDir, '--title', 'Task D', '--scope', 'lib', '--scope', `factory-fake/${taskDId}.txt`, '--command-id', taskDId], { cwd: tempCwd })
      expect(createD.status).toBe(0)

      // Apply queued create commands
      const dbPre = openStore(join(stateDir, 'state.sqlite'))
      const attemptAId = randomUUID()
      const delayMs = 3000
      const futureAttemptMs = Date.now() + delayMs
      try {
        const handle = acquireSupervisor(dbPre, stateDir, { nowMs: Date.now(), staleAfterMs: 30000 })
        try {
          applyPendingCommands(dbPre, handle)
        } finally {
          handle.release(Date.now())
        }

        // Set Task A to 'progress' with attempt 1 'succeeded' and worker 'exited'
        const nowIso = new Date().toISOString()
        dbPre.prepare("UPDATE tasks SET status = 'progress', updated_at = ? WHERE id = ?").run(nowIso, taskAId)
        dbPre.prepare(`
          INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation, started_at, ended_at)
          VALUES (?, ?, 1, 'succeeded', 1, ?, ?)
        `).run(attemptAId, taskAId, nowIso, nowIso)

        const worktreeDir = join(stateDir, 'worktrees', taskAId)
        mkdirSync(dirname(worktreeDir), { recursive: true })
        git(repoDir, 'worktree', 'add', worktreeDir, baseSha)
        mkdirSync(join(worktreeDir, 'src'), { recursive: true })
        writeFileSync(join(worktreeDir, 'src', 'change.txt'), 'data\n', 'utf8')

        const runDir = join(stateDir, 'runs', attemptAId)
        mkdirSync(runDir, { recursive: true })
        writeFileSync(join(runDir, 'stdout.log'), '')
        writeFileSync(join(runDir, 'stderr.log'), '')

        dbPre.prepare(`
          INSERT INTO workers (attempt_id, nonce, pid, state, worktree_path, heartbeat_ms, started_at, ended_at)
          VALUES (?, ?, 99999, 'exited', ?, ?, ?, ?)
        `).run(attemptAId, randomUUID(), worktreeDir, Date.now(), nowIso, nowIso)

        // Seed outbox for Task A with next_attempt_ms in the future
        dbPre.prepare(`
          INSERT INTO outbox (id, idempotency_key, kind, payload_json, status, tries, next_attempt_ms, created_at, updated_at)
          VALUES (?, ?, 'evidence.commit', ?, 'pending', 0, ?, ?, ?)
        `).run(
          randomUUID(),
          `evidence.commit:${attemptAId}`,
          JSON.stringify({
            attemptId: attemptAId,
            worktreePath: worktreeDir,
            baseSha,
            stdoutPath: join(runDir, 'stdout.log'),
            stderrPath: join(runDir, 'stderr.log'),
            exitCode: 0,
          }),
          futureAttemptMs,
          nowIso,
          nowIso,
        )

        // Verify next_attempt_ms was stored
        const outboxRow = dbPre.prepare('SELECT next_attempt_ms FROM outbox WHERE idempotency_key = ?').get(`evidence.commit:${attemptAId}`) as { next_attempt_ms: number }
        expect(outboxRow.next_attempt_ms).toBe(futureAttemptMs)
      } finally {
        dbPre.close()
      }

      try {
        const startRes = runCli(
          ['start', '--state-dir', stateDir, '--exit-when-idle'],
          {
            cwd: tempCwd,
            env: cleanTestEnv({ FAKE_SLEEP_MS: '200' }),
            timeout: 60000,
          },
        )
        expect(startRes.status).toBe(0)

        const db = openStore(join(stateDir, 'state.sqlite'))
        try {
          const nonces = db.prepare('SELECT nonce FROM workers').all() as Array<{ nonce: string }>
          for (const n of nonces) activeNonces.add(n.nonce)

          const tA = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskAId) as { status: string }
          const tB = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskBId) as { status: string }
          const tD = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskDId) as { status: string }
          expect(tA.status).toBe('done')
          expect(tB.status).toBe('done')
          expect(tD.status).toBe('done')

          const attB = db.prepare('SELECT started_at, ended_at FROM attempts WHERE task_id = ?').get(taskBId) as { started_at: string; ended_at: string }
          const attD = db.prepare('SELECT started_at, ended_at FROM attempts WHERE task_id = ?').get(taskDId) as { started_at: string; ended_at: string }
          const evA = db.prepare('SELECT recorded_at FROM evidence WHERE attempt_id = ?').get(attemptAId) as { recorded_at: string }

          const startB = Date.parse(attB.started_at)
          const startD = Date.parse(attD.started_at)
          const evTimeA = Date.parse(evA.recorded_at)

          // Disjoint task D started before Task A's evidence was committed:
          expect(startD).toBeLessThan(evTimeA)

          // Overlapping task B was blocked until Task A's evidence was committed:
          expect(startB).toBeGreaterThanOrEqual(evTimeA)
        } finally {
          db.close()
        }
      } finally {
        collectNoncesFromDatabases()
      }
    },
    90000,
  )

  it(
    'CHK-M4-06-b reservation: waiting task with seeded not_before_ms blocks later overlapping task without retries',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'm4-06-b-res-'))
      directories.push(root)
      const repoDir = join(root, 'repo')
      const stateDir = join(root, 'state')
      const tempCwd = join(root, 'cwd')
      mkdirSync(tempCwd, { recursive: true })

      createGitRepo(repoDir)
      const initRes = runCli(['init', '--state-dir', stateDir, '--repo', repoDir], { cwd: tempCwd })
      expect(initRes.status).toBe(0)

      // Task W: scope 'src', created first
      const taskWId = randomUUID()
      const createW = runCli(['task', 'create', '--state-dir', stateDir, '--title', 'Task W', '--scope', 'src', '--scope', `factory-fake/${taskWId}.txt`, '--command-id', taskWId], { cwd: tempCwd })
      expect(createW.status).toBe(0)

      // Task X: scope 'src/sub', created second (overlaps W, not_before_ms = 0)
      const taskXId = randomUUID()
      const createX = runCli(['task', 'create', '--state-dir', stateDir, '--title', 'Task X', '--scope', 'src/sub', '--scope', `factory-fake/${taskXId}.txt`, '--command-id', taskXId], { cwd: tempCwd })
      expect(createX.status).toBe(0)

      // Task Y: scope 'lib', created third (disjoint from W and X, not_before_ms = 0)
      const taskYId = randomUUID()
      const createY = runCli(['task', 'create', '--state-dir', stateDir, '--title', 'Task Y', '--scope', 'lib', '--scope', `factory-fake/${taskYId}.txt`, '--command-id', taskYId], { cwd: tempCwd })
      expect(createY.status).toBe(0)

      // Apply queued create commands, then directly seed not_before_ms for Task W into the future:
      const dbPre = openStore(join(stateDir, 'state.sqlite'))
      const futureTime = Date.now() + 3000
      try {
        const handle = acquireSupervisor(dbPre, stateDir, { nowMs: Date.now(), staleAfterMs: 30000 })
        try {
          applyPendingCommands(dbPre, handle)
        } finally {
          handle.release(Date.now())
        }

        const updateRes = dbPre.prepare('UPDATE tasks SET not_before_ms = ? WHERE id = ?').run(futureTime, taskWId)
        expect(Number(updateRes.changes)).toBe(1)

        const taskWRow = dbPre.prepare('SELECT not_before_ms FROM tasks WHERE id = ?').get(taskWId) as { not_before_ms: number }
        expect(taskWRow.not_before_ms).toBe(futureTime)
      } finally {
        dbPre.close()
      }

      try {
        const startRes = runCli(
          ['start', '--state-dir', stateDir, '--exit-when-idle'],
          {
            cwd: tempCwd,
            env: cleanTestEnv({
              FAKE_SLEEP_MS: '200',
            }),
            timeout: 60000,
          },
        )
        expect(startRes.status).toBe(0)

        const db = openStore(join(stateDir, 'state.sqlite'))
        try {
          const nonces = db.prepare('SELECT nonce FROM workers').all() as Array<{ nonce: string }>
          for (const n of nonces) activeNonces.add(n.nonce)

          const attW = db.prepare('SELECT started_at, ended_at FROM attempts WHERE task_id = ?').get(taskWId) as { started_at: string; ended_at: string }
          const attX = db.prepare('SELECT started_at, ended_at FROM attempts WHERE task_id = ?').get(taskXId) as { started_at: string; ended_at: string }
          const attY = db.prepare('SELECT started_at, ended_at FROM attempts WHERE task_id = ?').get(taskYId) as { started_at: string; ended_at: string }

          const startW = Date.parse(attW.started_at)
          const endW = Date.parse(attW.ended_at)
          const startX = Date.parse(attX.started_at)
          const startY = Date.parse(attY.started_at)

          // Disjoint Task Y started without waiting for W's not_before_ms:
          expect(startY).toBeLessThan(startW)

          // Waiting Task W reserved its scope in held, blocking overlapping Task X:
          // X did not start before W, and started only after W finished:
          expect(startW).toBeLessThan(startX)
          expect(endW).toBeLessThanOrEqual(startX)
        } finally {
          db.close()
        }
      } finally {
        collectNoncesFromDatabases()
      }
    },
    90000,
  )

  it(
    'CHK-M4-06-c: Supervisor crash while holding scope blocks overlapping task until re-attempt completes',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'm4-06-c-'))
      directories.push(root)
      const repoDir = join(root, 'repo')
      const stateDir = join(root, 'state')
      const dbPath = join(stateDir, 'state.sqlite')
      const runsDir = join(stateDir, 'runs')
      const tempCwd = join(root, 'cwd')
      mkdirSync(tempCwd, { recursive: true })

      createGitRepo(repoDir)
      const initRes = runCli(['init', '--state-dir', stateDir, '--repo', repoDir], { cwd: tempCwd })
      expect(initRes.status).toBe(0)

      const taskAId = randomUUID()
      const createA = runCli(['task', 'create', '--state-dir', stateDir, '--title', 'Task A', '--scope', 'src', '--scope', `factory-fake/${taskAId}.txt`, '--command-id', taskAId], { cwd: tempCwd })
      expect(createA.status).toBe(0)

      const taskBId = randomUUID()
      const createB = runCli(['task', 'create', '--state-dir', stateDir, '--title', 'Task B', '--scope', 'src/a', '--scope', `factory-fake/${taskBId}.txt`, '--command-id', taskBId], { cwd: tempCwd })
      expect(createB.status).toBe(0)

      // Start supervisor 1 in background holding executor with long sleep
      const sup1 = spawn(
        process.execPath,
        [cliPath, 'start', '--state-dir', stateDir, '--stale-after-ms', '1000', '--heartbeat-ms', '500'],
        {
          cwd: tempCwd,
          env: cleanTestEnv({
            FAKE_SLEEP_MS: '30000',
          }),
          stdio: 'ignore',
          windowsHide: true,
        },
      )
      if (sup1.pid) {
        spawnedSupervisors.push({ child: sup1, pid: sup1.pid, marker: stateDir })
      }

      try {
        // Verify identity and publication of the worker
        const publishedWorker = await waitForWorkerPublication(runsDir, 25000)
        activeNonces.add(publishedWorker.nonce)

        // Verify DB records attempt and worker in running state
        const dbRunning = openStore(dbPath)
        try {
          const att = dbRunning.prepare("SELECT status FROM attempts WHERE id = ?").get(publishedWorker.attemptId) as { status: string } | undefined
          const w = dbRunning.prepare("SELECT state, pid FROM workers WHERE attempt_id = ?").get(publishedWorker.attemptId) as { state: string; pid: number } | undefined
          expect(att?.status).toBe('running')
          expect(w?.state).toBe('running')
          expect(w?.pid).toBe(publishedWorker.pid)
        } finally {
          dbRunning.close()
        }

        // Verify Supervisor identity before kill
        const sup1Cmd = getCommandLineForPid(sup1.pid!)
        expect(sup1Cmd).toBeDefined()
        expect(sup1Cmd).toContain(cliPath)
        expect(sup1Cmd).toContain(stateDir)

        // Hard-kill supervisor 1's PID only with exit confirmation
        if (process.platform === 'win32') {
          const killRes = spawnSync('taskkill', ['/F', '/PID', String(sup1.pid!)], { timeout: 10000, windowsHide: true })
          expect(killRes.error).toBeUndefined()
          expect(killRes.status).toBe(0)
        } else {
          process.kill(sup1.pid!, 'SIGKILL')
        }

        const sup1Dead = await waitForProcessDeath(sup1.pid!, 15000)
        expect(sup1Dead).toBe(true)

        // Confirm Supervisor-only death: supervisor is dead, executor and grandchild are still alive
        expect(isProcessAlive(sup1.pid!)).toBe(false)
        expect(isProcessAlive(publishedWorker.pid)).toBe(true)
        expect(isProcessAlive(publishedWorker.grandchildPid)).toBe(true)

        // Capture heartbeat evidence AFTER supervisor death confirmation
        let lease: { owner_id: string; generation: number; heartbeat_ms: number } | undefined
        const dbLease = openStore(dbPath)
        try {
          lease = dbLease.prepare('SELECT owner_id, generation, heartbeat_ms FROM supervisor_lease WHERE id = 1').get() as {
            owner_id: string
            generation: number
            heartbeat_ms: number
          }
        } finally {
          dbLease.close()
        }
        expect(lease).toBeDefined()
        const takeoverEvidence = `${lease!.owner_id}:${lease!.generation}:${lease!.heartbeat_ms}`

        // Await staleness
        const staleDeadline = lease!.heartbeat_ms + 1000 + 200
        const waitMs = Math.max(0, staleDeadline - Date.now())
        if (waitMs > 0) await delay(waitMs)

        // Restart supervisor 2 with takeover
        const start2Res = runCli(
          [
            'start',
            '--state-dir', stateDir,
            '--exit-when-idle',
            '--takeover', takeoverEvidence,
            '--stale-after-ms', '1000',
          ],
          {
            cwd: tempCwd,
            env: cleanTestEnv({
              FAKE_SLEEP_MS: '200',
            }),
            timeout: 60000,
          },
        )
        expect(start2Res.status).toBe(0)

        const db = openStore(dbPath)
        try {
          const nonces = db.prepare('SELECT nonce FROM workers').all() as Array<{ nonce: string }>
          for (const n of nonces) activeNonces.add(n.nonce)

          const attemptsA = db.prepare('SELECT attempt_no, status, started_at, ended_at FROM attempts WHERE task_id = ? ORDER BY attempt_no').all(taskAId) as Array<{
            attempt_no: number
            status: string
            started_at: string
            ended_at: string
          }>
          const attemptsB = db.prepare('SELECT attempt_no, status, started_at, ended_at FROM attempts WHERE task_id = ? ORDER BY attempt_no').all(taskBId) as Array<{
            attempt_no: number
            status: string
            started_at: string
            ended_at: string
          }>

          expect(attemptsA).toHaveLength(2)
          expect(attemptsA[0]!.status).toBe('interrupted')
          expect(attemptsA[1]!.status).toBe('succeeded')

          expect(attemptsB).toHaveLength(1)
          expect(attemptsB[0]!.status).toBe('succeeded')

          const startB = Date.parse(attemptsB[0]!.started_at)
          const endA2 = Date.parse(attemptsA[1]!.ended_at)

          // B (src/a) does not start until A's re-attempt finishes:
          expect(startB).toBeGreaterThanOrEqual(endA2)

          // No attempt of B overlaps any attempt of A:
          for (const attA of attemptsA) {
            const sA = Date.parse(attA.started_at)
            const eA = Date.parse(attA.ended_at)
            const eB = Date.parse(attemptsB[0]!.ended_at)
            const overlap = Math.max(sA, startB) < Math.min(eA, eB)
            expect(overlap, `Attempt ${attA.attempt_no} of A must not overlap attempt of B`).toBe(false)
          }
        } finally {
          db.close()
        }
      } finally {
        collectNoncesFromDatabases()
      }
    },
    90000,
  )

  it(
    'CHK-M4-06-d: write, rename, or delete outside scope fails with scope-violation without commit; write inside scope commits normally',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'm4-06-d-'))
      directories.push(root)
      const repoDir = join(root, 'repo')
      const stateDir = join(root, 'state')
      const dbPath = join(stateDir, 'state.sqlite')
      const tempCwd = join(root, 'cwd')
      mkdirSync(tempCwd, { recursive: true })

      // Create tracked files in the base commit:
      // - tracked-outside.txt (outside scope factory-fake)
      // - factory-fake/tracked-inside.txt (inside scope factory-fake)
      const { baseSha } = createGitRepo(repoDir, {
        'tracked-outside.txt': 'outside content\n',
        'factory-fake/tracked-inside.txt': 'inside content\n',
      })
      const initRes = runCli(['init', '--state-dir', stateDir, '--repo', repoDir], { cwd: tempCwd })
      expect(initRes.status).toBe(0)

      try {
        // 1. Write outside scope
        const createWriteOut = runCli(['task', 'create', '--state-dir', stateDir, '--title', 'Write Outside', '--scope', 'factory-fake'], { cwd: tempCwd })
        expect(createWriteOut.status).toBe(0)
        const taskWriteOutId = parseCreatedTaskId(createWriteOut.stdout)

        const runWriteOut = runCli(
          ['start', '--state-dir', stateDir, '--exit-when-idle'],
          {
            cwd: tempCwd,
            env: cleanTestEnv({ FAKE_WRITE: 'outside.txt' }),
            timeout: 45000,
          },
        )
        expect(runWriteOut.status).toBe(0)

        // 2a. Rename SOURCE outside scope, TARGET inside scope (staged porcelain rename R)
        const createRenSrc = runCli(['task', 'create', '--state-dir', stateDir, '--title', 'Rename Src Outside', '--scope', 'factory-fake'], { cwd: tempCwd })
        expect(createRenSrc.status).toBe(0)
        const taskRenSrcId = parseCreatedTaskId(createRenSrc.stdout)

        const knownRunsRenSrc = new Set(existsSync(join(stateDir, 'runs')) ? readdirSync(join(stateDir, 'runs')) : [])
        const supRenSrc = spawn(
          process.execPath,
          [cliPath, 'start', '--state-dir', stateDir, '--exit-when-idle'],
          {
            cwd: tempCwd,
            env: cleanTestEnv({ FAKE_SLEEP_MS: '3000' }),
            stdio: 'ignore',
            windowsHide: true,
          },
        )
        if (supRenSrc.pid) {
          spawnedSupervisors.push({ child: supRenSrc, pid: supRenSrc.pid, marker: stateDir })
        }
        const workerRenSrc = await waitForWorkerPublication(join(stateDir, 'runs'), 25000, knownRunsRenSrc)
        activeNonces.add(workerRenSrc.nonce)

        const wtRenSrc = join(stateDir, 'worktrees', taskRenSrcId)
        mkdirSync(join(wtRenSrc, 'factory-fake'), { recursive: true })
        git(wtRenSrc, 'mv', 'tracked-outside.txt', 'factory-fake/renamed-inside.txt')

        await waitForProcessDeath(supRenSrc.pid!, 30000)

        // 2b. Rename SOURCE inside scope, TARGET outside scope (staged porcelain rename R)
        const createRenTgt = runCli(['task', 'create', '--state-dir', stateDir, '--title', 'Rename Tgt Outside', '--scope', 'factory-fake'], { cwd: tempCwd })
        expect(createRenTgt.status).toBe(0)
        const taskRenTgtId = parseCreatedTaskId(createRenTgt.stdout)

        const knownRunsRenTgt = new Set(existsSync(join(stateDir, 'runs')) ? readdirSync(join(stateDir, 'runs')) : [])
        const supRenTgt = spawn(
          process.execPath,
          [cliPath, 'start', '--state-dir', stateDir, '--exit-when-idle'],
          {
            cwd: tempCwd,
            env: cleanTestEnv({ FAKE_SLEEP_MS: '3000' }),
            stdio: 'ignore',
            windowsHide: true,
          },
        )
        if (supRenTgt.pid) {
          spawnedSupervisors.push({ child: supRenTgt, pid: supRenTgt.pid, marker: stateDir })
        }
        const workerRenTgt = await waitForWorkerPublication(join(stateDir, 'runs'), 25000, knownRunsRenTgt)
        activeNonces.add(workerRenTgt.nonce)

        const wtRenTgt = join(stateDir, 'worktrees', taskRenTgtId)
        git(wtRenTgt, 'mv', 'factory-fake/tracked-inside.txt', 'escaped-outside.txt')

        await waitForProcessDeath(supRenTgt.pid!, 30000)

        // 3. Deletion of tracked file outside scope (staged deletion D)
        const createDelete = runCli(['task', 'create', '--state-dir', stateDir, '--title', 'Delete Outside', '--scope', 'factory-fake'], { cwd: tempCwd })
        expect(createDelete.status).toBe(0)
        const taskDeleteId = parseCreatedTaskId(createDelete.stdout)

        const knownRunsDel = new Set(existsSync(join(stateDir, 'runs')) ? readdirSync(join(stateDir, 'runs')) : [])
        const supDel = spawn(
          process.execPath,
          [cliPath, 'start', '--state-dir', stateDir, '--exit-when-idle'],
          {
            cwd: tempCwd,
            env: cleanTestEnv({ FAKE_SLEEP_MS: '3000' }),
            stdio: 'ignore',
            windowsHide: true,
          },
        )
        if (supDel.pid) {
          spawnedSupervisors.push({ child: supDel, pid: supDel.pid, marker: stateDir })
        }
        const workerDel = await waitForWorkerPublication(join(stateDir, 'runs'), 25000, knownRunsDel)
        activeNonces.add(workerDel.nonce)

        const wtDel = join(stateDir, 'worktrees', taskDeleteId)
        git(wtDel, 'rm', 'tracked-outside.txt')

        await waitForProcessDeath(supDel.pid!, 30000)

        // 4. Write inside scope commits normally
        const taskInsideId = randomUUID()
        const createInside = runCli(['task', 'create', '--state-dir', stateDir, '--title', 'Write Inside', '--scope', 'factory-fake', '--scope', `factory-fake/${taskInsideId}.txt`, '--command-id', taskInsideId], { cwd: tempCwd })
        expect(createInside.status).toBe(0)

        const runInside = runCli(
          ['start', '--state-dir', stateDir, '--exit-when-idle'],
          {
            cwd: tempCwd,
            env: cleanTestEnv({ FAKE_WRITE: 'factory-fake/inside.txt' }),
            timeout: 45000,
          },
        )
        expect(runInside.status).toBe(0)

        const db = openStore(dbPath)
        try {
          const nonces = db.prepare('SELECT nonce FROM workers').all() as Array<{ nonce: string }>
          for (const n of nonces) activeNonces.add(n.nonce)

          // 1. Check Write Outside
          const taskOut = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskWriteOutId) as { status: string }
          expect(taskOut.status).toBe('failed')
          const attOut = db.prepare('SELECT id, status, error_class FROM attempts WHERE task_id = ?').get(taskWriteOutId) as { id: string; status: string; error_class: string }
          expect(attOut.status).toBe('failed')
          expect(attOut.error_class).toBe('scope-violation')
          const evOut = db.prepare('SELECT COUNT(*) as c FROM evidence WHERE attempt_id = ?').get(attOut.id) as { c: number }
          expect(evOut.c).toBe(0)
          const outboxOut = db.prepare("SELECT status, last_error FROM outbox WHERE idempotency_key = ?").get(`evidence.commit:${attOut.id}`) as { status: string; last_error: string | null }
          expect(outboxOut.status).toBe('done')
          expect(outboxOut.last_error).toBe('scope-violation: outside.txt')
          expect(git(repoDir, 'rev-parse', `factory/task/${taskWriteOutId}`)).toBe(baseSha)

          // 2a. Check Rename Source Outside
          const taskRenSrc = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskRenSrcId) as { status: string }
          expect(taskRenSrc.status).toBe('failed')
          const attRenSrc = db.prepare('SELECT id, status, error_class FROM attempts WHERE task_id = ?').get(taskRenSrcId) as { id: string; status: string; error_class: string }
          expect(attRenSrc.status).toBe('failed')
          expect(attRenSrc.error_class).toBe('scope-violation')
          const evRenSrc = db.prepare('SELECT COUNT(*) as c FROM evidence WHERE attempt_id = ?').get(attRenSrc.id) as { c: number }
          expect(evRenSrc.c).toBe(0)
          const outboxRenSrc = db.prepare("SELECT status, last_error FROM outbox WHERE idempotency_key = ?").get(`evidence.commit:${attRenSrc.id}`) as { status: string; last_error: string | null }
          expect(outboxRenSrc.status).toBe('done')
          expect(outboxRenSrc.last_error).toBe('scope-violation: tracked-outside.txt')
          expect(git(repoDir, 'rev-parse', `factory/task/${taskRenSrcId}`)).toBe(baseSha)

          // 2b. Check Rename Target Outside
          const taskRenTgt = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskRenTgtId) as { status: string }
          expect(taskRenTgt.status).toBe('failed')
          const attRenTgt = db.prepare('SELECT id, status, error_class FROM attempts WHERE task_id = ?').get(taskRenTgtId) as { id: string; status: string; error_class: string }
          expect(attRenTgt.status).toBe('failed')
          expect(attRenTgt.error_class).toBe('scope-violation')
          const evRenTgt = db.prepare('SELECT COUNT(*) as c FROM evidence WHERE attempt_id = ?').get(attRenTgt.id) as { c: number }
          expect(evRenTgt.c).toBe(0)
          const outboxRenTgt = db.prepare("SELECT status, last_error FROM outbox WHERE idempotency_key = ?").get(`evidence.commit:${attRenTgt.id}`) as { status: string; last_error: string | null }
          expect(outboxRenTgt.status).toBe('done')
          expect(outboxRenTgt.last_error).toBe('scope-violation: escaped-outside.txt')
          expect(git(repoDir, 'rev-parse', `factory/task/${taskRenTgtId}`)).toBe(baseSha)

          // 3. Check Delete Outside
          const taskDel = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskDeleteId) as { status: string }
          expect(taskDel.status).toBe('failed')
          const attDel = db.prepare('SELECT id, status, error_class FROM attempts WHERE task_id = ?').get(taskDeleteId) as { id: string; status: string; error_class: string }
          expect(attDel.status).toBe('failed')
          expect(attDel.error_class).toBe('scope-violation')
          const evDel = db.prepare('SELECT COUNT(*) as c FROM evidence WHERE attempt_id = ?').get(attDel.id) as { c: number }
          expect(evDel.c).toBe(0)
          const outboxDel = db.prepare("SELECT status, last_error FROM outbox WHERE idempotency_key = ?").get(`evidence.commit:${attDel.id}`) as { status: string; last_error: string | null }
          expect(outboxDel.status).toBe('done')
          expect(outboxDel.last_error).toBe('scope-violation: tracked-outside.txt')
          expect(git(repoDir, 'rev-parse', `factory/task/${taskDeleteId}`)).toBe(baseSha)

          // 4. Check Write Inside commits normally
          const taskIn = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskInsideId) as { status: string }
          expect(taskIn.status).toBe('done')
          const attIn = db.prepare('SELECT id, status, error_class FROM attempts WHERE task_id = ?').get(taskInsideId) as { id: string; status: string; error_class: string | null }
          expect(attIn.status).toBe('succeeded')
          expect(attIn.error_class).toBeNull()
          const evIn = db.prepare('SELECT head_sha FROM evidence WHERE attempt_id = ?').get(attIn.id) as { head_sha: string } | undefined
          expect(evIn).toBeDefined()
          const branchSha = git(repoDir, 'rev-parse', `factory/task/${taskInsideId}`)
          expect(branchSha).not.toBe(baseSha)
          expect(branchSha).toBe(evIn!.head_sha)
          const commitMsg = git(repoDir, 'log', '-1', '--format=%B', branchSha)
          expect(commitMsg).toContain(`Factory-Attempt: ${attIn.id}`)
          const outboxIn = db.prepare("SELECT status, last_error FROM outbox WHERE idempotency_key = ?").get(`evidence.commit:${attIn.id}`) as { status: string; last_error: string | null }
          expect(outboxIn.status).toBe('done')
          expect(outboxIn.last_error).toBeNull()
        } finally {
          db.close()
        }
      } finally {
        collectNoncesFromDatabases()
      }
    },
    120000,
  )
})
