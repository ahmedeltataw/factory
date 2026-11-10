// M3-05 Property Test Contract:
//
// CHK-M3-05-e: property: for random crash points across random effect lists,
// every key ends done or failed and destination effects per key <= 1.
//
// Lead decisions for CHK-e:
// - Small bounded numRuns (numRuns: 8) with fast-check option `endOnFailure: true`
//   to prevent long shrinking loops.
// - Conservative Windows timing estimate:
//   - Up to 3 child processes per run (initial child + up to 2 restarts): ~1.5s per child = ~4.5s
//   - Git operations per run (init, worktree add, commits, log queries): ~12 commands * ~150ms = ~1.8s
//   - Total per iteration: ~6.3s; for 8 runs: 8 * ~6.3s ≈ 50.4s
//   - Explicit Vitest per-test timeout set to 120,000ms (120s) providing 2x headroom.
// - Clean temporary state directory in each example's `finally` block to prevent disk growth.
// - Generated bounded crash target: effect index 0..n-1 and boundary 'before' | 'after'.
// - Up to 2 restarts (0, 1, or 2 crashes).
// - All three effect kinds exercised: 'worktree.ensure', 'attempt.start', and 'evidence.commit'.
// - Persistent spawn observations for 'attempt.start': stub spawnWorker appends attemptId to
//   file and returns { pid, nonce } WITHOUT touching the database.
// - Targeted effect guarantees: every generated effect is designed to succeed (exitCode: 0
//   for evidence.commit), ensuring after-effect crash points are reachable regardless of
//   execution / processing order.
// - Fully independent generated effects: each effect receives its own task id, its own attempt id
//   with attempt_no = 1 under that task, and its own worktree path/branch. No shared prerequisites.
//   Every prerequisite insert verifies changes === 1 without INSERT OR IGNORE.
// - Before-effect assertions check only that effect's own destination.
// - Worktree counting: parse 'worktree <path>' lines from git worktree list --porcelain and compare
//   normalized paths with path.resolve, case-insensitive on Windows, forward/back slashes normalized.
// - Abrupt crash proofs: child processes register exit and finally sentinels. On SIGKILL fault,
//   neither sentinel file is created.
// - Pre-recovery assertions: verifies destination effect state and confirms target outbox row is
//   still 'pending' before recovery process takes over.
// - Lease recovery: child takeover evidence records heartbeatMs: nowMs matching the acquisition heartbeat.
// - Exception paths: any held supervisor lease handle is released in child `finally` before closing DB.
// - Invariants verified across all runs:
//   1. Every outbox key ends in status 'done' or 'failed'.
//   2. Destination effects per key are at most 1 (<= 1).
//   3. For keys ending in 'done', destination effects count is exactly 1.
//   4. For keys ending in 'failed', tries === MAX_TRIES and last_error is non-empty.
//   5. No duplicate rows in outbox for the same idempotency key.

import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import { openStore } from '../../supervisor/src/app/store.ts'
import {
  acquireSupervisor,
  type SupervisorLeaseHandle,
} from '../../supervisor/src/app/supervisor-lease.ts'
import {
  BACKOFF_MS,
  createEffectHandlers,
  enqueue,
  MAX_TRIES,
  runDue,
  type OutboxHandler,
  type OutboxRow,
} from '../../supervisor/src/app/outbox.ts'
import {
  parseFault,
  type FaultName,
} from '../../supervisor/src/app/faults.ts'

const directories: string[] = []

function safeRemoveDir(dir: string): void {
  const maxRetries = 10
  let lastError: unknown
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (err) {
      lastError = err
      if (attempt === maxRetries) {
        throw lastError
      }
      const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
      Atomics.wait(waitBuffer, 0, 0, 50)
    }
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c', 'user.name=Factory Test',
      '-c', 'user.email=factory@example.test',
      '-c', 'core.hooksPath=',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
    },
  ).trim()
}

