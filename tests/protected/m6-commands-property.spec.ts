import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as fc from 'fast-check'
import { expect, it } from 'vitest'
import { openStore } from '../../supervisor/src/app/store.ts'
import { applyPendingCommands } from '../../supervisor/src/app/apply-commands.ts'
import { acquireSupervisor } from '../../supervisor/src/app/supervisor-lease.ts'

it('CHK-M6-04-e: random decisions, duplicates, creates and apply runs preserve event and task invariants', () => {
  const action = fc.record({ kind: fc.constantFrom('approve', 'reject', 'duplicate', 'create', 'apply'), event: fc.integer({ min: 1, max: 4 }) })
  fc.assert(fc.property(fc.array(action, { maxLength: 12 }), (actions) => {
    const dir = mkdtempSync(join(tmpdir(), 'm6-property-'))
    const db = openStore(join(dir, 'state.sqlite'))
    try {
      db.exec("INSERT INTO projects VALUES ('p1','Project','2026-01-01'); INSERT INTO project_config VALUES ('p1','/repo','main','2026-01-01')")
      for (let n = 1; n <= 4; n++) {
        const id = String(n)
        const basis = JSON.stringify({ policyVersion: 1, policyHash: 'a'.repeat(64), actorId: 7, repo: 'owner/repo', issue: n, eventId: id, kind: 'issue.opened' })
        db.prepare(`INSERT INTO github_events (event_id,project_id,repo,kind,actor_id,actor_login,issue,status,title,scope_json,basis_json,text,text_trust,text_sha256,event_at,received_at) VALUES (?,'p1','owner/repo','issue.opened',7,'alice',?,'pending','Title','["src"]',?,'body','untrusted',?,'2026-01-01','2026-01-01')`).run(id, n, basis, 'a'.repeat(64))
      }
      const saved: Array<{ action: string; event: string; id: string }> = []
      const terminal = new Map<string, string>()
      const invoke = (args: string[]) => spawnSync(process.execPath, [join(process.cwd(), 'supervisor/src/cli/main.ts'), ...args, '--state-dir', dir], { encoding: 'utf8', timeout: 15000 })
      const append = (kind: string, event: string) => {
        const id = randomUUID()
        const res = invoke(['github', kind, '--event', event, '--command-id', id])
        expect(res.status).toBe(0); saved.push({ action: kind, event, id })
        return id
      }
      const check = () => {
        const events = db.prepare('SELECT event_id,status,task_id,decided_by_command FROM github_events').all() as Array<{ event_id: string; status: string; task_id: string | null; decided_by_command: string | null }>
        for (const event of events) {
          const old = terminal.get(event.event_id)
          if (old) expect(event.status).toBe(old)
          if (event.status === 'approved' || event.status === 'rejected') terminal.set(event.event_id, event.status)
          const approvals = db.prepare("SELECT t.id FROM tasks t JOIN commands c ON c.id=t.created_by_command WHERE c.kind='github.approve' AND json_extract(c.payload_json,'$.eventId')=?").all(event.event_id) as Array<{id:string}>
          expect(approvals.length).toBeLessThanOrEqual(1)
          if (event.status === 'approved') {
            expect(approvals).toEqual([{ id: event.task_id }]); expect(event.decided_by_command).toBe(event.task_id)
          } else expect(approvals).toEqual([])
        }
        expect(db.prepare('SELECT command_id FROM command_outcomes GROUP BY command_id HAVING count(*) > 1').all()).toEqual([])
        const orphan = db.prepare("SELECT t.id FROM tasks t JOIN commands c ON c.id=t.created_by_command WHERE c.kind='github.approve' AND NOT EXISTS (SELECT 1 FROM github_events e WHERE e.project_id=t.project_id AND e.event_id=json_extract(c.payload_json,'$.eventId') AND e.status='approved' AND e.task_id=t.id AND e.decided_by_command=c.id)").all()
        expect(orphan).toEqual([])
      }
      const apply = () => {
        const handle = acquireSupervisor(db, dir, { nowMs: Date.now(), staleAfterMs: 300000 })
        try { applyPendingCommands(db, handle) } finally { handle.release(Date.now()) }
        check()
      }
      // Each run witnesses both terminal states, a duplicate and a non-GitHub create.
      const approved = append('approve', '1'); const rejected = append('reject', '2')
      const dup = invoke(['github', 'approve', '--event', '1', '--command-id', approved])
      expect(dup.status).toBe(0); expect(dup.stdout).toMatch(/\bduplicate\b/)
      expect(invoke(['task', 'create', '--title', 'ordinary', '--command-id', randomUUID()]).status).toBe(0)
      apply()
      expect(db.prepare('SELECT outcome FROM command_outcomes WHERE command_id=?').get(approved)).toEqual({ outcome: 'applied' })
      expect(db.prepare('SELECT outcome FROM command_outcomes WHERE command_id=?').get(rejected)).toEqual({ outcome: 'applied' })
      expect(terminal.get('1')).toBe('approved'); expect(terminal.get('2')).toBe('rejected')
      for (const a of actions) {
        if (a.kind === 'apply') apply()
        else if (a.kind === 'create') expect(invoke(['task', 'create', '--title', 'ordinary', '--command-id', randomUUID()]).status).toBe(0)
        else if (a.kind === 'duplicate') {
          const item = saved[a.event % saved.length]!
          const res = invoke(['github', item.action, '--event', item.event, '--command-id', item.id])
          expect(res.status).toBe(0); expect(res.stdout).toMatch(/\bduplicate\b/)
        } else append(a.kind, String(a.event))
        check()
      }
      apply()
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
  }), { numRuns: 10 })
}, 120000)
