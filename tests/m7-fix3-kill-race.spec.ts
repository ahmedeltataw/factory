import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ spawnSync: vi.fn(), delay: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: mocks.spawnSync,
}))
vi.mock('node:timers/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:timers/promises')>(),
  setTimeout: mocks.delay,
}))
import { killTree } from '../supervisor/src/app/process-tree.ts'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const pid = 123456
const childPid = 123457

describe('CHK-M7-FIX3-a Windows kill race', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    mocks.delay.mockResolvedValue(undefined)
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform)
    vi.restoreAllMocks()
    vi.resetAllMocks()
  })

  function setup(status: number, remaining: 'gone' | 'alive', error?: Error) {
    const nonce = randomUUID()
    const root = { ProcessId: pid, ParentProcessId: 1, CreationDate: '100', CommandLine: Buffer.from(nonce, 'utf16le').toString('base64') }
    const child = { ProcessId: childPid, ParentProcessId: pid, CreationDate: '101' }
    let enumerations = 0
    mocks.spawnSync.mockImplementation((file: string) => {
      if (file === 'powershell.exe') {
        enumerations++
        const records = enumerations === 1 ? [root] : enumerations === 2 || remaining === 'alive' ? [root, child] : []
        return { status: 0, stdout: JSON.stringify(records), stderr: '' }
      }
      return { status, stderr: 'taskkill failed', error }
    })
    return nonce
  }

  it('verifies the tree after nonzero taskkill when all members have exited', async () => {
    const nonce = setup(128, 'gone')
    await expect(killTree(pid, nonce)).resolves.toEqual({ result: 'killed' })
    expect(mocks.spawnSync.mock.calls.filter(([file]) => file === 'powershell.exe')).toHaveLength(3)
    expect(mocks.spawnSync).toHaveBeenCalledWith('taskkill', ['/T', '/F', '/PID', String(pid)], expect.any(Object))
  })

  it('retries surviving members and fails after the deadline', async () => {
    const nonce = setup(5, 'alive')
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(5000)
    await expect(killTree(pid, nonce)).resolves.toEqual({ result: 'kill-failed', detail: 'Process tree remained alive after timeout' })
    expect(mocks.spawnSync).toHaveBeenCalledWith('taskkill', ['/F', '/PID', String(childPid)], expect.any(Object))
  })

  it('returns spawn errors even if the tree would be gone', async () => {
    const nonce = setup(0, 'gone', new Error('spawn failed'))
    await expect(killTree(pid, nonce)).resolves.toEqual({ result: 'kill-failed', detail: 'spawn failed' })
    expect(mocks.spawnSync.mock.calls.filter(([file]) => file === 'powershell.exe')).toHaveLength(2)
  })

  it('preserves nonzero custom command failures even if the tree would be gone', async () => {
    const nonce = setup(128, 'gone')
    await expect(killTree(pid, nonce, { killCommand: { file: 'custom', args: [] } })).resolves.toEqual({ result: 'kill-failed', detail: 'taskkill failed' })
    expect(mocks.spawnSync.mock.calls.filter(([file]) => file === 'powershell.exe')).toHaveLength(2)
  })
})
