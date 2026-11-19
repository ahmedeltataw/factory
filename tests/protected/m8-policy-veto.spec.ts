import fc from 'fast-check'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  type BrainCallType,
  type BrainOutputMap,
  type Severity,
  BRAIN_CALL_TYPES,
  BRAIN_SCHEMA_VERSION,
  validateBrainOutput,
} from '../../supervisor/src/brain/schemas.ts'
import {
  DEFAULT_FORBIDDEN_FILES,
  DEFAULT_FORBIDDEN_PREFIXES,
  type PolicyVetoContext,
  type PolicyVetoResult,
  VETO_CODES,
  type VetoCode,
  evaluatePolicyVetoes,
  isForbiddenPath,
} from '../../supervisor/src/brain/policy-veto.ts'

const EXPECTED_VETO_CODES = [
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

const BASE_PROVENANCE = [
  { source: 'spec', ref: 'docs/milestones/M8.md#L106', claim: 'Policy rules are deterministic' },
]

function makeCleanPlan(): BrainOutputMap['plan'] {
  return {
    schema_version: BRAIN_SCHEMA_VERSION,
    call_id: 'call-plan-1',
    status: 'ok',
    provenance: BASE_PROVENANCE,
    confidence: 0.9,
    policy_check: { allowed: true, vetoes: [] },
    assumptions: ['Existing supervisor layout remains stable'],
    adrs: [
      {
        title: 'Use deterministic veto module',
        decision: 'Keep policy checks pure and stateless',
        consequences: ['Easy to property-test'],
      },
    ],
    task_graph: [
      {
        id: 'T1',
        title: 'Implement veto engine',
        owner: 'builder-logic',
        scope: ['supervisor/src/brain/policy-veto.ts'],
        deps: [],
        done: ['All 20 veto codes covered by unit tests'],
      },
      {
        id: 'T2',
        title: 'Add integration tests',
        owner: 'qa',
        scope: ['tests/m8-03-policy-veto.spec.ts'],
        deps: ['T1'],
        done: ['Vitest suite passes'],
      },
    ],
    golden_choice: 'T1 -> T2',
    escalation: null,
  }
}

function makeCleanAnswer(): BrainOutputMap['answer'] {
  return {
    schema_version: BRAIN_SCHEMA_VERSION,
    call_id: 'call-answer-1',
    status: 'ok',
    provenance: BASE_PROVENANCE,
    confidence: 0.88,
    policy_check: { allowed: true, vetoes: [] },
    answer: 'Use pure path normalization in supervisor/src/brain/policy-veto.ts.',
    actions: [
      {
        kind: 'request_edit',
        detail: 'Update policy-veto implementation',
        target_paths: ['supervisor/src/brain/policy-veto.ts'],
      },
    ],
    evidence_needed: [],
    escalation: null,
  }
}

function makeCleanUnblock(): BrainOutputMap['unblock'] {
  return {
    schema_version: BRAIN_SCHEMA_VERSION,
    call_id: 'call-unblock-1',
    status: 'ok',
    provenance: BASE_PROVENANCE,
    confidence: 0.85,
    policy_check: { allowed: true, vetoes: [] },
    root_cause: 'Missing path normalization for backslash separators',
    evidence: [{ source: 'test-log', claim: 'Windows path test failed' }],
    action: 'retry_with_change',
    question: null,
    stop: false,
    retry_change: 'Normalize backslashes before prefix matching',
    target_paths: ['supervisor/src/brain/policy-veto.ts'],
  }
}

function makeCleanTriage(): BrainOutputMap['triage'] {
  return {
    schema_version: BRAIN_SCHEMA_VERSION,
    call_id: 'call-triage-1',
    status: 'ok',
    provenance: BASE_PROVENANCE,
    confidence: 0.92,
    policy_check: { allowed: true, vetoes: [] },
    bugs: [
      {
        id: 'BUG-1',
        severity: 'S2',
        original_severity: 'S2',
        evidence_refs: ['logs/run-1.txt'],
        summary: 'Minor formatting discrepancy',
      },
    ],
    clusters: [{ name: 'formatting', bug_ids: ['BUG-1'] }],
    priority_order: ['BUG-1'],
    reopened_tasks: [],
    waivers: [],
  }
}

function makeCleanArbitrate(): BrainOutputMap['arbitrate'] {
  return {
    schema_version: BRAIN_SCHEMA_VERSION,
    call_id: 'call-arbitrate-1',
    status: 'ok',
    provenance: BASE_PROVENANCE,
    confidence: 0.95,
    policy_check: { allowed: true, vetoes: [] },
    ruling: 'approve',
    reasoning_summary: 'All ADR constraints and review checks satisfied',
    required_changes: [],
    accepted_findings: ['Clean separation of concerns'],
    escalation: null,
    risk: 'medium',
    lead_reviewed: false,
    violates_adr: false,
  }
}

function makeCleanChangeImpact(): BrainOutputMap['change-impact'] {
  return {
    schema_version: BRAIN_SCHEMA_VERSION,
    call_id: 'call-change-impact-1',
    status: 'ok',
    provenance: BASE_PROVENANCE,
    confidence: 0.87,
    policy_check: { allowed: true, vetoes: [] },
    impact: 'Adds pure policy-veto evaluator without touching store schema',
    affected_tasks: ['M8-03'],
    affected_paths: ['supervisor/src/brain/policy-veto.ts'],
    adr_required: false,
    adr: null,
    migration_steps: [],
    risk: 'low',
    decision: 'proceed',
    breaks_contract: false,
  }
}

function makeCleanMilestoneReview(): BrainOutputMap['milestone-review'] {
  return {
    schema_version: BRAIN_SCHEMA_VERSION,
    call_id: 'call-milestone-1',
    status: 'ok',
    provenance: BASE_PROVENANCE,
    confidence: 0.91,
    policy_check: { allowed: true, vetoes: [] },
    health: 'green',
    complete: true,
    drift_tasks: [],
    adr_updates: [],
    release_blockers: [],
    next_milestone: 'M9',
    open_s0_s1_count: 0,
    missing_evidence: [],
  }
}

function makeCleanByType<K extends BrainCallType>(callType: K): BrainOutputMap[K] {
  const map: { [T in BrainCallType]: () => BrainOutputMap[T] } = {
    plan: makeCleanPlan,
    answer: makeCleanAnswer,
    unblock: makeCleanUnblock,
    triage: makeCleanTriage,
    arbitrate: makeCleanArbitrate,
    'change-impact': makeCleanChangeImpact,
    'milestone-review': makeCleanMilestoneReview,
  }
  return map[callType]()
}

describe('M8-03 Deterministic semantic & policy veto engine', () => {
  it('CHK-M8-03-a: exports frozen constants, types, and all 20 veto codes', () => {
    expect(DEFAULT_FORBIDDEN_PREFIXES).toEqual([
      'tests/protected/',
      'tests/qa/',
      'schemas/',
      '.factory/',
      'licenses/',
    ])
    expect(DEFAULT_FORBIDDEN_FILES).toEqual(['source_manifest.json', 'notice', 'license'])
    expect(VETO_CODES).toHaveLength(20)
    expect([...VETO_CODES].sort()).toEqual([...EXPECTED_VETO_CODES].sort())

    expectTypeOf<VetoCode>().toEqualTypeOf<(typeof VETO_CODES)[number]>()
    expectTypeOf<PolicyVetoResult>().toEqualTypeOf<{ allowed: boolean; vetoes: VetoCode[] }>()
    expectTypeOf<PolicyVetoContext>().toMatchTypeOf<{
      forbiddenPaths?: readonly string[]
      allowedDestinations?: readonly string[]
      existingTaskIds?: readonly string[]
      risk?: 'low' | 'medium' | 'high'
      openS0S1Count?: number
      missingEvidence?: readonly string[]
    }>()

    for (const callType of BRAIN_CALL_TYPES) {
      const clean = makeCleanByType(callType)
      expect(validateBrainOutput(callType, clean).ok).toBe(true)
    }
  })

  describe('CHK-M8-03-a: path normalization and isForbiddenPath', () => {
    it('rejects all 5 default prefixes and 3 exact files', () => {
      for (const prefix of DEFAULT_FORBIDDEN_PREFIXES) {
        expect(isForbiddenPath(`${prefix}file.ts`), prefix).toBe(true)
      }
      for (const file of DEFAULT_FORBIDDEN_FILES) {
        expect(isForbiddenPath(file), file).toBe(true)
      }
    })

    it('normalizes backslashes, repeated ./, case, and rejects traversal/null/root/drive/UNC', () => {
      const forbiddenSamples = [
        'tests\\protected\\m8-policy-veto.spec.ts',
        'TESTS/Protected/M8.spec.ts',
        '././tests/qa/smoke.spec.ts',
        '.\\./SCHEMAS/brain/plan.json',
        './.Factory/state.json',
        'Licenses/MIT.txt',
        '././SOURCE_MANIFEST.JSON',
        'Notice',
        './LiCeNsE',
        'src/../tests/protected/x.ts',
        'a/b/../c.ts',
        '../outside.ts',
        'supervisor/src/ok.ts\0.txt',
        '/etc/passwd',
        '/supervisor/src/a.ts',
        'C:/Users/repo/file.ts',
        'd:\\repo\\file.ts',
        '//server/share/file.ts',
        '\\\\server\\share\\file.ts',
      ]
      for (const sample of forbiddenSamples) {
        expect(isForbiddenPath(sample), sample).toBe(true)
      }

      expect(isForbiddenPath('custom\\locked\\secret.ts', ['./CUSTOM/locked/'])).toBe(true)
      expect(isForbiddenPath('config/Keys.json', ['CONFIG/keys.json'])).toBe(true)

      const safeSamples = [
        'supervisor/src/brain/policy-veto.ts',
        './supervisor/src/brain/schemas.ts',
        'tests/m8-03-policy-veto.spec.ts',
        'tests/protected-helper.ts',
        'schemas.ts',
        'src/notice.ts',
        'docs/license-guide.md',
      ]
      for (const safe of safeSamples) {
        expect(isForbiddenPath(safe), safe).toBe(false)
      }
    })
  })

  describe('CHK-M8-03-a: common provenance missing-evidence rule', () => {
    it('vetoes status === ok with empty provenance across all 7 call types, but allows non-ok statuses', () => {
      for (const callType of BRAIN_CALL_TYPES) {
        const okEmpty = makeCleanByType(callType)
        okEmpty.status = 'ok'
        okEmpty.provenance = []
        const res = evaluatePolicyVetoes(callType, okEmpty)
        expect(res.allowed, callType).toBe(false)
        expect(res.vetoes, callType).toContain('missing-evidence')

        const escalateEmpty = makeCleanByType(callType)
        escalateEmpty.status = 'escalate'
        escalateEmpty.provenance = []
        expect(evaluatePolicyVetoes(callType, escalateEmpty).vetoes, callType).not.toContain(
          'missing-evidence',
        )

        const insuffEmpty = makeCleanByType(callType)
        insuffEmpty.status = 'insufficient_evidence'
        insuffEmpty.provenance = []
        if (callType === 'unblock') {
          ;(insuffEmpty as BrainOutputMap['unblock']).question = 'Which file should be inspected?'
        }
        expect(evaluatePolicyVetoes(callType, insuffEmpty).vetoes, callType).not.toContain(
          'missing-evidence',
        )
      }
    })
  })

  describe('CHK-M8-03-a: plan veto rules', () => {
    it('enforces task-missing-owner, task-missing-dod, dependency-without-adr, invented-destination, forbidden-path, and task-graph-invalid', () => {
      const missingOwner = makeCleanPlan()
      missingOwner.task_graph[0]!.owner = '   '
      expect(evaluatePolicyVetoes('plan', missingOwner)).toEqual({
        allowed: false,
        vetoes: ['task-missing-owner'],
      })

      const emptyDone = makeCleanPlan()
      emptyDone.task_graph[0]!.done = []
      expect(evaluatePolicyVetoes('plan', emptyDone)).toEqual({
        allowed: false,
        vetoes: ['task-missing-dod'],
      })

      const blankDoneItem = makeCleanPlan()
      blankDoneItem.task_graph[1]!.done = ['valid', '  \t ']
      expect(evaluatePolicyVetoes('plan', blankDoneItem)).toEqual({
        allowed: false,
        vetoes: ['task-missing-dod'],
      })

      const depNoAdr = makeCleanPlan()
      depNoAdr.adrs = []
      depNoAdr.task_graph[0]!.new_dependencies = ['lodash']
      expect(evaluatePolicyVetoes('plan', depNoAdr)).toEqual({
        allowed: false,
        vetoes: ['dependency-without-adr'],
      })

      const inventedField = makeCleanPlan()
      inventedField.invented_destinations = ['supervisor/src/magic/new-dir']
      expect(evaluatePolicyVetoes('plan', inventedField)).toEqual({
        allowed: false,
        vetoes: ['invented-destination'],
      })

      const outsideAllowed = makeCleanPlan()
      expect(
        evaluatePolicyVetoes('plan', outsideAllowed, {
          allowedDestinations: ['supervisor/src/brain/policy-veto.ts'],
        }),
      ).toEqual({
        allowed: false,
        vetoes: ['invented-destination'],
      })

      expect(
        evaluatePolicyVetoes('plan', outsideAllowed, {
          allowedDestinations: [
            'supervisor/src/brain/policy-veto.ts',
            'tests/m8-03-policy-veto.spec.ts',
          ],
        }),
      ).toEqual({ allowed: true, vetoes: [] })

      const forbiddenPlan = makeCleanPlan()
      forbiddenPlan.task_graph[0]!.scope = ['TESTS\\Protected\\m8-policy-veto.spec.ts']
      expect(evaluatePolicyVetoes('plan', forbiddenPlan)).toEqual({
        allowed: false,
        vetoes: ['forbidden-path'],
      })

      const contextForbiddenPlan = makeCleanPlan()
      expect(
        evaluatePolicyVetoes('plan', contextForbiddenPlan, {
          forbiddenPaths: ['supervisor/src/brain/'],
        }),
      ).toEqual({
        allowed: false,
        vetoes: ['forbidden-path'],
      })
    })

    it('validates task_graph duplicates, dangling deps, existingTaskIds, self-cycle, 2-node and 3-node cycles', () => {
      const duplicateId = makeCleanPlan()
      duplicateId.task_graph[1]!.id = 'T1'
      expect(evaluatePolicyVetoes('plan', duplicateId)).toEqual({
        allowed: false,
        vetoes: ['task-graph-invalid'],
      })

      const danglingDep = makeCleanPlan()
      danglingDep.task_graph[1]!.deps = ['T999']
      expect(evaluatePolicyVetoes('plan', danglingDep)).toEqual({
        allowed: false,
        vetoes: ['task-graph-invalid'],
      })

      const existingDep = makeCleanPlan()
      existingDep.task_graph[0]!.deps = ['M8-02']
      expect(
        evaluatePolicyVetoes('plan', existingDep, { existingTaskIds: ['M8-02'] }),
      ).toEqual({ allowed: true, vetoes: [] })

      const selfCycle = makeCleanPlan()
      selfCycle.task_graph[0]!.deps = ['T1']
      expect(evaluatePolicyVetoes('plan', selfCycle)).toEqual({
        allowed: false,
        vetoes: ['task-graph-invalid'],
      })

      const twoNodeCycle = makeCleanPlan()
      twoNodeCycle.task_graph[0]!.deps = ['T2']
      twoNodeCycle.task_graph[1]!.deps = ['T1']
      expect(evaluatePolicyVetoes('plan', twoNodeCycle)).toEqual({
        allowed: false,
        vetoes: ['task-graph-invalid'],
      })

      const threeNodeCycle = makeCleanPlan()
      threeNodeCycle.task_graph = [
        {
          id: 'A',
          title: 'Task A',
          owner: 'builder-logic',
          scope: ['supervisor/src/a.ts'],
          deps: ['C'],
          done: ['A done'],
        },
        {
          id: 'B',
          title: 'Task B',
          owner: 'builder-logic',
          scope: ['supervisor/src/b.ts'],
          deps: ['A'],
          done: ['B done'],
        },
        {
          id: 'C',
          title: 'Task C',
          owner: 'builder-logic',
          scope: ['supervisor/src/c.ts'],
          deps: ['B'],
          done: ['C done'],
        },
      ]
      expect(evaluatePolicyVetoes('plan', threeNodeCycle)).toEqual({
        allowed: false,
        vetoes: ['task-graph-invalid'],
      })
    })
  })

  describe('CHK-M8-03-a: answer veto rules', () => {
    it('enforces forbidden-path via request_edit and waive-acceptance-criteria', () => {
      const forbiddenEdit = makeCleanAnswer()
      forbiddenEdit.actions = [
        {
          kind: 'request_edit',
          detail: 'Edit protected spec',
          target_paths: ['tests/protected/m8-policy-veto.spec.ts'],
        },
      ]
      expect(evaluatePolicyVetoes('answer', forbiddenEdit)).toEqual({
        allowed: false,
        vetoes: ['forbidden-path'],
      })

      const waive = makeCleanAnswer()
      waive.actions = [{ kind: 'waive_criterion', detail: 'Skip CHK-M8-03-c' }]
      expect(evaluatePolicyVetoes('answer', waive)).toEqual({
        allowed: false,
        vetoes: ['waive-acceptance-criteria'],
      })
    })
  })

  describe('CHK-M8-03-a: unblock veto rules', () => {
    it('enforces s0-s1-waiver (S0/S1 vetoed, S2/S3/S4 allowed), destructive-action, policy-override, forbidden-path, retry-without-cause-or-change', () => {
      for (const sev of ['S0', 'S1'] as const) {
        const out = makeCleanUnblock()
        out.waived_severities = [sev]
        expect(evaluatePolicyVetoes('unblock', out), sev).toEqual({
          allowed: false,
          vetoes: ['s0-s1-waiver'],
        })
      }

      for (const sev of ['S2', 'S3', 'S4'] as const) {
        const out = makeCleanUnblock()
        out.waived_severities = [sev]
        expect(evaluatePolicyVetoes('unblock', out), sev).toEqual({
          allowed: true,
          vetoes: [],
        })
      }

      const destructive = makeCleanUnblock()
      destructive.destructive = true
      expect(evaluatePolicyVetoes('unblock', destructive)).toEqual({
        allowed: false,
        vetoes: ['destructive-action'],
      })

      const override = makeCleanUnblock()
      override.policy_override = true
      expect(evaluatePolicyVetoes('unblock', override)).toEqual({
        allowed: false,
        vetoes: ['policy-override'],
      })

      const targetForbidden = makeCleanUnblock()
      targetForbidden.target_paths = ['.factory/evidence/run.json']
      expect(evaluatePolicyVetoes('unblock', targetForbidden)).toEqual({
        allowed: false,
        vetoes: ['forbidden-path'],
      })

      const splitForbidden = makeCleanUnblock()
      splitForbidden.action = 'split_task'
      splitForbidden.retry_change = null
      splitForbidden.split_tasks = [
        { title: 'Subtask', scope: ['schemas/brain/unblock.json'], done: ['Done'] },
      ]
      expect(evaluatePolicyVetoes('unblock', splitForbidden)).toEqual({
        allowed: false,
        vetoes: ['forbidden-path'],
      })

      const blankCause = makeCleanUnblock()
      blankCause.root_cause = '   '
      expect(evaluatePolicyVetoes('unblock', blankCause)).toEqual({
        allowed: false,
        vetoes: ['retry-without-cause-or-change'],
      })

      const blankChange = makeCleanUnblock()
      blankChange.retry_change = '  '
      expect(evaluatePolicyVetoes('unblock', blankChange)).toEqual({
        allowed: false,
        vetoes: ['retry-without-cause-or-change'],
      })

      const nullChange = makeCleanUnblock()
      nullChange.retry_change = null
      expect(evaluatePolicyVetoes('unblock', nullChange)).toEqual({
        allowed: false,
        vetoes: ['retry-without-cause-or-change'],
      })
    })

    it('enforces insufficient-evidence-without-single-question for null, whitespace, and 2+ ? characters, allowing single ?', () => {
      const badQuestions: Array<string | null> = [
        null,
        '',
        '   \t\n ',
        'First question? Second question?',
        'What??',
      ]

      for (const question of badQuestions) {
        const viaStatus = makeCleanUnblock()
        viaStatus.status = 'insufficient_evidence'
        viaStatus.provenance = []
        viaStatus.action = 'continue'
        viaStatus.question = question
        expect(evaluatePolicyVetoes('unblock', viaStatus)).toEqual({
          allowed: false,
          vetoes: ['insufficient-evidence-without-single-question'],
        })

        const viaAction = makeCleanUnblock()
        viaAction.status = 'ok'
        viaAction.action = 'ask_question'
        viaAction.question = question
        expect(evaluatePolicyVetoes('unblock', viaAction)).toEqual({
          allowed: false,
          vetoes: ['insufficient-evidence-without-single-question'],
        })
      }

      const singleQuestionStatus = makeCleanUnblock()
      singleQuestionStatus.status = 'insufficient_evidence'
      singleQuestionStatus.provenance = []
      singleQuestionStatus.action = 'continue'
      singleQuestionStatus.question = 'Which dependency version should be pinned?'
      expect(evaluatePolicyVetoes('unblock', singleQuestionStatus)).toEqual({
        allowed: true,
        vetoes: [],
      })

      const singleQuestionAction = makeCleanUnblock()
      singleQuestionAction.status = 'ok'
      singleQuestionAction.action = 'ask_question'
      singleQuestionAction.question = 'Should the retry target branch main?'
      expect(evaluatePolicyVetoes('unblock', singleQuestionAction)).toEqual({
        allowed: true,
        vetoes: [],
      })
    })
  })

  describe('CHK-M8-03-a: triage veto rules', () => {
    it('enforces downgrade-without-evidence, s0-s1-waiver, and qa-test-edit', () => {
      const downgrades: Array<[Severity, Severity]> = [
        ['S0', 'S1'],
        ['S0', 'S2'],
        ['S0', 'S3'],
        ['S0', 'S4'],
        ['S1', 'S2'],
        ['S2', 'S3'],
        ['S3', 'S4'],
      ]
      for (const [orig, next] of downgrades) {
        const out = makeCleanTriage()
        out.bugs = [
          {
            id: 'B1',
            original_severity: orig,
            severity: next,
            evidence_refs: [],
            summary: 'Downgraded',
          },
        ]
        expect(evaluatePolicyVetoes('triage', out), `${orig}->${next}`).toEqual({
          allowed: false,
          vetoes: ['downgrade-without-evidence'],
        })
      }

      const downgradeWithEvidence = makeCleanTriage()
      downgradeWithEvidence.bugs = [
        {
          id: 'B1',
          original_severity: 'S0',
          severity: 'S2',
          evidence_refs: ['artifacts/trace.log'],
          summary: 'Verified lower impact',
        },
      ]
      expect(evaluatePolicyVetoes('triage', downgradeWithEvidence)).toEqual({
        allowed: true,
        vetoes: [],
      })

      const equalNoEvidence = makeCleanTriage()
      equalNoEvidence.bugs = [
        {
          id: 'B2',
          original_severity: 'S1',
          severity: 'S1',
          evidence_refs: [],
          summary: 'Unchanged severity',
        },
      ]
      expect(evaluatePolicyVetoes('triage', equalNoEvidence)).toEqual({
        allowed: true,
        vetoes: [],
      })

      const upgradeNoEvidence = makeCleanTriage()
      upgradeNoEvidence.bugs = [
        {
          id: 'B3',
          original_severity: 'S3',
          severity: 'S1',
          evidence_refs: [],
          summary: 'Escalated severity',
        },
      ]
      expect(evaluatePolicyVetoes('triage', upgradeNoEvidence)).toEqual({
        allowed: true,
        vetoes: [],
      })

      for (const sev of ['S0', 'S1'] as const) {
        const waived = makeCleanTriage()
        waived.waivers = [{ bug_id: 'B1', severity: sev, reason: 'Defer' }]
        expect(evaluatePolicyVetoes('triage', waived), sev).toEqual({
          allowed: false,
          vetoes: ['s0-s1-waiver'],
        })
      }

      const s2Waived = makeCleanTriage()
      s2Waived.waivers = [{ bug_id: 'B1', severity: 'S2', reason: 'Post-MVP' }]
      expect(evaluatePolicyVetoes('triage', s2Waived)).toEqual({
        allowed: true,
        vetoes: [],
      })

      const qaEdit = makeCleanTriage()
      qaEdit.qa_test_edits = ['tests/m8-03-smoke.spec.ts']
      expect(evaluatePolicyVetoes('triage', qaEdit)).toEqual({
        allowed: false,
        vetoes: ['qa-test-edit'],
      })

      const qaForbiddenEdit = makeCleanTriage()
      qaForbiddenEdit.qa_test_edits = ['tests/qa/smoke.spec.ts']
      const qaForbiddenRes = evaluatePolicyVetoes('triage', qaForbiddenEdit)
      expect(qaForbiddenRes.allowed).toBe(false)
      expect(qaForbiddenRes.vetoes).toContain('qa-test-edit')
    })
  })

  describe('CHK-M8-03-a: arbitrate veto rules', () => {
    it('enforces approve-against-adr and high-risk-without-lead-review', () => {
      const againstAdr = makeCleanArbitrate()
      againstAdr.ruling = 'approve'
      againstAdr.violates_adr = true
      expect(evaluatePolicyVetoes('arbitrate', againstAdr)).toEqual({
        allowed: false,
        vetoes: ['approve-against-adr'],
      })

      const rejectAgainstAdr = makeCleanArbitrate()
      rejectAgainstAdr.ruling = 'request_changes'
      rejectAgainstAdr.violates_adr = true
      expect(evaluatePolicyVetoes('arbitrate', rejectAgainstAdr)).toEqual({
        allowed: true,
        vetoes: [],
      })

      const highRiskOutput = makeCleanArbitrate()
      highRiskOutput.ruling = 'approve'
      highRiskOutput.risk = 'high'
      highRiskOutput.lead_reviewed = false
      expect(evaluatePolicyVetoes('arbitrate', highRiskOutput)).toEqual({
        allowed: false,
        vetoes: ['high-risk-without-lead-review'],
      })

      const highRiskContext = makeCleanArbitrate()
      delete highRiskContext.risk
      highRiskContext.ruling = 'approve'
      highRiskContext.lead_reviewed = false
      expect(
        evaluatePolicyVetoes('arbitrate', highRiskContext, { risk: 'high' }),
      ).toEqual({
        allowed: false,
        vetoes: ['high-risk-without-lead-review'],
      })

      const highRiskReviewed = makeCleanArbitrate()
      highRiskReviewed.ruling = 'approve'
      highRiskReviewed.risk = 'high'
      highRiskReviewed.lead_reviewed = true
      expect(evaluatePolicyVetoes('arbitrate', highRiskReviewed)).toEqual({
        allowed: true,
        vetoes: [],
      })

      const highRiskEscalate = makeCleanArbitrate()
      highRiskEscalate.ruling = 'escalate'
      highRiskEscalate.risk = 'high'
      highRiskEscalate.lead_reviewed = false
      expect(evaluatePolicyVetoes('arbitrate', highRiskEscalate)).toEqual({
        allowed: true,
        vetoes: [],
      })
    })
  })

  describe('CHK-M8-03-a: change-impact veto rules', () => {
    it('enforces silent-contract-break, dependency-without-adr, and forbidden-path', () => {
      const breakNoAdrReq = makeCleanChangeImpact()
      breakNoAdrReq.breaks_contract = true
      breakNoAdrReq.adr_required = false
      breakNoAdrReq.decision = 'require_adr'
      expect(evaluatePolicyVetoes('change-impact', breakNoAdrReq)).toEqual({
        allowed: false,
        vetoes: ['silent-contract-break'],
      })

      const breakProceedNoAdr = makeCleanChangeImpact()
      breakProceedNoAdr.breaks_contract = true
      breakProceedNoAdr.adr_required = true
      breakProceedNoAdr.decision = 'proceed'
      breakProceedNoAdr.adr = null
      expect(evaluatePolicyVetoes('change-impact', breakProceedNoAdr)).toEqual({
        allowed: false,
        vetoes: ['silent-contract-break'],
      })

      const breakWithAdr = makeCleanChangeImpact()
      breakWithAdr.breaks_contract = true
      breakWithAdr.adr_required = true
      breakWithAdr.decision = 'proceed'
      breakWithAdr.adr = {
        title: 'Contract migration',
        decision: 'Bump version to v2',
        consequences: ['Clients must upgrade'],
      }
      expect(evaluatePolicyVetoes('change-impact', breakWithAdr)).toEqual({
        allowed: true,
        vetoes: [],
      })

      const depNoAdr = makeCleanChangeImpact()
      depNoAdr.new_dependencies = ['zod-ext']
      depNoAdr.adr_required = false
      depNoAdr.adr = null
      expect(evaluatePolicyVetoes('change-impact', depNoAdr)).toEqual({
        allowed: false,
        vetoes: ['dependency-without-adr'],
      })

      const depWithAdr = makeCleanChangeImpact()
      depWithAdr.new_dependencies = ['zod-ext']
      depWithAdr.adr_required = true
      depWithAdr.adr = {
        title: 'Add zod-ext',
        decision: 'Approve dependency',
        consequences: ['Minimal footprint'],
      }
      expect(evaluatePolicyVetoes('change-impact', depWithAdr)).toEqual({
        allowed: true,
        vetoes: [],
      })

      const forbiddenImpact = makeCleanChangeImpact()
      forbiddenImpact.affected_paths = ['licenses/MIT']
      expect(evaluatePolicyVetoes('change-impact', forbiddenImpact)).toEqual({
        allowed: false,
        vetoes: ['forbidden-path'],
      })
    })
  })

  describe('CHK-M8-03-a: milestone-review veto rules', () => {
    it('enforces complete-with-open-s0-s1 and complete-with-missing-evidence via output and context', () => {
      const openOutput = makeCleanMilestoneReview()
      openOutput.complete = true
      openOutput.open_s0_s1_count = 2
      expect(evaluatePolicyVetoes('milestone-review', openOutput)).toEqual({
        allowed: false,
        vetoes: ['complete-with-open-s0-s1'],
      })

      const openContext = makeCleanMilestoneReview()
      delete openContext.open_s0_s1_count
      openContext.complete = true
      expect(
        evaluatePolicyVetoes('milestone-review', openContext, { openS0S1Count: 1 }),
      ).toEqual({
        allowed: false,
        vetoes: ['complete-with-open-s0-s1'],
      })

      const incompleteOpen = makeCleanMilestoneReview()
      incompleteOpen.complete = false
      incompleteOpen.open_s0_s1_count = 3
      expect(evaluatePolicyVetoes('milestone-review', incompleteOpen)).toEqual({
        allowed: true,
        vetoes: [],
      })

      const missingOut = makeCleanMilestoneReview()
      missingOut.complete = true
      missingOut.missing_evidence = ['M8-03 test output']
      expect(evaluatePolicyVetoes('milestone-review', missingOut)).toEqual({
        allowed: false,
        vetoes: ['complete-with-missing-evidence'],
      })

      const missingCtx = makeCleanMilestoneReview()
      missingCtx.complete = true
      expect(
        evaluatePolicyVetoes('milestone-review', missingCtx, {
          missingEvidence: ['acceptance/M8.ps1 log'],
        }),
      ).toEqual({
        allowed: false,
        vetoes: ['complete-with-missing-evidence'],
      })

      const incompleteMissing = makeCleanMilestoneReview()
      incompleteMissing.complete = false
      incompleteMissing.missing_evidence = ['M8-03']
      expect(evaluatePolicyVetoes('milestone-review', incompleteMissing)).toEqual({
        allowed: true,
        vetoes: [],
      })
    })

    it('deduplicates and lexicographically sorts triggered veto codes', () => {
      const multi = makeCleanPlan()
      multi.provenance = []
      multi.adrs = []
      multi.invented_destinations = ['foo/bar']
      multi.task_graph = [
        {
          id: 'T1',
          title: 'Bad 1',
          owner: '',
          scope: ['tests/protected/a.ts', 'schemas/b.json'],
          deps: ['MISSING'],
          done: [],
          new_dependencies: ['dep1'],
        },
        {
          id: 'T1',
          title: 'Bad 2',
          owner: '  ',
          scope: ['.factory/c.db'],
          deps: ['T1'],
          done: ['  '],
          new_dependencies: ['dep2'],
        },
      ]
      const res = evaluatePolicyVetoes('plan', multi)
      expect(res.allowed).toBe(false)
      expect(res.vetoes).toEqual([
        'dependency-without-adr',
        'forbidden-path',
        'invented-destination',
        'missing-evidence',
        'task-graph-invalid',
        'task-missing-dod',
        'task-missing-owner',
      ])
      expect(new Set(res.vetoes).size).toBe(res.vetoes.length)
      expect([...res.vetoes].sort()).toEqual(res.vetoes)
    })
  })

  describe('CHK-M8-03-b: pure, stateless, and authoritative over model policy_check', () => {
    it('overrides optimistic model policy_check when violations exist and overrides pessimistic policy_check on clean outputs', () => {
      const violated = makeCleanUnblock()
      violated.policy_check = { allowed: true, vetoes: [] }
      violated.destructive = true
      violated.policy_override = true
      const vetoedRes = evaluatePolicyVetoes('unblock', violated)
      expect(vetoedRes).toEqual({
        allowed: false,
        vetoes: ['destructive-action', 'policy-override'],
      })

      for (const callType of BRAIN_CALL_TYPES) {
        const clean = makeCleanByType(callType)
        clean.policy_check = {
          allowed: false,
          vetoes: ['forbidden-path', 'invented-hallucinated-veto'],
        }
        const res = evaluatePolicyVetoes(callType, clean)
        expect(res, callType).toEqual({ allowed: true, vetoes: [] })
      }
    })

    it('never mutates input objects or context and operates purely on arguments', () => {
      const plan = makeCleanPlan()
      const ctx: PolicyVetoContext = {
        forbiddenPaths: ['custom/forbidden/'],
        allowedDestinations: [
          'supervisor/src/brain/policy-veto.ts',
          'tests/m8-03-policy-veto.spec.ts',
        ],
        existingTaskIds: ['M8-01', 'M8-02'],
        risk: 'low',
        openS0S1Count: 0,
        missingEvidence: [],
      }
      const planBefore = structuredClone(plan)
      const ctxBefore = structuredClone(ctx)

      const res1 = evaluatePolicyVetoes('plan', plan, ctx)
      const res2 = evaluatePolicyVetoes('plan', plan, ctx)

      expect(res1).toEqual({ allowed: true, vetoes: [] })
      expect(res2).toEqual(res1)
      expect(plan).toEqual(planBefore)
      expect(ctx).toEqual(ctxBefore)
      expect(evaluatePolicyVetoes.length).toBeLessThanOrEqual(3)
    })
  })

  describe('CHK-M8-03-c: property tests (fast-check)', () => {
    const arbRandomCase = (s: string) =>
      fc
        .array(fc.boolean(), { minLength: s.length, maxLength: s.length })
        .map((flags) =>
          [...s]
            .map((ch, idx) => (flags[idx] ? ch.toUpperCase() : ch.toLowerCase()))
            .join(''),
        )

    const arbForbiddenVariant = fc.oneof(
      fc
        .tuple(
          fc.constantFrom(...DEFAULT_FORBIDDEN_PREFIXES),
          fc.constantFrom('file.ts', 'sub/nested.json', 'a/b/c.md'),
          fc.constantFrom('', './', '././', '.\\.\\'),
          fc.constantFrom<'posix' | 'backslash' | 'mixed'>('posix', 'backslash', 'mixed'),
        )
        .chain(([prefix, rest, lead, slashMode]) =>
          arbRandomCase(`${lead}${prefix}${rest}`).map((cased) => {
            if (slashMode === 'backslash') return cased.replaceAll('/', '\\')
            if (slashMode === 'mixed') return cased.replace('/', '\\')
            return cased
          }),
        ),
      fc
        .tuple(
          fc.constantFrom(...DEFAULT_FORBIDDEN_FILES),
          fc.constantFrom('', './', '././', '.\\.\\'),
        )
        .chain(([file, lead]) => arbRandomCase(`${lead}${file}`)),
      fc.constantFrom(
        'src/../tests/protected/x.ts',
        'supervisor/a/../b.ts',
        '../escape.ts',
        'C:/Windows/win.ini',
        'D:\\repo\\file.ts',
        '//server/share/file.ts',
        '\\\\server\\share\\file.ts',
        '/root/secret.txt',
        'src/file\0.ts',
      ),
    )

    it('CHK-M8-03-c: generated forbidden-path variants across applicable call types never return allowed: true and always include forbidden-path', () => {
      fc.assert(
        fc.property(
          arbForbiddenVariant,
          fc.constantFrom<'plan' | 'answer' | 'unblock-target' | 'unblock-split' | 'change-impact'>(
            'plan',
            'answer',
            'unblock-target',
            'unblock-split',
            'change-impact',
          ),
          (badPath, mode) => {
            expect(isForbiddenPath(badPath)).toBe(true)

            let res: PolicyVetoResult
            if (mode === 'plan') {
              const out = makeCleanPlan()
              out.policy_check = { allowed: true, vetoes: [] }
              out.task_graph[0]!.scope = [badPath]
              res = evaluatePolicyVetoes('plan', out)
            } else if (mode === 'answer') {
              const out = makeCleanAnswer()
              out.policy_check = { allowed: true, vetoes: [] }
              out.actions = [{ kind: 'request_edit', detail: 'Edit', target_paths: [badPath] }]
              res = evaluatePolicyVetoes('answer', out)
            } else if (mode === 'unblock-target') {
              const out = makeCleanUnblock()
              out.policy_check = { allowed: true, vetoes: [] }
              out.target_paths = [badPath]
              res = evaluatePolicyVetoes('unblock', out)
            } else if (mode === 'unblock-split') {
              const out = makeCleanUnblock()
              out.policy_check = { allowed: true, vetoes: [] }
              out.action = 'split_task'
              out.retry_change = null
              out.split_tasks = [{ title: 'Split', scope: [badPath], done: ['Done'] }]
              res = evaluatePolicyVetoes('unblock', out)
            } else {
              const out = makeCleanChangeImpact()
              out.policy_check = { allowed: true, vetoes: [] }
              out.affected_paths = [badPath]
              res = evaluatePolicyVetoes('change-impact', out)
            }

            expect(res.allowed).toBe(false)
            expect(res.vetoes).toContain('forbidden-path')
            expect([...res.vetoes].sort()).toEqual(res.vetoes)
            expect(new Set(res.vetoes).size).toBe(res.vetoes.length)
          },
        ),
        { numRuns: 45 },
      )
    })

    it('CHK-M8-03-c: generated S0/S1 waivers across unblock and triage never return allowed: true and always include s0-s1-waiver', () => {
      const arbWaivedList = fc.tuple(
        fc.constantFrom<'S0' | 'S1'>('S0', 'S1'),
        fc.array(fc.constantFrom<Severity>('S0', 'S1', 'S2', 'S3', 'S4'), { maxLength: 3 }),
      )

      fc.assert(
        fc.property(
          arbWaivedList,
          fc.constantFrom<'unblock' | 'triage'>('unblock', 'triage'),
          fc.string({ minLength: 1, maxLength: 24 }),
          ([criticalSev, extraSevs], targetType, reason) => {
            const allSevs = [criticalSev, ...extraSevs]

            let res: PolicyVetoResult
            if (targetType === 'unblock') {
              const out = makeCleanUnblock()
              out.policy_check = { allowed: true, vetoes: [] }
              out.waived_severities = allSevs
              res = evaluatePolicyVetoes('unblock', out)
            } else {
              const out = makeCleanTriage()
              out.policy_check = { allowed: true, vetoes: [] }
              out.waivers = allSevs.map((severity, idx) => ({
                bug_id: `BUG-${idx}`,
                severity,
                reason,
              }))
              res = evaluatePolicyVetoes('triage', out)
            }

            expect(res.allowed).toBe(false)
            expect(res.vetoes).toContain('s0-s1-waiver')
            expect([...res.vetoes].sort()).toEqual(res.vetoes)
            expect(new Set(res.vetoes).size).toBe(res.vetoes.length)
          },
        ),
        { numRuns: 40 },
      )
    })
  })
})
