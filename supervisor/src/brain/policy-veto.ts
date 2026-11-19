import type { BrainCallType, BrainOutputMap } from './schemas.ts'

export const DEFAULT_FORBIDDEN_PREFIXES = [
  'tests/protected/',
  'tests/qa/',
  'schemas/',
  '.factory/',
  'licenses/',
] as const

export const DEFAULT_FORBIDDEN_FILES = ['source_manifest.json', 'notice', 'license'] as const

export const VETO_CODES = [
  'approve-against-adr',
  'complete-with-missing-evidence',
  'complete-with-open-s0-s1',
  'dependency-without-adr',
  'destructive-action',
  'downgrade-without-evidence',
  'forbidden-path',
  'high-risk-without-lead-review',
  'insufficient-evidence-without-single-question',
  'invented-destination',
  'missing-evidence',
  'policy-override',
  'qa-test-edit',
  'retry-without-cause-or-change',
  's0-s1-waiver',
  'silent-contract-break',
  'task-graph-invalid',
  'task-missing-dod',
  'task-missing-owner',
  'waive-acceptance-criteria',
] as const

export type VetoCode = (typeof VETO_CODES)[number]

export interface PolicyVetoContext {
  forbiddenPaths?: readonly string[]
  allowedDestinations?: readonly string[]
  existingTaskIds?: readonly string[]
  risk?: 'low' | 'medium' | 'high'
  openS0S1Count?: number
  missingEvidence?: readonly string[]
}

export interface PolicyVetoResult {
  allowed: boolean
  vetoes: VetoCode[]
}

function normalizePath(path: string): string {
  // Strip leading ./ before collapsing slashes so an exposed root marker survives.
  const separated = path.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '').replace(/\/+/g, '/')
  const normalized = separated.split('/').filter((segment) => segment !== '.').join('/')
  return (normalized || (separated.startsWith('/') ? '/' : '')).toLowerCase()
}

function matchesPath(path: string, rule: string): boolean {
  const normalizedRule = normalizePath(rule)
  if (normalizedRule.endsWith('/')) {
    return path.startsWith(normalizedRule) || path === normalizedRule.slice(0, -1)
  }
  return path === normalizedRule
}

export function isForbiddenPath(path: string, forbiddenPaths: readonly string[] = []): boolean {
  const normalized = normalizePath(path)
  if (
    normalized.includes('\0') ||
    normalized.split('/').includes('..') ||
    /^(?:[a-z]:|\/)/.test(normalized)
  ) {
    return true
  }
  return [...DEFAULT_FORBIDDEN_PREFIXES, ...DEFAULT_FORBIDDEN_FILES, ...forbiddenPaths].some(
    (rule) => matchesPath(normalized, rule),
  )
}

function isTaskGraphValid(
  tasks: BrainOutputMap['plan']['task_graph'],
  existingTaskIds: readonly string[] = [],
): boolean {
  const nodes = new Map(tasks.map((task) => [task.id, { pending: 0, dependents: [] as string[] }]))
  if (nodes.size !== tasks.length) return false
  const existing = new Set(existingTaskIds)
  for (const task of tasks) {
    const node = nodes.get(task.id)!
    for (const dep of task.deps) {
      const parent = nodes.get(dep)
      if (parent) {
        node.pending++
        parent.dependents.push(task.id)
      } else if (!existing.has(dep)) {
        return false
      }
    }
  }
  const ready = [...nodes.values()].filter((node) => node.pending === 0)
  for (const node of ready) {
    for (const id of node.dependents) {
      const dependent = nodes.get(id)!
      dependent.pending--
      if (dependent.pending === 0) ready.push(dependent)
    }
  }
  return ready.length === tasks.length
}

