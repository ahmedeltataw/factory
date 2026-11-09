import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { appendCommand } from '../supervisor/src/app/commands.ts'

it('rejects malformed Unicode in every command string and preserves exact retries', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE commands (id TEXT PRIMARY KEY, project_id TEXT, kind TEXT, payload_json TEXT, created_at TEXT)')
    const command = { id: 'id-😀', projectId: 'project', kind: 'create', payloadJson: '{"name":"😀"}', createdAt: '2026-11-08T00:00:00.000Z' }
    for (const field of Object.keys(command) as Array<keyof typeof command>) {
      expect(() => appendCommand(db, { ...command, [field]: command[field] + '\ud800' })).toThrow('well-formed Unicode')
    }
    expect(appendCommand(db, command)).toBe('created')
    expect(appendCommand(db, command)).toBe('duplicate')
  } finally { db.close() }
})
