import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openStore } from '../../supervisor/src/app/store.ts'
import { acquireSupervisor, LeaseLostError } from '../../supervisor/src/app/supervisor-lease.ts'
import { runTick, type LoopDeps } from '../../supervisor/src/app/supervisor-loop.ts'
import { parsePolicy } from '../../supervisor/src/sources/github/gate.ts'
import { createFakeGitHub } from '../../supervisor/src/sources/github/fake.ts'
import type { GitHubPort, PollResult } from '../../supervisor/src/sources/github/ports.ts'

declare module '../../supervisor/src/app/supervisor-loop.ts' {
  interface LoopDeps {
    github?: {
      port: GitHubPort
      policyPath: string
      pollTimeoutMs?: number
    }
  }
}

const directories: string[] = []

function makeTempDir(prefix = 'm6-poll-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  directories.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of directories.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    } catch {
      // ignore deletion errors during cleanup
    }
  }
})

function createGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  spawnSync('git', ['init', dir], { stdio: 'ignore', timeout: 15000 })
  spawnSync('git', ['-C', dir, '-c', 'user.name=Factory Test', '-c', 'user.email=factory@example.test', 'config', 'core.autocrlf', 'false'], { stdio: 'ignore' })
  writeFileSync(join(dir, 'README.md'), '# test\n', 'utf8')
  spawnSync('git', ['-C', dir, '-c', 'user.name=Factory Test', '-c', 'user.email=factory@example.test', 'add', '.'], { stdio: 'ignore' })
  spawnSync('git', ['-C', dir, '-c', 'user.name=Factory Test', '-c', 'user.email=factory@example.test', 'commit', '-m', 'initial commit'], { stdio: 'ignore' })
  spawnSync('git', ['-C', dir, 'branch', '-M', 'main'], { stdio: 'ignore' })
}

function setupDatabase(stateDir: string, projectId = 'p1', repoDir?: string): { db: DatabaseSync; dbPath: string; repoDir: string } {
  const repo = repoDir ?? join(stateDir, 'repo')
  if (!existsSync(join(repo, '.git'))) {
    createGitRepo(repo)
  }
  const dbPath = join(stateDir, 'state.sqlite')
  const db = openStore(dbPath)
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000')
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, 'Project', '2026-11-13T00:00:00.000Z')").run(projectId)
  db.prepare("INSERT INTO project_config (project_id, repo_path, base_ref, created_at) VALUES (?, ?, 'main', '2026-11-13T00:00:00.000Z')").run(projectId, repo)
  db.prepare("INSERT INTO phases (project_id, name, ord, status, opened_at) VALUES (?, 'intake', 1, 'open', '2026-11-13T00:00:00.000Z')").run(projectId)
  db.prepare("INSERT INTO phases (project_id, name, ord, status) VALUES (?, 'development', 2, 'locked')").run(projectId)
  db.prepare("INSERT INTO phases (project_id, name, ord, status) VALUES (?, 'qa', 3, 'locked')").run(projectId)
  db.prepare("INSERT INTO phases (project_id, name, ord, status) VALUES (?, 'devops', 4, 'locked')").run(projectId)
  db.prepare("INSERT INTO phases (project_id, name, ord, status) VALUES (?, 'handover', 5, 'locked')").run(projectId)
  return { db, dbPath, repoDir: repo }
}

function writePolicy(path: string, policy: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify(policy, null, 2), 'utf8')
}

function defaultPolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    repos: [
      { name: 'owner/repo', labels: ['factory'], scope: ['.'] },
    ],
    actors: [
      { id: 1, login: 'alice' },
    ],
    command: '/factory task',
    maxPendingPerRepo: 10,
    ...overrides,
  }
}

function makeIssueCommentEvent(
  id: string,
  repo: string,
  actorId: number,
  actorLogin: string,
  commentBody: string,
  labels: string[] = ['factory'],
): Record<string, unknown> {
  return {
    id,
    type: 'IssueCommentEvent',
    actor: { id: actorId, login: actorLogin, type: 'User' },
    repo: { name: repo },
    payload: {
      action: 'created',
      issue: {
        number: 42,
        title: 'Issue title',
        body: 'Issue body',
        labels: labels.map((name) => ({ name })),
      },
      comment: {
        body: commentBody,
      },
    },
    created_at: '2026-11-13T00:00:00.000Z',
  }
}

function insertReadyTask(db: DatabaseSync, taskId: string, projectId = 'p1', title = 'Test task'): void {
  const commandId = randomUUID()
  db.prepare(`
    INSERT INTO commands (id, project_id, kind, payload_json, created_at)
    VALUES (?, ?, 'task.create', '{"title":"Test task"}', '2026-11-13T00:00:00.000Z')
  `).run(commandId, projectId)

  db.prepare(`
    INSERT INTO command_outcomes (command_id, outcome, reason, lease_generation, applied_at)
    VALUES (?, 'applied', NULL, 1, '2026-11-13T00:00:00.000Z')
  `).run(commandId)

  db.prepare(`
    INSERT INTO tasks (id, project_id, created_by_command, title, status, phase, scope_json, max_attempts, not_before_ms, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'ready', 'intake', '["."]', 3, 0, '2026-11-13T00:00:00.000Z', '2026-11-13T00:00:00.000Z')
  `).run(taskId, projectId, commandId, title)
}

