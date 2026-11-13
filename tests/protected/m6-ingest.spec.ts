import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openStore } from '../../supervisor/src/app/store.ts'
import { parsePolicy, type Policy } from '../../supervisor/src/sources/github/gate.ts'
import { sanitizeLine } from '../../supervisor/src/sources/github/event.ts'
import type { GitHubPort, PollResult } from '../../supervisor/src/sources/github/ports.ts'
import { createIngestState, ingestPoll, type IngestState } from '../../supervisor/src/sources/github/ingest.ts'
import { createFakeGitHub } from '../../supervisor/src/sources/github/fake.ts'

const directories: string[] = []

function databaseDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-m6-ingest-'))
  directories.push(dir)
  return dir
}

function databasePath(): string {
  return join(databaseDir(), 'state.sqlite')
}

afterEach(() => {
  for (const dir of directories.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore deletion errors in cleanup
    }
  }
})

function setupDatabase(): { db: DatabaseSync; path: string } {
  const path = databasePath()
  const db = openStore(path)
  db.exec("INSERT INTO projects (id, name, created_at) VALUES ('p', 'Test Project', '2026-11-13T00:00:00.000Z')")
  return { db, path }
}

function parseTestPolicy(overrides: Record<string, unknown> = {}): { policy: Policy; hash: string } {
  const result = parsePolicy({
    version: 1,
    repos: [
      { name: 'owner/repo', labels: ['factory', 'bug'], scope: ['src/core', 'docs'] },
      { name: 'owner/other', labels: ['task'], scope: ['.'] },
    ],
    actors: [
      { id: 101, login: 'alice' },
      { id: 102, login: 'bob' },
    ],
    command: '/factory task',
    maxPendingPerRepo: 2,
    ...overrides,
  })
  if (!result.ok) throw new Error(`Invalid test policy: ${result.reason}`)
  return { policy: result.policy, hash: result.hash }
}

function testPolicy(overrides: Record<string, unknown> = {}): Policy {
  return parseTestPolicy(overrides).policy
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function makeIssuesPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '10001',
    type: 'IssuesEvent',
    actor: { id: 101, login: 'alice', type: 'User' },
    repo: { name: 'owner/repo' },
    payload: {
      action: 'opened',
      issue: {
        number: 42,
        title: 'Initial bug report',
        body: 'Details of the bug',
        labels: [{ name: 'factory' }],
      },
    },
    created_at: '2026-11-13T10:00:00Z',
    ...overrides,
  }
}

function makeCommentPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '20001',
    type: 'IssueCommentEvent',
    actor: { id: 101, login: 'alice', type: 'User' },
    repo: { name: 'owner/repo' },
    payload: {
      action: 'created',
      issue: {
        number: 42,
        title: 'Initial bug report',
        body: 'Details of the bug',
        labels: [{ name: 'factory' }],
      },
      comment: {
        id: 555,
        body: '/factory task Implement widget',
      },
    },
    created_at: '2026-11-13T10:05:00Z',
    ...overrides,
  }
}

