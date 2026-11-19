import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BRAIN_SCHEMA_VERSION,
  BRAIN_CALL_TYPES,
  type BrainCallType,
  type Severity,
  BrainEnvelopeSchema,
  PlanOutputSchema,
  AnswerOutputSchema,
  UnblockOutputSchema,
  TriageOutputSchema,
  ArbitrateOutputSchema,
  ChangeImpactOutputSchema,
  MilestoneReviewOutputSchema,
  BrainOutputSchemas,
  CardMetadataSchema,
  WorkerReportSchema,
  validateBrainOutput,
  validateCardMetadata,
  validateWorkerReport,
} from '../supervisor/src/brain/schemas.ts'

const baseEnvelope = {
  schema_version: 1 as const,
  call_id: 'call-m8-02',
  status: 'ok' as const,
  provenance: [{ source: 'ci', ref: 'run/100', claim: 'All unit tests passed.' }],
  confidence: 0.85,
  policy_check: { allowed: true, vetoes: [] },
}

describe('M8-02 Lead Brain JSON Schemas and Zod validators', () => {
  it('exports frozen constants and schemas for all 7 call types', () => {
    expect(BRAIN_SCHEMA_VERSION).toBe(1)
    expect(BRAIN_CALL_TYPES).toEqual([
      'plan',
      'answer',
      'unblock',
      'triage',
      'arbitrate',
      'change-impact',
      'milestone-review',
    ])
    expect(BrainOutputSchemas.plan).toBe(PlanOutputSchema)
    expect(BrainOutputSchemas.answer).toBe(AnswerOutputSchema)
    expect(BrainOutputSchemas.unblock).toBe(UnblockOutputSchema)
    expect(BrainOutputSchemas.triage).toBe(TriageOutputSchema)
    expect(BrainOutputSchemas.arbitrate).toBe(ArbitrateOutputSchema)
    expect(BrainOutputSchemas['change-impact']).toBe(ChangeImpactOutputSchema)
    expect(BrainOutputSchemas['milestone-review']).toBe(MilestoneReviewOutputSchema)
  })

  it('rejects unknown or prototype-inherited call types in validateBrainOutput', () => {
    const unknownCall = validateBrainOutput('unknown-type' as BrainCallType, baseEnvelope)
    expect(unknownCall).toEqual({
      ok: false,
      errors: ['Unknown brain call type: unknown-type'],
    })

    const protoCall = validateBrainOutput('toString' as BrainCallType, baseEnvelope)
    expect(protoCall).toEqual({
      ok: false,
      errors: ['Unknown brain call type: toString'],
    })
  })

  it('returns parsed data on valid brain outputs across all 7 call types', () => {
    const planInput = {
      ...baseEnvelope,
      assumptions: ['A1'],
      adrs: [{ title: 'ADR-1', decision: 'Use SQLite', consequences: ['Single writer'] }],
      task_graph: [
        {
          id: 'M8-02',
          title: 'Schemas',
          owner: 'builder',
          scope: ['schemas/'],
          deps: ['M8-01'],
          done: ['Tests pass'],
          new_dependencies: ['zod'],
        },
      ],
      golden_choice: 'opt-a',
      escalation: null,
      invented_destinations: ['docs/extra'],
    }
    const planRes = validateBrainOutput('plan', planInput)
    expect(planRes).toEqual({ ok: true, data: planInput })

    const answerInput = {
      ...baseEnvelope,
      answer: 'Follow the contract.',
      actions: [{ kind: 'request_edit' as const, detail: 'Update schema', target_paths: ['schemas/brain/plan.json'] }],
      evidence_needed: ['log-1'],
      escalation: null,
    }
    expect(validateBrainOutput('answer', answerInput)).toEqual({ ok: true, data: answerInput })

    const unblockInput = {
      ...baseEnvelope,
      root_cause: 'Flaky fixture',
      evidence: [{ source: 'test', claim: 'Failed 3 times' }],
      action: 'retry_with_change' as const,
      question: null,
      stop: false,
      retry_change: 'Pin timestamp',
      reassignment: { role: 'builder', reason: 'Retry needed' },
      split_tasks: [{ title: 'Subtask', scope: ['tests/'], done: ['Green'] }],
      adr: { title: 'ADR-2', decision: 'Pin time', consequences: ['Deterministic'] },
      waived_severities: ['S3', 'S4'] as Severity[],
      destructive: false,
      policy_override: false,
      target_paths: ['tests/m8-02-schemas.spec.ts'],
    }
    expect(validateBrainOutput('unblock', unblockInput)).toEqual({ ok: true, data: unblockInput })

    const triageInput = {
      ...baseEnvelope,
      bugs: [
        {
          id: 'B1',
          severity: 'S2' as const,
          original_severity: 'S1' as const,
          evidence_refs: ['ref-1'],
          summary: 'Minor regression',
        },
      ],
      clusters: [{ name: 'Cluster A', bug_ids: ['B1'] }],
      priority_order: ['B1'],
      reopened_tasks: ['M8-01'],
      waivers: [{ bug_id: 'B1', severity: 'S3' as const, reason: 'Low impact' }],
      qa_test_edits: ['tests/qa/a.spec.ts'],
    }
    expect(validateBrainOutput('triage', triageInput)).toEqual({ ok: true, data: triageInput })

    const arbitrateInput = {
      ...baseEnvelope,
      ruling: 'approve' as const,
      reasoning_summary: 'Meets spec',
      required_changes: [],
      accepted_findings: ['F1'],
      escalation: null,
      risk: 'low' as const,
      lead_reviewed: true,
      violates_adr: false,
    }
    expect(validateBrainOutput('arbitrate', arbitrateInput)).toEqual({ ok: true, data: arbitrateInput })

    const changeImpactInput = {
      ...baseEnvelope,
      impact: 'Schema update',
      affected_tasks: ['M8-02'],
      affected_paths: ['schemas/brain/plan.json'],
      adr_required: true,
      adr: { title: 'ADR-3', decision: 'Add field', consequences: ['Version bump'] },
      migration_steps: ['Step 1'],
      risk: 'medium' as const,
      decision: 'require_adr' as const,
      breaks_contract: false,
      new_dependencies: [],
    }
    expect(validateBrainOutput('change-impact', changeImpactInput)).toEqual({ ok: true, data: changeImpactInput })

    const milestoneReviewInput = {
      ...baseEnvelope,
      health: 'green' as const,
      complete: true,
      drift_tasks: [],
      adr_updates: [],
      release_blockers: [],
      next_milestone: 'M9',
      open_s0_s1_count: 0,
      missing_evidence: [],
    }
    expect(validateBrainOutput('milestone-review', milestoneReviewInput)).toEqual({
      ok: true,
      data: milestoneReviewInput,
    })
  })

  it('enforces finite confidence bounds and non-empty string constraints in BrainEnvelopeSchema', () => {
    for (const validConfidence of [0, 0.5, 1]) {
      expect(BrainEnvelopeSchema.safeParse({ ...baseEnvelope, confidence: validConfidence }).success).toBe(true)
    }
    for (const invalidConfidence of [-0.0001, 1.0001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const res = validateBrainOutput('milestone-review', {
        ...baseEnvelope,
        confidence: invalidConfidence,
        health: 'green',
        complete: false,
        drift_tasks: [],
        adr_updates: [],
        release_blockers: [],
        next_milestone: null,
      })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.errors.length).toBeGreaterThan(0)
        expect(res.errors[0]!.length).toBeGreaterThan(0)
      }
    }

    for (const field of ['source', 'ref', 'claim'] as const) {
      const badProv = { ...baseEnvelope.provenance[0]!, [field]: '' }
      expect(BrainEnvelopeSchema.safeParse({ ...baseEnvelope, provenance: [badProv] }).success).toBe(false)
      const okOneChar = { ...baseEnvelope.provenance[0]!, [field]: 'x' }
      expect(BrainEnvelopeSchema.safeParse({ ...baseEnvelope, provenance: [okOneChar] }).success).toBe(true)
    }

    expect(BrainEnvelopeSchema.safeParse({ ...baseEnvelope, call_id: 'a' }).success).toBe(true)
    expect(BrainEnvelopeSchema.safeParse({ ...baseEnvelope, call_id: '' }).success).toBe(false)
  })

  it('validates card metadata layer rules and strict semver boundaries', () => {
    const validCore = {
      card_id: 'lead',
      role: 'lead',
      layer: 'core' as const,
      card_version: '1.0.0',
      capabilities: ['orchestrate'],
      forbidden_paths: ['tests/protected/'],
    }
    expect(validateCardMetadata(validCore)).toEqual({ ok: true, data: validCore })

    const emptyCoreRes = validateCardMetadata({ ...validCore, capabilities: [] })
    expect(emptyCoreRes).toEqual({
      ok: false,
      errors: ['core cards require at least one capability'],
    })

    for (const layer of ['stack', 'project'] as const) {
      const validAddendum = { ...validCore, layer, capabilities: [] }
      expect(validateCardMetadata(validAddendum)).toEqual({ ok: true, data: validAddendum })
    }

    for (const goodSemver of ['0.0.0', '1.9.0', '9.10.11', '10.20.30']) {
      expect(validateCardMetadata({ ...validCore, card_version: goodSemver }).ok).toBe(true)
    }

    for (const badSemver of [
      '01.0.0',
      '1.02.0',
      '1.0.03',
      '1.0',
      '1.0.0-alpha',
      '1.0.0+20130313',
      'v1.0.0',
      'prefix1.0.0',
      '1.0.0suffix',
      '1..0',
      'a.b.c',
      '',
    ]) {
      const res = validateCardMetadata({ ...validCore, card_version: badSemver })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.errors.length).toBeGreaterThan(0)
      }
    }
  })

  it('validates worker report fields and rejects invalid inputs with non-empty error messages', () => {
    const validReport = {
      status: 'done',
      summary: 'Implemented M8-02',
      changed_paths: ['supervisor/src/brain/schemas.ts'],
      checks: ['pnpm typecheck'],
      evidence: ['472 passed'],
      risks: [],
      question: null,
      next_action: 'Ready for review',
      card_version: '2.10.0',
    }
    expect(validateWorkerReport(validReport)).toEqual({ ok: true, data: validReport })

    const withQuestion = { ...validReport, question: 'Should we split task?' }
    expect(validateWorkerReport(withQuestion)).toEqual({ ok: true, data: withQuestion })

    const badReport = validateWorkerReport({ ...validReport, card_version: '02.10.0', extra: true })
    expect(badReport.ok).toBe(false)
    if (!badReport.ok) {
      expect(badReport.errors.length).toBeGreaterThanOrEqual(2)
    }

    expect(CardMetadataSchema.safeParse(validCoreForTest()).success).toBe(true)
    expect(WorkerReportSchema.safeParse(validReport).success).toBe(true)
  })

  it('verifies all 9 JSON Schema files exist and declare Draft 2020-12 with strict object definitions', () => {
    const files = [
      ...BRAIN_CALL_TYPES.map((t) => `brain/${t}.json`),
      'cards/card.schema.json',
      'report/report.schema.json',
    ]
    for (const rel of files) {
      const raw = JSON.parse(readFileSync(new URL(`../schemas/${rel}`, import.meta.url), 'utf8')) as {
        $schema?: string
        type?: string
        additionalProperties?: boolean
      }
      expect(raw.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
      expect(raw.type).toBe('object')
      expect(raw.additionalProperties).toBe(false)
    }
  })
})

function validCoreForTest() {
  return {
    card_id: 'reviewer',
    role: 'reviewer',
    layer: 'core' as const,
    card_version: '0.1.0',
    capabilities: ['review'],
    forbidden_paths: [],
  }
}
