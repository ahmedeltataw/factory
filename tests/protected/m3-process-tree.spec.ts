// M3-04 test interface:
//   spawnWorker({ runDir, cwd, taskId, attemptId, env? }) => { pid: number, nonce: string }
//     (from supervisor/src/app/process-tree.ts; generates nonce, writes stdout/stderr to <runDir>/stdout.log and stderr.log)
//   killTree(pid: number, nonce: string, options?: { killCommand?: { file: string, args: string[] } }) =>
//     Promise<{ result: 'killed' | 'not-running' | 'identity-mismatch' | 'kill-failed', detail?: string }>
//
// Executor contract (supervisor/src/executors/fake-executor.ts):
//   - Positional argv: process.argv[2] = taskId, process.argv[3] = nonce, process.argv[4] = runDir.
//   - Writes <runDir>/worker.json: { pid: number, nonce: string, grandchildPid: number }.
//   - Spawns grandchild with 'factory-grandchild-<nonce>' in argv.
//   - Writes deterministic <cwd>/factory-fake/<taskId>.txt.
//   - Respects FAKE_SLEEP_MS and FAKE_EXIT_CODE.
//
// Implementer contract for killTree:
//   - Verifies process command line contains the expected nonce (Windows CIM Win32_Process.CommandLine, Linux /proc/<pid>/cmdline).
//   - If target process is not running -> { result: 'not-running' }.
//   - If process is running but command line lacks nonce -> { result: 'identity-mismatch' } (target NOT killed).
//   - Terminates process tree via taskkill /T /F (Windows) or SIGKILL to process group (POSIX), or options.killCommand if provided.
//   - If kill fails or processes remain alive after bounded wait -> { result: 'kill-failed', detail: string }.
//   - Never returns 'killed' without verifying the process tree is gone.

import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { killTree, spawnWorker } from '../../supervisor/src/app/process-tree.ts'

interface KillTreeResult {
  result: 'killed' | 'not-running' | 'identity-mismatch' | 'kill-failed'
  detail?: string
}

const tempDirs: string[] = []
const activeNonces = new Set<string>()

interface RegisteredRun {
  runDir: string
  nonce: string
}
const registeredRuns: RegisteredRun[] = []

function registerRun(runDir: string, nonce: string): void {
  registeredRuns.push({ runDir, nonce })
}

interface TrackedProcess {
  pid: number
  nonce: string
}
const trackedProcesses: TrackedProcess[] = []

function createFixtureDir(prefix = 'factory-m3-process-tree-'): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}${randomUUID().slice(0, 8)}-`))
  tempDirs.push(dir)
  return dir
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

function trackProcess(pid: number, nonce: string): void {
  if (pid > 0 && pid !== process.pid && nonce) {
    if (!trackedProcesses.some((item) => item.pid === pid && item.nonce === nonce)) {
      trackedProcesses.push({ pid, nonce })
    }
  }
}

function untrackDeadProcesses(): void {
  for (let i = trackedProcesses.length - 1; i >= 0; i--) {
    const item = trackedProcesses[i]
    if (!item) continue
    if (!isProcessAlive(item.pid)) {
      trackedProcesses.splice(i, 1)
    }
  }
}

/**
 * Batched enumeration: finds all live PIDs whose command line contains ANY of the given nonces.
 * Excludes both the PowerShell lookup process ($PID) and the test runner PID (process.pid).
 * Throws on lookup failures rather than silently returning an empty list.
 */
function findPidsByNonces(nonces: string[]): number[] {
  const validNonces = nonces.filter((n) => typeof n === 'string' && n.trim().length > 0)
  if (validNonces.length === 0) return []

  if (process.platform === 'win32') {
    const escapedNonces = validNonces.map((n) => `'*${n.replace(/'/g, "''")}*'`).join(',')
    const runnerPid = process.pid
    const script = [
      `$n = @(${escapedNonces});`,
      `Get-CimInstance Win32_Process | Where-Object {`,
      `  if ($_.ProcessId -eq $PID -or $_.ProcessId -eq ${runnerPid}) { return $false };`,
      `  $c = $_.CommandLine;`,
      `  if (-not $c) { return $false };`,
      `  foreach ($p in $n) { if ($c -like $p) { return $true } };`,
      `  return $false`,
      `} | ForEach-Object { $_.ProcessId }`,
    ].join(' ')

    const run = () => spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    })
    let res = run()
    if ((res.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') res = run()

    if (res.error) {
      throw new Error(`Process enumeration failed: ${res.error.message}`)
    }
    if (res.status !== 0) {
      throw new Error(
        `Process enumeration command failed with exit code ${res.status}: ${res.stderr || res.stdout}`,
      )
    }

    const pids: number[] = []
    if (res.stdout) {
      for (const line of res.stdout.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (/^\d+$/.test(trimmed)) {
          const pid = Number(trimmed)
          if (pid > 0 && pid !== process.pid) {
            pids.push(pid)
          }
        }
      }
    }
    return Array.from(new Set(pids))
  } else {
    const pids: number[] = []
    if (existsSync('/proc')) {
      const entries = readdirSync('/proc')
      for (const entry of entries) {
        if (/^\d+$/.test(entry)) {
          const pid = Number(entry)
          if (pid === process.pid) continue
          try {
            const cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8')
            for (const n of validNonces) {
              if (cmdline.includes(n)) {
                pids.push(pid)
                break
              }
            }
          } catch {
            // Process may have exited or access denied; continue
          }
        }
      }
    } else {
      const ps = spawnSync('ps', ['-eo', 'pid,command'], {
        encoding: 'utf8',
        timeout: 10000,
      })
      if (ps.error) {
        throw new Error(`ps command failed: ${ps.error.message}`)
      }
      if (ps.status !== 0) {
        throw new Error(`ps command failed with status ${ps.status}: ${ps.stderr || ps.stdout}`)
      }
      if (ps.stdout) {
        for (const line of ps.stdout.split('\n')) {
          for (const n of validNonces) {
            if (line.includes(n)) {
              const match = line.trim().match(/^(\d+)/)
              if (match) {
                const pid = Number(match[1])
                if (pid > 0 && pid !== process.pid) {
                  pids.push(pid)
                  break
                }
              }
            }
          }
        }
      }
    }
    return Array.from(new Set(pids))
  }
}

