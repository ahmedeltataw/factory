import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateCardMetadata, type CardMetadata } from './schemas.ts'

export const CORE_CARD_MAX_LINES = 80 as const

export const CORE_CARD_ROLES = [
  'builder-ui',
  'builder-logic',
  'reviewer',
  'qa',
  'ops',
  'writer',
  'lead',
] as const

export type CoreCardRole = (typeof CORE_CARD_ROLES)[number]

export type CardLayer = CardMetadata['layer']

export interface ParsedRoleCard {
  readonly metadata: CardMetadata
  readonly body: string
  readonly rawNormalized: string
  readonly lineCount: number
  readonly sha256: string
}

export type CardValidationResult =
  | { readonly ok: true; readonly card: ParsedRoleCard }
  | { readonly ok: false; readonly errors: readonly string[] }

const PROTECTED_TARGET_SOURCE =
  '(?:tests\\/protected\\/?|docs\\/milestones\\/?|AGENTS\\.md|CLAUDE\\.md|schemas\\/?|\\.factory\\/?|forbidden[\\s_-]+paths?|protected[\\s_-]+(?:paths?|tests?|files?|milestones?))'

const RULE_TARGET_SOURCE =
  '(?:core|factory|policy|veto|gate|verification)[\\s_-]+(?:rules?|restrictions?|policies|veto(?:es)?|gates?|checks?)'

const RELAX_VERB_SOURCE =
  '(?:override|bypass|disable|ignore|weaken|relax|waive|exempt|lift|suspend|remove|circumvent|skip)(?:s|ed|ing)?'

const RELAX_PASSIVE_SOURCE =
  '(?:overridden|bypassed|disabled|ignored|weakened|relaxed|waived|exempted|lifted|suspended|removed|circumvented|skipped)'

const ADDENDUM_OVERRIDE_PATTERNS: readonly RegExp[] = [
  /factory[\s_-]*rules\s*:/i,
  /policy[\s_-]*override\b/i,
  /override[\s_-]*forbidden[\s_-]*paths\b/i,
  new RegExp(
    `(?<!\\b(?:without|never|not|cannot|can't|don't)\\s+)\\b${RELAX_VERB_SOURCE}[\\s_-]+(?:${RULE_TARGET_SOURCE}|forbidden[\\s_-]+paths?|protected[\\s_-]+(?:paths?|tests?|files?|milestones?)|s0|s1)`,
    'i',
  ),
  new RegExp(
    `\\b(?:${RULE_TARGET_SOURCE}|forbidden[\\s_-]+paths?)[^\\n.;]*\\b(?:is|are|may\\s+be|can\\s+be|will\\s+be|become[s]?|made)\\s+${RELAX_PASSIVE_SOURCE}\\b`,
    'i',
  ),
  /\b(?:allow|permit)[\s_-]+forbidden[\s_-]+paths?\b/i,
  new RegExp(
    `\\b(?:allow|permit|may|can|authorized\\s+to|allowed\\s+to|permitted\\s+to)[\\s_-]+(?:modify(?:ing)?|edit(?:ing)?|writ(?:e|ing)|chang(?:e|ing)|touch(?:ing)?|delet(?:e|ing)|overwrit(?:e|ing))(?:[\\s_-]+to)?[\\s_-]+${PROTECTED_TARGET_SOURCE}`,
    'i',
  ),
  new RegExp(
    `(?<![\\w./-])${PROTECTED_TARGET_SOURCE}[^\\n.;]*(?<!\\bnot\\s+)\\bwritable\\b`,
    'i',
  ),
  new RegExp(
    `\\bwritable\\b[^\\n.;]*(?<![\\w./-])${PROTECTED_TARGET_SOURCE}`,
    'i',
  ),
  new RegExp(
    `\\b(?:exceptions?|exempt(?:ions?)?)\\s+(?:to|from)\\s+(?:${RULE_TARGET_SOURCE}|${PROTECTED_TARGET_SOURCE}|core\\b|factory\\b)`,
    'i',
  ),
]

const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/
const SINGLE_LINE_SCALAR_FIELDS = ['card_id', 'role', 'card_version'] as const
const SINGLE_LINE_ARRAY_FIELDS = ['capabilities', 'forbidden_paths'] as const

function normalizeLineEndings(raw: string): string {
  return raw.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
}

function stripInlineComment(value: string): string {
  let inSingle = false
  let inDouble = false
  let escaped = false
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!
    if (escaped) {
      escaped = false
      continue
    }
    if (inDouble && ch === '\\') {
      escaped = true
      continue
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble
      continue
    }
    if (!inDouble && ch === "'") {
      inSingle = !inSingle
      continue
    }
    if (!inSingle && !inDouble && ch === '#' && (i === 0 || /\s/.test(value[i - 1]!))) {
      return value.slice(0, i).trim()
    }
  }
  return value.trim()
}

