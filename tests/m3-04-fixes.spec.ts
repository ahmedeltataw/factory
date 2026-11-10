import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { setTimeout as delay } from 'node:timers/promises'
import { killTree, parseLinuxStat, parseWindowsProcesses, spawnWorker, treeMembers, aliveMembers } from '../supervisor/src/app/process-tree.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return { ...original, spawnSync: vi.fn(original.spawnSync) }
})

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, readFileSync: vi.fn(original.readFileSync), readdirSync: vi.fn(original.readdirSync) }
})

vi.mock('node:timers/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:timers/promises')>()
  return { ...original, setTimeout: vi.fn(original.setTimeout) }
})

it('waits for a zombie root to disappear before reporting POSIX success', async () => {
  const pid = 123456789
  const nonce = randomUUID()
  const stat = `${pid} (worker) S 1 17 ${Array(16).fill('0').join(' ')} 100`
  const zombie = `${pid} (worker) Z`
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (signal === 0 && kill.mock.calls.filter(([, value]) => value === 0).length === 3) {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    }
    return true
  })
  let statReads = 0
  vi.mocked(readFileSync).mockImplementation(((path: unknown) => String(path).endsWith('/cmdline') ? `worker ${nonce}` : ++statReads <= 3 ? stat : zombie) as unknown as typeof readFileSync)
  vi.mocked(readdirSync).mockReturnValue([String(pid)] as never)
  try {
    expect(await killTree(pid, nonce)).toEqual({ result: 'killed' })
    expect(kill.mock.calls.filter(([, signal]) => signal === 0)).toHaveLength(3)
  } finally {
    platform.mockRestore()
    kill.mockRestore()
    vi.mocked(readFileSync).mockRestore()
    vi.mocked(readdirSync).mockRestore()
  }
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

describe('process parsers and tree identities', () => {
  const record = (pid: number, parent: number, created = '100') => ({ ProcessId: pid, ParentProcessId: parent, CreationDate: created })
  it('validates Windows creation times and filtered commands', () => {
    expect(parseWindowsProcesses(JSON.stringify([record(1, 0, '638000000000000001')]))).toEqual([{ pid: 1, parent: 0, created: '638000000000000001' }])
    for (const created of [null, 1, '', '-1', '1.2', '01']) {
      expect(() => parseWindowsProcesses(JSON.stringify([record(1, 0, created as string)]))).toThrow()
    }
    const command = Buffer.from('worker \u0627\u062e\u062a\u0628\u0627\u0631', 'utf16le').toString('base64')
    expect(parseWindowsProcesses(JSON.stringify([{ ...record(1, 0), CommandLine: command }]), 1)).toEqual([{ pid: 1, parent: 0, created: '100', command: 'worker \u0627\u062e\u062a\u0628\u0627\u0631' }])
    for (const command of [null, 1, '!!!!', 'AB==', 'AQ==']) {
      expect(() => parseWindowsProcesses(JSON.stringify([{ ...record(1, 0), CommandLine: command }]), 1)).toThrow('Invalid process command')
    }
    expect(() => parseWindowsProcesses('{}')).toThrow()
    expect(() => parseWindowsProcesses(JSON.stringify([record(2, 0)]), 1)).toThrow()
    expect(() => parseWindowsProcesses(JSON.stringify([record(1, 0), record(1, 0)]), 1)).toThrow()
    expect(() => parseWindowsProcesses('[{"ProcessId":-1,"ParentProcessId":1}]')).toThrow()
  })

  it('reads Linux field 22 after a name with parentheses and rejects malformed start times', () => {
    const stat = (state: string, start: string) => `123 (name ) with spaces) ${state} 42 17 ${Array(16).fill('0').join(' ')} ${start}`
    expect(parseLinuxStat('123', stat('S', '98765432109876543'))).toEqual({ pid: 123, parent: 42, created: '98765432109876543' })
    expect(parseLinuxStat('123', stat('Z', '12'))).toBeUndefined()
    expect(() => parseLinuxStat('123', stat('S', 'bad'))).toThrow()
    expect(() => parseLinuxStat('123', '123 (name) S 42 17')).toThrow()
  })

  it('tracks identities and rejects children older than their recorded parent', () => {
    const root = { pid: 1, parent: 0, created: '100' }
    const child = { pid: 2, parent: 1, created: '200' }
    let members = treeMembers([child, root], new Map([['1:100', root]]))
    const reused = { pid: 2, parent: 99, created: '300' }
    const stale = { pid: 3, parent: 2, created: '199' }
    const late = { pid: 4, parent: 2, created: '250' }
    members = treeMembers([reused, stale, late], members)
    expect(aliveMembers([reused, stale, late], members)).toEqual([late])
    expect([...members.keys()]).toEqual(['1:100', '2:200', '4:250'])
    const newChild = { pid: 2, parent: 1, created: '300' }
    members = treeMembers([newChild], members)
    expect(aliveMembers([newChild], members)).toEqual([newChild])
  })
})

