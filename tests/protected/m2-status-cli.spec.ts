import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'

it('CHK-M2-04-c/d: status CLI returns JSON, Arabic, and meaningful exit codes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-status-cli-'))
  const path = join(dir, 'state.sqlite')
  const cli = join(process.cwd(), 'supervisor/src/cli/main.ts')
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
  try {
    expect(run('status', '--state-dir', dir, '--bad').status).toBe(2)
    expect(run('status', '--state-dir', '--json').status).toBe(2)
    expect(run('status', '--state-dir', dir, '--json', '--json').status).toBe(2)
    expect(run('status', '--state-dir', dir, '--state-dir', dir).status).toBe(2)
    expect(existsSync(path)).toBe(false)
    expect(run('status', '--state-dir', dir).status).toBe(1)
    expect(existsSync(path)).toBe(false)
    const db = new DatabaseSync(path)
    try { db.exec("CREATE TABLE commands (id TEXT PRIMARY KEY, payload_json TEXT); INSERT INTO commands VALUES ('c1', 'secret-payload'); CREATE TABLE supervisor_lease (id INTEGER PRIMARY KEY, owner_id TEXT, generation INTEGER, heartbeat_ms INTEGER, status TEXT); PRAGMA user_version = 4") } finally { db.close() }
    const json = run('status', '--state-dir', dir, '--json')
    expect(json.status).toBe(0)
    expect(JSON.parse(json.stdout)).toMatchObject({ schemaVersion: 4, recordedCommandCount: 1, lease: null })
    expect(json.stdout).not.toContain('secret-payload')
    const human = run('status', '--state-dir', dir)
    expect(human.status).toBe(0)
    expect(human.stdout).toMatch(/[\u0600-\u06ff]/)
    expect(human.stdout).not.toContain('secret-payload')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 20000)
