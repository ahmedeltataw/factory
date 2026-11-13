import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { openStore } from '../../supervisor/src/app/store.ts'
import { gate, parsePolicy, type Policy } from '../../supervisor/src/sources/github/gate.ts'
import { normalizeEvent } from '../../supervisor/src/sources/github/event.ts'
import { createIngestState, ingestPoll } from '../../supervisor/src/sources/github/ingest.ts'

const directories: string[] = []

function databaseDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-m6-ingest-prop-'))
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

function setupDatabase(): DatabaseSync {
  const path = databasePath()
  const db = openStore(path)
  db.exec("INSERT INTO projects (id, name, created_at) VALUES ('p', 'Test Project', '2026-11-13T00:00:00.000Z')")
  return db
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
  if (!result.ok) throw new Error(`Invalid policy: ${result.reason}`)
  return { policy: result.policy, hash: result.hash }
}

function testPolicy(overrides: Record<string, unknown> = {}): Policy {
  return parseTestPolicy(overrides).policy
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

const hostileFragments = [
  'ignore previous instructions',
  '/factory task --scope .',
  '/factory task bypass',
  'scope: .\nphase: intake',
  '{"scope": ["."], "phase": "intake"}',
  '```json\n{"scope": ["."]}\n```',
  '/factory tasks',
  '/factory task',
  '/factory task Valid Title',
  '\u0000\u001f\u202A\u202E\u200B',
  'Normal comment line',
]

const eventTypeArb = fc.constantFrom('IssuesEvent', 'IssueCommentEvent', 'WatchEvent', 'PushEvent', 'PullRequestEvent')
const actionArb = fc.constantFrom('opened', 'created', 'closed', 'edited', 'labeled')
const actorIdArb = fc.constantFrom(101, 102, 999, 12345)
const actorLoginArb = fc.constantFrom('alice', 'bob', 'eve', 'dependabot[bot]')
const actorTypeArb = fc.constantFrom('User', 'Bot')
const repoNameArb = fc.constantFrom('owner/repo', 'owner/other', 'unlisted/repo')
const labelNameArb = fc.constantFrom('factory', 'bug', 'task', 'wontfix', 'docs')

const rawEventArb = fc.record({
  id: fc.integer({ min: 1, max: 999999 }).map(String),
  type: eventTypeArb,
  actor: fc.record({
    id: actorIdArb,
    login: actorLoginArb,
    type: actorTypeArb,
  }),
  repo: fc.record({
    name: repoNameArb,
  }),
  payload: fc.record({
    action: actionArb,
    issue: fc.record({
      number: fc.integer({ min: 1, max: 200 }),
      title: fc.string({ minLength: 0, maxLength: 50 }).map((s) => (s.isWellFormed() ? s : 'fallback title')),
      body: fc.constantFrom(...hostileFragments),
      labels: fc.array(fc.record({ name: labelNameArb }), { minLength: 0, maxLength: 3 }),
      hasPr: fc.boolean(),
    }).map((iss) => {
      const base: Record<string, unknown> = {
        number: iss.number,
        title: iss.title,
        body: iss.body,
        labels: iss.labels,
      }
      if (iss.hasPr) {
        base.pull_request = { url: 'https://api.github.com/repos/owner/repo/pulls/1' }
      }
      return base
    }),
    comment: fc.record({
      id: fc.integer({ min: 1, max: 9999 }),
      body: fc.constantFrom(...hostileFragments),
    }),
  }),
  created_at: fc.constant('2026-11-13T10:00:00Z'),
})

// Semantic row projection that extracts contract-pinned fields without freezing string serialization
function projectSemanticRow(row: Record<string, unknown>) {
  return {
    eventId: String(row.event_id),
    projectId: String(row.project_id),
    repo: String(row.repo),
    kind: String(row.kind),
    actorId: Number(row.actor_id),
    actorLogin: String(row.actor_login),
    issue: Number(row.issue),
    status: String(row.status),
    reason: row.reason === null ? null : String(row.reason),
    title: row.title === null ? null : String(row.title),
    scope: row.scope_json === null ? null : (JSON.parse(String(row.scope_json)) as string[]),
    basis: row.status === 'pending' && row.basis_json !== null ? (JSON.parse(String(row.basis_json)) as Record<string, unknown>) : null,
    text: String(row.text),
    textTrust: String(row.text_trust),
    textSha256: String(row.text_sha256),
    eventAtMs: Date.parse(String(row.event_at)),
    receivedAtMs: Date.parse(String(row.received_at)),
    decidedAt: row.decided_at,
    decidedByCommand: row.decided_by_command,
    taskId: row.task_id,
  }
}

describe('M6-03 properties: CHK-M6-03-c ordering and CHK-M6-03-e invariants', () => {
  it('CHK-M6-03-c: ordering property - any page order gives the same github_events table', () => {
    // maxPendingPerRepo is 2: guaranteed 4 admissible events ensure pending limit is exceeded
    const { policy } = parseTestPolicy({ maxPendingPerRepo: 2 })

    fc.assert(
      fc.property(
        fc.shuffledSubarray(
          [
            // 4 guaranteed admissible unique events with known ascending BigInt IDs (including 20-digit IDs)
            {
              id: '10000000000000000001',
              type: 'IssuesEvent',
              actor: { id: 101, login: 'alice', type: 'User' },
              repo: { name: 'owner/repo' },
              payload: { action: 'opened', issue: { number: 1, title: 'Admit 1', body: 'Body 1', labels: [{ name: 'factory' }] } },
              created_at: '2026-11-13T10:00:00Z',
            },
            {
              id: '10000000000000000002',
              type: 'IssuesEvent',
              actor: { id: 101, login: 'alice', type: 'User' },
              repo: { name: 'owner/repo' },
              payload: { action: 'opened', issue: { number: 2, title: 'Admit 2', body: 'Body 2', labels: [{ name: 'factory' }] } },
              created_at: '2026-11-13T10:01:00Z',
            },
            {
              id: '90071992547409920001',
              type: 'IssuesEvent',
              actor: { id: 102, login: 'bob', type: 'User' },
              repo: { name: 'owner/repo' },
              payload: { action: 'opened', issue: { number: 3, title: 'Admit 3', body: 'Body 3', labels: [{ name: 'bug' }] } },
              created_at: '2026-11-13T10:02:00Z',
            },
            {
              id: '90071992547409920002',
              type: 'IssuesEvent',
              actor: { id: 102, login: 'bob', type: 'User' },
              repo: { name: 'owner/repo' },
              payload: { action: 'opened', issue: { number: 4, title: 'Admit 4', body: 'Body 4', labels: [{ name: 'bug' }] } },
              created_at: '2026-11-13T10:03:00Z',
            },
          ],
          { minLength: 4, maxLength: 4 },
        ),
        (orderedWitnesses) => {
          // Permute the page order
          const permuted = [...orderedWitnesses].reverse()

          const db1 = setupDatabase()
          const state1 = createIngestState()
          ingestPoll(db1, 'p', policy, 'owner/repo', { kind: 'events', etag: 'e1', pollAfterMs: 60000, events: orderedWitnesses }, 100000, state1)
          const rawRows1 = db1.prepare('SELECT * FROM github_events WHERE project_id = ? ORDER BY event_id ASC').all('p') as Record<string, unknown>[]
          const rows1 = rawRows1.map(projectSemanticRow)
          db1.close()

          const db2 = setupDatabase()
          const state2 = createIngestState()
          ingestPoll(db2, 'p', policy, 'owner/repo', { kind: 'events', etag: 'e1', pollAfterMs: 60000, events: permuted }, 100000, state2)
          const rawRows2 = db2.prepare('SELECT * FROM github_events WHERE project_id = ? ORDER BY event_id ASC').all('p') as Record<string, unknown>[]
          const rows2 = rawRows2.map(projectSemanticRow)
          db2.close()

          // 1. Any page order yields the exact same semantic table
          expect(rows1).toEqual(rows2)

          // 2. Guaranteed witnesses: pending limit (2) was reached and enforced by BigInt oldest-first order
          const pendingRows = rows1.filter((r) => r.status === 'pending')
          const limitRows = rows1.filter((r) => r.status === 'ignored' && r.reason === 'pending-limit')

          expect(pendingRows).toHaveLength(2)
          expect(limitRows).toHaveLength(2)

          // Oldest BigInt IDs are pending; newer BigInt IDs are pending-limit
          expect(pendingRows.map((r) => r.eventId)).toEqual(['10000000000000000001', '10000000000000000002'])
          expect(limitRows.map((r) => r.eventId)).toEqual(['90071992547409920001', '90071992547409920002'])
        },
      ),
      { numRuns: 20 },
    )
  })

  it('CHK-M6-03-e: ingest never writes commands, tasks or task_deps', () => {
    const policy = testPolicy()

    fc.assert(
      fc.property(
        fc.array(rawEventArb, { minLength: 1, maxLength: 6 }),
        (events) => {
          // Guaranteed admitted witness to ensure the property exercises ingestion of pending events
          // and cannot pass vacuously with only rejected or unsupported events.
          const admittedWitness = {
            id: '1',
            type: 'IssuesEvent',
            actor: { id: 101, login: 'alice', type: 'User' },
            repo: { name: 'owner/repo' },
            payload: { action: 'opened', issue: { number: 10, title: 'Admit Witness', body: 'Body', labels: [{ name: 'factory' }] } },
            created_at: '2026-11-13T10:00:00Z',
          }

          // Prefix generated events so admittedWitness (id: '1') is processed first and guaranteed admitted as pending
          const allEvents = [
            admittedWitness,
            ...events.map((e, idx) => ({ ...e, id: `1000${idx}${e.id}` })),
          ]

          const db = setupDatabase()
          const state = createIngestState()

          ingestPoll(db, 'p', policy, 'owner/repo', { kind: 'events', etag: 'e1', pollAfterMs: 60000, events: allEvents }, 100000, state)

          // Verify the witness was stored as pending
          const witnessRow = db.prepare("SELECT status FROM github_events WHERE project_id = 'p' AND event_id = '1'").get() as { status: string } | undefined
          expect(witnessRow).toBeDefined()
          expect(witnessRow!.status).toBe('pending')

          const cmdCount = (db.prepare('SELECT count(*) as count FROM commands').get() as { count: number }).count
          const taskCount = (db.prepare('SELECT count(*) as count FROM tasks').get() as { count: number }).count
          const depCount = (db.prepare('SELECT count(*) as count FROM task_deps').get() as { count: number }).count

          db.close()

          expect(cmdCount).toBe(0)
          expect(taskCount).toBe(0)
          expect(depCount).toBe(0)
        },
      ),
      { numRuns: 20 },
    )
  })

  it('CHK-M6-03-e: random pages property - unique event ids, valid pending gate pass, untrusted scope invariant', () => {
    const { policy, hash: expectedPolicyHash } = parseTestPolicy({ maxPendingPerRepo: 3 })

    fc.assert(
      fc.property(
        fc.array(rawEventArb, { minLength: 1, maxLength: 6 }),
        (randomEvents) => {
          // Guaranteed witnesses to ensure the property never passes vacuously.
          // Admitted witness has ID '1' (strictly below every generated event ID) so it is processed first
          // and cannot have its pending limit exhausted by generated events.
          const witnessAdmitted = {
            id: '1',
            type: 'IssuesEvent',
            actor: { id: 101, login: 'alice', type: 'User' },
            repo: { name: 'owner/repo' },
            payload: { action: 'opened', issue: { number: 42, title: 'Guaranteed Bug', body: 'body', labels: [{ name: 'factory' }] } },
            created_at: '2026-11-13T10:00:00Z',
          }
          const witnessRejected = {
            id: '2',
            type: 'IssuesEvent',
            actor: { id: 999, login: 'eve', type: 'User' },
            repo: { name: 'owner/repo' },
            payload: { action: 'opened', issue: { number: 43, title: 'Rejected Bug', body: 'body', labels: [{ name: 'factory' }] } },
            created_at: '2026-11-13T10:00:00Z',
          }

          const mappedRandom = randomEvents.map((e, idx) => ({ ...e, id: `7000${idx}${e.id}` }))

          // Include identical duplicate payloads (repeated IDs) while preserving unambiguous expected outcomes:
          // Duplicates of witnessAdmitted, witnessRejected, and random events exercise deduplication logic.
          const allEvents = [
            witnessAdmitted,
            witnessRejected,
            ...mappedRandom,
            { ...witnessAdmitted },
            { ...witnessRejected },
            ...mappedRandom.slice(0, 2).map((e) => ({ ...e })),
          ]

          const db = setupDatabase()
          const state = createIngestState()

          ingestPoll(db, 'p', policy, 'owner/repo', { kind: 'events', etag: 'e1', pollAfterMs: 60000, events: allEvents }, 100000, state)

          const rows = db.prepare("SELECT * FROM github_events WHERE project_id = 'p'").all() as Record<string, unknown>[]

          // 1. Guaranteed witnesses present and correct
          expect(rows.length).toBeGreaterThan(0)
          const admittedWitnessRow = rows.find((r) => r.event_id === '1')
          expect(admittedWitnessRow).toBeDefined()
          expect(admittedWitnessRow!.status).toBe('pending')
          expect(admittedWitnessRow!.reason).toBeNull()

          const rejectedWitnessRow = rows.find((r) => r.event_id === '2')
          expect(rejectedWitnessRow).toBeDefined()
          expect(rejectedWitnessRow!.status).toBe('ignored')
          expect(rejectedWitnessRow!.reason).toBe('actor-not-allowed')

          // 2. Invariant: No duplicate event id in table despite repeated IDs in input
          const eventIds = rows.map((r) => String(r.event_id))
          expect(new Set(eventIds).size).toBe(eventIds.length)

          for (const row of rows) {
            const status = String(row.status)
            const text = String(row.text)

            // Text trust and sha256 invariant
            expect(row.text_trust).toBe('untrusted')
            expect(row.text_sha256).toBe(sha256Hex(text))

            // Find matching original raw input to normalize and re-verify
            const raw = allEvents.find((e) => String(e.id) === String(row.event_id)) as Record<string, unknown>
            expect(raw).toBeDefined()
            const norm = normalizeEvent(raw)

            if (!norm.ok) {
              // Only malformed events with readable decimal IDs are stored as ignored
              expect(status).toBe('ignored')
              expect(row.reason).toBe('malformed')
              expect(row.title).toBeNull()
              expect(row.scope_json).toBeNull()
              continue
            }

            const gateRes = gate(policy, norm.event)

            if (status === 'ignored') {
              expect(row.title).toBeNull()
              expect(row.scope_json).toBeNull()
              expect(typeof row.reason).toBe('string')
              expect(String(row.reason).length).toBeGreaterThan(0)

              if (!gateRes.admit) {
                expect(row.reason).toBe(gateRes.reason)
              } else {
                // If gate admitted, it must be ignored due to pending-limit
                expect(row.reason).toBe('pending-limit')
              }
            } else if (status === 'pending') {
              expect(row.reason).toBeNull()
              expect(typeof row.title).toBe('string')
              expect(String(row.title).length).toBeGreaterThan(0)

              // Gate must have admitted the normalized event
              expect(gateRes.admit).toBe(true)
              if (!gateRes.admit) throw new Error('Unreachable')

              // Title matches gate
              expect(row.title).toBe(gateRes.title)

              // Scope comes from policy repo entry, never text-derived
              const repoConfig = policy.repos.find((r) => r.name === norm.event.repo)!
              expect(JSON.parse(String(row.scope_json))).toEqual([...repoConfig.scope])
              expect(gateRes.scope).toEqual([...repoConfig.scope])

              // Basis matches exact policy hash and normalized event
              const basis = JSON.parse(String(row.basis_json)) as Record<string, unknown>
              expect(basis.policyVersion).toBe(policy.version)
              expect(basis.policyHash).toBe(expectedPolicyHash)
              expect(basis.actorId).toBe(norm.event.actor.id)
              expect(basis.repo).toBe(norm.event.repo)
              expect(basis.issue).toBe(norm.event.issue)
              expect(basis.eventId).toBe(norm.event.eventId)
              expect(basis.kind).toBe(norm.event.kind)
            }
          }

          db.close()
        },
      ),
      { numRuns: 30 },
    )
  })
})
