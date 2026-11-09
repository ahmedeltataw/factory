#!/usr/bin/env node
import { readStatus, formatStatus, type Status } from '../app/status.ts'

import { DEFAULT_STALE_AFTER_MS } from '../app/supervisor-lease.ts'

interface ParsedArgs {
  readonly stateDir: string
  readonly json: boolean
  readonly staleAfterMs: number
}

class ArgumentError extends Error {}

function usage(message: string): never {
  throw new ArgumentError(`خطأ في الوسائط: ${message}\nالاستخدام: factory status --state-dir <مسار الحالة> [--json] [--stale-after-ms <عدد صحيح موجب>]`)
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv.length === 0 || argv[0] !== 'status') usage('الأمر غير مدعوم؛ الأمر الوحيد هو "status"')
  let stateDir: string | undefined
  let json = false
  let staleAfterMs: number | undefined
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
    } else if (arg.startsWith('-')) {
      usage(`الخيار غير معروف: ${arg}`)
    } else {
      usage(`وسيطة غير متوقعة: ${arg}`)
    }
  }
  if (stateDir === undefined) usage('الخيار --state-dir مطلوب')
  return { stateDir, json, staleAfterMs: staleAfterMs ?? DEFAULT_STALE_AFTER_MS }
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

process.exitCode = run(process.argv.slice(2))
