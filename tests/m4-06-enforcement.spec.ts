import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))
import { execFileSync } from 'node:child_process'
import { openStore } from '../supervisor/src/app/store.ts'
import { acquireSupervisor } from '../supervisor/src/app/supervisor-lease.ts'
import { createEffectHandlers, enqueue, runDue } from '../supervisor/src/app/outbox.ts'

it.each([
  ['?? outside.txt\0', 'outside.txt'],
  [' D outside.txt\0', 'outside.txt'],
  ['R  inside/new.txt\0outside.txt\0', 'outside.txt'],
  ['R  outside.txt\0inside/old.txt\0', 'outside.txt'],
])('rejects status entry %s before committing', async (status, bad) => {
  const dir = mkdtempSync(join(tmpdir(), 'm406-scope-'))
  const db = openStore(join(dir, 'state.sqlite'))
  const handle = acquireSupervisor(db, dir, { nowMs: 1, staleAfterMs: 10000 })
  try {
    db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p', 'P', 'now')").run()
    db.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES ('c', 'p', 'task.create', '{}', 'now')").run()
    db.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, scope_json, created_at, updated_at) VALUES ('t', 'p', 'c', 'T', 'progress', ?, 'now', 'now')").run(JSON.stringify(['inside']))
    db.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation) VALUES ('a', 't', 1, 'succeeded', ?)").run(handle.generation)
    enqueue(db, handle, { idempotencyKey: 'evidence.commit:a', kind: 'evidence.commit', payloadJson: JSON.stringify({ attemptId: 'a', worktreePath: dir }), nowMs: 1 })
    vi.mocked(execFileSync).mockReturnValueOnce(status as never)
    await runDue(db, handle, createEffectHandlers({ db }), 2)
    expect(db.prepare('SELECT status, error_class FROM attempts').get()).toMatchObject({ status: 'failed', error_class: 'scope-violation' })
    expect(db.prepare('SELECT status FROM tasks').get()).toMatchObject({ status: 'failed' })
    expect(db.prepare('SELECT status, last_error FROM outbox').get()).toMatchObject({ status: 'done', last_error: `scope-violation: ${bad}` })
    expect(db.prepare('SELECT count(*) AS n FROM evidence').get()).toMatchObject({ n: 0 })
    expect(execFileSync).toHaveBeenCalledTimes(1)
  } finally { vi.clearAllMocks(); handle.release(3); db.close(); rmSync(dir, { recursive: true, force: true }) }
})
