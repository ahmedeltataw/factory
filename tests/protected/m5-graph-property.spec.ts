import fc from 'fast-check'
import { expect, it } from 'vitest'
import { planDispatch } from '../../supervisor/src/core/graph.ts'
import { scopesOverlap } from '../../supervisor/src/core/scope.ts'
import { runScript } from '../scripts/helpers.ts'

const names = ['intake', 'development', 'qa', 'devops', 'handover'] as const
const statuses = ['ready', 'progress', 'blocked', 'failed', 'done', 'dropped'] as const
const row = fc.record({ status: fc.constantFrom(...statuses), phase: fc.constantFrom(...names), scope: fc.constantFrom('.', 'src', 'src/a', 'SRC/b', 'docs', 'test'), deps: fc.array(fc.nat({ max: 20 }), { maxLength: 5 }), backoff: fc.boolean() })

it('CHK-M5-04-d: random valid DAGs preserve dispatch invariants and determinism', () => {
  fc.assert(fc.property(fc.array(row, { maxLength: 20 }), fc.integer({ min: -1, max: 4 }), (rows, openIndex) => {
    const phases = names.map((name, i) => ({ name, status: (i === openIndex ? 'open' : i < openIndex ? 'done' : 'locked') as 'open' | 'done' | 'locked' }))
    const tasks = rows.map((r, i) => ({
      id: `t${i}`, status: r.status, phase: r.phase,
      // Existing non-ready states are roots; generated dependency edges still form arbitrary ready-task DAGs.
      deps: r.status === 'ready' ? [...new Set(r.deps.filter((n) => n < i).map((n) => `t${n}`))] : [],
      scope: r.status === 'progress' ? [`progress-${i}`] : [r.scope], notBeforeMs: r.backoff ? 101 : 100,
    }))
    const input = { nowMs: 100, phases, tasks }
    const result = planDispatch(input)
    expect(planDispatch(input)).toEqual(result)
    const byId = new Map(tasks.map((t) => [t.id, t]))
    for (const id of result.schedule) {
      const t = byId.get(id)!
      expect(phases.find((p) => p.name === t.phase)?.status).toBe('open')
      expect(t.deps.every((dep) => byId.get(dep)?.status === 'done')).toBe(true)
    }
    const running = [...tasks.filter((t) => t.status === 'progress').map((t) => t.id), ...result.schedule]
    for (let i = 0; i < running.length; i++) for (let j = i + 1; j < running.length; j++) {
      expect(scopesOverlap(byId.get(running[i]!)!.scope, byId.get(running[j]!)!.scope)).toBe(false)
    }
    const blocked = new Set<string>()
    for (const t of tasks) {
      if (t.status === 'ready' && t.deps.some((id) => {
        const dep = byId.get(id)!
        return dep.status === 'dropped' || dep.status === 'blocked' || blocked.has(id)
      })) blocked.add(t.id)
    }
    expect(new Set(result.block)).toEqual(blocked)
    expect(result.block).toHaveLength(blocked.size)
  }), { numRuns: 300 })
})

it('CHK-M5-04-d: forbidden-imports passes', () => {
  const result = runScript('check-forbidden-imports.mjs')
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
})
