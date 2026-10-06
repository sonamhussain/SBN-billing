import { Prisma } from '../../../generated/prisma/client.ts'
import { formatDateOnly, parseStrictDateOnly } from '../../shared/rules/date-only.ts'
// A4.6 owns the strict quantity grammar and the unitCode normalization for encounter activities. A5.4
// compares its lines against exactly those activity values, so it parses with exactly the same rules:
// a second parser for the same concept is how a value gets accepted on one side and refused on the
// other.
import { normalizeUnitCode, parsePositiveQuantity } from '../encounter-activity/encounter-activity.validation.ts'
import {
  MAX_LINES_PER_BATCH,
  lineInputFields,
  lineServerOwnedFields,
  lineStatuses,
  type AuthorizationLineDto,
  type AuthorizationLineInput,
  type LineStatus,
} from './authorization-line.types.ts'

// A5.4 — the pure line rules. No database access lives here.
//
// Error messages name the line and the field that was wrong and never echo the submitted values.

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isAuthorizationLineUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidShape.test(value)
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; message: string }

const UNIT_CODE_MAX = 64
const hasControlCharacters = (value: string) => /[\u0000-\u001f\u007f]/.test(value)

// An explicit zero, written in any of the forms the shared grammar would otherwise accept. Zero is a
// real approved quantity ("approved for none") and is distinct from null ("not supplied").
const EXACT_ZERO = /^0(?:\.0{1,4})?$/

export function normalizeRequestedQty(value: unknown): Outcome<string> {
  const parsed = parsePositiveQuantity(value)
  if (!parsed.ok) return { ok: false, message: 'requestedQty must be a positive decimal string with at most 14 digits before and 4 after the decimal point' }
  return { ok: true, value: parsed.value.toString() }
}

// Non-negative: the shared grammar for anything positive, plus an explicit zero. There is deliberately
// no rule that approvedQty is at most requestedQty — payer semantics are external, and what was
// reported is preserved for A5.8 to judge.
export function normalizeApprovedQty(value: unknown): Outcome<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value === 'string' && EXACT_ZERO.test(value.trim())) return { ok: true, value: '0' }
  const parsed = parsePositiveQuantity(value)
  if (!parsed.ok) return { ok: false, message: 'approvedQty must be null or a non-negative decimal string with at most 14 digits before and 4 after the decimal point' }
  return { ok: true, value: parsed.value.toString() }
}

// A4.6's rule first — absent or null means none, a supplied value is trimmed, and a blank one is
// refused rather than silently turned into null — then the two limits A5.4 adds.
export function normalizeLineUnitCode(value: unknown): Outcome<string | null> {
  const normalized = normalizeUnitCode(value)
  if (!normalized.ok) return normalized
  if (normalized.value === null) return normalized
  if (hasControlCharacters(normalized.value)) return { ok: false, message: 'unitCode must not contain control characters' }
  if (normalized.value.length > UNIT_CODE_MAX) return { ok: false, message: `unitCode must be at most ${UNIT_CODE_MAX} characters` }
  return normalized
}

export function normalizeLineStatus(value: unknown): Outcome<LineStatus> {
  if (typeof value !== 'string' || !(lineStatuses as readonly string[]).includes(value))
    return { ok: false, message: `status must be one of ${lineStatuses.join(', ')}` }
  return { ok: true, value: value as LineStatus }
}

function optionalUuid(value: unknown, field: string): Outcome<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (!isAuthorizationLineUuid(value)) return { ok: false, message: `${field} must be a UUID or null` }
  return { ok: true, value }
}

function optionalDate(value: unknown, field: string): Outcome<Date | null> {
  if (value === undefined || value === null) return { ok: true, value: null }
  const parsed = parseStrictDateOnly(value)
  if (!parsed) return { ok: false, message: `${field} must be a real calendar date in YYYY-MM-DD format, or null` }
  return { ok: true, value: parsed }
}

export function validateLine(value: unknown): Outcome<AuthorizationLineInput> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, message: 'each line must be an object' }

  const keys = Object.keys(value as Record<string, unknown>)
  const serverOwned = lineServerOwnedFields.filter((field) => keys.includes(field))
  if (serverOwned.length > 0) return { ok: false, message: `${serverOwned.join(', ')} is derived by the server and cannot be supplied` }
  const allowed = new Set<string>(lineInputFields)
  const unknown = keys.filter((key) => !allowed.has(key))
  if (unknown.length > 0) return { ok: false, message: `unknown field(s): ${unknown.join(', ')}` }

  const record = value as Record<string, unknown>
  const serviceId = optionalUuid(record.serviceId, 'serviceId')
  if (!serviceId.ok) return serviceId
  const procedureCodeId = optionalUuid(record.procedureCodeId, 'procedureCodeId')
  if (!procedureCodeId.ok) return procedureCodeId
  // A diagnosis alone does not say what was authorized.
  if (serviceId.value === null && procedureCodeId.value === null)
    return { ok: false, message: 'at least one of serviceId or procedureCodeId is required; a diagnosis alone does not identify the authorized service' }
  const diagnosisCodeId = optionalUuid(record.diagnosisCodeId, 'diagnosisCodeId')
  if (!diagnosisCodeId.ok) return diagnosisCodeId

  const requestedQty = normalizeRequestedQty(record.requestedQty)
  if (!requestedQty.ok) return requestedQty
  const approvedQty = normalizeApprovedQty(record.approvedQty)
  if (!approvedQty.ok) return approvedQty
  const unitCode = normalizeLineUnitCode(record.unitCode)
  if (!unitCode.ok) return unitCode

  const approvedFrom = optionalDate(record.approvedFrom, 'approvedFrom')
  if (!approvedFrom.ok) return approvedFrom
  const approvedThrough = optionalDate(record.approvedThrough, 'approvedThrough')
  if (!approvedThrough.ok) return approvedThrough
  if (approvedFrom.value !== null && approvedThrough.value !== null && approvedThrough.value.getTime() < approvedFrom.value.getTime())
    return { ok: false, message: 'approvedThrough must not be earlier than approvedFrom' }

  const status = normalizeLineStatus(record.status)
  if (!status.ok) return status

  return {
    ok: true,
    value: {
      serviceId: serviceId.value,
      procedureCodeId: procedureCodeId.value,
      diagnosisCodeId: diagnosisCodeId.value,
      requestedQty: requestedQty.value,
      approvedQty: approvedQty.value,
      unitCode: unitCode.value,
      approvedFrom: approvedFrom.value,
      approvedThrough: approvedThrough.value,
      status: status.value,
    },
  }
}

