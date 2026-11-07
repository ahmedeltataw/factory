// Guard: validate evidence records (path .factory/evidence/<card>/<attempt>.json).
// Required fields, non-empty checks, result enum, no fail, not-run needs deferred_to.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const REQUIRED_FIELDS = ['schema_version', 'card', 'attempt', 'role', 'checks']
const VALID_RESULTS = ['pass', 'fail', 'not-run']

function fail(reason) {
  console.log(`FAIL: ${reason}`)
  process.exit(1)
}

const files = process.argv.slice(2)
if (files.length === 0) fail('usage: check-evidence.mjs <file> [...]')

for (const file of files) {
  const display = path.relative(process.cwd(), path.resolve(file)) || file
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    fail(`${display}: cannot read file: ${error?.message}`)
  }
  let record
  try {
    record = JSON.parse(raw)
  } catch (error) {
    fail(`${display}: invalid JSON: ${error?.message}`)
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    fail(`${display}: record must be a JSON object`)
  }
  for (const field of REQUIRED_FIELDS) {
    if (!(field in record)) fail(`${display}: missing required field '${field}'`)
  }
  if (!Array.isArray(record.checks)) fail(`${display}: 'checks' must be an array`)
  if (record.checks.length === 0) fail(`${display}: 'checks' must not be empty`)

  for (let i = 0; i < record.checks.length; i++) {
    const check = record.checks[i]
    const where = `${display}: checks[${i}]`
    if (check === null || typeof check !== 'object') {
      fail(`${where}: entry must be an object`)
    }
    if (typeof check.id !== 'string' || check.id === '') {
      fail(`${where}: missing 'id'`)
    }
    const labelled = `${where} (${check.id})`
    if (!('result' in check)) fail(`${labelled}: missing 'result'`)
    const result = check.result
    if (!VALID_RESULTS.includes(result)) {
      fail(`${labelled}: invalid result ${JSON.stringify(String(result))}`)
    }
    if (result === 'fail') fail(`${labelled}: recorded failure`)
    if (result === 'not-run') {
      const deferred =
        typeof check.deferred_to === 'string' && check.deferred_to.trim() !== ''
      if (!deferred) fail(`${labelled}: 'not-run' requires 'deferred_to'`)
    }
  }
}

console.log(`OK (${files.length} record(s) validated)`)
