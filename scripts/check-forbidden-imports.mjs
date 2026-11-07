// Guard: forbid DSH host coupling in supervisor sources (CHK-M1-03-b).
// Pass: exit 0 + "OK". Fail: exit 1 + one line "FAIL: <reason>".
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const FORBIDDEN_PREFIXES = ['@deepseek-ai/', 'dsh-']
const FORBIDDEN_SUBSTRINGS = ['cordis', 'feishu']
const CORE_ALLOWED = new Set(['node:crypto'])
const CORE_PREFIX = 'supervisor/src/core/'

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

function isForbidden(spec) {
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (spec.startsWith(prefix)) return true
  }
  const lower = spec.toLowerCase()
  for (const fragment of FORBIDDEN_SUBSTRINGS) {
    if (lower.includes(fragment)) return true
  }
  return false
}

// Core code must only depend on its own directory and node:crypto.
function isCoreAllowed(spec) {
  return spec.startsWith('./') || CORE_ALLOWED.has(spec)
}

const SPECIFIER_RES = [
  // `import x from 'a'`, `export { x } from 'a'`, side-effect `import 'a'`
  /(?:\bfrom\b|\bimport\b)\s*(['"])([^'"\r\n]+)\1/g,
  // dynamic `import('a')`
  /\bimport\s*\(\s*(['"])([^'"\r\n]+)\1/g,
]

function collectSpecifiers(source) {
  const found = new Set()
  for (const re of SPECIFIER_RES) {
    re.lastIndex = 0
    let match
    while ((match = re.exec(source)) !== null) {
      const spec = match[2]
      if (spec !== '') found.add(spec)
    }
  }
  return [...found]
}

const root = path.resolve(parseRoot(process.argv.slice(2)))
const supervisorDir = path.join(root, 'supervisor')

let relativeFiles
try {
  relativeFiles = await readdir(supervisorDir, { recursive: true })
} catch (error) {
  if (error?.code === 'ENOENT') relativeFiles = []
  else fail(`cannot scan ${path.join(root, 'supervisor')}: ${error?.message}`)
}

const tsFiles = relativeFiles
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
  .sort()

for (const file of tsFiles) {
  const absolute = path.join(supervisorDir, file)
  const rel = path.relative(root, absolute).replaceAll('\\', '/')
  const source = await readFile(absolute, 'utf8')
  const inCore = rel.startsWith(CORE_PREFIX)
  for (const spec of collectSpecifiers(source)) {
    if (isForbidden(spec)) {
      fail(`${rel}: forbidden import specifier ${JSON.stringify(spec)}`)
    }
    if (inCore && !isCoreAllowed(spec)) {
      fail(
        `${rel}: src/core may only import relative './' paths or node:crypto, found ${JSON.stringify(spec)}`,
      )
    }
  }
}

console.log(`OK (${tsFiles.length} file(s) scanned)`)