function parseScalar(rawValue: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = stripInlineComment(rawValue)
  if (trimmed.length === 0) {
    return { ok: true, value: '' }
  }
  if (trimmed.startsWith('"')) {
    if (!trimmed.endsWith('"') || trimmed.length < 2) {
      return { ok: false, error: `Unterminated double-quoted string: ${trimmed}` }
    }
    try {
      return { ok: true, value: JSON.parse(trimmed) }
    } catch {
      return { ok: false, error: `Invalid double-quoted string: ${trimmed}` }
    }
  }
  if (trimmed.startsWith("'")) {
    let out = ''
    let closedAt = -1
    for (let i = 1; i < trimmed.length; i++) {
      const ch = trimmed[i]!
      if (ch === "'") {
        if (trimmed[i + 1] === "'") {
          out += "'"
          i++
          continue
        }
        closedAt = i
        break
      }
      out += ch
    }
    if (closedAt === -1) {
      return { ok: false, error: `Unterminated single-quoted string: ${trimmed}` }
    }
    if (closedAt !== trimmed.length - 1) {
      return { ok: false, error: `Trailing characters after closing quote: ${trimmed}` }
    }
    return { ok: true, value: out }
  }
  if (/[\[\]{}]/.test(trimmed)) {
    return { ok: false, error: `Invalid unquoted bracket or brace in scalar: ${trimmed}` }
  }
  if (trimmed === 'true') return { ok: true, value: true }
  if (trimmed === 'false') return { ok: true, value: false }
  if (trimmed === 'null' || trimmed === '~') return { ok: true, value: null }
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return { ok: true, value: Number(trimmed) }
  return { ok: true, value: trimmed }
}

function splitInlineArrayItems(inner: string): { ok: true; items: string[] } | { ok: false; error: string } {
  const items: string[] = []
  let current = ''
  let inSingle = false
  let inDouble = false
  let escaped = false
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (inDouble && ch === '\\') {
      current += ch
      escaped = true
      continue
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble
      current += ch
      continue
    }
    if (!inDouble && ch === "'") {
      inSingle = !inSingle
      current += ch
      continue
    }
    if (!inSingle && !inDouble && ch === ',') {
      items.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (inSingle || inDouble) {
    return { ok: false, error: `Unterminated quote in inline array: [${inner}]` }
  }
  const last = current.trim()
  if (last.length > 0 || items.length > 0) {
    items.push(last)
  }
  return { ok: true, items }
}

function parseFrontmatterValue(rawValue: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const cleaned = stripInlineComment(rawValue)
  if (cleaned.startsWith('[')) {
    if (!cleaned.endsWith(']')) {
      return { ok: false, error: `Unterminated inline array: ${cleaned}` }
    }
    const inner = cleaned.slice(1, -1).trim()
    if (inner.length === 0) {
      return { ok: true, value: [] }
    }
    const split = splitInlineArrayItems(inner)
    if (!split.ok) return split
    const values: unknown[] = []
    for (const item of split.items) {
      if (item.length === 0) {
        return { ok: false, error: `Empty element in inline array: ${cleaned}` }
      }
      const parsed = parseScalar(item)
      if (!parsed.ok) return parsed
      values.push(parsed.value)
    }
    return { ok: true, value: values }
  }
  return parseScalar(cleaned)
}

function parseYamlFrontmatter(
  lines: readonly string[],
): { ok: true; data: Record<string, unknown> } | { ok: false; errors: string[] } {
  const data: Record<string, unknown> = {}
  const errors: string[] = []

  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      i++
      continue
    }
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (!match) {
      errors.push(`Invalid frontmatter line: ${line}`)
      i++
      continue
    }
    const key = match[1]!
    const rest = match[2]!
    if (Object.hasOwn(data, key)) {
      errors.push(`Duplicate frontmatter key: ${key}`)
    }

    const strippedRest = stripInlineComment(rest)
    if (strippedRest.length === 0) {
      const items: unknown[] = []
      let j = i + 1
      let sawListItem = false
      while (j < lines.length) {
        const nextLine = lines[j]!
        const nextTrimmed = nextLine.trim()
        if (nextTrimmed.length === 0 || nextTrimmed.startsWith('#')) {
          j++
          continue
        }
        const listMatch = /^\s*-\s*(.*)$/.exec(nextLine)
        if (!listMatch) {
          break
        }
        sawListItem = true
        const parsedItem = parseScalar(listMatch[1]!)
        if (!parsedItem.ok) {
          errors.push(parsedItem.error)
        } else {
          items.push(parsedItem.value)
        }
        j++
      }
      data[key] = sawListItem ? items : null
      i = j
      continue
    }

    const parsedValue = parseFrontmatterValue(rest)
    if (!parsedValue.ok) {
      errors.push(parsedValue.error)
    } else {
      data[key] = parsedValue.value
    }
    i++
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, data }
}

function matchesOverrideDirective(text: string): boolean {
  return ADDENDUM_OVERRIDE_PATTERNS.some((pattern) => pattern.test(text))
}

