import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openStore } from '../../supervisor/src/app/store.ts'
import { formatStatus, readStatus, type Status } from '../../supervisor/src/app/status.ts'

export interface GitHubRepoStatus {
  readonly name: string
  readonly lastPollAt: string
  readonly nextPollAt: string
  readonly etag: boolean
  readonly error: string | null
}

export interface GitHubEventsCounts {
  readonly ignored: number
  readonly pending: number
  readonly approved: number
  readonly rejected: number
}

export interface GitHubPendingEvent {
  readonly eventId: string
  readonly repo: string
  readonly issue: number
  readonly actor: string
  readonly title: string
  readonly scope: readonly string[]
  readonly receivedAt: string
}

export interface GitHubStatus {
  readonly repos: readonly GitHubRepoStatus[]
  readonly events: GitHubEventsCounts
  readonly pending: readonly GitHubPendingEvent[]
}

export type StatusWithGitHub = Status & {
  readonly github: null | GitHubStatus
}

const stamp = '2026-11-13T10:00:00.000Z'
const cli = join(process.cwd(), 'supervisor/src/cli/main.ts')

const run = (dir: string, ...args: string[]) =>
  spawnSync(process.execPath, [cli, 'status', '--state-dir', dir, ...args], {
    encoding: 'utf8',
    timeout: 15000,
  })

const fileHash = (path: string) =>
  createHash('sha256').update(readFileSync(path)).digest('hex')

function dumpDatabaseContents(dbPath: string): string {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]
    ).map((r) => r.name)
    const dump: Record<string, unknown[]> = {}
    for (const table of tables) {
      if (table.startsWith('sqlite_')) continue
      dump[table] = db.prepare(`SELECT * FROM "${table}"`).all()
    }
    return JSON.stringify(dump)
  } finally {
    db.close()
  }
}

const directories: string[] = []
function makeFixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-m6-status-'))
  directories.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function seedProject(db: DatabaseSync, dir: string, projectId = 'p') {
  db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(projectId, 'Project', stamp)
  db.prepare('INSERT INTO project_config (project_id, repo_path, base_ref, created_at) VALUES (?, ?, ?, ?)').run(projectId, dir, 'main', stamp)
  const phase = db.prepare('INSERT INTO phases (project_id, name, ord, status, opened_at, closed_at) VALUES (?, ?, ?, ?, ?, ?)')
  phase.run(projectId, 'intake', 1, 'open', stamp, null)
  phase.run(projectId, 'development', 2, 'locked', null, null)
  phase.run(projectId, 'qa', 3, 'locked', null, null)
  phase.run(projectId, 'devops', 4, 'locked', null, null)
  phase.run(projectId, 'handover', 5, 'locked', null, null)
}

