import { createHash } from 'node:crypto'
import { PayloadEncodingError, payloadSchema } from './claim-payload.serializer.ts'
import type { CanonicalClaimPayloadV1 } from './claim-payload.types.ts'

// CRG-01 Checkpoint B — A6-PAYLOAD-2: every A6-PAYLOAD-1 field (same key order, same rules) under its own schema
// version, plus a `coding` section that binds each diagnosis and each procedure-coded line to its exact A5-VAL-2
// receipt and the run's manifest digest. A separate encoder: the A6-PAYLOAD-1 serializer, its schema version and its
// golden vectors are untouched. No code text is copied — identifiers, the controlled code system and hashes only.

export const PAYLOAD_SCHEMA_VERSION_V2 = 'A6-PAYLOAD-2'

export type CodingDiagnosisV2 = {
  claimDiagnosisId: string
  encounterDiagnosisId: string
  receiptId: string
  codeSystem: string
  referenceDatasetVersionId: string
  membershipId: string
  sourceRowSha256: string
}
export type CodingLineV2 = {
  claimLineId: string
  encounterActivityId: string
  receiptId: string
  codeSystem: string
  referenceDatasetVersionId: string
  membershipId: string
  sourceRowSha256: string
}
export type CanonicalCodingV2 = { manifestSha256: string; diagnoses: CodingDiagnosisV2[]; lines: CodingLineV2[] }

export type CanonicalClaimPayloadV2 = Omit<CanonicalClaimPayloadV1, 'schemaVersion'> & { schemaVersion: typeof PAYLOAD_SCHEMA_VERSION_V2; coding: CanonicalCodingV2 }

type Scalar = 'uuid' | 'text' | 'hex64'
type Shape = string | { object: readonly (readonly [string, Shape])[] } | { array: Shape; order?: string }
type Schema = readonly (readonly [string, Shape])[]

const codingDiagnosisSchema: Schema = [
  ['claimDiagnosisId', 'uuid'],
  ['encounterDiagnosisId', 'uuid'],
  ['receiptId', 'uuid'],
  ['codeSystem', 'text'],
  ['referenceDatasetVersionId', 'uuid'],
  ['membershipId', 'uuid'],
  ['sourceRowSha256', 'hex64'],
]
const codingLineSchema: Schema = [
  ['claimLineId', 'uuid'],
  ['encounterActivityId', 'uuid'],
  ['receiptId', 'uuid'],
  ['codeSystem', 'text'],
  ['referenceDatasetVersionId', 'uuid'],
  ['membershipId', 'uuid'],
  ['sourceRowSha256', 'hex64'],
]
const codingSchema: Schema = [
  ['manifestSha256', 'hex64'],
  ['diagnoses', { array: { object: codingDiagnosisSchema } }],
  ['lines', { array: { object: codingLineSchema } }],
]

// The A6-PAYLOAD-2 key order: the A6-PAYLOAD-1 schema exactly, then `coding`.
export const payloadSchemaV2: Schema = [...(payloadSchema as Schema), ['coding', { object: codingSchema }]]

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const dateShape = /^(\d{4})-(\d{2})-(\d{2})$/
const hex64Shape = /^[0-9a-f]{64}$/
const decimal4Shape = /^(0|[1-9]\d*)\.\d{4}$/
const moneyShape = (scale: number) => (scale === 0 ? /^(0|[1-9]\d*)$/ : new RegExp(`^(0|[1-9]\\d*)\\.\\d{${scale}}$`))

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function encodeText(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new PayloadEncodingError(path, 'must be a non-empty string')
  if (!value.isWellFormed()) throw new PayloadEncodingError(path, 'must be well-formed Unicode')
  return JSON.stringify(value)
}

// The same scalar rules as A6-PAYLOAD-1; only the schema version literal differs.
function encodeScalar(kind: string, value: unknown, path: string, moneyScale: number): string {
  if (value === undefined) throw new PayloadEncodingError(path, 'is undefined')
  switch (kind as Scalar | 'schemaVersion' | 'nullableUuid' | 'nullableText' | 'date' | 'position' | 'decimal4' | 'money') {
    case 'schemaVersion':
      if (value !== PAYLOAD_SCHEMA_VERSION_V2) throw new PayloadEncodingError(path, `must be ${PAYLOAD_SCHEMA_VERSION_V2}`)
      return JSON.stringify(value)
    case 'uuid':
      if (typeof value !== 'string' || !uuidShape.test(value)) throw new PayloadEncodingError(path, 'must be a lowercase UUID')
      return JSON.stringify(value)
    case 'nullableUuid':
      return value === null ? 'null' : encodeScalar('uuid', value, path, moneyScale)
    case 'text':
      return encodeText(value, path)
    case 'nullableText':
      return value === null ? 'null' : encodeText(value, path)
    case 'date': {
      const match = typeof value === 'string' ? dateShape.exec(value) : null
      const [year, month, day] = match ? [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10), Number.parseInt(match[3], 10)] : [0, 0, 0]
      const calendar = new Date(Date.UTC(year, month - 1, day))
      if (!match || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day)
        throw new PayloadEncodingError(path, 'must be a calendar date YYYY-MM-DD')
      return JSON.stringify(value)
    }
    case 'position':
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new PayloadEncodingError(path, 'must be a positive safe integer')
      return String(value)
    case 'hex64':
      if (typeof value !== 'string' || !hex64Shape.test(value)) throw new PayloadEncodingError(path, 'must be a lowercase SHA-256 hex digest')
      return JSON.stringify(value)
    case 'decimal4':
      if (typeof value !== 'string' || !decimal4Shape.test(value)) throw new PayloadEncodingError(path, 'must be a non-negative decimal string with exactly 4 decimals')
      return JSON.stringify(value)
    case 'money':
      if (typeof value !== 'string' || !moneyShape(moneyScale).test(value)) throw new PayloadEncodingError(path, `must be a non-negative decimal string with exactly ${moneyScale} decimals`)
      return JSON.stringify(value)
    default:
      throw new PayloadEncodingError(path, `unknown shape ${kind}`)
  }
}

