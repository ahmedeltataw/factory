// Guard: every CHK-<card>-* check id in the card's spec section must have a
// passing (or deferred not-run) result in the evidence record (CHK-M1-03-c).
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

function fail(reason) {
  console.log(`FAIL: ${reason}`)
  process.exit(1)
}

function parseFlags(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i]
    if (name !== '--spec' && name !== '--card' && name !== '--evidence') {
      fail(`unexpected argument: ${name}`)
    }
    const value = argv[i + 1]
    if (value === undefined) fail(`${name} requires a value`)
    flags[name.slice(2)] = value
    i++
  }
  for (const required of ['spec', 'card', 'evidence']) {
    if (flags[required] === undefined) fail(`missing required flag --${required}`)
    if (flags[required] === '') fail(`--${required} requires a value`)
  }
  return flags
}

const { spec, card, evidence } = parseFlags(process.argv.slice(2))
const cardEscaped = card.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const idRegex = new RegExp(`\\bCHK-${cardEscaped}-[a-z0-9]+\\b`, 'g')

let specSource
try {
  specSource = await readFile(path.resolve(spec), 'utf8')
} catch (error) {
  fail(`cannot read spec ${spec}: ${error?.message}`)
}

const lines = specSource.split(/\r?\n/)
let sectionStart = -1
for (let i = 0; i < lines.length; i++) {
  const heading = /^###\s+(.*)$/.exec(lines[i])
  if (heading !== null) {
    const title = heading[1].trim()
    if (title === card || title.startsWith(`${card} `)) {
      sectionStart = i
      break
    }
  }
}
if (sectionStart === -1) fail(`section '### ${card}' not found in spec ${spec}`)

let sectionEnd = lines.length
for (let i = sectionStart + 1; i < lines.length; i++) {
  if (/^\s*#{2,}\s/.test(lines[i])) {
    sectionEnd = i
    break
  }
}
const section = lines.slice(sectionStart + 1, sectionEnd).join('\n')

const ids = [...new Set(section.match(idRegex) ?? [])]
if (ids.length === 0) {
  fail(`no CHK-${card}-* check ids found in the ${card} spec section`)
}

let evidenceSource
try {
  evidenceSource = await readFile(path.resolve(evidence), 'utf8')
} catch (error) {
  fail(`cannot read evidence ${evidence}: ${error?.message}`)
}
let record
try {
  record = JSON.parse(evidenceSource)
} catch (error) {
  fail(`evidence ${evidence} is not valid JSON`)
}
const checks = Array.isArray(record?.checks) ? record.checks : null
if (checks === null) fail(`evidence ${evidence} has no checks array`)

const isCovered = (id) => {
  return checks.some((entry) => {
    if (!entry || typeof entry !== 'object' || entry.id !== id) return false
    if (entry.result === 'pass') return true
    return (
      entry.result === 'not-run' &&
      typeof entry.deferred_to === 'string' &&
      entry.deferred_to.trim() !== ''
    )
  })
}

const uncovered = ids.filter((id) => !isCovered(id))
if (uncovered.length > 0) {
  fail(
    `${uncovered.length} check(s) without pass result in evidence: ${uncovered.join(', ')}`,
  )
}

console.log(`OK (${ids.length} check(s) covered)`)
