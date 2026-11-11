import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { killTree } from '../supervisor/src/app/process-tree.ts'

const executor = fileURLToPath(new URL('../supervisor/src/executors/fake-executor.ts', import.meta.url))
const task = 'task-m4-04'
type Worker = { pid: number; nonce: string; grandchildPid: number }
type Fixture = { root: string; cwd: string; run: string; nonce: string; child: ChildProcess; exit: Promise<number | null> }

function start(env: Record<string, string> = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'factory-m4-04-unit-'))
  const cwd = join(root, 'cwd'), run = join(root, 'run'), nonce = randomUUID()
  mkdirSync(cwd); mkdirSync(run)
  const cleanEnv = { ...process.env }
  for (const key of ['FACTORY_ATTEMPT_NO', 'FAKE_FAIL_UNTIL_ATTEMPT', 'FAKE_FAIL_CODE', 'FAKE_HANG', 'FAKE_WRITE', 'FAKE_SLEEP_MS', 'FAKE_EXIT_CODE']) {
    delete cleanEnv[key]
  }
  const child = spawn(process.execPath, [executor, task, nonce, run], {
    cwd,
    env: { ...cleanEnv, ...env },
    detached: true,
    windowsHide: true,
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
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function cleanup(f: Fixture): Promise<void> {
  try {
    if (f.child.pid && f.child.exitCode === null && f.child.signalCode === null) {
      await killTree(f.child.pid, f.nonce)
    }
    const workerPath = join(f.run, 'worker.json')
    if (existsSync(workerPath)) {
      try {
        const w = JSON.parse(readFileSync(workerPath, 'utf8')) as Worker
        if (w.pid === f.child.pid && w.nonce === f.nonce && Number.isSafeInteger(w.grandchildPid) && w.grandchildPid > 0 && alive(w.grandchildPid)) {
          await killTree(w.grandchildPid, f.nonce)
        }
      } catch {
        // ignore parse error if worker.json was partial
      }
    }
    await waitForExit(f)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
}

async function run(env: Record<string, string>, check: (f: Fixture, code: number | null) => void): Promise<void> {
  const f = start(env)
  try {
    check(f, await waitForExit(f))
  } finally {
    await cleanup(f)
  }
}

function result(f: Fixture): unknown {
  return JSON.parse(readFileSync(join(f.run, 'result.json'), 'utf8'))
}

function output(f: Fixture): string {
  return join(f.cwd, 'factory-fake', `${task}.txt`)
}

describe('M4-04 unit tests for fake-executor', () => {
  it('rejects invalid numeric inputs with exit 2 and leaves no files', async () => {
    const invalidInputs: Record<string, string>[] = [
      { FAKE_FAIL_UNTIL_ATTEMPT: '-1' },
      { FAKE_FAIL_UNTIL_ATTEMPT: '1.5' },
      { FAKE_FAIL_UNTIL_ATTEMPT: ' 2 ' },
      { FAKE_FAIL_UNTIL_ATTEMPT: '' },
      { FAKE_EXIT_CODE: '-5' },
      { FAKE_EXIT_CODE: '0x10' },
      { FAKE_SLEEP_MS: 'abc' },
      { FACTORY_ATTEMPT_NO: '-3' },
      { FAKE_HANG: 'true' },
      { FAKE_HANG: 'not-a-number' },
      { FAKE_FAIL_CODE: 'nine' },
    ]

    for (const env of invalidInputs) {
      await run(env, (f, code) => {
        expect(code).toBe(2)
        expect(existsSync(output(f))).toBe(false)
        expect(existsSync(join(f.run, 'result.json'))).toBe(false)
        expect(existsSync(join(f.run, 'worker.json'))).toBe(false)
      })
    }
  })

  it('rejects malformed FAKE_WRITE paths before creating any files', async () => {
    const badWrites = [
      '',
      'a.txt,,b.txt',
      ',a.txt',
      'a.txt,',
      'dir/',
      'dir\\',
      'a/../b.txt',
      '..',
      '.',
    ]

    for (const bad of badWrites) {
      await run({ FAKE_WRITE: bad }, (f, code) => {
        expect(code).toBe(2)
        expect(existsSync(output(f))).toBe(false)
        expect(existsSync(join(f.run, 'result.json'))).toBe(false)
        expect(existsSync(join(f.run, 'worker.json'))).toBe(false)
      })
    }
  })

  it('writes deep nested directory paths deterministically and cleans up temp files', async () => {
    await run({ FAKE_WRITE: 'deep/nested/folder/file.txt,second/sub/target.md' }, (f, code) => {
      expect(code).toBe(0)
      expect(result(f)).toEqual({ exitCode: 0 })
      expect(existsSync(output(f))).toBe(true)

      const file1 = join(f.cwd, 'deep/nested/folder/file.txt')
      const file2 = join(f.cwd, 'second/sub/target.md')
      expect(existsSync(file1)).toBe(true)
      expect(existsSync(file2)).toBe(true)

      expect(readFileSync(file1, 'utf8')).toContain(`fake-write:${task}:deep/nested/folder/file.txt`)
      expect(readFileSync(file2, 'utf8')).toContain(`fake-write:${task}:second/sub/target.md`)

      // Verify no temporary files remain in run directory
      const runFiles = readdirSync(f.run)
      expect(runFiles.filter((name) => name.endsWith('.tmp'))).toHaveLength(0)
      expect(runFiles).toContain('result.json')
      expect(runFiles).toContain('worker.json')
    })
  })

  it('FAKE_HANG=0 does not hang and executes normally', async () => {
    await run({ FAKE_HANG: '0' }, (f, code) => {
      expect(code).toBe(0)
      expect(result(f)).toEqual({ exitCode: 0 })
      expect(existsSync(output(f))).toBe(true)
    })
  })

  it('precedence: FAKE_FAIL_UNTIL_ATTEMPT > FAKE_EXIT_CODE when attempt matches', async () => {
    await run({ FACTORY_ATTEMPT_NO: '1', FAKE_FAIL_UNTIL_ATTEMPT: '1', FAKE_FAIL_CODE: '88', FAKE_EXIT_CODE: '5' }, (f, code) => {
      expect(code).toBe(88)
      expect(result(f)).toEqual({ exitCode: 88 })
      expect(existsSync(output(f))).toBe(false)
    })

    // When attempt exceeds threshold, FAKE_EXIT_CODE takes over
    await run({ FACTORY_ATTEMPT_NO: '2', FAKE_FAIL_UNTIL_ATTEMPT: '1', FAKE_FAIL_CODE: '88', FAKE_EXIT_CODE: '5' }, (f, code) => {
      expect(code).toBe(5)
      expect(result(f)).toEqual({ exitCode: 5 })
      expect(existsSync(output(f))).toBe(true)
    })
  })

  it.skipIf(process.platform !== 'win32')('handles FAKE_WRITE with Windows backslashes', async () => {
    await run({ FAKE_WRITE: 'subpath\\windows-style.txt' }, (f, code) => {
      expect(code).toBe(0)
      expect(result(f)).toEqual({ exitCode: 0 })
      const filePath = join(f.cwd, 'subpath', 'windows-style.txt')
      expect(existsSync(filePath)).toBe(true)
      expect(readFileSync(filePath, 'utf8').length).toBeGreaterThan(0)
    })
  })

  it.skipIf(process.platform !== 'win32')('runs with 8.3 short path alias as runDir and cwd', async (ctx) => {
    const root = mkdtempSync(join(tmpdir(), 'factory m4 04 long name-'))
    let child: ChildProcess | undefined
    let nonce: string | undefined
    let alias: string | undefined
    let exitPromise: Promise<number | null> | undefined

    try {
      const cmdOut = execSync(`cmd /c for %I in ("${root}") do @echo %~sI`, { encoding: 'utf8' })
      alias = cmdOut ? cmdOut.trim() : ''

      if (!alias || alias.toLowerCase() === root.toLowerCase()) {
        ctx.skip()
        return
      }

      nonce = randomUUID()
      const cleanEnv = { ...process.env }
      for (const key of ['FACTORY_ATTEMPT_NO', 'FAKE_FAIL_UNTIL_ATTEMPT', 'FAKE_FAIL_CODE', 'FAKE_HANG', 'FAKE_WRITE', 'FAKE_SLEEP_MS', 'FAKE_EXIT_CODE']) {
        delete cleanEnv[key]
      }

      child = spawn(process.execPath, [executor, task, nonce, alias], {
        cwd: alias,
        env: cleanEnv,
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
      })

      const proc = child
      exitPromise = new Promise<number | null>((resolve, reject) => {
        proc.once('error', reject)
        proc.once('exit', resolve)
      })

      let timer: ReturnType<typeof setTimeout> | undefined
      let exitCode: number | null = null
      try {
        exitCode = await Promise.race([
          exitPromise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Executor exit timed out')), 15000)
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }

      expect(exitCode).toBe(0)
      const workerPath = join(alias, 'worker.json')
      expect(existsSync(workerPath)).toBe(true)
      const workerData = JSON.parse(readFileSync(workerPath, 'utf8')) as Worker
      expect(workerData.pid).toBe(child.pid)
      expect(workerData.nonce).toBe(nonce)
    } finally {
      try {
        let killRes: Awaited<ReturnType<typeof killTree>> | undefined
        if (child?.pid && child.exitCode === null && child.signalCode === null && nonce) {
          killRes = await killTree(child.pid, nonce)
        }
        if (alias && nonce) {
          const workerPath = join(alias, 'worker.json')
          if (existsSync(workerPath)) {
            try {
              const w = JSON.parse(readFileSync(workerPath, 'utf8')) as Worker
              if (w.pid === child?.pid && w.nonce === nonce && Number.isSafeInteger(w.grandchildPid) && w.grandchildPid > 0 && alive(w.grandchildPid)) {
                await killTree(w.grandchildPid, nonce)
              }
            } catch {
              // ignore
            }
          }
        }
        if (exitPromise && child && (child.exitCode !== null || killRes?.result === 'killed' || killRes?.result === 'not-running')) {
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([
              exitPromise,
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, 10000)
              }),
            ])
          } catch {
            // ignore
          } finally {
            if (timer) clearTimeout(timer)
          }
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  })
})
