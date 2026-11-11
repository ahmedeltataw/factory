import { describe, expect, it } from 'vitest'
import { parseDeps, planDispatch } from '../../supervisor/src/core/graph.ts'

type Phase = 'intake' | 'development' | 'qa' | 'devops' | 'handover'
type Status = 'ready' | 'progress' | 'blocked' | 'failed' | 'done' | 'dropped'
type Task = { id: string; status: Status; phase: Phase; deps: string[]; scope: string[]; notBeforeMs: number }
const phases: { name: Phase; status: 'open' | 'locked' }[] = [
  { name: 'intake', status: 'open' }, { name: 'development', status: 'locked' },
  { name: 'qa', status: 'locked' }, { name: 'devops', status: 'locked' }, { name: 'handover', status: 'locked' },
]
const task = (id: string, overrides: Partial<Task> = {}): Task => ({ id, status: 'ready', phase: 'intake', deps: [], scope: [id], notBeforeMs: 0, ...overrides })
const plan = (tasks: Task[]) => planDispatch({ nowMs: 100, phases, tasks })

describe('M5-04 graph core', () => {
  it('CHK-M5-04-a: accepts and normalizes dependency arrays', () => {
    expect(parseDeps([])).toEqual({ ok: true, deps: [] })
    expect(parseDeps(['z', 'A', 'a', 'z', '😀', 'x'.repeat(200)])).toEqual({ ok: true, deps: ['A', 'a', 'x'.repeat(200), 'z', '😀'] })
    expect(parseDeps(Array.from({ length: 32 }, (_, i) => String(i)))).toEqual({ ok: true, deps: Array.from({ length: 32 }, (_, i) => String(i)).sort() })
  })
  it.each([
    ['non-array', null], ['33 entries', Array(33).fill('x')], ['non-string', [1]],
    ['empty', ['']], ['blank', [' \t\n']], ['201 characters', ['x'.repeat(201)]],
    ['lone high surrogate', ['\ud800']], ['lone low surrogate', ['\udc00']],
  ])('CHK-M5-04-a: rejects %s with a reason', (_label, input) => {
    const result = parseDeps(input)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('invalid dependencies accepted')
    expect(result.reason).toEqual(expect.any(String))
    expect(result.reason.length).toBeGreaterThan(0)
  })

  it.each([
    { label: '1 dropped dep precedes phase', tasks: [task('a', { status: 'dropped' }), task('b', { phase: 'qa', deps: ['a'] })], expected: { schedule: [], block: ['b'], wait: [] } },
    { label: '1 blocked dep', tasks: [task('a', { status: 'blocked' }), task('b', { deps: ['a'] })], expected: { schedule: [], block: ['b'], wait: [] } },
    { label: '2 phase before deps', tasks: [task('a', { status: 'failed' }), task('b', { phase: 'qa', deps: ['a'] })], expected: { schedule: [], block: [], wait: [{ id: 'b', reason: 'phase-locked', on: ['qa'] }] } },
    { label: '3 unfinished deps', tasks: [task('a', { status: 'failed' }), task('b', { status: 'done' }), task('c', { status: 'progress' }), task('d', { deps: ['a', 'b', 'c'] })], expected: { schedule: [], block: [], wait: [{ id: 'd', reason: 'deps', on: ['a', 'c'] }] } },
    { label: '4 scope before backoff', tasks: [task('a', { status: 'progress', scope: ['src'] }), task('b', { scope: ['src/a'], notBeforeMs: 101 })], expected: { schedule: [], block: [], wait: [{ id: 'b', reason: 'scope', on: ['a'] }] } },
    { label: '5 backoff', tasks: [task('a', { notBeforeMs: 101 })], expected: { schedule: [], block: [], wait: [{ id: 'a', reason: 'backoff', on: [] }] } },
    { label: '6 schedule at deadline', tasks: [task('a', { notBeforeMs: 100 })], expected: { schedule: ['a'], block: [], wait: [] } },
  ])('CHK-M5-04-b: rule $label', ({ tasks, expected }) => {
    expect(plan(tasks)).toEqual(expected)
  })
  it('CHK-M5-04-b: propagates block through the dispatch-order chain', () => {
    expect(plan([task('a', { status: 'dropped' }), task('b', { deps: ['a'] }), task('c', { deps: ['b'] }), task('d', { deps: ['c'] })])).toEqual({ schedule: [], block: ['b', 'c', 'd'], wait: [] })
  })
  it('CHK-M5-04-b: progress tasks hold scope in any phase', () => {
    expect(plan([task('a', { status: 'progress', phase: 'qa', scope: ['src'] }), task('b', { status: 'progress', phase: 'development', scope: ['src/other'] }), task('c', { scope: ['src'] })])).toEqual({ schedule: [], block: [], wait: [{ id: 'c', reason: 'scope', on: ['a', 'b'] }] })
  })
  it('CHK-M5-04-c: locked root scope and dependency wait do not hold scope', () => {
    expect(plan([task('dep', { status: 'failed' }), task('later', { phase: 'qa', scope: ['.'] }), task('waiting', { deps: ['dep'], scope: ['src'] }), task('open', { scope: ['src'] })])).toEqual({ schedule: ['open'], block: [], wait: [{ id: 'later', reason: 'phase-locked', on: ['qa'] }, { id: 'waiting', reason: 'deps', on: ['dep'] }] })
  })
  it('CHK-M5-04-c: overlapping runnable tasks preserve FIFO including scope waiters and backoff', () => {
    expect(plan([task('a', { scope: ['src/a'], notBeforeMs: 101 }), task('b', { scope: ['src'] }), task('c', { scope: ['src/b'] }), task('d', { scope: ['other'] })])).toEqual({ schedule: ['d'], block: [], wait: [{ id: 'a', reason: 'backoff', on: [] }, { id: 'b', reason: 'scope', on: ['a'] }, { id: 'c', reason: 'scope', on: ['b'] }] })
    expect(plan([task('a', { scope: ['src'] }), task('b', { scope: ['src/a'] })])).toEqual({ schedule: ['a'], block: [], wait: [{ id: 'b', reason: 'scope', on: ['a'] }] })
  })
})
