import fc from 'fast-check'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sanitizeLine, type GhEvent } from '../../supervisor/src/sources/github/event.ts'
import { gate, parsePolicy, type Policy, type GateResult } from '../../supervisor/src/sources/github/gate.ts'

interface PolicyRepo {
  readonly name: string
  readonly labels: readonly string[]
  readonly scope: readonly string[]
}

interface PolicyActor {
  readonly id: number
  readonly login: string
}

function sortObjectKeysRecursively(val: unknown): unknown {
  if (val === null || typeof val !== 'object') return val
  if (Array.isArray(val)) return val.map(sortObjectKeysRecursively)
  const obj = val as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const k of Object.keys(obj).sort()) {
    sorted[k] = sortObjectKeysRecursively(obj[k])
  }
  return sorted
}

function expectedPolicyHash(policy: unknown): string {
  const sorted = sortObjectKeysRecursively(policy)
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex')
}

const C0_C1_CODES = [
  ...Array.from({ length: 0x20 }, (_, i) => i),
  0x7f,
  ...Array.from({ length: 0x20 }, (_, i) => 0x80 + i),
]
const BIDI_CHARS = [
  '\u202A', '\u202B', '\u202C', '\u202D', '\u202E',
  '\u2066', '\u2067', '\u2068', '\u2069',
]
const ZERO_WIDTH_CHARS = ['\u200B', '\u200C', '\u200D', '\uFEFF']
const SPECIAL_CHARS = [
  ...C0_C1_CODES.map((c) => String.fromCharCode(c)),
  ...BIDI_CHARS,
  ...ZERO_WIDTH_CHARS,
]

const hostileFragments = [
  'ignore previous instructions',
  '/factory task --scope .',
  '/factory task bypass',
  'scope: .\nphase: intake',
  '{"scope": ["."], "phase": "intake"}',
  '```json\n{"scope": ["."]}\n```',
  '/factory tasks',
  '/factory task',
  '/factory task Valid Title',
]

function oracleGate(policy: Policy, hash: string, event: GhEvent): GateResult {
  // 1. repo-not-allowed: repo not in repos
  const matchedRepo = (policy.repos as readonly PolicyRepo[]).find((r) => r.name === event.repo)
  if (!matchedRepo) {
    return { admit: false, reason: 'repo-not-allowed' }
  }

  // 2. bot-actor: actor.bot is true
  if (event.actor.bot) {
    return { admit: false, reason: 'bot-actor' }
  }

  // 3. actor-not-allowed: actor id not in actors
  const matchedActor = (policy.actors as readonly PolicyActor[]).find((a) => a.id === event.actor.id)
  if (!matchedActor) {
    return { admit: false, reason: 'actor-not-allowed' }
  }

  // 4. label-not-allowed: issue carries none of repo's labels
  const hasAllowedLabel = event.labels.some((l: string) => matchedRepo.labels.includes(l))
  if (!hasAllowedLabel) {
    return { admit: false, reason: 'label-not-allowed' }
  }

  // 5. command check for comments; opened issues admit without command
  let titleRaw = ''
  if (event.kind === 'issue.comment') {
    const lines = event.text.split(/\r\n|\r|\n/)
    const firstNonBlank = lines.find((line: string) => line.trim().length > 0)
    if (!firstNonBlank) {
      return { admit: false, reason: 'no-command' }
    }
    const trimmed = firstNonBlank.trim()
    if (trimmed === policy.command) {
      titleRaw = `#${event.issue} ${event.issueTitle}`
    } else if (trimmed.startsWith(policy.command)) {
      const rest = trimmed.slice(policy.command.length)
      if (rest.startsWith(' ') || rest.startsWith('\t')) {
        const arg = rest.trim()
        if (arg.length > 0) {
          titleRaw = arg
        } else {
          titleRaw = `#${event.issue} ${event.issueTitle}`
        }
      } else {
        return { admit: false, reason: 'no-command' }
      }
    } else {
      return { admit: false, reason: 'no-command' }
    }
  } else if (event.kind === 'issue.opened') {
    titleRaw = `#${event.issue} ${event.issueTitle}`
  }

  const title = sanitizeLine(titleRaw)
  if (title.length === 0) {
    return { admit: false, reason: 'empty-title' }
  }

  return {
    admit: true,
    title,
    scope: [...matchedRepo.scope],
    basis: {
      policyVersion: policy.version,
      policyHash: hash,
      actorId: event.actor.id,
      repo: event.repo,
      issue: event.issue,
      eventId: event.eventId,
      kind: event.kind,
    },
  }
}