function insertCursor(
  db: DatabaseSync,
  {
    projectId = 'p',
    repo,
    etag = null,
    nextPollMs,
    error = null,
    updatedAt = stamp,
  }: {
    projectId?: string
    repo: string
    etag?: string | null
    nextPollMs: number
    error?: string | null
    updatedAt?: string
  },
) {
  db.prepare(
    'INSERT INTO github_cursor (project_id, repo, etag, next_poll_ms, error, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(projectId, repo, etag, nextPollMs, error, updatedAt)
}

function insertEvent(
  db: DatabaseSync,
  {
    eventId,
    projectId = 'p',
    repo,
    kind = 'issue.comment',
    actorId = 100,
    actorLogin = 'alice',
    issue = 1,
    status,
    reason = null,
    title = null,
    scopeJson = null,
    basisJson = null,
    text = 'sample comment text',
    textTrust = 'untrusted',
    textSha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    eventAt = stamp,
    receivedAt = stamp,
    decidedAt = null,
    decidedByCommand = null,
    taskId = null,
  }: {
    eventId: string
    projectId?: string
    repo: string
    kind?: 'issue.opened' | 'issue.comment'
    actorId?: number
    actorLogin?: string
    issue?: number
    status: 'ignored' | 'pending' | 'approved' | 'rejected' | string
    reason?: string | null
    title?: string | null
    scopeJson?: string | null
    basisJson?: string | null
    text?: string
    textTrust?: string
    textSha256?: string
    eventAt?: string
    receivedAt?: string
    decidedAt?: string | null
    decidedByCommand?: string | null
    taskId?: string | null
  },
) {
  db.prepare(
    'INSERT INTO github_events (event_id, project_id, repo, kind, actor_id, actor_login, issue, status, reason, title, scope_json, basis_json, text, text_trust, text_sha256, event_at, received_at, decided_at, decided_by_command, task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    eventId,
    projectId,
    repo,
    kind,
    actorId,
    actorLogin,
    issue,
    status,
    reason,
    title,
    scopeJson,
    basisJson,
    text,
    textTrust,
    textSha256,
    eventAt,
    receivedAt,
    decidedAt,
    decidedByCommand,
    taskId,
  )
}

describe('M6-07 Protected Tests: Status of GitHub intake', () => {
  it('CHK-M6-07-a: github is null for an empty project with no cursor and no events', () => {
    const dir = makeFixtureDir()
    const dbPath = join(dir, 'state.sqlite')
    const db = openStore(dbPath)
    try {
      seedProject(db, dir)
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally {
      db.close()
    }

    const status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 }) as unknown as StatusWithGitHub
    expect(status.schemaVersion).toBe(8)
    expect(status.github).toBeNull()

    const res = run(dir, '--json')
    expect(res.status).toBe(0)
    const json = JSON.parse(res.stdout)
    expect(json.schemaVersion).toBe(8)
    expect(json.github).toBeNull()
  })

  it('CHK-M6-07-a: github has exact shape, sorted repos, error, ISO nextPollAt, events counts, and no text leak', () => {
    const dir = makeFixtureDir()
    const dbPath = join(dir, 'state.sqlite')
    const db = openStore(dbPath)
    const canaryIgnored1 = 'CANARY_SECRET_TEXT_IGNORED_1_DO_NOT_LEAK'
    const canaryIgnored2 = 'CANARY_SECRET_TEXT_IGNORED_2_DO_NOT_LEAK'
    const canaryApproved = 'CANARY_SECRET_TEXT_APPROVED_3_DO_NOT_LEAK'
    const canaryApproved2 = 'CANARY_SECRET_TEXT_APPROVED_3B_DO_NOT_LEAK'
    const canaryApproved3 = 'CANARY_SECRET_TEXT_APPROVED_3C_DO_NOT_LEAK'
    const canaryApproved4 = 'CANARY_SECRET_TEXT_APPROVED_3D_DO_NOT_LEAK'
    const canaryRejected = 'CANARY_SECRET_TEXT_REJECTED_4_DO_NOT_LEAK'
    const canaryPending1 = 'CANARY_SECRET_TEXT_PENDING_5_DO_NOT_LEAK'
    const canaryPending2 = 'CANARY_SECRET_TEXT_PENDING_6_DO_NOT_LEAK'

    try {
      seedProject(db, dir)
      db.prepare('INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)').run(
        'cmd-app-1',
        'p',
        'github.approve',
        '{"eventId":"12"}',
        stamp,
      )
      db.prepare(
        'INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run('task-app-1', 'p', 'cmd-app-1', 'Approved task', 'ready', stamp, stamp, '["src"]')

      // Insert repos in reverse alphabetical order to verify sorting by repo name.
      // org/beta has an empty-string ETag to verify etag presence vs truthiness.
      insertCursor(db, {
        repo: 'org/zeta',
        etag: 'etag-zeta-1',
        nextPollMs: 1768220000000,
        error: null,
        updatedAt: '2026-11-13T10:00:00.000Z',
      })
      insertCursor(db, {
        repo: 'org/beta',
        etag: '',
        nextPollMs: 1768218000000,
        error: null,
        updatedAt: '2026-11-13T09:30:00.000Z',
      })
      insertCursor(db, {
        repo: 'org/alpha',
        etag: null,
        nextPollMs: 1768215000000,
        error: 'policy: missing',
        updatedAt: '2026-11-13T09:00:00.000Z',
      })

      // Insert events covering all 4 statuses with distinct counts:
      // ignored: 3, pending: 2, approved: 4, rejected: 1
      insertEvent(db, {
        eventId: '10',
        repo: 'org/alpha',
        status: 'ignored',
        reason: 'label-not-allowed',
        text: canaryIgnored1,
      })
      insertEvent(db, {
        eventId: '11',
        repo: 'org/zeta',
        status: 'ignored',
        reason: 'bot-actor',
        text: canaryIgnored2,
      })
      insertEvent(db, {
        eventId: '103',
        repo: 'org/alpha',
        status: 'ignored',
        reason: 'actor-not-allowed',
        text: 'ignored canary 3',
      })
      insertEvent(db, {
        eventId: '12',
        repo: 'org/alpha',
        status: 'approved',
        title: 'Approved Issue Task 1',
        scopeJson: '["src"]',
        basisJson: '{"policyVersion":1}',
        text: canaryApproved,
        taskId: 'task-app-1',
        decidedAt: '2026-11-13T09:30:00.000Z',
        decidedByCommand: 'cmd-app-1',
      })
      insertEvent(db, {
        eventId: '16',
        repo: 'org/beta',
        status: 'approved',
        title: 'Approved Issue Task 2',
        scopeJson: '["src"]',
        basisJson: '{"policyVersion":1}',
        text: canaryApproved2,
        taskId: 'task-app-1',
        decidedAt: '2026-11-13T09:31:00.000Z',
        decidedByCommand: 'cmd-app-1',
      })
      insertEvent(db, {
        eventId: '17',
        repo: 'org/zeta',
        status: 'approved',
        title: 'Approved Issue Task 3',
        scopeJson: '["src"]',
        basisJson: '{"policyVersion":1}',
        text: canaryApproved3,
        taskId: 'task-app-1',
        decidedAt: '2026-11-13T09:32:00.000Z',
        decidedByCommand: 'cmd-app-1',
      })
      insertEvent(db, {
        eventId: '18',
        repo: 'org/alpha',
        status: 'approved',
        title: 'Approved Issue Task 4',
        scopeJson: '["src"]',
        basisJson: '{"policyVersion":1}',
        text: canaryApproved4,
        taskId: 'task-app-1',
        decidedAt: '2026-11-13T09:33:00.000Z',
        decidedByCommand: 'cmd-app-1',
      })
      insertEvent(db, {
        eventId: '13',
        repo: 'org/zeta',
        status: 'rejected',
        reason: 'no-command',
        title: 'Rejected Issue Task',
        scopeJson: '["."]',
        text: canaryRejected,
      })
      insertEvent(db, {
        eventId: '14',
        repo: 'org/alpha',
        issue: 101,
        actorLogin: 'alice',
        status: 'pending',
        title: 'Feature implementation',
        scopeJson: '["src/core", "docs"]',
        basisJson: '{"policyVersion":1}',
        text: canaryPending1,
        receivedAt: '2026-11-13T10:01:00.000Z',
      })
      insertEvent(db, {
        eventId: '15',
        repo: 'org/zeta',
        issue: 102,
        actorLogin: 'bob',
        status: 'pending',
        title: 'Fix edge case bug',
        scopeJson: '["."]',
        basisJson: '{"policyVersion":1}',
        text: canaryPending2,
        receivedAt: '2026-11-13T10:02:00.000Z',
      })

      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally {
      db.close()
    }

    const status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 }) as unknown as StatusWithGitHub
    expect(status.schemaVersion).toBe(8)
    expect(status.github).toBeDefined()
    expect(status.github).not.toBeNull()

    const gh = status.github!
    // Repos must be ordered by repo name.
    // org/beta has etag: '' (empty string), which must yield etag: true (presence vs truthiness).
    expect(gh.repos).toEqual([
      {
        name: 'org/alpha',
        lastPollAt: '2026-11-13T09:00:00.000Z',
        nextPollAt: new Date(1768215000000).toISOString(),
        etag: false,
        error: 'policy: missing',
      },
      {
        name: 'org/beta',
        lastPollAt: '2026-11-13T09:30:00.000Z',
        nextPollAt: new Date(1768218000000).toISOString(),
        etag: true,
        error: null,
      },
      {
        name: 'org/zeta',
        lastPollAt: '2026-11-13T10:00:00.000Z',
        nextPollAt: new Date(1768220000000).toISOString(),
        etag: true,
        error: null,
      },
    ])

    // Event counts for all 4 statuses with distinct counts
    expect(gh.events).toEqual({
      ignored: 3,
      pending: 2,
      approved: 4,
      rejected: 1,
    })

    // Pending events array
    expect(gh.pending).toEqual([
      {
        eventId: '14',
        repo: 'org/alpha',
        issue: 101,
        actor: 'alice',
        title: 'Feature implementation',
        scope: ['src/core', 'docs'],
        receivedAt: '2026-11-13T10:01:00.000Z',
      },
      {
        eventId: '15',
        repo: 'org/zeta',
        issue: 102,
        actor: 'bob',
        title: 'Fix edge case bug',
        scope: ['.'],
        receivedAt: '2026-11-13T10:02:00.000Z',
      },
    ])

    // Verify CLI --json output matches status object
    const res = run(dir, '--json')
    expect(res.status).toBe(0)
    const json = JSON.parse(res.stdout)
    expect(json.schemaVersion).toBe(8)
    expect(json.github).toEqual(gh)

    // Verify no text column anywhere in JSON or Arabic outputs
    const allCanaries = [
      canaryIgnored1,
      canaryIgnored2,
      canaryApproved,
      canaryApproved2,
      canaryApproved3,
      canaryApproved4,
      canaryRejected,
      canaryPending1,
      canaryPending2,
    ]
    for (const canary of allCanaries) {
      expect(res.stdout).not.toContain(canary)
      expect(JSON.stringify(status)).not.toContain(canary)
    }
    expect('text' in (json.github as Record<string, unknown>)).toBe(false)
    for (const p of json.github.pending) {
      expect('text' in p).toBe(false)
    }
    for (const r of json.github.repos) {
      expect('text' in r).toBe(false)
    }
  })

  it('CHK-M6-07-a: pending events list is limited to newest 20 rows and returned oldest first', () => {
    const dir = makeFixtureDir()
    const dbPath = join(dir, 'state.sqlite')
    const db = openStore(dbPath)

    try {
      seedProject(db, dir)
      insertCursor(db, {
        repo: 'org/repo',
        nextPollMs: 1768220000000,
      })

      // 25 pending events with scrambled timestamps, event IDs, and DB insertion order.
      // Indices 0..3: 4 strictly oldest events (excluded)
      // Index 4: tie candidate at cutoff (receivedAt :05, eventId '301') -> excluded (21st newest)
      // Index 5: tie candidate at cutoff (receivedAt :05, eventId '302') -> included (20th newest, 302 > 301)
      // Indices 6..22: 17 newer events (receivedAt :06..:22) -> included
      // Index 23: tie candidate within included set (receivedAt :23, eventId '351') -> included
      // Index 24: tie candidate within included set (receivedAt :23, eventId '352') -> included (351 precedes 352 oldest-first)
      const allEvents = [
        { eventId: '804', issue: 1, actorLogin: 'user-1', title: 'Task #804', receivedAt: '2026-11-13T10:00:01.000Z' },
        { eventId: '202', issue: 2, actorLogin: 'user-2', title: 'Task #202', receivedAt: '2026-11-13T10:00:02.000Z' },
        { eventId: '703', issue: 3, actorLogin: 'user-3', title: 'Task #703', receivedAt: '2026-11-13T10:00:03.000Z' },
        { eventId: '101', issue: 4, actorLogin: 'user-4', title: 'Task #101', receivedAt: '2026-11-13T10:00:04.000Z' },
        { eventId: '301', issue: 5, actorLogin: 'user-5', title: 'Task #301', receivedAt: '2026-11-13T10:00:05.000Z' },
        { eventId: '302', issue: 6, actorLogin: 'user-6', title: 'Task #302', receivedAt: '2026-11-13T10:00:05.000Z' },
        { eventId: '906', issue: 7, actorLogin: 'user-7', title: 'Task #906', receivedAt: '2026-11-13T10:00:06.000Z' },
        { eventId: '407', issue: 8, actorLogin: 'user-8', title: 'Task #407', receivedAt: '2026-11-13T10:00:07.000Z' },
        { eventId: '608', issue: 9, actorLogin: 'user-9', title: 'Task #608', receivedAt: '2026-11-13T10:00:08.000Z' },
        { eventId: '109', issue: 10, actorLogin: 'user-10', title: 'Task #109', receivedAt: '2026-11-13T10:00:09.000Z' },
        { eventId: '810', issue: 11, actorLogin: 'user-11', title: 'Task #810', receivedAt: '2026-11-13T10:00:10.000Z' },
        { eventId: '211', issue: 12, actorLogin: 'user-12', title: 'Task #211', receivedAt: '2026-11-13T10:00:11.000Z' },
        { eventId: '712', issue: 13, actorLogin: 'user-13', title: 'Task #712', receivedAt: '2026-11-13T10:00:12.000Z' },
        { eventId: '313', issue: 14, actorLogin: 'user-14', title: 'Task #313', receivedAt: '2026-11-13T10:00:13.000Z' },
        { eventId: '914', issue: 15, actorLogin: 'user-15', title: 'Task #914', receivedAt: '2026-11-13T10:00:14.000Z' },
        { eventId: '515', issue: 16, actorLogin: 'user-16', title: 'Task #515', receivedAt: '2026-11-13T10:00:15.000Z' },
        { eventId: '116', issue: 17, actorLogin: 'user-17', title: 'Task #116', receivedAt: '2026-11-13T10:00:16.000Z' },
        { eventId: '817', issue: 18, actorLogin: 'user-18', title: 'Task #817', receivedAt: '2026-11-13T10:00:17.000Z' },
        { eventId: '418', issue: 19, actorLogin: 'user-19', title: 'Task #418', receivedAt: '2026-11-13T10:00:18.000Z' },
        { eventId: '619', issue: 20, actorLogin: 'user-20', title: 'Task #619', receivedAt: '2026-11-13T10:00:19.000Z' },
        { eventId: '220', issue: 21, actorLogin: 'user-21', title: 'Task #220', receivedAt: '2026-11-13T10:00:20.000Z' },
        { eventId: '721', issue: 22, actorLogin: 'user-22', title: 'Task #721', receivedAt: '2026-11-13T10:00:21.000Z' },
        { eventId: '522', issue: 23, actorLogin: 'user-23', title: 'Task #522', receivedAt: '2026-11-13T10:00:22.000Z' },
        { eventId: '351', issue: 24, actorLogin: 'user-24', title: 'Task #351', receivedAt: '2026-11-13T10:00:23.000Z' },
        { eventId: '352', issue: 25, actorLogin: 'user-25', title: 'Task #352', receivedAt: '2026-11-13T10:00:23.000Z' },
      ]

      // Insertion order into SQLite is scrambled.
      // Index 5 ('302') is inserted before index 4 ('301') to reverse tied insertion order across cutoff.
      // Index 24 ('352') is inserted before index 23 ('351') to reverse tied insertion order within included set.
      const insertionOrder = [
        17, 3, 24, 8, 12, 1, 21, 5, 14, 0, 19, 7, 23, 11, 4, 16, 2, 20, 9, 13, 22, 6, 18, 10, 15,
      ]
      for (const idx of insertionOrder) {
        const ev = allEvents[idx]!
        insertEvent(db, {
          eventId: ev.eventId,
          repo: 'org/repo',
          issue: ev.issue,
          actorLogin: ev.actorLogin,
          status: 'pending',
          title: ev.title,
          scopeJson: '["src"]',
          receivedAt: ev.receivedAt,
        })
      }

      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally {
      db.close()
    }

    const status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 }) as unknown as StatusWithGitHub
    expect(status.github).toBeDefined()
    expect(status.github).not.toBeNull()
    const pending = status.github?.pending ?? []

    // Must be capped at exactly 20 rows
    expect(pending).toHaveLength(20)

    // Oldest 5 rows must be excluded (including '301' which lost tie-break across cutoff to '302')
    const eventIds = pending.map((e) => e.eventId)
    const excludedIds = ['804', '202', '703', '101', '301']
    for (const id of excludedIds) {
      expect(eventIds).not.toContain(id)
    }

    // Newest 20 rows must be included and ordered OLDEST FIRST
    const expectedIds = [
      '302',
      '906',
      '407',
      '608',
      '109',
      '810',
      '211',
      '712',
      '313',
      '914',
      '515',
      '116',
      '817',
      '418',
      '619',
      '220',
      '721',
      '522',
      '351',
      '352',
    ]
    expect(eventIds).toEqual(expectedIds)

    // Cutoff tie-break check: between 301 and 302 at 10:00:05.000Z, 302 was kept and appears first
    expect(eventIds[0]).toBe('302')

    // High tie-break check: between 351 and 352 with identical received_at, 351 precedes 352
    expect(eventIds[18]).toBe('351')
    expect(eventIds[19]).toBe('352')

    // Also assert CLI --json preserves the exact order and length
    const res = run(dir, '--json')
    expect(res.status).toBe(0)
    const json = JSON.parse(res.stdout)
    expect(json.github?.pending.map((e: { eventId: string }) => e.eventId)).toEqual(expectedIds)
  })

  it('CHK-M6-07-a: github is present when events exist without cursor', () => {
    const dir = makeFixtureDir()
    const dbPath = join(dir, 'state.sqlite')
    const db = openStore(dbPath)

    try {
      seedProject(db, dir)
      insertEvent(db, {
        eventId: '55',
        repo: 'org/standalone',
        status: 'ignored',
        reason: 'repo-not-allowed',
      })
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally {
      db.close()
    }

    const status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 }) as unknown as StatusWithGitHub
    expect(status.github).toBeDefined()
    expect(status.github).not.toBeNull()
    expect(status.github?.repos).toEqual([])
    expect(status.github?.events).toEqual({
      ignored: 1,
      pending: 0,
      approved: 0,
      rejected: 0,
    })
    expect(status.github?.pending).toEqual([])
  })

  it('CHK-M6-07-a: github has all four zero event counts and empty pending when cursor exists without events', () => {
    const dir = makeFixtureDir()
    const dbPath = join(dir, 'state.sqlite')
    const db = openStore(dbPath)

    try {
      seedProject(db, dir)
      insertCursor(db, {
        repo: 'org/cursor-only',
        nextPollMs: 1768220000000,
        etag: null,
        error: null,
      })
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally {
      db.close()
    }

    const status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 }) as unknown as StatusWithGitHub
    expect(status.github).toBeDefined()
    expect(status.github).not.toBeNull()
    expect(status.github?.repos).toEqual([
      {
        name: 'org/cursor-only',
        lastPollAt: stamp,
        nextPollAt: new Date(1768220000000).toISOString(),
        etag: false,
        error: null,
      },
    ])
    expect(status.github?.events).toEqual({
      ignored: 0,
      pending: 0,
      approved: 0,
      rejected: 0,
    })
    expect(status.github?.pending).toEqual([])

    const res = run(dir, '--json')
    expect(res.status).toBe(0)
    const json = JSON.parse(res.stdout)
    expect(json.github?.events).toEqual({
      ignored: 0,
      pending: 0,
      approved: 0,
      rejected: 0,
    })
    expect(json.github?.pending).toEqual([])
  })

  it('CHK-M6-07-b: Arabic view shows repo name, poll times, counts, and pending event facts', () => {
    const dir = makeFixtureDir()
    const dbPath = join(dir, 'state.sqlite')
    const db = openStore(dbPath)
    const canaryText = 'CANARY_ARABIC_VIEW_BODY_SECRET'

    try {
      seedProject(db, dir)
      db.prepare('INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)').run(
        'cmd-prior',
        'p',
        'task.create',
        '{}',
        stamp,
      )
      db.prepare(
        'INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at, scope_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run('prior-task', 'p', 'cmd-prior', 'Prior task', 'ready', stamp, stamp, '["."]')

      insertCursor(db, {
        repo: 'owner/backend',
        updatedAt: '2026-11-13T14:30:00.000Z',
        nextPollMs: 1768220000000,
        etag: 'etag-xyz',
        error: 'policy: missing',
      })
      // Insert events with distinct counts for all 4 statuses:
      // pending: 18, ignored: 31, approved: 47, rejected: 73
      //
      // Counts are chosen as unique multi-digit numbers (31, 18, 47, 73) that do NOT
      // appear as substrings in any timestamp, schema version, phase ordinal, command count,
      // attempt budget, issue number, or event ID.
      // Furthermore, pending titles and actors use purely alphabetic strings so they cannot
      // accidentally contain any count digits.
      // Asserting absence of digit strings when rendered without the count summary is not
      // directly possible via the CLI runner, so selecting collision-free numbers guarantees
      // that omitting the count summary line causes the count assertions to fail non-vacuously.
      insertEvent(db, {
        eventId: '9001',
        repo: 'owner/backend',
        issue: 42,
        actorLogin: 'lead-dev',
        status: 'pending',
        title: 'Add OAuth authentication',
        scopeJson: '["src/auth"]',
        receivedAt: '2026-11-13T14:35:00.000Z',
        text: canaryText,
      })
      const pendingNatoSuffixes = [
        'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf',
        'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike',
        'november', 'oscar', 'papa', 'quebec', 'romeo',
      ]
      for (let i = 0; i < pendingNatoSuffixes.length; i++) {
        const suffix = pendingNatoSuffixes[i]
        insertEvent(db, {
          eventId: String(700000 + i * 100),
          repo: 'owner/backend',
          issue: 501 + i,
          actorLogin: `dev-${suffix}`,
          status: 'pending',
          title: `Pending task ${suffix}`,
          scopeJson: '["src"]',
          receivedAt: '2026-11-13T14:35:00.000Z',
        })
      }
      for (let i = 1; i <= 31; i++) {
        insertEvent(db, {
          eventId: `ign-${i}`,
          repo: 'owner/backend',
          status: 'ignored',
          reason: 'bot-actor',
        })
      }
      for (let i = 1; i <= 47; i++) {
        insertEvent(db, {
          eventId: `app-${i}`,
          repo: 'owner/backend',
          status: 'approved',
          title: 'Prior task approved',
          scopeJson: '["."]',
          taskId: 'prior-task',
          decidedAt: '2026-11-13T14:36:00.000Z',
        })
      }
      for (let i = 1; i <= 73; i++) {
        insertEvent(db, {
          eventId: `rej-${i}`,
          repo: 'owner/backend',
          status: 'rejected',
          reason: 'no-command',
        })
      }

      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally {
      db.close()
    }

    const status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 }) as unknown as StatusWithGitHub
    expect(status.github?.events).toEqual({
      ignored: 31,
      pending: 18,
      approved: 47,
      rejected: 73,
    })
    const formatted = formatStatus(status as unknown as Status)
    const res = run(dir)
    expect(res.status).toBe(0)

    for (const output of [formatted, res.stdout]) {
      // Must contain Arabic characters
      expect(output).toMatch(/[\u0600-\u06ff]/)

      // Must show repo name
      expect(output).toContain('owner/backend')

      // Must show poll times
      expect(output).toContain('2026-11-13T14:30:00.000Z')
      expect(output).toContain(new Date(1768220000000).toISOString())

      // Must show paused-policy error from M6-05
      expect(output).toContain('policy: missing')

      // Must show all four event counts with distinguishable values (without fixing wording or field order).
      // Counts are non-vacuous: 31, 18, 47, and 73 are unique and absent from all other rendered facts.
      expect(output).toMatch(/\b31\b/)
      expect(output).toMatch(/\b18\b/)
      expect(output).toMatch(/\b47\b/)
      expect(output).toMatch(/\b73\b/)

      // Must show pending event facts: eventId, issue number, actor, title
      expect(output).toContain('9001')
      expect(output).toContain('42')
      expect(output).toContain('lead-dev')
      expect(output).toContain('Add OAuth authentication')

      // Must NOT leak stored event body text
      expect(output).not.toContain(canaryText)
    }
  })

  it('CHK-M6-07-b: titles and actors with bidi overrides and controls are re-sanitized in BOTH outputs', () => {
    const dir = makeFixtureDir()
    const dbPath = join(dir, 'state.sqlite')
    const db = openStore(dbPath)

    // Direct insertion of hostile title containing:
    // bidi override U+202E, C0 controls \x00, \x07, \x1F
    const hostileTitle1 = 'Task\u202EAttack\x00\x07Title\x1FTest'
    const hostileActor1 = 'bad\u202Euser\x00'

    // Direct insertion of title with newlines and tabs
    const hostileTitle2 = 'TitleLine1\r\nTitleLine2\tTabbed'
    const normalActor2 = 'cleanuser'

    try {
      seedProject(db, dir)
      insertCursor(db, {
        repo: 'org/repo',
        nextPollMs: 1768220000000,
      })

      insertEvent(db, {
        eventId: '701',
        repo: 'org/repo',
        issue: 11,
        actorLogin: hostileActor1,
        status: 'pending',
        title: hostileTitle1,
        scopeJson: '["src"]',
        receivedAt: '2026-11-13T10:00:01.000Z',
      })
      insertEvent(db, {
        eventId: '702',
        repo: 'org/repo',
        issue: 12,
        actorLogin: normalActor2,
        status: 'pending',
        title: hostileTitle2,
        scopeJson: '["docs"]',
        receivedAt: '2026-11-13T10:00:02.000Z',
      })

      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally {
      db.close()
    }

    const status = readStatus(dir, { nowMs: 1000, staleAfterMs: 500 }) as unknown as StatusWithGitHub
    expect(status.github).toBeDefined()
    expect(status.github).not.toBeNull()

    const pending0 = status.github?.pending[0]
    const pending1 = status.github?.pending[1]

    // Verify in status object:
    expect(pending0?.title).toBe('TaskAttackTitleTest')
    expect(pending0?.title).not.toContain('\u202e')
    expect(pending0?.title).not.toMatch(/[\u0000-\u001f]/)

    expect(pending0?.actor).toBe('baduser')
    expect(pending0?.actor).not.toContain('\u202e')
    expect(pending0?.actor).not.toMatch(/[\u0000-\u001f]/)

    // Verify newline handling against existing sanitizer: collapsed/stripped
    expect(pending1?.title).toBe('TitleLine1TitleLine2Tabbed')
    expect(pending1?.title).not.toContain('\r')
    expect(pending1?.title).not.toContain('\n')

    // Verify in CLI --json output:
    const resJson = run(dir, '--json')
    expect(resJson.status).toBe(0)
    const parsedJson = JSON.parse(resJson.stdout)
    const jsonPending0 = parsedJson.github?.pending[0]
    const jsonPending1 = parsedJson.github?.pending[1]

    expect(jsonPending0?.title).toBe('TaskAttackTitleTest')
    expect(jsonPending0?.actor).toBe('baduser')
    expect(jsonPending1?.title).toBe('TitleLine1TitleLine2Tabbed')

    // Verify in Arabic output (both formatStatus and CLI standard stdout):
    const formatted = formatStatus(status as unknown as Status)
    const resArabic = run(dir)
    expect(resArabic.status).toBe(0)

    for (const output of [formatted, resArabic.stdout]) {
      // Must not contain raw bidi overrides
      expect(output).not.toContain('\u202e')
      // Must not contain raw control bytes
      expect(output).not.toContain('\x00')
      expect(output).not.toContain('\x07')
      expect(output).not.toContain('\x1f')

      // Must contain re-sanitized title and actor
      expect(output).toContain('TaskAttackTitleTest')
      expect(output).toContain('baduser')
      expect(output).toContain('TitleLine1TitleLine2Tabbed')
    }
  })

  it('CHK-M6-07-c: unknown github_events.status causes exit 1 with malformed-data message', () => {
    const dir = makeFixtureDir()
    const dbPath = join(dir, 'state.sqlite')
    const db = openStore(dbPath)

    try {
      seedProject(db, dir)
      insertCursor(db, {
        repo: 'org/repo',
        nextPollMs: 1768220000000,
      })

      // Drop triggers and recreate github_events table without CHECK constraint to inject unknown status
      db.exec('DROP TRIGGER IF EXISTS github_events_pending_check')
      db.exec('DROP TRIGGER IF EXISTS github_events_immutable')
      db.exec('DROP TRIGGER IF EXISTS github_events_no_delete')
      db.exec(`
        CREATE TABLE github_events_temp (
          event_id TEXT NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id),
          repo TEXT NOT NULL,
          kind TEXT NOT NULL,
          actor_id INTEGER NOT NULL,
          actor_login TEXT NOT NULL,
          issue INTEGER NOT NULL,
          status TEXT NOT NULL,
          reason TEXT,
          title TEXT,
          scope_json TEXT,
          basis_json TEXT,
          text TEXT NOT NULL,
          text_trust TEXT NOT NULL,
          text_sha256 TEXT NOT NULL,
          event_at TEXT NOT NULL,
          received_at TEXT NOT NULL,
          decided_at TEXT,
          decided_by_command TEXT,
          task_id TEXT,
          PRIMARY KEY (project_id, event_id)
        );
        INSERT INTO github_events_temp SELECT * FROM github_events;
        DROP TABLE github_events;
        ALTER TABLE github_events_temp RENAME TO github_events;
      `)

      insertEvent(db, {
        eventId: '999',
        repo: 'org/repo',
        status: 'invalid_status_value',
        title: 'Some title',
        scopeJson: '["src"]',
      })

      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally {
      db.close()
    }

    // CLI --json must exit 1 with malformed-data message
    const resJson = run(dir, '--json')
    expect(resJson.status).toBe(1)
    expect(resJson.stderr).toContain('بيانات قاعدة البيانات غير صالحة')

    // CLI Arabic view must exit 1 with malformed-data message
    const resArabic = run(dir)
    expect(resArabic.status).toBe(1)
    expect(resArabic.stderr).toContain('بيانات قاعدة البيانات غير صالحة')

    // readStatus must throw
    expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow()
  })

  it.each([
    { desc: 'empty title', titleValue: '' },
    { desc: 'null title', titleValue: null },
  ])('CHK-M6-07-c: pending row with $desc causes exit 1 with malformed-data message', ({ titleValue }) => {
    const dir = makeFixtureDir()
    const dbPath = join(dir, 'state.sqlite')
    const db = openStore(dbPath)

    try {
      seedProject(db, dir)
      insertCursor(db, {
        repo: 'org/repo',
        nextPollMs: 1768220000000,
      })

      // Drop pending-insert check trigger to allow inserting invalid title directly
      db.exec('DROP TRIGGER IF EXISTS github_events_pending_check')

      insertEvent(db, {
        eventId: '888',
        repo: 'org/repo',
        issue: 1,
        status: 'pending',
        title: titleValue,
        scopeJson: '["src"]',
      })

      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally {
      db.close()
    }

    // CLI --json must exit 1 with malformed-data message
    const resJson = run(dir, '--json')
    expect(resJson.status).toBe(1)
    expect(resJson.stderr).toContain('بيانات قاعدة البيانات غير صالحة')

    // CLI Arabic view must exit 1 with malformed-data message
    const resArabic = run(dir)
    expect(resArabic.status).toBe(1)
    expect(resArabic.stderr).toContain('بيانات قاعدة البيانات غير صالحة')

    // readStatus must throw
    expect(() => readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })).toThrow()
  })

  it('CHK-M6-07-c: status process is read-only and leaves db file bytes unchanged', () => {
    const dir = makeFixtureDir()
    const dbPath = join(dir, 'state.sqlite')
    const db = openStore(dbPath)

    try {
      seedProject(db, dir)
      insertCursor(db, {
        repo: 'org/repo',
        nextPollMs: 1768220000000,
        etag: 'tag-1',
        error: null,
      })
      insertEvent(db, {
        eventId: '601',
        repo: 'org/repo',
        issue: 1,
        actorLogin: 'alice',
        status: 'pending',
        title: 'Task title',
        scopeJson: '["src"]',
        basisJson: '{"version":1}',
      })
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally {
      db.close()
    }

    const baselineHash = fileHash(dbPath)
    const baselineContents = dumpDatabaseContents(dbPath)

    // Run in-process reader and verify both hash and logical database contents after call
    readStatus(dir, { nowMs: 1000, staleAfterMs: 500 })
    expect(fileHash(dbPath)).toBe(baselineHash)
    expect(dumpDatabaseContents(dbPath)).toBe(baselineContents)

    // Run CLI --json and verify both hash and logical database contents after call
    const resJson = run(dir, '--json')
    expect(resJson.status).toBe(0)
    expect(fileHash(dbPath)).toBe(baselineHash)
    expect(dumpDatabaseContents(dbPath)).toBe(baselineContents)

    // Run CLI Arabic view and verify both hash and logical database contents after call
    const resArabic = run(dir)
    expect(resArabic.status).toBe(0)
    expect(fileHash(dbPath)).toBe(baselineHash)
    expect(dumpDatabaseContents(dbPath)).toBe(baselineContents)
  })
})