describe('simulated Windows kill flow', () => {
  const record = (pid: number, parent: number, created = '100') => ({ ProcessId: pid, ParentProcessId: parent, CreationDate: created })
  const filtered = (pid: number, parent: number, created = '100') => ({ ...record(pid, parent, created), CommandLine: Buffer.from('worker nonce', 'utf16le').toString('base64') })
  const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' } as never)
  const target = JSON.stringify([filtered(123, 1)])

  it('fails closed on errors and checks the nonce', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      vi.mocked(spawnSync).mockReturnValueOnce({ status: 1, stderr: ' denied ' } as never).mockReturnValueOnce(ok('[]')).mockReturnValueOnce(ok(target))
      expect(await killTree(123, 'nonce')).toEqual({ result: 'kill-failed', detail: 'denied' })
      expect(await killTree(123, 'nonce')).toEqual({ result: 'not-running' })
      expect(await killTree(123, 'wrong')).toEqual({ result: 'identity-mismatch' })
    } finally { platform.mockRestore(); vi.mocked(spawnSync).mockRestore() }
  })

  it('kills the root tree first and retries only snapshot-matched identities', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      vi.mocked(spawnSync).mockReturnValueOnce(ok(target))
        .mockReturnValueOnce(ok(JSON.stringify([record(123, 1), record(124, 123, '150')])))
        .mockReturnValueOnce(ok(''))
        .mockReturnValueOnce(ok(JSON.stringify([record(123, 9, '200'), record(124, 123, '150')])))
        .mockReturnValueOnce(ok(''))
        .mockReturnValueOnce(ok('[]'))
      expect(await killTree(123, 'nonce')).toEqual({ result: 'killed' })
      const kills = vi.mocked(spawnSync).mock.calls.filter(([file]) => file === 'taskkill')
      expect(kills.map(([, args]) => args)).toEqual([['/T', '/F', '/PID', '123'], ['/F', '/PID', '124']])
    } finally { platform.mockRestore(); vi.mocked(spawnSync).mockRestore() }
  })

  it('preserves custom kill command failure details', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      vi.mocked(spawnSync).mockReturnValueOnce(ok(target)).mockReturnValueOnce(ok('[]')).mockReturnValueOnce({ status: 7, stderr: ' failure ' } as never)
      expect(await killTree(123, 'nonce', { killCommand: { file: 'custom', args: ['arg'] } })).toEqual({ result: 'kill-failed', detail: 'failure' })
    } finally { platform.mockRestore(); vi.mocked(spawnSync).mockRestore() }
  })
})

