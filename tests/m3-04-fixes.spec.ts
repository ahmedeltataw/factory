import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { killTree, parseLinuxStat, parseWindowsProcesses, spawnWorker, treePids } from '../supervisor/src/app/process-tree.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return { ...original, spawnSync: vi.fn(original.spawnSync) }
})

describe('process identity safety', () => {
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid pid %s', async (pid) => {
    expect(await killTree(pid, 'nonce')).toEqual({ result: 'kill-failed', detail: 'Invalid process identity' })
  })
  it('rejects whitespace-only nonces', async () => {
    expect(await killTree(process.pid, ' \t\r\n')).toEqual({
      result: 'kill-failed', detail: 'Invalid process identity',
    })
  })

  it('never kills the current process, even when the nonce matches its command line', async () => {
    expect(await killTree(process.pid, process.execPath)).toEqual({ result: 'identity-mismatch' })
  })
})

describe('Windows process parser', () => {
  it('requires an array of valid uint32 records', () => {
    for (const value of [null, {}, 'x', 1, [1], { ProcessId: 1 }, ...[-1, 1.5, 4294967296, '1', null].map((pid) => ({ ProcessId: pid, ParentProcessId: 0 })), ...[-1, 1.5, 4294967296, '1', null].map((parent) => ({ ProcessId: 1, ParentProcessId: parent }))]) {
      expect(() => parseWindowsProcesses(JSON.stringify([value]))).toThrow('Invalid process record')
    }
    expect(() => parseWindowsProcesses('{}')).toThrow('Invalid process enumeration')
    expect(parseWindowsProcesses('[{"ProcessId":0,"ParentProcessId":4294967295}]')).toEqual([{ pid: 0, parent: 4294967295 }])
    expect(() => parseWindowsProcesses('[{"ProcessId":1,"ParentProcessId":0},{"ProcessId":1,"ParentProcessId":0}]', 1)).toThrow('Invalid filtered process enumeration')
    expect(() => parseWindowsProcesses('[{"ProcessId":2,"ParentProcessId":0}]', 1)).toThrow('Invalid process record')
  })

  it('rejects invalid, noncanonical and odd-length base64 commands', () => {
    for (const command of [null, 1, '!!!!', 'AAAA!', '!AAAA', 'A', 'AAA', 'AA=A', 'AB==', 'AQ==']) {
      expect(() => parseWindowsProcesses(JSON.stringify([{ ProcessId: 1, ParentProcessId: 0, CommandLine: command }]), 1)).toThrow('Invalid process command')
    }
    expect(parseWindowsProcesses('[{"ProcessId":1,"ParentProcessId":0,"CommandLine":""}]', 1)).toEqual([{ pid: 1, parent: 0, command: '' }])
  })
  it('rejects malformed enumeration records instead of omitting them', () => {
    expect(() => parseWindowsProcesses('[{"ProcessId":12,"ParentProcessId":1},{"ProcessId":13}]')).toThrow()
    expect(() => parseWindowsProcesses('not json')).toThrow()
    expect(() => parseWindowsProcesses('[{"ProcessId":-1,"ParentProcessId":1}]')).toThrow()
  })

  it('validates and decodes the filtered command', () => {
    const command = Buffer.from('worker اختبار', 'utf16le').toString('base64')
    expect(parseWindowsProcesses(JSON.stringify([{ ProcessId: 12, ParentProcessId: 1, CommandLine: command }]), 12))
      .toEqual([{ pid: 12, parent: 1, command: 'worker اختبار' }])
    expect(() => parseWindowsProcesses('[{"ProcessId":12,"ParentProcessId":1,"CommandLine":"!!!"}]', 12)).toThrow()
    expect(parseWindowsProcesses('[]', 12)).toEqual([])
  })
})

describe('process tree logic', () => {
  it('parses stat names containing parentheses and ignores zombies', () => {
    expect(parseLinuxStat('123', '123 (name ) with spaces) S 42 17 0')).toEqual({ pid: 123, parent: 42, group: 17 })
    expect(parseLinuxStat('123', '123 (name) Z 42 17 0')).toBeUndefined()
  })

  it('finds indirect descendants and group members regardless of order, without cycles', () => {
    expect([...treePids([
      { pid: 4, parent: 3 }, { pid: 3, parent: 2 }, { pid: 2, parent: 1 },
      { pid: 5, parent: 99, group: 1 }, { pid: 6, parent: 5 },
      { pid: 1, parent: 4 }, { pid: 7, parent: 99, group: 2 },
    ], 1)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6])
    expect([...treePids([], 42)]).toEqual([42])
  })
})