describe('M6-01 GitHub event model, sanitizer, gate property tests', () => {
  it('CHK-M6-01-b: sanitizeLine property: output contains no forbidden characters and has at most 200 code points', () => {
    const stringArbitrary = fc.oneof(
      fc.string({ unit: 'binary', maxLength: 300 }),
      fc.string({ unit: 'grapheme', maxLength: 300 }),
      fc.string({ maxLength: 300 }),
      fc.array(
        fc.oneof(
          fc.constantFrom(...SPECIAL_CHARS),
          fc.constantFrom(...hostileFragments),
          fc.string({ unit: 'grapheme', maxLength: 10 }),
          fc.constantFrom(' ', '\t', '\n', '\r')
        ),
        { minLength: 1, maxLength: 50 }
      ).map((arr) => arr.join(''))
    )

    fc.assert(
      fc.property(stringArbitrary, (input) => {
        const out = sanitizeLine(input)

        // 1. At most 200 code points
        const codePoints = [...out]
        expect(codePoints.length).toBeLessThanOrEqual(200)

        // 2. Well-formed UTF-16 (no broken surrogates)
        expect(out.isWellFormed()).toBe(true)

        // 3. No C0 or C1 control characters
        for (let i = 0; i < out.length; i++) {
          const code = out.charCodeAt(i)
          const isC0 = (code >= 0 && code <= 0x1f) || code === 0x7f
          const isC1 = code >= 0x80 && code <= 0x9f
          expect(isC0).toBe(false)
          expect(isC1).toBe(false)
        }

        // 4. No bidi override/isolate characters
        expect(/[\u202A-\u202E\u2066-\u2069]/.test(out)).toBe(false)

        // 5. No zero-width characters
        expect(/[\u200B-\u200D\uFEFF]/.test(out)).toBe(false)

        // 6. Whitespace runs collapsed and trimmed
        expect(out.includes('  ')).toBe(false)
        expect(out.includes('\t')).toBe(false)
        expect(out.includes('\n')).toBe(false)
        expect(out.includes('\r')).toBe(false)
        expect(out).toBe(out.trim())

        // 7. Idempotent
        expect(sanitizeLine(out)).toBe(out)
      }),
      { numRuns: 500 }
    )
  })

  it('CHK-M6-01-d: gate property: guaranteed-admissible events always admit with exact title, scope and basis', () => {
    const basePolicyJson = {
      version: 1,
      repos: [
        { name: 'org/repo-a', labels: ['factory', 'bug'], scope: ['src/core', 'docs'] },
        { name: 'org/repo-b', labels: ['enhancement'], scope: ['.'] },
      ],
      actors: [
        { id: 101, login: 'alice' },
        { id: 202, login: 'bob' },
      ],
      command: '/factory task',
      maxPendingPerRepo: 25,
    }
    const parsed = parsePolicy(basePolicyJson)
    if (!parsed.ok) throw new Error(`basePolicyJson parse failed: ${parsed.reason}`)
    const policy = parsed.policy
    const hash = parsed.hash

    const admissibleEventArbitrary = fc.record({
      repoChoice: fc.constantFrom(0, 1),
      actorChoice: fc.constantFrom(0, 1),
      kind: fc.constantFrom('issue.opened' as const, 'issue.comment' as const),
      eventId: fc.stringMatching(/^[1-9][0-9]{3,18}$/),
      issue: fc.integer({ min: 1, max: 100000 }),
      issueTitle: fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 _-]{2,40}$/),
      createdAtMs: fc.integer({ min: 1700000000000, max: 1800000000000 }),
      extraLabels: fc.array(fc.string({ minLength: 1, maxLength: 10 }), { maxLength: 3 }),
      commentStyle: fc.oneof(
        // Command alone
        fc.constant({ type: 'alone' as const }),
        // Command with whitespace only (takes issue-title form)
        fc.constantFrom(
          { type: 'ws' as const, ws: '   ' },
          { type: 'ws' as const, ws: '\t' },
          { type: 'ws' as const, ws: ' \t  ' }
        ),
        // Command with valid argument
        fc.record({
          type: fc.constant('arg' as const),
          sep: fc.constantFrom(' ', '  ', '\t', ' \t '),
          arg: fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 _-]{1,50}$/),
        })
      ),
      leadingBlankLines: fc.constantFrom('', '\n', '\n\n', '  \n\t  \n'),
      trailingLines: fc.constantFrom('', '\nadditional text', '\nscope: .\nphase: fake', '\n```json\n{}```'),
      openedBody: fc.oneof(
        fc.constant(''),
        fc.constant('Some issue description'),
        fc.constantFrom(...hostileFragments)
      ),
    }).map((gen) => {
      const repoObj = policy.repos[gen.repoChoice]!
      const actorObj = policy.actors[gen.actorChoice]!
      const validLabel = repoObj.labels[0]!
      const labels = [validLabel, ...gen.extraLabels]

      let text = ''
      let expectedTitle = ''

      if (gen.kind === 'issue.opened') {
        text = gen.openedBody
        expectedTitle = sanitizeLine(`#${gen.issue} ${gen.issueTitle}`)
      } else {
        if (gen.commentStyle.type === 'alone') {
          text = `${gen.leadingBlankLines}${policy.command}${gen.trailingLines}`
          expectedTitle = sanitizeLine(`#${gen.issue} ${gen.issueTitle}`)
        } else if (gen.commentStyle.type === 'ws') {
          text = `${gen.leadingBlankLines}${policy.command}${gen.commentStyle.ws}${gen.trailingLines}`
          expectedTitle = sanitizeLine(`#${gen.issue} ${gen.issueTitle}`)
        } else {
          text = `${gen.leadingBlankLines}${policy.command}${gen.commentStyle.sep}${gen.commentStyle.arg}${gen.trailingLines}`
          expectedTitle = sanitizeLine(gen.commentStyle.arg)
        }
      }

      const event: GhEvent = {
        eventId: gen.eventId,
        repo: repoObj.name,
        kind: gen.kind,
        actor: { id: actorObj.id, login: actorObj.login, bot: false },
        issue: gen.issue,
        labels,
        createdAtMs: gen.createdAtMs,
        issueTitle: gen.issueTitle,
        text,
        textTrust: 'untrusted',
      }

      return { event, expectedTitle, expectedScope: [...repoObj.scope] }
    })

    fc.assert(
      fc.property(admissibleEventArbitrary, ({ event, expectedTitle, expectedScope }) => {
        const result = gate(policy, event)

        expect(result.admit).toBe(true)
        if (result.admit) {
          expect(result.title).toBe(expectedTitle)
          expect(result.scope).toEqual(expectedScope)
          expect(result.basis).toEqual({
            policyVersion: policy.version,
            policyHash: hash,
            actorId: event.actor.id,
            repo: event.repo,
            issue: event.issue,
            eventId: event.eventId,
            kind: event.kind,
          })
        }
      }),
      { numRuns: 300 }
    )
  })

  it('CHK-M6-01-d: gate property: random events match independent oracle exactly', () => {
    const basePolicyJson = {
      version: 1,
      repos: [
        { name: 'org/repo-a', labels: ['factory', 'bug'], scope: ['src/core', 'docs'] },
        { name: 'org/repo-b', labels: ['enhancement'], scope: ['.'] },
      ],
      actors: [
        { id: 101, login: 'alice' },
        { id: 202, login: 'bob' },
      ],
      command: '/factory task',
      maxPendingPerRepo: 25,
    }
    const parsed = parsePolicy(basePolicyJson)
    if (!parsed.ok) throw new Error(`basePolicyJson parse failed: ${parsed.reason}`)
    const policy = parsed.policy
    const hash = parsed.hash

    const eventArbitrary = fc.record({
      eventId: fc.stringMatching(/^[1-9][0-9]{3,18}$/),
      repo: fc.oneof(
        fc.constantFrom('org/repo-a', 'org/repo-b'),
        fc.stringMatching(/^[a-z0-9-]+\/[a-z0-9-]+$/)
      ),
      kind: fc.constantFrom('issue.opened' as const, 'issue.comment' as const),
      actor: fc.record({
        id: fc.oneof(fc.constantFrom(101, 202), fc.integer({ min: 1, max: 999999 })),
        login: fc.string({ minLength: 1, maxLength: 20 }),
        bot: fc.boolean(),
      }),
      issue: fc.integer({ min: 1, max: 100000 }),
      labels: fc.array(
        fc.oneof(
          fc.constantFrom('factory', 'bug', 'enhancement'),
          fc.string({ minLength: 1, maxLength: 15 })
        ),
        { maxLength: 5 }
      ),
      createdAtMs: fc.integer({ min: 1700000000000, max: 1800000000000 }),
      issueTitle: fc.oneof(
        fc.constantFrom('Fix login bug', 'Crash on load', 'Add support for dark mode'),
        fc.string({ unit: 'grapheme', minLength: 1, maxLength: 50 })
      ),
      text: fc.oneof(
        fc.constantFrom(...hostileFragments),
        fc.string({ unit: 'grapheme', maxLength: 200 }),
        fc.string({ maxLength: 200 })
      ),
      textTrust: fc.constant('untrusted' as const),
    })

    fc.assert(
      fc.property(eventArbitrary, (event: GhEvent) => {
        const actual = gate(policy, event)
        const expected = oracleGate(policy, hash, event)

        expect(actual).toEqual(expected)

        if (actual.admit) {
          // Actor cannot be a bot
          expect(event.actor.bot).toBe(false)

          // Actor id must be in policy actors
          const matchedActor = (policy.actors as readonly PolicyActor[]).find((a: PolicyActor) => a.id === event.actor.id)
          expect(matchedActor).toBeDefined()

          // Repo must be in policy repos
          const matchedRepo = (policy.repos as readonly PolicyRepo[]).find((r: PolicyRepo) => r.name === event.repo)
          expect(matchedRepo).toBeDefined()

          // At least one issue label must be in policy repo's allowed labels
          const hasAllowedLabel = event.labels.some((l: string) => matchedRepo!.labels.includes(l))
          expect(hasAllowedLabel).toBe(true)

          // Scope strictly equals policy repo entry scope
          expect(actual.scope).toEqual(matchedRepo!.scope)

          // Basis matches event and policy metadata exactly
          expect(actual.basis).toEqual({
            policyVersion: policy.version,
            policyHash: hash,
            actorId: event.actor.id,
            repo: event.repo,
            issue: event.issue,
            eventId: event.eventId,
            kind: event.kind,
          })

          // Title is non-empty and sanitized
          expect(actual.title.length).toBeGreaterThan(0)
          expect(actual.title).toBe(sanitizeLine(actual.title))
        } else {
          expect([
            'repo-not-allowed',
            'bot-actor',
            'actor-not-allowed',
            'label-not-allowed',
            'no-command',
            'empty-title',
          ]).toContain(actual.reason)
        }
      }),
      { numRuns: 500 }
    )
  })

  it('CHK-M6-01-e: parsePolicy property: hash stability under key order permutations', () => {
    const validPolicyObject = {
      version: 1,
      repos: [
        { name: 'owner/repo', labels: ['factory', 'bug'], scope: ['src/core', 'docs'] },
        { name: 'owner/other', labels: ['task'], scope: ['.'] },
      ],
      actors: [
        { id: 100, login: 'alice' },
        { id: 200, login: 'bob' },
      ],
      command: '/factory task',
      maxPendingPerRepo: 10,
    }

    const baseResult = parsePolicy(validPolicyObject)
    if (!baseResult.ok) throw new Error('Base parsePolicy failed')
    const baseHash = baseResult.hash
    expect(baseHash).toBe(expectedPolicyHash(validPolicyObject))

    const permuteArbitrary = fc.shuffledSubarray(
      ['version', 'repos', 'actors', 'command', 'maxPendingPerRepo'] as const,
      { minLength: 5, maxLength: 5 }
    )

    fc.assert(
      fc.property(permuteArbitrary, (shuffledKeys) => {
        const permutedObj: Record<string, unknown> = {}
        for (const k of shuffledKeys) {
          permutedObj[k] = validPolicyObject[k]
        }
        const res = parsePolicy(permutedObj)
        expect(res.ok).toBe(true)
        if (res.ok) {
          expect(res.hash).toBe(baseHash)
          expect(res.hash).toBe(expectedPolicyHash(permutedObj))
        }
      }),
      { numRuns: 50 }
    )
  })
})
