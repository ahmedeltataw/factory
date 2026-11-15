import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openStore } from '../supervisor/src/app/store.ts'
import { parsePolicy, type Policy } from '../supervisor/src/sources/github/gate.ts'
import { createIngestState, ingestPoll } from '../supervisor/src/sources/github/ingest.ts'

const dirs: string[] = []
const DAY_MS = 86400000
const START = Date.parse('2026-11-14T12:00:00Z')

const basePolicyInput = {
  version: 1 as const,
  repos: [{ name: 'owner/repo', labels: ['factory'], scope: ['src/core'] }],
  actors: [
    { id: 101, login: 'alice' },
    { id: 102, login: 'bob' },
  ],
  command: '/factory task',
  maxPendingPerRepo: 10,
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  }
})

function setupDb(projectId = 'proj-test'): { db: DatabaseSync; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-m7-05-test-'))
  dirs.push(dir)
  const db = openStore(join(dir, 'state.sqlite'))
  db.exec(`INSERT INTO projects (id, name, created_at) VALUES ('${projectId}', 'Test', '2026-11-14T00:00:00.000Z')`)
  return { db, dir }
}

function makePolicy(limit?: number, pending = 10): Policy {
  const res = parsePolicy({
    ...basePolicyInput,
    maxPendingPerRepo: pending,
    ...(limit !== undefined ? { maxPerActorPerDay: limit } : {}),
  })
  if (!res.ok) throw new Error(res.reason)
  return res.policy
}

function makeEvent(id: number, actorId = 101, overrides: Record<string, unknown> = {}) {
  return {
    id: String(id),
    type: 'IssuesEvent',
    actor: { id: actorId, login: actorId === 101 ? 'alice' : 'bob', type: 'User' },
    repo: { name: 'owner/repo' },
    payload: {
      action: 'opened',
      issue: {
        number: id,
        title: `Issue ${id}`,
        body: `Body ${id}`,
        labels: [{ name: 'factory' }],
      },
    },
    created_at: '2026-11-14T12:00:00Z',
    ...overrides,
  }
}

function pollEvents(
  db: DatabaseSync,
  policy: Policy,
  events: ReturnType<typeof makeEvent>[],
  nowMs: number,
  projectId = 'proj-test',
  repo = 'owner/repo',
) {
  return ingestPoll(
    db,
    projectId,
    policy,
    repo,
    { kind: 'events', etag: 'etag-1', pollAfterMs: 60000, events },
    nowMs,
    createIngestState(),
  )
}

function selectEvents(db: DatabaseSync, projectId = 'proj-test') {
  return db.prepare(
    'SELECT event_id, actor_id, status, reason, title, scope_json, basis_json, received_at FROM github_events WHERE project_id = ? ORDER BY CAST(event_id AS INTEGER)',
  ).all(projectId) as {
    event_id: string
    actor_id: number
    status: string
    reason: string | null
    title: string | null
    scope_json: string | null
    basis_json: string | null
    received_at: string
  }[]
}

describe('M7-05: Policy parsing and validation', () => {
  it('accepts integer boundaries 1 and 1000, and typical values', () => {
    for (const val of [1, 20, 100, 1000]) {
      const parsed = parsePolicy({ ...basePolicyInput, maxPerActorPerDay: val })
      expect(parsed.ok).toBe(true)
      if (parsed.ok) {
        expect(parsed.policy.version).toBe(1)
        expect(parsed.policy.maxPerActorPerDay).toBe(val)
        expect(Object.isFrozen(parsed.policy)).toBe(true)
      }
    }
  })

  it('rejects invalid maxPerActorPerDay values with exact path reason', () => {
    const invalidValues = [0, 1001, -1, 1.5, NaN, Infinity, -Infinity, '1', '20', null, [], {}, false, true]
    for (const val of invalidValues) {
      const parsed = parsePolicy({ ...basePolicyInput, maxPerActorPerDay: val })
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) {
        expect(parsed.reason).toBe('maxPerActorPerDay')
      }
    }
  })

  it('omits maxPerActorPerDay when absent in input', () => {
    const parsed = parsePolicy(basePolicyInput)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.policy.maxPerActorPerDay).toBeUndefined()
      expect('maxPerActorPerDay' in parsed.policy).toBe(false)
    }
  })

  it('omits maxPerActorPerDay when explicitly undefined in input', () => {
    const parsed = parsePolicy({ ...basePolicyInput, maxPerActorPerDay: undefined })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.policy.maxPerActorPerDay).toBeUndefined()
      expect('maxPerActorPerDay' in parsed.policy).toBe(false)
    }
  })
})

