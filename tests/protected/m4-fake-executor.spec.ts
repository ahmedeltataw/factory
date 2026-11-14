import { isProcessAliveWithNonce as alive } from '../helpers/process-identity.ts'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { killTree } from '../../supervisor/src/app/process-tree.ts'

const executor = fileURLToPath(new URL('../../supervisor/src/executors/fake-executor.ts', import.meta.url))
const task = 'task-1'
type Worker = { pid: number; nonce: string; grandchildPid: number }
type Fixture = { root: string; cwd: string; run: string; nonce: string; child: ChildProcess; exit: Promise<number | null> }

function start(env: Record<string, string> = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'factory-m4-04-'))
  const cwd = join(root, 'cwd'), run = join(root, 'run'), nonce = randomUUID()
  mkdirSync(cwd); mkdirSync(run)
  const cleanEnv = { ...process.env }
  for (const key of ['FACTORY_ATTEMPT_NO', 'FAKE_FAIL_UNTIL_ATTEMPT', 'FAKE_FAIL_CODE', 'FAKE_HANG', 'FAKE_NO_WATCHDOG', 'FAKE_WRITE', 'FAKE_SLEEP_MS', 'FAKE_EXIT_CODE']) delete cleanEnv[key]
  const child = spawn(process.execPath, [executor, task, nonce, run], {
    cwd, env: { ...cleanEnv, ...env }, detached: true, windowsHide: true,
    stdio: 'ignore',
  })
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  return { root, cwd, run, nonce, child, exit }
}

async function waitForExit(f: Fixture): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      f.exit,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Executor exit timed out')), 15000) }),
    ])
  } finally { if (timer) clearTimeout(timer) }
}

