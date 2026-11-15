import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import fc from 'fast-check'
import { openStore } from '../../supervisor/src/app/store.ts'
import { parsePolicy, type Policy } from '../../supervisor/src/sources/github/gate.ts'
import { createIngestState, ingestPoll } from '../../supervisor/src/sources/github/ingest.ts'

const dirs: string[] = []
const day = 86400000
const start = Date.parse('2026-11-13T10:00:00Z')
const base = {
  version: 1 as const,
  repos: [{ name: 'owner/repo', labels: ['factory'], scope: ['src/core'] }],
  actors: [{ id: 101, login: 'alice' }, { id: 102, login: 'bob' }],
  command: '/factory task', maxPendingPerRepo: 100,
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'factory-m7-intake-'))
  dirs.push(dir)
  const db = openStore(join(dir, 'state.sqlite'))
  db.exec("INSERT INTO projects (id, name, created_at) VALUES ('p', 'Test', '2026-11-13T00:00:00.000Z')")
  return db
}

// The cast keeps behavioral tests runnable before Policy includes the frozen field.
function policy(limit?: number, pending = 100): Policy {
  return { ...base, maxPendingPerRepo: pending, ...(limit === undefined ? {} : { maxPerActorPerDay: limit }) } as Policy
}

function event(id: number, actor = 101) {
  return {
    id: String(id), type: 'IssuesEvent', actor: { id: actor, login: actor === 101 ? 'alice' : 'bob', type: 'User' },
    repo: { name: 'owner/repo' }, payload: { action: 'opened', issue: { number: id, title: `Issue ${id}`, body: 'Body', labels: [{ name: 'factory' }] } },
    created_at: '2026-11-13T10:00:00Z',
  }
}

function poll(db: DatabaseSync, p: Policy, events: ReturnType<typeof event>[], now: number): void {
  ingestPoll(db, 'p', p, 'owner/repo', { kind: 'events', etag: 'e', pollAfterMs: 60000, events }, now, createIngestState())
}

function rows(db: DatabaseSync) {
  return db.prepare('SELECT event_id, actor_id, status, reason, received_at FROM github_events WHERE project_id = ? ORDER BY CAST(event_id AS INTEGER)').all('p') as { event_id: string; actor_id: number; status: string; reason: string | null; received_at: string }[]
}

it('CHK-M7-05-a: validates optional daily policy limit and preserves M6 behavior when absent', () => {
  for (const value of [1, 1000]) {
    const result = parsePolicy({ ...base, maxPerActorPerDay: value })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.policy.version).toBe(1)
  }
  for (const value of [0, 1001, 1.5, '1', null]) expect(parsePolicy({ ...base, maxPerActorPerDay: value }).ok).toBe(false)
  const parsed = parsePolicy({ ...base, maxPendingPerRepo: 2 })
  expect(parsed.ok).toBe(true)
  if (!parsed.ok) throw new Error(parsed.reason)
  const db = setup()
  try {
    poll(db, parsed.policy, [event(1), event(2), event(3)], start)
    expect(rows(db).map(({ status, reason }) => [status, reason])).toEqual([['pending', null], ['pending', null], ['ignored', 'pending-limit']])
  } finally { db.close() }
})

function seedEvent(db: DatabaseSync, status: 'approved' | 'rejected' | 'ignored', receivedAt: number): void {
  const stamp = new Date(receivedAt).toISOString()
  db.prepare(`INSERT INTO github_events (event_id, project_id, repo, kind, actor_id, actor_login, issue, status, reason, title, scope_json, basis_json, text, text_trust, text_sha256, event_at, received_at)
    VALUES ('1', 'p', 'owner/repo', 'issue.opened', 101, 'alice', 1, ?, NULL, 'Title', '["src/core"]', '{}', 'Body', 'untrusted', 'hash', ?, ?)`).run(status, stamp, stamp)
}

it('CHK-M7-05-b: a recent seeded approved event counts toward the limit', () => {
  for (const limit of [undefined, 1]) {
    const db = setup()
    try {
      seedEvent(db, 'approved', start - 1)
      expect(rows(db)[0]).toMatchObject({ actor_id: 101, status: 'approved', received_at: new Date(start - 1).toISOString() })
      poll(db, policy(limit), [event(2)], start)
      expect(rows(db)[1]).toMatchObject(limit === undefined
        ? { event_id: '2', status: 'pending', reason: null }
        : { event_id: '2', status: 'rejected', reason: 'actor-daily-limit' })
    } finally { db.close() }
  }
})

