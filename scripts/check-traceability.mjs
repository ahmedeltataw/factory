// Guard: every CHK-<card>-* check id in the card's spec section must have a
// passing (or deferred not-run) result in the evidence record (CHK-M1-03-c).
// Single-card mode: --spec <md> --card <id> --evidence <json>.
// All mode (--all): for every directory .factory/evidence/<card>/ take the
// record with the highest attempt number; if any docs/milestones/*.md has a
// `### <card>` section, check it exactly like single-card mode. Cards without
// a spec section are skipped and listed. Exit 1 if any checked card fails.
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

function fail(reason) {
  console.log(`FAIL: ${reason}`)
  process.exit(1)
}

function parseFlags(argv) {
  const flags = { all: false, spec: undefined, card: undefined, evidence: undefined }
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i]
    if (name === '--all') {
      if (flags.spec !== undefined || flags.card !== undefined || flags.evidence !== undefined) {
        fail('--all cannot be combined with --spec, --card or --evidence')
      }
      flags.all = true
      continue
    }
    if (name !== '--spec' && name !== '--card' && name !== '--evidence') {
      fail(`unexpected argument: ${name}`)
    }
    if (flags.all) {
      fail('--all cannot be combined with --spec, --card or --evidence')
    }
    const value = argv[i + 1]
    if (value === undefined) fail(`${name} requires a value`)
    flags[name.slice(2)] = value
    i++
  }
  if (!flags.all) {
    for (const required of ['spec', 'card', 'evidence']) {
      if (flags[required] === undefined) fail(`missing required flag --${required} (or pass --all)`)
      if (flags[required] === '') fail(`--${required} requires a value`)
    }
  }
  return flags
}