describe('simulated Windows kill flow', () => {
  const target = JSON.stringify([{ ProcessId: 123, ParentProcessId: 1, CommandLine: Buffer.from('worker nonce', 'utf16le').toString('base64') }])
  const record = (pid: number, parent: number) => ({ ProcessId: pid, ParentProcessId: parent })
  const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' } as never)

  it('reports enumeration errors, missing processes and identity mismatches', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      for (const [response, expected] of [
        [{ status: 1, stdout: '', stderr: ' denied \n' }, { result: 'kill-failed', detail: 'denied' }],
        [{ status: 1, stdout: '', stderr: '' }, { result: 'kill-failed', detail: 'PowerShell failed' }],
        [{ status: null, error: new Error('launch failed'), stderr: 'ignored' }, { result: 'kill-failed', detail: 'launch failed' }],
        [ok('[]'), { result: 'not-running' }],
        [ok(target), { result: 'identity-mismatch' }],
      ] as const) {
        vi.mocked(spawnSync).mockReturnValueOnce(response as never)
        expect(await killTree(123, 'different')).toEqual(expected)
      }
    } finally { platform.mockRestore(); vi.mocked(spawnSync).mockRestore() }
  })

  it('uses the supplied kill command and preserves failure details', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      for (const [failure, detail] of [
        [{ status: null, error: new Error('cannot launch'), stderr: 'ignored' }, 'cannot launch'],
        [{ status: 7, stderr: ' failure \n' }, 'failure'],
        [{ status: 7, stderr: '' }, 'Kill command exited 7'],
      ] as const) {
        vi.mocked(spawnSync).mockReturnValueOnce(ok(target)).mockReturnValueOnce(ok('[]')).mockReturnValueOnce(failure as never)
        expect(await killTree(123, 'nonce', { killCommand: { file: 'custom', args: ['arg'] } })).toEqual({ result: 'kill-failed', detail })
        expect(vi.mocked(spawnSync)).toHaveBeenLastCalledWith('custom', ['arg'], { encoding: 'utf8', timeout: 10000, windowsHide: true })
      }
    } finally { platform.mockRestore(); vi.mocked(spawnSync).mockRestore() }
  })

  it('waits for newly discovered descendants and uses default taskkill arguments', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      vi.mocked(spawnSync).mockReturnValueOnce(ok(target))
        .mockReturnValueOnce(ok(JSON.stringify([record(123, 1), record(124, 123)])))
        .mockReturnValueOnce(ok(''))
        .mockReturnValueOnce(ok(JSON.stringify([record(125, 124)])))
        .mockReturnValueOnce(ok('[]'))
      expect(await killTree(123, 'nonce')).toEqual({ result: 'killed' })
      expect(vi.mocked(spawnSync)).toHaveBeenCalledWith('taskkill', ['/T', '/F', '/PID', '123'], { encoding: 'utf8', timeout: 10000, windowsHide: true })
    } finally { platform.mockRestore(); vi.mocked(spawnSync).mockRestore() }
  })

  it('returns timeout detail when the tree remains alive at the deadline', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValue(5100)
    try {
      vi.mocked(spawnSync).mockReturnValueOnce(ok(target)).mockReturnValueOnce(ok('[]'))
        .mockReturnValueOnce(ok('')).mockReturnValueOnce(ok(JSON.stringify([record(123, 1)])))
      expect(await killTree(123, 'nonce')).toEqual({ result: 'kill-failed', detail: 'Process tree remained alive after timeout' })
    } finally { clock.mockRestore(); platform.mockRestore(); vi.mocked(spawnSync).mockRestore() }
  })

  it('continues polling before the deadline and reports non-Error exceptions', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValue(5099)
    try {
      vi.mocked(spawnSync).mockReturnValueOnce(ok(target)).mockReturnValueOnce(ok('[]')).mockReturnValueOnce(ok(''))
        .mockReturnValueOnce(ok(JSON.stringify([record(123, 1)]))).mockReturnValueOnce(ok('[]'))
      expect(await killTree(123, 'nonce')).toEqual({ result: 'killed' })
      vi.mocked(spawnSync).mockImplementationOnce(() => { throw 'enumeration broke' })
      expect(await killTree(123, 'nonce')).toEqual({ result: 'kill-failed', detail: 'enumeration broke' })
    } finally { clock.mockRestore(); platform.mockRestore(); vi.mocked(spawnSync).mockRestore() }
  })
})

describe.skipIf(process.platform !== 'win32')('Windows enumeration failures', () => {
  it('returns kill-failed when a process table record is malformed', async () => {
    const command = Buffer.from('worker nonce', 'utf16le').toString('base64')
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify([{ ProcessId: 123, ParentProcessId: 1, CommandLine: command }]), stderr: '' } as never)
      .mockReturnValueOnce({ status: 0, stdout: '[{"ProcessId":123}]', stderr: '' } as never)
    try {
      expect((await killTree(123, 'nonce')).result).toBe('kill-failed')
    } finally {
      vi.mocked(spawnSync).mockReset()
      vi.mocked(spawnSync).mockImplementation((await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawnSync)
    }
  })
})


describe.skipIf(process.platform !== 'win32')('Windows process enumeration', () => {
  it('kills a worker when an unrelated process has non-ASCII arguments', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'm3-04-'))
    const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', '\u201c\u0627\u062e\u062a\u0628\u0627\u0631\u201d'], { stdio: 'ignore', windowsHide: true })
    let worker: ReturnType<typeof spawnWorker> | undefined
    try {
      await once(helper, 'spawn', { signal: AbortSignal.timeout(5000) })
      worker = spawnWorker({ runDir, cwd: process.cwd(), taskId: 'm3-04', attemptId: '1', env: { ...process.env, FAKE_SLEEP_MS: '30000' } })
      expect(await killTree(worker.pid, worker.nonce)).toEqual({ result: 'killed' })
    } finally {
      helper.kill()
      if (worker) {
        try { process.kill(worker.pid) } catch { /* Worker has already exited. */ }
      }
      rmSync(runDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  }, 60000)
})