describe('in-process mutation coverage', () => {
  const pid = 123456789
  const nonce = randomUUID()
  const stat = (id: number, parent = 1, created = '100', state = 'S') =>
    `${id} (worker) ${state} ${parent} 17 ${Array(16).fill('0').join(' ')} ${created}`
  const err = (code: string) => Object.assign(new Error(code), { code })
  const record = (id: number, parent: number, created = '100') => ({ ProcessId: id, ParentProcessId: parent, CreationDate: created })
  const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' } as never)

  it('validates each Windows record boundary and command encoding', () => {
    for (const item of [null, [], 1, 'x', { ...record(1, 0), ProcessId: '1' },
      { ...record(1, 0), ProcessId: 1.5 }, { ...record(1, 0), ProcessId: 4294967296 },
      { ...record(1, 0), ParentProcessId: -1 }, { ...record(1, 0), ParentProcessId: 4294967296 }]) {
      expect(() => parseWindowsProcesses(JSON.stringify([item]))).toThrow('Invalid process record')
    }
    expect(parseWindowsProcesses(JSON.stringify([record(4294967295, 4294967295)]))).toEqual([{ pid: 4294967295, parent: 4294967295, created: '100' }])
    for (const command of ['!YQ==', 'YQ==!', 'A==', 'AAA!', 'AAAAA']) {
      expect(() => parseWindowsProcesses(JSON.stringify([{ ...record(1, 0), CommandLine: command }]), 1)).toThrow('Invalid process command')
    }
  })

  it('validates Linux stat identifiers, parent and numeric boundaries', () => {
    for (const [entry, value] of [['x123', stat(123)], ['123x', stat(123)], ['123', '123 (missing'],
      ['123', stat(124)], ['9007199254740992', stat(9007199254740992)],
      ['123', stat(123, 9007199254740992)], ['123', stat(123).replace(' S 1 ', ' S x1 ')],
      ['123', stat(123).replace(' S 1 ', ' S 1x ')], ['123', stat(123, 1, '1x')], ['123', stat(123, 1, 'x1')]]) {
      expect(() => parseLinuxStat(entry!, value!)).toThrow('Invalid process stat')
    }
    expect(parseLinuxStat('123', `123 (worker)  S  1  17  ${Array(16).fill('0').join('  ')}  100`)).toEqual({ pid: 123, parent: 1, created: '100' })
  })

  it('finds reversed descendants with equal creation times', () => {
    const root = { pid: 1, parent: 0, created: '100' }
    const child = { pid: 2, parent: 1, created: '100' }
    const grandchild = { pid: 3, parent: 2, created: '100' }
    expect([...treeMembers([grandchild, child], new Map([['1:100', root]])).keys()]).toEqual(['1:100', '2:100', '3:100'])
  })

  it('fails closed for missing, replaced, empty or inaccessible Linux identities', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    try {
      const read = vi.mocked(readFileSync)
      read.mockImplementationOnce(() => { throw err('ENOENT') })
      expect(await killTree(pid, nonce)).toEqual({ result: 'not-running' })
      read.mockImplementationOnce(() => { throw err('EACCES') })
      expect(await killTree(pid, nonce)).toEqual({ result: 'kill-failed', detail: 'EACCES' })
      read.mockReturnValueOnce(stat(pid)).mockImplementationOnce(() => { throw err('ESRCH') })
      expect(await killTree(pid, nonce)).toEqual({ result: 'not-running' })
      read.mockReturnValueOnce(stat(pid)).mockReturnValueOnce('')
      expect(await killTree(pid, nonce)).toEqual({ result: 'not-running' })
      read.mockReturnValueOnce(stat(pid)).mockReturnValueOnce(nonce).mockReturnValueOnce(stat(pid, 1, '101'))
      expect(await killTree(pid, nonce)).toEqual({ result: 'identity-mismatch' })
      read.mockReturnValueOnce(stat(pid)).mockReturnValueOnce(nonce).mockImplementationOnce(() => { throw err('ENOENT') })
      expect(await killTree(pid, nonce)).toEqual({ result: 'identity-mismatch' })
      expect(kill).not.toHaveBeenCalled()
    } finally { platform.mockRestore(); kill.mockRestore(); vi.mocked(readFileSync).mockRestore() }
  })

  it.each(['ENOENT', 'ESRCH', 'EACCES', 'EPERM'])('ignores vanished or inaccessible Linux table entries: %s', async (code) => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const kill = vi.spyOn(process, 'kill').mockImplementation((_id, signal) => { if (signal === 0) throw err('ESRCH'); return true })
    try {
      vi.mocked(readdirSync).mockReturnValueOnce(['not123', '123x', '55', String(pid)] as never).mockReturnValueOnce([] as never)
      vi.mocked(readFileSync).mockImplementation(((path: unknown) => {
        const name = String(path)
        if (name.includes('/55/')) throw err(code)
        if (name.endsWith('/cmdline')) return nonce
        if (name === `/proc/${pid}/stat`) return stat(pid)
        throw new Error(`unexpected ${name}`)
      }) as unknown as typeof readFileSync)
      expect(await killTree(pid, nonce)).toEqual({ result: 'killed' })
      expect(kill).toHaveBeenCalledWith(-pid, 'SIGKILL')
    } finally { platform.mockRestore(); kill.mockRestore(); vi.mocked(readFileSync).mockRestore(); vi.mocked(readdirSync).mockRestore() }
  })

  it('reports unexpected Linux table errors before killing', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    try {
      vi.mocked(readdirSync).mockReturnValue(['55'] as never)
      vi.mocked(readFileSync).mockImplementation(((path: unknown) => String(path).includes('/55/') ? (() => { throw err('EIO') })() : String(path).endsWith('/cmdline') ? nonce : stat(pid)) as unknown as typeof readFileSync)
      expect(await killTree(pid, nonce)).toEqual({ result: 'kill-failed', detail: 'EIO' })
      expect(kill).not.toHaveBeenCalled()
    } finally { platform.mockRestore(); kill.mockRestore(); vi.mocked(readFileSync).mockRestore(); vi.mocked(readdirSync).mockRestore() }
  })

  it('kills POSIX group then descendants in reverse order and confirms disappearance', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const kill = vi.spyOn(process, 'kill').mockImplementation((_id, signal) => { if (signal === 0) throw err('ESRCH'); return true })
    let listings = 0
    try {
      vi.mocked(delay).mockResolvedValue(undefined)
      vi.mocked(readdirSync).mockImplementation((() => ++listings <= 2 ? [String(pid), '222', '333'] : []) as unknown as typeof readdirSync)
      vi.mocked(readFileSync).mockImplementation(((path: unknown) => {
        const name = String(path)
        if (name.endsWith('/cmdline')) return nonce
        if (name.includes('/222/')) return stat(222, pid, '101')
        if (name.includes('/333/')) return stat(333, 222, '102')
        return stat(pid)
      }) as unknown as typeof readFileSync)
      expect(await killTree(pid, nonce)).toEqual({ result: 'killed' })
      expect(kill.mock.calls).toEqual([[-pid, 'SIGKILL'], [333, 'SIGKILL'], [222, 'SIGKILL'], [pid, 'SIGKILL'], [pid, 0]])
      expect(delay).toHaveBeenCalledWith(100)
    } finally { platform.mockRestore(); kill.mockRestore(); vi.mocked(delay).mockRestore(); vi.mocked(readFileSync).mockRestore(); vi.mocked(readdirSync).mockRestore() }
  })

  it('respects the deadline and reports surviving Windows identities', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    let now = 1000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      vi.mocked(delay).mockImplementation((async (ms?: number) => { now += ms ?? 0 }) as typeof delay)
      vi.mocked(spawnSync).mockImplementation(((file: string, args: string[]) => {
        if (file === 'taskkill') return ok('')
        return ok(JSON.stringify(args[3]!.includes('-Filter') ? [{ ...record(pid, 1), CommandLine: Buffer.from(nonce, 'utf16le').toString('base64') }] : [record(pid, 1)]))
      }) as unknown as typeof spawnSync)
      expect(await killTree(pid, nonce)).toEqual({ result: 'kill-failed', detail: 'Process tree remained alive after timeout' })
      const kills = vi.mocked(spawnSync).mock.calls.filter(([file]) => file === 'taskkill')
      expect(kills[0]![1]).toEqual(['/T', '/F', '/PID', String(pid)])
      expect(kills[1]![1]).toEqual(['/F', '/PID', String(pid)])
      expect(kills[1]![2]).toEqual({ encoding: 'utf8', timeout: 5000, windowsHide: true })
      expect(kills.at(-1)![2]).toEqual({ encoding: 'utf8', timeout: 100, windowsHide: true })
      expect(delay).toHaveBeenCalledTimes(50)
    } finally { platform.mockRestore(); clock.mockRestore(); vi.mocked(delay).mockRestore(); vi.mocked(spawnSync).mockRestore() }
  })

  it('passes filtered and unfiltered CIM queries and reports PowerShell failures', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      vi.mocked(spawnSync).mockReturnValueOnce(ok(`  ${JSON.stringify([{ ...record(pid, 1), CommandLine: Buffer.from(nonce, 'utf16le').toString('base64') }])}  `))
        .mockReturnValueOnce({ status: 1, stderr: '' } as never)
      expect(await killTree(pid, nonce)).toEqual({ result: 'kill-failed', detail: 'PowerShell failed' })
      const calls = vi.mocked(spawnSync).mock.calls
      expect(calls[0]![1]![3]).toContain(`-Filter 'ProcessId = ${pid}'`)
      expect(calls[0]![1]![3]).toContain('CommandLine')
      expect(calls[1]![1]![3]).not.toContain('-Filter')
      expect(calls[1]![1]![3]).toContain('ConvertTo-Json')
      expect(calls[0]![2]).toEqual({ encoding: 'utf8', timeout: 10000, windowsHide: true })
    } finally { platform.mockRestore(); vi.mocked(spawnSync).mockRestore() }
  })
})

