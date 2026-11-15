import { expect, it } from 'vitest'
import { planDispatch, type DispatchTask } from '../../supervisor/src/core/graph.ts'

const task = (id: string, overrides: Partial<DispatchTask> = {}): DispatchTask => ({
  id, status: 'ready', phase: 'intake', deps: [], scope: [id], notBeforeMs: 0, ...overrides,
})
const phases = [{ name: 'intake', status: 'open' }, { name: 'qa', status: 'locked' }]
const plan = (tasks: DispatchTask[], extra: { maxParallel?: number | null; gates?: Record<string, { reason: 'quota' | 'budget'; retryAtMs: number | null }> } = {}) =>
  planDispatch({ nowMs: 100, phases, tasks, ...extra })

it('CHK-M7-02-a: unlimited inputs retain the hard-coded M6 plans', () => {
  const cases = [
    { tasks: [], expected: { schedule: [], block: [], wait: [] } },
    { tasks: [task('a')], expected: { schedule: ['a'], block: [], wait: [] } },
    { tasks: [task('x', { status: 'dropped' }), task('a', { deps: ['x'] })], expected: { schedule: [], block: ['a'], wait: [] } },
    { tasks: [task('a', { phase: 'qa' })], expected: { schedule: [], block: [], wait: [{ id: 'a', reason: 'phase-locked', on: ['qa'] }] } },
    { tasks: [task('x', { status: 'failed' }), task('a', { deps: ['x'] })], expected: { schedule: [], block: [], wait: [{ id: 'a', reason: 'deps', on: ['x'] }] } },
    { tasks: [task('x', { status: 'progress', scope: ['src'] }), task('a', { scope: ['src/a'] })], expected: { schedule: [], block: [], wait: [{ id: 'a', reason: 'scope', on: ['x'] }] } },
    { tasks: [task('a', { notBeforeMs: 101 })], expected: { schedule: [], block: [], wait: [{ id: 'a', reason: 'backoff', on: [] }] } },
    { tasks: [task('a', { scope: ['src'], notBeforeMs: 101 }), task('b', { scope: ['src/b'] })], expected: { schedule: [], block: [], wait: [{ id: 'a', reason: 'backoff', on: [] }, { id: 'b', reason: 'scope', on: ['a'] }] } },
    { tasks: [task('a', { scope: ['src'] }), task('b', { scope: ['src/b'] }), task('c', { scope: ['src/b/c'] })], expected: { schedule: ['a'], block: [], wait: [{ id: 'b', reason: 'scope', on: ['a'] }, { id: 'c', reason: 'scope', on: ['a', 'b'] }] } },
  ]
  for (const { tasks, expected } of cases) {
    expect(plan(tasks)).toEqual(expected)
    expect(plan(tasks, { maxParallel: null, gates: {} })).toEqual(expected)
  }
})

it('CHK-M7-02-b: slots count running and scheduled tasks and preserve wait order', () => {
  const running = task('running', { status: 'progress' })
  expect(plan([running, task('a'), task('b')], { maxParallel: 2 })).toEqual({ schedule: ['a'], block: [], wait: [{ id: 'b', reason: 'slots', on: ['running'] }] })
  expect(plan([running, task('a'), task('b')], { maxParallel: 1 })).toEqual({ schedule: [], block: [], wait: [{ id: 'a', reason: 'slots', on: ['running'] }, { id: 'b', reason: 'slots', on: ['running'] }] })
  expect(plan(['a', 'b', 'c', 'd', 'e'].map((id) => task(id)), { maxParallel: 3 })).toEqual({ schedule: ['a', 'b', 'c'], block: [], wait: [{ id: 'd', reason: 'slots', on: [] }, { id: 'e', reason: 'slots', on: [] }] })
  expect(plan([running, task('a', { scope: ['shared'] }), task('b', { scope: ['shared'] })], { maxParallel: 1 }).wait).toEqual([{ id: 'a', reason: 'slots', on: ['running'] }, { id: 'b', reason: 'slots', on: ['running'] }])
})

it('CHK-M7-02-c: gates preserve retry times, held scopes, slots, and earlier precedence', () => {
  for (const gate of [{ reason: 'quota' as const, retryAtMs: 1234 }, { reason: 'budget' as const, retryAtMs: null }]) {
    expect(plan([task('a', { scope: ['shared'] }), task('b', { scope: ['shared'] })], { maxParallel: 1, gates: { a: gate } })).toEqual({ schedule: ['b'], block: [], wait: [{ id: 'a', reason: gate.reason, on: [], retryAtMs: gate.retryAtMs }] })
    expect(plan([task('running', { status: 'progress', scope: ['shared'] }), task('a', { scope: ['shared'] })], { gates: { a: gate } })).toEqual({ schedule: [], block: [], wait: [{ id: 'a', reason: 'scope', on: ['running'] }] })
  }
})
