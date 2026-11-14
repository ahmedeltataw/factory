import fc from 'fast-check'
import { expect, it } from 'vitest'
import { planDispatch } from '../../supervisor/src/core/graph.ts'
import { scopesOverlap } from '../../supervisor/src/core/scope.ts'

const row = fc.record({
  status: fc.constantFrom('ready', 'progress', 'done', 'blocked', 'dropped', 'failed'),
  phase: fc.constantFrom('intake', 'qa'),
  scope: fc.constantFrom('src', 'src/a', 'src/b', 'docs', 'test'),
  deps: fc.array(fc.nat({ max: 15 }), { maxLength: 3 }),
  backoff: fc.boolean(),
  gate: fc.option(fc.record({ reason: fc.constantFrom('quota' as const, 'budget' as const), retryAtMs: fc.option(fc.nat({ max: 10000 }), { nil: null }) }), { nil: null }),
})

it('CHK-M7-02-d: randomized caps, scopes, gates, determinism and input purity', () => {
  fc.assert(fc.property(fc.array(row, { maxLength: 16 }), fc.nat({ max: 8 }), fc.boolean(), (rows, extraSlots, capped) => {
    const tasks = rows.map((r, i) => ({
      id: `t${i}`, status: r.status, phase: r.phase, scope: [r.scope],
      deps: r.status === 'ready' ? [...new Set(r.deps.filter((n) => n < i).map((n) => `t${n}`))] : [],
      notBeforeMs: r.backoff ? 101 : 100,
    }))
    const gates: Record<string, { reason: 'quota' | 'budget'; retryAtMs: number | null }> = {}
    rows.forEach((r, i) => { if (r.gate) gates[`t${i}`] = r.gate })
    const running = tasks.filter((t) => t.status === 'progress')
    const maxParallel = capped ? Math.max(1, running.length + extraSlots) : null
    const input = { nowMs: 100, phases: [{ name: 'intake', status: 'open' }, { name: 'qa', status: 'locked' }], tasks, maxParallel, gates }
    const before = structuredClone(input)
    const result = planDispatch(input)
    expect(planDispatch(input)).toEqual(result)
    expect(input).toEqual(before)
    if (maxParallel !== null) expect(result.schedule.length + running.length).toBeLessThanOrEqual(maxParallel)
    const byId = new Map(tasks.map((t) => [t.id, t]))
    for (let i = 0; i < result.schedule.length; i++) {
      const current = byId.get(result.schedule[i]!)!
      for (const other of [...running, ...result.schedule.slice(0, i).map ( (id) => byId.get(id)! )]) {
        expect(scopesOverlap(current.scope, other.scope)).toBe(false)
      }
    }
    for (const t of tasks) {
      const gate = gates[t.id]
      if (t.status !== 'ready' || !gate) continue
      const wait = result.wait.find((w) => w.id === t.id)
      const earlier = result.block.includes(t.id) || (wait && ['phase-locked', 'deps', 'scope', 'backoff'].includes(wait.reason))
      if (!earlier) {
        expect(result.schedule).not.toContain(t.id)
        expect(wait).toEqual({ id: t.id, reason: gate.reason, on: [], retryAtMs: gate.retryAtMs })
      }
    }
  }), { numRuns: 300 })
})