export function evaluatePolicyVetoes<K extends BrainCallType>(
  callType: K,
  parsedOutput: BrainOutputMap[K],
  context?: PolicyVetoContext,
): PolicyVetoResult
export function evaluatePolicyVetoes(
  callType: BrainCallType,
  parsedOutput: BrainOutputMap[BrainCallType],
  context: PolicyVetoContext = {},
): PolicyVetoResult {
  const vetoes = new Set<VetoCode>()
  const check = (condition: boolean, code: VetoCode): void => {
    if (condition) vetoes.add(code)
  }
  const forbidden = (paths: readonly string[]): boolean =>
    paths.some((path) => isForbiddenPath(path, context.forbiddenPaths))

  check(parsedOutput.status === 'ok' && parsedOutput.provenance.length === 0, 'missing-evidence')

  switch (callType) {
    case 'plan': {
      const out = parsedOutput as BrainOutputMap['plan']
      const paths = out.task_graph.flatMap((task) => task.scope)
      const destinations = context.allowedDestinations
      for (const task of out.task_graph) {
        check(task.owner.trim() === '', 'task-missing-owner')
        check(
          task.done.length === 0 || task.done.some((item) => item.trim() === ''),
          'task-missing-dod',
        )
        check(
          (task.new_dependencies?.length ?? 0) > 0 && out.adrs.length === 0,
          'dependency-without-adr',
        )
      }
      check(forbidden(paths), 'forbidden-path')
      check(
        (out.invented_destinations?.length ?? 0) > 0 ||
          (destinations !== undefined &&
            paths.some((path) => !destinations.some((rule) => matchesPath(normalizePath(path), rule)))),
        'invented-destination',
      )
      check(!isTaskGraphValid(out.task_graph, context.existingTaskIds), 'task-graph-invalid')
      break
    }
    case 'answer': {
      const out = parsedOutput as BrainOutputMap['answer']
      check(
        out.actions.some((action) => action.kind === 'waive_criterion'),
        'waive-acceptance-criteria',
      )
      check(
        out.actions.some(
          (action) => action.kind === 'request_edit' && forbidden(action.target_paths ?? []),
        ),
        'forbidden-path',
      )
      break
    }
    case 'unblock': {
      const out = parsedOutput as BrainOutputMap['unblock']
      check(
        (out.waived_severities ?? []).some((severity) => severity === 'S0' || severity === 'S1'),
        's0-s1-waiver',
      )
      check(out.destructive === true, 'destructive-action')
      check(out.policy_override === true, 'policy-override')
      check(
        forbidden([
          ...(out.target_paths ?? []),
          ...(out.split_tasks ?? []).flatMap((task) => task.scope),
        ]),
        'forbidden-path',
      )
      check(
        out.action === 'retry_with_change' && (out.root_cause.trim() === '' || !out.retry_change?.trim()),
        'retry-without-cause-or-change',
      )
      check(
        (out.status === 'insufficient_evidence' || out.action === 'ask_question') &&
          (out.question === null ||
            out.question.trim() === '' ||
            (out.question.match(/\?/g) ?? []).length > 1),
        'insufficient-evidence-without-single-question',
      )
      break
    }
    case 'triage': {
      const out = parsedOutput as BrainOutputMap['triage']
      check(
        out.bugs.some(
          (bug) => bug.original_severity !== undefined &&
            bug.severity > bug.original_severity && bug.evidence_refs.length === 0,
        ),
        'downgrade-without-evidence',
      )
      check(
        out.waivers.some((waiver) => waiver.severity === 'S0' || waiver.severity === 'S1'),
        's0-s1-waiver',
      )
      check((out.qa_test_edits?.length ?? 0) > 0, 'qa-test-edit')
      check(forbidden(out.qa_test_edits ?? []), 'forbidden-path')
      break
    }
    case 'arbitrate': {
      const out = parsedOutput as BrainOutputMap['arbitrate']
      check(out.ruling === 'approve' && out.violates_adr === true, 'approve-against-adr')
      check(
        out.ruling === 'approve' && (out.risk ?? context.risk) === 'high' && out.lead_reviewed !== true,
        'high-risk-without-lead-review',
      )
      break
    }
    case 'change-impact': {
      const out = parsedOutput as BrainOutputMap['change-impact']
      check(
        out.breaks_contract === true && (!out.adr_required || (out.decision === 'proceed' && !out.adr)),
        'silent-contract-break',
      )
      check(
        (out.new_dependencies?.length ?? 0) > 0 && (!out.adr_required || !out.adr),
        'dependency-without-adr',
      )
      check(forbidden(out.affected_paths), 'forbidden-path')
      break
    }
    case 'milestone-review': {
      const out = parsedOutput as BrainOutputMap['milestone-review']
      check(
        out.complete && (out.open_s0_s1_count ?? context.openS0S1Count ?? 0) > 0,
        'complete-with-open-s0-s1',
      )
      check(
        out.complete && ((out.missing_evidence?.length ?? 0) > 0 || (context.missingEvidence?.length ?? 0) > 0),
        'complete-with-missing-evidence',
      )
      break
    }
  }

  const sorted = [...vetoes].sort()
  return { allowed: sorted.length === 0, vetoes: sorted }
}
