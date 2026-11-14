import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { openStore } from '../supervisor/src/app/store.ts'
import { readStatus } from '../supervisor/src/app/status.ts'

it('preserves stored scope order and rejects malformed scope data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-m6-scope-'))
  const db = openStore(join(dir, 'state.sqlite'))
  try {
    const stamp = '2026-11-13T10:00:00.000Z'
    db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run('p', 'Project', stamp)
    db.prepare(`INSERT INTO github_events (event_id, project_id, repo, kind, actor_id, actor_login, issue, status, title, scope_json, basis_json, text, text_trust, text_sha256, event_at, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('1', 'p', 'org/repo', 'issue.comment', 1, 'alice', 1, 'pending', 'Title', '["z", "a"]', '{}', '', 'untrusted', 'hash', stamp, stamp)
    expect(readStatus(dir, { nowMs: 1000, staleAfterMs: 500 }).github?.pending[0]?.scope).toEqual(['z', 'a'])
    db.exec('DROP TRIGGER IF EXISTS github_events_immutable')
    for (const malformed of ['{}', '["a", 1]', 'null', '{']) {
      db.prepare('UPDATE github_events SET scope_json = ? WHERE event_id = ?').run(malformed, '1')
      expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow('malformed github scope')
      const result = spawnSync(process.execPath, [join(process.cwd(), 'supervisor/src/cli/main.ts'), 'status', '--state-dir', dir], { encoding: 'utf8' })
      expect(result.status).toBe(1)
    }
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