describe('M6-03 CHK-M6-03-a: fake GitHub port', () => {
  it('CHK-M6-03-a: fake port pushes events, computes etag e<count>, and returns events newest first', async () => {
    const fake = createFakeGitHub()
    expect(fake.calls).toEqual([])

    const event1 = makeIssuesPayload({ id: '101' })
    const event2 = makeIssuesPayload({ id: '102' })
    fake.push('owner/repo', [event1, event2])

    const res1 = await fake.poll({ repo: 'owner/repo', etag: null })
    expect(res1).toEqual({
      kind: 'events',
      etag: 'e2',
      pollAfterMs: 60000,
      events: [event2, event1],
    })
    expect(fake.calls).toEqual([{ repo: 'owner/repo', etag: null }])

    const event3 = makeCommentPayload({ id: '103' })
    fake.push('owner/repo', [event3])

    const res2 = await fake.poll({ repo: 'owner/repo', etag: 'e2' })
    expect(res2).toEqual({
      kind: 'events',
      etag: 'e3',
      pollAfterMs: 60000,
      events: [event3, event2, event1],
    })
    expect(fake.calls).toEqual([
      { repo: 'owner/repo', etag: null },
      { repo: 'owner/repo', etag: 'e2' },
    ])
  })

  it('CHK-M6-03-a: fake port returns not-modified when sent etag equals current etag', async () => {
    const fake = createFakeGitHub()
    fake.push('owner/repo', [makeIssuesPayload({ id: '101' })])

    const res = await fake.poll({ repo: 'owner/repo', etag: 'e1' })
    expect(res).toEqual({
      kind: 'not-modified',
      etag: 'e1',
      pollAfterMs: 60000,
    })
    expect(fake.calls).toEqual([{ repo: 'owner/repo', etag: 'e1' }])
  })

  it('CHK-M6-03-a: fake port unknown repo behaves as repo with no events and etag e0', async () => {
    const fake = createFakeGitHub()

    const res1 = await fake.poll({ repo: 'unseen/repo', etag: null })
    expect(res1).toEqual({
      kind: 'events',
      etag: 'e0',
      pollAfterMs: 60000,
      events: [],
    })

    const res2 = await fake.poll({ repo: 'unseen/repo', etag: 'e0' })
    expect(res2).toEqual({
      kind: 'not-modified',
      etag: 'e0',
      pollAfterMs: 60000,
    })
    expect(fake.calls).toEqual([
      { repo: 'unseen/repo', etag: null },
      { repo: 'unseen/repo', etag: 'e0' },
    ])
  })

  it('CHK-M6-03-a: fake port isolates events, etags, and scripts per repo and logs all poll calls', async () => {
    const fake = createFakeGitHub()
    expect(fake.calls).toEqual([])

    const eventA1 = makeIssuesPayload({ id: '101' })
    const eventA2 = makeIssuesPayload({ id: '102' })
    const eventB1 = makeCommentPayload({ id: '201', repo: { name: 'owner/other' } })

    fake.push('owner/repo', [eventA1, eventA2])
    fake.push('owner/other', [eventB1])

    const rateLimitedA: PollResult = { kind: 'rate-limited', retryAfterMs: 75000 }
    const errorResultA: PollResult = { kind: 'error', retryable: true, message: 'socket timeout repo A' }
    const errorResultB: PollResult = { kind: 'error', retryable: false, message: 'fatal repo B' }

    fake.script('owner/repo', rateLimitedA)
    fake.script('owner/repo', errorResultA)
    fake.script('owner/other', errorResultB)

    // Interleave calls between repo A and repo B to verify FIFO script order, isolation, and call logging
    const resA1 = await fake.poll({ repo: 'owner/repo', etag: null })
    expect(resA1).toEqual(rateLimitedA)

    const resB1 = await fake.poll({ repo: 'owner/other', etag: null })
    expect(resB1).toEqual(errorResultB)

    // Second scripted result for repo A verifies FIFO order in script queue
    const resA2 = await fake.poll({ repo: 'owner/repo', etag: null })
    expect(resA2).toEqual(errorResultA)

    // Script queue for repo A is now exhausted; subsequent poll falls back to pushed events
    const resA3 = await fake.poll({ repo: 'owner/repo', etag: null })
    expect(resA3).toEqual({
      kind: 'events',
      etag: 'e2',
      pollAfterMs: 60000,
      events: [eventA2, eventA1],
    })

    // Script queue for repo B is also exhausted; falls back to pushed events
    const resB2 = await fake.poll({ repo: 'owner/other', etag: null })
    expect(resB2).toEqual({
      kind: 'events',
      etag: 'e1',
      pollAfterMs: 60000,
      events: [eventB1],
    })

    const resA4 = await fake.poll({ repo: 'owner/repo', etag: 'e2' })
    expect(resA4).toEqual({
      kind: 'not-modified',
      etag: 'e2',
      pollAfterMs: 60000,
    })

    const resB3 = await fake.poll({ repo: 'owner/other', etag: 'e1' })
    expect(resB3).toEqual({
      kind: 'not-modified',
      etag: 'e1',
      pollAfterMs: 60000,
    })

    expect(fake.calls).toEqual([
      { repo: 'owner/repo', etag: null },
      { repo: 'owner/other', etag: null },
      { repo: 'owner/repo', etag: null },
      { repo: 'owner/repo', etag: null },
      { repo: 'owner/other', etag: null },
      { repo: 'owner/repo', etag: 'e2' },
      { repo: 'owner/other', etag: 'e1' },
    ])
  })

  it('CHK-M6-03-a: fake port call log contains no token and port exposes no write method', async () => {
    const fake = createFakeGitHub()
    await fake.poll({ repo: 'owner/repo', etag: 'e0' })

    expect(fake.calls).toEqual([{ repo: 'owner/repo', etag: 'e0' }])
    const callJson = JSON.stringify(fake.calls)
    expect(callJson).not.toMatch(/token/i)
    expect(callJson).not.toMatch(/bearer/i)
    expect(callJson).not.toMatch(/secret/i)

    const portObj = fake as unknown as Record<string, unknown>
    expect(typeof portObj.poll).toBe('function')
    expect(portObj.write).toBeUndefined()
    expect(portObj.post).toBeUndefined()
    expect(portObj.put).toBeUndefined()
    expect(portObj.delete).toBeUndefined()
    expect(portObj.create).toBeUndefined()
    expect(portObj.update).toBeUndefined()
  })
})

