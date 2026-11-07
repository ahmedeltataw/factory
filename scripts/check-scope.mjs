// Guard: changed paths must stay inside the card's scope. Sources: either a
// git diff against a base ref, or a text file with one path per line.
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const FORBIDDEN_DIRS = ['tests/protected', 'docs', 'schemas', '.factory', 'licenses']
const FORBIDDEN_FILES = ['SOURCE_MANIFEST.json', 'NOTICE', 'LICENSE']

function fail(reason) {
  console.log(`FAIL: ${reason}`)
  process.exit(1)
}

function parseFlags(argv) {
  let base
  let pathsFile
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i]
    if (name === '--base' || name === '--paths') {
      const value = argv[i + 1]
      if (value === undefined) fail(`${name} requires a value`)
      if (name === '--base') {
        if (pathsFile !== undefined) fail('--base and --paths are mutually exclusive')
        base = value
      } else {
        if (base !== undefined) fail('--base and --paths are mutually exclusive')
        pathsFile = value
      }
      i++
    } else {
      fail(`unexpected argument: ${name}`)
    }
  }
  if (base === undefined && pathsFile === undefined) {
    fail('usage: check-scope.mjs (--base <git-ref> | --paths <file>)')
  }
  return { base, pathsFile }
}

const { base, pathsFile } = parseFlags(process.argv.slice(2))

let changedPaths
if (base !== undefined) {
  const result = spawnSync('git', ['diff', '--name-only', `${base}...HEAD`], {
    encoding: 'utf8',
  })
  if (result.error !== undefined && result.error !== null) {
    fail(`git diff failed: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const firstError = String(result.stderr ?? '').trim().split(/\r?\n/)[0]
    fail(`git diff failed: ${firstError || `exit code ${result.status}`}`)
  }
  changedPaths = String(result.stdout ?? '').split(/\r?\n/)
} else {
  let raw
  try {
    raw = await readFile(path.resolve(pathsFile), 'utf8')
  } catch (error) {
    fail(`cannot read paths file ${pathsFile}: ${error?.message}`)
  }
  changedPaths = raw.split(/\r?\n/).map((line) => line.trim())
}

// Normalize: accept \ or / separators and any drive-letter case.
const normalized = changedPaths
  .map((line) => path.posix.normalize(line.replaceAll('\\', '/')).replaceAll('\\', '/'))
  .filter((line) => line !== '' && line !== '.')

const isProtected = (p) => {
  for (const file of FORBIDDEN_FILES) {
    if (p === file) return true
  }
  for (const dir of FORBIDDEN_DIRS) {
    if (p === dir || p.startsWith(`${dir}/`)) return true
  }
  return false
}

const offenders = normalized.filter(isProtected)
if (offenders.length > 0) {
  fail(`out-of-scope paths: ${offenders.join(', ')}`)
}

console.log(`OK (${normalized.length} changed path(s) in scope)`)