function findPidsByNonce(nonce: string): number[] {
  return findPidsByNonces([nonce])
}

/**
 * Independent identity-checked cleanup:
 * 1. Recovers descendant identities from registered run directories (worker.json).
 * 2. Repeatedly enumerates live matching PIDs using batched CIM/proc lookup and kills them.
 * 3. Asserts termination: confirms survivors reached zero before clearing tracking records.
 */
async function cleanupNonces(
  nonces: Iterable<string>,
  timeoutMs = 25000,
): Promise<void> {
  const nonceList = Array.from(
    new Set(Array.from(nonces).filter((n) => typeof n === 'string' && n.length > 0)),
  )
  if (nonceList.length === 0) return

  // 1. Recover known descendant identities from registered run directories
  for (const reg of registeredRuns) {
    if (nonceList.includes(reg.nonce)) {
      const workerPath = join(reg.runDir, 'worker.json')
      if (existsSync(workerPath)) {
        try {
          const raw = readFileSync(workerPath, 'utf8')
          const data = JSON.parse(raw) as WorkerJson
          if (data && typeof data.pid === 'number') {
            trackProcess(data.pid, data.nonce || reg.nonce)
          }
          if (data && typeof data.grandchildPid === 'number') {
            trackProcess(data.grandchildPid, data.nonce || reg.nonce)
          }
        } catch {
          // ignore read error
        }
      }
    }
  }

  // 2. Repeatedly enumerate and identity-check survivors before killing them
  const deadline = Date.now() + timeoutMs
  let survivors: number[] = []

  while (Date.now() < deadline) {
    survivors = findPidsByNonces(nonceList)
    if (survivors.length === 0) {
      break
    }

    for (const pid of survivors) {
      if (pid === process.pid) continue
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/F', '/PID', String(pid)], {
            timeout: 10000,
            stdio: 'ignore',
            windowsHide: true,
          })
        } else {
          process.kill(pid, 'SIGKILL')
        }
      } catch {
        // ignore individual kill failure
      }
    }

    await delay(150)
  }

  // 3. Final verification: assert zero survivors remain
  survivors = findPidsByNonces(nonceList)
  if (survivors.length > 0) {
    throw new Error(
      `Cleanup failed to terminate all matching processes for nonces [${nonceList.join(', ')}]. Surviving PIDs: ${survivors.join(', ')}`,
    )
  }

  // 4. Discard confirmed dead records
  untrackDeadProcesses()
  for (const n of nonceList) {
    activeNonces.delete(n)
  }
}

async function waitForProcessDeath(pid: number, timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true
    }
    await delay(50)
  }
  return !isProcessAlive(pid)
}

