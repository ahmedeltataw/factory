import { z } from 'zod'

export interface GhEvent {
  eventId: string
  repo: string
  kind: 'issue.opened' | 'issue.comment'
  actor: { id: number; login: string; bot: boolean }
  issue: number
  labels: string[]
  createdAtMs: number
  issueTitle: string
  text: string
  textTrust: 'untrusted'
}

const text = z.string().refine((value) => value.isWellFormed())
const issue = z.object({
  number: z.number().int().positive(),
  title: text,
  body: text.nullish(),
  labels: z.array(z.object({ name: text })),
})
const eventSchema = z.object({
  id: z.string().regex(/^\d+$/),
  actor: z.object({ id: z.number().int().positive(), login: text, type: text }),
  repo: z.object({ name: text.regex(/^[^/]+\/[^/]+$/) }),
  payload: z.object({ action: z.string(), issue, comment: z.object({ body: text.nullish() }).optional() }),
  created_at: z.string().refine((value) => Number.isFinite(Date.parse(value))),
})

export function normalizeEvent(raw: unknown): { ok: true; event: GhEvent } | { ok: false; reason: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'malformed' }
  const value = raw as Record<string, unknown>
  if (typeof value.type !== 'string') return { ok: false, reason: 'malformed' }
  if (value.type !== 'IssuesEvent' && value.type !== 'IssueCommentEvent') return { ok: false, reason: 'unsupported-event' }
  const payload = value.payload
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, reason: 'malformed' }
  const data = payload as Record<string, unknown>
  if (typeof data.action !== 'string') return { ok: false, reason: 'malformed' }
  if ((value.type === 'IssuesEvent' && data.action !== 'opened') || (value.type === 'IssueCommentEvent' && data.action !== 'created')) {
    return { ok: false, reason: 'unsupported-event' }
  }
  if (data.issue !== null && typeof data.issue === 'object' && 'pull_request' in data.issue) {
    return { ok: false, reason: 'unsupported-event' }
  }
  const parsed = eventSchema.safeParse(raw)
  if (!parsed.success || (value.type === 'IssueCommentEvent' && !parsed.data.payload.comment)) return { ok: false, reason: 'malformed' }
  const source = parsed.data
  const body = value.type === 'IssuesEvent' ? source.payload.issue.body : source.payload.comment?.body
  let clipped = (body ?? '').slice(0, 8000)
  if (!clipped.isWellFormed()) clipped = clipped.slice(0, -1)
  return { ok: true, event: {
    eventId: source.id,
    repo: source.repo.name.toLowerCase(),
    kind: value.type === 'IssuesEvent' ? 'issue.opened' : 'issue.comment',
    actor: { id: source.actor.id, login: source.actor.login, bot: source.actor.type === 'Bot' || source.actor.login.endsWith('[bot]') },
    issue: source.payload.issue.number,
    labels: source.payload.issue.labels.map((label) => label.name).sort(),
    createdAtMs: Date.parse(source.created_at),
    issueTitle: source.payload.issue.title,
    text: clipped,
    textTrust: 'untrusted',
  } }
}

export function sanitizeLine(input: string): string {
  const cleaned = input.toWellFormed().replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u200b-\u200d\ufeff]/g, '').replace(/\s+/gu, ' ').trim()
  return Array.from(cleaned).slice(0, 200).join('').trim()
}