function createTestDeps(options: {
  stateDir: string
  github?: {
    port: GitHubPort
    policyPath: string
    pollTimeoutMs?: number
  }
  spawnWorker?: LoopDeps['spawnWorker']
}): LoopDeps {
  return {
    stateDir: options.stateDir,
    staleAfterMs: 300000,
    spawnWorker: options.spawnWorker ?? (async () => ({ pid: process.pid, nonce: 'nonce-test' })),
    isAlive: () => true,
    readResult: () => undefined,
    killTree: async () => ({ result: 'killed' as const }),
    github: options.github,
  }
}

describe('M6-05 in-process polling in the Supervisor loop', () => {
  it('CHK-M6-05-a: polls a due repo, stores events, and does not poll again before next_poll_ms', async () => {
    const stateDir = makeTempDir()
    const { db } = setupDatabase(stateDir)
    const policyPath = join(stateDir, 'github-policy.json')
    writePolicy(policyPath, defaultPolicy())

    const fake = createFakeGitHub()
    fake.push('owner/repo', [
      makeIssueCommentEvent('1001', 'owner/repo', 1, 'alice', '/factory task Fix issue 1'),
    ])

    const deps = createTestDeps({
      stateDir,
      github: { port: fake, policyPath, pollTimeoutMs: 20000 },
    })

    const baseNow = 1_000_000
    const handle = acquireSupervisor(db, stateDir, { nowMs: baseNow, staleAfterMs: 300000 })
    try {
      // 1. First tick at baseNow polls the due repo
      await runTick(db, handle, deps, baseNow)

      expect(fake.calls).toEqual([{ repo: 'owner/repo', etag: null }])
      const eventRow = db.prepare('SELECT event_id, status, title FROM github_events WHERE event_id = ?').get('1001') as { event_id: string; status: string; title: string } | undefined
      expect(eventRow).toBeDefined()
      expect(eventRow?.status).toBe('pending')
      expect(eventRow?.title).toBe('Fix issue 1')

      const cursorRow = db.prepare('SELECT etag, next_poll_ms, error FROM github_cursor WHERE repo = ?').get('owner/repo') as { etag: string; next_poll_ms: number; error: string | null } | undefined
      expect(cursorRow).toBeDefined()
      expect(cursorRow?.etag).toBe('e1')
      expect(cursorRow?.error).toBeNull()
      expect(cursorRow?.next_poll_ms).toBe(baseNow + 60000)
      const nextPollMs = cursorRow!.next_poll_ms

      // 2. Second tick immediately before next_poll_ms does not poll again
      await runTick(db, handle, deps, nextPollMs - 1)
      expect(fake.calls).toHaveLength(1)

      // 3. Tick at or after next_poll_ms polls again
      await runTick(db, handle, deps, nextPollMs)
      expect(fake.calls).toHaveLength(2)
      expect(fake.calls[1]).toEqual({ repo: 'owner/repo', etag: 'e1' })
    } finally {
      handle.release(baseNow)
      db.close()
    }
  })

  it('CHK-M6-05-a: two repos polled one at a time in policy order (held first poll proves sequential execution)', async () => {
    const stateDir = makeTempDir()
    const { db } = setupDatabase(stateDir)
    const policyPath = join(stateDir, 'github-policy.json')
    writePolicy(policyPath, defaultPolicy({
      repos: [
        { name: 'owner/repo-alpha', labels: ['factory'], scope: ['src/alpha'] },
        { name: 'owner/repo-beta', labels: ['factory'], scope: ['src/beta'] },
      ],
    }))

    let alphaResolved = false
    let betaStarted = false
    let resolveAlpha: (res: PollResult) => void
    const alphaPromise = new Promise<PollResult>((resolve) => {
      resolveAlpha = resolve
    })

    const calls: Array<{ repo: string; etag: string | null }> = []
    const sequentialPort: GitHubPort = {
      async poll(input) {
        calls.push(input)
        if (input.repo === 'owner/repo-alpha') {
          return alphaPromise.then((res) => {
            alphaResolved = true
            return res
          })
        }
        if (input.repo === 'owner/repo-beta') {
          betaStarted = true
          // If execution was concurrent (Promise.all), alphaResolved would be false here
          expect(alphaResolved).toBe(true)
          return {
            kind: 'events',
            etag: 'e1',
            pollAfterMs: 60000,
            events: [makeIssueCommentEvent('2002', 'owner/repo-beta', 1, 'alice', '/factory task Beta task')],
          }
        }
        throw new Error(`Unexpected repo: ${input.repo}`)
      },
    }

    const deps = createTestDeps({
      stateDir,
      github: { port: sequentialPort, policyPath, pollTimeoutMs: 20000 },
    })

    const nowMs = 1_000_000
    const handle = acquireSupervisor(db, stateDir, { nowMs, staleAfterMs: 300000 })
    try {
      const tickPromise = runTick(db, handle, deps, nowMs)

      // Allow tick microtasks to progress
      await new Promise((r) => setTimeout(r, 20))

      // Alpha is in flight and unresolved; beta MUST NOT have started
      expect(calls).toEqual([{ repo: 'owner/repo-alpha', etag: null }])
      expect(betaStarted).toBe(false)
      expect(alphaResolved).toBe(false)

      // Resolve alpha now
      resolveAlpha!({
        kind: 'events',
        etag: 'e1',
        pollAfterMs: 60000,
        events: [makeIssueCommentEvent('2001', 'owner/repo-alpha', 1, 'alice', '/factory task Alpha task')],
      })

      await tickPromise
      expect(alphaResolved).toBe(true)
      expect(betaStarted).toBe(true)
      expect(calls).toEqual([
        { repo: 'owner/repo-alpha', etag: null },
        { repo: 'owner/repo-beta', etag: null },
      ])

      const rows = db.prepare('SELECT event_id, repo, status FROM github_events ORDER BY event_id ASC').all() as Array<{ event_id: string; repo: string; status: string }>
      expect(rows).toEqual([
        { event_id: '2001', repo: 'owner/repo-alpha', status: 'pending' },
        { event_id: '2002', repo: 'owner/repo-beta', status: 'pending' },
      ])
    } finally {
      handle.release(nowMs)
      db.close()
    }
  })

  it('CHK-M6-05-a: a 304 (not-modified) moves only the cursor', async () => {
    const stateDir = makeTempDir()
    const { db } = setupDatabase(stateDir)
    const policyPath = join(stateDir, 'github-policy.json')
    writePolicy(policyPath, defaultPolicy())

    const fake = createFakeGitHub()
    fake.push('owner/repo', [
      makeIssueCommentEvent('3001', 'owner/repo', 1, 'alice', '/factory task Task 3001'),
    ])

    const deps = createTestDeps({
      stateDir,
      github: { port: fake, policyPath, pollTimeoutMs: 20000 },
    })

    const t1 = 1_000_000
    const handle = acquireSupervisor(db, stateDir, { nowMs: t1, staleAfterMs: 300000 })
    try {
      await runTick(db, handle, deps, t1)
      const cursor1 = db.prepare('SELECT etag, next_poll_ms FROM github_cursor WHERE repo = ?').get('owner/repo') as { etag: string; next_poll_ms: number }
      expect(cursor1.etag).toBe('e1')
      expect(cursor1.next_poll_ms).toBe(t1 + 60000)
      const initialNextPoll = cursor1.next_poll_ms

      // On next tick when due, fake receives etag: 'e1' and returns not-modified
      const t2 = initialNextPoll
      await runTick(db, handle, deps, t2)

      expect(fake.calls).toHaveLength(2)
      expect(fake.calls[1]).toEqual({ repo: 'owner/repo', etag: 'e1' })

      const cursor2 = db.prepare('SELECT etag, next_poll_ms FROM github_cursor WHERE repo = ?').get('owner/repo') as { etag: string; next_poll_ms: number }
      expect(cursor2.etag).toBe('e1')
      expect(cursor2.next_poll_ms).toBe(t2 + 60000)

      // Tick immediately before next_poll_ms boundary does not poll again
      await runTick(db, handle, deps, cursor2.next_poll_ms - 1)
      expect(fake.calls).toHaveLength(2)

      // Tick at next_poll_ms boundary polls again
      await runTick(db, handle, deps, cursor2.next_poll_ms)
      expect(fake.calls).toHaveLength(3)
      expect(fake.calls[2]).toEqual({ repo: 'owner/repo', etag: 'e1' })

      const count = (db.prepare('SELECT count(*) as cnt FROM github_events').get() as { cnt: number }).cnt
      expect(count).toBe(1)
    } finally {
      handle.release(t1)
      db.close()
    }
  })

  it('CHK-M6-05-a: no policy results in zero GitHub table access and existing task executes normally (M5 loop behavior)', async () => {
    const stateDir = makeTempDir()
    const { db } = setupDatabase(stateDir)

    // Drop GitHub tables to strictly guarantee that no read or write to github tables occurs
    db.exec('DROP TABLE github_cursor; DROP TABLE github_events')

    const readyTaskId = randomUUID()
    insertReadyTask(db, readyTaskId)

    let spawnWorkerCalls = 0
    let spawnedTaskId: string | undefined
    const fake = createFakeGitHub()
    const deps = createTestDeps({
      stateDir,
      github: undefined,
      spawnWorker: async (opts) => {
        spawnWorkerCalls++
        spawnedTaskId = opts.taskId
        return { pid: process.pid, nonce: 'nonce-no-policy' }
      },
    })

    const nowMs = 1_000_000
    const handle = acquireSupervisor(db, stateDir, { nowMs, staleAfterMs: 300000 })
    try {
      // Loop executes as in M5 without accessing github tables
      const result = await runTick(db, handle, deps, nowMs)
      expect(fake.calls).toHaveLength(0)

      // Injected spawnWorker actually executed and task transitioned to progress
      expect(spawnWorkerCalls).toBe(1)
      expect(spawnedTaskId).toBe(readyTaskId)

      const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(readyTaskId) as { status: string }
      expect(task.status).toBe('progress')
      const worker = db.prepare('SELECT state, nonce FROM workers WHERE attempt_id = (SELECT id FROM attempts WHERE task_id = ?)').get(readyTaskId) as { state: string; nonce: string } | undefined
      expect(worker?.state).toBe('running')
      expect(worker?.nonce).toBe('nonce-no-policy')
      expect(result.idle).toBe(false)
    } finally {
      handle.release(nowMs)
      db.close()
    }
  })

  it('CHK-M6-05-a: polling phase placement: command drain happens before poll, and poll happens before task dispatch', async () => {
    const stateDir = makeTempDir()
    const { db } = setupDatabase(stateDir)
    const policyPath = join(stateDir, 'github-policy.json')
    writePolicy(policyPath, defaultPolicy())

    // 1. Seed a pending command to verify it is drained before poll
    const commandId = randomUUID()
    db.prepare(`
      INSERT INTO commands (id, project_id, kind, payload_json, created_at)
      VALUES (?, 'p1', 'phase.advance', '{"phase":"intake"}', '2026-11-13T00:00:00.000Z')
    `).run(commandId)

    // 2. Seed a ready task to verify dispatch has not happened yet when poll executes
    const readyTaskId = randomUUID()
    insertReadyTask(db, readyTaskId)

    let commandAppliedBeforePoll = false
    let taskStillReadyDuringPoll = false
    let spawnWorkerCalled = false

    const phasePort: GitHubPort = {
      async poll(input) {
        // Check command outcome: command must already have been applied/rejected (drained)
        const outcome = db.prepare('SELECT outcome FROM command_outcomes WHERE command_id = ?').get(commandId) as { outcome: string } | undefined
        commandAppliedBeforePoll = outcome !== undefined

        // Check task status: dispatch must NOT have occurred yet (task is still ready)
        const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(readyTaskId) as { status: string }
        taskStillReadyDuringPoll = task.status === 'ready'

        return {
          kind: 'events',
          etag: 'e1',
          pollAfterMs: 60000,
          events: [makeIssueCommentEvent('1099', input.repo, 1, 'alice', '/factory task Polled event')],
        }
      },
    }

    const deps = createTestDeps({
      stateDir,
      github: { port: phasePort, policyPath, pollTimeoutMs: 20000 },
      spawnWorker: async () => {
        spawnWorkerCalled = true
        return { pid: process.pid, nonce: 'nonce-phase' }
      },
    })

    const nowMs = 1_000_000
    const handle = acquireSupervisor(db, stateDir, { nowMs, staleAfterMs: 300000 })
    try {
      await runTick(db, handle, deps, nowMs)

      expect(commandAppliedBeforePoll).toBe(true)
      expect(taskStillReadyDuringPoll).toBe(true)
      expect(spawnWorkerCalled).toBe(true)

      // After runTick completes, task has now been dispatched to progress
      const taskAfter = db.prepare('SELECT status FROM tasks WHERE id = ?').get(readyTaskId) as { status: string }
      expect(taskAfter.status).toBe('progress')
    } finally {
      handle.release(nowMs)
      db.close()
    }
  })

  it('CHK-M6-05-b: actor removed from the policy file between two poll rounds makes that actor\'s next event ignored with reason actor-not-allowed', async () => {
    const stateDir = makeTempDir()
    const { db } = setupDatabase(stateDir)
    const policyPath = join(stateDir, 'github-policy.json')

    // Initial policy contains both alice (id 1) and bob (id 2)
    writePolicy(policyPath, defaultPolicy({
      actors: [
        { id: 1, login: 'alice' },
        { id: 2, login: 'bob' },
      ],
    }))

    const fake = createFakeGitHub()
    fake.push('owner/repo', [
      makeIssueCommentEvent('4001', 'owner/repo', 1, 'alice', '/factory task Alice event 1'),
    ])

    const deps = createTestDeps({
      stateDir,
      github: { port: fake, policyPath, pollTimeoutMs: 20000 },
    })

    const t1 = 1_000_000
    const handle = acquireSupervisor(db, stateDir, { nowMs: t1, staleAfterMs: 300000 })
    try {
      await runTick(db, handle, deps, t1)
      const ev1 = db.prepare('SELECT status, reason FROM github_events WHERE event_id = ?').get('4001') as { status: string; reason: string | null }
      expect(ev1.status).toBe('pending')
      expect(ev1.reason).toBeNull()

      const cursor = db.prepare('SELECT next_poll_ms FROM github_cursor WHERE repo = ?').get('owner/repo') as { next_poll_ms: number }

      // Between poll rounds: remove alice from policy file
      writePolicy(policyPath, defaultPolicy({
        actors: [
          { id: 2, login: 'bob' },
        ],
      }))

      // Push a new event from alice
      fake.push('owner/repo', [
        makeIssueCommentEvent('4002', 'owner/repo', 1, 'alice', '/factory task Alice event 2'),
      ])

      const t2 = cursor.next_poll_ms
      await runTick(db, handle, deps, t2)

      const ev2 = db.prepare('SELECT status, reason FROM github_events WHERE event_id = ?').get('4002') as { status: string; reason: string | null }
      expect(ev2.status).toBe('ignored')
      expect(ev2.reason).toBe('actor-not-allowed')
    } finally {
      handle.release(t1)
      db.close()
    }
  })

  it('CHK-M6-05-b: a policy that turns invalid or missing mid-run pauses polling, writes github_cursor.error \'policy: ...\' comparing against parsePolicy reason, dispatch continues, and valid policy resumes', async () => {
    const stateDir = makeTempDir()
    const { db } = setupDatabase(stateDir)
    const policyPath = join(stateDir, 'github-policy.json')
    writePolicy(policyPath, defaultPolicy())

    const fake = createFakeGitHub()
    fake.push('owner/repo', [
      makeIssueCommentEvent('5001', 'owner/repo', 1, 'alice', '/factory task Task 5001'),
    ])

    const deps = createTestDeps({
      stateDir,
      github: { port: fake, policyPath, pollTimeoutMs: 20000 },
    })

    const t1 = 1_000_000
    const handle = acquireSupervisor(db, stateDir, { nowMs: t1, staleAfterMs: 300000 })
    try {
      // 1. Initial valid round creates cursor with error = null
      await runTick(db, handle, deps, t1)
      const initialCursor = db.prepare('SELECT etag, next_poll_ms, error FROM github_cursor WHERE repo = ?').get('owner/repo') as { etag: string; next_poll_ms: number; error: string | null }
      expect(initialCursor.error).toBeNull()

      // Insert an existing ready task to verify dispatch continues even when policy is invalid
      const readyTaskId = randomUUID()
      insertReadyTask(db, readyTaskId)
      let spawnWorkerCalledDuringInvalidPolicy = false
      const invalidPolicyDeps = createTestDeps({
        stateDir,
        github: { port: fake, policyPath, pollTimeoutMs: 20000 },
        spawnWorker: async () => {
          spawnWorkerCalledDuringInvalidPolicy = true
          return { pid: process.pid, nonce: 'nonce-invalid-policy' }
        },
      })

      // 2. Policy file turns missing mid-run
      unlinkSync(policyPath)
      const t2 = initialCursor.next_poll_ms
      await runTick(db, handle, invalidPolicyDeps, t2)

      expect(fake.calls).toHaveLength(1) // polling paused: no new poll call
      const missingCursor = db.prepare('SELECT error FROM github_cursor WHERE repo = ?').get('owner/repo') as { error: string }
      expect(missingCursor.error).toBe('policy: missing')

      // Dispatch of the existing ready task continued and worker was spawned!
      expect(spawnWorkerCalledDuringInvalidPolicy).toBe(true)
      const taskRow = db.prepare('SELECT status FROM tasks WHERE id = ?').get(readyTaskId) as { status: string }
      expect(taskRow.status).toBe('progress')

      // 3. Policy file turns invalid JSON mid-run
      writeFileSync(policyPath, '{"broken json: true', 'utf8')
      const t3 = t2 + 10_000
      await runTick(db, handle, deps, t3)

      expect(fake.calls).toHaveLength(1) // polling still paused
      const invalidJsonCursor = db.prepare('SELECT error FROM github_cursor WHERE repo = ?').get('owner/repo') as { error: string }
      expect(invalidJsonCursor.error).toBe('policy: invalid json')

      // 4. Policy file turns invalid policy schema mid-run: compare against parsePolicy returned reason
      const badPolicy = defaultPolicy({
        repos: [{ name: 'owner/repo', labels: ['factory'], scope: ['../escape'] }],
      })
      const parsedBad = parsePolicy(badPolicy)
      expect(parsedBad.ok).toBe(false)
      const expectedReason = (parsedBad as { ok: false; reason: string }).reason

      writePolicy(policyPath, badPolicy)
      const t4 = t3 + 10_000
      await runTick(db, handle, deps, t4)

      expect(fake.calls).toHaveLength(1) // polling still paused
      const invalidPolicyCursor = db.prepare('SELECT error FROM github_cursor WHERE repo = ?').get('owner/repo') as { error: string }
      expect(invalidPolicyCursor.error).toBe('policy: ' + expectedReason)

      // 5. Valid policy restored: polling resumes and next successful poll clears error
      writePolicy(policyPath, defaultPolicy())
      fake.push('owner/repo', [
        makeIssueCommentEvent('5002', 'owner/repo', 1, 'alice', '/factory task Task 5002'),
      ])

      const t5 = t4 + 10_000
      await runTick(db, handle, deps, t5)

      expect(fake.calls).toHaveLength(2) // polling resumed
      const resumedCursor = db.prepare('SELECT error, etag FROM github_cursor WHERE repo = ?').get('owner/repo') as { error: string | null; etag: string }
      expect(resumedCursor.error).toBeNull()
      expect(resumedCursor.etag).toBe('e2')
    } finally {
      handle.release(t1)
      db.close()
    }
  })

  it('CHK-M6-05-b: non-retryable error marks repo stopped in IngestState so subsequent ticks skip it, while restart with new LoopDeps resumes polling', async () => {
    const stateDir = makeTempDir()
    const { db } = setupDatabase(stateDir)
    const policyPath = join(stateDir, 'github-policy.json')
    writePolicy(policyPath, defaultPolicy())

    const fake = createFakeGitHub()
    // Script a non-retryable 404 error
    fake.script('owner/repo', { kind: 'error', retryable: false, message: 'Not Found' })

    const deps = createTestDeps({
      stateDir,
      github: { port: fake, policyPath, pollTimeoutMs: 20000 },
    })

    const t1 = 1_000_000
    const handle = acquireSupervisor(db, stateDir, { nowMs: t1, staleAfterMs: 300000 })
    try {
      // 1. First tick polls and encounters non-retryable error
      await runTick(db, handle, deps, t1)
      expect(fake.calls).toHaveLength(1)

      const cursor = db.prepare('SELECT error, next_poll_ms FROM github_cursor WHERE repo = ?').get('owner/repo') as { error: string; next_poll_ms: number }
      expect(cursor.error).toBe('Not Found')

      // 2. Subsequent tick with same deps (same IngestState) at or past next_poll_ms skips polling
      await runTick(db, handle, deps, t1 + 100_000)
      expect(fake.calls).toHaveLength(1) // Still 1: repo is stopped in memory

      // 3. Restart with fresh LoopDeps (representing new supervisor process with fresh IngestState)
      const restartDeps = createTestDeps({
        stateDir,
        github: { port: fake, policyPath, pollTimeoutMs: 20000 },
      })

      // On next tick after restart, repo is no longer in stopped set and is polled again
      await runTick(db, handle, restartDeps, t1 + 100_000)
      expect(fake.calls).toHaveLength(2)
    } finally {
      handle.release(t1)
      db.close()
    }
  })

  it('CHK-M6-05-c: a throwing port converts to a retryable error with sanitized fixed message, exact backoff, and continued dispatch of ready tasks', async () => {
    const stateDir = makeTempDir()
    const { db } = setupDatabase(stateDir)
    const policyPath = join(stateDir, 'github-policy.json')
    writePolicy(policyPath, defaultPolicy())

    let pollCalls = 0
    const rawError1 = 'raw internal error: socket hangup in custom transport'
    const rawError2 = 'completely different thrown error: connection reset by peer'
    const throwingPort: GitHubPort = {
      poll: async () => {
        pollCalls++
        throw new Error(pollCalls === 1 ? rawError1 : rawError2)
      },
    }

    const readyTaskId = randomUUID()
    insertReadyTask(db, readyTaskId)
    let workerSpawned = false

    const deps = createTestDeps({
      stateDir,
      github: {
        port: throwingPort,
        policyPath,
        pollTimeoutMs: 20000,
      },
      spawnWorker: async () => {
        workerSpawned = true
        return { pid: process.pid, nonce: 'nonce-throwing' }
      },
    })

    const nowMs1 = 1_000_000
    const handle = acquireSupervisor(db, stateDir, { nowMs: nowMs1, staleAfterMs: 300000 })
    try {
      // 1. First tick polls and port throws: runTick must settle without rejecting
      await runTick(db, handle, deps, nowMs1)
      expect(pollCalls).toBe(1)

      // Cursor recorded retryable error: sanitized fixed message (never leaks raw thrown text) and exact first-round backoff (60,000 ms)
      const cursor1 = db.prepare('SELECT error, next_poll_ms FROM github_cursor WHERE repo = ?').get('owner/repo') as { error: string; next_poll_ms: number }
      expect(typeof cursor1.error).toBe('string')
      expect(cursor1.error.trim().length).toBeGreaterThan(0)
      expect(cursor1.error).not.toContain(rawError1)
      expect(cursor1.error).not.toContain(rawError2)
      expect(cursor1.next_poll_ms).toBe(nowMs1 + 60000)

      // Ready task dispatch continued despite thrown port error
      expect(workerSpawned).toBe(true)
      const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(readyTaskId) as { status: string }
      expect(task.status).toBe('progress')
      const worker = db.prepare('SELECT state, nonce FROM workers WHERE attempt_id = (SELECT id FROM attempts WHERE task_id = ?)').get(readyTaskId) as { state: string; nonce: string } | undefined
      expect(worker?.state).toBe('running')
      expect(worker?.nonce).toBe('nonce-throwing')

      // Tick immediately before next_poll_ms does not poll
      await runTick(db, handle, deps, cursor1.next_poll_ms - 1)
      expect(pollCalls).toBe(1)

      // 2. Second tick at next_poll_ms polls again, encounters second consecutive error, doubles backoff to 120,000 ms
      const nowMs2 = cursor1.next_poll_ms
      await runTick(db, handle, deps, nowMs2)
      expect(pollCalls).toBe(2)

      const cursor2 = db.prepare('SELECT error, next_poll_ms FROM github_cursor WHERE repo = ?').get('owner/repo') as { error: string; next_poll_ms: number }
      expect(typeof cursor2.error).toBe('string')
      expect(cursor2.error.trim().length).toBeGreaterThan(0)
      expect(cursor2.error).not.toContain(rawError1)
      expect(cursor2.error).not.toContain(rawError2)
      expect(cursor2.error).toBe(cursor1.error) // Fixed diagnostic is stable across rounds and identical despite distinct thrown errors
      expect(cursor2.next_poll_ms).toBe(nowMs2 + 120000)
    } finally {
      handle.release(nowMs1)
      db.close()
    }
  })

  it('CHK-M6-05-c: a poll timeout (default 20000ms verified with fake timers) is a retryable error, subsequent rounds apply consecutive-error backoff, and loop keeps dispatching ready tasks', async () => {
    vi.useFakeTimers()
    const stateDir = makeTempDir()
    const { db } = setupDatabase(stateDir)
    const policyPath = join(stateDir, 'github-policy.json')
    writePolicy(policyPath, defaultPolicy())

    let pollCalls = 0
    const hangingPort: GitHubPort = {
      poll: async () => {
        pollCalls++
        return new Promise<PollResult>(() => {})
      },
    }

    const readyTaskId = randomUUID()
    insertReadyTask(db, readyTaskId)
    let workerSpawned = false

    // Omit pollTimeoutMs to verify the contract default of 20,000 ms
    const deps = createTestDeps({
      stateDir,
      github: {
        port: hangingPort,
        policyPath,
      },
      spawnWorker: async () => {
        workerSpawned = true
        return { pid: process.pid, nonce: 'nonce-timeout' }
      },
    })

    const nowMs1 = 1_000_000
    const handle = acquireSupervisor(db, stateDir, { nowMs: nowMs1, staleAfterMs: 300000 })
    try {
      // Round 1: start tick at nowMs1
      let tick1Settled = false
      const tick1 = runTick(db, handle, deps, nowMs1).then((res) => {
        tick1Settled = true
        return res
      })

      // Advance by 19,999 ms: poll was called, but timeout has not expired yet; tick remains unsettled and no cursor error
      await vi.advanceTimersByTimeAsync(19_999)
      expect(pollCalls).toBe(1)
      expect(tick1Settled).toBe(false)
      const cursorBeforeTimeout = db.prepare('SELECT error FROM github_cursor WHERE repo = ?').get('owner/repo') as { error: string } | undefined
      expect(cursorBeforeTimeout).toBeUndefined()

      // Advance by 1 ms to reach 20,000 ms: default timeout fires and tick settles
      await vi.advanceTimersByTimeAsync(1)
      await tick1
      expect(tick1Settled).toBe(true)

      // Cursor recorded retryable error with first consecutive error backoff (60,000 ms)
      const cursor1 = db.prepare('SELECT error, next_poll_ms FROM github_cursor WHERE repo = ?').get('owner/repo') as { error: string; next_poll_ms: number }
      expect(cursor1.error).toBe('poll timeout')
      expect(cursor1.next_poll_ms).toBe(nowMs1 + 60000)

      // The loop kept dispatching the ready task in the same tick sequence and spawnWorker executed
      expect(workerSpawned).toBe(true)
      const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(readyTaskId) as { status: string }
      expect(task.status).toBe('progress')
      const worker = db.prepare('SELECT state, nonce FROM workers WHERE attempt_id = (SELECT id FROM attempts WHERE task_id = ?)').get(readyTaskId) as { state: string; nonce: string } | undefined
      expect(worker?.state).toBe('running')
      expect(worker?.nonce).toBe('nonce-timeout')

      // Round 2: at next_poll_ms, second consecutive timeout doubles backoff to 120,000 ms
      const nowMs2 = cursor1.next_poll_ms
      const tick2 = runTick(db, handle, deps, nowMs2)
      await vi.advanceTimersByTimeAsync(20_000)
      await tick2

      expect(pollCalls).toBe(2)
      const cursor2 = db.prepare('SELECT error, next_poll_ms FROM github_cursor WHERE repo = ?').get('owner/repo') as { error: string; next_poll_ms: number }
      expect(cursor2.error).toBe('poll timeout')
      expect(cursor2.next_poll_ms).toBe(nowMs2 + 120000)

      // Tick before next_poll_ms does not poll
      await runTick(db, handle, deps, nowMs2 + 50_000)
      expect(pollCalls).toBe(2)
    } finally {
      handle.release(nowMs1)
      db.close()
      vi.useRealTimers()
    }
  })

  it('CHK-M6-05-c: explicit pollTimeoutMs override fires at specified timeout and remains unsettled before', async () => {
    vi.useFakeTimers()
    const stateDir = makeTempDir()
    const { db } = setupDatabase(stateDir)
    const policyPath = join(stateDir, 'github-policy.json')
    writePolicy(policyPath, defaultPolicy())

    let pollCalls = 0
    const hangingPort: GitHubPort = {
      poll: async () => {
        pollCalls++
        return new Promise<PollResult>(() => {})
      },
    }

    const explicitTimeoutMs = 5000
    const deps = createTestDeps({
      stateDir,
      github: {
        port: hangingPort,
        policyPath,
        pollTimeoutMs: explicitTimeoutMs,
      },
    })

    const nowMs = 2_000_000
    const handle = acquireSupervisor(db, stateDir, { nowMs, staleAfterMs: 300000 })
    try {
      let tickSettled = false
      const tick = runTick(db, handle, deps, nowMs).then((res) => {
        tickSettled = true
        return res
      })

      // Advance to 4,999 ms: tick remains unsettled, no timeout cursor exists
      await vi.advanceTimersByTimeAsync(4_999)
      expect(pollCalls).toBe(1)
      expect(tickSettled).toBe(false)
      const cursorBefore = db.prepare('SELECT error FROM github_cursor WHERE repo = ?').get('owner/repo') as { error: string } | undefined
      expect(cursorBefore).toBeUndefined()

      // Advance by 1 ms to reach 5,000 ms: explicit timeout fires and tick settles
      await vi.advanceTimersByTimeAsync(1)
      await tick
      expect(tickSettled).toBe(true)

      const cursor = db.prepare('SELECT error, next_poll_ms FROM github_cursor WHERE repo = ?').get('owner/repo') as { error: string; next_poll_ms: number }
      expect(cursor.error).toBe('poll timeout')
      expect(cursor.next_poll_ms).toBe(nowMs + 60000)
    } finally {
      handle.release(nowMs)
      db.close()
      vi.useRealTimers()
    }
  })

  it('CHK-M6-05-c: rate-limited stops polling that repo until retryAfterMs (no poll immediately before reset, exactly one at reset)', async () => {
    const stateDir = makeTempDir()
    const { db } = setupDatabase(stateDir)
    const policyPath = join(stateDir, 'github-policy.json')
    writePolicy(policyPath, defaultPolicy())

    const fake = createFakeGitHub()
    fake.script('owner/repo', { kind: 'rate-limited', retryAfterMs: 120000 })

    const deps = createTestDeps({
      stateDir,
      github: { port: fake, policyPath, pollTimeoutMs: 20000 },
    })

    const t1 = 1_000_000
    const handle = acquireSupervisor(db, stateDir, { nowMs: t1, staleAfterMs: 300000 })
    try {
      // First tick gets rate-limited
      await runTick(db, handle, deps, t1)
      expect(fake.calls).toHaveLength(1)

      const cursor = db.prepare('SELECT next_poll_ms FROM github_cursor WHERE repo = ?').get('owner/repo') as { next_poll_ms: number }
      expect(cursor.next_poll_ms).toBe(t1 + 120000)

      // Tick immediately before reset (t1 + 119,999): NO poll
      await runTick(db, handle, deps, t1 + 119_999)
      expect(fake.calls).toHaveLength(1)

      // Tick exactly at reset (t1 + 120,000): exactly one new poll
      await runTick(db, handle, deps, t1 + 120_000)
      expect(fake.calls).toHaveLength(2)
      expect(fake.calls[1]).toEqual({ repo: 'owner/repo', etag: null })
    } finally {
      handle.release(t1)
      db.close()
    }
  })

  it('CHK-M6-05-d: runTick returns idle true with pending events present and no due poll', async () => {
    const stateDir = makeTempDir()
    const { db } = setupDatabase(stateDir)
    const policyPath = join(stateDir, 'github-policy.json')
    writePolicy(policyPath, defaultPolicy())

    const nowMs = 1_000_000
    db.prepare(`
      INSERT INTO github_events (event_id, project_id, repo, kind, actor_id, actor_login, issue, status, reason, title, scope_json, basis_json, text, text_trust, text_sha256, event_at, received_at)
      VALUES ('6001', 'p1', 'owner/repo', 'issue.opened', 1, 'alice', 1, 'pending', null, 'Pending task', '["."]', '{}', 'body', 'untrusted', 'abc', '2026-11-13T00:00:00.000Z', '2026-11-13T00:00:00.000Z')
    `).run()
    db.prepare(`
      INSERT INTO github_cursor (project_id, repo, etag, next_poll_ms, error, updated_at)
      VALUES ('p1', 'owner/repo', 'e1', ?, null, '2026-11-13T00:00:00.000Z')
    `).run(nowMs + 60000)

    const fake = createFakeGitHub()
    const deps = createTestDeps({
      stateDir,
      github: { port: fake, policyPath, pollTimeoutMs: 20000 },
    })

    const handle = acquireSupervisor(db, stateDir, { nowMs, staleAfterMs: 300000 })
    try {
      const result = await runTick(db, handle, deps, nowMs)
      expect(result.idle).toBe(true)
      expect(fake.calls).toHaveLength(0)
    } finally {
      handle.release(nowMs)
      db.close()
    }
  })

  it('CHK-M6-05-d: with a due poll runTick returns idle false', async () => {
    const stateDir = makeTempDir()
    const { db } = setupDatabase(stateDir)
    const policyPath = join(stateDir, 'github-policy.json')
    writePolicy(policyPath, defaultPolicy())

    const fake = createFakeGitHub()
    const deps = createTestDeps({
      stateDir,
      github: { port: fake, policyPath, pollTimeoutMs: 20000 },
    })

    const nowMs = 1_000_000
    const handle = acquireSupervisor(db, stateDir, { nowMs, staleAfterMs: 300000 })
    try {
      const result = await runTick(db, handle, deps, nowMs)
      expect(result.idle).toBe(false)
      expect(fake.calls).toHaveLength(1)
    } finally {
      handle.release(nowMs)
      db.close()
    }
  })

  it('CHK-M6-05-d: fenced ingestion: displaced lease during poll prevents commit and rolls back ingest transaction', async () => {
    const stateDir = makeTempDir()
    const { db } = setupDatabase(stateDir)
    const policyPath = join(stateDir, 'github-policy.json')
    writePolicy(policyPath, defaultPolicy())

    const displacingPort: GitHubPort = {
      async poll() {
        // Displace the current lease generation in the database while poll is in flight
        db.prepare("UPDATE supervisor_lease SET generation = generation + 1 WHERE id = 1").run()
        return {
          kind: 'events',
          etag: 'e1',
          pollAfterMs: 60000,
          events: [makeIssueCommentEvent('9901', 'owner/repo', 1, 'alice', '/factory task Displaced event')],
        }
      },
    }

    const deps = createTestDeps({
      stateDir,
      github: { port: displacingPort, policyPath, pollTimeoutMs: 20000 },
    })

    const nowMs = 1_000_000
    const handle = acquireSupervisor(db, stateDir, { nowMs, staleAfterMs: 300000 })
    try {
      // fencedWrite must reject with LeaseLostError because generation no longer matches
      await expect(runTick(db, handle, deps, nowMs)).rejects.toThrow(LeaseLostError)

      // Nothing committed: github_events and github_cursor remain completely empty
      const eventCount = (db.prepare('SELECT count(*) as cnt FROM github_events').get() as { cnt: number }).cnt
      expect(eventCount).toBe(0)
      const cursorCount = (db.prepare('SELECT count(*) as cnt FROM github_cursor').get() as { cnt: number }).cnt
      expect(cursorCount).toBe(0)
    } finally {
      db.close()
    }
  })
})
