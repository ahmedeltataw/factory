import { z } from 'zod'

export const BRAIN_SCHEMA_VERSION = 1 as const

export const BRAIN_CALL_TYPES = [
  'plan',
  'answer',
  'unblock',
  'triage',
  'arbitrate',
  'change-impact',
  'milestone-review',
] as const

export type BrainCallType = (typeof BRAIN_CALL_TYPES)[number]

export type Severity = 'S0' | 'S1' | 'S2' | 'S3' | 'S4'

const SeveritySchema = z.enum(['S0', 'S1', 'S2', 'S3', 'S4'])
const RiskSchema = z.enum(['low', 'medium', 'high'])
const NonEmptyStringSchema = z.string().min(1)
const StrictSemverSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)

const ProvenanceItemSchema = z
  .object({
    source: NonEmptyStringSchema,
    ref: NonEmptyStringSchema,
    claim: NonEmptyStringSchema,
  })
  .strict()

const PolicyCheckSchema = z
  .object({
    allowed: z.boolean(),
    vetoes: z.array(z.string()),
  })
  .strict()

export const BrainEnvelopeSchema = z
  .object({
    schema_version: z.literal(BRAIN_SCHEMA_VERSION),
    call_id: NonEmptyStringSchema,
    status: z.enum(['ok', 'insufficient_evidence', 'escalate']),
    provenance: z.array(ProvenanceItemSchema),
    confidence: z.number().min(0).max(1),
    policy_check: PolicyCheckSchema,
  })
  .strict()

const AdrSchema = z
  .object({
    title: z.string(),
    decision: z.string(),
    consequences: z.array(z.string()),
  })
  .strict()

const PlanTaskSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    owner: z.string(),
    scope: z.array(z.string()),
    deps: z.array(z.string()),
    done: z.array(z.string()),
    new_dependencies: z.array(z.string()).optional(),
  })
  .strict()

export const PlanOutputSchema = BrainEnvelopeSchema.extend({
  assumptions: z.array(z.string()),
  adrs: z.array(AdrSchema),
  task_graph: z.array(PlanTaskSchema),
  golden_choice: z.string().nullable(),
  escalation: z.string().nullable(),
  invented_destinations: z.array(z.string()).optional(),
}).strict()

const AnswerActionSchema = z
  .object({
    kind: z.enum(['guide', 'request_edit', 'waive_criterion', 'escalate']),
    detail: z.string(),
    target_paths: z.array(z.string()).optional(),
  })
  .strict()

export const AnswerOutputSchema = BrainEnvelopeSchema.extend({
  answer: z.string().nullable(),
  actions: z.array(AnswerActionSchema),
  evidence_needed: z.array(z.string()),
  escalation: z.string().nullable(),
}).strict()

const UnblockEvidenceSchema = z
  .object({
    source: z.string(),
    claim: z.string(),
  })
  .strict()

const UnblockReassignmentSchema = z
  .object({
    role: z.string(),
    reason: z.string(),
  })
  .strict()

const UnblockSplitTaskSchema = z
  .object({
    title: z.string(),
    scope: z.array(z.string()),
    done: z.array(z.string()),
  })
  .strict()

export const UnblockOutputSchema = BrainEnvelopeSchema.extend({
  root_cause: z.string(),
  evidence: z.array(UnblockEvidenceSchema),
  action: z.enum([
    'continue',
    'retry_with_change',
    'split_task',
    'reassign',
    'write_adr',
    'escalate_designer',
    'ask_question',
    'stop',
  ]),
  question: z.string().nullable(),
  stop: z.boolean(),
  retry_change: z.string().nullable().optional(),
  reassignment: UnblockReassignmentSchema.nullable().optional(),
  split_tasks: z.array(UnblockSplitTaskSchema).optional(),
  adr: AdrSchema.nullable().optional(),
  waived_severities: z.array(SeveritySchema).optional(),
  destructive: z.boolean().optional(),
  policy_override: z.boolean().optional(),
  target_paths: z.array(z.string()).optional(),
}).strict()

const TriageBugSchema = z
  .object({
    id: z.string(),
    severity: SeveritySchema,
    original_severity: SeveritySchema.optional(),
    evidence_refs: z.array(z.string()),
    summary: z.string(),
  })
  .strict()

const TriageClusterSchema = z
  .object({
    name: z.string(),
    bug_ids: z.array(z.string()),
  })
  .strict()

const TriageWaiverSchema = z
  .object({
    bug_id: z.string(),
    severity: SeveritySchema,
    reason: z.string(),
  })
  .strict()

