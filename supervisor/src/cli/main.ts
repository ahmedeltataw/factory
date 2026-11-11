#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readStatus, formatStatus, type Status } from '../app/status.ts'

import { DEFAULT_STALE_AFTER_MS } from '../app/supervisor-lease.ts'
import { parseScope } from '../core/scope.ts'
import { PHASES, parseDeps, type PhaseName } from '../core/graph.ts'

interface ParsedArgs {
  readonly stateDir: string
  readonly json: boolean
  readonly staleAfterMs: number
  readonly watch: boolean
  readonly intervalMs: number
  readonly count?: number
}

class ArgumentError extends Error {}

function usage(message: string): never {
  throw new ArgumentError(`خطأ في الوسائط: ${message}\nالاستخدام: factory status --state-dir <مسار الحالة> [--json] [--stale-after-ms <عدد صحيح موجب>] [--watch [--interval-ms <200..60000>] [--count <عدد صحيح موجب>]]`)
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv.length === 0 || argv[0] !== 'status') usage('الأمر غير مدعوم؛ الأمر الوحيد هو "status"')
  let stateDir: string | undefined
  let json = false
  let staleAfterMs: number | undefined
  let watch = false
  let intervalMs: number | undefined
  let count: number | undefined

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) usage('وسيطة غير متوقعة')
    if (arg === '--state-dir') {
      if (stateDir !== undefined) usage('الخيار --state-dir مكرر')
      if (i + 1 >= argv.length) usage('القيمة مفقودة للخيار --state-dir')
      stateDir = argv[++i]
      if (stateDir === undefined || stateDir === '' || stateDir.startsWith('-')) usage('قيمة غير صالحة للخيار --state-dir')
    } else if (arg === '--stale-after-ms') {
      if (staleAfterMs !== undefined) usage('الخيار --stale-after-ms مكرر')
      const value = argv[++i]
      if (value === undefined || !/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
        usage('قيمة غير صالحة للخيار --stale-after-ms')
      }
      staleAfterMs = Number(value)
    } else if (arg === '--json') {
      if (json) usage('الخيار --json مكرر')
      json = true
    } else if (arg === '--watch') {
      if (watch) usage('الخيار --watch مكرر')
      watch = true
    } else if (arg === '--interval-ms') {
      if (intervalMs !== undefined) usage('الخيار --interval-ms مكرر')
      const value = argv[++i]
      if (value === undefined || !/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) {
        usage('قيمة غير صالحة للخيار --interval-ms')
      }
      const n = Number(value)
      if (n < 200 || n > 60000) {
        usage('قيمة غير صالحة للخيار --interval-ms')
      }
      intervalMs = n
    } else if (arg === '--count') {
      if (count !== undefined) usage('الخيار --count مكرر')
      const value = argv[++i]
      if (value === undefined || !/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) {
        usage('قيمة غير صالحة للخيار --count')
      }
      const n = Number(value)
      if (n < 1) {
        usage('قيمة غير صالحة للخيار --count')
      }
      count = n
    } else if (arg.startsWith('-')) {
      usage(`الخيار غير معروف: ${arg}`)
    } else {
      usage(`وسيطة غير متوقعة: ${arg}`)
    }
  }
  if (stateDir === undefined) usage('الخيار --state-dir مطلوب')
  if (intervalMs !== undefined && !watch) usage('الخيار --interval-ms يتطلب الخيار --watch')
  if (count !== undefined && !watch) usage('الخيار --count يتطلب الخيار --watch')

  return {
    stateDir,
    json,
    staleAfterMs: staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
    watch,
    intervalMs: intervalMs ?? 2000,
    count,
  }
}

async function run(argv: readonly string[]): Promise<number> {
  let parsed: ParsedArgs
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    if (error instanceof ArgumentError) {
      process.stderr.write(`${error.message}\n`)
      return 2
    }
    process.stderr.write('خطأ في تحليل الوسائط\n')
    return 2
  }

  const printSnapshot = (): number => {
    let status: Status
    try {
      status = readStatus(parsed.stateDir, { nowMs: Date.now(), staleAfterMs: parsed.staleAfterMs })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const label = message.includes('unsupported schema version')
        ? 'إصدار مخطط قاعدة البيانات غير مدعوم'
        : /unable to open database|cannot open|no such file/i.test(message)
          ? 'قاعدة البيانات مفقودة أو تعذر فتحها'
          : 'بيانات قاعدة البيانات غير صالحة أو تعذرت قراءتها'
      process.stderr.write(`${label}\nالتفاصيل: ${message}\n`)
      return 1
    }

    process.stdout.write(`${parsed.json ? JSON.stringify(status) : formatStatus(status)}\n`)
    return 0
  }

  if (!parsed.watch) {
    return printSnapshot()
  }

  let snapshots = 0
  let interrupted = false
  const onSignal = () => { interrupted = true }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    while (!interrupted) {
      const code = printSnapshot()
      if (code !== 0) return code
      snapshots++
      if (parsed.count !== undefined && snapshots >= parsed.count) {
        break
      }
      await new Promise<void>((resolve) => {
        let check: NodeJS.Timeout | undefined
        const timer = setTimeout(() => {
          if (check !== undefined) clearInterval(check)
          resolve()
        }, parsed.intervalMs)
        check = setInterval(() => {
          if (interrupted) {
            clearTimeout(timer)
            clearInterval(check)
            resolve()
          }
        }, 50)
        check.unref()
      })
    }
  } finally {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
  }

  return 0
}

