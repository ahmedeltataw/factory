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
  const run = () => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Source', join(temp, 'missing-local-repository')], { encoding: 'utf8', env: { ...process.env, TEMP: temp, TMP: temp }, timeout: 15000 })
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