function normalizePath(p: string): string {
  const normalized = resolve(p.replace(/\\/g, '/'))
  if (existsSync(normalized)) {
    try {
      const canonical = resolve(realpathSync.native(normalized))
      return process.platform === 'win32' ? canonical.toLowerCase() : canonical
    } catch {
      // fall back to current behaviour only when canonicalization fails
    }
  }
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function countGitWorktrees(repoDir: string, targetPath: string): number {
  const wtList = git(repoDir, 'worktree', 'list', '--porcelain')
  const normalizedTarget = normalizePath(targetPath)
  let count = 0
  for (const line of wtList.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('worktree ')) {
      const parsedPath = trimmed.slice('worktree '.length).trim()
      if (normalizePath(parsedPath) === normalizedTarget) {
        count++
      }
    }
  }
  return count
}

afterEach(() => {
  const errors: unknown[] = []
  for (const directory of directories.splice(0)) {
    try {
      safeRemoveDir(directory)
    } catch (err) {
      errors.push(err)
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Cleanup failed to remove temporary directories')
  }
})

// Unified child process runner: supports fresh acquire or takeover,
// targeted fault injection at bounded effect index and boundary with sentinels,
// persistent spawn worker observations, and recovery draining to completion.
const childRunnerSource = `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const [
  storeUrl,
  leaseUrl,
  outboxUrl,
  faultsUrl,
  dbPath,
  stateDir,
  repoPath,
  baseRef,
  spawnObsPath,
  evidenceInPath,
  evidenceOutPath,
  sentinelFinallyPath,
  sentinelExitPath,
  crashTargetIndexStr,
  crashBoundaryStr,
  crashInfoPath,
  nowMsStr,
  drainUntilEmptyStr,
] = process.argv.slice(2);

if (sentinelExitPath) {
  process.on('exit', () => {
    try {
      writeFileSync(sentinelExitPath, 'exit handler executed');
    } catch {}
  });
}

const { openStore } = await import(storeUrl);
const { acquireSupervisor } = await import(leaseUrl);
const { runDue, createEffectHandlers, BACKOFF_MS, MAX_TRIES } = await import(outboxUrl);
const { triggerFault } = await import(faultsUrl);

let nowMs = Number(nowMsStr);
const targetIndex = Number(crashTargetIndexStr);
const boundary = crashBoundaryStr;
const drainUntilEmpty = drainUntilEmptyStr === 'true';

let db;
let handle;
try {
  db = openStore(dbPath);
  const leaseOptions = {
    nowMs,
    staleAfterMs: 100,
  };
  if (evidenceInPath) {
    leaseOptions.takeover = JSON.parse(readFileSync(evidenceInPath, 'utf8'));
  }
  handle = acquireSupervisor(db, stateDir, leaseOptions);

  if (evidenceOutPath) {
    writeFileSync(
      evidenceOutPath,
      JSON.stringify({
        ownerId: handle.ownerId,
        generation: handle.generation,
        heartbeatMs: nowMs,
      }),
    );
  }

  const baseHandlers = createEffectHandlers({
    db,
    spawnWorker: (opts) => {
      appendFileSync(spawnObsPath, \`\${opts.attemptId}\\n\`);
      return { pid: 12345, nonce: \`nonce-\${opts.attemptId}\` };
    },
    config: { stateDir, repoPath, baseRef },
  });

  let effectIndex = 0;
  const wrappedHandlers = {};
  for (const [kind, fn] of Object.entries(baseHandlers)) {
    wrappedHandlers[kind] = async (row, ctx) => {
      const idx = effectIndex++;
      if (idx === targetIndex && boundary === 'before') {
        if (crashInfoPath) {
          writeFileSync(
            crashInfoPath,
            JSON.stringify({
              index: idx,
              boundary: 'before',
              key: row.idempotency_key,
              kind: row.kind,
              payload: row.payload_json,
            }),
          );
        }
        triggerFault('outbox-before-effect');
      }
      const res = await fn(row, ctx);
      if (idx === targetIndex && boundary === 'after') {
        if (crashInfoPath) {
          writeFileSync(
            crashInfoPath,
            JSON.stringify({
              index: idx,
              boundary: 'after',
              key: row.idempotency_key,
              kind: row.kind,
              payload: row.payload_json,
            }),
          );
        }
        triggerFault('outbox-after-effect');
      }
      return res;
    };
  }

  await runDue(db, handle, wrappedHandlers, nowMs);

  if (drainUntilEmpty) {
    for (let step = 0; step < MAX_TRIES + 2; step++) {
      const pending = db.prepare("SELECT count(*) as cnt FROM outbox WHERE status = 'pending'").get().cnt;
      if (pending === 0) break;
      nowMs += BACKOFF_MS + 100;
      await runDue(db, handle, wrappedHandlers, nowMs);
    }
  }

  handle.release(nowMs + 1);
  handle = null;
} finally {
  if (sentinelFinallyPath) {
    try {
      writeFileSync(sentinelFinallyPath, 'finally block executed');
    } catch {}
  }
  if (handle) {
    try {
      handle.release(Date.now());
    } catch {}
  }
  if (db) {
    try {
      db.close();
    } catch {}
  }
}
`

interface PropertyEffectSpec {
  readonly taskId: string
  readonly kind: 'worktree.ensure' | 'attempt.start' | 'evidence.commit'
}

interface PropertySchedule {
  readonly effects: PropertyEffectSpec[]
  readonly restartCount: 0 | 1 | 2
  readonly targetEffectIndex: number
  readonly boundary: 'before' | 'after'
  readonly restart1Boundary: 'before' | 'after'
}

const effectKindArbitrary = fc.constantFrom<'worktree.ensure' | 'attempt.start' | 'evidence.commit'>(
  'worktree.ensure',
  'attempt.start',
  'evidence.commit',
)

const scheduleArbitrary: fc.Arbitrary<PropertySchedule> = fc.record({
  kinds: fc.array(effectKindArbitrary, { minLength: 2, maxLength: 4 }),
  restartCount: fc.constantFrom<0 | 1 | 2>(0, 1, 1, 2),
  targetEffectIndex: fc.integer({ min: 0, max: 3 }),
  boundary: fc.constantFrom<'before' | 'after'>('before', 'after'),
  restart1Boundary: fc.constantFrom<'before' | 'after'>('before', 'after'),
}).map(({ kinds, restartCount, targetEffectIndex, boundary, restart1Boundary }) => ({
  effects: kinds.map((kind, idx) => ({
    taskId: `t${idx + 1}`,
    kind,
  })),
  restartCount,
  targetEffectIndex,
  boundary,
  restart1Boundary,
}))

describe('M3-05 outbox property tests', () => {
  it('CHK-M3-05-e: for random crash points across random effect lists, every key ends done or failed and destination effects per key <= 1', async () => {
    // Budget: numRuns: 8 with endOnFailure: true.
    // Conservative Windows execution per run: up to 3 children (~4.5s) + ~12 git commands (~1.8s) ≈ 6.3s per run.
    // 8 runs ≈ 50.4s. Total per-test timeout set to 120,000ms.
    await fc.assert(
      fc.asyncProperty(scheduleArbitrary, async (schedule) => {
        const stateDir = mkdtempSync(join(tmpdir(), 'factory-outbox-prop-'))
        directories.push(stateDir)

        try {
          const dbPath = join(stateDir, 'state.sqlite')
          const spawnObsFile = join(stateDir, 'spawn-observations.log')
          const childScript = join(stateDir, 'child-runner.mjs')
          writeFileSync(childScript, childRunnerSource)

          const evidenceFile1 = join(stateDir, 'lease-evidence-1.json')
          const evidenceFile2 = join(stateDir, 'lease-evidence-2.json')
          const evidenceFile3 = join(stateDir, 'lease-evidence-3.json')

          const sentinelFinally1 = join(stateDir, 'sentinel-finally-1.txt')
          const sentinelExit1 = join(stateDir, 'sentinel-exit-1.txt')
          const crashInfoPath1 = join(stateDir, 'crash-info-1.json')

          const sentinelFinally2 = join(stateDir, 'sentinel-finally-2.txt')
          const sentinelExit2 = join(stateDir, 'sentinel-exit-2.txt')
          const crashInfoPath2 = join(stateDir, 'crash-info-2.json')

          const sentinelFinally3 = join(stateDir, 'sentinel-finally-3.txt')
          const sentinelExit3 = join(stateDir, 'sentinel-exit-3.txt')

          const repoDir = join(stateDir, 'repo')
          mkdirSync(repoDir)
          git(repoDir, 'init')
          git(repoDir, 'config', 'core.autocrlf', 'false')
          writeFileSync(join(repoDir, 'base.txt'), 'base\n')
          git(repoDir, 'add', '.')
          git(repoDir, 'commit', '-m', 'base commit')
          const baseRef = git(repoDir, 'rev-parse', 'HEAD')

          const storeUrl = pathToFileURL(join(process.cwd(), 'supervisor/src/app/store.ts')).href
          const leaseUrl = pathToFileURL(join(process.cwd(), 'supervisor/src/app/supervisor-lease.ts')).href
          const outboxUrl = pathToFileURL(join(process.cwd(), 'supervisor/src/app/outbox.ts')).href
          const faultsUrl = pathToFileURL(join(process.cwd(), 'supervisor/src/app/faults.ts')).href

          // Initialize DB and prerequisite records, enqueue all generated outbox rows
          const initDb = openStore(dbPath)
          let initHandle: SupervisorLeaseHandle | undefined
          const uniqueKeys = new Set<string>()
          const enqueuedSpecs: Array<{ spec: PropertyEffectSpec; key: string; payloadJson: string }> = []
          let child1TargetIndex = -1
          let child1Boundary = ''

          try {
            initHandle = acquireSupervisor(initDb, stateDir, { nowMs: 500, staleAfterMs: 300000 })
            const projRes = initDb.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'Prop Project', '2026-11-10T00:00:00.000Z')").run()
            expect(projRes.changes).toBe(1)

            for (const spec of schedule.effects) {
              const taskId = spec.taskId
              const cmdRes = initDb.prepare("INSERT INTO commands (id, project_id, kind, payload_json, created_at) VALUES (?, 'p1', 'task.create', '{}', '2026-11-10T00:00:00.000Z')").run(`cmd-${taskId}`)
              expect(cmdRes.changes).toBe(1)
              const taskRes = initDb.prepare("INSERT INTO tasks (id, project_id, created_by_command, title, status, created_at, updated_at) VALUES (?, 'p1', ?, 'Task', 'ready', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')").run(taskId, `cmd-${taskId}`)
              expect(taskRes.changes).toBe(1)

              if (spec.kind === 'worktree.ensure') {
                const key = `worktree.ensure:${taskId}`
                expect(uniqueKeys.has(key)).toBe(false)
                uniqueKeys.add(key)
                const payloadJson = JSON.stringify({ taskId })
                enqueue(initDb, initHandle, {
                  idempotencyKey: key,
                  kind: 'worktree.ensure',
                  payloadJson,
                  nowMs: 1000,
                })
                enqueuedSpecs.push({ spec, key, payloadJson })
              } else if (spec.kind === 'attempt.start') {
                const attemptId = `att-start-${taskId}`
                const key = `attempt.start:${attemptId}`
                expect(uniqueKeys.has(key)).toBe(false)
                uniqueKeys.add(key)
                const attRes = initDb.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation) VALUES (?, ?, 1, 'pending', 1)").run(attemptId, taskId)
                expect(attRes.changes).toBe(1)
                const payloadJson = JSON.stringify({ attemptId, taskId })
                enqueue(initDb, initHandle, {
                  idempotencyKey: key,
                  kind: 'attempt.start',
                  payloadJson,
                  nowMs: 1000,
                })
                enqueuedSpecs.push({ spec, key, payloadJson })
              } else {
                const attemptId = `att-ev-${taskId}`
                const key = `evidence.commit:${attemptId}`
                expect(uniqueKeys.has(key)).toBe(false)
                uniqueKeys.add(key)
                const attRes = initDb.prepare("INSERT INTO attempts (id, task_id, attempt_no, status, lease_generation) VALUES (?, ?, 1, 'succeeded', 1)").run(attemptId, taskId)
                expect(attRes.changes).toBe(1)

                // Setup worktree for this independent task
                const wtPath = join(stateDir, 'worktrees', taskId)
                git(repoDir, 'worktree', 'add', '-b', `factory/task/${taskId}`, wtPath, baseRef)
                writeFileSync(join(wtPath, 'output.txt'), `work for ${taskId}\n`)

                const runDir = join(stateDir, 'runs', attemptId)
                mkdirSync(runDir, { recursive: true })
                const stdoutPath = join(runDir, 'stdout.log')
                const stderrPath = join(runDir, 'stderr.log')
                writeFileSync(stdoutPath, 'stdout\n')
                writeFileSync(stderrPath, 'stderr\n')

                const payloadJson = JSON.stringify({
                  attemptId,
                  worktreePath: wtPath,
                  baseSha: baseRef,
                  stdoutPath,
                  stderrPath,
                  exitCode: 0,
                })
                enqueue(initDb, initHandle, {
                  idempotencyKey: key,
                  kind: 'evidence.commit',
                  payloadJson,
                  nowMs: 1000,
                })
                enqueuedSpecs.push({ spec, key, payloadJson })
              }
            }

            // Derive target position for Child 1 (bounded across unique enqueued effects)
            child1TargetIndex = schedule.restartCount > 0 ? (schedule.targetEffectIndex % enqueuedSpecs.length) : -1
            child1Boundary = schedule.restartCount > 0 ? schedule.boundary : ''
          } finally {
            if (initHandle) {
              try { initHandle.release(501) } catch { /* ignore */ }
            }
            initDb.close()
          }

          const child1DrainStr = schedule.restartCount === 0 ? 'true' : 'false'

          // 1. Run Child 1: initial attempt
          const child1Result = spawnSync(
            process.execPath,
            [
              childScript,
              storeUrl,
              leaseUrl,
              outboxUrl,
              faultsUrl,
              dbPath,
              stateDir,
              repoDir,
              baseRef,
              spawnObsFile,
              '', // no takeover for Child 1
              evidenceFile1,
              sentinelFinally1,
              sentinelExit1,
              String(child1TargetIndex),
              child1Boundary,
              crashInfoPath1,
              '1000',
              child1DrainStr,
            ],
            {
              timeout: 10000,
              encoding: 'utf8',
              env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
            },
          )

          expect(child1Result.error).toBeUndefined()
          expect(child1Result.signal).not.toBe('SIGTERM')

          if (schedule.restartCount > 0) {
            // Abrupt crash check: status is nonzero and sentinels are NOT written
            expect(child1Result.status).not.toBe(0)
            expect(existsSync(sentinelFinally1)).toBe(false)
            expect(existsSync(sentinelExit1)).toBe(false)
            expect(existsSync(evidenceFile1)).toBe(true)
            expect(existsSync(crashInfoPath1)).toBe(true)

            const crashInfo1 = JSON.parse(readFileSync(crashInfoPath1, 'utf8')) as {
              index: number
              boundary: 'before' | 'after'
              key: string
              kind: string
              payload: string
            }
            expect(crashInfo1.index).toBe(child1TargetIndex)
            expect(crashInfo1.boundary).toBe(child1Boundary)

            // Pre-recovery assertion: verify destination and outbox state before recovery
            const preDb1 = openStore(dbPath)
            try {
              const targetRow = preDb1.prepare('SELECT status, tries FROM outbox WHERE idempotency_key = ?').get(crashInfo1.key) as OutboxRow
              expect(targetRow).toBeDefined()
              expect(targetRow.status).toBe('pending')

              if (crashInfo1.boundary === 'before') {
                if (crashInfo1.kind === 'evidence.commit') {
                  const { attemptId, worktreePath } = JSON.parse(crashInfo1.payload)
                  const commits = git(worktreePath, 'log', `--grep=^Factory-Attempt: ${attemptId}$`, '--format=%H').trim()
                  expect(commits.length).toBe(0)
                  const evCount = (preDb1.prepare('SELECT count(*) as cnt FROM evidence WHERE attempt_id = ?').get(attemptId) as { cnt: number }).cnt
                  expect(evCount).toBe(0)
                } else if (crashInfo1.kind === 'attempt.start') {
                  const { attemptId } = JSON.parse(crashInfo1.payload)
                  const spawnLines = existsSync(spawnObsFile)
                    ? readFileSync(spawnObsFile, 'utf8').split('\n').filter((l) => l.trim() === attemptId)
                    : []
                  expect(spawnLines.length).toBe(0)
                  const wRow = preDb1.prepare('SELECT state FROM workers WHERE attempt_id = ?').get(attemptId) as { state: string } | undefined
                  expect(wRow).toBeUndefined()
                } else if (crashInfo1.kind === 'worktree.ensure') {
                  const { taskId } = JSON.parse(crashInfo1.payload)
                  const wtPath = join(stateDir, 'worktrees', taskId)
                  expect(existsSync(wtPath)).toBe(false)
                  expect(countGitWorktrees(repoDir, wtPath)).toBe(0)
                }
              } else {
                // boundary === 'after': effect ran before crash, but row in outbox was NOT marked 'done' yet
                if (crashInfo1.kind === 'evidence.commit') {
                  const { attemptId, worktreePath } = JSON.parse(crashInfo1.payload)
                  const commits = git(worktreePath, 'log', `--grep=^Factory-Attempt: ${attemptId}$`, '--format=%H')
                    .split('\n')
                    .map((s) => s.trim())
                    .filter(Boolean)
                  expect(commits.length).toBe(1)
                  const evCount = (preDb1.prepare('SELECT count(*) as cnt FROM evidence WHERE attempt_id = ?').get(attemptId) as { cnt: number }).cnt
                  expect(evCount).toBe(1)
                } else if (crashInfo1.kind === 'attempt.start') {
                  const { attemptId } = JSON.parse(crashInfo1.payload)
                  const spawnLines = existsSync(spawnObsFile)
                    ? readFileSync(spawnObsFile, 'utf8').split('\n').filter((l) => l.trim() === attemptId)
                    : []
                  expect(spawnLines.length).toBe(1)
                  const wRow = preDb1.prepare('SELECT state FROM workers WHERE attempt_id = ?').get(attemptId) as { state: string } | undefined
                  expect(wRow).toBeDefined()
                } else if (crashInfo1.kind === 'worktree.ensure') {
                  const { taskId } = JSON.parse(crashInfo1.payload)
                  const wtPath = join(stateDir, 'worktrees', taskId)
                  expect(existsSync(wtPath)).toBe(true)
                  expect(countGitWorktrees(repoDir, wtPath)).toBe(1)
                }
              }
            } finally {
              preDb1.close()
            }

            // Wait 120ms to ensure lease (staleAfterMs: 100) is stale for recovery takeover
            const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
            Atomics.wait(waitBuffer, 0, 0, 120)

            if (schedule.restartCount === 1) {
              // 2a. Single restart: Child 2 takes over and drains all outbox items to completion
              const child2Result = spawnSync(
                process.execPath,
                [
                  childScript,
                  storeUrl,
                  leaseUrl,
                  outboxUrl,
                  faultsUrl,
                  dbPath,
                  stateDir,
                  repoDir,
                  baseRef,
                  spawnObsFile,
                  evidenceFile1,
                  evidenceFile2,
                  sentinelFinally2,
                  sentinelExit2,
                  '-1', // no crash in recovery child
                  '',
                  '',
                  '1200',
                  'true', // drainUntilEmpty
                ],
                {
                  timeout: 10000,
                  encoding: 'utf8',
                  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
                },
              )

              expect(child2Result.error).toBeUndefined()
              expect(child2Result.signal).not.toBe('SIGTERM')
              expect(child2Result.status).toBe(0)
            } else {
              // 2b. Two restarts: Child 2 takes over and crashes on its first eligible boundary
              const child2Result = spawnSync(
                process.execPath,
                [
                  childScript,
                  storeUrl,
                  leaseUrl,
                  outboxUrl,
                  faultsUrl,
                  dbPath,
                  stateDir,
                  repoDir,
                  baseRef,
                  spawnObsFile,
                  evidenceFile1,
                  evidenceFile2,
                  sentinelFinally2,
                  sentinelExit2,
                  '0', // targetIndex 0 in remaining due effects
                  schedule.restart1Boundary,
                  crashInfoPath2,
                  '1200',
                  'false', // will crash before draining
                ],
                {
                  timeout: 10000,
                  encoding: 'utf8',
                  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
                },
              )

              expect(child2Result.error).toBeUndefined()
              expect(child2Result.signal).not.toBe('SIGTERM')
              expect(child2Result.status).not.toBe(0)
              expect(existsSync(sentinelFinally2)).toBe(false)
              expect(existsSync(sentinelExit2)).toBe(false)
              expect(existsSync(evidenceFile2)).toBe(true)
              expect(existsSync(crashInfoPath2)).toBe(true)

              const crashInfo2 = JSON.parse(readFileSync(crashInfoPath2, 'utf8')) as {
                index: number
                boundary: 'before' | 'after'
                key: string
                kind: string
                payload: string
              }
              expect(crashInfo2.index).toBe(0)
              expect(crashInfo2.boundary).toBe(schedule.restart1Boundary)

              // Pre-recovery assertion for Child 2 crash
              const preDb2 = openStore(dbPath)
              try {
                const targetRow2 = preDb2.prepare('SELECT status, tries FROM outbox WHERE idempotency_key = ?').get(crashInfo2.key) as OutboxRow
                expect(targetRow2).toBeDefined()
                expect(targetRow2.status).toBe('pending')

                if (crashInfo2.boundary === 'after') {
                  if (crashInfo2.kind === 'evidence.commit') {
                    const { attemptId, worktreePath } = JSON.parse(crashInfo2.payload)
                    const commits = git(worktreePath, 'log', `--grep=^Factory-Attempt: ${attemptId}$`, '--format=%H')
                      .split('\n')
                      .map((s) => s.trim())
                      .filter(Boolean)
                    expect(commits.length).toBe(1)
                  } else if (crashInfo2.kind === 'attempt.start') {
                    const { attemptId } = JSON.parse(crashInfo2.payload)
                    const spawnLines = existsSync(spawnObsFile)
                      ? readFileSync(spawnObsFile, 'utf8').split('\n').filter((l) => l.trim() === attemptId)
                      : []
                    expect(spawnLines.length).toBe(1)
                  } else if (crashInfo2.kind === 'worktree.ensure') {
                    const { taskId } = JSON.parse(crashInfo2.payload)
                    const wtPath = join(stateDir, 'worktrees', taskId)
                    expect(existsSync(wtPath)).toBe(true)
                    expect(countGitWorktrees(repoDir, wtPath)).toBe(1)
                  }
                }
              } finally {
                preDb2.close()
              }

              // Wait 120ms before Child 3 takeover
              Atomics.wait(waitBuffer, 0, 0, 120)

              // Child 3: final recovery child taking over from Child 2
              const child3Result = spawnSync(
                process.execPath,
                [
                  childScript,
                  storeUrl,
                  leaseUrl,
                  outboxUrl,
                  faultsUrl,
                  dbPath,
                  stateDir,
                  repoDir,
                  baseRef,
                  spawnObsFile,
                  evidenceFile2,
                  evidenceFile3,
                  sentinelFinally3,
                  sentinelExit3,
                  '-1', // no crash
                  '',
                  '',
                  '1400',
                  'true', // drainUntilEmpty
                ],
                {
                  timeout: 10000,
                  encoding: 'utf8',
                  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
                },
              )

              expect(child3Result.error).toBeUndefined()
              expect(child3Result.signal).not.toBe('SIGTERM')
              expect(child3Result.status).toBe(0)
            }
          } else {
            // No crash scheduled: Child 1 completed normally
            expect(child1Result.status).toBe(0)
          }

          // 3. Invariant Verification in Parent with safe connection handling
          const verifyDb = openStore(dbPath)
          try {
            const allRows = verifyDb.prepare('SELECT * FROM outbox').all() as OutboxRow[]

            // Invariant 1: Total outbox rows match unique idempotency keys (no duplicate rows)
            expect(allRows.length).toBe(uniqueKeys.size)

            for (const row of allRows) {
              // Invariant 2: Every key ends in 'done' or 'failed'
              expect(['done', 'failed']).toContain(row.status)

              if (row.kind === 'evidence.commit') {
                const { attemptId, worktreePath } = JSON.parse(row.payload_json) as { attemptId: string; worktreePath: string }

                // Uncapped destination observation: count commits in git log with trailer
                const trailerCommits = git(worktreePath, 'log', `--grep=^Factory-Attempt: ${attemptId}$`, '--format=%H')
                  .split('\n')
                  .map((s) => s.trim())
                  .filter(Boolean)

                // Invariant 3: Destination effects per key <= 1
                expect(trailerCommits.length).toBeLessThanOrEqual(1)

                // Uncapped destination observation: count evidence rows in DB
                const evRows = verifyDb.prepare('SELECT * FROM evidence WHERE attempt_id = ?').all(attemptId)
                expect(evRows.length).toBeLessThanOrEqual(1)

                if (row.status === 'done') {
                  // Invariant 4: If marked done, destination effect occurred exactly once
                  expect(trailerCommits.length).toBe(1)
                  expect(evRows.length).toBe(1)
                } else {
                  expect(trailerCommits.length).toBe(0)
                  expect(evRows.length).toBe(0)
                }
              } else if (row.kind === 'worktree.ensure') {
                const { taskId } = JSON.parse(row.payload_json) as { taskId: string }
                const wtPath = join(stateDir, 'worktrees', taskId)
                const wtCount = countGitWorktrees(repoDir, wtPath)
                expect(wtCount).toBeLessThanOrEqual(1)

                if (row.status === 'done') {
                  expect(existsSync(wtPath)).toBe(true)
                  expect(wtCount).toBe(1)
                } else {
                  expect(existsSync(wtPath)).toBe(false)
                  expect(wtCount).toBe(0)
                }
              } else if (row.kind === 'attempt.start') {
                const { attemptId } = JSON.parse(row.payload_json) as { attemptId: string }
                const spawnLines = existsSync(spawnObsFile)
                  ? readFileSync(spawnObsFile, 'utf8').split('\n').filter((l) => l.trim() === attemptId)
                  : []

                // Invariant 3: Spawn calls <= 1 (no duplicate spawn under process recovery)
                expect(spawnLines.length).toBeLessThanOrEqual(1)

                const wRows = verifyDb.prepare('SELECT * FROM workers WHERE attempt_id = ?').all(attemptId)
                expect(wRows.length).toBeLessThanOrEqual(1)

                if (row.status === 'done') {
                  expect(spawnLines.length).toBe(1)
                  expect(wRows.length).toBe(1)
                } else {
                  expect(spawnLines.length).toBe(0)
                  expect(wRows.length).toBe(0)
                }
              }

              if (row.status === 'failed') {
                // Invariant 5: If failed, tries reached MAX_TRIES and last_error is present
                expect(row.tries).toBe(MAX_TRIES)
                expect(typeof row.last_error).toBe('string')
                expect(row.last_error?.length).toBeGreaterThan(0)
              }
            }
          } finally {
            verifyDb.close()
          }
        } finally {
          // Immediately clean up temporary state directory for each example
          safeRemoveDir(stateDir)
          const idx = directories.indexOf(stateDir)
          if (idx !== -1) directories.splice(idx, 1)
        }
      }),
      { numRuns: 8, endOnFailure: true },
    )
  }, 120000)
})
