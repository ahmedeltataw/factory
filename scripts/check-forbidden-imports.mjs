// Guard: forbid DSH host coupling in supervisor sources (CHK-M1-03-b).
// Pass: exit 0 + "OK". Fail: exit 1 + one line "FAIL: <reason>".
//
// Module specifiers are collected with the TypeScript compiler API (already a
// devDependency), so comments, strings and regex literals are handled by the
// real parser instead of a hand-written character scanner. Only static
// specifiers count:
// - `import ... from '<s>'` / `import '<s>'` (ImportDeclaration)
// - `export ... from '<s>'`, incl. `export * from` (ExportDeclaration)
// - `import('<s>')` where the argument is a string literal or a template
//   literal without `${...}` substitutions
// - `import x = require('<s>')` (ImportEqualsDeclaration with an
//   ExternalModuleReference)
// Everything else (e.g. `const s = 'cordis'` or `/import('cordis')/`) is not
// an import.
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import ts from 'typescript'

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

// Static specifier text when the node is a plain string literal or a template
// literal without substitutions; a template with `${...}` is dynamic, not a
// static specifier.
function staticSpecifier(node) {
  if (node === undefined || node === null) return undefined
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return undefined
}

// Walk the AST (forEachChild, recursively) and collect module specifiers from
// exactly the four import shapes listed in the header. Because the compiler
// does the tokenizing, a regex literal like /import('cordis')/ or a regex
// containing // or /* can neither produce a false positive nor hide a real
// import that follows it.
function collectSpecifiers(file, source) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const found = new Set()
  const add = (spec) => {
    if (spec) found.add(spec)
  }
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      add(staticSpecifier(node.moduleSpecifier))
    } else if (ts.isExportDeclaration(node)) {
      // `export * from` and `export { x } from`; a bare `export { x }` has no
      // moduleSpecifier and is not an import.
      add(staticSpecifier(node.moduleSpecifier))
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        add(staticSpecifier(node.arguments[0]))
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      // `import x = require('y')` or an external ambient reference.
      if (node.moduleReference && ts.isExternalModuleReference(node.moduleReference)) {
        add(staticSpecifier(node.moduleReference.expression))
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sf, visit)
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
  for (const spec of collectSpecifiers(absolute, source)) {
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
