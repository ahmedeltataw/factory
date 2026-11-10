import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { appendCommand } from '../supervisor/src/app/commands.ts'
import { applyPendingCommands } from '../supervisor/src/app/apply-commands.ts'
import { openStore } from '../supervisor/src/app/store.ts'
import { acquireSupervisor } from '../supervisor/src/app/supervisor-lease.ts'

it('rejects partial create payloads and rolls back task and outcome together', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-m4-03-'))
  const db = openStore(join(dir, 'state.sqlite'))
  const handle = acquireSupervisor(db, dir, { nowMs: 1000, staleAfterMs: 300000 })
  try {
    db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p', 'Project', '2026-11-10T00:00:00.000Z')").run()
    const append = (id: string, payload: unknown) => appendCommand(db, { id, projectId: 'p', kind: 'task.create', payloadJson: JSON.stringify(payload), createdAt: '2026-11-10T00:00:00.000Z' })
    append('partial', { title: 'Task', scope: ['.'] })
    append('legacy-extra', { title: 'Task', extra: true })
    append('valid', { title: 'Task', scope: ['z', 'a'], maxAttempts: 1, timeoutMs: 86400000 })
    db.exec("CREATE TRIGGER fail_valid BEFORE INSERT ON command_outcomes WHEN NEW.command_id = 'valid' BEGIN SELECT RAISE(ABORT, 'outcome failure'); END")
    expect(() => applyPendingCommands(db, handle)).toThrow('outcome failure')
    expect(db.prepare("SELECT outcome FROM command_outcomes WHERE command_id IN ('partial', 'legacy-extra') ORDER BY command_id").all()).toEqual([{ outcome: 'rejected' }, { outcome: 'rejected' }])
    expect(db.prepare("SELECT id FROM tasks WHERE id = 'valid'").get()).toBeUndefined()
    expect(db.prepare("SELECT command_id FROM command_outcomes WHERE command_id = 'valid'").get()).toBeUndefined()
    db.exec('DROP TRIGGER fail_valid')
    applyPendingCommands(db, handle)
    expect(db.prepare("SELECT scope_json, max_attempts, timeout_ms FROM tasks WHERE id = 'valid'").get()).toMatchObject({ scope_json: '["a","z"]', max_attempts: 1, timeout_ms: 86400000 })
  } finally {
    handle.release(Date.now())
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
