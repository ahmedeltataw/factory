import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

const childSource = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const { openStore } = await import(process.argv[1]);
const { acquireSupervisor } = await import(process.argv[2]);
const db = openStore(process.argv[3]);
const handle = acquireSupervisor(db, process.argv[4], { nowMs: 10, staleAfterMs: 10 });
if (process.argv[5] === 'double') db.exec('BEGIN');
if (process.argv[5] === 'heartbeat') db.close();
const original = fs.closeSync;
fs.closeSync = () => { throw new Error('simulated close failure'); };
syncBuiltinESMExports();
let failed = false;
let message = '';
let closeMessage = '';
try { if (process.argv[5] === 'heartbeat') handle.heartbeat(11); else handle.release(11); } catch (error) { failed = true; message = error.message; closeMessage = error.cause?.message ?? ''; }
fs.closeSync = original;
syncBuiltinESMExports();
if (process.argv[5] === 'double') db.exec('ROLLBACK');
if (process.argv[5] !== 'heartbeat') db.close();
console.log(JSON.stringify({ failed, message, closeMessage }));
`

it('CHK-M2-03-e: an OS handle close failure is not reported as successful release', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-lease-close-failure-'))
  try {
    const result = spawnSync(process.execPath, [
      '--input-type=module', '--eval', childSource,
      pathToFileURL(join(process.cwd(), 'supervisor/src/app/store.ts')).href,
      pathToFileURL(join(process.cwd(), 'supervisor/src/app/supervisor-lease.ts')).href,
      join(dir, 'state.sqlite'), dir,
    ], { encoding: 'utf8', timeout: 10000 })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ failed: true, message: 'simulated close failure' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 15000)

it('CHK-M2-03-e: preserves the primary heartbeat failure when closing also fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-lease-heartbeat-double-'))
  try {
    const result = spawnSync(process.execPath, [
      '--input-type=module', '--eval', childSource,
      pathToFileURL(join(process.cwd(), 'supervisor/src/app/store.ts')).href,
      pathToFileURL(join(process.cwd(), 'supervisor/src/app/supervisor-lease.ts')).href,
      join(dir, 'state.sqlite'), dir, 'heartbeat',
    ], { encoding: 'utf8', timeout: 10000 })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    const resultData = JSON.parse(result.stdout) as { failed: boolean; message: string; closeMessage: string }
    expect(resultData.failed).toBe(true)
    expect(resultData.message).not.toBe('simulated close failure')
    expect(resultData.closeMessage).toBe('simulated close failure')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 15000)

it('CHK-M2-03-e: preserves the primary release failure when closing also fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-lease-double-failure-'))
  try {
    const result = spawnSync(process.execPath, [
      '--input-type=module', '--eval', childSource,
      pathToFileURL(join(process.cwd(), 'supervisor/src/app/store.ts')).href,
      pathToFileURL(join(process.cwd(), 'supervisor/src/app/supervisor-lease.ts')).href,
      join(dir, 'state.sqlite'), dir, 'double',
    ], { encoding: 'utf8', timeout: 10000 })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ failed: true, message: expect.stringContaining('active transaction'), closeMessage: 'simulated close failure' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 15000)
