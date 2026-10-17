import { createHash } from 'node:crypto'
import { Prisma } from '../../../generated/prisma/client.ts'
import { PAYLOAD_SCHEMA_VERSION, type CanonicalClaimPayloadV1 } from './claim-payload.types.ts'

// A6.6 §4 — the one strict, deterministic encoder for A6-PAYLOAD-1.
//
// * Every object is written in the key order defined below, never in the order its properties happen to
//   have; an object must carry exactly its schema keys (an unknown, missing or undefined key is refused).
// * Output is compact UTF-8 JSON: no BOM, no whitespace, no trailing newline.
// * Strings are emitted with JSON's own escaping; identifiers must be lowercase UUIDs, dates YYYY-MM-DD and
//   decimals exact strings at their contract scale (no Number, sign, exponent or locale separator).
// * Integers are positive safe integers (positions only). There is no float anywhere.
// * The bytes are encoded once and the SHA-256 is taken over exactly those bytes.
// Nothing here reads a clock, the locale, the time zone or the environment.

export class PayloadEncodingError extends Error {
  readonly path: string
  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`)
    this.path = path
  }
}

type Scalar = 'schemaVersion' | 'uuid' | 'nullableUuid' | 'text' | 'nullableText' | 'date' | 'position' | 'hex64' | 'decimal4' | 'money'
type Shape = Scalar | { object: Schema } | { array: Shape; order?: 'ascending' | 'positions' }
type Schema = readonly (readonly [string, Shape])[]

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const dateShape = /^(\d{4})-(\d{2})-(\d{2})$/
const hex64Shape = /^[0-9a-f]{64}$/
const decimal4Shape = /^(0|[1-9]\d*)\.\d{4}$/
const moneyShape = (scale: number) => (scale === 0 ? /^(0|[1-9]\d*)$/ : new RegExp(`^(0|[1-9]\\d*)\\.\\d{${scale}}$`))

// §3 — the A6-PAYLOAD-1 key order. Changing anything here is a new schema version.
const headerSchema: Schema = [
  ['claimId', 'uuid'],
  ['claimContractVersion', 'text'],
  ['handoffSchemaVersion', 'text'],
  ['encounterId', 'uuid'],
  ['serviceDate', 'date'],
  ['facilityId', 'uuid'],
  ['facilityRegulatoryProfileId', 'uuid'],
  ['jurisdictionCode', 'text'],
  ['assessedValidationRunId', 'uuid'],
  ['readinessAssessmentId', 'uuid'],
  ['readinessPolicyVersion', 'text'],
  ['draftAssessmentId', 'uuid'],
  ['draftContractVersion', 'text'],
  ['draftFingerprint', 'hex64'],
  ['pricingRunId', 'uuid'],
  ['pricingContractVersion', 'text'],
  ['approvalDecisionId', 'uuid'],
]

const commercialSchema: Schema = [
  ['providerContractId', 'uuid'],
  ['tariffScheduleId', 'uuid'],
  ['tariffScheduleVersionId', 'uuid'],
  ['payerId', 'uuid'],
  ['tpaId', 'nullableUuid'],
  ['networkId', 'nullableUuid'],
  ['insuranceProductId', 'nullableUuid'],
  ['currencyCode', 'text'],
]

const lineSchema: Schema = [
  ['claimLineId', 'uuid'],
  ['sequence', 'position'],
  ['encounterActivityId', 'uuid'],
  ['serviceId', 'nullableUuid'],
  ['procedureCodeId', 'nullableUuid'],
  ['quantity', 'decimal4'],
  ['unitCode', 'nullableText'],
  ['modifierCodes', { array: 'text' }],
  ['pricingLineResultId', 'uuid'],
  ['tariffRateId', 'uuid'],
  ['unitTariffAmount', 'decimal4'],
  ['extendedAmount', 'money'],
  ['currencyCode', 'text'],
  ['claimDiagnosisIds', { array: 'uuid' }],
]

const diagnosisSchema: Schema = [
  ['claimDiagnosisId', 'uuid'],
  ['sequence', 'position'],
  ['encounterDiagnosisId', 'uuid'],
  ['roleCode', 'text'],
  ['diagnosisCodeId', 'uuid'],
]

const financialSchema: Schema = [
  ['totalExtendedAmount', 'money'],
  ['currencyCode', 'text'],
]

const sortedIds: Shape = { array: 'uuid', order: 'ascending' }
const evidenceSchema: Schema = [
  ['validationFindingIds', sortedIds],
  ['eligibilityVerificationIds', sortedIds],
  ['priorAuthorizationVersionIds', sortedIds],
  ['authorizationLineIds', sortedIds],
  ['evidenceRequirementIds', sortedIds],
  ['evidenceArtifactVersionIds', sortedIds],
  ['ruleVersionIds', sortedIds],
  ['governingSourceVersionIds', sortedIds],
  ['referenceDatasetVersionIds', sortedIds],
]

const approvalSchema: Schema = [
  ['reviewContractVersion', 'text'],
  ['decisionId', 'uuid'],
  ['reviewedAssessmentId', 'uuid'],
  ['reviewFingerprint', 'hex64'],
  ['reviewerUserId', 'uuid'],
]

export const payloadSchema: Schema = [
  ['schemaVersion', 'schemaVersion'],
  ['header', { object: headerSchema }],
  ['commercial', { object: commercialSchema }],
  ['lines', { array: { object: lineSchema }, order: 'positions' }],
  ['diagnoses', { array: { object: diagnosisSchema }, order: 'positions' }],
  ['financial', { object: financialSchema }],
  ['evidence', { object: evidenceSchema }],
  ['approval', { object: approvalSchema }],
]

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

function encodeScalar(kind: Scalar, value: unknown, path: string, moneyScale: number): string {
  if (value === undefined) throw new PayloadEncodingError(path, 'is undefined')
  switch (kind) {
    case 'schemaVersion':
      if (value !== PAYLOAD_SCHEMA_VERSION) throw new PayloadEncodingError(path, `must be ${PAYLOAD_SCHEMA_VERSION}`)
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

export type EncodedPayload = { text: string; bytes: Buffer; sha256: string }

// Encodes a payload whose money is at `moneyScale` decimals (the currency's minor units, owned by A6.3).
export function encodeCanonicalPayload(payload: CanonicalClaimPayloadV1, moneyScale: number): EncodedPayload {
  if (!Number.isSafeInteger(moneyScale) || moneyScale < 0 || moneyScale > 4) throw new PayloadEncodingError('$', 'money scale must be an integer from 0 to 4')
  const text = encodeObject(payloadSchema, payload, '$', moneyScale)
  const bytes = Buffer.from(text, 'utf8')
  return { text, bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
}

// An exact decimal string at `scale` from a stored Prisma Decimal. Refuses anything the string could not
// represent without loss (more stored precision than the scale), a negative value and a non-finite value.
export function exactDecimalText(value: Prisma.Decimal, scale: number, path: string): string {
  if (!value.isFinite()) throw new PayloadEncodingError(path, 'must be finite')
  if (value.isNegative() && !value.isZero()) throw new PayloadEncodingError(path, 'must not be negative')
  const text = value.abs().toFixed(scale)
  if (!new Prisma.Decimal(text).equals(value)) throw new PayloadEncodingError(path, `carries more precision than ${scale} decimals`)
  return text
}
