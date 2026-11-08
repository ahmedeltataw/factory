import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { expect, it } from 'vitest'
import { openStore } from '../../supervisor/src/app/store.ts'

const workerSource = `
const { parentPort, workerData } = require('node:worker_threads')
;(async () => {
  const { openStore } = await import(workerData.store)
  const { appendCommand } = await import(workerData.commands)
  const db = openStore(workerData.path)
  try {
    parentPort.postMessage({ type: 'ready' })
    const gate = new Int32Array(workerData.gate)
    Atomics.wait(gate, 0, 0, 10000)
    if (Atomics.load(gate, 0) !== 1) throw new Error('race gate timed out')
    const result = appendCommand(db, workerData.command)
    parentPort.postMessage({ type: 'result', result })
  } finally { db.close() }
})().catch(error => { parentPort.postMessage({ type: 'error', message: String(error) }) })
`

it('CHK-M2-02-e: concurrent connections record a shared command only once', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-command-race-'))
  const path = join(directory, 'state.sqlite')
  const command = { id: 'same', projectId: 'p1', kind: 'create', payloadJson: '{}', createdAt: '2026-11-08T00:00:00.000Z' }
  const seed = openStore(path)
  try { seed.prepare('INSERT INTO projects VALUES (?, ?, ?)').run('p1', 'Project', command.createdAt) } finally { seed.close() }
  const gate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  const workerData = {
    path, command, gate: gate.buffer,
    store: pathToFileURL(join(process.cwd(), 'supervisor/src/app/store.ts')).href,
    commands: pathToFileURL(join(process.cwd(), 'supervisor/src/app/commands.ts')).href,
  }
  const workers = [new Worker(workerSource, { eval: true, workerData }), new Worker(workerSource, { eval: true, workerData })]
  let ready = 0
  try {
    const results = await Promise.all(workers.map(worker => new Promise<string>((resolve, reject) => {
      worker.on('error', reject)
      worker.on('exit', code => { if (code !== 0) reject(new Error(`worker exited ${code}`)) })
      worker.on('message', (message: { type: string; result?: string; message?: string }) => {
        if (message.type === 'ready' && ++ready === workers.length) { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0) }
        if (message.type === 'result' && message.result) resolve(message.result)
        if (message.type === 'error') reject(new Error(message.message))
      })
    })))
    expect(results.sort()).toEqual(['created', 'duplicate'])
    const observer = openStore(path)
    try { expect(observer.prepare('SELECT COUNT(*) AS count FROM commands').get()).toMatchObject({ count: 1 }) } finally { observer.close() }
  } finally {
    Atomics.store(gate, 0, 1)
    Atomics.notify(gate, 0)
    await Promise.all(workers.map(worker => worker.terminate()))
    rmSync(directory, { recursive: true, force: true })
  }
}, 20000)
