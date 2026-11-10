import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import { fencedWrite } from '../../supervisor/src/app/fence.ts'
import { openStore } from '../../supervisor/src/app/store.ts'
import { acquireSupervisor, LeaseLostError, SupervisorLeaseHandle } from '../../supervisor/src/app/supervisor-lease.ts'

const storeUrl = pathToFileURL(join(process.cwd(), 'supervisor/src/app/store.ts')).href
const leaseUrl = pathToFileURL(join(process.cwd(), 'supervisor/src/app/supervisor-lease.ts')).href

const directories: string[] = []
function stateDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'factory-m3-fence-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

describe('M3-01 write fence contract', () => {
  it('CHK-M3-01-d: executes fn inside BEGIN IMMEDIATE and commits writes when lease is active and matches handle', () => {
    const dir = stateDir()
    const path = join(dir, 'state.sqlite')
    const db = openStore(path)
    try {
      const handle = acquireSupervisor(db, dir, { nowMs: 1000, staleAfterMs: 5000 })
      try {
        const result = fencedWrite(db, handle, () => {
          // 1. Verify transaction state inside the callback
          expect(db.isTransaction).toBe(true)

          // 2. Prove another connection cannot acquire the write lock before the callback writes
          const writer2 = new DatabaseSync(path, { timeout: 0 })
          try {
            expect(() => writer2.exec('BEGIN IMMEDIATE')).toThrow(/busy|locked/i)
          } finally {
            writer2.close()
          }

          db.prepare("INSERT INTO projects VALUES ('p1', 'Alpha', '2026-11-10T00:00:00.000Z')").run()
          return 'ok'
        })
        expect(result).toBe('ok')
        expect(db.isTransaction).toBe(false)

        expect(db.prepare('SELECT name FROM projects WHERE id = ?').get('p1')).toMatchObject({ name: 'Alpha' })

        // Check committed and visible to another connection
        const reader = new DatabaseSync(path)
        try {
          expect(reader.prepare('SELECT name FROM projects WHERE id = ?').get('p1')).toMatchObject({ name: 'Alpha' })
        } finally {
          reader.close()
        }

        // 3. Test lease displacement between entry and transaction acquisition
        const origExec = DatabaseSync.prototype.exec
        let displacementInjected = false

        const injectDisplacement = () => {
          if (!displacementInjected) {
            displacementInjected = true
            const displacer = new DatabaseSync(path)
            try {
              origExec.call(displacer, 'UPDATE supervisor_lease SET generation = generation + 1 WHERE id = 1')
            } finally {
              displacer.close()
            }
          }
        }

        DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
          if (/BEGIN\s+IMMEDIATE/i.test(sql)) {
            injectDisplacement()
          }
          return origExec.call(this, sql)
        }

        let callbackRan = false
        try {
          expect(() => {
            fencedWrite(db, handle, () => {
              callbackRan = true
              db.prepare("INSERT INTO projects VALUES ('p-displaced', 'Displaced', '2026-11-10T00:00:00.000Z')").run()
            })
          }).toThrow(LeaseLostError)
        } finally {
          DatabaseSync.prototype.exec = origExec
        }

        expect(displacementInjected, 'displacement hook must fire during transaction begin').toBe(true)
        expect(callbackRan, 'callback must not execute when lease is displaced').toBe(false)
        expect(db.isTransaction).toBe(false)
        expect(db.prepare("SELECT name FROM projects WHERE id = 'p-displaced'").get()).toBeUndefined()
      } finally {
        try {
          handle.release(1100)
        } catch {
          // ignore if already displaced
        }
      }
    } finally {
      db.close()
    }
  })

  it('CHK-M3-01-d: throws LeaseLostError and rolls back changes if generation or owner is mismatched', () => {
    const dir = stateDir()
    const path = join(dir, 'state.sqlite')
    const db = openStore(path)
    try {
      const handle = acquireSupervisor(db, dir, { nowMs: 1000, staleAfterMs: 5000 })
      try {
        // Displace the lease by bumping generation
        db.prepare('UPDATE supervisor_lease SET generation = generation + 1 WHERE id = 1').run()

        expect(() => {
          fencedWrite(db, handle, () => {
            db.prepare("INSERT INTO projects VALUES ('p-fail', 'Fail', '2026-11-10T00:00:00.000Z')").run()
          })
        }).toThrow(LeaseLostError)

        expect(db.prepare("SELECT name FROM projects WHERE id = 'p-fail'").get()).toBeUndefined()
        expect(db.isTransaction).toBe(false)

        // Also test owner mismatch
        db.prepare("UPDATE supervisor_lease SET owner_id = 'displaced-owner', generation = ? WHERE id = 1").run(handle.generation)

        expect(() => {
          fencedWrite(db, handle, () => {
            db.prepare("INSERT INTO projects VALUES ('p-fail2', 'Fail2', '2026-11-10T00:00:00.000Z')").run()
          })
        }).toThrow(LeaseLostError)

        expect(db.prepare("SELECT name FROM projects WHERE id = 'p-fail2'").get()).toBeUndefined()
        expect(db.isTransaction).toBe(false)
      } finally {
        try {
          handle.release(1100)
        } catch {
          // displaced lease release fails as expected
        }
      }
    } finally {
      db.close()
    }
  })

  it('CHK-M3-01-d: throws LeaseLostError and rolls back if lease status is released or row is missing', () => {
    const dir = stateDir()
    const path = join(dir, 'state.sqlite')
    const db = openStore(path)
    try {
      const handle = acquireSupervisor(db, dir, { nowMs: 1000, staleAfterMs: 5000 })
      handle.release(1100)

      expect(() => {
        fencedWrite(db, handle, () => {
          db.prepare("INSERT INTO projects VALUES ('p-released', 'Released', '2026-11-10T00:00:00.000Z')").run()
        })
      }).toThrow(LeaseLostError)

      expect(db.prepare("SELECT name FROM projects WHERE id = 'p-released'").get()).toBeUndefined()
      expect(db.isTransaction).toBe(false)

      // Missing lease row
      db.prepare('DELETE FROM supervisor_lease WHERE id = 1').run()
      expect(() => {
        fencedWrite(db, handle, () => {
          db.prepare("INSERT INTO projects VALUES ('p-missing', 'Missing', '2026-11-10T00:00:00.000Z')").run()
        })
      }).toThrow(LeaseLostError)

      expect(db.prepare("SELECT name FROM projects WHERE id = 'p-missing'").get()).toBeUndefined()
      expect(db.isTransaction).toBe(false)
    } finally {
      db.close()
    }
  })

  it('CHK-M3-01-d: rolls back and rethrows if fn throws an error', () => {
    const dir = stateDir()
    const path = join(dir, 'state.sqlite')
    const db = openStore(path)
    try {
      const handle = acquireSupervisor(db, dir, { nowMs: 1000, staleAfterMs: 5000 })
      try {
        class CustomWriteError extends Error {
          constructor() {
            super('custom write failure')
            this.name = 'CustomWriteError'
          }
        }

        expect(() => {
          fencedWrite(db, handle, () => {
            db.prepare("INSERT INTO projects VALUES ('p-err', 'Error', '2026-11-10T00:00:00.000Z')").run()
            throw new CustomWriteError()
          })
        }).toThrow(CustomWriteError)

        expect(db.prepare("SELECT name FROM projects WHERE id = 'p-err'").get()).toBeUndefined()
        expect(db.isTransaction).toBe(false)

        // Subsequent write with the same held handle still works
        fencedWrite(db, handle, () => {
          db.prepare("INSERT INTO projects VALUES ('p-ok', 'Ok', '2026-11-10T00:00:00.000Z')").run()
        })
        expect(db.prepare("SELECT name FROM projects WHERE id = 'p-ok'").get()).toMatchObject({ name: 'Ok' })
      } finally {
        try {
          handle.release(1200)
        } catch {
          // ignore
        }
      }
    } finally {
      db.close()
    }
  })

  it('CHK-M3-01-d: rejects writes from an older handle after takeover and rolls back', () => {
    const dir = stateDir()
    const path = join(dir, 'state.sqlite')

    // Simulate crashed owner: child process opens store, acquires lease, inserts p1, and exits without calling release
    const scriptPath = join(dir, 'crashed-owner.mjs')
    writeFileSync(
      scriptPath,
      `import { pathToFileURL } from 'node:url'
const { openStore } = await import(process.argv[2])
const { acquireSupervisor } = await import(process.argv[3])
const db = openStore(process.argv[4])
const handle = acquireSupervisor(db, process.argv[5], { nowMs: 1000, staleAfterMs: 500 })
db.prepare("INSERT INTO projects VALUES ('p1', 'Alpha', '2026-11-10T00:00:00.000Z')").run()
process.stdout.write(JSON.stringify({ ownerId: handle.ownerId, generation: handle.generation, heartbeatMs: 1000 }))
process.exit(0)
`,
    )

    const stdout = execFileSync(process.execPath, [scriptPath, storeUrl, leaseUrl, path, dir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const evidence = JSON.parse(stdout.trim()) as { ownerId: string; generation: number; heartbeatMs: number }

    const db = openStore(path)
    let handle2: SupervisorLeaseHandle | undefined
    try {
      expect(db.prepare('SELECT name FROM projects WHERE id = ?').get('p1')).toMatchObject({ name: 'Alpha' })

      // Create old handle object representing the crashed owner's lease
      const oldHandle = Object.create(SupervisorLeaseHandle.prototype, {
        ownerId: { value: evidence.ownerId, enumerable: true },
        generation: { value: evidence.generation, enumerable: true },
      }) as SupervisorLeaseHandle

      // Takeover by a second supervisor after stale threshold (2000 >= 1000 + 500)
      handle2 = acquireSupervisor(db, dir, {
        nowMs: 2000,
        staleAfterMs: 500,
        takeover: {
          ownerId: evidence.ownerId,
          generation: evidence.generation,
          heartbeatMs: evidence.heartbeatMs,
        },
      })
      expect(handle2.generation).toBe(evidence.generation + 1)

      // Old handle write MUST fail with LeaseLostError
      expect(() => {
        fencedWrite(db, oldHandle, () => {
          db.prepare("INSERT INTO projects VALUES ('p-old', 'Old', '2026-11-10T00:00:00.000Z')").run()
        })
      }).toThrow(LeaseLostError)

      expect(db.prepare("SELECT name FROM projects WHERE id = 'p-old'").get()).toBeUndefined()
      expect(db.isTransaction).toBe(false)

      // New handle write succeeds
      fencedWrite(db, handle2, () => {
        db.prepare("INSERT INTO projects VALUES ('p2', 'Beta', '2026-11-10T00:00:00.000Z')").run()
      })

      const rows = db.prepare('SELECT id FROM projects ORDER BY id').all() as Array<{ id: string }>
      expect(rows).toEqual([{ id: 'p1' }, { id: 'p2' }])
    } finally {
      try {
        handle2?.release(2100)
      } catch {
        // ignore
      }
      db.close()
    }
  })

  it(
    'CHK-M3-01-d: property: for random acquire/takeover/write sequences no old-generation write is committed',
    () => {
      type Action =
        | { type: 'write_active'; payload: string }
        | { type: 'write_stale'; handleIndex: number; payload: string }
        | { type: 'heartbeat' }
        | { type: 'release_and_acquire' }
        | { type: 'takeover' }

      const actionArb = fc.oneof(
        fc.record({
          type: fc.constant<'write_active'>('write_active'),
          payload: fc.string({ minLength: 1, maxLength: 8 }),
        }),
        fc.record({
          type: fc.constant<'write_stale'>('write_stale'),
          handleIndex: fc.nat(),
          payload: fc.string({ minLength: 1, maxLength: 8 }),
        }),
        fc.record({
          type: fc.constant<'heartbeat'>('heartbeat'),
        }),
        fc.record({
          type: fc.constant<'release_and_acquire'>('release_and_acquire'),
        }),
        fc.record({
          type: fc.constant<'takeover'>('takeover'),
        }),
      )

      fc.assert(
        fc.property(fc.array(actionArb, { minLength: 5, maxLength: 25 }), (actions) => {
          const testDir = mkdtempSync(join(tmpdir(), 'factory-fence-prop-'))
          let db: DatabaseSync | undefined
          const handlesToRelease: SupervisorLeaseHandle[] = []
          try {
            const dbPath = join(testDir, 'state.sqlite')
            db = openStore(dbPath)
            const store: DatabaseSync = db
            store.exec('CREATE TABLE test_fence_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, generation INTEGER NOT NULL, payload TEXT NOT NULL)')

            const helperScript = join(testDir, 'crashed-owner.mjs')
            writeFileSync(
              helperScript,
              `import { pathToFileURL } from 'node:url'
const { openStore } = await import(process.argv[2])
const { acquireSupervisor } = await import(process.argv[3])
const db = openStore(process.argv[4])
const handle = acquireSupervisor(db, process.argv[5], { nowMs: Number(process.argv[6]), staleAfterMs: Number(process.argv[7]) })
process.stdout.write(JSON.stringify({ ownerId: handle.ownerId, generation: handle.generation, heartbeatMs: Number(process.argv[6]) }))
process.exit(0)
`,
            )

            let clock = 1000
            const staleAfterMs = 200
            let activeHandle: SupervisorLeaseHandle = acquireSupervisor(store, testDir, { nowMs: clock, staleAfterMs })
            handlesToRelease.push(activeHandle)

            const staleHandles: SupervisorLeaseHandle[] = []
            const expectedRows: Array<{ generation: number; payload: string }> = []

            // Initial write commits on generation 1
            const initPayload = `init-${clock}`
            const initRes = fencedWrite(store, activeHandle, () => {
              store.prepare('INSERT INTO test_fence_entries (generation, payload) VALUES (?, ?)').run(activeHandle.generation, initPayload)
              return initPayload
            })
            expect(initRes).toBe(initPayload)
            expectedRows.push({ generation: activeHandle.generation, payload: initPayload })

            for (const action of actions) {
              clock += 20
              if (action.type === 'write_active') {
                const payload = `active-${action.payload}-${clock}`
                const res = fencedWrite(store, activeHandle, () => {
                  store.prepare('INSERT INTO test_fence_entries (generation, payload) VALUES (?, ?)').run(activeHandle.generation, payload)
                  return payload
                })
                expect(res).toBe(payload)
                expectedRows.push({ generation: activeHandle.generation, payload })
              } else if (action.type === 'write_stale') {
                if (staleHandles.length > 0) {
                  const stale = staleHandles[action.handleIndex % staleHandles.length]!
                  const payload = `stale-${action.payload}-${clock}`
                  expect(() => {
                    fencedWrite(store, stale, () => {
                      store.prepare('INSERT INTO test_fence_entries (generation, payload) VALUES (?, ?)').run(stale.generation, payload)
                      return payload
                    })
                  }).toThrow(LeaseLostError)
                  expect(store.prepare('SELECT 1 FROM test_fence_entries WHERE payload = ?').get(payload)).toBeUndefined()
                }
              } else if (action.type === 'heartbeat') {
                activeHandle.heartbeat(clock)
              } else if (action.type === 'release_and_acquire') {
                activeHandle.release(clock)
                staleHandles.push(activeHandle)
                clock += 20
                activeHandle = acquireSupervisor(store, testDir, { nowMs: clock, staleAfterMs })
                handlesToRelease.push(activeHandle)
              } else if (action.type === 'takeover') {
                // Free OS lock from parent so child process can acquire and crash
                activeHandle.release(clock)
                staleHandles.push(activeHandle)
                clock += 20

                const stdout = execFileSync(
                  process.execPath,
                  [helperScript, storeUrl, leaseUrl, dbPath, testDir, String(clock), String(staleAfterMs)],
                  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
                )
                const evidence = JSON.parse(stdout.trim()) as { ownerId: string; generation: number; heartbeatMs: number }
                const crashedStaleHandle = Object.create(SupervisorLeaseHandle.prototype, {
                  ownerId: { value: evidence.ownerId, enumerable: true },
                  generation: { value: evidence.generation, enumerable: true },
                }) as SupervisorLeaseHandle
                staleHandles.push(crashedStaleHandle)

                // Advance clock beyond staleAfterMs window
                clock += staleAfterMs + 50
                activeHandle = acquireSupervisor(store, testDir, {
                  nowMs: clock,
                  staleAfterMs,
                  takeover: evidence,
                })
                handlesToRelease.push(activeHandle)
              }
            }

            // Invariant: persisted rows must strictly match independent expected model
            const actualRows = store
              .prepare('SELECT generation, payload FROM test_fence_entries ORDER BY id ASC')
              .all() as Array<{ generation: number; payload: string }>
            expect(actualRows).toEqual(expectedRows)
          } finally {
            for (const h of handlesToRelease) {
              try {
                h.release(1_000_000)
              } catch {
                // ignore
              }
            }
            if (db) {
              try {
                db.close()
              } catch {
                // ignore
              }
            }
            try {
              rmSync(testDir, { recursive: true, force: true })
            } catch {
              // ignore
            }
          }
        }),
        { numRuns: 50 },
      )
    },
    180000,
  )
})
