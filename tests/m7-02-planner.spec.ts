import { describe, expect, it } from 'vitest'
import { planDispatch, type DispatchTask, type PhaseInfo } from '../supervisor/src/core/graph.ts'

const phases: PhaseInfo[] = [
  { name: 'intake', status: 'open' },
  { name: 'development', status: 'locked' },
  { name: 'qa', status: 'locked' },
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

describe('M7-02 planner slots and gates', () => {
  describe('CHK-M7-02-a: unlimited inputs retain M6 behavior and lack retryAtMs', () => {
    it('returns exact same plan with absent vs null/empty extra options', () => {
      const tasks = [
        makeTask('t1', { scope: ['src'] }),
        makeTask('t2', { scope: ['src/sub'] }),
      ]
      const planDefault = planDispatch({ nowMs: 100, phases, tasks })
      const planExplicit = planDispatch({ nowMs: 100, phases, tasks, maxParallel: null, gates: {} })

      expect(planDefault).toEqual({
        schedule: ['t1'],
        block: [],
        wait: [{ id: 't2', reason: 'scope', on: ['t1'] }],
      })
      expect(planExplicit).toEqual(planDefault)
      expect('retryAtMs' in planDefault.wait[0]!).toBe(false)
    })
  })

  describe('CHK-M7-02-b: slots capping, progress tracking, and held isolation', () => {
    it('cap 2 with 1 running schedules at most 1', () => {
      const running = makeTask('p1', { status: 'progress' })
      const t1 = makeTask('t1')
      const t2 = makeTask('t2')
      const res = planDispatch({
        nowMs: 100,
        phases,
        tasks: [running, t1, t2],
        maxParallel: 2,
      })

      expect(res).toEqual({
        schedule: ['t1'],
        block: [],
        wait: [{ id: 't2', reason: 'slots', on: ['p1'] }],
      })
      expect('retryAtMs' in res.wait[0]!).toBe(false)
    })

    it('cap 1 with 1 running schedules 0 and waits slots on running task', () => {
      const running = makeTask('p1', { status: 'progress' })
      const t1 = makeTask('t1')
      const t2 = makeTask('t2')
      const res = planDispatch({
        nowMs: 100,
        phases,
        tasks: [running, t1, t2],
        maxParallel: 1,
      })

      expect(res.schedule).toEqual([])
      expect(res.wait).toEqual([
        { id: 't1', reason: 'slots', on: ['p1'] },
        { id: 't2', reason: 'slots', on: ['p1'] },
      ])
    })

    it('wait order strictly follows input task order', () => {
      const tasks = ['a', 'b', 'c', 'd'].map((id) => makeTask(id))
      const res = planDispatch({
        nowMs: 100,
        phases,
        tasks,
        maxParallel: 1,
      })

      expect(res.schedule).toEqual(['a'])
      expect(res.wait.map((w) => w.id)).toEqual(['b', 'c', 'd'])
      expect(res.wait.every((w) => w.reason === 'slots' && w.on.length === 0)).toBe(true)
    })

    it('includes all progress tasks in on list in task order', () => {
      const p1 = makeTask('p1', { status: 'progress' })
      const p2 = makeTask('p2', { status: 'progress' })
      const t1 = makeTask('t1')
      const res = planDispatch({
        nowMs: 100,
        phases,
        tasks: [p1, p2, t1],
        maxParallel: 2,
      })

      expect(res.wait).toEqual([
        { id: 't1', reason: 'slots', on: ['p1', 'p2'] },
      ])
    })

    it('slots wait does not join held (does not block later overlapping task via scope)', () => {
      const running = makeTask('p', { status: 'progress', scope: ['other'] })
      const t1 = makeTask('t1', { scope: ['shared'] })
      const t2 = makeTask('t2', { scope: ['shared'] })
      const res = planDispatch({
        nowMs: 100,
        phases,
        tasks: [running, t1, t2],
        maxParallel: 1,
      })

      // Both t1 and t2 wait on slots; t2 does NOT wait on scope because t1 was not held!
      expect(res.wait).toEqual([
        { id: 't1', reason: 'slots', on: ['p'] },
        { id: 't2', reason: 'slots', on: ['p'] },
      ])
    })

    it('boundary check: running 1, maxParallel 3, 3 ready tasks', () => {
      const running = makeTask('p1', { status: 'progress' })
      const t1 = makeTask('t1')
      const t2 = makeTask('t2')
      const t3 = makeTask('t3')
      const res = planDispatch({
        nowMs: 100,
        phases,
        tasks: [running, t1, t2, t3],
        maxParallel: 3,
      })

      // 1 running + 2 scheduled = 3. t3 hits 1 + 2 >= 3 and waits slots
      expect(res.schedule).toEqual(['t1', 't2'])
      expect(res.wait).toEqual([
        { id: 't3', reason: 'slots', on: ['p1'] },
      ])
    })
  })

  describe('CHK-M7-02-c: gates, retryAtMs, held isolation, and precedence', () => {
    it('sets retryAtMs only on quota/budget waits and leaves on empty', () => {
      const tQuota = makeTask('q')
      const tBudget = makeTask('b')
      const res = planDispatch({
        nowMs: 100,
        phases,
        tasks: [tQuota, tBudget],
        gates: {
          q: { reason: 'quota', retryAtMs: 2000 },
          b: { reason: 'budget', retryAtMs: null },
        },
      })

      expect(res).toEqual({
        schedule: [],
        block: [],
        wait: [
          { id: 'q', reason: 'quota', on: [], retryAtMs: 2000 },
          { id: 'b', reason: 'budget', on: [], retryAtMs: null },
        ],
      })
    })

    it('gated task does not join held and does not consume slot', () => {
      const tGated = makeTask('g', { scope: ['shared'] })
      const tNext = makeTask('n', { scope: ['shared'] })
      const res = planDispatch({
        nowMs: 100,
        phases,
        tasks: [tGated, tNext],
        maxParallel: 1,
        gates: {
          g: { reason: 'quota', retryAtMs: 1500 },
        },
      })

      // tGated waits for quota.
      // tNext has identical scope and maxParallel is 1.
      // Since tGated did not join held and did not take a slot, tNext schedules!
      expect(res).toEqual({
        schedule: ['n'],
        block: [],
        wait: [
          { id: 'g', reason: 'quota', on: [], retryAtMs: 1500 },
        ],
      })
    })

    it('precedence: earlier checks precede gates', () => {
      // 1. Blocked dep precedes gate
      const dropped = makeTask('dr', { status: 'dropped' })
      const tDepBlocked = makeTask('t-db', { deps: ['dr'] })
      const resBlocked = planDispatch({
        nowMs: 100,
        phases,
        tasks: [dropped, tDepBlocked],
        gates: { 't-db': { reason: 'quota', retryAtMs: 1000 } },
      })
      expect(resBlocked.block).toEqual(['t-db'])
      expect(resBlocked.wait).toEqual([])

      // 2. Locked phase precedes gate
      const tLocked = makeTask('t-l', { phase: 'development' })
      const resLocked = planDispatch({
        nowMs: 100,
        phases,
        tasks: [tLocked],
        gates: { 't-l': { reason: 'budget', retryAtMs: null } },
      })
      expect(resLocked.wait).toEqual([{ id: 't-l', reason: 'phase-locked', on: ['development'] }])

      // 3. Unfinished dep precedes gate
      const failed = makeTask('f', { status: 'failed' })
      const tWaitDep = makeTask('t-wd', { deps: ['f'] })
      const resDep = planDispatch({
        nowMs: 100,
        phases,
        tasks: [failed, tWaitDep],
        gates: { 't-wd': { reason: 'quota', retryAtMs: 1000 } },
      })
      expect(resDep.wait).toEqual([{ id: 't-wd', reason: 'deps', on: ['f'] }])

      // 4. Scope overlap with held precedes gate
      const prog = makeTask('p', { status: 'progress', scope: ['src'] })
      const tScope = makeTask('t-sc', { scope: ['src'] })
      const resScope = planDispatch({
        nowMs: 100,
        phases,
        tasks: [prog, tScope],
        gates: { 't-sc': { reason: 'budget', retryAtMs: null } },
      })
      expect(resScope.wait).toEqual([{ id: 't-sc', reason: 'scope', on: ['p'] }])

      // 5. Backoff precedes gate
      const tBackoff = makeTask('t-bo', { notBeforeMs: 200 })
      const resBackoff = planDispatch({
        nowMs: 100,
        phases,
        tasks: [tBackoff],
        gates: { 't-bo': { reason: 'quota', retryAtMs: 1000 } },
      })
      expect(resBackoff.wait).toEqual([{ id: 't-bo', reason: 'backoff', on: [] }])
    })

    it('precedence: gates precede slots', () => {
      const running = makeTask('p', { status: 'progress' })
      const tGated = makeTask('t-g')
      const res = planDispatch({
        nowMs: 100,
        phases,
        tasks: [running, tGated],
        maxParallel: 1,
        gates: { 't-g': { reason: 'quota', retryAtMs: 3000 } },
      })

      // maxParallel is 1, 1 is running. If slots came first, tGated would wait 'slots'.
      // But gate check comes first!
      expect(res.wait).toEqual([
        { id: 't-g', reason: 'quota', on: [], retryAtMs: 3000 },
      ])
    })

    it('does not treat inherited Object.prototype properties as gates', () => {
      const specialIds = ['constructor', 'toString', 'hasOwnProperty', '__proto__']
      const tasks = specialIds.map((id) => makeTask(id))

      const resEmpty = planDispatch({
        nowMs: 100,
        phases,
        tasks,
        gates: {},
      })
      expect(resEmpty.schedule).toEqual(specialIds)
      expect(resEmpty.wait).toEqual([])
      expect(resEmpty.block).toEqual([])

      const resOther = planDispatch({
        nowMs: 100,
        phases,
        tasks,
        gates: {
          other: { reason: 'quota' as const, retryAtMs: null },
        },
      })
      expect(resOther.schedule).toEqual(specialIds)
      expect(resOther.wait).toEqual([])
      expect(resOther.block).toEqual([])

      const resGated = planDispatch({
        nowMs: 100,
        phases,
        tasks,
        gates: {
          constructor: { reason: 'quota' as const, retryAtMs: 1234 },
        },
      })
      expect(resGated.schedule).toEqual(['toString', 'hasOwnProperty', '__proto__'])
      expect(resGated.wait).toEqual([
        { id: 'constructor', reason: 'quota', on: [], retryAtMs: 1234 },
      ])
      expect(resGated.block).toEqual([])
    })
  })

  describe('purity and determinism', () => {
    it('does not mutate input structures and returns deterministic result', () => {
      const input = {
        nowMs: 100,
        phases,
        tasks: [
          makeTask('p', { status: 'progress', scope: ['src'] }),
          makeTask('t1', { scope: ['src'] }),
          makeTask('t2', { scope: ['docs'] }),
        ],
        maxParallel: 2,
        gates: {
          t2: { reason: 'quota' as const, retryAtMs: 999 },
        },
      }
      const beforeSnapshot = JSON.stringify(input)
      const res1 = planDispatch(input)
      const res2 = planDispatch(input)

      expect(JSON.stringify(input)).toBe(beforeSnapshot)
      expect(res1).toEqual(res2)
    })
  })
})