function collectOverrideErrors(frontmatter: Record<string, unknown>, body: string): string[] {
  const errors: string[] = []
  for (const key of Object.keys(frontmatter)) {
    if (matchesOverrideDirective(key) || /^factory[\s_-]*rules$/i.test(key)) {
      errors.push(`Addendum frontmatter key "${key}" attempts to override factory rules`)
    }
  }
  const visitValue = (value: unknown): void => {
    if (typeof value === 'string') {
      if (matchesOverrideDirective(value)) {
        errors.push(`Addendum metadata value attempts to override factory rules`)
      }
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visitValue(item)
      }
    }
  }
  for (const value of Object.values(frontmatter)) {
    visitValue(value)
  }
  if (matchesOverrideDirective(body)) {
    errors.push('Addendum body attempts to override factory rules')
  }
  return errors
}

function collectControlCharErrors(data: Record<string, unknown>): string[] {
  const errors: string[] = []
  for (const key of SINGLE_LINE_SCALAR_FIELDS) {
    const value = data[key]
    if (typeof value === 'string' && CONTROL_CHAR_PATTERN.test(value)) {
      errors.push(`Metadata field "${key}" must not contain line breaks or control characters`)
    }
  }
  for (const key of SINGLE_LINE_ARRAY_FIELDS) {
    const value = data[key]
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && CONTROL_CHAR_PATTERN.test(item)) {
          errors.push(`Metadata field "${key}" entries must not contain line breaks or control characters`)
        }
      }
    }
  }
  return errors
}

export function validateCard(raw: string, expectedLayer?: CardLayer): CardValidationResult {
  const rawNormalized = normalizeLineEndings(raw)
  const lines = rawNormalized.split('\n')

  if (lines[0] !== '---') {
    return { ok: false, errors: ['Missing YAML frontmatter opening delimiter (---)'] }
  }

  let closeIndex = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      closeIndex = i
      break
    }
  }
  if (closeIndex === -1) {
    return { ok: false, errors: ['Missing YAML frontmatter closing delimiter (---)'] }
  }

  const frontmatterLines = lines.slice(1, closeIndex)
  const body = lines.slice(closeIndex + 1).join('\n')
  const lineCount = rawNormalized.replace(/\n$/, '').split('\n').length

  const parsedFm = parseYamlFrontmatter(frontmatterLines)
  if (!parsedFm.ok) {
    return { ok: false, errors: parsedFm.errors }
  }

  const errors: string[] = collectControlCharErrors(parsedFm.data)
  const metaResult = validateCardMetadata(parsedFm.data)
  if (!metaResult.ok) {
    errors.push(...metaResult.errors)
  }

  const layer = metaResult.ok ? metaResult.data.layer : parsedFm.data['layer']
  if (expectedLayer !== undefined && metaResult.ok && metaResult.data.layer !== expectedLayer) {
    errors.push(`Expected card layer "${expectedLayer}", got "${metaResult.data.layer}"`)
  }
  if (metaResult.ok && metaResult.data.layer === 'core' && lineCount > CORE_CARD_MAX_LINES) {
    errors.push(`Core card exceeds maximum of ${CORE_CARD_MAX_LINES} lines (got ${lineCount})`)
  }
  if (layer === 'stack' || layer === 'project' || expectedLayer === 'stack' || expectedLayer === 'project') {
    errors.push(...collectOverrideErrors(parsedFm.data, body))
  }

  if (errors.length > 0 || !metaResult.ok) {
    return { ok: false, errors: Array.from(new Set(errors)) }
  }

  const sha256 = createHash('sha256').update(rawNormalized, 'utf8').digest('hex')
  return {
    ok: true,
    card: {
      metadata: metaResult.data,
      body,
      rawNormalized,
      lineCount,
      sha256,
    },
  }
}

export function parseRoleCard(raw: string): CardValidationResult {
  return validateCard(raw)
}

function resolveDefaultCoreDir(): string {
  const candidates = ['../../../cards/core', '../cards/core', '../../cards/core']
  for (const rel of candidates) {
    const resolved = fileURLToPath(new URL(rel, import.meta.url))
    if (existsSync(resolved)) {
      return resolved
    }
  }
  return path.resolve(process.cwd(), 'cards', 'core')
}

export function loadCoreCard(role: CoreCardRole, coreDir?: string): ParsedRoleCard {
  if (!CORE_CARD_ROLES.includes(role)) {
    throw new Error(`Unknown core card role: ${String(role)}`)
  }
  const dir = coreDir ?? resolveDefaultCoreDir()
  const filePath = path.join(dir, `${role}.md`)
  const raw = readFileSync(filePath, 'utf8')
  const result = validateCard(raw, 'core')
  if (!result.ok) {
    throw new Error(`Invalid core card "${role}": ${result.errors.join('; ')}`)
  }
  if (result.card.metadata.role !== role) {
    throw new Error(`Core card "${role}" has mismatched role "${result.card.metadata.role}"`)
  }
  return result.card
}

export function loadAllCoreCards(coreDir?: string): Record<CoreCardRole, ParsedRoleCard> {
  const cards = {} as Record<CoreCardRole, ParsedRoleCard>
  for (const role of CORE_CARD_ROLES) {
    cards[role] = loadCoreCard(role, coreDir)
  }
  return cards
}