// The section ends only at the next line starting with exactly `### ` or
// `## `; a `#### ` sub-heading inside the card does NOT end it.
const SECTION_BOUNDARY_RE = /^(?:## |### )/

function findSectionStart(lines, card) {
  for (let i = 0; i < lines.length; i++) {
    const heading = /^###\s+(.*)$/.exec(lines[i])
    if (heading !== null) {
      const title = heading[1].trim()
      if (title === card || title.startsWith(`${card} `)) return i
    }
  }
  return -1
}

function findSectionEnd(lines, start) {
  for (let i = start + 1; i < lines.length; i++) {
    if (SECTION_BOUNDARY_RE.test(lines[i])) return i
  }
  return lines.length
}

const isCovered = (checks, id) => {
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

// Shared card check. Returns { sectionFound: false } when the spec has no
// `### <card>` section (skip-listed in --all mode, failure in single mode).
function cardCheck(specSource, card, record, evidenceLabel) {
  const lines = specSource.split(/\r?\n/)
  const start = findSectionStart(lines, card)
  if (start === -1) return { sectionFound: false, ok: false }

  const end = findSectionEnd(lines, start)
  const section = lines.slice(start + 1, end).join('\n')

  const cardEscaped = card.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const ids = [...new Set(section.match(new RegExp(`\\bCHK-${cardEscaped}-[a-z0-9]+\\b`, 'g')) ?? [])]
  if (ids.length === 0) {
    return {
      sectionFound: true,
      ok: false,
      reason: `no CHK-${card}-* check ids found in the ${card} spec section`,
    }
  }

  const checks =
    record !== null && typeof record === 'object' && Array.isArray(record.checks)
      ? record.checks
      : null
  if (checks === null) {
    return {
      sectionFound: true,
      ok: false,
      reason: `evidence ${evidenceLabel} has no checks array`,
    }
  }

  const uncovered = ids.filter((id) => !isCovered(checks, id))
  if (uncovered.length > 0) {
    return {
      sectionFound: true,
      ok: false,
      reason: `${uncovered.length} check(s) without pass result in evidence: ${uncovered.join(', ')}`,
    }
  }
  return { sectionFound: true, ok: true, count: ids.length }
}

function readSpec(specPath) {
  try {
    return readFile(path.resolve(specPath), 'utf8')
  } catch (error) {
    return fail(`cannot read spec ${specPath}: ${error?.message}`)
  }
}

async function readEvidence(evidencePath) {
  let source
  try {
    source = await readFile(path.resolve(evidencePath), 'utf8')
  } catch (error) {
    return fail(`cannot read evidence ${evidencePath}: ${error?.message}`)
  }
  try {
    return JSON.parse(source)
  } catch {
    return fail(`evidence ${evidencePath} is not valid JSON`)
  }
}

// Collect docs/milestones/*.md sources, sorted, relative to the given root.
async function collectSpecFiles(root) {
  const dir = path.join(root, 'docs', 'milestones')
  let names
  try {
    names = await readdir(dir)
  } catch (error) {
    return fail(`cannot read ${path.join('docs', 'milestones')}: ${error?.message}`)
  }
  const specs = []
  for (const name of names.filter((n) => n.endsWith('.md')).sort()) {
    try {
      specs.push({ file: name, source: await readFile(path.join(dir, name), 'utf8') })
    } catch (error) {
      return fail(`cannot read ${path.join('docs', 'milestones', name)}: ${error?.message}`)
    }
  }
  return specs
}

// For every evidence directory <root>/.factory/evidence/<card>/ keep the
// record with the highest attempt number (invalid JSON counts as attempt -1).
async function collectEvidenceRecords(root) {
  const dir = path.join(root, '.factory', 'evidence')
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    return fail(`cannot read ${path.join('.factory', 'evidence')}: ${error?.message}`)
  }
  const stemNumber = (file) => {
    const m = /^(\d+)\.json$/.exec(file)
    return m === null ? Number.POSITIVE_INFINITY : Number(m[1])
  }
  const cards = []
  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const cardDir = path.join(dir, entry.name)
    const files = (
      await readdir(cardDir)
        .catch(() => [])
    )
      .filter((n) => n.endsWith('.json'))
      .sort((a, b) => stemNumber(a) - stemNumber(b) || a.localeCompare(b))
    if (files.length === 0) continue
    let best = null
    for (const file of files) {
      const label = path.join('.factory', 'evidence', entry.name, file)
      let record = null
      try {
        record = JSON.parse(await readFile(path.join(cardDir, file), 'utf8'))
      } catch {
        record = null
      }
      const attempt = record !== null && typeof record.attempt === 'number' ? record.attempt : -1
      if (best === null || attempt >= best.attempt) best = { attempt, record, label }
    }
    cards.push({ card: entry.name, record: best.record, evidenceLabel: best.label })
  }
  return cards
}

const { all, spec, card, evidence } = parseFlags(process.argv.slice(2))

if (!all) {
  const specSource = await readSpec(spec)
  const record = await readEvidence(evidence)

  const result = cardCheck(specSource, card, record, evidence)
  if (!result.sectionFound) fail(`section '### ${card}' not found in spec ${spec}`)
  if (!result.ok) fail(result.reason)
  console.log(`OK (${result.count} check(s) covered)`)
}

if (all) {
  const root = path.resolve(process.cwd())
  const specs = await collectSpecFiles(root)
  const cards = await collectEvidenceRecords(root)

  const checked = []
  const skipped = []
  const failures = []
  for (const { card: name, record, evidenceLabel } of cards) {
    // The first (sorted) milestone file that has a `### <card>` section.
    const owner = specs.find(
      (spec) => findSectionStart(spec.source.split(/\r?\n/), name) !== -1,
    )
    if (owner === undefined) {
      skipped.push(name)
      continue
    }
    const result = cardCheck(owner.source, name, record, evidenceLabel)
    checked.push(name)
    if (!result.ok) failures.push(`${name}: ${result.reason}`)
  }

  const summary = `checked ${checked.length} card(s): ${checked.join(', ') || 'none'}; skipped: ${skipped.join(', ') || 'none'}`
  if (failures.length > 0) {
    fail(`${failures.join('; ')} (${summary})`)
  }
  console.log(`OK (${summary})`)
}