export const TriageOutputSchema = BrainEnvelopeSchema.extend({
  bugs: z.array(TriageBugSchema),
  clusters: z.array(TriageClusterSchema),
  priority_order: z.array(z.string()),
  reopened_tasks: z.array(z.string()),
  waivers: z.array(TriageWaiverSchema),
  qa_test_edits: z.array(z.string()).optional(),
}).strict()

export const ArbitrateOutputSchema = BrainEnvelopeSchema.extend({
  ruling: z.enum(['approve', 'request_changes', 'escalate']),
  reasoning_summary: z.string(),
  required_changes: z.array(z.string()),
  accepted_findings: z.array(z.string()),
  escalation: z.string().nullable(),
  risk: RiskSchema.optional(),
  lead_reviewed: z.boolean().optional(),
  violates_adr: z.boolean().optional(),
}).strict()

export const ChangeImpactOutputSchema = BrainEnvelopeSchema.extend({
  impact: z.string(),
  affected_tasks: z.array(z.string()),
  affected_paths: z.array(z.string()),
  adr_required: z.boolean(),
  adr: AdrSchema.nullable().optional(),
  migration_steps: z.array(z.string()),
  risk: RiskSchema,
  decision: z.enum(['proceed', 'require_adr', 'reject', 'escalate']),
  breaks_contract: z.boolean().optional(),
  new_dependencies: z.array(z.string()).optional(),
}).strict()

export const MilestoneReviewOutputSchema = BrainEnvelopeSchema.extend({
  health: z.enum(['green', 'yellow', 'red']),
  complete: z.boolean(),
  drift_tasks: z.array(z.string()),
  adr_updates: z.array(z.string()),
  release_blockers: z.array(z.string()),
  next_milestone: z.string().nullable(),
  open_s0_s1_count: z.number().optional(),
  missing_evidence: z.array(z.string()).optional(),
}).strict()

export const BrainOutputSchemas = {
  plan: PlanOutputSchema,
  answer: AnswerOutputSchema,
  unblock: UnblockOutputSchema,
  triage: TriageOutputSchema,
  arbitrate: ArbitrateOutputSchema,
  'change-impact': ChangeImpactOutputSchema,
  'milestone-review': MilestoneReviewOutputSchema,
} as const satisfies Record<BrainCallType, z.ZodType>

export type BrainOutputMap = {
  [K in BrainCallType]: z.infer<(typeof BrainOutputSchemas)[K]>
}

export const CardMetadataSchema = z
  .object({
    card_id: z.string(),
    role: z.string(),
    layer: z.enum(['core', 'stack', 'project']),
    card_version: StrictSemverSchema,
    capabilities: z.array(z.string()),
    forbidden_paths: z.array(z.string()),
  })
  .strict()
  .refine((data) => data.layer !== 'core' || data.capabilities.length > 0, {
    message: 'core cards require at least one capability',
  })

export type CardMetadata = z.infer<typeof CardMetadataSchema>

export const WorkerReportSchema = z
  .object({
    status: z.string(),
    summary: z.string(),
    changed_paths: z.array(z.string()),
    checks: z.array(z.string()),
    evidence: z.array(z.string()),
    risks: z.array(z.string()),
    question: z.string().nullable(),
    next_action: z.string(),
    card_version: StrictSemverSchema,
  })
  .strict()

export type WorkerReport = z.infer<typeof WorkerReportSchema>

export type ValidationResult<T = unknown> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly errors: readonly string[] }

function validateWithSchema<T>(schema: z.ZodType<T>, input: unknown): ValidationResult<T> {
  const parsed = schema.safeParse(input)
  if (parsed.success) {
    return { ok: true, data: parsed.data }
  }
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => issue.message),
  }
}

export function validateBrainOutput<K extends BrainCallType>(
  callType: K,
  input: unknown,
): ValidationResult<BrainOutputMap[K]>
export function validateBrainOutput(callType: BrainCallType, input: unknown): ValidationResult
export function validateBrainOutput(callType: BrainCallType, input: unknown): ValidationResult {
  if (!Object.hasOwn(BrainOutputSchemas, callType)) {
    return { ok: false, errors: [`Unknown brain call type: ${String(callType)}`] }
  }
  return validateWithSchema(BrainOutputSchemas[callType] as z.ZodType, input)
}

export function validateCardMetadata(input: unknown): ValidationResult<CardMetadata> {
  return validateWithSchema(CardMetadataSchema, input)
}

export function validateWorkerReport(input: unknown): ValidationResult<WorkerReport> {
  return validateWithSchema(WorkerReportSchema, input)
}
