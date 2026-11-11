import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { appendCommand, CommandConflictError } from '../supervisor/src/app/commands.ts'
import { applyPendingCommands } from '../supervisor/src/app/apply-commands.ts'
import { openStore } from '../supervisor/src/app/store.ts'
import { acquireSupervisor } from '../supervisor/src/app/supervisor-lease.ts'

it('applies phase and dependency commands atomically and rejects invalid transitions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-m5-05-'))
  const db = openStore(join(dir, 'state.sqlite'))
  const handle = acquireSupervisor(db, dir, { nowMs: 1000, staleAfterMs: 300000 })
  const stamp = '2026-11-10T00:00:00.000Z'
  try {
    for (const project of ['p', 'other']) {
      db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(project, project, stamp)
      for (const [index, name] of ['intake', 'development', 'qa', 'devops', 'handover'].entries())
        db.prepare('INSERT INTO phases (project_id, name, ord, status, opened_at) VALUES (?, ?, ?, ?, ?)').run(project, name, index + 1, index === 0 ? 'open' : 'locked', index === 0 ? stamp : null)
    }
    const command = (id: string, kind: string, payload: unknown, projectId = 'p') => ({ id, projectId, kind, payloadJson: JSON.stringify(payload), createdAt: stamp })
    const send = (id: string, kind: string, payload: unknown, projectId = 'p') => { appendCommand(db, command(id, kind, payload, projectId)); applyPendingCommands(db, handle) }
    const outcome = (id: string) => db.prepare('SELECT outcome, reason FROM command_outcomes WHERE command_id = ?').get(id)
    const create = (phase: string | null = null, deps: string[] = []) => ({ title: 'Task', scope: ['.'], maxAttempts: 3, timeoutMs: null, phase, deps })
    send('a', 'task.create', create())
    expect(appendCommand(db, command('a', 'task.create', create()))).toBe('duplicate')
    expect(() => appendCommand(db, command('a', 'task.create', create('qa')))).toThrow(CommandConflictError)
    send('foreign', 'task.create', create(), 'other')
    send('later', 'task.create', create('qa'))
    for (const [id, deps] of [['missing', ['absent']], ['cross', ['foreign']], ['future', ['later']]] as const) {
      send(id, 'task.create', create('intake', [...deps]))
      expect(outcome(id)).toMatchObject({ outcome: 'rejected' })
      expect(db.prepare('SELECT id FROM tasks WHERE id = ?').get(id)).toBeUndefined()
    }
    send('good', 'task.create', create('qa', ['a', 'a']))
    expect(db.prepare('SELECT depends_on FROM task_deps WHERE task_id = ?').all('good')).toEqual([{ depends_on: 'a' }])
    send('busy', 'phase.advance', { phase: 'intake' })
    expect(outcome('busy')).toMatchObject({ outcome: 'rejected', reason: 'phase has unfinished tasks' })
    send('locked', 'phase.advance', { phase: 'qa' })
    expect(outcome('locked')).toMatchObject({ outcome: 'rejected', reason: 'phase is not open' })
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = 'a'").run()
    send('advance', 'phase.advance', { phase: 'intake' })
    expect(outcome('advance')).toMatchObject({ outcome: 'applied', reason: null })
    expect(db.prepare("SELECT status, opened_at FROM phases WHERE project_id = 'p' AND name = 'development'").get()).toMatchObject({ status: 'open', opened_at: expect.any(String) })
    send('done-phase', 'task.create', create('intake'))
    expect(outcome('done-phase')).toMatchObject({ outcome: 'rejected' })
    send('legacy', 'task.create', { title: 'Legacy', scope: ['.'], maxAttempts: 3, timeoutMs: null })
    expect(db.prepare("SELECT phase FROM tasks WHERE id = 'legacy'").get()).toEqual({ phase: 'development' })
    send('bad-deps', 'task.create', { ...create(), deps: [null] })
    expect(outcome('bad-deps')).toMatchObject({ outcome: 'rejected' })
  } finally {
    handle.release(Date.now())
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
