import { readFileSync } from 'node:fs'
import { inspect, isDeepStrictEqual } from 'node:util'
import { describe, expect, expectTypeOf, it } from 'vitest'
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
} from '../../supervisor/src/brain/schemas.ts'

const callTypes = ['plan', 'answer', 'unblock', 'triage', 'arbitrate', 'change-impact', 'milestone-review'] as const
const severities = ['S0', 'S1', 'S2', 'S3', 'S4'] as const
const risks = ['low', 'medium', 'high'] as const
const namedOutputs = {
  plan: PlanOutputSchema,
  answer: AnswerOutputSchema,
  unblock: UnblockOutputSchema,
  triage: TriageOutputSchema,
  arbitrate: ArbitrateOutputSchema,
  'change-impact': ChangeImpactOutputSchema,
  'milestone-review': MilestoneReviewOutputSchema,
}
const cardFile = 'cards/card.schema.json'
const reportFile = 'report/report.schema.json'
const brainFile = (type: BrainCallType) => `brain/${type}.json`

type JsonObject = Record<string, unknown>
type JsonType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
type JsonSchema = boolean | {
  $schema?: string
  $ref?: string
  $defs?: Record<string, JsonSchema>
  type?: JsonType | JsonType[]
  const?: unknown
  enum?: unknown[]
  required?: string[]
  properties?: Record<string, JsonSchema>
  additionalProperties?: JsonSchema
  items?: JsonSchema
  minItems?: number
  minLength?: number
  minimum?: number
  maximum?: number
  pattern?: string
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  allOf?: JsonSchema[]
  if?: JsonSchema
  then?: JsonSchema
  else?: JsonSchema
  not?: JsonSchema
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const schemaFiles = new Map<string, Exclude<JsonSchema, boolean>>()

function readSchema(file: string): Exclude<JsonSchema, boolean> {
  const cached = schemaFiles.get(file)
  if (cached) return cached
  const schema: unknown = JSON.parse(readFileSync(new URL(`../../schemas/${file}`, import.meta.url), 'utf8'))
  if (!isObject(schema)) throw new Error(`${file} must contain a schema object`)
  schemaFiles.set(file, schema)
  return schema
}

const schemaMaps = ['$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas']
const schemaArrays = ['allOf', 'anyOf', 'oneOf', 'prefixItems']
const schemaChildren = [
  'items', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems',
  'contains', 'propertyNames', 'if', 'then', 'else', 'not', 'contentSchema',
]
const escapePointer = (part: string) => part.replaceAll('~', '~0').replaceAll('/', '~1')

function checkClosedObjects(node: unknown, location: string): void {
  if (typeof node === 'boolean') return
  if (!isObject(node)) throw new Error(`${location} must be a schema object or boolean`)
  if (node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object'))) {
    expect(Object.hasOwn(node, 'additionalProperties'), location).toBe(true)
    expect(node.additionalProperties, location).toBe(false)
  }
  for (const key of schemaMaps) {
    if (!Object.hasOwn(node, key)) continue
    const children = node[key]
    if (!isObject(children)) throw new Error(`${location}/${key} must be a schema map`)
    for (const [name, child] of Object.entries(children)) {
      checkClosedObjects(child, `${location}/${key}/${escapePointer(name)}`)
    }
  }
  for (const key of schemaArrays) {
    if (!Object.hasOwn(node, key)) continue
    const children = node[key]
    if (!Array.isArray(children)) throw new Error(`${location}/${key} must be a schema array`)
    children.forEach((child, index) => checkClosedObjects(child, `${location}/${key}/${index}`))
  }
  for (const key of schemaChildren) {
    if (Object.hasOwn(node, key)) checkClosedObjects(node[key], `${location}/${key}`)
  }
}

function resolveRef(root: JsonSchema, ref: string): JsonSchema {
  if (ref === '#') return root
  if (!ref.startsWith('#/')) throw new Error(`Expected a local JSON pointer, got ${ref}`)
  let target: unknown = root
  for (const part of decodeURIComponent(ref.slice(2)).split('/')) {
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~')
    if (!isObject(target) || !Object.hasOwn(target, key)) throw new Error(`Unresolved schema reference ${ref}`)
    target = target[key]
  }
  if (!isObject(target) && typeof target !== 'boolean') throw new Error(`Invalid schema reference ${ref}`)
  return target
}

function matchesType(type: JsonType, value: unknown): boolean {
  switch (type) {
    case 'object': return isObject(value)
    case 'array': return Array.isArray(value)
    case 'null': return value === null
    case 'integer': return Number.isInteger(value)
    case 'number': return Number.isFinite(value)
    case 'string': return typeof value === 'string'
    case 'boolean': return typeof value === 'boolean'
    default: throw new Error(`Invalid JSON Schema type: ${type}`)
  }
}

function acceptsJson(schema: JsonSchema, value: unknown, root: JsonSchema = schema): boolean {
  if (typeof schema === 'boolean') return schema
  const accepts = (subschema: JsonSchema) => acceptsJson(subschema, value, root)
  if (schema.$ref !== undefined && !accepts(resolveRef(root, schema.$ref))) return false
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some(type => matchesType(type, value))) return false
  }
  if (Object.hasOwn(schema, 'const') && !isDeepStrictEqual(value, schema.const)) return false
  if (schema.enum && !schema.enum.some(member => isDeepStrictEqual(value, member))) return false
  if (schema.allOf && !schema.allOf.every(branch => accepts(branch))) return false
  if (schema.anyOf && !schema.anyOf.some(branch => accepts(branch))) return false
  if (schema.oneOf && schema.oneOf.filter(branch => accepts(branch)).length !== 1) return false
  if (schema.not !== undefined && accepts(schema.not)) return false
  if (schema.if !== undefined) {
    const branch = accepts(schema.if) ? schema.then : schema.else
    if (branch !== undefined && !accepts(branch)) return false
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) return false
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) return false
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && !(value >= schema.minimum)) return false
    if (schema.maximum !== undefined && !(value <= schema.maximum)) return false
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false
    const items = schema.items
    if (items !== undefined && !value.every(item => acceptsJson(items, item, root))) return false
  }
  if (isObject(value)) {
    if (schema.required?.some(key => !Object.hasOwn(value, key))) return false
    const properties = schema.properties ?? {}
    for (const [key, entry] of Object.entries(value)) {
      const child = Object.hasOwn(properties, key) ? properties[key]! : schema.additionalProperties ?? true
      if (!acceptsJson(child, entry, root)) return false
    }
  }
  return true
}

