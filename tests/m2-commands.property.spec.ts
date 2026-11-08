import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { appendCommand, CommandConflictError } from '../supervisor/src/app/commands.ts'
import type { Command } from '../supervisor/src/app/commands.ts'
import { openStore } from '../supervisor/src/app/store.ts'

const directories: string[] = []
function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'factory-m2-commands-property-'))
  directories.push(directory)
  return join(directory, 'state.sqlite')
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

type Row = {
  id: string
  project_id: string
  kind: string
  payload_json: string
  created_at: string
}

// generated IDs and kinds stay printable, non-blank ASCII so zod and the
// schema CHECK constraints agree on what is valid
const token = fc
  .string({ minLength: 1, maxLength: 12, unit: 'grapheme-ascii' })
  .filter((value) => value.trim().length > 0 && !value.includes('\x00'))

// bounded real timestamps; toISOString always yields the exact UTC form
const createdAt = fc
  .nat({ max: 4_102_444_799_999 }) // up to 2099-12-31T23:59:59.999Z
  .map((milliseconds) => new Date(milliseconds).toISOString())

// fixed valid UTC project timestamp; commands[0] is rejected under
// noUncheckedIndexedAccess, so do not index into the generated array
const projectCreatedAt = '2024-06-15T12:00:00.000Z'

describe('M2-02 command property (CHK-M2-02-b, CHK-M2-02-c)', () => {
  it('appends each generated command once, flags exact retries as duplicates, rejects conflicting payloads and keeps rows immutable across reopen', () => {
    try {
      fc.assert(
        fc.property(
          fc.record({
            projectId: token,
            commands: fc.uniqueArray(
              fc.record({
                id: token,
                kind: token,
                payloadJson: fc.json(),
                createdAt,
              }),
              { minLength: 1, maxLength: 4, selector: (command: { id: string }) => command.id },
            ),
          }),
          ({ projectId, commands }) => {
            const path = databasePath()
            const expected = commands
              .map((command) => ({
                id: command.id,
                project_id: projectId,
                kind: command.kind,
                payload_json: command.payloadJson,
                created_at: command.createdAt,
              }))
              .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

            const db = openStore(path)
            let reopened: DatabaseSync | undefined
            try {
              db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(
                projectId,
                projectId,
                projectCreatedAt,
              )

              for (const generated of commands) {
                const command: Command = {
                  id: generated.id,
                  projectId,
                  kind: generated.kind,
                  payloadJson: generated.payloadJson,
                  createdAt: generated.createdAt,
                }
                expect(appendCommand(db, command)).toBe('created')
                expect(appendCommand(db, command)).toBe('duplicate')
                // valid JSON text that can never equal the stored payload,
                // so the conflict is triggered by content alone
                expect(() =>
                  appendCommand(db, { ...command, payloadJson: `${command.payloadJson} ` }),
                ).toThrow(CommandConflictError)
              }

              reopened = openStore(path)
              const rows = reopened
                .prepare('SELECT id, project_id, kind, payload_json, created_at FROM commands ORDER BY id')
                .all() as Row[]
              expect(rows).toEqual(expected)
              expect(reopened.prepare('SELECT COUNT(*) AS count FROM commands').get()).toMatchObject({
                count: commands.length,
              })
            } finally {
              if (reopened !== undefined) reopened.close()
              db.close()
            }
          },
        ),
        { numRuns: 15 },
      )
    } finally {
      for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
    }
  })
})