function encodeShape(shape: Shape, value: unknown, path: string, moneyScale: number): string {
  if (typeof shape === 'string') return encodeScalar(shape, value, path, moneyScale)
  if ('object' in shape) return encodeObject(shape.object, value, path, moneyScale)
  if (!Array.isArray(value)) throw new PayloadEncodingError(path, 'must be an array')
  const items = value.map((item, index) => encodeShape(shape.array, item, `${path}[${index}]`, moneyScale))
  if (shape.order === 'ascending')
    for (let i = 1; i < value.length; i += 1)
      if (!((value[i - 1] as string) < (value[i] as string))) throw new PayloadEncodingError(path, 'must be strictly ascending (sorted and deduplicated)')
  if (shape.order === 'positions')
    value.forEach((item, index) => {
      if ((item as { sequence: number }).sequence !== index + 1) throw new PayloadEncodingError(`${path}[${index}].sequence`, `must be ${index + 1} (positions 1..N in order)`)
    })
  return `[${items.join(',')}]`
}

function encodeObject(schema: Schema, value: unknown, path: string, moneyScale: number): string {
  if (!isPlainRecord(value)) throw new PayloadEncodingError(path, 'must be a plain object')
  const expected = schema.map(([key]) => key)
  const unknown = Object.keys(value).filter((key) => !expected.includes(key))
  if (unknown.length > 0) throw new PayloadEncodingError(path, `unknown key(s): ${unknown.join(', ')}`)
  const missing = expected.filter((key) => !Object.prototype.hasOwnProperty.call(value, key))
  if (missing.length > 0) throw new PayloadEncodingError(path, `missing key(s): ${missing.join(', ')}`)
  return `{${schema.map(([key, shape]) => `${JSON.stringify(key)}:${encodeShape(shape, value[key], `${path}.${key}`, moneyScale)}`).join(',')}}`
}

export function encodeCanonicalPayloadV2(payload: CanonicalClaimPayloadV2, moneyScale: number) {
  if (!Number.isSafeInteger(moneyScale) || moneyScale < 0 || moneyScale > 4) throw new PayloadEncodingError('$', 'money scale must be an integer from 0 to 4')
  const text = encodeObject(payloadSchemaV2, payload, '$', moneyScale)
  const bytes = Buffer.from(text, 'utf8')
  return { text, bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
}

// The coding section from the V1-shaped payload and the run's recorded receipts (by target id). Every diagnosis and
// every procedure-coded line must have exactly one APPLICABLE receipt (a READY_FOR_REVIEW A5-VAL-2 run has no other);
// a service-only line has none. Order: the payload's own diagnosis and line order (claim positions).
export type RecordedReceipt = { receiptId: string; decisionCode: string; codeSystem: string | null; referenceDatasetVersionId: string | null; membershipId: string | null; sourceRowSha256: string | null }

export function codingSectionOf(
  payload: CanonicalClaimPayloadV1,
  manifestSha256: string,
  receiptsByTarget: ReadonlyMap<string, RecordedReceipt>,
): { ok: true; value: CanonicalCodingV2 } | { ok: false; detail: string } {
  const bound = (targetId: string) => {
    const receipt = receiptsByTarget.get(targetId)
    if (!receipt || receipt.decisionCode !== 'APPLICABLE' || !receipt.codeSystem || !receipt.referenceDatasetVersionId || !receipt.membershipId || !receipt.sourceRowSha256) return null
    return { receiptId: receipt.receiptId, codeSystem: receipt.codeSystem, referenceDatasetVersionId: receipt.referenceDatasetVersionId, membershipId: receipt.membershipId, sourceRowSha256: receipt.sourceRowSha256 }
  }
  const diagnoses: CodingDiagnosisV2[] = []
  for (const diagnosis of payload.diagnoses) {
    const receipt = bound(diagnosis.encounterDiagnosisId)
    if (!receipt) return { ok: false, detail: 'a claim diagnosis has no applicable coding receipt' }
    diagnoses.push({ claimDiagnosisId: diagnosis.claimDiagnosisId, encounterDiagnosisId: diagnosis.encounterDiagnosisId, ...receipt })
  }
  const lines: CodingLineV2[] = []
  for (const line of payload.lines) {
    if (line.procedureCodeId === null) {
      if (receiptsByTarget.has(line.encounterActivityId)) return { ok: false, detail: 'a service-only line has a coding receipt' }
      continue
    }
    const receipt = bound(line.encounterActivityId)
    if (!receipt) return { ok: false, detail: 'a procedure-coded claim line has no applicable coding receipt' }
    lines.push({ claimLineId: line.claimLineId, encounterActivityId: line.encounterActivityId, ...receipt })
  }
  return { ok: true, value: { manifestSha256, diagnoses, lines } }
}
