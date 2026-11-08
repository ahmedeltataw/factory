#!/usr/bin/env node
import { readStatus, formatStatus, type Status } from '../app/status.ts'

const STALE_AFTER_MS = 300_000

interface ParsedArgs {
  readonly stateDir: string
  readonly json: boolean
}

class ArgumentError extends Error {}

function usage(message: string): never {
  throw new ArgumentError(`خطأ في الوسائط: ${message}\nالاستخدام: factory status --state-dir <مسار الحالة> [--json]`)
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv.length === 0 || argv[0] !== 'status') usage('الأمر غير مدعوم؛ الأمر الوحيد هو "status"')
  let stateDir: string | undefined
  let json = false
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) usage('وسيطة غير متوقعة')
    if (arg === '--state-dir') {
      if (stateDir !== undefined) usage('الخيار --state-dir مكرر')
      if (i + 1 >= argv.length) usage('القيمة مفقودة للخيار --state-dir')
      stateDir = argv[++i]
      if (stateDir === undefined || stateDir === '' || stateDir.startsWith('-')) usage('قيمة غير صالحة للخيار --state-dir')
    } else if (arg === '--json') {
      if (json) usage('الخيار --json مكرر')
      json = true
    } else if (arg.startsWith('-')) {
      usage(`الخيار غير معروف: ${arg}`)
    } else {
      usage(`وسيطة غير متوقعة: ${arg}`)
    }
  }
  if (stateDir === undefined) usage('الخيار --state-dir مطلوب')
  return { stateDir, json }
}

function run(argv: readonly string[]): number {
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

  let status: Status
  try {
    status = readStatus(parsed.stateDir, { nowMs: Date.now(), staleAfterMs: STALE_AFTER_MS })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`فشل في قراءة حالة المشغل: ${message}\n`)
    return 1
  }

  process.stdout.write(`${parsed.json ? JSON.stringify(status) : formatStatus(status)}\n`)
  return 0
}

process.exitCode = run(process.argv.slice(2))