async function waitForFileContent(
  filePath: string,
  expected: string,
  timeoutMs = 15000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf8')
        if (content.includes(expected)) {
          return
        }
      } catch {
        // file write may be in progress
      }
    }
    await delay(50)
  }
  throw new Error(`File ${filePath} did not contain "${expected}" within ${timeoutMs}ms`)
}

interface WorkerJson {
  pid: number
  nonce: string
  grandchildPid?: number
}

async function waitForWorkerJson(
  runDir: string,
  timeoutMs = 20000,
): Promise<{ pid: number; nonce: string; grandchildPid: number }> {
  const workerPath = join(runDir, 'worker.json')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(workerPath)) {
      try {
        const raw = readFileSync(workerPath, 'utf8')
        const data = JSON.parse(raw) as WorkerJson
        if (
          data &&
          typeof data.pid === 'number' &&
          typeof data.nonce === 'string' &&
          typeof data.grandchildPid === 'number'
        ) {
          return {
            pid: data.pid,
            nonce: data.nonce,
            grandchildPid: data.grandchildPid,
          }
        }
      } catch {
        // file write may be in progress; retry
      }
    }
    await delay(25)
  }
  throw new Error(`worker.json with grandchildPid did not appear in ${runDir} within ${timeoutMs}ms`)
}

afterEach(async () => {
  try {
    await cleanupNonces(activeNonces, 25000)
  } finally {
    activeNonces.clear()
    trackedProcesses.length = 0
    registeredRuns.length = 0

    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  }
}, 60000)

