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
const original = fs.closeSync;
fs.closeSync = () => { throw new Error('simulated close failure'); };
syncBuiltinESMExports();
let failed = false;
try { handle.release(11); } catch { failed = true; }
fs.closeSync = original;
syncBuiltinESMExports();
db.close();
console.log(JSON.stringify({ failed }));
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
    expect(JSON.parse(result.stdout)).toEqual({ failed: true })
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 15000)
