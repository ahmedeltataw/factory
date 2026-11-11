import { describe, expect, it } from 'vitest'
import {
  PHASES,
  parseDeps,
  phaseOrd,
  planDispatch,
  type DispatchTask,
  type PhaseInfo,
  type PhaseName,
} from '../supervisor/src/core/graph.ts'

const standardPhases: PhaseInfo[] = [
  { name: 'intake', status: 'open' },
  { name: 'development', status: 'locked' },
  { name: 'qa', status: 'locked' },
  { name: 'devops', status: 'locked' },
  { name: 'handover', status: 'locked' },
]

function makeTask(id: string, overrides: Partial<DispatchTask> = {}): DispatchTask {
  return {
    id,
    status: 'ready',
    phase: 'intake',
    deps: [],
    scope: [id],
    notBeforeMs: 0,
    ...overrides,
  }
}

describe('M5-04 focused graph tests', () => {
  describe('PHASES and phaseOrd', () => {
    it('PHASES has the exact five frozen phase names in order', () => {
      expect(PHASES).toEqual(['intake', 'development', 'qa', 'devops', 'handover'])
      expect(PHASES).toHaveLength(5)
    })

    it('phaseOrd returns 1..5 for all five phase names', () => {
      expect(phaseOrd('intake')).toBe(1)
      expect(phaseOrd('development')).toBe(2)
      expect(phaseOrd('qa')).toBe(3)
      expect(phaseOrd('devops')).toBe(4)
      expect(phaseOrd('handover')).toBe(5)
    })

    it('phaseOrd throws on unknown or invalid phase names', () => {
      expect(() => phaseOrd('unknown')).toThrow('unknown phase name: unknown')
      expect(() => phaseOrd('')).toThrow('unknown phase name: ')
      expect(() => phaseOrd('INTAKE')).toThrow('unknown phase name: INTAKE')
      expect(() => phaseOrd('invalid_phase')).toThrow('unknown phase name: invalid_phase')
    })
  })

  describe('parseDeps edge cases and boundaries', () => {
    it('boundary 0 deps: accepts empty array', () => {
      const res = parseDeps([])
      expect(res).toEqual({ ok: true, deps: [] })
    })

    it('boundary 32 deps: accepts exactly 32 entries', () => {
      const input = Array.from({ length: 32 }, (_, i) => `dep-${String(i).padStart(2, '0')}`)
      const res = parseDeps(input)
      expect(res.ok).toBe(true)
      if (!res.ok) throw new Error('expected ok')
      expect(res.deps).toHaveLength(32)
      expect(res.deps).toEqual([...input].sort())
    })

    it('boundary 33 deps: rejects 33 unique entries', () => {
      const input = Array.from({ length: 33 }, (_, i) => `dep-${String(i).padStart(2, '0')}`)
      const res = parseDeps(input)
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('expected reject')
      expect(res.reason).toContain('32')
    })

    it('boundary 33 deps: rejects 33 identical duplicate entries before deduplication', () => {
      const input = Array(33).fill('dup')
      const res = parseDeps(input)
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('expected reject')
      expect(res.reason).toContain('32')
    })

    it('boundary 200 chars: accepts 200 characters string', () => {
      const longStr = 'x'.repeat(200)
      const res = parseDeps([longStr])
      expect(res).toEqual({ ok: true, deps: [longStr] })
    })

    it('boundary 201 chars: rejects 201 characters string', () => {
      const tooLong = 'x'.repeat(201)
      const res = parseDeps([tooLong])
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('expected reject')
      expect(res.reason).toContain('200')
    })

    it('boundary 1 char and 199 chars: accepts valid lengths', () => {
      const res = parseDeps(['a', 'b'.repeat(199)])
      expect(res).toEqual({ ok: true, deps: ['a', 'b'.repeat(199)] })
    })

    it('rejects empty string (0 chars)', () => {
      const res = parseDeps([''])
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('expected reject')
      expect(res.reason).toContain('empty')
    })

    it('rejects blank strings of various whitespace after trim', () => {
      for (const blank of [' ', '  ', '\t', '\n', '\r\n', ' \t \n ']) {
        const res = parseDeps([blank])
        expect(res.ok).toBe(false)
        if (res.ok) throw new Error('expected reject')
        expect(res.reason).toContain('blank')
      }
    })

    it('accepts string with leading/trailing spaces as long as not blank after trim', () => {
      const res = parseDeps(['  valid  '])
      expect(res).toEqual({ ok: true, deps: ['  valid  '] })
    })

    it('rejects non-array inputs', () => {
      for (const nonArray of [null, undefined, 42, 'str', {}, true, false, () => {}]) {
        const res = parseDeps(nonArray)
        expect(res.ok).toBe(false)
        if (res.ok) throw new Error('expected reject')
        expect(res.reason).toContain('array')
      }
    })

    it('rejects non-string entries in array', () => {
      for (const badEntry of [123, null, undefined, {}, true, []]) {
        const res = parseDeps(['valid', badEntry as unknown as string])
        expect(res.ok).toBe(false)
        if (res.ok) throw new Error('expected reject')
        expect(res.reason).toContain('string')
      }
    })

    it('rejects lone surrogates (ill-formed Unicode)', () => {
      expect(parseDeps(['\ud800']).ok).toBe(false)
      expect(parseDeps(['\udc00']).ok).toBe(false)
      expect(parseDeps(['prefix-\ud800-suffix']).ok).toBe(false)
    })

    it('deduplicates and sorts in code-unit order', () => {
      const input = ['zebra', 'apple', 'zebra', 'Beta', 'alpha']
      const res = parseDeps(input)
      expect(res).toEqual({
        ok: true,
        deps: ['Beta', 'alpha', 'apple', 'zebra'],
      })
    })
  })

  describe('planDispatch edge cases', () => {
    it('nowMs equal to notBeforeMs schedules (not backoff)', () => {
      const res = planDispatch({
        nowMs: 100,
        phases: standardPhases,
        tasks: [makeTask('t1', { notBeforeMs: 100 })],
      })
      expect(res).toEqual({
        schedule: ['t1'],
        block: [],
        wait: [],
      })
    })

    it('nowMs less than notBeforeMs triggers backoff', () => {
      const res = planDispatch({
        nowMs: 100,
        phases: standardPhases,
        tasks: [makeTask('t1', { notBeforeMs: 101 })],
      })
      expect(res).toEqual({
        schedule: [],
        block: [],
        wait: [{ id: 't1', reason: 'backoff', on: [] }],
      })
    })

    it('nowMs greater than notBeforeMs schedules', () => {
      const res = planDispatch({
        nowMs: 100,
        phases: standardPhases,
        tasks: [makeTask('t1', { notBeforeMs: 99 })],
      })
      expect(res).toEqual({
        schedule: ['t1'],
        block: [],
        wait: [],
      })
    })

    it('dep in block from earlier in the same pass propagates to later tasks', () => {
      const tasks = [
        makeTask('root', { status: 'dropped' }),
        makeTask('child1', { deps: ['root'] }),
        makeTask('child2', { deps: ['child1'] }),
        makeTask('child3', { deps: ['child2'] }),
      ]
      const res = planDispatch({
        nowMs: 100,
        phases: standardPhases,
        tasks,
      })
      expect(res).toEqual({
        schedule: [],
        block: ['child1', 'child2', 'child3'],
        wait: [],
      })
    })

    it('a task whose dep is progress waits for deps', () => {
      const tasks = [
        makeTask('in-prog', { status: 'progress', scope: ['worker'] }),
        makeTask('dependant', { deps: ['in-prog'], scope: ['other'] }),
      ]
      const res = planDispatch({
        nowMs: 100,
        phases: standardPhases,
        tasks,
      })
      expect(res).toEqual({
        schedule: [],
        block: [],
        wait: [{ id: 'dependant', reason: 'deps', on: ['in-prog'] }],
      })
    })

    it('a task whose dep is ready waits for deps', () => {
      const tasks = [
        makeTask('first', { notBeforeMs: 101, scope: ['first'] }),
        makeTask('second', { deps: ['first'], scope: ['second'] }),
      ]
      const res = planDispatch({
        nowMs: 100,
        phases: standardPhases,
        tasks,
      })
      expect(res).toEqual({
        schedule: [],
        block: [],
        wait: [
          { id: 'first', reason: 'backoff', on: [] },
          { id: 'second', reason: 'deps', on: ['first'] },
        ],
      })
    })

    it('a task whose dep is failed waits for deps', () => {
      const tasks = [
        makeTask('failed-task', { status: 'failed' }),
        makeTask('waiter', { deps: ['failed-task'] }),
      ]
      const res = planDispatch({
        nowMs: 100,
        phases: standardPhases,
        tasks,
      })
      expect(res).toEqual({
        schedule: [],
        block: [],
        wait: [{ id: 'waiter', reason: 'deps', on: ['failed-task'] }],
      })
    })

    it('a task with multiple deps where some are done and some are unfinished lists only unfinished in on', () => {
      const tasks = [
        makeTask('d1', { status: 'done' }),
        makeTask('d2', { status: 'progress' }),
        makeTask('d3', { status: 'failed' }),
        makeTask('d4', { status: 'done' }),
        makeTask('target', { deps: ['d1', 'd2', 'd3', 'd4'] }),
      ]
      const res = planDispatch({
        nowMs: 100,
        phases: standardPhases,
        tasks,
      })
      expect(res).toEqual({
        schedule: [],
        block: [],
        wait: [{ id: 'target', reason: 'deps', on: ['d2', 'd3'] }],
      })
    })

    it('phase-locked triggers when phase is done or unknown', () => {
      const phasesWithDone: PhaseInfo[] = [
        { name: 'intake', status: 'done' },
        { name: 'development', status: 'open' },
      ]
      const tasks = [
        makeTask('t-done', { phase: 'intake' }),
        makeTask('t-unknown', { phase: 'qa' }),
      ]
      const res = planDispatch({
        nowMs: 100,
        phases: phasesWithDone,
        tasks,
      })
      expect(res.schedule).toEqual([])
      expect(res.block).toEqual([])
      expect(res.wait).toEqual([
        { id: 't-done', reason: 'phase-locked', on: ['intake'] },
        { id: 't-unknown', reason: 'phase-locked', on: ['qa'] },
      ])
    })

    it('ignores non-ready tasks from schedule, block, and wait outputs', () => {
      const tasks: DispatchTask[] = [
        makeTask('p', { status: 'progress' }),
        makeTask('b', { status: 'blocked' }),
        makeTask('f', { status: 'failed' }),
        makeTask('d', { status: 'done' }),
        makeTask('dr', { status: 'dropped' }),
      ]
      const res = planDispatch({
        nowMs: 100,
        phases: standardPhases,
        tasks,
      })
      expect(res).toEqual({
        schedule: [],
        block: [],
        wait: [],
      })
    })

    it('backoff waiter joins held and blocks subsequent overlapping task with scope wait', () => {
      const tasks = [
        makeTask('backoff-task', { scope: ['src/core'], notBeforeMs: 200 }),
        makeTask('overlapping-task', { scope: ['src/core/graph.ts'], notBeforeMs: 0 }),
      ]
      const res = planDispatch({
        nowMs: 100,
        phases: standardPhases,
        tasks,
      })
      expect(res).toEqual({
        schedule: [],
        block: [],
        wait: [
          { id: 'backoff-task', reason: 'backoff', on: [] },
          { id: 'overlapping-task', reason: 'scope', on: ['backoff-task'] },
        ],
      })
    })

    it('scheduled task joins held and blocks subsequent overlapping task with scope wait', () => {
      const tasks = [
        makeTask('sched', { scope: ['src'] }),
        makeTask('waiter', { scope: ['src/sub'] }),
      ]
      const res = planDispatch({
        nowMs: 100,
        phases: standardPhases,
        tasks,
      })
      expect(res).toEqual({
        schedule: ['sched'],
        block: [],
        wait: [{ id: 'waiter', reason: 'scope', on: ['sched'] }],
      })
    })

    it('scope waiter joins held and transitively blocks later overlapping task', () => {
      const tasks = [
        makeTask('running', { status: 'progress', scope: ['src/a'] }),
        makeTask('waiter1', { scope: ['src'] }), // overlaps 'running', joins held
        makeTask('waiter2', { scope: ['src/b'] }), // overlaps 'waiter1' but not 'running'
      ]
      const res = planDispatch({
        nowMs: 100,
        phases: standardPhases,
        tasks,
      })
      expect(res).toEqual({
        schedule: [],
        block: [],
        wait: [
          { id: 'waiter1', reason: 'scope', on: ['running'] },
          { id: 'waiter2', reason: 'scope', on: ['waiter1'] },
        ],
      })
    })
  })
})