type Vector = { label: string; input: unknown; valid: boolean }
const vector = (label: string, input: unknown, valid = true): Vector => ({ label, input, valid })

function withField(fixture: JsonObject, path: string, value: unknown): JsonObject {
  const copy = structuredClone(fixture)
  const parts = path.split('.')
  const field = parts.pop()!
  let parent = copy
  for (const part of parts) {
    const child = parent[part]
    if (!isObject(child) && !Array.isArray(child)) throw new Error(`No fixture object at ${path}`)
    parent = child as JsonObject
  }
  parent[field] = value
  return copy
}

function values(fixture: JsonObject, path: string, valid: boolean, ...variants: unknown[]): Vector[] {
  return variants.map(value => vector(`${path} = ${inspect(value)}`, withField(fixture, path, value), valid))
}

function missing(fixture: JsonObject, ...fields: string[]): Vector[] {
  return fields.map(field => {
    if (!Object.hasOwn(fixture, field)) throw new Error(`No required fixture field ${field}`)
    const input = { ...fixture }
    delete input[field]
    return vector(`missing ${field}`, input, false)
  })
}

function extra(fixture: JsonObject, ...paths: string[]): Vector[] {
  return paths.map(path => vector(`extra key in ${path || 'root'}`,
    withField(fixture, path ? `${path}.unexpected` : 'unexpected', true), false))
}

const envelope = {
  schema_version: 1,
  call_id: 'brain-call-1',
  status: 'ok',
  provenance: [{ source: 'ci', ref: 'run/42', claim: 'The test command passed.' }],
  confidence: 0.65,
  policy_check: { allowed: true, vetoes: [] },
}