describe('M7-05: Ingest daily actor budget enforcement', () => {
  it('rejects events when actor hits daily limit and preserves null title/scope for rejected rows', () => {
    const { db } = setupDb()
    try {
      const p = makePolicy(2)
      pollEvents(db, p, [makeEvent(1), makeEvent(2), makeEvent(3)], START)
      const rows = selectEvents(db)
      expect(rows).toHaveLength(3)

      expect(rows[0]).toMatchObject({
        event_id: '1',
        actor_id: 101,
        status: 'pending',
        reason: null,
        title: '#1 Issue 1',
      })
      expect(rows[1]).toMatchObject({
        event_id: '2',
        actor_id: 101,
        status: 'pending',
        reason: null,
        title: '#2 Issue 2',
      })
      expect(rows[2]).toMatchObject({
        event_id: '3',
        actor_id: 101,
        status: 'rejected',
        reason: 'actor-daily-limit',
        title: null,
        scope_json: null,
        basis_json: null,
      })
    } finally {
      db.close()
    }
  })

  it('isolates different actors so one actor reaching daily limit does not impact others', () => {
    const { db } = setupDb()
    try {
      const p = makePolicy(1)
      pollEvents(db, p, [makeEvent(1, 101), makeEvent(2, 101), makeEvent(3, 102), makeEvent(4, 102)], START)
      const rows = selectEvents(db)
      expect(rows.map((r) => [r.event_id, r.actor_id, r.status, r.reason])).toEqual([
        ['1', 101, 'pending', null],
        ['2', 101, 'rejected', 'actor-daily-limit'],
        ['3', 102, 'pending', null],
        ['4', 102, 'rejected', 'actor-daily-limit'],
      ])
    } finally {
      db.close()
    }
  })

  it('isolates different projects so actor usage in project A does not limit project B', () => {
    const { db } = setupDb('proj-a')
    try {
      db.exec("INSERT INTO projects (id, name, created_at) VALUES ('proj-b', 'Project B', '2026-11-14T00:00:00.000Z')")
      const p = makePolicy(1)

      pollEvents(db, p, [makeEvent(1, 101)], START, 'proj-a')
      pollEvents(db, p, [makeEvent(2, 101)], START, 'proj-a')

      pollEvents(db, p, [makeEvent(1, 101)], START, 'proj-b')
      pollEvents(db, p, [makeEvent(2, 101)], START, 'proj-b')

      const rowsA = selectEvents(db, 'proj-a')
      const rowsB = selectEvents(db, 'proj-b')

      expect(rowsA.map((r) => [r.status, r.reason])).toEqual([
        ['pending', null],
        ['rejected', 'actor-daily-limit'],
      ])
      expect(rowsB.map((r) => [r.status, r.reason])).toEqual([
        ['pending', null],
        ['rejected', 'actor-daily-limit'],
      ])
    } finally {
      db.close()
    }
  })

  it('respects exact rolling 24-hour boundary (received_at > nowMs - 86400000)', () => {
    const { db } = setupDb()
    try {
      const p = makePolicy(1)
      // Poll at START
      pollEvents(db, p, [makeEvent(1)], START)

      // Event at START + DAY_MS - 1: exactly within the 24-hour window (start > (start + day - 1) - day)
      pollEvents(db, p, [makeEvent(2)], START + DAY_MS - 1)

      // Event at START + DAY_MS: boundary is now start. (start > start) is false! Event 1 no longer counts.
      pollEvents(db, p, [makeEvent(3)], START + DAY_MS)

      const rows = selectEvents(db)
      expect(rows.map((r) => [r.status, r.reason])).toEqual([
        ['pending', null],
        ['rejected', 'actor-daily-limit'],
        ['pending', null],
      ])
    } finally {
      db.close()
    }
  })

  it('only approved and pending rows count toward the limit; ignored and rejected rows do not', () => {
    const { db } = setupDb()
    try {
      const stamp = new Date(START - 1000).toISOString()
      // Seed rows of various statuses
      db.prepare(`INSERT INTO github_events (event_id, project_id, repo, kind, actor_id, actor_login, issue, status, reason, title, scope_json, basis_json, text, text_trust, text_sha256, event_at, received_at)
        VALUES ('10', 'proj-test', 'owner/repo', 'issue.opened', 101, 'alice', 10, 'ignored', 'pending-limit', NULL, NULL, NULL, 'text', 'untrusted', 'hash', ?, ?)`).run(stamp, stamp)
      db.prepare(`INSERT INTO github_events (event_id, project_id, repo, kind, actor_id, actor_login, issue, status, reason, title, scope_json, basis_json, text, text_trust, text_sha256, event_at, received_at)
        VALUES ('11', 'proj-test', 'owner/repo', 'issue.opened', 101, 'alice', 11, 'rejected', 'manual', NULL, NULL, NULL, 'text', 'untrusted', 'hash', ?, ?)`).run(stamp, stamp)

      // Limit is 1. Neither ignored nor rejected count, so event 1 should be admitted as pending!
      const p = makePolicy(1)
      pollEvents(db, p, [makeEvent(1)], START)

      const rows = selectEvents(db)
      const event1 = rows.find((r) => r.event_id === '1')
      expect(event1).toMatchObject({
        status: 'pending',
        reason: null,
      })
    } finally {
      db.close()
    }
  })

  it('prioritizes gate rejection over actor daily limit', () => {
    const { db } = setupDb()
    try {
      const p = makePolicy(1)
      // First event consumes limit
      pollEvents(db, p, [makeEvent(1)], START)

      // Second event has disallowed label
      const unallowedLabelEvent = makeEvent(2, 101, {
        payload: {
          action: 'opened',
          issue: { number: 2, title: 'No Label', body: 'body', labels: [{ name: 'unrelated' }] },
        },
      })
      pollEvents(db, p, [unallowedLabelEvent], START + 10)

      const rows = selectEvents(db)
      expect(rows[1]).toMatchObject({
        event_id: '2',
        status: 'ignored',
        reason: 'label-not-allowed',
      })
    } finally {
      db.close()
    }
  })

  it('prioritizes actor daily limit over pending limit when both limits are reached', () => {
    const { db } = setupDb()
    try {
      // maxPerActorPerDay = 1, maxPendingPerRepo = 1
      const p = makePolicy(1, 1)

      // Event 1 admitted: pending count is 1, actor count is 1
      pollEvents(db, p, [makeEvent(1)], START)

      // Event 2: actor 101 has count 1 (>= limit 1) AND repo pending count is 1 (>= limit 1)
      // Actor daily limit must trigger 'rejected' with 'actor-daily-limit'
      pollEvents(db, p, [makeEvent(2)], START + 10)

      const rows = selectEvents(db)
      expect(rows.map((r) => [r.status, r.reason])).toEqual([
        ['pending', null],
        ['rejected', 'actor-daily-limit'],
      ])
    } finally {
      db.close()
    }
  })

  it('replaying a rejected event deduplicates and keeps exact stored row', () => {
    const { db } = setupDb()
    try {
      const p = makePolicy(1)
      pollEvents(db, p, [makeEvent(1), makeEvent(2)], START)
      const before = selectEvents(db)
      expect(before[1]).toMatchObject({
        event_id: '2',
        status: 'rejected',
        reason: 'actor-daily-limit',
      })

      // Replay in next poll 2 days later
      pollEvents(db, p, [makeEvent(2)], START + 2 * DAY_MS)
      const after = selectEvents(db)
      expect(after).toEqual(before)
    } finally {
      db.close()
    }
  })

  it('an unparsable received_at row does not count toward the daily limit and never throws', () => {
    const { db } = setupDb()
    try {
      const stamp = '2026-11-14T12:00:00Z'
      // Seed rows with various unparsable received_at strings for actor 101
      db.prepare(`INSERT INTO github_events (event_id, project_id, repo, kind, actor_id, actor_login, issue, status, reason, title, scope_json, basis_json, text, text_trust, text_sha256, event_at, received_at)
        VALUES ('90', 'proj-test', 'owner/repo', 'issue.opened', 101, 'alice', 1, 'approved', NULL, 'Title', '["src/core"]', '{}', 'Body', 'untrusted', 'hash', ?, 'not-a-date')`).run(stamp)
      db.prepare(`INSERT INTO github_events (event_id, project_id, repo, kind, actor_id, actor_login, issue, status, reason, title, scope_json, basis_json, text, text_trust, text_sha256, event_at, received_at)
        VALUES ('91', 'proj-test', 'owner/repo', 'issue.opened', 101, 'alice', 2, 'pending', NULL, 'Title', '["src/core"]', '{}', 'Body', 'untrusted', 'hash', ?, 'invalid-timestamp-xyz')`).run(stamp)

      // Policy limit is 1. If unparsable rows counted, actor 101 would have count 2 >= 1 and event 1 would be rejected.
      // Because unparsable rows do not count, event 1 must be admitted as pending without error.
      const p = makePolicy(1)
      expect(() => pollEvents(db, p, [makeEvent(1, 101)], START)).not.toThrow()

      const rows = selectEvents(db)
      const event1 = rows.find((r) => r.event_id === '1')
      expect(event1).toMatchObject({
        event_id: '1',
        status: 'pending',
        reason: null,
      })
    } finally {
      db.close()
    }
  })

  it('correctly handles offset timestamps: inside window counts, outside does not, and exact boundary does not count', () => {
    const stamp = '2026-11-14T12:00:00Z'
    const p = makePolicy(1)

    // START = 2026-11-14T12:00:00Z. Window boundary is START - 86400000 = 2026-11-13T12:00:00Z.
    // In UTC+02:00, 12:00:00 UTC corresponds to 14:00:00+02:00.

    // 1. Exact boundary with +02:00 offset: Date.parse === nowMs - 86400000 (must NOT count)
    {
      const { db } = setupDb()
      try {
        db.prepare(`INSERT INTO github_events (event_id, project_id, repo, kind, actor_id, actor_login, issue, status, reason, title, scope_json, basis_json, text, text_trust, text_sha256, event_at, received_at)
          VALUES ('80', 'proj-test', 'owner/repo', 'issue.opened', 101, 'alice', 1, 'approved', NULL, 'Title', '["src/core"]', '{}', 'Body', 'untrusted', 'hash', ?, '2026-11-13T14:00:00+02:00')`).run(stamp)
        pollEvents(db, p, [makeEvent(1, 101)], START)
        const event1 = selectEvents(db).find((r) => r.event_id === '1')
        expect(event1).toMatchObject({ status: 'pending', reason: null })
      } finally {
        db.close()
      }
    }

    // 2. Just outside the window with +02:00 offset: 1 second before boundary (must NOT count)
    {
      const { db } = setupDb()
      try {
        db.prepare(`INSERT INTO github_events (event_id, project_id, repo, kind, actor_id, actor_login, issue, status, reason, title, scope_json, basis_json, text, text_trust, text_sha256, event_at, received_at)
          VALUES ('81', 'proj-test', 'owner/repo', 'issue.opened', 101, 'alice', 1, 'approved', NULL, 'Title', '["src/core"]', '{}', 'Body', 'untrusted', 'hash', ?, '2026-11-13T13:59:59+02:00')`).run(stamp)
        pollEvents(db, p, [makeEvent(1, 101)], START)
        const event1 = selectEvents(db).find((r) => r.event_id === '1')
        expect(event1).toMatchObject({ status: 'pending', reason: null })
      } finally {
        db.close()
      }
    }

    // 3. Just inside the window with +02:00 offset: 1 second after boundary (MUST count)
    {
      const { db } = setupDb()
      try {
        db.prepare(`INSERT INTO github_events (event_id, project_id, repo, kind, actor_id, actor_login, issue, status, reason, title, scope_json, basis_json, text, text_trust, text_sha256, event_at, received_at)
          VALUES ('82', 'proj-test', 'owner/repo', 'issue.opened', 101, 'alice', 1, 'approved', NULL, 'Title', '["src/core"]', '{}', 'Body', 'untrusted', 'hash', ?, '2026-11-13T14:00:01+02:00')`).run(stamp)
        pollEvents(db, p, [makeEvent(1, 101)], START)
        const event1 = selectEvents(db).find((r) => r.event_id === '1')
        expect(event1).toMatchObject({ status: 'rejected', reason: 'actor-daily-limit' })
      } finally {
        db.close()
      }
    }

    // 4. Negative offset -05:00: inside the window (07:00:01-05:00 = 12:00:01 UTC) MUST count
    {
      const { db } = setupDb()
      try {
        db.prepare(`INSERT INTO github_events (event_id, project_id, repo, kind, actor_id, actor_login, issue, status, reason, title, scope_json, basis_json, text, text_trust, text_sha256, event_at, received_at)
          VALUES ('83', 'proj-test', 'owner/repo', 'issue.opened', 101, 'alice', 1, 'approved', NULL, 'Title', '["src/core"]', '{}', 'Body', 'untrusted', 'hash', ?, '2026-11-13T07:00:01-05:00')`).run(stamp)
        pollEvents(db, p, [makeEvent(1, 101)], START)
        const event1 = selectEvents(db).find((r) => r.event_id === '1')
        expect(event1).toMatchObject({ status: 'rejected', reason: 'actor-daily-limit' })
      } finally {
        db.close()
      }
    }

    // 5. Negative offset -05:00: exact boundary (07:00:00-05:00 = 12:00:00 UTC) must NOT count
    {
      const { db } = setupDb()
      try {
        db.prepare(`INSERT INTO github_events (event_id, project_id, repo, kind, actor_id, actor_login, issue, status, reason, title, scope_json, basis_json, text, text_trust, text_sha256, event_at, received_at)
          VALUES ('84', 'proj-test', 'owner/repo', 'issue.opened', 101, 'alice', 1, 'approved', NULL, 'Title', '["src/core"]', '{}', 'Body', 'untrusted', 'hash', ?, '2026-11-13T07:00:00-05:00')`).run(stamp)
        pollEvents(db, p, [makeEvent(1, 101)], START)
        const event1 = selectEvents(db).find((r) => r.event_id === '1')
        expect(event1).toMatchObject({ status: 'pending', reason: null })
      } finally {
        db.close()
      }
    }
  })

  it('updates in-memory count across multiple events in one poll without re-scanning DB', () => {
    const { db } = setupDb()
    try {
      const p = makePolicy(2)
      // 4 events for actor 101 in a single poll:
      // Event 1: admitted (pending, count becomes 1)
      // Event 2: admitted (pending, count becomes 2)
      // Event 3: limit reached (rejected actor-daily-limit, count stays 2)
      // Event 4: limit reached (rejected actor-daily-limit, count stays 2)
      // Event 5 for actor 102: admitted (pending, actor 102 count becomes 1)
      pollEvents(db, p, [
        makeEvent(1, 101),
        makeEvent(2, 101),
        makeEvent(3, 101),
        makeEvent(4, 101),
        makeEvent(5, 102),
      ], START)

      const rows = selectEvents(db)
      expect(rows.map((r) => [r.event_id, r.actor_id, r.status, r.reason])).toEqual([
        ['1', 101, 'pending', null],
        ['2', 101, 'pending', null],
        ['3', 101, 'rejected', 'actor-daily-limit'],
        ['4', 101, 'rejected', 'actor-daily-limit'],
        ['5', 102, 'pending', null],
      ])
    } finally {
      db.close()
    }
  })
})
