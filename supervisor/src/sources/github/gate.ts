import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parseScope } from '../../core/scope.ts'
import { sanitizeLine, type GhEvent } from './event.ts'

export interface Policy {
  readonly version: 1
  readonly repos: readonly { readonly name: string; readonly labels: readonly string[]; readonly scope: readonly string[] }[]
  readonly actors: readonly { readonly id: number; readonly login: string }[]
  readonly command: string
  readonly maxPendingPerRepo: number
}

export type GateResult =
  | { admit: false; reason: string }
  | { admit: true; title: string; scope: string[]; basis: { policyVersion: number; policyHash: string; actorId: number; repo: string; issue: number; eventId: string; kind: GhEvent['kind'] } }

const repoSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/),
  labels: z.array(z.string()),
  scope: z.array(z.string()).refine((value) => parseScope(value).ok),
})
const fields = {
  version: z.literal(1),
  repos: z.array(repoSchema).min(1).refine((repos) => new Set(repos.map((repo) => repo.name)).size === repos.length),
  actors: z.array(z.strictObject({ id: z.number().int().positive(), login: z.string() })).min(1),
  command: z.string().startsWith('/'),
  maxPendingPerRepo: z.number().int().min(1).max(100),
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sorted(item)]))
  }
  return value
}

function policyHash(policy: Policy): string {
  return createHash('sha256').update(JSON.stringify(sorted(policy))).digest('hex')
}

export function parsePolicy(input: unknown): { ok: true; policy: Policy; hash: string } | { ok: false; reason: string } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: 'policy' }
  const object = input as Record<string, unknown>
  for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
    const result = fields[key].safeParse(object[key])
    if (!result.success) {
      const issue = result.error.issues[0]!
      const path = [key, ...issue.path.map(String)]
      if (issue.code === 'unrecognized_keys') path.push(issue.keys[0]!)
      return { ok: false, reason: path.join('.') }
    }
  }
  const unknown = Object.keys(object).find((key) => !Object.hasOwn(fields, key))
  if (unknown !== undefined) return { ok: false, reason: unknown }
  const policy = z.object(fields).parse(object)
  for (const repo of policy.repos) {
    Object.freeze(repo.labels)
    Object.freeze(repo.scope)
    Object.freeze(repo)
  }
  for (const actor of policy.actors) Object.freeze(actor)
  Object.freeze(policy.repos)
  Object.freeze(policy.actors)
  Object.freeze(policy)
  return { ok: true, policy, hash: policyHash(policy) }
}

export function gate(policy: Policy, event: GhEvent): GateResult {
  const repo = policy.repos.find((entry) => entry.name === event.repo)
  if (!repo) return { admit: false, reason: 'repo-not-allowed' }
  if (event.actor.bot) return { admit: false, reason: 'bot-actor' }
  if (!policy.actors.some((actor) => actor.id === event.actor.id)) return { admit: false, reason: 'actor-not-allowed' }
  if (!event.labels.some((label) => repo.labels.includes(label))) return { admit: false, reason: 'label-not-allowed' }

  let title = `#${event.issue} ${event.issueTitle}`
  if (event.kind === 'issue.comment') {
    const line = event.text.split(/\r\n|\r|\n/).find((item) => item.trim().length > 0)?.trim()
    if (!line || (line !== policy.command && !(line.startsWith(policy.command) && /^[ \t]/.test(line.slice(policy.command.length))))) {
      return { admit: false, reason: 'no-command' }
    }
    const argument = line.slice(policy.command.length).trim()
    if (argument) title = argument
  }
  title = sanitizeLine(title)
  if (!title) return { admit: false, reason: 'empty-title' }
  return { admit: true, title, scope: [...repo.scope], basis: {
    policyVersion: policy.version, policyHash: policyHash(policy), actorId: event.actor.id,
    repo: event.repo, issue: event.issue, eventId: event.eventId, kind: event.kind,
  } }
}