function envelopeVectors(fixture: JsonObject): Vector[] {
  return [
    vector('required fields with optional fields omitted', fixture),
    ...['ok', 'insufficient_evidence', 'escalate'].map(status =>
      vector(`${status} allows empty provenance in the schema`, { ...fixture, status, provenance: [] })),
    ...values(fixture, 'confidence', true, 0, 1),
    ...values(fixture, 'policy_check', true, { allowed: false, vetoes: ['missing-evidence'] }),
    ...missing(fixture, 'schema_version', 'call_id', 'status', 'provenance', 'confidence', 'policy_check'),
    ...extra(fixture, '', 'provenance.0', 'policy_check'),
    ...values(fixture, 'schema_version', false, 0, 2, '1'),
    ...values(fixture, 'call_id', false, '', 1),
    ...values(fixture, 'status', false, 'pending'),
    ...values(fixture, 'confidence', false, -0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, '0.65'),
    ...values(fixture, 'provenance', false, null, [{}], [{ ref: 'run/42', claim: 'Verified' }]),
    ...values(fixture, 'provenance.0.source', false, ''),
    ...values(fixture, 'provenance.0.ref', false, ''),
    ...values(fixture, 'provenance.0.claim', false, ''),
    ...values(fixture, 'policy_check', false, { allowed: true }, { vetoes: [] }),
    ...values(fixture, 'policy_check.allowed', false, 'true'),
    ...values(fixture, 'policy_check.vetoes', false, [0]),
    vector('null root', null, false),
    vector('array root', [], false),
  ]
}

const adr = { title: 'Record the retry plan', decision: 'Retry once', consequences: ['One extra attempt'] }
const task = {
  id: 'M8-02', title: 'Define the schemas', owner: 'builder', scope: ['schemas/brain'],
  deps: ['M8-01'], done: ['Validate all seven outputs'],
}
const action = { kind: 'guide', detail: 'Read the M8 contract.' }
const bug = { id: 'BUG-1', severity: 'S2', evidence_refs: ['run/42'], summary: 'A schema drifted.' }

const requiredOutputs = {
  plan: {
    assumptions: ['The schema version is frozen'], adrs: [adr], task_graph: [task],
    golden_choice: null, escalation: null,
  },
  answer: { answer: null, actions: [action], evidence_needed: ['run/42'], escalation: null },
  unblock: {
    root_cause: 'The test used a stale fixture.', evidence: [{ source: 'ci', claim: 'The fixture predates M8.' }],
    action: 'continue', question: null, stop: false,
  },
  triage: {
    bugs: [bug], clusters: [{ name: 'Schema drift', bug_ids: ['BUG-1'] }], priority_order: ['BUG-1'],
    reopened_tasks: ['M8-02'], waivers: [{ bug_id: 'BUG-1', severity: 'S3', reason: 'Duplicate report' }],
  },
  arbitrate: {
    ruling: 'approve', reasoning_summary: 'The acceptance criterion is met.',
    required_changes: [], accepted_findings: ['Finding 1'], escalation: null,
  },
  'change-impact': {
    impact: 'The published contract changes.', affected_tasks: ['M8-02'], affected_paths: ['schemas/brain/plan.json'],
    adr_required: false, migration_steps: ['Regenerate fixtures'], risk: 'low', decision: 'proceed',
  },
  'milestone-review': {
    health: 'green', complete: false, drift_tasks: [], adr_updates: [], release_blockers: [], next_milestone: null,
  },
} satisfies Record<BrainCallType, JsonObject>

const populatedFields = {
  plan: {
    task_graph: [{ ...task, new_dependencies: ['schema-parser'] }], invented_destinations: ['docs/new'],
    golden_choice: 'reference-1', escalation: 'Confirm the reference.',
  },
  answer: {
    answer: 'Use the M8 contract.', actions: [{ ...action, target_paths: ['supervisor/src/brain/schemas.ts'] }],
    escalation: 'The reference needs a decision.',
  },
  unblock: {
    question: 'Which fixture should we use?', retry_change: 'Refresh the stale fixture.',
    reassignment: { role: 'builder', reason: 'The current worker is unavailable.' },
    split_tasks: [{ title: 'Update the fixture', scope: ['tests/m8-02-fixtures.spec.ts'], done: ['Fixture validates'] }],
    adr, waived_severities: ['S4'], destructive: false, policy_override: false, target_paths: ['tests'],
  },
  triage: { bugs: [{ ...bug, original_severity: 'S1' }], qa_test_edits: ['tests/qa/schema.spec.ts'] },
  arbitrate: { escalation: 'Review the disputed finding.', risk: 'high', lead_reviewed: true, violates_adr: false },
  'change-impact': { adr, breaks_contract: true, new_dependencies: ['schema-parser'] },
  'milestone-review': { next_milestone: 'M9', open_s0_s1_count: 2, missing_evidence: ['run/43'] },
} satisfies Record<BrainCallType, JsonObject>

