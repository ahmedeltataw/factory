import { scopesOverlap } from './scope.ts'

export const PHASES = ['intake', 'development', 'qa', 'devops', 'handover'] as const
export type PhaseName = (typeof PHASES)[number]

export function phaseOrd(name: PhaseName): 1 | 2 | 3 | 4 | 5
export function phaseOrd(name: string): number
export function phaseOrd(name: string): number {
  const index = PHASES.indexOf(name as PhaseName)
  if (index === -1) {
    throw new Error(`unknown phase name: ${name}`)
  }
  return (index + 1) as 1 | 2 | 3 | 4 | 5
}

export type ParseDepsResult =
  | { ok: true; deps: string[] }
  | { ok: false; reason: string }

export function parseDeps(input: unknown): ParseDepsResult {
  if (!Array.isArray(input)) {
    return { ok: false, reason: 'dependencies must be an array' }
  }
  if (input.length > 32) {
    return { ok: false, reason: 'dependencies array must contain at most 32 entries' }
  }

  for (const entry of input) {
    if (typeof entry !== 'string') {
      return { ok: false, reason: 'dependency entry must be a string' }
    }
    if (entry.length < 1) {
      return { ok: false, reason: 'dependency entry must not be empty' }
    }
    if (entry.length > 200) {
      return { ok: false, reason: 'dependency entry must not exceed 200 characters' }
    }
    if (!entry.isWellFormed()) {
      return { ok: false, reason: 'dependency entry must be well-formed Unicode' }
    }
    if (entry.trim().length === 0) {
      return { ok: false, reason: 'dependency entry must not be blank' }
    }
  }

  const unique = Array.from(new Set(input as string[]))
  unique.sort()

  return { ok: true, deps: unique }
}

export type PhaseStatus = 'locked' | 'open' | 'done'
export type TaskStatus = 'ready' | 'progress' | 'blocked' | 'failed' | 'done' | 'dropped'

export interface PhaseInfo {
  name: PhaseName | string
  status: PhaseStatus | string
}

export interface DispatchTask {
  id: string
  status: TaskStatus | string
  phase: PhaseName | string
  deps: string[]
  scope: string[]
  notBeforeMs: number
}

export interface DispatchInput {
  nowMs: number
  phases: PhaseInfo[]
  tasks: DispatchTask[]
  maxParallel?: number | null
  gates?: Record<string, { reason: 'quota' | 'budget'; retryAtMs: number | null }>
}

export type WaitReason =
  | 'phase-locked'
  | 'deps'
  | 'scope'
  | 'backoff'
  | 'slots'
  | 'quota'
  | 'budget'

export interface Wait<R extends string = WaitReason> {
  id: string
  reason: R
  on: string[]
  retryAtMs?: number | null
}

export interface DispatchPlan<R extends string = WaitReason> {
  schedule: string[]
  block: string[]
  wait: Wait<R>[]
}

export function planDispatch(input: {
  nowMs: number
  phases: PhaseInfo[]
  tasks: DispatchTask[]
  maxParallel?: undefined | null
  gates?: undefined
}): DispatchPlan<'phase-locked' | 'deps' | 'scope' | 'backoff'>
export function planDispatch(input: DispatchInput): DispatchPlan<WaitReason>
export function planDispatch(input: DispatchInput): DispatchPlan<WaitReason> {
  const schedule: string[] = []
  const block: string[] = []
  const wait: Wait[] = []

  const byId = new Map<string, DispatchTask>()
  for (const t of input.tasks) {
    byId.set(t.id, t)
  }

  const phaseStatusByName = new Map<string, string>()
  for (const p of input.phases) {
    phaseStatusByName.set(p.name, p.status)
  }

  const blockSet = new Set<string>()
  for (const t of input.tasks) {
    if (t.status === 'blocked') {
      blockSet.add(t.id)
    }
  }

  const progressTaskIds: string[] = []
  const held: { id: string; scope: string[] }[] = []
  for (const t of input.tasks) {
    if (t.status === 'progress') {
      held.push({ id: t.id, scope: t.scope })
      progressTaskIds.push(t.id)
    }
  }

  for (const task of input.tasks) {
    if (task.status !== 'ready') {
      continue
    }

    // 1. A task with a dep in status dropped, or a dep that is itself in block or already blocked,
    // goes to block (transitively, in dispatch order; deps are always older, so one pass is enough).
    let isBlocked = false
    for (const depId of task.deps) {
      const dep = byId.get(depId)
      if (dep?.status === 'dropped' || dep?.status === 'blocked' || blockSet.has(depId)) {
        isBlocked = true
        break
      }
    }
    if (isBlocked) {
      block.push(task.id)
      blockSet.add(task.id)
      continue
    }

    // 2. Phase not open -> wait phase-locked. The task does not join held.
    const phaseStatus = phaseStatusByName.get(task.phase)
    if (phaseStatus !== 'open') {
      wait.push({
        id: task.id,
        reason: 'phase-locked',
        on: [task.phase],
      })
      continue
    }

    // 3. A dep not done -> wait deps. The task does not join held.
    const unfinished: string[] = []
    for (const depId of task.deps) {
      const dep = byId.get(depId)
      if (dep?.status !== 'done') {
        unfinished.push(depId)
      }
    }
    if (unfinished.length > 0) {
      wait.push({
        id: task.id,
        reason: 'deps',
        on: unfinished,
      })
      continue
    }

    // 4. Scope overlaps held (M4 rule, scopesOverlap) -> wait scope, and it joins held.
    const overlapping: string[] = []
    for (const h of held) {
      if (scopesOverlap(task.scope, h.scope)) {
        overlapping.push(h.id)
      }
    }
    if (overlapping.length > 0) {
      wait.push({
        id: task.id,
        reason: 'scope',
        on: overlapping,
      })
      held.push({ id: task.id, scope: task.scope })
      continue
    }

    // 5. notBeforeMs > nowMs -> wait backoff, and it joins held.
    if (task.notBeforeMs > input.nowMs) {
      wait.push({
        id: task.id,
        reason: 'backoff',
        on: [],
      })
      held.push({ id: task.id, scope: task.scope })
      continue
    }

    // 6. Task in gates -> wait quota / budget. The task does not join held.
    const gate = input.gates && Object.hasOwn(input.gates, task.id) ? input.gates[task.id] : undefined
    if (gate) {
      wait.push({
        id: task.id,
        reason: gate.reason,
        on: [],
        retryAtMs: gate.retryAtMs ?? null,
      })
      continue
    }

    // 7. Slots cap reached -> wait slots on progress tasks. The task does not join held.
    if (typeof input.maxParallel === 'number' && progressTaskIds.length + schedule.length >= input.maxParallel) {
      wait.push({
        id: task.id,
        reason: 'slots',
        on: [...progressTaskIds],
      })
      continue
    }

    // 8. Otherwise -> schedule, and it joins held.
    schedule.push(task.id)
    held.push({ id: task.id, scope: task.scope })
  }

  return { schedule, block, wait }
}
