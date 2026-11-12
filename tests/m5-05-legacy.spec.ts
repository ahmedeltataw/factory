import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { appendCommand } from '../supervisor/src/app/commands.ts'
import { applyPendingCommands } from '../supervisor/src/app/apply-commands.ts'
import { openStore } from '../supervisor/src/app/store.ts'
import { acquireSupervisor } from '../supervisor/src/app/supervisor-lease.ts'

it('preserves M4 creation in phase-less projects and rejects phase features', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-m5-05-legacy-'))
  const db = openStore(join(dir, 'state.sqlite'))
  const handle = acquireSupervisor(db, dir, { nowMs: 1000, staleAfterMs: 300000 })
  const stamp = '2026-11-10T00:00:00.000Z'
  try {
    db.prepare('INSERT INTO projects VALUES (?, ?, ?)').run('p', 'Project', stamp)
    const send = (id: string, kind: string, payload: unknown) => {
      appendCommand(db, { id, projectId: 'p', kind, payloadJson: JSON.stringify(payload), createdAt: stamp })
      applyPendingCommands(db, handle)
      return db.prepare('SELECT outcome FROM command_outcomes WHERE command_id = ?').get(id)
    }
    const m4 = { title: 'M4', scope: ['src'], maxAttempts: 2, timeoutMs: 1000 }
    expect(send('legacy', 'task.create', { title: 'Legacy' })).toEqual({ outcome: 'applied' })
    expect(send('m4', 'task.create', m4)).toEqual({ outcome: 'applied' })
    expect(send('null', 'task.create', { ...m4, phase: null, deps: [] })).toEqual({ outcome: 'applied' })
    for (const id of ['legacy', 'm4', 'null']) expect(db.prepare('SELECT phase FROM tasks WHERE id = ?').get(id)).toEqual({ phase: 'intake' })
    expect(send('named', 'task.create', { ...m4, phase: 'intake', deps: [] })).toEqual({ outcome: 'rejected' })
    expect(send('dependent', 'task.create', { ...m4, phase: null, deps: ['m4'] })).toEqual({ outcome: 'rejected' })
    expect(send('advance', 'phase.advance', { phase: 'intake' })).toEqual({ outcome: 'rejected' })
    expect(db.prepare('SELECT id FROM tasks ORDER BY id').all()).toEqual([{ id: 'legacy' }, { id: 'm4' }, { id: 'null' }])
    expect(db.prepare('SELECT * FROM task_deps').all()).toEqual([])
    db.prepare("INSERT INTO phases (project_id, name, ord, status) VALUES ('p', 'intake', 1, 'done')").run()
    expect(send('no-open', 'task.create', m4)).toEqual({ outcome: 'rejected' })
    expect(db.prepare("SELECT id FROM tasks WHERE id = 'no-open'").get()).toBeUndefined()
  } finally {
    handle.release(Date.now())
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