function outputVectors(type: BrainCallType): Vector[] {
  const base = { ...envelope, ...requiredOutputs[type] }
  const full = { ...base, ...populatedFields[type] }
  const specific = (() => {
    switch (type) {
      case 'plan': return [
        ...extra(full, 'adrs.0', 'task_graph.0'),
        ...values(full, 'task_graph.0.new_dependencies', false, null, [1]),
        ...values(full, 'invented_destinations', false, 'docs/new'),
        ...values(base, 'golden_choice', false, true),
        ...values(base, 'escalation', false, 1),
      ]
      case 'answer': return [
        ...extra(full, 'actions.0'),
        ...values(base, 'actions.0.kind', true, 'request_edit', 'waive_criterion', 'escalate'),
        ...values(base, 'actions.0.kind', false, 'edit'),
        ...values(full, 'actions.0.target_paths', false, null, [1]),
        ...values(base, 'answer', false, 1),
      ]
      case 'unblock': return [
        ...extra(full, 'evidence.0', 'reassignment', 'split_tasks.0', 'adr'),
        ...values(base, 'action', true, 'retry_with_change', 'split_task', 'reassign', 'write_adr',
          'escalate_designer', 'ask_question', 'stop'),
        ...values(base, 'action', false, 'rerun'),
        ...values(full, 'retry_change', true, null),
        ...values(full, 'reassignment', true, null),
        ...values(full, 'adr', true, null),
        ...values(full, 'waived_severities', true, [...severities]),
        ...values(full, 'waived_severities', false, ['S5']),
        ...values(full, 'split_tasks', false, null),
        ...values(full, 'destructive', false, 'false'),
        ...values(full, 'policy_override', false, 0),
        ...values(full, 'target_paths', false, [false]),
        ...values(base, 'question', false, 1),
        ...values(base, 'stop', false, 'false'),
      ]
      case 'triage': return [
        ...extra(full, 'bugs.0', 'clusters.0', 'waivers.0'),
        ...values(full, 'bugs.0.severity', true, ...severities.filter(severity => severity !== bug.severity)),
        ...values(full, 'bugs.0.severity', false, 'critical'),
        ...values(full, 'bugs.0.original_severity', false, 'S5', null),
        ...values(full, 'waivers.0.severity', false, 'S5'),
        ...values(full, 'qa_test_edits', false, [2]),
      ]
      case 'arbitrate': return [
        ...values(base, 'ruling', true, 'request_changes', 'escalate'),
        ...values(base, 'ruling', false, 'reject'),
        ...values(full, 'risk', true, 'low', 'medium'),
        ...values(full, 'risk', false, 'critical'),
        ...values(full, 'lead_reviewed', false, 'true'),
        ...values(full, 'violates_adr', false, 0),
      ]
      case 'change-impact': return [
        ...extra(full, 'adr'),
        ...values(full, 'adr', true, null),
        ...values(base, 'risk', true, ...risks.slice(1)),
        ...values(base, 'risk', false, 'critical'),
        ...values(base, 'decision', true, 'require_adr', 'reject', 'escalate'),
        ...values(base, 'decision', false, 'approve'),
        ...values(full, 'breaks_contract', false, 'true'),
        ...values(full, 'new_dependencies', false, null),
      ]
      case 'milestone-review': return [
        ...values(base, 'health', true, 'yellow', 'red'),
        ...values(base, 'health', false, 'blue'),
        ...values(full, 'open_s0_s1_count', true, 0),
        ...values(full, 'open_s0_s1_count', false, '2'),
        ...values(full, 'missing_evidence', false, [1]),
        ...values(base, 'next_milestone', false, 9),
      ]
    }
  })()
  return [
    ...envelopeVectors(base),
    vector('populated optional and nullable fields', full),
    ...missing(base, ...Object.keys(requiredOutputs[type])),
    ...specific,
  ]
}

const card = {
  card_id: 'builder-logic', role: 'builder', layer: 'core', card_version: '1.2.3',
  capabilities: ['edit scoped files'], forbidden_paths: ['tests/protected/'],
}
const report = {
  status: 'done', summary: 'Validated the contract.', changed_paths: ['schemas/brain/plan.json'],
  checks: [], evidence: [], risks: [], question: null, next_action: 'Review the schema.', card_version: '1.2.3',
}

