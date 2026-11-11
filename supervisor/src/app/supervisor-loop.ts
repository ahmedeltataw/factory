import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { applyPendingCommands } from './apply-commands.ts'
import { fencedWrite } from './fence.ts'
import { triggerFault, type FaultName } from './faults.ts'
import { createEffectHandlers, runDue } from './outbox.ts'
import { failExhaustedEffects, finishAttempt, readWorker, reconcileWorkers, retryTask, scheduleAttempt, stateDirectory, type RecoveryDeps } from './recovery.ts'
import type { SupervisorLeaseHandle } from './supervisor-lease.ts'
import type { EnsureWorktreeConfig } from './worktree.ts'
import { parseScope, scopesOverlap } from '../core/scope.ts'

export { MAX_ATTEMPTS } from './recovery.ts'
export interface WorkerCompletionRecord { exitCode: number }
type Wrapper = <T>(fn: () => Promise<T> | T) => Promise<T> | T
export interface LoopDeps extends RecoveryDeps {
  spawnWorker: (options: { runDir: string; cwd: string; taskId: string; attemptId: string; env?: Record<string, string> }) => Promise<{ pid: number; nonce: string }> | { pid: number; nonce: string }
  isAlive: (pid: number, nonce: string) => Promise<boolean> | boolean
  readResult: (runDir: string) => Promise<WorkerCompletionRecord | undefined> | WorkerCompletionRecord | undefined
  config?: EnsureWorktreeConfig
  onPhase?: (phase: string) => void
  isProcessAlive?: (pid: number) => boolean
  wrapRecoverOutbox?: Wrapper; wrapReconcileWorkers?: Wrapper; wrapApplyCommands?: Wrapper
  wrapDispatchTasks?: Wrapper; wrapWorkerLiveness?: Wrapper; wrapLeaseHeartbeat?: Wrapper
}
export interface RunTickResult { idle: boolean }
export async function runTick(db: DatabaseSync, handle: SupervisorLeaseHandle, deps: LoopDeps, nowMs: number, options?: { fault?: FaultName }): Promise<RunTickResult> {
  const stateDir = deps.config?.stateDir ?? deps.stateDir ?? stateDirectory(db)
  const project = db.prepare('SELECT repo_path, base_ref FROM project_config LIMIT 1').get() as { repo_path: string; base_ref: string } | undefined
  const config = deps.config ?? (project ? { stateDir, repoPath: project.repo_path, baseRef: project.base_ref } : undefined)
  const spawn = async (args: Parameters<LoopDeps['spawnWorker']>[0]) => {
    const result = await deps.spawnWorker(args)
    if (options?.fault === 'attempt-after-spawn') {
      // Allow the executor to publish its identity so restart can safely kill it.
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        try {
          const identity = JSON.parse(readFileSync(join(args.runDir, 'worker.json'), 'utf8')) as { pid?: number; nonce?: string; grandchildPid?: number }
          if (identity.pid === result.pid && identity.nonce === result.nonce && identity.grandchildPid) break
        } catch { /* executor has not published its identity yet */ }
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      triggerFault(options.fault)
    }
    return result
  }
  const handlers = createEffectHandlers({ db, config, spawnWorker: spawn })
  const originalStart = handlers['attempt.start']!
  handlers['attempt.start'] = async (row, context) => {
    const { attemptId } = JSON.parse(row.payload_json) as { attemptId: string }
    const attempt = db.prepare('SELECT a.lease_generation, a.status, t.status AS task_status FROM attempts a JOIN tasks t ON t.id = a.task_id WHERE a.id = ?').get(attemptId) as { lease_generation: number; status: string; task_status: string } | undefined
    if (!attempt || attempt.lease_generation !== handle.generation || !['pending', 'running'].includes(attempt.status) || attempt.task_status === 'dropped') {
      fencedWrite(db, handle, () => db.prepare("UPDATE outbox SET last_error = 'superseded' WHERE id = ? AND status = 'pending'").run(row.id))
      return
    }
    const prerequisite = db.prepare('SELECT status FROM outbox WHERE idempotency_key = ?').get(`worktree.ensure:${attemptId}`) as { status: string } | undefined
    if (prerequisite && prerequisite.status !== 'done') throw new Error('worktree is not ready')
    await originalStart(row, context)
  }
  handlers['attempt.kill'] = async (row) => {
    const { attemptId } = JSON.parse(row.payload_json) as { attemptId: string }
    const worker = db.prepare('SELECT pid, nonce FROM workers WHERE attempt_id = ?').get(attemptId) as { pid: number | null; nonce: string } | undefined
    let workerState = 'lost'
    const identity = worker?.pid && worker.nonce ? { pid: worker.pid, nonce: worker.nonce } : readWorker(join(stateDir, 'runs', attemptId))
    if (identity) {
      const result = await deps.killTree(identity.pid, identity.nonce)
      if (result.result === 'kill-failed') throw new Error(result.detail ?? 'kill failed')
      if (result.result === 'killed') workerState = 'killed'
    }
    fencedWrite(db, handle, () => {
      const now = new Date(nowMs).toISOString()
      db.prepare('UPDATE workers SET state = ?, ended_at = ? WHERE attempt_id = ?').run(workerState, now, attemptId)
      db.prepare("UPDATE attempts SET status = 'killed', ended_at = ? WHERE id = ? AND status IN ('pending','running')").run(now, attemptId)
      db.prepare("UPDATE outbox SET status = 'done', last_error = 'superseded', updated_at = ? WHERE idempotency_key = ? AND status = 'pending'").run(now, `attempt.start:${attemptId}`)
    })
  }
  const runEffects = async () => { await runDue(db, handle, handlers, nowMs, options); failExhaustedEffects(db, handle, nowMs) }
  const phase = async (name: string, wrapper: Wrapper | undefined, fn: () => unknown | Promise<unknown>) => { deps.onPhase?.(name); await (wrapper ? wrapper(fn) : fn()) }
  await phase('recover-outbox', deps.wrapRecoverOutbox, runEffects)
  await phase('reconcile-workers', deps.wrapReconcileWorkers, () => reconcileWorkers(db, handle, { killTree: deps.killTree, stateDir, staleAfterMs: deps.staleAfterMs }, nowMs))
  await phase('apply-commands', deps.wrapApplyCommands, () => applyPendingCommands(db, handle))
  await phase('dispatch-tasks', deps.wrapDispatchTasks, async () => {
    // Kill commands applied this tick before creating any new work.
    await runEffects()
    fencedWrite(db, handle, () => {
      const tasks = db.prepare("SELECT id, status, scope_json, not_before_ms FROM tasks WHERE status IN ('ready', 'progress') ORDER BY created_at, rowid").all() as Array<{ id: string; status: string; scope_json: string; not_before_ms: number }>
      const scopeOf = (json: string) => {
        const parsed = parseScope(JSON.parse(json))
        if (!parsed.ok) throw new Error(`invalid task scope: ${parsed.reason}`)
        return parsed.scope
      }
      const held = tasks.filter((task) => task.status === 'progress').map((task) => scopeOf(task.scope_json))
      for (const task of tasks) {
        if (task.status !== 'ready') continue
        const scope = scopeOf(task.scope_json)
        if (!held.some((other) => scopesOverlap(scope, other)) && task.not_before_ms <= nowMs) scheduleAttempt(db, handle, task.id, stateDir, nowMs)
        held.push(scope)
      }
    })
    await runEffects()
  })
  await phase('worker-liveness', deps.wrapWorkerLiveness, async () => {
    const workers = db.prepare("SELECT a.id, a.task_id, w.pid, w.nonce, w.worktree_path, a.deadline_ms FROM attempts a JOIN workers w ON w.attempt_id = a.id JOIN tasks t ON t.id = a.task_id WHERE a.status IN ('pending','running') AND w.state = 'running' AND t.status != 'dropped'").all() as unknown as Array<{ id: string; task_id: string; pid: number; nonce: string; worktree_path: string; deadline_ms: number | null }>
    for (const worker of workers) {
      if (await deps.isAlive(worker.pid, worker.nonce)) {
        if (worker.deadline_ms !== null && nowMs >= worker.deadline_ms) {
          const killed = await deps.killTree(worker.pid, worker.nonce)
          if (killed.result === 'kill-failed') continue
          if (killed.result === 'not-running') {
            const completion = await deps.readResult(join(stateDir, 'runs', worker.id))
            if (completion) finishAttempt(db, handle, worker, stateDir, completion.exitCode, nowMs)
            else fencedWrite(db, handle, () => {
              const now = new Date(nowMs).toISOString()
              db.prepare("UPDATE workers SET state = 'lost', ended_at = ? WHERE attempt_id = ?").run(now, worker.id)
              db.prepare("UPDATE attempts SET status = 'interrupted', error_class = 'lost', ended_at = ? WHERE id = ?").run(now, worker.id)
              db.prepare("UPDATE tasks SET status = 'ready', updated_at = ? WHERE id = ? AND status = 'progress'").run(now, worker.task_id)
            })
            continue
          }
          fencedWrite(db, handle, () => {
            const now = new Date(nowMs).toISOString()
            db.prepare('UPDATE workers SET state = ?, ended_at = ? WHERE attempt_id = ?').run(killed.result === 'killed' ? 'killed' : 'lost', now, worker.id)
            db.prepare("UPDATE attempts SET status = 'interrupted', error_class = 'timeout', ended_at = ? WHERE id = ?").run(now, worker.id)
            retryTask(db, worker.task_id, worker.id, nowMs)
          })
          continue
        }
        fencedWrite(db, handle, () => db.prepare('UPDATE workers SET heartbeat_ms = ? WHERE attempt_id = ?').run(nowMs, worker.id))
      } else {
        const completion = await deps.readResult(join(stateDir, 'runs', worker.id))
        if (completion) finishAttempt(db, handle, worker, stateDir, completion.exitCode, nowMs)
        else fencedWrite(db, handle, () => {
          const now = new Date(nowMs).toISOString()
          db.prepare("UPDATE workers SET state = 'lost', ended_at = ? WHERE attempt_id = ?").run(now, worker.id)
          db.prepare("UPDATE attempts SET status = 'interrupted', error_class = 'lost', ended_at = ? WHERE id = ?").run(now, worker.id)
          db.prepare("UPDATE tasks SET status = 'ready', updated_at = ? WHERE id = ? AND status = 'progress'").run(now, worker.task_id)
        })
      }
    }
    await runEffects()
    fencedWrite(db, handle, () => db.prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE status = 'progress' AND EXISTS (SELECT 1 FROM attempts a JOIN evidence e ON e.attempt_id = a.id WHERE a.task_id = tasks.id AND a.status = 'succeeded')").run(new Date(nowMs).toISOString()))
  })
  await phase('lease-heartbeat', deps.wrapLeaseHeartbeat, () => handle.heartbeat(nowMs))
  const pending = db.prepare("SELECT 1 FROM tasks WHERE status IN ('ready','progress') UNION ALL SELECT 1 FROM outbox WHERE status = 'pending' UNION ALL SELECT 1 FROM commands c WHERE NOT EXISTS (SELECT 1 FROM command_outcomes o WHERE o.command_id = c.id) LIMIT 1").get()
  return { idle: !pending }
}