it.each([
  ['old approved', 'approved', start - day - 1],
  ['recent rejected', 'rejected', start - 1],
  ['recent ignored', 'ignored', start - 1],
] as const)('CHK-M7-05-b: %s event does not count toward the limit', (_label, status, receivedAt) => {
  const db = setup()
  try {
    seedEvent(db, status, receivedAt)
    expect(rows(db)[0]).toMatchObject({ actor_id: 101, status, received_at: new Date(receivedAt).toISOString() })
    poll(db, policy(1), [event(2)], start)
    expect(rows(db)[1]).toMatchObject({ event_id: '2', status: 'pending', reason: null })
  } finally { db.close() }
})

it('CHK-M7-05-b: counts each event within one poll and isolates actors', () => {
  const db = setup()
  try {
    poll(db, policy(2), [event(3), event(1), event(2), event(4, 102)], start)
    expect(rows(db).map(({ status, reason }) => [status, reason])).toEqual([
      ['pending', null], ['pending', null], ['rejected', 'actor-daily-limit'], ['pending', null],
    ])
  } finally { db.close() }
})

it('CHK-M7-05-b: counts across polls and excludes rejected rows', () => {
  const db = setup()
  try {
    poll(db, policy(2), [event(1), event(2)], start)
    poll(db, policy(2), [event(3)], start + 1)
    db.prepare("UPDATE github_events SET status = 'rejected', reason = 'manual' WHERE project_id = 'p' AND event_id = '1'").run()
    poll(db, policy(2), [event(4), event(5)], start + 2)
    expect(rows(db).map(({ status, reason }) => [status, reason])).toEqual([
      ['rejected', 'manual'], ['pending', null], ['rejected', 'actor-daily-limit'], ['pending', null], ['rejected', 'actor-daily-limit'],
    ])
  } finally { db.close() }
})

it('CHK-M7-05-b: uses a strict 24-hour boundary', () => {
  const db = setup()
  try {
    poll(db, policy(1), [event(1)], start)
    poll(db, policy(1), [event(2)], start + day - 1)
    poll(db, policy(1), [event(3)], start + day)
    expect(rows(db).map(({ status, reason }) => [status, reason])).toEqual([
      ['pending', null], ['rejected', 'actor-daily-limit'], ['pending', null],
    ])
  } finally { db.close() }
})

it('CHK-M7-05-c: stores and deduplicates a rejected event on replay', () => {
  const db = setup()
  try {
    poll(db, policy(1), [event(1), event(2)], start)
    const before = rows(db)
    expect(before[1]).toMatchObject({ event_id: '2', status: 'rejected', reason: 'actor-daily-limit' })
    poll(db, policy(1), [event(2)], start + day + 1)
    expect(rows(db)).toEqual(before)
  } finally { db.close() }
})

it('CHK-M7-05-c: both configured limits independently enforce their reasons', () => {
  const db = setup()
  try {
    poll(db, policy(1, 2), [event(1), event(2), event(3, 102)], start)
    expect(rows(db).map(({ status, reason }) => [status, reason])).toEqual([
      ['pending', null], ['rejected', 'actor-daily-limit'], ['pending', null],
    ])
    // A fresh actor budget with the repository already full reaches the M6 pending limit.
    poll(db, policy(2, 2), [event(5, 102)], start + 1)
    expect(rows(db)[3]).toMatchObject({ status: 'ignored', reason: 'pending-limit' })
  } finally { db.close() }
})

it('CHK-M7-05-b: property - admitted rows never exceed the actor limit in a rolling day', () => {
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 4 }),
    fc.array(fc.record({ actor: fc.constantFrom(101, 102), advance: fc.integer({ min: 0, max: day }) }), { minLength: 1, maxLength: 20 }),
    (limit, stream) => {
      const db = setup()
      try {
        let now = start
        for (const [index, item] of stream.entries()) {
          now += item.advance
          poll(db, policy(limit), [event(index + 1, item.actor)], now)
          const admitted = rows(db).filter((row) => row.actor_id === item.actor && (row.status === 'pending' || row.status === 'approved') && Date.parse(row.received_at) > now - day)
          expect(admitted.length).toBeLessThanOrEqual(limit)
        }
      } finally { db.close() }
    },
  ), { numRuns: 30 })
})

