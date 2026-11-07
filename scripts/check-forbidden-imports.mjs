// Guard: forbid DSH host coupling in supervisor sources (CHK-M1-03-b).
// Pass: exit 0 + "OK". Fail: exit 1 + one line "FAIL: <reason>".
//
// Matching rules: comments and plain strings are ignored. Only treated as
// imports are `import ... from '<s>'`, `import '<s>'`, `export ... from '<s>'`
// (including `export * from`), and `import(<literal>)` where the literal is a
// ', " or ` string without `${`. Everything else (e.g. `const s = 'cordis'`)
// is not an import.
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

// Character scanner (no dependency). Returns the source with comments blanked
// out (comment text becomes spaces) plus a per-character mask marking which
// characters live inside a string or template literal. Literals are tracked
// first, so a `//` inside `'...'` does not start a comment and a quote inside
// a `//` comment does not start a string. Template `${...}` expressions are
// scanned as code (with brace counting) and may contain comments.
const MASK_CODE = 0
const MASK_STRING = 1
const MASK_COMMENT = 2

function analyze(source) {
  const len = source.length
  const text = new Array(len)
  for (let k = 0; k < len; k++) text[k] = source[k]
  const mask = new Uint8Array(len)
  let i = 0
  let quote = null // active quote char: "'", '"', or '`' (template)
  const templateDepths = [] // brace depth per open template ${ expression }

  while (i < len) {
    const c = source[i]
    const n = i + 1 < len ? source[i + 1] : ''

    // Inside a quoted string: keep content verbatim, honor escapes.
    if (quote !== null && quote !== '`') {
      mask[i] = MASK_STRING
      if (c === '\\') {
        if (n !== '') {
          mask[i + 1] = MASK_STRING
          i += 2
        } else {
          i += 1
        }
        continue
      }
      if (c === quote) quote = null
      i += 1
      continue
    }

    // Inside a template literal: keep content verbatim, honor escapes,
    // `${` reopens code context.
    if (quote === '`') {
      mask[i] = MASK_STRING
      if (c === '\\') {
        if (n !== '') {
          mask[i + 1] = MASK_STRING
          i += 2
        } else {
          i += 1
        }
        continue
      }
      if (c === '`') {
        quote = null
        i += 1
        continue
      }
      if (c === '$' && n === '{') {
        templateDepths.push(0)
        quote = null
        i += 2
        continue
      }
      i += 1
      continue
    }

    // Code context.
    if (c === '/' && n === '/') {
      // Line comment: blank out, keep the newline.
      while (i < len && source[i] !== '\n') {
        text[i] = ' '
        mask[i] = MASK_COMMENT
        i += 1
      }
      continue
    }
    if (c === '/' && n === '*') {
      // Block comment: blank out, keep newlines.
      text[i] = ' '
      text[i + 1] = ' '
      mask[i] = MASK_COMMENT
      mask[i + 1] = MASK_COMMENT
      i += 2
      while (i < len) {
        if (source[i] === '*' && source[i + 1] === '/') {
          text[i] = ' '
          text[i + 1] = ' '
          mask[i] = MASK_COMMENT
          mask[i + 1] = MASK_COMMENT
          i += 2
          break
        }
        if (source[i] !== '\n') {
          text[i] = ' '
          mask[i] = MASK_COMMENT
        }
        i += 1
      }
      continue
    }
    if (c === '\'' || c === '"') {
      quote = c
      mask[i] = MASK_STRING
      i += 1
      continue
    }
    if (c === '`') {
      quote = '`'
      mask[i] = MASK_STRING
      i += 1
      continue
    }
    if (templateDepths.length > 0) {
      if (c === '{') {
        templateDepths[templateDepths.length - 1] += 1
        i += 1
        continue
      }
      if (c === '}') {
        const depth = templateDepths[templateDepths.length - 1]
        if (depth > 0) {
          templateDepths[templateDepths.length - 1] = depth - 1
        } else {
          templateDepths.pop()
          quote = '`' // back into the template literal
        }
        i += 1
        continue
      }
    }
    i += 1
  }

  return { text: text.join(''), mask }
}

// From-imports: `import <clause> from '<s>'` / `export <clause> from '<s>'`
// (including `export * from`). The tempered scan between the keyword and
// `from` never crosses `=`, `;` or the word from, so
// `export const from = 'cordis'` is not an import.
const FROM_IMPORT_RE =
  /(?<![\w$.])(?:import|export)\b(?:(?![=;])(?!\bfrom\b)[\s\S])*?\bfrom\s*(['"`])([^'"`\r\n]*)\1/g

// Side-effect import: `import '<s>'`.
const SIDE_EFFECT_IMPORT_RE = /(?<![\w$.])import\s*(['"`])([^'"`\r\n]*)\1/g

// Static dynamic import: `import('<s>')` — literal without substitutions.
const DYNAMIC_IMPORT_RE = /(?<![\w$.])import\s*\(\s*(['"`])([^'"`\r\n]*)\1/g

function collectSpecifiers(source) {
  const { text, mask } = analyze(source)
  const isCodeAt = (index) => mask[index] === MASK_CODE
  const found = new Set()
  const add = (spec) => {
    if (spec !== '') found.add(spec)
  }
  let match
  FROM_IMPORT_RE.lastIndex = 0
  while ((match = FROM_IMPORT_RE.exec(text)) !== null) {
    if (isCodeAt(match.index)) add(match[2])
  }
  SIDE_EFFECT_IMPORT_RE.lastIndex = 0
  while ((match = SIDE_EFFECT_IMPORT_RE.exec(text)) !== null) {
    if (isCodeAt(match.index)) add(match[2])
  }
  DYNAMIC_IMPORT_RE.lastIndex = 0
  while ((match = DYNAMIC_IMPORT_RE.exec(text)) !== null) {
    if (isCodeAt(match.index) && !(match[1] === '`' && match[2].includes('${'))) {
      add(match[2])
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