describe('M6-03 CHK-M6-03-b: event storage, normalisation, gate, and atomic transaction', () => {
  it('CHK-M6-03-b: stores admitted issue.comment as pending with exact columns, policy scope, and cursor update', () => {
    const { db } = setupDatabase()
    const { policy, hash: expectedPolicyHash } = parseTestPolicy()
    const state = createIngestState()
    const raw = makeCommentPayload({
      id: '20001',
      payload: {
        action: 'created',
        issue: { number: 42, title: 'Bug title', body: 'Issue body', labels: [{ name: 'factory' }] },
        comment: { id: 555, body: '/factory task Implement feature\nIgnore line 2' },
      },
      created_at: '2026-11-13T10:05:00Z',
    })

    const nowMs = 1700000000000
    const pollResult: PollResult = { kind: 'events', etag: 'e1', pollAfterMs: 60000, events: [raw] }
    const out = ingestPoll(db, 'p', policy, 'owner/repo', pollResult, nowMs, state)

    expect(out).toEqual({ nextPollMs: nowMs + 60000, stopped: false })

    const row = db.prepare("SELECT * FROM github_events WHERE project_id = 'p' AND event_id = '20001'").get() as Record<string, unknown>
    expect(row).toBeDefined()
    expect(row.event_id).toBe('20001')
    expect(row.project_id).toBe('p')
    expect(row.repo).toBe('owner/repo')
    expect(row.kind).toBe('issue.comment')
    expect(row.actor_id).toBe(101)
    expect(row.actor_login).toBe('alice')
    expect(row.issue).toBe(42)
    expect(row.status).toBe('pending')
    expect(row.reason).toBeNull()
    expect(row.title).toBe('Implement feature')
    expect(JSON.parse(String(row.scope_json))).toEqual(['src/core', 'docs'])
    expect(row.text).toBe('/factory task Implement feature\nIgnore line 2')
    expect(row.text_trust).toBe('untrusted')
    expect(row.text_sha256).toBe(sha256Hex('/factory task Implement feature\nIgnore line 2'))
    expect(Date.parse(String(row.event_at))).toBe(Date.parse('2026-11-13T10:05:00Z'))
    expect(Date.parse(String(row.received_at))).toBe(nowMs)
    expect(row.decided_at).toBeNull()
    expect(row.decided_by_command).toBeNull()
    expect(row.task_id).toBeNull()

    const basis = JSON.parse(String(row.basis_json)) as Record<string, unknown>
    expect(basis.policyVersion).toBe(1)
    expect(basis.policyHash).toBe(expectedPolicyHash)
    expect(basis.actorId).toBe(101)
    expect(basis.repo).toBe('owner/repo')
    expect(basis.issue).toBe(42)
    expect(basis.eventId).toBe('20001')
    expect(basis.kind).toBe('issue.comment')

    const cursor = db.prepare("SELECT * FROM github_cursor WHERE project_id = 'p' AND repo = 'owner/repo'").get() as Record<string, unknown>
    expect(cursor).toBeDefined()
    expect(cursor.project_id).toBe('p')
    expect(cursor.repo).toBe('owner/repo')
    expect(cursor.etag).toBe('e1')
    expect(cursor.next_poll_ms).toBe(nowMs + 60000)
    expect(cursor.error).toBeNull()
    expect(Date.parse(String(cursor.updated_at))).toBe(nowMs)
  })

  it('CHK-M6-03-b: stores admitted issue.opened as pending with issue title and policy scope', () => {
    const { db } = setupDatabase()
    const policy = testPolicy()
    const state = createIngestState()
    const raw = makeIssuesPayload({
      id: '10001',
      payload: {
        action: 'opened',
        issue: { number: 7, title: 'Crash on boot', body: 'Steps to reproduce', labels: [{ name: 'bug' }] },
      },
      created_at: '2026-11-13T10:00:00Z',
    })

    const nowMs = 1700000000000
    const pollResult: PollResult = { kind: 'events', etag: 'e1', pollAfterMs: 60000, events: [raw] }
    ingestPoll(db, 'p', policy, 'owner/repo', pollResult, nowMs, state)

    const row = db.prepare("SELECT * FROM github_events WHERE project_id = 'p' AND event_id = '10001'").get() as Record<string, unknown>
    expect(row.status).toBe('pending')
    expect(row.title).toBe('#7 Crash on boot')
    expect(JSON.parse(String(row.scope_json))).toEqual(['src/core', 'docs'])
    expect(row.reason).toBeNull()
    expect(row.text).toBe('Steps to reproduce')
    expect(row.text_sha256).toBe(sha256Hex('Steps to reproduce'))
  })

  it('CHK-M6-03-b: stores gated-out events as ignored with reason, null title, and null scope_json', () => {
    const { db } = setupDatabase()
    const policy = testPolicy()
    const state = createIngestState()

    const cases = [
      {
        id: '30001',
        name: 'label-not-allowed',
        event: makeCommentPayload({
          id: '30001',
          payload: {
            action: 'created',
            issue: { number: 1, title: 'T', body: 'B', labels: [{ name: 'other' }] },
            comment: { id: 1, body: '/factory task Work' },
          },
        }),
      },
      {
        id: '30002',
        name: 'actor-not-allowed',
        event: makeCommentPayload({
          id: '30002',
          actor: { id: 999, login: 'charlie', type: 'User' },
        }),
      },
      {
        id: '30003',
        name: 'bot-actor',
        event: makeCommentPayload({
          id: '30003',
          actor: { id: 101, login: 'alice[bot]', type: 'User' },
        }),
      },
      {
        id: '30004',
        name: 'no-command',
        event: makeCommentPayload({
          id: '30004',
          payload: {
            action: 'created',
            issue: { number: 1, title: 'T', body: 'B', labels: [{ name: 'factory' }] },
            comment: { id: 1, body: 'Not a command line' },
          },
        }),
      },
      {
        id: '30005',
        name: 'empty-title',
        event: makeCommentPayload({
          id: '30005',
          payload: {
            action: 'created',
            issue: { number: 1, title: 'Issue Title', body: 'B', labels: [{ name: 'factory' }] },
            comment: { id: 1, body: '/factory task \u200B\u200C\u200D' },
          },
        }),
      },
    ]

    for (const c of cases) {
      ingestPoll(db, 'p', policy, 'owner/repo', { kind: 'events', etag: `e-${c.id}`, pollAfterMs: 60000, events: [c.event] }, 100000, state)
      const row = db.prepare("SELECT * FROM github_events WHERE project_id = 'p' AND event_id = ?").get(c.id) as Record<string, unknown>
      expect(row).toBeDefined()
      expect(row.status).toBe('ignored')
      expect(row.reason).toBe(c.name)
      expect(row.title).toBeNull()
      expect(row.scope_json).toBeNull()
      expect(row.text_trust).toBe('untrusted')
      expect(row.text_sha256).toBe(sha256Hex(String(row.text)))
    }
  })

  it('CHK-M6-03-b: unsupported event types and PR comments are not stored in github_events', () => {
    const { db } = setupDatabase()
    const policy = testPolicy()
    const state = createIngestState()

    const unsupportedEvents = [
      { id: '40001', type: 'WatchEvent', actor: { id: 101, login: 'alice' }, repo: { name: 'owner/repo' }, payload: {} },
      makeIssuesPayload({ id: '40002', payload: { action: 'closed', issue: { number: 1, title: 'T', labels: [{ name: 'factory' }] } } }),
      makeCommentPayload({
        id: '40003',
        payload: {
          action: 'created',
          issue: { number: 1, title: 'PR comment', labels: [{ name: 'factory' }], pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/1' } },
          comment: { id: 1, body: '/factory task PR work' },
        },
      }),
      makeIssuesPayload({ id: '40004', payload: { action: 'labeled', issue: { number: 1, title: 'T', labels: [{ name: 'factory' }] } } }),
    ]

    const out = ingestPoll(db, 'p', policy, 'owner/repo', { kind: 'events', etag: 'e4', pollAfterMs: 60000, events: unsupportedEvents }, 100000, state)
    expect(out.stopped).toBe(false)

    const count = db.prepare("SELECT count(*) as count FROM github_events WHERE project_id = 'p'").get() as { count: number }
    expect(count.count).toBe(0)

    const cursor = db.prepare("SELECT etag FROM github_cursor WHERE project_id = 'p' AND repo = 'owner/repo'").get() as { etag: string }
    expect(cursor.etag).toBe('e4')
  })

  it('CHK-M6-03-b: malformed event stored as ignored only if readable decimal event id is present', () => {
    const { db } = setupDatabase()
    const policy = testPolicy()
    const state = createIngestState()

    const events = [
      { id: '50001', type: 'IssuesEvent', payload: null },
      { type: 'IssuesEvent', payload: {} },
      { id: 'not-a-number', type: 'IssuesEvent', payload: {} },
      null,
      12345,
    ]

    ingestPoll(db, 'p', policy, 'owner/repo', { kind: 'events', etag: 'e5', pollAfterMs: 60000, events }, 100000, state)

    const rows = db.prepare("SELECT event_id, status, reason FROM github_events WHERE project_id = 'p'").all() as { event_id: string; status: string; reason: string }[]
    expect(rows).toEqual([
      { event_id: '50001', status: 'ignored', reason: 'malformed' },
    ])
  })

  it('CHK-M6-03-b: cursor moves in the same transaction as event rows', () => {
    const { db } = setupDatabase()
    const policy = testPolicy()
    const state = createIngestState()
    const raw = makeIssuesPayload({ id: '60001' })

    const nowMs = 1700000000000
    ingestPoll(db, 'p', policy, 'owner/repo', { kind: 'events', etag: 'e-cursor', pollAfterMs: 65000, events: [raw] }, nowMs, state)

    const event = db.prepare("SELECT event_id FROM github_events WHERE project_id = 'p' AND event_id = '60001'").get()
    const cursor = db.prepare("SELECT etag, next_poll_ms FROM github_cursor WHERE project_id = 'p' AND repo = 'owner/repo'").get() as { etag: string; next_poll_ms: number }

    expect(event).toBeDefined()
    expect(cursor.etag).toBe('e-cursor')
    expect(cursor.next_poll_ms).toBe(nowMs + 65000)
  })

  it('CHK-M6-03-b: failure injected after first event rolls back earlier rows and leaves cursor unchanged', () => {
    const { db } = setupDatabase()
    const policy = testPolicy()
    const state = createIngestState()

    // Seed initial cursor to verify it remains unchanged on rollback
    db.exec("INSERT INTO github_cursor (project_id, repo, etag, next_poll_ms, error, updated_at) VALUES ('p', 'owner/repo', 'e-initial', 50000, NULL, '2026-11-13T00:00:00.000Z')")

    // Abort the transaction on the second event insert, testing that the first inserted event is rolled back
    db.exec(`
      CREATE TRIGGER test_inject_failure_on_second
      AFTER INSERT ON github_events
      WHEN (SELECT count(*) FROM github_events) = 2
      BEGIN
        SELECT RAISE(ABORT, 'injected transaction failure on second event insert');
      END;
    `)

    const e1 = makeIssuesPayload({ id: '70001' })
    const e2 = makeIssuesPayload({ id: '70002' })

    expect(() => {
      ingestPoll(db, 'p', policy, 'owner/repo', { kind: 'events', etag: 'e-fail', pollAfterMs: 60000, events: [e1, e2] }, 100000, state)
    }).toThrow(/injected transaction failure/)

    // Both rows must be absent due to transaction rollback
    const eventCount = db.prepare("SELECT count(*) as count FROM github_events WHERE project_id = 'p'").get() as { count: number }
    expect(eventCount.count).toBe(0)

    // Cursor must remain exactly as seeded
    const cursor = db.prepare("SELECT * FROM github_cursor WHERE project_id = 'p' AND repo = 'owner/repo'").get() as Record<string, unknown>
    expect(cursor.etag).toBe('e-initial')
    expect(cursor.next_poll_ms).toBe(50000)
    expect(cursor.error).toBeNull()
    expect(Date.parse(String(cursor.updated_at))).toBe(Date.parse('2026-11-13T00:00:00.000Z'))

    db.exec('DROP TRIGGER test_inject_failure_on_second')
  })
})

describe('M6-03 CHK-M6-03-c: dedupe and ordering', () => {
  it('CHK-M6-03-c: duplicate event id in the same page produces single row', () => {
    const { db } = setupDatabase()
    const policy = testPolicy()
    const state = createIngestState()
    const e1 = makeIssuesPayload({ id: '80001' })
    const e1Dup = makeIssuesPayload({ id: '80001', payload: { action: 'opened', issue: { number: 42, title: 'Diff', labels: [{ name: 'factory' }] } } })

    ingestPoll(db, 'p', policy, 'owner/repo', { kind: 'events', etag: 'e1', pollAfterMs: 60000, events: [e1, e1Dup] }, 100000, state)

    const rows = db.prepare("SELECT event_id FROM github_events WHERE project_id = 'p' AND event_id = '80001'").all()
    expect(rows).toHaveLength(1)
  })

  it('CHK-M6-03-c: duplicate event id across polls is ignored on subsequent poll', () => {
    const { db } = setupDatabase()
    const policy = testPolicy()
    const state = createIngestState()
    const e1 = makeIssuesPayload({ id: '81001', payload: { action: 'opened', issue: { number: 1, title: 'First', labels: [{ name: 'factory' }] } } })
    const e2 = makeIssuesPayload({ id: '81002', payload: { action: 'opened', issue: { number: 2, title: 'Second', labels: [{ name: 'factory' }] } } })

    ingestPoll(db, 'p', policy, 'owner/repo', { kind: 'events', etag: 'e1', pollAfterMs: 60000, events: [e1] }, 100000, state)
    ingestPoll(db, 'p', policy, 'owner/repo', { kind: 'events', etag: 'e2', pollAfterMs: 60000, events: [e2, e1] }, 200000, state)

    const rows = db.prepare("SELECT event_id, title FROM github_events WHERE project_id = 'p' ORDER BY event_id ASC").all() as { event_id: string; title: string }[]
    expect(rows).toEqual([
      { event_id: '81001', title: '#1 First' },
      { event_id: '81002', title: '#2 Second' },
    ])
  })

  it('CHK-M6-03-c: event first ignored stays ignored when re-delivered under widened policy', () => {
    const { db } = setupDatabase()
    const policy1 = testPolicy({
      repos: [{ name: 'owner/repo', labels: ['factory'], scope: ['src/core'] }],
    })
    const state = createIngestState()
    const event = makeIssuesPayload({
      id: '82001',
      payload: { action: 'opened', issue: { number: 50, title: 'Feature', labels: [{ name: 'enhancement' }] } },
    })

    ingestPoll(db, 'p', policy1, 'owner/repo', { kind: 'events', etag: 'e1', pollAfterMs: 60000, events: [event] }, 100000, state)

    const before = db.prepare("SELECT status, reason FROM github_events WHERE project_id = 'p' AND event_id = '82001'").get() as { status: string; reason: string }
    expect(before).toEqual({ status: 'ignored', reason: 'label-not-allowed' })

    const policy2 = testPolicy({
      repos: [{ name: 'owner/repo', labels: ['factory', 'enhancement'], scope: ['src/core'] }],
    })

    ingestPoll(db, 'p', policy2, 'owner/repo', { kind: 'events', etag: 'e2', pollAfterMs: 60000, events: [event] }, 200000, state)

    const after = db.prepare("SELECT status, reason, title, scope_json FROM github_events WHERE project_id = 'p' AND event_id = '82001'").get() as Record<string, unknown>
    expect(after.status).toBe('ignored')
    expect(after.reason).toBe('label-not-allowed')
    expect(after.title).toBeNull()
    expect(after.scope_json).toBeNull()
  })

  it('CHK-M6-03-c: same issue number and text under a new event id is stored as distinct row', () => {
    const { db } = setupDatabase()
    const policy = testPolicy()
    const state = createIngestState()

    const e1 = makeCommentPayload({ id: '83001', payload: { action: 'created', issue: { number: 42, title: 'T', labels: [{ name: 'factory' }] }, comment: { id: 1, body: '/factory task Work' } } })
    const e2 = makeCommentPayload({ id: '83002', payload: { action: 'created', issue: { number: 42, title: 'T', labels: [{ name: 'factory' }] }, comment: { id: 2, body: '/factory task Work' } } })

    ingestPoll(db, 'p', policy, 'owner/repo', { kind: 'events', etag: 'e2', pollAfterMs: 60000, events: [e1, e2] }, 100000, state)

    const rows = db.prepare("SELECT event_id, issue, title, status FROM github_events WHERE project_id = 'p' ORDER BY event_id ASC").all() as { event_id: string; issue: number; title: string; status: string }[]
    expect(rows).toEqual([
      { event_id: '83001', issue: 42, title: 'Work', status: 'pending' },
      { event_id: '83002', issue: 42, title: 'Work', status: 'pending' },
    ])
  })

  it('CHK-M6-03-c: events processed oldest first by BigInt id including 20-digit ids differing in last digit', () => {
    const { db } = setupDatabase()
    const policy = testPolicy({ maxPendingPerRepo: 1 })
    const state = createIngestState()

    const idLow = '90071992547409920001'
    const idHigh = '90071992547409920002'
    expect(BigInt(idLow) < BigInt(idHigh)).toBe(true)
    expect(Number(idLow) === Number(idHigh)).toBe(true)

    const eventLow = makeIssuesPayload({ id: idLow, payload: { action: 'opened', issue: { number: 1, title: 'Older', labels: [{ name: 'factory' }] } } })
    const eventHigh = makeIssuesPayload({ id: idHigh, payload: { action: 'opened', issue: { number: 2, title: 'Newer', labels: [{ name: 'factory' }] } } })

    ingestPoll(db, 'p', policy, 'owner/repo', { kind: 'events', etag: 'e-bigint', pollAfterMs: 60000, events: [eventHigh, eventLow] }, 100000, state)

    const rowLow = db.prepare("SELECT event_id, status, reason FROM github_events WHERE project_id = 'p' AND event_id = ?").get(idLow) as { event_id: string; status: string; reason: string | null }
    const rowHigh = db.prepare("SELECT event_id, status, reason FROM github_events WHERE project_id = 'p' AND event_id = ?").get(idHigh) as { event_id: string; status: string; reason: string | null }

    expect(rowLow).toEqual({ event_id: idLow, status: 'pending', reason: null })
    expect(rowHigh).toEqual({ event_id: idHigh, status: 'ignored', reason: 'pending-limit' })
  })
})

describe('M6-03 CHK-M6-03-d: limits, backoff, errors, and stopped state', () => {
  it('CHK-M6-03-d: pending-limit respects per-repo limit with pre-existing pending rows and another repo', () => {
    const { db } = setupDatabase()
    const policy = testPolicy({ maxPendingPerRepo: 2 })
    const state = createIngestState()

    // 1. Pre-existing pending row for owner/repo
    const e1 = makeIssuesPayload({ id: '90001' })
    ingestPoll(db, 'p', policy, 'owner/repo', { kind: 'events', etag: 'e1', pollAfterMs: 60000, events: [e1] }, 100000, state)

    // 2. Another repo (owner/other) ingests 2 pending rows
    const eOther1 = makeIssuesPayload({ id: '91001', repo: { name: 'owner/other' }, payload: { action: 'opened', issue: { number: 1, title: 'Other 1', labels: [{ name: 'task' }] } } })
    const eOther2 = makeIssuesPayload({ id: '91002', repo: { name: 'owner/other' }, payload: { action: 'opened', issue: { number: 2, title: 'Other 2', labels: [{ name: 'task' }] } } })
    ingestPoll(db, 'p', policy, 'owner/other', { kind: 'events', etag: 'e-other', pollAfterMs: 60000, events: [eOther1, eOther2] }, 105000, state)

    // 3. Next poll for owner/repo with e2, e3, e4WrongLabel
    // Since owner/repo already has 1 pending row, e2 is admitted (reaching max 2), e3 is ignored with pending-limit,
    // and owner/other's 2 pending rows do not count against owner/repo (not global, not page-local).
    const e2 = makeIssuesPayload({ id: '90002' })
    const e3 = makeIssuesPayload({ id: '90003' })
    const e4WrongLabel = makeIssuesPayload({ id: '90004', payload: { action: 'opened', issue: { number: 4, title: 'No label', labels: [{ name: 'other' }] } } })

    ingestPoll(db, 'p', policy, 'owner/repo', { kind: 'events', etag: 'e2', pollAfterMs: 60000, events: [e2, e3, e4WrongLabel] }, 110000, state)

    const r1 = db.prepare("SELECT status, reason FROM github_events WHERE project_id = 'p' AND event_id = '90001'").get() as { status: string; reason: string | null }
    const r2 = db.prepare("SELECT status, reason FROM github_events WHERE project_id = 'p' AND event_id = '90002'").get() as { status: string; reason: string | null }
    const r3 = db.prepare("SELECT status, reason FROM github_events WHERE project_id = 'p' AND event_id = '90003'").get() as { status: string; reason: string | null }
    const r4 = db.prepare("SELECT status, reason FROM github_events WHERE project_id = 'p' AND event_id = '90004'").get() as { status: string; reason: string | null }

    expect(r1).toEqual({ status: 'pending', reason: null })
    expect(r2).toEqual({ status: 'pending', reason: null })
    expect(r3).toEqual({ status: 'ignored', reason: 'pending-limit' })
    expect(r4).toEqual({ status: 'ignored', reason: 'label-not-allowed' })

    // Verify other repo's rows remain pending
    const otherRows = db.prepare("SELECT status FROM github_events WHERE project_id = 'p' AND repo = 'owner/other'").all() as { status: string }[]
    expect(otherRows).toEqual([{ status: 'pending' }, { status: 'pending' }])
  })

  it('CHK-M6-03-d: pollAfterMs below 60000 is raised to 60000 in cursor and return value', () => {
    const { db } = setupDatabase()
    const policy = testPolicy()
    const state = createIngestState()

    const nowMs = 500000
    const out1 = ingestPoll(db, 'p', policy, 'owner/repo', { kind: 'events', etag: 'e1', pollAfterMs: 15000, events: [] }, nowMs, state)
    expect(out1.nextPollMs).toBe(nowMs + 60000)

    const cursor1 = db.prepare("SELECT next_poll_ms FROM github_cursor WHERE project_id = 'p' AND repo = 'owner/repo'").get() as { next_poll_ms: number }
    expect(cursor1.next_poll_ms).toBe(nowMs + 60000)

    const out2 = ingestPoll(db, 'p', policy, 'owner/repo', { kind: 'not-modified', etag: 'e1', pollAfterMs: 0 }, nowMs + 100000, state)
    expect(out2.nextPollMs).toBe(nowMs + 100000 + 60000)

    const cursor2 = db.prepare("SELECT next_poll_ms FROM github_cursor WHERE project_id = 'p' AND repo = 'owner/repo'").get() as { next_poll_ms: number }
    expect(cursor2.next_poll_ms).toBe(nowMs + 100000 + 60000)
  })

  it('CHK-M6-03-d: rate-limited result updates next_poll_ms honoring retryAfterMs with no error recorded', () => {
    const { db } = setupDatabase()
    const policy = testPolicy()
    const state = createIngestState()

    const nowMs = 1000000
    const out = ingestPoll(db, 'p', policy, 'owner/repo', { kind: 'rate-limited', retryAfterMs: 95000 }, nowMs, state)
    expect(out).toEqual({ nextPollMs: nowMs + 95000, stopped: false })

    const cursor = db.prepare("SELECT next_poll_ms, error FROM github_cursor WHERE project_id = 'p' AND repo = 'owner/repo'").get() as { next_poll_ms: number; error: string | null }
    expect(cursor.next_poll_ms).toBe(nowMs + 95000)
    expect(cursor.error).toBeNull()

    const count = db.prepare("SELECT count(*) as count FROM github_events WHERE project_id = 'p'").get() as { count: number }
    expect(count.count).toBe(0)
  })

  it('CHK-M6-03-d: retryable error sanitizes error text, applies doubling backoff up to 900000 ms, resets on restart or non-error', () => {
    const { db } = setupDatabase()
    const policy = testPolicy()
    const state = createIngestState()

    let now = 1000000
    const expectedDeltas = [60000, 120000, 240000, 480000, 900000, 900000]

    // Hostile error text containing control characters, zero-width chars, bidi chars, and newlines
    const hostileMsg = 'socket \u0000\u001f\u202Atimeout\u200B\nerror'
    const sanitizedMsg = sanitizeLine(hostileMsg)

    for (let i = 0; i < expectedDeltas.length; i++) {
      const delta = expectedDeltas[i]!
      const msg = i === 0 ? hostileMsg : `timeout round ${i + 1}`
      const expectedStored = i === 0 ? sanitizedMsg : sanitizeLine(msg)

      const out = ingestPoll(db, 'p', policy, 'owner/repo', { kind: 'error', retryable: true, message: msg }, now, state)
      expect(out).toEqual({ nextPollMs: now + delta, stopped: false })

      const cursor = db.prepare("SELECT next_poll_ms, error FROM github_cursor WHERE project_id = 'p' AND repo = 'owner/repo'").get() as { next_poll_ms: number; error: string }
      expect(cursor.next_poll_ms).toBe(now + delta)
      expect(cursor.error).toBe(expectedStored)

      now += 10000
    }

    // Per-repo isolation: 'owner/other' starts at initial delta (60000 ms)
    const outOther = ingestPoll(db, 'p', policy, 'owner/other', { kind: 'error', retryable: true, message: 'other err' }, now, state)
    expect(outOther).toEqual({ nextPollMs: now + 60000, stopped: false })

    // Restart backoff reset: fresh IngestState resets consecutive error count
    const restartState = createIngestState()
    const outRestart = ingestPoll(db, 'p', policy, 'owner/repo', { kind: 'error', retryable: true, message: 'after restart' }, now + 20000, restartState)
    expect(outRestart).toEqual({ nextPollMs: now + 20000 + 60000, stopped: false })

    // Non-error reset: 'events' resets consecutive count and clears cursor error
    const eventsResetOut = ingestPoll(db, 'p', policy, 'owner/repo', { kind: 'events', etag: 'e-ev', pollAfterMs: 60000, events: [] }, now + 30000, state)
    expect(eventsResetOut.stopped).toBe(false)
    const cursorAfterEvents = db.prepare("SELECT error FROM github_cursor WHERE project_id = 'p' AND repo = 'owner/repo'").get() as { error: string | null }
    expect(cursorAfterEvents.error).toBeNull()

    // Next retryable error after events reset starts at initial 60000 ms
    const outAfterEventsReset = ingestPoll(db, 'p', policy, 'owner/repo', { kind: 'error', retryable: true, message: 'err post-events' }, now + 40000, state)
    expect(outAfterEventsReset).toEqual({ nextPollMs: now + 40000 + 60000, stopped: false })

    // Non-error reset: 'rate-limited' resets consecutive count
    ingestPoll(db, 'p', policy, 'owner/repo', { kind: 'rate-limited', retryAfterMs: 70000 }, now + 50000, state)
    const outAfterRateLimited = ingestPoll(db, 'p', policy, 'owner/repo', { kind: 'error', retryable: true, message: 'err post-rate-limited' }, now + 60000, state)
    expect(outAfterRateLimited).toEqual({ nextPollMs: now + 60000 + 60000, stopped: false })

    // Non-error reset: 'not-modified' resets consecutive count and clears cursor error
    ingestPoll(db, 'p', policy, 'owner/repo', { kind: 'not-modified', etag: 'e-nm', pollAfterMs: 60000 }, now + 70000, state)
    const cursorAfterNm = db.prepare("SELECT error FROM github_cursor WHERE project_id = 'p' AND repo = 'owner/repo'").get() as { error: string | null }
    expect(cursorAfterNm.error).toBeNull()
    const outAfterNmReset = ingestPoll(db, 'p', policy, 'owner/repo', { kind: 'error', retryable: true, message: 'err post-nm' }, now + 80000, state)
    expect(outAfterNmReset).toEqual({ nextPollMs: now + 80000 + 60000, stopped: false })
  })

  it('CHK-M6-03-d: non-retryable error stops repo with per-repo stop isolation and complete cursor immutability, restart resumes', () => {
    const { db } = setupDatabase()
    const { policy, hash: expectedPolicyHash } = parseTestPolicy()
    const state = createIngestState()

    const hostile404 = '404 \u0000not \u202Afound\u200B'
    const nowMs = 1000000
    const out1 = ingestPoll(db, 'p', policy, 'owner/repo', { kind: 'error', retryable: false, message: hostile404 }, nowMs, state)
    expect(out1.stopped).toBe(true)
    expect(state.stopped.has('owner/repo')).toBe(true)

    // Capture complete snapshot of the stopped repo's cursor row
    const stoppedSnapshot = db.prepare("SELECT * FROM github_cursor WHERE project_id = 'p' AND repo = 'owner/repo'").get() as Record<string, unknown>
    expect(stoppedSnapshot.error).toBe(sanitizeLine(hostile404))

    // Per-repo stop isolation: 'owner/other' using the same state is NOT stopped and ingests successfully
    expect(state.stopped.has('owner/other')).toBe(false)
    const rawOther = makeIssuesPayload({
      id: '96001',
      repo: { name: 'owner/other' },
      payload: {
        action: 'opened',
        issue: {
          number: 1,
          title: 'Other Work',
          body: 'Details of other work',
          labels: [{ name: 'task' }],
        },
      },
      created_at: '2026-11-13T10:00:00Z',
    })
    const outOther = ingestPoll(db, 'p', policy, 'owner/other', { kind: 'events', etag: 'e-other', pollAfterMs: 60000, events: [rawOther] }, nowMs + 5000, state)
    expect(outOther).toEqual({ nextPollMs: nowMs + 5000 + 60000, stopped: false })
    expect(state.stopped.has('owner/other')).toBe(false)

    // Assert event 96001 is stored as pending with exact values
    const rowOther = db.prepare("SELECT * FROM github_events WHERE project_id = 'p' AND event_id = '96001'").get() as Record<string, unknown>
    expect(rowOther).toBeDefined()
    expect(rowOther.event_id).toBe('96001')
    expect(rowOther.project_id).toBe('p')
    expect(rowOther.repo).toBe('owner/other')
    expect(rowOther.kind).toBe('issue.opened')
    expect(rowOther.actor_id).toBe(101)
    expect(rowOther.actor_login).toBe('alice')
    expect(rowOther.issue).toBe(1)
    expect(rowOther.status).toBe('pending')
    expect(rowOther.reason).toBeNull()
    expect(rowOther.title).toBe('#1 Other Work')
    expect(JSON.parse(String(rowOther.scope_json))).toEqual(['.'])
    expect(rowOther.text).toBe('Details of other work')
    expect(rowOther.text_trust).toBe('untrusted')
    expect(rowOther.text_sha256).toBe(sha256Hex('Details of other work'))
    expect(Date.parse(String(rowOther.event_at))).toBe(Date.parse('2026-11-13T10:00:00Z'))
    expect(Date.parse(String(rowOther.received_at))).toBe(nowMs + 5000)
    expect(rowOther.decided_at).toBeNull()
    expect(rowOther.decided_by_command).toBeNull()
    expect(rowOther.task_id).toBeNull()

    const basisOther = JSON.parse(String(rowOther.basis_json)) as Record<string, unknown>
    expect(basisOther.policyVersion).toBe(1)
    expect(basisOther.policyHash).toBe(expectedPolicyHash)
    expect(basisOther.actorId).toBe(101)
    expect(basisOther.repo).toBe('owner/other')
    expect(basisOther.issue).toBe(1)
    expect(basisOther.eventId).toBe('96001')
    expect(basisOther.kind).toBe('issue.opened')

    // Assert owner/other cursor advances with exact values
    const cursorOther = db.prepare("SELECT * FROM github_cursor WHERE project_id = 'p' AND repo = 'owner/other'").get() as Record<string, unknown>
    expect(cursorOther).toBeDefined()
    expect(cursorOther.project_id).toBe('p')
    expect(cursorOther.repo).toBe('owner/other')
    expect(cursorOther.etag).toBe('e-other')
    expect(cursorOther.next_poll_ms).toBe(nowMs + 5000 + 60000)
    expect(cursorOther.error).toBeNull()
    expect(Date.parse(String(cursorOther.updated_at))).toBe(nowMs + 5000)

    // Complete cursor immutability: poll on stopped repo writes nothing and leaves every cursor column identical
    const raw = makeIssuesPayload({ id: '95001' })
    const outStoppedAgain = ingestPoll(db, 'p', policy, 'owner/repo', { kind: 'events', etag: 'e-new', pollAfterMs: 60000, events: [raw] }, nowMs + 10000, state)
    expect(outStoppedAgain).toEqual({ nextPollMs: stoppedSnapshot.next_poll_ms, stopped: true })

    const afterStoppedAgain = db.prepare("SELECT * FROM github_cursor WHERE project_id = 'p' AND repo = 'owner/repo'").get() as Record<string, unknown>
    expect(afterStoppedAgain).toEqual(stoppedSnapshot)

    // No events were stored for owner/repo
    const repoEvents = db.prepare("SELECT count(*) as count FROM github_events WHERE project_id = 'p' AND repo = 'owner/repo'").get() as { count: number }
    expect(repoEvents.count).toBe(0)

    // A restart (fresh createIngestState) clears stopped state and resumes polling
    const restartState = createIngestState()
    expect(restartState.stopped.has('owner/repo')).toBe(false)

    const outRestart = ingestPoll(db, 'p', policy, 'owner/repo', { kind: 'events', etag: 'e-restart', pollAfterMs: 60000, events: [raw] }, nowMs + 20000, restartState)
    expect(outRestart.stopped).toBe(false)
    expect(outRestart.nextPollMs).toBe(nowMs + 20000 + 60000)

    const eventRestart = db.prepare("SELECT event_id, status FROM github_events WHERE project_id = 'p' AND event_id = '95001'").get() as { event_id: string; status: string }
    expect(eventRestart).toEqual({ event_id: '95001', status: 'pending' })

    const cursorRestart = db.prepare("SELECT error, etag FROM github_cursor WHERE project_id = 'p' AND repo = 'owner/repo'").get() as { error: string | null; etag: string }
    expect(cursorRestart.error).toBeNull()
    expect(cursorRestart.etag).toBe('e-restart')
  })

  it('CHK-M6-03-d: returned nextPollMs always equals stored next_poll_ms in github_cursor', () => {
    const { db } = setupDatabase()
    const policy = testPolicy()
    const state = createIngestState()

    const results: PollResult[] = [
      { kind: 'events', etag: 'e1', pollAfterMs: 70000, events: [] },
      { kind: 'not-modified', etag: 'e1', pollAfterMs: 80000 },
      { kind: 'rate-limited', retryAfterMs: 90000 },
      { kind: 'error', retryable: true, message: 'temporary flakiness' },
    ]

    let now = 1000000
    for (const r of results) {
      const out = ingestPoll(db, 'p', policy, 'owner/repo', r, now, state)
      const cursor = db.prepare("SELECT next_poll_ms FROM github_cursor WHERE project_id = 'p' AND repo = 'owner/repo'").get() as { next_poll_ms: number }
      expect(out.nextPollMs).toBe(cursor.next_poll_ms)
      now += 50000
    }
  })
})