async function runTaskOrInit(argv: readonly string[]): Promise<number> {
  const isInit = argv[0] === 'init'
  const action = argv[1]
  const isPhase = argv[0] === 'phase' && action === 'advance'
  const start = isInit ? 1 : 2
  if (!isInit && !isPhase && (argv[0] !== 'task' || (action !== 'create' && action !== 'kill' && action !== 'retry'))) return await run(argv)
  const allowed = isInit ? ['--state-dir', '--repo'] : isPhase ? ['--state-dir', '--phase', '--command-id'] : ['--state-dir', action === 'create' ? '--title' : '--task', '--command-id', ...(action === 'create' ? ['--scope', '--max-attempts', '--timeout-ms', '--phase', '--after'] : [])]
  const values: Record<string, string> = {}
  const scopes: string[] = []
  const after: string[] = []
  for (let i = start; i < argv.length; i++) {
    const key = argv[i]!
    const value = argv[++i]
    if (!allowed.includes(key) || (key !== '--scope' && key !== '--after' && values[key] !== undefined) || value === undefined || (key !== '--scope' && value.startsWith('-')) || !value.trim() || !value.isWellFormed()) {
      process.stderr.write('\u062e\u0637\u0623 \u0641\u064a \u0627\u0644\u0648\u0633\u0627\u0626\u0637: factory --state-dir <path>\n')
      return 2
    }
    if (key === '--scope') scopes.push(value)
    else if (key === '--after') after.push(value)
    else values[key] = value
  }
  const required = isInit ? ['--state-dir', '--repo'] : ['--state-dir', isPhase ? '--phase' : action === 'create' ? '--title' : '--task']
  if (required.some((key) => values[key] === undefined) || (values['--command-id'] !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(values['--command-id']))) {
    process.stderr.write('\u062e\u0637\u0623 \u0641\u064a \u0627\u0644\u0648\u0633\u0627\u0626\u0637: factory --state-dir <path>\n')
    return 2
  }
  const deps = parseDeps(after)
  const phase = values['--phase']
  const scope = parseScope(scopes.length ? scopes : ['.'])
  const integerOption = (key: string, fallback: number | null, min: number, max: number): number | null | undefined => {
    const value = values[key]
    if (value === undefined) return fallback
    const n = Number(value)
    return /^[0-9]+$/.test(value) && Number.isSafeInteger(n) && n >= min && n <= max ? n : undefined
  }
  const maxAttempts = integerOption('--max-attempts', 3, 1, 10)
  const timeoutMs = integerOption('--timeout-ms', null, 1000, 86400000)
  if (!scope.ok || !deps.ok || (phase !== undefined && !PHASES.includes(phase as PhaseName)) || maxAttempts === undefined || timeoutMs === undefined) {
    process.stderr.write('\u062e\u0637\u0623 \u0641\u064a \u0627\u0644\u0648\u0633\u0627\u0626\u0637: factory --state-dir <path>\n')
    return 2
  }
  try {
    if (isInit) {
      const { init } = await import('../app/init.ts')
      init(values['--state-dir']!, values['--repo']!)
      process.stdout.write('\u062a\u0645 \u0627\u0644\u062a\u0647\u064a\u0626\u0629\n')
    } else {
      const path = join(values['--state-dir']!, 'state.sqlite')
      if (!existsSync(path)) throw new Error('missing database')
      const db = new DatabaseSync(path)
      try {
        db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000')
        const project = db.prepare('SELECT project_id FROM project_config').get() as { project_id: string } | undefined
        if (!project) throw new Error('missing project')
        const id = values['--command-id'] ?? randomUUID()
        const existing = db.prepare('SELECT created_at FROM commands WHERE id = ?').get(id) as { created_at: string } | undefined
        const { appendCommand } = await import('../app/commands.ts')
        const result = appendCommand(db, { id, projectId: project.project_id, kind: isPhase ? 'phase.advance' : `task.${action}`, payloadJson: JSON.stringify(isPhase ? { phase } : action === 'create' ? { title: values['--title'], scope: scope.scope, maxAttempts, timeoutMs, phase: phase ?? null, deps: deps.deps } : { taskId: values['--task'] }), createdAt: existing?.created_at ?? new Date().toISOString() })
        process.stdout.write(`${result} ${id}\n\u062a\u0645 \u062a\u0633\u062c\u064a\u0644 \u0627\u0644\u0623\u0645\u0631\n`)
      } finally { db.close() }
    }
    return 0
  } catch (error) {
    process.stderr.write(`\u062a\u0639\u0630\u0631 \u062a\u0646\u0641\u064a\u0630 \u0627\u0644\u0623\u0645\u0631: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function runStart(argv: readonly string[]): Promise<number> {
  const values: Record<string, string> = {}
  let idle = false
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i]!
    if (key === '--exit-when-idle') { if (idle) return startUsage(); idle = true; continue }
    if (!['--state-dir', '--takeover', '--stale-after-ms', '--heartbeat-ms'].includes(key) || values[key] !== undefined) return startUsage()
    const value = argv[++i]
    if (!value || value.startsWith('-')) return startUsage()
    values[key] = value
  }
  if (!values['--state-dir']) return startUsage()
  const numberOption = (key: string, fallback: number): number | undefined => {
    const value = values[key]
    if (value === undefined) return fallback
    const n = Number(value)
    return /^[0-9]+$/.test(value) && Number.isSafeInteger(n) && n > 0 ? n : undefined
  }
  const staleAfterMs = numberOption('--stale-after-ms', DEFAULT_STALE_AFTER_MS)
  const heartbeatMs = numberOption('--heartbeat-ms', 1000)
  if (!staleAfterMs || !heartbeatMs) return startUsage()
  let takeover: { ownerId: string; generation: number; heartbeatMs: number } | undefined
  if (values['--takeover']) {
    const parts = values['--takeover'].split(':')
    if (parts.length !== 3 || !parts[0] || !/^[0-9]+$/.test(parts[1]!) || !/^[0-9]+$/.test(parts[2]!)) return startUsage()
    takeover = { ownerId: parts[0], generation: Number(parts[1]), heartbeatMs: Number(parts[2]) }
    if (!Number.isSafeInteger(takeover.generation) || takeover.generation < 1 || !Number.isSafeInteger(takeover.heartbeatMs)) return startUsage()
  }
  let fault: import('../app/faults.ts').FaultName | undefined
  try { fault = (await import('../app/faults.ts')).parseFault(process.env.FACTORY_FAULT) } catch { return startUsage() }
  try {
    const stateDir = values['--state-dir']!
    if (!existsSync(join(stateDir, 'state.sqlite'))) throw new Error('missing database')
    const { openStore } = await import('../app/store.ts')
    const { acquireSupervisor } = await import('../app/supervisor-lease.ts')
    const { runTick } = await import('../app/supervisor-loop.ts')
    const { readCompletion, reconcileWorkers } = await import('../app/recovery.ts')
    const { spawnWorker, killTree } = await import('../app/process-tree.ts')
    const db = openStore(join(stateDir, 'state.sqlite'))
    try {
      const handle = acquireSupervisor(db, stateDir, { nowMs: Date.now(), staleAfterMs, takeover })
      try {
        await reconcileWorkers(db, handle, { killTree, stateDir, staleAfterMs }, Date.now())
        while (true) {
          try {
            const result = await runTick(db, handle, { spawnWorker, killTree, stateDir, staleAfterMs, readResult: readCompletion, isAlive: (pid) => { try { process.kill(pid, 0); return true } catch { return false } } }, Date.now(), { fault })
            if (idle && result.idle) break
          } catch (error) {
            if (typeof error !== 'object' || error === null || !('errcode' in error) || (error.errcode !== 5 && error.errcode !== 6)) throw error
            process.stderr.write('\u0642\u0627\u0639\u062f\u0629 \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a \u0645\u0634\u063a\u0648\u0644\u0629\u061b \u0633\u062a\u062a\u0645 \u0625\u0639\u0627\u062f\u0629 \u0627\u0644\u0645\u062d\u0627\u0648\u0644\u0629\n')
          }
          await new Promise((resolve) => setTimeout(resolve, heartbeatMs))
        }
      } finally { handle.release(Date.now()) }
    } finally { db.close() }
    process.stdout.write('\u0627\u0643\u062a\u0645\u0644 \u062a\u0634\u063a\u064a\u0644 \u0627\u0644\u0645\u0634\u0631\u0641\n')
    return 0
  } catch (error) {
    process.stderr.write(`\u062a\u0639\u0630\u0631 \u062a\u0634\u063a\u064a\u0644 \u0627\u0644\u0645\u0634\u0631\u0641: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
function startUsage(): number { process.stderr.write('\u062e\u0637\u0623 \u0641\u064a \u0648\u0633\u0627\u0626\u0637 \u0627\u0644\u062a\u0634\u063a\u064a\u0644\n'); return 2 }

process.exitCode = process.argv[2] === 'start' ? await runStart(process.argv.slice(2)) : await runTaskOrInit(process.argv.slice(2))
