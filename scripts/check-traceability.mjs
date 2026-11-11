// Guard: every CHK-<card>-* check id in the card's spec section must have a
// passing (or deferred not-run) result in the evidence record (CHK-M1-03-c).
// Pass --require-passing to disallow deferred results (strict mode).
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
  const flags = {
    all: false,
    requirePassing: false,
    presentOnly: false,
    cardPrefix: undefined,
    spec: undefined,
    card: undefined,
    evidence: undefined,
  }
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i]
    if (name === '--all') {
      if (flags.spec !== undefined || flags.card !== undefined || flags.evidence !== undefined) {
        fail('--all cannot be combined with --spec, --card or --evidence')
      }
      flags.all = true
      continue
    }
    if (name === '--require-passing') {
      flags.requirePassing = true
      continue
    }
    if (name === '--present-only') {
      flags.presentOnly = true
      continue
    }
    if (name !== '--card-prefix' && name !== '--spec' && name !== '--card' && name !== '--evidence') {
      fail(`unexpected argument: ${name}`)
    }
    const prop = name === '--card-prefix' ? 'cardPrefix' : name.slice(2)
    if (flags[prop] !== undefined) {
      fail(`duplicate flag ${name}`)
    }
    const value = argv[i + 1]
    if (value === undefined || value === '' || value.startsWith('-')) {
      fail(`${name} requires a value`)
    }
    flags[prop] = value
    i++
  }
  if (flags.cardPrefix !== undefined && !flags.all) {
    fail('--card-prefix can only be used with --all')
  }
  if (flags.presentOnly && !flags.all) fail('--present-only can only be used with --all')
  if (flags.all) {
    if (flags.spec !== undefined || flags.card !== undefined || flags.evidence !== undefined) {
      fail('--all cannot be combined with --spec, --card or --evidence')
    }
  } else {
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

const isCovered = (checks, id, requirePassing = false) => {
  if (requirePassing) {
    const matching = checks.filter(
      (entry) => Boolean(entry) && typeof entry === 'object' && entry.id === id,
    )
    return matching.length > 0 && matching.every((entry) => entry.result === 'pass')
  }
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
function cardCheck(specSource, card, record, evidenceLabel, requirePassing = false) {
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

  const uncovered = ids.filter((id) => !isCovered(checks, id, requirePassing))
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
async function collectEvidenceRecords(root, strict = false, cardPrefix = undefined) {
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
  let dirEntries = entries.filter((e) => e.isDirectory() && e.name !== 'step-0')
  if (cardPrefix !== undefined) {
    dirEntries = dirEntries.filter((e) => e.name.startsWith(cardPrefix))
  }
  for (const entry of dirEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    const cardDir = path.join(dir, entry.name)
    const files = (
      await readdir(cardDir)
        .catch(() => [])
    )
      .filter((n) => n.endsWith('.json'))
      .sort((a, b) => stemNumber(a) - stemNumber(b) || a.localeCompare(b))
    if (files.length === 0) continue
    if (strict) {
      const seenAttempts = new Set()
      let best = null
      for (const file of files) {
        const label = path.join('.factory', 'evidence', entry.name, file)
        let record
        try {
          record = JSON.parse(await readFile(path.join(cardDir, file), 'utf8'))
        } catch {
          return fail(`evidence ${label} is not valid JSON`)
        }
        if (record === null || typeof record !== 'object' || Array.isArray(record)) {
          return fail(`evidence ${label} is not a valid JSON object`)
        }
        if (record.card !== entry.name) {
          return fail(`evidence ${label} card '${record.card}' does not match directory '${entry.name}'`)
        }
        const attempt = record.attempt
        if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt <= 0) {
          return fail(`evidence ${label} attempt must be a positive safe integer`)
        }
        if (seenAttempts.has(attempt)) {
          return fail(`evidence ${label} duplicate attempt ${attempt} for card ${entry.name}`)
        }
        seenAttempts.add(attempt)
        if (best === null || attempt > best.attempt) best = { attempt, record, label }
      }
      cards.push({ card: entry.name, record: best.record, evidenceLabel: best.label })
      continue
    }
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

const { all, requirePassing, presentOnly, cardPrefix, spec, card, evidence } = parseFlags(process.argv.slice(2))

if (!all) {
  const specSource = await readSpec(spec)
  const record = await readEvidence(evidence)

  const result = cardCheck(specSource, card, record, evidence, requirePassing)
  if (!result.sectionFound) fail(`section '### ${card}' not found in spec ${spec}`)
  if (!result.ok) fail(result.reason)
  console.log(`OK (${result.count} check(s) covered)`)
}

if (all) {
  const root = path.resolve(process.cwd())
  const specs = await collectSpecFiles(root)
  const cards = await collectEvidenceRecords(root, requirePassing, cardPrefix)

  if (requirePassing) {
    const qualifyingCards = []
    const seen = new Set()

    for (const spec of specs) {
      const lines = spec.source.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        const heading = /^###\s+(.*)$/.exec(lines[i])
        if (heading === null) continue
        const title = heading[1].trim()
        const idMatch = /^([^\s]+)/.exec(title)
        if (!idMatch) continue
        const id = idMatch[1]
        if (cardPrefix !== undefined && !id.startsWith(cardPrefix)) continue
        const end = findSectionEnd(lines, i)
        const section = lines.slice(i + 1, end).join('\n')
        const idEscaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const chkRegex = new RegExp(`\\bCHK-${idEscaped}-[a-z0-9]+\\b`)
        if (!chkRegex.test(section)) {
          if (cardPrefix !== undefined || cards.some((c) => c.card === id)) {
            fail(`card ${id}: missing CHK-${id}-* check in spec section`)
          }
          continue
        }
        if (seen.has(id)) fail(`duplicate section for card ${id}`)
        seen.add(id)
        qualifyingCards.push({ id, specSource: spec.source })
      }
    }

    if (qualifyingCards.length === 0) fail('no qualifying cards found')
    const qualifyingCardIds = new Set(qualifyingCards.map((c) => c.id))
    for (const { card: name } of cards) {
      if (!qualifyingCardIds.has(name)) fail(`evidence card ${name} has no qualifying spec section`)
    }
    const cardMap = new Map(cards.map((c) => [c.card, c]))
    const evidenceDirectories = presentOnly
      ? new Set((await readdir(path.join(root, '.factory', 'evidence'), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory()).map((entry) => entry.name))
      : new Set()
    const checked = []
    const failures = []
    for (const { id, specSource } of qualifyingCards) {
      const recordEntry = cardMap.get(id)
      if (!recordEntry) {
        if (presentOnly && !evidenceDirectories.has(id)) {
          console.log(`PENDING: ${id}`)
          continue
        }
        fail(`missing evidence record for card ${id}`)
      }
      const result = cardCheck(specSource, id, recordEntry.record, recordEntry.evidenceLabel, true)
      checked.push(id)
      if (!result.ok) failures.push(`${id}: ${result.reason}`)
    }
    const summary = `checked ${checked.length} card(s): ${checked.join(', ') || 'none'}; skipped: none`
    if (failures.length > 0) fail(`${failures.join('; ')} (${summary})`)
    console.log(`OK (${summary})`)
  } else {
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
    const result = cardCheck(owner.source, name, record, evidenceLabel, requirePassing)
    checked.push(name)
    if (!result.ok) failures.push(`${name}: ${result.reason}`)
  }

  const summary = `checked ${checked.length} card(s): ${checked.join(', ') || 'none'}; skipped: ${skipped.join(', ') || 'none'}`
  if (failures.length > 0) {
    fail(`${failures.join('; ')} (${summary})`)
  }
  console.log(`OK (${summary})`)
  }
}