async function cleanup(f: Fixture): Promise<void> {
  try {
    if (f.child.pid && f.child.exitCode === null && f.child.signalCode === null) {
      const killed = await killTree(f.child.pid, f.nonce)
      if (killed.result !== 'killed' && killed.result !== 'not-running') throw new Error(`Identity-checked cleanup failed: ${killed.result} ${killed.detail ?? ''}`)
    }
    const workerPath = join(f.run, 'worker.json')
    if (existsSync(workerPath)) {
      const w = JSON.parse(readFileSync(workerPath, 'utf8')) as Worker
      if (w.pid === f.child.pid && w.nonce === f.nonce && Number.isSafeInteger(w.grandchildPid) && w.grandchildPid > 0 && alive(w.grandchildPid, `factory-grandchild-${f.nonce}`)) {
        const killed = await killTree(w.grandchildPid, f.nonce)
        if (killed.result !== 'killed' && killed.result !== 'not-running') throw new Error(`Identity-checked grandchild cleanup failed: ${killed.result} ${killed.detail ?? ''}`)
      }
      if (w.pid === f.child.pid && w.nonce === f.nonce && Number.isSafeInteger(w.grandchildPid) && w.grandchildPid > 0) expect(alive(w.grandchildPid, `factory-grandchild-${f.nonce}`)).toBe(false)
    }
    await waitForExit(f)
  } finally {
    try {
      if (f.child.exitCode === null && f.child.signalCode === null) f.child.kill()
      await waitForExit(f)
    } finally {
      rmSync(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }
}

async function run(env: Record<string, string>, check: (f: Fixture, code: number | null) => void): Promise<void> {
  const f = start(env)
  try { check(f, await waitForExit(f)) } finally { await cleanup(f) }
}
function result(f: Fixture): unknown { return JSON.parse(readFileSync(join(f.run, 'result.json'), 'utf8')) }
function output(f: Fixture): string { return join(f.cwd, 'factory-fake', `${task}.txt`) }

async function worker(f: Fixture): Promise<Worker> {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    try {
      const data = JSON.parse(readFileSync(join(f.run, 'worker.json'), 'utf8')) as Worker
      if (data.pid === f.child.pid && data.nonce === f.nonce && data.grandchildPid > 0) return data
    } catch { /* worker may be absent or mid-write */ }
    if (f.child.exitCode !== null || f.child.signalCode !== null) break
    await delay(25)
  }
  throw new Error('worker.json with grandchild did not appear before exit or timeout')
}

it('CHK-M4-04-a: fails through attempt two and succeeds on three, with configurable failure code', async () => {
  for (const attempt of [1, 2]) await run({ FACTORY_ATTEMPT_NO: String(attempt), FAKE_FAIL_UNTIL_ATTEMPT: '2' }, (f, code) => {
    expect(code).toBe(75); expect(result(f)).toEqual({ exitCode: 75 }); expect(existsSync(output(f))).toBe(false)
  })
  await run({ FACTORY_ATTEMPT_NO: '3', FAKE_FAIL_UNTIL_ATTEMPT: '2' }, (f, code) => {
    expect(code).toBe(0); expect(result(f)).toEqual({ exitCode: 0 }); expect(existsSync(output(f))).toBe(true)
  })
  await run({ FAKE_FAIL_UNTIL_ATTEMPT: '1', FAKE_FAIL_CODE: '9' }, (f, code) => {
    expect(code).toBe(9); expect(result(f)).toEqual({ exitCode: 9 }); expect(existsSync(output(f))).toBe(false)
  })
}, 60000)

it('CHK-M4-04-b: hang keeps both processes alive beyond three seconds until tree kill', async () => {
  const f = start({ FAKE_HANG: '1', FAKE_NO_WATCHDOG: '1', FAKE_FAIL_UNTIL_ATTEMPT: '2', FAKE_EXIT_CODE: '9' })
  try {
    const w = await worker(f)
    await delay(3100)
    expect(alive(w.pid, f.nonce)).toBe(true); expect(alive(w.grandchildPid, `factory-grandchild-${f.nonce}`)).toBe(true)
    expect(existsSync(join(f.run, 'result.json'))).toBe(false)
    const killed = await killTree(w.pid, f.nonce)
    expect(killed).toEqual({ result: 'killed' })
    await waitForExit(f)
    const deadline = Date.now() + 5000
    let workerAlive = true, grandchildAlive = true
    while (Date.now() < deadline) {
      workerAlive = alive(w.pid, f.nonce, { deadlineMs: deadline })
      grandchildAlive = alive(w.grandchildPid, `factory-grandchild-${f.nonce}`, { deadlineMs: deadline })
      if (!workerAlive && !grandchildAlive) break
      await delay(Math.min(50, Math.max(0, deadline - Date.now())))
    }
    expect(workerAlive).toBe(false); expect(grandchildAlive).toBe(false)
  } finally { await cleanup(f) }
}, 40000)

it('CHK-M5-QA1-a: grandchild survives executor-only kill with watchdog disabled', async () => {
  const f = start({ FAKE_HANG: '1', FAKE_NO_WATCHDOG: '1' })
  try {
    const w = await worker(f)
    expect(f.child.kill('SIGKILL')).toBe(true)
    await waitForExit(f)
    await delay(1000)
    expect(alive(w.grandchildPid, `factory-grandchild-${f.nonce}`)).toBe(true)
  } finally { await cleanup(f) }
}, 40000)

it('CHK-M4-04-c: writes deterministic files and rejects traversal, absolute and junction escapes atomically', async () => {
  let contents: string[] = []
  for (let i = 0; i < 2; i++) await run({ FAKE_WRITE: 'a/b.txt,c.txt' }, (f, code) => {
    expect(code).toBe(0); expect(existsSync(output(f))).toBe(true); expect(result(f)).toEqual({ exitCode: 0 })
    const current = ['a/b.txt', 'c.txt'].map(p => readFileSync(join(f.cwd, p), 'utf8'))
    expect(current.every(s => s.length > 0)).toBe(true)
    if (i) expect(current).toEqual(contents); else contents = current
  })
  for (const kind of ['traversal', 'absolute', 'junction']) {
    const f = startPrepared(kind)
    try {
      expect(await waitForExit(f)).toBe(2)
      expect(existsSync(join(f.cwd, 'safe.txt'))).toBe(false)
      expect(existsSync(join(f.root, 'outside', 'escape.txt'))).toBe(false)
      expect(existsSync(output(f))).toBe(false)
      expect(existsSync(join(f.run, 'result.json'))).toBe(false)
      expect(existsSync(join(f.run, 'worker.json'))).toBe(false)
    } finally { await cleanup(f) }
  }
}, 60000)

function startPrepared(kind: string): Fixture {
  // Set up the link before spawning, in a separate parent fixture directory.
  const root = mkdtempSync(join(tmpdir(), 'factory-m4-link-'))
  const cwd = join(root, 'cwd'), outside = join(root, 'outside'), runDir = join(root, 'run')
  mkdirSync(cwd); mkdirSync(outside); mkdirSync(runDir)
  if (kind === 'junction') symlinkSync(outside, join(cwd, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  const path = kind === 'traversal' ? '../outside/escape.txt' : kind === 'absolute' ? join(outside, 'escape.txt') : 'link/escape.txt'
  const nonce = randomUUID(), cleanEnv = { ...process.env }
  for (const key of ['FACTORY_ATTEMPT_NO', 'FAKE_FAIL_UNTIL_ATTEMPT', 'FAKE_FAIL_CODE', 'FAKE_HANG', 'FAKE_NO_WATCHDOG', 'FAKE_WRITE', 'FAKE_SLEEP_MS', 'FAKE_EXIT_CODE']) delete cleanEnv[key]
  const child = spawn(process.execPath, [executor, task, nonce, runDir], { cwd, env: { ...cleanEnv, FAKE_WRITE: `safe.txt,${path}` }, detached: true, windowsHide: true, stdio: 'ignore' })
  const exit = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  return { root, cwd, run: runDir, nonce, child, exit }
}

it('CHK-M4-04-d: fail takes precedence over exit code and invalid numbers are rejected', async () => {
  await run({ FAKE_FAIL_UNTIL_ATTEMPT: '2', FAKE_EXIT_CODE: '7' }, (f, code) => {
    expect(code).toBe(75); expect(result(f)).toEqual({ exitCode: 75 }); expect(existsSync(output(f))).toBe(false)
  })
  for (const key of ['FACTORY_ATTEMPT_NO', 'FAKE_FAIL_UNTIL_ATTEMPT', 'FAKE_FAIL_CODE', 'FAKE_SLEEP_MS', 'FAKE_EXIT_CODE']) {
    for (const value of ['not-a-number', '2abc']) await run({ ...(key === 'FAKE_FAIL_CODE' ? { FAKE_FAIL_UNTIL_ATTEMPT: '2' } : {}), [key]: value }, (f, code) => {
      expect(code).toBe(2); expect(existsSync(output(f))).toBe(false); expect(existsSync(join(f.run, 'result.json'))).toBe(false)
    })
  }
}, 60000)

it('CHK-M4-04-d: M3 defaults, sleep, exit code, worker and deterministic output remain intact', async () => {
  let content = ''
  await run({}, (f, code) => {
    expect(code).toBe(0); expect(result(f)).toEqual({ exitCode: 0 })
    const w = JSON.parse(readFileSync(join(f.run, 'worker.json'), 'utf8')) as Worker
    expect(w.pid).toBe(f.child.pid); expect(w.nonce).toBe(f.nonce); expect(w.grandchildPid).toBeGreaterThan(0)
    content = readFileSync(output(f), 'utf8'); expect(content.length).toBeGreaterThan(0)
  })
  const started = Date.now()
  await run({ FAKE_SLEEP_MS: '1200', FAKE_EXIT_CODE: '7' }, (f, code) => {
    expect(code).toBe(7); expect(result(f)).toEqual({ exitCode: 7 })
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000); expect(readFileSync(output(f), 'utf8')).toBe(content)
  })
}, 40000)
