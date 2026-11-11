import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it.skipIf(process.platform !== 'win32')('CHK-M1-ACCEPT-SAFE-a/b: failed local clone preserves existing files and stops before install', () => {
  const temp = mkdtempSync(join(tmpdir(), 'factory-accept-safety-'))
  const old = join(temp, 'factory-m1-acceptance')
  mkdirSync(old)
  const marker = join(old, 'do-not-delete.txt')
  writeFileSync(marker, 'keep')
  const script = join(process.cwd(), 'acceptance', 'M1.ps1')
  const invoke = () => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Source', join(temp, 'missing-local-repository')], { encoding: 'utf8', env: { ...process.env, TEMP: temp, TMP: temp }, timeout: 30000 })
  const run = () => {
    let result = invoke()
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') result = invoke()
    return result
  }
  try {
    const a = run()
    const b = run()
    expect(a.error).toBeUndefined()
    expect(b.error).toBeUndefined()
    expect(a.status).not.toBe(0)
    expect(b.status).not.toBe(0)
    expect(readFileSync(marker, 'utf8')).toBe('keep')
    expect(a.stdout).not.toContain('Install with frozen lockfile')
    expect(b.stdout).not.toContain('Install with frozen lockfile')
    const pathOf = (output: string) => output.match(/factory-m1-acceptance-[a-f0-9-]+/i)?.[0]
    expect(pathOf(a.stdout)).toBeDefined()
    expect(pathOf(b.stdout)).toBeDefined()
    expect(pathOf(a.stdout)).not.toBe(pathOf(b.stdout))
  } finally { rmSync(temp, { recursive: true, force: true }) }
}, 40000)

it.skipIf(process.platform !== 'win32')('CHK-M1-ACCEPT-SAFE-b: a failing install that writes output stops acceptance', () => {
  const temp = mkdtempSync(join(tmpdir(), 'factory-accept-failed-install-'))
  const source = join(temp, 'source')
  const bin = join(temp, 'bin')
  mkdirSync(source)
  mkdirSync(bin)
  writeFileSync(join(source, 'README.md'), 'local acceptance fixture')
  writeFileSync(join(bin, 'pnpm.cmd'), '@echo off\r\necho deliberate install failure\r\nexit /b 7\r\n')
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: source, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    if (result.status !== 0) throw new Error(result.stderr)
  }
  try {
    git('init', '-q')
    git('add', 'README.md')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')
    const run = () => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(process.cwd(), 'acceptance', 'M1.ps1'), '-Source', source], {
      encoding: 'utf8', timeout: 30000, env: { ...process.env, TEMP: temp, TMP: temp, USERPROFILE: temp, PATH: `${bin};${process.env.PATH}`, GIT_TERMINAL_PROMPT: '0' },
    })
    let result = run()
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') result = run()
    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    expect(result.stdout, result.stderr).toContain('deliberate install failure')
    expect(result.stdout).not.toContain('[4] Typecheck')
    expect(result.stdout).not.toContain('M1: PASS')
  } finally { rmSync(temp, { recursive: true, force: true }) }
}, 40000)

it.skipIf(process.platform !== 'win32')('CHK-M1-ACCEPT-SAFE-b: an unsupported Node version stops before clone', () => {
  const temp = mkdtempSync(join(tmpdir(), 'factory-accept-node-version-'))
  const bin = join(temp, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'node.cmd'), '@echo off\r\necho v99.0.0\r\nexit /b 0\r\n')
  try {
    const run = () => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(process.cwd(), 'acceptance', 'M1.ps1'), '-Source', join(temp, 'missing')], {
      encoding: 'utf8', timeout: 30000, env: { ...process.env, TEMP: temp, TMP: temp, PATH: `${bin};${process.env.PATH}` },
    })
    let result = run()
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') result = run()
    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    expect(result.stdout).not.toContain('[2] Fresh clone')
  } finally { rmSync(temp, { recursive: true, force: true }) }
}, 30000)

it.skipIf(process.platform !== 'win32')('CHK-M1-ACCEPT-SAFE-b: a failing Node command cannot pass with version-like output', () => {
  const temp = mkdtempSync(join(tmpdir(), 'factory-accept-node-failure-'))
  const bin = join(temp, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'node.cmd'), '@echo off\r\necho v24.0.0\r\nexit /b 9\r\n')
  try {
    const run = () => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(process.cwd(), 'acceptance', 'M1.ps1'), '-Source', join(temp, 'missing')], {
      encoding: 'utf8', timeout: 30000, env: { ...process.env, TEMP: temp, TMP: temp, PATH: `${bin};${process.env.PATH}` },
    })
    let result = run()
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') result = run()
    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    expect(result.stdout).not.toContain('[2] Fresh clone')
  } finally { rmSync(temp, { recursive: true, force: true }) }
}, 30000)
