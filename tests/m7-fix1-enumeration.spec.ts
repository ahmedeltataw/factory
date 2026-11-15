import { afterEach, expect, it, vi } from 'vitest'

const { spawnSync } = vi.hoisted(() => ({ spawnSync: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync,
}))

import { findProcessesWithNonces } from './helpers/process-identity.ts'

afterEach(() => { vi.restoreAllMocks(); spawnSync.mockReset() })

it('retries a timed out enumeration once within the deadline', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
  spawnSync.mockImplementationOnce(() => {
    now.mockReturnValue(1100)
    return { error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }) }
  }).mockReturnValueOnce({ status: 0, stdout: '__FACTORY_ENUM_SUCCESS__\n[]' })
  expect(findProcessesWithNonces(['nonce'], { deadlineMs: 2000 })).toEqual([])
  expect(spawnSync).toHaveBeenCalledTimes(2)
  expect(spawnSync.mock.calls[1]![2].timeout).toBe(900)
})
