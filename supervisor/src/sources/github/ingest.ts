import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { normalizeEvent, sanitizeLine } from './event.ts'
import { gate, type Policy } from './gate.ts'
import type { PollResult } from './ports.ts'

export type IngestState = { errors: Map<string, number>; stopped: Set<string> }

export function createIngestState(): IngestState {
  return { errors: new Map(), stopped: new Set() }
}

function eventId(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = (raw as Record<string, unknown>).id
  return typeof id === 'string' && /^\d+$/.test(id) ? id : null
}

export function ingestPoll(db: DatabaseSync, projectId: string, policy: Policy, repo: string, result: PollResult, nowMs: number, state: IngestState): { nextPollMs: number; stopped: boolean } {
  const cursor = db.prepare('SELECT etag, next_poll_ms, error FROM github_cursor WHERE project_id = ? AND repo = ?').get(projectId, repo) as { etag: string | null; next_poll_ms: number; error: string | null } | undefined
  if (state.stopped.has(repo)) return { nextPollMs: cursor?.next_poll_ms ?? 0, stopped: true }

  const errors = result.kind === 'error' && result.retryable ? (state.errors.get(repo) ?? 0) + 1 : 0
  const delay = result.kind === 'error' ? Math.min(60000 * 2 ** Math.min(Math.max(errors - 1, 0), 4), 900000)
    : result.kind === 'rate-limited' ? result.retryAfterMs : Math.max(60000, result.pollAfterMs)
  const nextPollMs = nowMs + delay
  const now = new Date(nowMs).toISOString()
  const etag = result.kind === 'events' || result.kind === 'not-modified' ? result.etag : cursor?.etag ?? null
  const error = result.kind === 'error' ? sanitizeLine(result.message) : result.kind === 'rate-limited' ? cursor?.error ?? null : null

  db.exec('SAVEPOINT github_ingest')
  try {
    if (result.kind === 'events') {
      const items = result.events.map((raw) => ({ raw, id: eventId(raw) })).filter((item): item is { raw: unknown; id: string } => item.id !== null)
      items.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0)
      const exists = db.prepare('SELECT 1 FROM github_events WHERE project_id = ? AND event_id = ?')
      const pending = db.prepare("SELECT count(*) AS count FROM github_events WHERE project_id = ? AND repo = ? AND status = 'pending'")
      const insert = db.prepare(`INSERT INTO github_events (event_id, project_id, repo, kind, actor_id, actor_login, issue, status, reason, title, scope_json, basis_json, text, text_trust, text_sha256, event_at, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'untrusted', ?, ?, ?)`)
      for (const item of items) {
        if (exists.get(projectId, item.id)) continue
        const normalized = normalizeEvent(item.raw)
        if (!normalized.ok) {
          if (normalized.reason === 'unsupported-event') continue
          const text = ''
          insert.run(item.id, projectId, repo, 'issue.opened', 0, '', 0, 'ignored', 'malformed', null, null, null, text, createHash('sha256').update(text).digest('hex'), now, now)
          continue
        }
        const event = normalized.event
        const decision = gate(policy, event)
        const count = (pending.get(projectId, event.repo) as { count: number }).count
        const admitted = decision.admit && count < policy.maxPendingPerRepo
        const reason = !decision.admit ? decision.reason : admitted ? null : 'pending-limit'
        insert.run(event.eventId, projectId, event.repo, event.kind, event.actor.id, event.actor.login, event.issue,
          admitted ? 'pending' : 'ignored', reason, admitted && decision.admit ? decision.title : null,
          admitted && decision.admit ? JSON.stringify(decision.scope) : null, admitted && decision.admit ? JSON.stringify(decision.basis) : null,
          event.text, createHash('sha256').update(event.text).digest('hex'), new Date(event.createdAtMs).toISOString(), now)
      }
    }
    db.prepare(`INSERT INTO github_cursor (project_id, repo, etag, next_poll_ms, error, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, repo) DO UPDATE SET etag = excluded.etag, next_poll_ms = excluded.next_poll_ms, error = excluded.error, updated_at = excluded.updated_at`)
      .run(projectId, repo, etag, nextPollMs, error, now)
    db.exec('RELEASE SAVEPOINT github_ingest')
  } catch (error) {
    try { db.exec('ROLLBACK TO SAVEPOINT github_ingest'); db.exec('RELEASE SAVEPOINT github_ingest') } catch { /* transaction may already have ended */ }
    throw error
  }
  if (errors) state.errors.set(repo, errors)
  else if (result.kind !== 'error') state.errors.delete(repo)
  const stopped = result.kind === 'error' && !result.retryable
  if (stopped) state.stopped.add(repo)
  return { nextPollMs, stopped }
}