function versionVectors(fixture: JsonObject): Vector[] {
  return [
    ...values(fixture, 'card_version', true, '0.0.0', '12.34.56'),
    ...values(fixture, 'card_version', false, '', 1, '1.2', '1.2.3.4', 'v1.2.3', '01.2.3', '1.02.3', '1.2.03',
      '-1.2.3', '1.2.3-rc.1', '1.2.3+build.1', '1.2.3 ', '1.2.3\n'),
  ]
}

const cardVectors = [
  vector('core with capabilities', card),
  ...values(card, 'layer', true, 'stack', 'project'),
  ...values(card, 'layer', false, 'addendum', 'CORE', null),
  ...values(card, 'capabilities', false, [], [1]),
  vector('stack with empty capabilities', { ...card, layer: 'stack', capabilities: [] }),
  vector('project with empty capabilities', { ...card, layer: 'project', capabilities: [] }),
  ...values(card, 'forbidden_paths', false, [1]),
  ...missing(card, ...Object.keys(card)),
  ...extra(card, ''),
  vector('array root', [], false),
  ...versionVectors(card),
]
const reportVectors = [
  vector('null question', report),
  ...values(report, 'question', true, 'Which report should I attach?'),
  ...values(report, 'question', false, 1, { text: 'Which report?' }),
  ...values(report, 'changed_paths', false, [1]),
  ...values(report, 'checks', false, 'passed'),
  ...values(report, 'evidence', false, null),
  ...values(report, 'risks', false, {}),
  ...missing(report, ...Object.keys(report)),
  ...extra(report, ''),
  vector('array root', [], false),
  ...versionVectors(report),
]

type ValidationResult = ReturnType<typeof validateBrainOutput>

function expectAgreement(sample: Vector, file: string, result: ValidationResult, ...schemaResults: boolean[]): void {
  expect({ jsonSchema: acceptsJson(readSchema(file), sample.input), zod: result.ok }).toEqual({
    jsonSchema: sample.valid, zod: sample.valid,
  })
  for (const accepted of schemaResults) expect(accepted).toBe(sample.valid)
  if (result.ok) {
    expect(result).toHaveProperty('data')
  } else {
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors.every(error => typeof error === 'string' && error.length > 0)).toBe(true)
  }
}

it.each([...callTypes.map(brainFile), cardFile, reportFile])(
  'CHK-M8-02-a: %s declares Draft 2020-12 and closes every object schema', file => {
    const schema = readSchema(file)
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    checkClosedObjects(schema, `${file}#`)
  },
)

it('CHK-M8-02-b: exports the frozen schema version, call types, severity and registry', () => {
  expect(BRAIN_SCHEMA_VERSION).toBe(1)
  expect(BRAIN_CALL_TYPES).toEqual(callTypes)
  expect(Object.keys(BrainOutputSchemas).sort()).toEqual([...callTypes].sort())
  expectTypeOf(BRAIN_CALL_TYPES).toEqualTypeOf<typeof callTypes>()
  expectTypeOf<BrainCallType>().toEqualTypeOf<(typeof callTypes)[number]>()
  expectTypeOf<Severity>().toEqualTypeOf<(typeof severities)[number]>()
})

it('CHK-M8-02-b: the standalone envelope enforces the shared contract', () => {
  for (const sample of envelopeVectors(envelope)) {
    expect(BrainEnvelopeSchema.safeParse(sample.input).success, sample.label).toBe(sample.valid)
  }
})

describe('CHK-M8-02-b and CHK-M8-02-c: Brain output validation and JSON Schema parity', () => {
  for (const type of callTypes) {
    describe(type, () => {
      it.each(outputVectors(type))('$label', sample => {
        expectAgreement(sample, brainFile(type), validateBrainOutput(type, sample.input),
          namedOutputs[type].safeParse(sample.input).success, BrainOutputSchemas[type].safeParse(sample.input).success)
      })
    })
  }
})

describe('CHK-M8-02-c: card metadata parity', () => {
  it.each(cardVectors)('$label', sample => {
    expectAgreement(sample, cardFile, validateCardMetadata(sample.input), CardMetadataSchema.safeParse(sample.input).success)
  })
})

describe('CHK-M8-02-c: worker report parity', () => {
  it.each(reportVectors)('$label', sample => {
    expectAgreement(sample, reportFile, validateWorkerReport(sample.input), WorkerReportSchema.safeParse(sample.input).success)
  })
})