// The whole batch. Lines keep their submitted order, which becomes the server-owned sequence.
export function validateLineBatch(body: unknown): Outcome<AuthorizationLineInput[]> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, message: 'a body of the form { lines: [...] } is required' }
  const keys = Object.keys(body as Record<string, unknown>)
  const extra = keys.filter((key) => key !== 'lines')
  if (extra.length > 0) return { ok: false, message: `unknown field(s): ${extra.join(', ')}` }

  const lines = (body as Record<string, unknown>).lines
  if (!Array.isArray(lines) || lines.length === 0) return { ok: false, message: 'lines must be a non-empty array' }
  if (lines.length > MAX_LINES_PER_BATCH) return { ok: false, message: `a batch may contain at most ${MAX_LINES_PER_BATCH} lines` }

  const validated: AuthorizationLineInput[] = []
  for (const [index, line] of lines.entries()) {
    const outcome = validateLine(line)
    if (!outcome.ok) return { ok: false, message: `lines[${index}]: ${outcome.message}` }
    validated.push(outcome.value)
  }
  return { ok: true, value: validated }
}

export type StoredLine = {
  id: string
  priorAuthorizationVersionId: string
  sequence: number
  serviceId: string | null
  procedureCodeId: string | null
  diagnosisCodeId: string | null
  requestedQty: Prisma.Decimal
  approvedQty: Prisma.Decimal | null
  unitCode: string | null
  approvedFrom: Date | null
  approvedThrough: Date | null
  status: string
  createdByUserId: string
  createdAt: Date
}

// NUMERIC(18,4) comes back as a Decimal carrying its full scale ("2.0000"). The DTO reports the exact
// value in its shortest form ("2"), so a line reads back exactly as it was reported.
export const decimalString = (value: Prisma.Decimal) => new Prisma.Decimal(value).toString()

export function toLineDto(record: StoredLine): AuthorizationLineDto {
  return {
    id: record.id,
    priorAuthorizationVersionId: record.priorAuthorizationVersionId,
    sequence: record.sequence,
    serviceId: record.serviceId,
    procedureCodeId: record.procedureCodeId,
    diagnosisCodeId: record.diagnosisCodeId,
    requestedQty: decimalString(record.requestedQty),
    approvedQty: record.approvedQty === null ? null : decimalString(record.approvedQty),
    unitCode: record.unitCode,
    approvedFrom: formatDateOnly(record.approvedFrom),
    approvedThrough: formatDateOnly(record.approvedThrough),
    status: record.status as LineStatus,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
  }
}

// The audit snapshot for a captured line: which row, under which version, in which position, and
// when. The service, procedure, diagnosis, quantities, unit, dates and status are all deliberately
// absent — an audit trail carrying them would become a second store of authorization scope.
export function lineAuditSnapshot(record: { id: string; priorAuthorizationVersionId: string; sequence: number; createdAt: Date }) {
  return {
    id: record.id,
    priorAuthorizationVersionId: record.priorAuthorizationVersionId,
    sequence: record.sequence,
    createdAt: record.createdAt.toISOString(),
  }
}

// §12 steps 4-5 — the frozen A5.3 context against the Encounter as it stands now. Every field the
// authorization case froze must still be equal: the selected membership, that membership's payer, TPA,
// network and product, the facility, the clinician and the service date. Any difference is drift and
// the evaluation fails closed. Nothing is re-resolved and no other authorization is substituted.
export type FrozenAuthorizationContext = {
  insuranceMembershipId: string
  payerId: string
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
  facilityId: string
  clinicianId: string
  serviceDate: Date
}

export type CurrentEncounterContext = {
  insuranceMembershipId: string | null
  facilityId: string
  clinicianId: string
  serviceDate: Date
  membership: { payerId: string; tpaId: string | null; networkId: string | null; insuranceProductId: string | null } | null
}

export function frozenContextMatches(frozen: FrozenAuthorizationContext, current: CurrentEncounterContext | null): boolean {
  if (current === null || current.membership === null) return false
  return (
    current.insuranceMembershipId === frozen.insuranceMembershipId &&
    current.membership.payerId === frozen.payerId &&
    current.membership.tpaId === frozen.tpaId &&
    current.membership.networkId === frozen.networkId &&
    current.membership.insuranceProductId === frozen.insuranceProductId &&
    current.facilityId === frozen.facilityId &&
    current.clinicianId === frozen.clinicianId &&
    current.serviceDate.getTime() === frozen.serviceDate.getTime()
  )
}
