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

const ADDENDUM_OVERRIDE_PATTERNS: readonly RegExp[] = [
  /factory[\s_-]*rules\s*:/i,
  /policy[\s_-]*override\b/i,
  /override[\s_-]*forbidden[\s_-]*paths\b/i,
  /\b(?:override|bypass|disable|ignore|weaken)[\s_-]+(?:factory[\s_-]+rules|forbidden[\s_-]+paths|policy[\s_-]+veto(?:es)?)\b/i,
  /\b(?:allow|permit)[\s_-]+forbidden[\s_-]+paths\b/i,
]

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
    if (!trimmed.endsWith("'") || trimmed.length < 2) {
      return { ok: false, error: `Unterminated single-quoted string: ${trimmed}` }
    }
    return { ok: true, value: trimmed.slice(1, -1).replaceAll("''", "'") }
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

  const errors: string[] = []
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