describe.skipIf(process.platform !== 'win32')('Windows enumeration failures', () => {
  it('returns kill-failed when a process table record is malformed', async () => {
    const command = Buffer.from('worker nonce', 'utf16le').toString('base64')
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify([{ ProcessId: 123, ParentProcessId: 1, CreationDate: '100', CommandLine: command }]), stderr: '' } as never)
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
      worker = spawnWorker({ runDir, cwd: runDir, taskId: 'm3-04', attemptId: '1', env: { ...process.env, FAKE_SLEEP_MS: '30000' } })
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

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 20000
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function processesWithNonces(nonces: string[]): Array<{ pid: number; nonce: string }> {
  if (!nonces.length) return []
  if (process.platform === 'win32') {
    const query = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; $p=@(Get-CimInstance Win32_Process -Property ProcessId,CommandLine | Where-Object { $_.CommandLine } | ForEach-Object { @{ ProcessId = $_.ProcessId; CommandLine = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($_.CommandLine)) } }); ConvertTo-Json -InputObject $p -Compress"],
    { encoding: 'utf8', timeout: 10000, windowsHide: true })
    if (query.error || query.status !== 0) throw new Error(query.error?.message || query.stderr)
    const rows = JSON.parse(query.stdout) as Array<{ ProcessId: number; CommandLine: string }>
    return rows.flatMap((row) => {
      if (typeof row.CommandLine !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.CommandLine)) throw new Error('Invalid process command')
      const bytes = Buffer.from(row.CommandLine, 'base64')
      if (bytes.length % 2 !== 0 || bytes.toString('base64') !== row.CommandLine) throw new Error('Invalid process command')
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

async function cleanupWorkers(workers: Array<{ pid: number; nonce: string }>): Promise<void> {
  for (const worker of workers) await killTree(worker.pid, worker.nonce)
  // Any orphan is killed only after its own command line has been checked for the nonce.
  for (const survivor of processesWithNonces(workers.map((worker) => worker.nonce))) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/T', '/F', '/PID', String(survivor.pid)], { timeout: 5000, windowsHide: true })
    } else {
      try { process.kill(survivor.pid, 'SIGKILL') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
  }
}

describe.skipIf(process.platform !== 'win32')('Windows command line encoding', () => {
  it('finds a process whose command line contains control characters', async () => {
    const root = mkdtempSync(join(tmpdir(), 'm4-th-'))
    const nonce = randomUUID()
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', `\u0001\u001b\n${nonce}`], { cwd: root, stdio: 'ignore', windowsHide: true })
    try {
      await once(child, 'spawn', { signal: AbortSignal.timeout(5000) })
      expect(processesWithNonces([nonce])).toContainEqual({ pid: child.pid, nonce })
    } finally {
      try {
        if (child.pid) expect((await killTree(child.pid, nonce)).result).toBe('killed')
      } finally {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      }
    }
  }, 60000)
})

describe('real process regression', () => {
  it('kills 50 workers immediately without leaving nonce-bearing processes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'm3-04-race-'))
    const workers: Array<{ pid: number; nonce: string }> = []
    try {
      for (let i = 0; i < 50; i++) {
        const worker = spawnWorker({ runDir: join(root, String(i)), cwd: root, taskId: `task-${i}`, attemptId: '1', env: { ...process.env, FAKE_SLEEP_MS: '30000' } })
        workers.push(worker)
        expect(await killTree(worker.pid, worker.nonce)).toEqual({ result: 'killed' })
      }
      expect(processesWithNonces(workers.map((worker) => worker.nonce))).toEqual([])
    } finally {
      try { await cleanupWorkers(workers) } finally { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) }
    }
  }, 300000)

  it('keeps the executor alive after its spawner dies', async () => {
    const root = mkdtempSync(join(tmpdir(), 'm3-04-parent-'))
    const resultFile = join(root, 'spawned.json')
    const script = join(root, 'parent.mjs')
    const moduleUrl = new URL('../supervisor/src/app/process-tree.ts', import.meta.url).href
    writeFileSync(script, `import { spawnWorker } from ${JSON.stringify(moduleUrl)};\nimport { writeFileSync } from 'node:fs';\nconst worker = spawnWorker({ runDir: ${JSON.stringify(join(root, 'run'))}, cwd: ${JSON.stringify(root)}, taskId: 'parent-test', attemptId: '1', env: { ...process.env, FAKE_SLEEP_MS: '30000' } });\nwriteFileSync(${JSON.stringify(resultFile)}, JSON.stringify(worker));\nsetInterval(() => {}, 1000);\n`)
    const parent = spawn(process.execPath, [script], { stdio: 'ignore', windowsHide: true })
    let worker: { pid: number; nonce: string } | undefined
    try {
      await waitForFile(resultFile)
      worker = JSON.parse(readFileSync(resultFile, 'utf8'))
      await waitForFile(join(root, 'run', 'worker.json'))
      const exited = once(parent, 'exit')
      parent.kill('SIGKILL')
      await exited
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(processesWithNonces([worker!.nonce]).some((item) => item.pid === worker!.pid)).toBe(true)
      expect(await killTree(worker!.pid, worker!.nonce)).toEqual({ result: 'killed' })
      expect(processesWithNonces([worker!.nonce])).toEqual([])
    } finally {
      parent.kill('SIGKILL')
      if (!worker && existsSync(resultFile)) worker = JSON.parse(readFileSync(resultFile, 'utf8'))
      try { if (worker) await cleanupWorkers([worker]) } finally { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) }
    }
  }, 90000)
})
