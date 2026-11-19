import { describe, expect, it } from 'vitest'
import type { BrainCallType, BrainOutputMap, Severity } from '../supervisor/src/brain/schemas.ts'
import {
  DEFAULT_FORBIDDEN_FILES,
  DEFAULT_FORBIDDEN_PREFIXES,
  evaluatePolicyVetoes,
  isForbiddenPath,
  type PolicyVetoContext,
  type VetoCode,
} from '../supervisor/src/brain/policy-veto.ts'

function task(id: string, deps: string[] = []): BrainOutputMap['plan']['task_graph'][number] {
  return { id, deps, title: id, owner: 'builder', scope: ['src/run.ts'], done: ['Checks pass'] }
}

const envelope = {
  schema_version: 1 as const,
  call_id: 'boundary-check',
  status: 'ok' as const,
  provenance: [{ source: 'spec', ref: 'M8-03', claim: 'Frozen policy rules' }],
  confidence: 1,
  policy_check: { allowed: true, vetoes: [] },
}

const fixtures: BrainOutputMap = {
  plan: {
    ...envelope, assumptions: [], adrs: [], task_graph: [task('A')],
    golden_choice: null, escalation: null,
  },
  answer: { ...envelope, answer: null, actions: [], evidence_needed: [], escalation: null },
  unblock: {
    ...envelope, root_cause: '', evidence: [], action: 'continue', question: null, stop: false,
  },
  triage: { ...envelope, bugs: [], clusters: [], priority_order: [], reopened_tasks: [], waivers: [] },
  arbitrate: {
    ...envelope, ruling: 'approve', reasoning_summary: '', required_changes: [],
    accepted_findings: [], escalation: null,
  },
  'change-impact': {
    ...envelope, impact: '', affected_tasks: [], affected_paths: [], adr_required: false,
    migration_steps: [], risk: 'low', decision: 'proceed',
  },
  'milestone-review': {
    ...envelope, health: 'green', complete: true, drift_tasks: [], adr_updates: [],
    release_blockers: [], next_milestone: null,
  },
}

function output<K extends BrainCallType>(
  callType: K,
  changes: Partial<BrainOutputMap[K]> = {},
): BrainOutputMap[K] {
  return { ...structuredClone(fixtures[callType]), ...changes }
}

const allowed = { allowed: true, vetoes: [] }
const denied = (...vetoes: VetoCode[]) => ({ allowed: false, vetoes })
const adr = { title: 'Migration', decision: 'Approve migration', consequences: [] }