describe('M3-04 process tree and kill contract', () => {
  it(
    'CHK-M3-04-a: spawnWorker starts executor with redirected output and returns pid and nonce',
    async () => {
      const root = createFixtureDir('m3-04-a-')
      const cwd = join(root, 'cwd')
      const runDir = join(root, 'run')
      mkdirSync(cwd, { recursive: true })
      mkdirSync(runDir, { recursive: true })

      // Write a small helper script loaded via NODE_OPTIONS to emit distinguishable output
      const loggerPath = join(root, 'preload-logger.mjs')
      writeFileSync(
        loggerPath,
        `process.stdout.write('DISTINGUISHABLE_STDOUT_LINE_A\\n');\n` +
          `process.stderr.write('DISTINGUISHABLE_STDERR_LINE_B\\n');\n`,
        'utf8',
      )

      const taskId = 'task-a-1'
      const attemptId = 'attempt-a-1'
      const spawned = await spawnWorker({
        runDir,
        cwd,
        taskId,
        attemptId,
        env: {
          ...process.env,
          NODE_OPTIONS: `--import "${pathToFileURL(loggerPath).href}"`,
          FAKE_SLEEP_MS: '60000',
        },
      })

      // Immediately register nonce and track spawned PID
      activeNonces.add(spawned.nonce)
      registerRun(runDir, spawned.nonce)
      trackProcess(spawned.pid, spawned.nonce)

      try {
        expect(spawned.pid).toBeGreaterThan(0)
        expect(typeof spawned.nonce).toBe('string')
        expect(spawned.nonce.length).toBeGreaterThan(0)
        expect(isProcessAlive(spawned.pid)).toBe(true)

        // Verify stdout and stderr log files exist with distinguishable, unmerged streams
        const stdoutPath = join(runDir, 'stdout.log')
        const stderrPath = join(runDir, 'stderr.log')
        expect(existsSync(stdoutPath)).toBe(true)
        expect(existsSync(stderrPath)).toBe(true)

        await waitForFileContent(stdoutPath, 'DISTINGUISHABLE_STDOUT_LINE_A', 15000)
        await waitForFileContent(stderrPath, 'DISTINGUISHABLE_STDERR_LINE_B', 15000)

        const stdoutContent = readFileSync(stdoutPath, 'utf8')
        const stderrContent = readFileSync(stderrPath, 'utf8')

        expect(stdoutContent).toContain('DISTINGUISHABLE_STDOUT_LINE_A')
        expect(stdoutContent).not.toContain('DISTINGUISHABLE_STDERR_LINE_B')
        expect(stderrContent).toContain('DISTINGUISHABLE_STDERR_LINE_B')
        expect(stderrContent).not.toContain('DISTINGUISHABLE_STDOUT_LINE_A')

        // Wait for worker.json containing grandchildPid
        const worker = await waitForWorkerJson(runDir, 20000)
        expect(worker.pid).toBe(spawned.pid)
        expect(worker.nonce).toBe(spawned.nonce)
        expect(worker.grandchildPid).toBeGreaterThan(0)
        expect(worker.grandchildPid).not.toBe(spawned.pid)

        trackProcess(worker.grandchildPid, spawned.nonce)
        expect(isProcessAlive(worker.grandchildPid)).toBe(true)

        // Poll boundedly for deterministic fake executor output file in cwd
        const fakeFile = join(cwd, 'factory-fake', `${taskId}.txt`)
        await waitForFileContent(fakeFile, `factory-fake:${taskId}\n`, 15000)
        expect(readFileSync(fakeFile, 'utf8')).toBe(`factory-fake:${taskId}\n`)

        // Assert POSIX process group ownership
        if (process.platform !== 'win32') {
          const ps = spawnSync('ps', ['-o', 'pgid=', '-p', String(spawned.pid)], {
            encoding: 'utf8',
            timeout: 10000,
          })
          if (ps.status === 0 && ps.stdout) {
            const pgid = Number(ps.stdout.trim())
            expect(pgid).toBe(spawned.pid)
          }
        }
      } finally {
        await cleanupNonces([spawned.nonce])
      }
    },
    90000,
  )

  it(
    'CHK-M3-04-b: killTree verifies nonce and terminates both executor and grandchild processes',
    async () => {
      const root = createFixtureDir('m3-04-b-')
      const cwd = join(root, 'cwd')
      const runDir = join(root, 'run')
      mkdirSync(cwd, { recursive: true })
      mkdirSync(runDir, { recursive: true })

      // Part 1: Tree with a stubborn descendant that does NOT exit on parent death
      const stubbornScriptPath = join(root, 'stubborn-parent.mjs')
      const stubbornPidFile = join(root, 'stubborn-child.pid')
      const stubbornReadyFile = join(root, 'stubborn-ready.txt')

      writeFileSync(
        stubbornScriptPath,
        `import { spawn } from 'node:child_process';\n` +
          `import { writeFileSync } from 'node:fs';\n` +
          `const nonce = process.argv[2];\n` +
          `const pidFile = process.argv[3];\n` +
          `const readyFile = process.argv[4];\n` +
          `// Stubborn child: sleeps and explicitly does NOT monitor parent death\n` +
          `const childScript = 'setInterval(() => {}, 1000);';\n` +
          `const child = spawn(process.execPath, ['-e', childScript, nonce], {\n` +
          `  stdio: 'ignore',\n` +
          `  windowsHide: true,\n` +
          `});\n` +
          `writeFileSync(pidFile, String(child.pid), 'utf8');\n` +
          `writeFileSync(readyFile, 'ready', 'utf8');\n` +
          `setInterval(() => {}, 1000);\n`,
        'utf8',
      )

      const stubbornNonce = `stubborn-tree-nonce-${randomUUID()}`
      activeNonces.add(stubbornNonce)

      const stubbornParent = spawn(
        process.execPath,
        [stubbornScriptPath, stubbornNonce, stubbornPidFile, stubbornReadyFile],
        {
          stdio: 'ignore',
          windowsHide: true,
          detached: process.platform !== 'win32',
        },
      )
      const parentPid = stubbornParent.pid!
      trackProcess(parentPid, stubbornNonce)

      await waitForFileContent(stubbornReadyFile, 'ready', 15000)
      const stubbornChildPid = Number(readFileSync(stubbornPidFile, 'utf8').trim())
      expect(stubbornChildPid).toBeGreaterThan(0)
      trackProcess(stubbornChildPid, stubbornNonce)

      expect(isProcessAlive(parentPid)).toBe(true)
      expect(isProcessAlive(stubbornChildPid)).toBe(true)

      // killTree must terminate both parent and stubborn descendant before returning 'killed'
      const stubbornKillRes = (await killTree(parentPid, stubbornNonce)) as KillTreeResult
      expect(stubbornKillRes.result).toBe('killed')

      // Assert immediate termination without further delay
      expect(isProcessAlive(parentPid)).toBe(false)
      expect(isProcessAlive(stubbornChildPid)).toBe(false)

      // Part 2: Real worker spawned via spawnWorker
      const taskId = 'task-b-1'
      const attemptId = 'attempt-b-1'
      const spawned = await spawnWorker({
        runDir,
        cwd,
        taskId,
        attemptId,
        env: {
          ...process.env,
          FAKE_SLEEP_MS: '60000',
        },
      })
      activeNonces.add(spawned.nonce)
      registerRun(runDir, spawned.nonce)
      trackProcess(spawned.pid, spawned.nonce)

      const worker = await waitForWorkerJson(runDir, 20000)
      trackProcess(worker.grandchildPid, spawned.nonce)

      expect(isProcessAlive(worker.pid)).toBe(true)
      expect(isProcessAlive(worker.grandchildPid)).toBe(true)

      const killResult = (await killTree(worker.pid, worker.nonce)) as KillTreeResult
      expect(killResult.result).toBe('killed')

      // Independent verification that both processes are dead
      const executorGone = await waitForProcessDeath(worker.pid, 20000)
      const grandchildGone = await waitForProcessDeath(worker.grandchildPid, 20000)

      expect(executorGone).toBe(true)
      expect(grandchildGone).toBe(true)
      expect(isProcessAlive(worker.pid)).toBe(false)
      expect(isProcessAlive(worker.grandchildPid)).toBe(false)
    },
    90000,
  )

  it(
    'CHK-M3-04-c: returns identity-mismatch for live pid without nonce and not-running for dead pid without throwing',
    async () => {
      // 1. Identity mismatch on test runner's own PID (must assert it is still alive)
      const runnerPid = process.pid
      expect(isProcessAlive(runnerPid)).toBe(true)

      const runnerNonce = `non-matching-nonce-${randomUUID()}`
      const runnerRes = (await killTree(runnerPid, runnerNonce)) as KillTreeResult

      expect(runnerRes.result).toBe('identity-mismatch')
      expect(isProcessAlive(runnerPid)).toBe(true)

      // 2. Identity mismatch on a live worker process with wrong nonce
      const root = createFixtureDir('m3-04-c-')
      const cwd = join(root, 'cwd')
      const runDir = join(root, 'run')
      mkdirSync(cwd, { recursive: true })
      mkdirSync(runDir, { recursive: true })

      const spawned = await spawnWorker({
        runDir,
        cwd,
        taskId: 'task-c-1',
        attemptId: 'attempt-c-1',
        env: {
          ...process.env,
          FAKE_SLEEP_MS: '60000',
        },
      })
      activeNonces.add(spawned.nonce)
      registerRun(runDir, spawned.nonce)
      trackProcess(spawned.pid, spawned.nonce)

      const worker = await waitForWorkerJson(runDir, 20000)
      trackProcess(worker.grandchildPid, spawned.nonce)

      try {
        const mismatchRes = (await killTree(
          worker.pid,
          `wrong-nonce-${randomUUID()}`,
        )) as KillTreeResult
        expect(mismatchRes.result).toBe('identity-mismatch')
        expect(isProcessAlive(worker.pid)).toBe(true)
        expect(isProcessAlive(worker.grandchildPid)).toBe(true)
      } finally {
        await cleanupNonces([spawned.nonce])
      }

      // 3. Not-running for a dead PID
      const deadChild = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
        timeout: 10000,
      })
      const deadPid = deadChild.pid!
      expect(isProcessAlive(deadPid)).toBe(false)

      const notRunningRes = (await killTree(deadPid, 'any-nonce-for-dead-pid')) as KillTreeResult
      expect(notRunningRes.result).toBe('not-running')
    },
    90000,
  )

  it(
    'CHK-M3-04-d: returns kill-failed with detail if kill command fails or process remains alive',
    async () => {
      const root = createFixtureDir('m3-04-d-')
      const cwd = join(root, 'cwd')
      const runDir = join(root, 'run')
      mkdirSync(cwd, { recursive: true })
      mkdirSync(runDir, { recursive: true })

      // Case 1: Kill command fails to execute (invalid binary name)
      const spawned1 = await spawnWorker({
        runDir,
        cwd,
        taskId: 'task-d-1',
        attemptId: 'attempt-d-1',
        env: {
          ...process.env,
          FAKE_SLEEP_MS: '60000',
        },
      })
      activeNonces.add(spawned1.nonce)
      registerRun(runDir, spawned1.nonce)
      trackProcess(spawned1.pid, spawned1.nonce)

      const worker1 = await waitForWorkerJson(runDir, 20000)
      trackProcess(worker1.grandchildPid, spawned1.nonce)

      try {
        const failRes1 = (await killTree(worker1.pid, worker1.nonce, {
          killCommand: {
            file: 'invalid-nonexistent-kill-cmd-xyz',
            args: ['--force'],
          },
        })) as KillTreeResult
        expect(failRes1.result).toBe('kill-failed')
        expect(typeof failRes1.detail).toBe('string')
        expect(failRes1.detail!.length).toBeGreaterThan(0)
        expect(failRes1.result).not.toBe('killed')
        expect(isProcessAlive(worker1.pid)).toBe(true)
      } finally {
        await cleanupNonces([spawned1.nonce])
      }

      // Case 2: Kill command runs and exits 0 (observable via marker file), but process survives
      const cwd2 = join(root, 'cwd2')
      const runDir2 = join(root, 'run2')
      mkdirSync(cwd2, { recursive: true })
      mkdirSync(runDir2, { recursive: true })

      const noopHelperPath = join(root, 'noop-kill-helper.mjs')
      const noopMarkerPath = join(runDir2, 'noop-kill-marker.txt')

      writeFileSync(
        noopHelperPath,
        `import { writeFileSync } from 'node:fs';\n` +
          `const markerPath = process.argv[2];\n` +
          `if (markerPath) {\n` +
          `  writeFileSync(markerPath, 'NOOP_KILL_EXECUTED\\n', 'utf8');\n` +
          `}\n` +
          `process.exit(0);\n`,
        'utf8',
      )

      const spawned2 = await spawnWorker({
        runDir: runDir2,
        cwd: cwd2,
        taskId: 'task-d-2',
        attemptId: 'attempt-d-2',
        env: {
          ...process.env,
          FAKE_SLEEP_MS: '60000',
        },
      })
      activeNonces.add(spawned2.nonce)
      registerRun(runDir2, spawned2.nonce)
      trackProcess(spawned2.pid, spawned2.nonce)

      const worker2 = await waitForWorkerJson(runDir2, 20000)
      trackProcess(worker2.grandchildPid, spawned2.nonce)

      try {
        expect(existsSync(noopMarkerPath)).toBe(false)

        const failRes2 = (await killTree(worker2.pid, worker2.nonce, {
          killCommand: {
            file: process.execPath,
            args: [noopHelperPath, noopMarkerPath],
          },
        })) as KillTreeResult

        // Verify that the no-op command executed successfully
        expect(existsSync(noopMarkerPath)).toBe(true)
        expect(readFileSync(noopMarkerPath, 'utf8')).toBe('NOOP_KILL_EXECUTED\n')

        // Verify that killTree detected the target was still alive and returned kill-failed
        expect(failRes2.result).toBe('kill-failed')
        expect(typeof failRes2.detail).toBe('string')
        expect(failRes2.detail!.length).toBeGreaterThan(0)
        expect(failRes2.result).not.toBe('killed')
        expect(isProcessAlive(worker2.pid)).toBe(true)
      } finally {
        await cleanupNonces([spawned2.nonce])
      }
    },
    90000,
  )

  it(
    'CHK-M3-04-e: 20 x spawn -> kill leaves no fake-executor processes counted by nonce',
    async () => {
      const nonces: string[] = []

      try {
        for (let i = 0; i < 20; i++) {
          const root = createFixtureDir(`m3-04-e-${i}-`)
          const cwd = join(root, 'cwd')
          const runDir = join(root, 'run')
          mkdirSync(cwd, { recursive: true })
          mkdirSync(runDir, { recursive: true })

          const taskId = `task-iter-${i}`
          const attemptId = `attempt-iter-${i}`
          const spawned = await spawnWorker({
            runDir,
            cwd,
            taskId,
            attemptId,
            env: {
              ...process.env,
              FAKE_SLEEP_MS: '60000',
            },
          })

          nonces.push(spawned.nonce)
          activeNonces.add(spawned.nonce)
          registerRun(runDir, spawned.nonce)
          trackProcess(spawned.pid, spawned.nonce)

          const worker = await waitForWorkerJson(runDir, 20000)
          trackProcess(worker.grandchildPid, spawned.nonce)

          const killResult = (await killTree(spawned.pid, spawned.nonce)) as KillTreeResult
          expect(killResult.result).toBe('killed')

          const execGone = await waitForProcessDeath(spawned.pid, 20000)
          const grandGone = await waitForProcessDeath(worker.grandchildPid, 20000)
          expect(execGone).toBe(true)
          expect(grandGone).toBe(true)
        }

        expect(nonces).toHaveLength(20)

        // Batched CIM query: enumerate matching command lines for all 20 nonces at once
        const survivors = findPidsByNonces(nonces)
        expect(survivors).toHaveLength(0)
      } finally {
        await cleanupNonces(nonces, 30000)
      }
    },
    180000,
  )
})
