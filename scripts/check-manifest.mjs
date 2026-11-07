// Guard: verify ported files against SOURCE_MANIFEST.json.
// Hashing: CRLF -> LF before sha256; protected tests hash after reverting the
// documented ../../supervisor/src/core/index.ts import rewrite.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const PROMOTED_IMPORT = "'../../supervisor/src/core/index.ts'"
const ORIGINAL_IMPORT = "'../src/core/index.ts'"

function fail(reason) {
  console.log(`FAIL: ${reason}`)
  process.exit(1)
}

function parseRoot(argv) {
  let root = '.'
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') {
      const value = argv[i + 1]
      if (value === undefined) fail('--root requires a directory argument')
      root = value
      i++
    } else {
      fail(`unexpected argument: ${argv[i]}`)
    }
  }
  return root
}

function sha256Hex(text) {
  const lf = text.replaceAll('\r\n', '\n')
  return createHash('sha256').update(Buffer.from(lf, 'utf8')).digest('hex')
}

// src/core/X -> supervisor/src/core/X, src/app/X -> supervisor/src/app/X
function mapPortVerbatim(sourcePath) {
  if (sourcePath.startsWith('src/core/')) {
    return `supervisor/src/core/${sourcePath.slice('src/core/'.length)}`
  }
  if (sourcePath.startsWith('src/app/')) {
    return `supervisor/src/app/${sourcePath.slice('src/app/'.length)}`
  }
  return null
}

function mapProtectedTest(sourcePath) {
  if (!sourcePath.startsWith('tests/')) return null
  return `tests/protected/${sourcePath.slice('tests/'.length)}`
}

const root = path.resolve(parseRoot(process.argv.slice(2)))
const manifestPath = path.join(root, 'SOURCE_MANIFEST.json')

let raw
try {
  raw = await readFile(manifestPath, 'utf8')
} catch (error) {
  fail(`cannot read manifest ${manifestPath}: ${error?.message}`)
}
let manifest
try {
  manifest = JSON.parse(raw)
} catch (error) {
  fail(`manifest ${manifestPath} is not valid JSON: ${error?.message}`)
}
const entries = Array.isArray(manifest?.files_selected_for_m1)
  ? manifest.files_selected_for_m1
  : null
if (entries === null) fail('manifest has no files_selected_for_m1 array')

const missing = []
const mismatched = []
const other = []

for (const entry of entries) {
  if (entry === null || typeof entry !== 'object') {
    other.push('invalid entry in files_selected_for_m1')
    continue
  }
  const sourcePath = String(entry.path ?? '').replaceAll('\\', '/')
  const action = String(entry.action ?? '')
  let target = null
  if (action === 'port-adapt') continue
  if (action === 'port-verbatim') {
    const mapped = mapPortVerbatim(sourcePath)
    if (mapped === null) {
      other.push(`${sourcePath}: no port-verbatim mapping`)
      continue
    }
    target = path.join(root, ...mapped.split('/'))
  } else if (action.startsWith('protected-test')) {
    const mapped = mapProtectedTest(sourcePath)
    if (mapped === null) {
      other.push(`${sourcePath}: no protected-test mapping`)
      continue
    }
    target = path.join(root, ...mapped.split('/'))
  } else if (action === 'attribution') {
    target = path.join(root, 'licenses', 'dsh-superagent-MIT.txt')
  } else {
    other.push(`${sourcePath}: unknown action ${JSON.stringify(action)}`)
    continue
  }

  let content
  try {
    content = await readFile(target, 'utf8')
  } catch (error) {
    missing.push(sourcePath)
    continue
  }
  if (action.startsWith('protected-test')) {
    content = content.split(PROMOTED_IMPORT).join(ORIGINAL_IMPORT)
  }
  const hash = sha256Hex(content)
  const expected =
    action === 'attribution' ? manifest?.source?.license_sha256 : entry.blob_sha256
  if (typeof expected !== 'string') {
    other.push(`${sourcePath}: manifest entry has no expected sha256`)
    continue
  }
  if (hash !== expected.toLowerCase()) {
    mismatched.push(`${sourcePath} (got ${hash}, want ${expected.toLowerCase()})`)
  }
}

const problems = [
  ...missing.map((p) => `missing: ${p}`),
  ...mismatched.map((p) => `mismatch: ${p}`),
  ...other,
]
if (problems.length > 0) {
  fail(`manifest check failed: ${problems.join('; ')}`)
}

console.log(`OK (${entries.length} manifest entry(ies) verified)`)
