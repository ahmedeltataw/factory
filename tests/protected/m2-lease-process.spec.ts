import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { openStore } from '../../supervisor/src/app/store.ts'
import { acquireSupervisor } from '../../supervisor/src/app/supervisor-lease.ts'

const childSource = `
const { openStore } = await import(process.argv[1]);
const { acquireSupervisor } = await import(process.argv[2]);
const db = openStore(process.argv[3]);
const handle = acquireSupervisor(db, process.argv[4], { nowMs: 1000, staleAfterMs: 1000 });
console.log(JSON.stringify({ ownerId: handle.ownerId, generation: handle.generation, heartbeatMs: 1000 }));
setInterval(() => {}, 1000);
`

it('CHK-M2-03-c/d: live OS lock blocks competitors; crash recovery requires matching stale evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-lease-process-'))
  const path = join(dir, 'state.sqlite')
  const initial = openStore(path)
  initial.close()
  const child = spawn(process.execPath, [
    '--input-type=module', '--eval', childSource,
    pathToFileURL(join(process.cwd(), 'supervisor/src/app/store.ts')).href,
    pathToFileURL(join(process.cwd(), 'supervisor/src/app/supervisor-lease.ts')).href,
    path, dir,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  try {
    const evidence = await new Promise<{ ownerId: string; generation: number; heartbeatMs: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child did not acquire: ${stderr}`)), 10000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`child exited ${code}: ${stderr}`)) })
      child.stdout.once('data', chunk => { clearTimeout(timer); try { resolve(JSON.parse(String(chunk))) } catch (error) { reject(error) } })
    })
    const db = openStore(path)
    try {
      expect(() => acquireSupervisor(db, dir, { nowMs: 5000, staleAfterMs: 1000, takeover: evidence })).toThrow()
      child.kill()
      await exited
      expect(() => acquireSupervisor(db, dir, { nowMs: 1500, staleAfterMs: 1000, takeover: evidence })).toThrow()
      expect(() => acquireSupervisor(db, dir, { nowMs: 3000, staleAfterMs: 1000 })).toThrow()
      expect(() => acquireSupervisor(db, dir, { nowMs: 3000, staleAfterMs: 1000, takeover: { ...evidence, heartbeatMs: 999 } })).toThrow()
      const next = acquireSupervisor(db, dir, { nowMs: 3000, staleAfterMs: 1000, takeover: evidence })
      try { expect(next.generation).toBe(evidence.generation + 1) } finally { next.release(3001) }
    } finally { db.close() }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited
    rmSync(dir, { recursive: true, force: true })
  }
}, 20000)
