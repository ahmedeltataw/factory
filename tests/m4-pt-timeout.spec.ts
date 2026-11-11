import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { killTree } from '../supervisor/src/app/process-tree.ts'

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: vi.fn(),
}))

describe('Windows process listing timeout', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.mocked(spawnSync).mockReset() })

  it('retries a timeout and continues normally', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const nonce = randomUUID()
    const timeout = Object.assign(new Error('spawnSync powershell.exe ETIMEDOUT'), { code: 'ETIMEDOUT' })
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ error: timeout } as never)
      .mockReturnValueOnce({ status: 0, stdout: '[]' } as never)
    expect(await killTree(123456789, nonce)).toEqual({ result: 'not-running' })
    expect(spawnSync).toHaveBeenCalledTimes(2)
    for (const call of vi.mocked(spawnSync).mock.calls) {
      expect(call[0]).toBe('powershell.exe')
      expect(call[2]).toMatchObject({ timeout: 30000 })
    }
  })

  it.each([
    ['ETIMEDOUT', 2],
    ['EACCES', 1],
  ])('reports %s after %i attempt(s)', async (code, attempts) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const error = Object.assign(new Error(`spawnSync powershell.exe ${code}`), { code })
    vi.mocked(spawnSync).mockReturnValue({ error } as never)
    expect(await killTree(123456789, randomUUID())).toEqual({ result: 'kill-failed', detail: error.message })
    expect(spawnSync).toHaveBeenCalledTimes(attempts)
  })
})