describe('M8-03 policy boundary coverage', () => {
  describe('path matching', () => {
    it.each([
      '././Z:relative.ts', '.\\.\\a:relative.ts', '././\\root.txt',
      '..', 'src/..', '.\\.\\..\\outside.ts', 'src/a\0b.ts', 'src//./../run.ts',
      '//etc/passwd', '/./etc/passwd', '\\\\server\\share', '/abs/path', '/.',
    ])('rejects unsafe normalized path %j', (path) => {
      expect(isForbiddenPath(path)).toBe(true)
      expect(evaluatePolicyVetoes('unblock', output('unblock', { target_paths: [path] })))
        .toEqual(denied('forbidden-path'))
    })

    it.each([
      'tests/./protected/m8-policy-veto.spec.ts', 'tests//protected/m8-policy-veto.spec.ts',
      'tests\\.\\qa\\smoke.spec.ts', 'schemas/./brain/plan.json', '.factory//state.json',
      'tests////protected/foo.ts', '././tests/./protected/.',
      'tests/protected', 'tests/qa', 'schemas', '.factory', 'licenses', 'tests/protected/.',
      'tests/protected/', 'source_manifest.json/.',
    ])('rejects protected path %j', (path) => {
      expect(isForbiddenPath(path)).toBe(true)
      expect(evaluatePolicyVetoes('unblock', output('unblock', { target_paths: [path] })))
        .toEqual(denied('forbidden-path'))
    })

    it.each([
      'src/.../run.ts', 'src/..config/run.ts', 'src/c:notes.ts', '0:notes.ts',
      'src/./run.ts', '', './', '.', 'tests/protected-utils/helper.ts', 'schemas-docs/readme.md',
    ])('does not reject non-traversal relative path %j', (path) => {
      expect(isForbiddenPath(path)).toBe(false)
    })

    it('keeps prefix roots and exact files distinct from similarly named paths', () => {
      for (const prefix of DEFAULT_FORBIDDEN_PREFIXES) {
        expect(isForbiddenPath(prefix)).toBe(true)
        expect(isForbiddenPath(`${prefix.slice(0, -1)}-copy/file.ts`)).toBe(false)
        expect(isForbiddenPath(`src/${prefix}file.ts`)).toBe(false)
      }
      for (const file of DEFAULT_FORBIDDEN_FILES) {
        expect(isForbiddenPath(`${file}.bak`)).toBe(false)
        expect(isForbiddenPath(`${file}/child.ts`)).toBe(false)
        expect(isForbiddenPath(`src/${file}`)).toBe(false)
      }
    })

    it('normalizes custom directory rules and preserves exact-file boundaries', () => {
      const rules = ['././CUSTOM\\.\\LOCKED//', '.\\.\\Config\\Secret.json']
      expect(isForbiddenPath('custom/locked/a.ts', rules)).toBe(true)
      expect(isForbiddenPath('custom/locked/', rules)).toBe(true)
      expect(isForbiddenPath('custom/locked', rules)).toBe(true)
      expect(isForbiddenPath('CUSTOM/locked-copy/a.ts', rules)).toBe(false)
      expect(isForbiddenPath('./CONFIG/SECRET.JSON', rules)).toBe(true)
      expect(isForbiddenPath('config/secret.json.bak', rules)).toBe(false)
      expect(isForbiddenPath('config/secret.json/child', rules)).toBe(false)
      expect(isForbiddenPath('src/config/secret.json', rules)).toBe(false)
    })
  })

  describe('plan destinations and task graphs', () => {
    it.each(['src/./run.ts', 'src//run.ts', './src/././run.ts'])
      ('allows equivalent spellings of an exact destination: %j', (path) => {
        const plan = output('plan', { task_graph: [{ ...task('A'), scope: [path] }] })
        expect(evaluatePolicyVetoes('plan', plan, { allowedDestinations: ['src/run.ts'] })).toEqual(allowed)
      })

    it('allows the root of a directory destination', () => {
      const plan = output('plan', { task_graph: [{ ...task('A'), scope: ['src'] }] })
      expect(evaluatePolicyVetoes('plan', plan, { allowedDestinations: ['src/'] })).toEqual(allowed)
      expect(evaluatePolicyVetoes('plan', plan, { allowedDestinations: ['src-other/'] }))
        .toEqual(denied('invented-destination'))
    })

    it('allows normalized directory destinations and rejects adjacent or file descendants', () => {
      const plan = output('plan')
      expect(evaluatePolicyVetoes('plan', plan, { allowedDestinations: ['././SRC\\'] })).toEqual(allowed)
      expect(evaluatePolicyVetoes('plan', plan, { allowedDestinations: ['.\\SRC\\RUN.TS'] })).toEqual(allowed)
      for (const destination of ['src/run.ts.bak', 'src/run', 'src-other/']) {
        expect(evaluatePolicyVetoes('plan', plan, { allowedDestinations: [destination] }))
          .toEqual(denied('invented-destination'))
      }
      plan.task_graph[0]!.scope = ['src/run.ts/child']
      expect(evaluatePolicyVetoes('plan', plan, { allowedDestinations: ['src/run.ts'] }))
        .toEqual(denied('invented-destination'))
    })

    it('treats an empty allowlist as restrictive and never lets it override forbidden paths', () => {
      expect(evaluatePolicyVetoes('plan', output('plan'), { allowedDestinations: [] }))
        .toEqual(denied('invented-destination'))
      expect(evaluatePolicyVetoes('plan', output('plan', { task_graph: [] }), { allowedDestinations: [] }))
        .toEqual(allowed)
      const plan = output('plan')
      plan.task_graph[0]!.scope = ['TESTS\\PROTECTED\\case.ts']
      expect(evaluatePolicyVetoes('plan', plan, { allowedDestinations: ['tests/protected/'] }))
        .toEqual(denied('forbidden-path'))
    })

    it('allows empty optional declarations and dependencies backed by an ADR', () => {
      const plan = output('plan', { invented_destinations: [] })
      plan.task_graph[0]!.new_dependencies = []
      expect(evaluatePolicyVetoes('plan', plan)).toEqual(allowed)
      plan.task_graph[0]!.new_dependencies = ['new-package']
      plan.adrs = [adr]
      expect(evaluatePolicyVetoes('plan', plan)).toEqual(allowed)
      plan.task_graph[0]!.owner = ''
      plan.task_graph[0]!.done = ['']
      expect(evaluatePolicyVetoes('plan', plan)).toEqual(denied('task-missing-dod', 'task-missing-owner'))
    })

    it('accepts unordered diamond graphs, repeated edges, external dependencies, and special IDs', () => {
      const task_graph = [
        task('D', ['B', 'C', 'B']), task('C', ['A']), task('B', ['A']),
        task('A', ['M8-02']), task('__proto__'), task('constructor', ['__proto__']),
      ]
      expect(evaluatePolicyVetoes('plan', output('plan', { task_graph }), { existingTaskIds: ['M8-02'] }))
        .toEqual(allowed)
    })

    it('finds disconnected cycles and never treats local IDs as completed external tasks', () => {
      for (const task_graph of [
        [task('A'), task('B', ['C']), task('C', ['B'])],
        [task('A', ['A'])],
        [task('A'), task('A')],
        [task('A', ['UNKNOWN'])],
      ]) {
        expect(evaluatePolicyVetoes('plan', output('plan', { task_graph }), { existingTaskIds: ['A', 'B', 'C'] }))
          .toEqual(denied('task-graph-invalid'))
      }
    })

    it('checks long dependency chains without overflowing the call stack', () => {
      const task_graph = Array.from({ length: 12000 }, (_, i) =>
        task(String(i), i === 11999 ? [] : [String(i + 1)]),
      )
      expect(evaluatePolicyVetoes('plan', output('plan', { task_graph }))).toEqual(allowed)
      task_graph[11999]!.deps = ['0']
      expect(evaluatePolicyVetoes('plan', output('plan', { task_graph })))
        .toEqual(denied('task-graph-invalid'))
    })
  })

  it('applies custom forbidden paths across all path-bearing call types', () => {
    const path = './CUSTOM\\LOCKED\\file.ts'
    const context = { forbiddenPaths: ['./custom/locked/'] }
    const plan = output('plan')
    plan.task_graph[0]!.scope = [path]
    expect(evaluatePolicyVetoes('plan', plan, context)).toEqual(denied('forbidden-path'))
    expect(evaluatePolicyVetoes('answer', output('answer', {
      actions: [{ kind: 'request_edit', detail: '', target_paths: [path] }],
    }), context)).toEqual(denied('forbidden-path'))
    expect(evaluatePolicyVetoes('unblock', output('unblock', { target_paths: [path] }), context))
      .toEqual(denied('forbidden-path'))
    expect(evaluatePolicyVetoes('unblock', output('unblock', {
      split_tasks: [{ title: '', scope: [path], done: [] }],
    }), context)).toEqual(denied('forbidden-path'))
    expect(evaluatePolicyVetoes('triage', output('triage', { qa_test_edits: [path] }), context))
      .toEqual(denied('forbidden-path', 'qa-test-edit'))
    expect(evaluatePolicyVetoes('change-impact', output('change-impact', { affected_paths: [path] }), context))
      .toEqual(denied('forbidden-path'))
  })

  it('only checks answer edit actions for paths and accepts omitted edit targets', () => {
    expect(evaluatePolicyVetoes('answer', output('answer', {
      actions: [
        { kind: 'guide', detail: '', target_paths: ['tests/protected/case.ts'] },
        { kind: 'request_edit', detail: '' },
      ],
    }))).toEqual(allowed)
  })

  describe('unblock boundaries', () => {
    it('requires retry_change when omitted, but allows no retry details for continue', () => {
      expect(evaluatePolicyVetoes('unblock', output('unblock'))).toEqual(allowed)
      expect(evaluatePolicyVetoes('unblock', output('unblock', {
        action: 'retry_with_change', root_cause: 'A failed import',
      }))).toEqual(denied('retry-without-cause-or-change'))
      expect(evaluatePolicyVetoes('unblock', output('unblock', {
        destructive: false, policy_override: false, waived_severities: [], split_tasks: [], target_paths: [],
      }))).toEqual(allowed)
    })

    it.each(['Confirm the target branch', '?Confirm the target branch', 'Confirm\nthe branch?'])
      ('permits a nonblank question with at most one question mark: %j', (question) => {
        expect(evaluatePolicyVetoes('unblock', output('unblock', { action: 'ask_question', question })))
          .toEqual(allowed)
        expect(evaluatePolicyVetoes('unblock', output('unblock', {
          status: 'insufficient_evidence', question, provenance: [],
        }))).toEqual(allowed)
      })

    it('does not enforce question syntax when neither question trigger is present', () => {
      expect(evaluatePolicyVetoes('unblock', output('unblock', { question: 'First? Second?' })))
        .toEqual(allowed)
    })
  })

  describe('triage severity ordering', () => {
    const severities: Severity[] = ['S0', 'S1', 'S2', 'S3', 'S4']
    const downgrades = new Set(['S0:S1', 'S0:S2', 'S0:S3', 'S0:S4', 'S1:S2', 'S1:S3', 'S1:S4', 'S2:S3', 'S2:S4', 'S3:S4'])

    it('checks every severity transition with and without evidence', () => {
      for (const original_severity of severities) {
        for (const severity of severities) {
          const bug = { id: 'B', severity, original_severity, evidence_refs: [], summary: '' }
          expect(evaluatePolicyVetoes('triage', output('triage', { bugs: [bug] })))
            .toEqual(downgrades.has(`${original_severity}:${severity}`) ? denied('downgrade-without-evidence') : allowed)
          expect(evaluatePolicyVetoes('triage', output('triage', {
            bugs: [{ ...bug, evidence_refs: ['trace.log'] }],
          }))).toEqual(allowed)
        }
      }
    })

    it('accepts absent original severity, empty edits, and noncritical waivers', () => {
      expect(evaluatePolicyVetoes('triage', output('triage', {
        bugs: [{ id: 'B', severity: 'S4', evidence_refs: [], summary: '' }],
        qa_test_edits: [],
        waivers: ['S3', 'S4'].map((severity) => ({ bug_id: 'B', severity: severity as Severity, reason: '' })),
      }))).toEqual(allowed)
    })
  })

  it('uses output risk before context risk and requires explicit Lead review for high risk', () => {
    for (const risk of ['low', 'medium'] as const) {
      expect(evaluatePolicyVetoes('arbitrate', output('arbitrate', { risk }), { risk: 'high' }))
        .toEqual(allowed)
    }
    expect(evaluatePolicyVetoes('arbitrate', output('arbitrate'))).toEqual(allowed)
    expect(evaluatePolicyVetoes('arbitrate', output('arbitrate', { risk: 'high' }), { risk: 'low' }))
      .toEqual(denied('high-risk-without-lead-review'))
    expect(evaluatePolicyVetoes('arbitrate', output('arbitrate'), { risk: 'high' }))
      .toEqual(denied('high-risk-without-lead-review'))
  })

  describe('change-impact ADR boundaries', () => {
    it.each<{
      name: string
      changes: Partial<BrainOutputMap['change-impact']>
      vetoes: VetoCode[]
    }>([
      { name: 'declared break waiting for ADR', changes: { breaks_contract: true, adr_required: true, decision: 'require_adr' }, vetoes: [] },
      { name: 'declared break rejected', changes: { breaks_contract: true, adr_required: true, decision: 'reject' }, vetoes: [] },
      { name: 'declared break escalated', changes: { breaks_contract: true, adr_required: true, decision: 'escalate' }, vetoes: [] },
      { name: 'break proceeding without optional ADR', changes: { breaks_contract: true, adr_required: true }, vetoes: ['silent-contract-break'] },
      { name: 'break with ADR but no declaration', changes: { breaks_contract: true, adr }, vetoes: ['silent-contract-break'] },
      { name: 'dependency with declaration but no ADR', changes: { new_dependencies: ['pkg'], adr_required: true }, vetoes: ['dependency-without-adr'] },
      { name: 'dependency with ADR but no declaration', changes: { new_dependencies: ['pkg'], adr }, vetoes: ['dependency-without-adr'] },
      { name: 'empty dependencies', changes: { new_dependencies: [], adr: null }, vetoes: [] },
      { name: 'both ADR rules violated', changes: { breaks_contract: true, new_dependencies: ['pkg'] }, vetoes: ['dependency-without-adr', 'silent-contract-break'] },
    ])('$name', ({ changes, vetoes }) => {
      expect(evaluatePolicyVetoes('change-impact', output('change-impact', changes)))
        .toEqual({ allowed: vetoes.length === 0, vetoes })
    })
  })

  it('uses explicit zero counts before context and combines missing evidence independently', () => {
    expect(evaluatePolicyVetoes('milestone-review', output('milestone-review'))).toEqual(allowed)
    for (const count of [0, -1]) {
      expect(evaluatePolicyVetoes('milestone-review', output('milestone-review', {
        open_s0_s1_count: count,
      }), { openS0S1Count: 1 })).toEqual(allowed)
    }
    expect(evaluatePolicyVetoes('milestone-review', output('milestone-review'), { openS0S1Count: 0 }))
      .toEqual(allowed)
    expect(evaluatePolicyVetoes('milestone-review', output('milestone-review', {
      missing_evidence: [],
    }), { missingEvidence: ['test log'] })).toEqual(denied('complete-with-missing-evidence'))
    expect(evaluatePolicyVetoes('milestone-review', output('milestone-review', {
      open_s0_s1_count: 1, missing_evidence: ['test log'],
    }), { openS0S1Count: 0, missingEvidence: [] }))
      .toEqual(denied('complete-with-missing-evidence', 'complete-with-open-s0-s1'))
    expect(evaluatePolicyVetoes('milestone-review', output('milestone-review', {
      complete: false,
    }), { openS0S1Count: 1, missingEvidence: ['test log'] })).toEqual(allowed)
  })

  it('accepts deeply frozen arguments and keeps returned veto arrays independent', () => {
    function freezeDeep(value: unknown): void {
      if (value !== null && typeof value === 'object') {
        Object.values(value).forEach(freezeDeep)
        Object.freeze(value)
      }
    }
    const plan = output('plan')
    const context: PolicyVetoContext = {
      forbiddenPaths: ['src/'], allowedDestinations: ['src/'], existingTaskIds: [],
    }
    freezeDeep(plan)
    freezeDeep(context)
    const first = evaluatePolicyVetoes('plan', plan, context)
    expect(first).toEqual(denied('forbidden-path'))
    first.vetoes.length = 0
    expect(evaluatePolicyVetoes('plan', plan, context)).toEqual(denied('forbidden-path'))
    expect(evaluatePolicyVetoes('plan', plan)).toEqual(allowed)
  })
})
