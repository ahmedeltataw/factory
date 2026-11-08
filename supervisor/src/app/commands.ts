import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

export interface Command {
  readonly id: string
  readonly projectId: string
  readonly kind: string
  readonly payloadJson: string
  readonly createdAt: string
}

export type AppendCommandResult = 'created' | 'duplicate'

export class CommandConflictError extends Error {
  constructor(id: string) {
    super(`command ${id} already exists with different data`)
    this.name = 'CommandConflictError'
  }
}

const nonblank = z.string().refine(
  (value) => value.trim().length > 0,
  'must not be blank',
)
const exactUtcTimestamp = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
  const date = new Date(value)
  return !Number.isNaN(date.getTime()) && date.toISOString() === value
}, 'must be an exact ISO-8601 UTC timestamp')
const jsonText = z.string().refine((value) => {
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}, 'must be valid JSON text')

const commandSchema = z.object({
  id: nonblank,
  projectId: nonblank,
  kind: nonblank,
  payloadJson: jsonText,
  createdAt: exactUtcTimestamp,
})

interface StoredCommand {
  id: string
  project_id: string
  kind: string
  payload_json: string
  created_at: string
}

/**
 * Append a command record, returning `'created'` for a new ID and `'duplicate'`
 * when the stored row matches the whole input exactly. The caller owns any
 * surrounding transaction; this function never begins, commits or rolls back one.
 */
export function appendCommand(db: DatabaseSync, input: Command): AppendCommandResult {
  const command = commandSchema.parse(input)
  const inserted = db
    .prepare('INSERT OR IGNORE INTO commands (id, project_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(command.id, command.projectId, command.kind, command.payloadJson, command.createdAt)
  if (Number(inserted.changes) > 0) return 'created'

  const row = db
    .prepare('SELECT id, project_id, kind, payload_json, created_at FROM commands WHERE id = ?')
    .get(command.id) as StoredCommand | undefined
  if (row === undefined) throw new Error('command insert was ignored without an existing row')
  if (
    row.id !== command.id ||
    row.project_id !== command.projectId ||
    row.kind !== command.kind ||
    row.payload_json !== command.payloadJson ||
    row.created_at !== command.createdAt
  ) {
    throw new CommandConflictError(command.id)
  }
  return 'duplicate'
}
