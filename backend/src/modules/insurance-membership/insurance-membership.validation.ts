import { formatDateOnly, normalizeDateOnlyField } from '../../shared/rules/date-only.ts'
import { isCommercialContextUuid, normalizeOptionalCommercialUuidField } from '../commercial-coverage/commercial-context.validation.ts'
import { membershipImmutableFields, membershipWritableFields, type InsuranceMembershipDto } from './insurance-membership.types.ts'

// A4.3 §9/§10/§12 — the pure validation contract, plus the §8 commercial-coherence decision. It
// reuses the shared strict date-only parser and the REF-01 commercial UUID helpers; there is no
// second parser. No message ever echoes a submitted member or policy value: an error names the
// field that was wrong, never what it contained.

export function isMembershipUuid(value: unknown): value is string {
  return typeof value === 'string' && isCommercialContextUuid(value)
}

const IDENTIFIER_MAX = 128

// A control character anywhere (CR, LF, tab, NUL, DEL …) is rejected rather than stripped: an
// identifier that needs one is a mistake, not something to repair silently.
const controlCharacters = /[\u0000-\u001f\u007f]/

export type FieldOutcome<T> = { ok: true; value: T } | { ok: false; message: string }

// Required; trimmed; 1–128 characters; case preserved; no formatting is guessed.
export function normalizeMemberIdentifier(value: unknown): FieldOutcome<string> {
  if (typeof value !== 'string') return { ok: false, message: 'memberIdentifier is required and must be a string' }
  if (controlCharacters.test(value)) return { ok: false, message: 'memberIdentifier must not contain control characters' }
  const trimmed = value.trim()
  if (trimmed.length === 0) return { ok: false, message: 'memberIdentifier must not be blank' }
  if (trimmed.length > IDENTIFIER_MAX) return { ok: false, message: `memberIdentifier must be at most ${IDENTIFIER_MAX} characters` }
  return { ok: true, value: trimmed }
}

// Optional; absent, null and blank all mean "not recorded" (null); otherwise trimmed, ≤128.
export function normalizePolicyIdentifier(value: unknown): FieldOutcome<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false, message: 'policyIdentifier must be a string or null' }
  if (controlCharacters.test(value)) return { ok: false, message: 'policyIdentifier must not contain control characters' }
  const trimmed = value.trim()
  if (trimmed.length === 0) return { ok: true, value: null }
  if (trimmed.length > IDENTIFIER_MAX) return { ok: false, message: `policyIdentifier must be at most ${IDENTIFIER_MAX} characters` }
  return { ok: true, value: trimmed }
}

export function normalizeRequiredPayerId(value: unknown): FieldOutcome<string> {
  if (!isMembershipUuid(value)) return { ok: false, message: 'payerId is required and must be a UUID' }
  return { ok: true, value }
}

function normalizeOptionalReference(value: unknown, field: string): FieldOutcome<string | null> {
  const outcome = normalizeOptionalCommercialUuidField(value)
  if (!outcome.valid) return { ok: false, message: `${field} must be a UUID or null` }
  return { ok: true, value: outcome.value }
}

// A recorded coverage date: a strict YYYY-MM-DD calendar day, or null for unknown. Timestamps and
// impossible dates are rejected, never rolled forward.
function normalizeCoverageDate(value: unknown, field: string): FieldOutcome<Date | null> {
  const outcome = normalizeDateOnlyField(value)
  if (!outcome.present) return { ok: true, value: null }
  if (!outcome.valid) return { ok: false, message: `${field} must be a real calendar date in YYYY-MM-DD format, or null` }
  return { ok: true, value: outcome.value }
}

// Either boundary may be unknown; only when both are recorded must the end not precede the start.
export function coverageDatesCoherent(coverageFrom: Date | null, coverageTo: Date | null): boolean {
  if (coverageFrom === null || coverageTo === null) return true
  return coverageTo.getTime() >= coverageFrom.getTime()
}

export type MembershipWriteInput = {
  payerId: string
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
  memberIdentifier: string
  policyIdentifier: string | null
  coverageFrom: Date | null
  coverageTo: Date | null
}

export type MembershipPatch = Partial<MembershipWriteInput>

export type ValidationOutcome<T> = { ok: true; value: T } | { ok: false; message: string }

function isPlainObject(body: unknown): body is Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
}

// Server-owned fields first (so a forged patientId is named as such), then anything unknown.
function refuseForeignKeys(body: Record<string, unknown>, immutableVerb: string): string | null {
  const keys = Object.keys(body)
  const immutable = membershipImmutableFields.filter((field) => keys.includes(field))
  if (immutable.length > 0) return `${immutable.join(', ')} ${immutableVerb}`
  const allowed = new Set<string>(membershipWritableFields)
  const unknown = keys.filter((key) => !allowed.has(key))
  if (unknown.length > 0) return `unknown field(s): ${unknown.join(', ')}`
  return null
}

export function validateCreateInput(body: unknown): ValidationOutcome<MembershipWriteInput> {
  if (!isPlainObject(body)) return { ok: false, message: 'a membership body is required' }
  const refused = refuseForeignKeys(body, 'is derived by the server and cannot be supplied')
  if (refused) return { ok: false, message: refused }

  const payerId = normalizeRequiredPayerId(body.payerId)
  if (!payerId.ok) return payerId
  const tpaId = normalizeOptionalReference(body.tpaId, 'tpaId')
  if (!tpaId.ok) return tpaId
  const networkId = normalizeOptionalReference(body.networkId, 'networkId')
  if (!networkId.ok) return networkId
  const insuranceProductId = normalizeOptionalReference(body.insuranceProductId, 'insuranceProductId')
  if (!insuranceProductId.ok) return insuranceProductId
  const memberIdentifier = normalizeMemberIdentifier(body.memberIdentifier)
  if (!memberIdentifier.ok) return memberIdentifier
  const policyIdentifier = normalizePolicyIdentifier(body.policyIdentifier)
  if (!policyIdentifier.ok) return policyIdentifier
  const coverageFrom = normalizeCoverageDate(body.coverageFrom, 'coverageFrom')
  if (!coverageFrom.ok) return coverageFrom
  const coverageTo = normalizeCoverageDate(body.coverageTo, 'coverageTo')
  if (!coverageTo.ok) return coverageTo
  if (!coverageDatesCoherent(coverageFrom.value, coverageTo.value))
    return { ok: false, message: 'coverageTo must not be before coverageFrom' }

  return {
    ok: true,
    value: {
      payerId: payerId.value,
      tpaId: tpaId.value,
      networkId: networkId.value,
      insuranceProductId: insuranceProductId.value,
      memberIdentifier: memberIdentifier.value,
      policyIdentifier: policyIdentifier.value,
      coverageFrom: coverageFrom.value,
      coverageTo: coverageTo.value,
    },
  }
}

// A PATCH carries only the fields it supplies. An absent field is untouched; an explicit null
// clears an optional one (TPA, network, product, policy, either date). payerId and
// memberIdentifier are required facts and can be corrected but never cleared. Date order and
// commercial coherence are judged on the MERGED state by the service, not here.
export function validateUpdateInput(body: unknown): ValidationOutcome<MembershipPatch> {
  if (!isPlainObject(body)) return { ok: false, message: 'a membership body is required' }
  const refused = refuseForeignKeys(body, 'cannot be changed')
  if (refused) return { ok: false, message: refused }
  const supplied = Object.keys(body)
  if (supplied.length === 0) return { ok: false, message: 'a patch must change at least one field' }

  const patch: MembershipPatch = {}
  if (supplied.includes('payerId')) {
    const outcome = normalizeRequiredPayerId(body.payerId)
    if (!outcome.ok) return { ok: false, message: 'payerId must be a UUID and cannot be cleared' }
    patch.payerId = outcome.value
  }
  for (const field of ['tpaId', 'networkId', 'insuranceProductId'] as const) {
    if (!supplied.includes(field)) continue
    const outcome = normalizeOptionalReference(body[field], field)
    if (!outcome.ok) return outcome
    patch[field] = outcome.value
  }
  if (supplied.includes('memberIdentifier')) {
    const outcome = normalizeMemberIdentifier(body.memberIdentifier)
    if (!outcome.ok) return outcome
    patch.memberIdentifier = outcome.value
  }
  if (supplied.includes('policyIdentifier')) {
    const outcome = normalizePolicyIdentifier(body.policyIdentifier)
    if (!outcome.ok) return outcome
    patch.policyIdentifier = outcome.value
  }
  for (const field of ['coverageFrom', 'coverageTo'] as const) {
    if (!supplied.includes(field)) continue
    const outcome = normalizeCoverageDate(body[field], field)
    if (!outcome.ok) return outcome
    patch[field] = outcome.value
  }
  return { ok: true, value: patch }
}

export type StoredMembership = MembershipWriteInput

// The state a PATCH would produce: every supplied field replaces the stored one.
export function mergeMembership(stored: StoredMembership, patch: MembershipPatch): MembershipWriteInput {
  return {
    payerId: patch.payerId ?? stored.payerId,
    tpaId: patch.tpaId !== undefined ? patch.tpaId : stored.tpaId,
    networkId: patch.networkId !== undefined ? patch.networkId : stored.networkId,
    insuranceProductId: patch.insuranceProductId !== undefined ? patch.insuranceProductId : stored.insuranceProductId,
    memberIdentifier: patch.memberIdentifier ?? stored.memberIdentifier,
    policyIdentifier: patch.policyIdentifier !== undefined ? patch.policyIdentifier : stored.policyIdentifier,
    coverageFrom: patch.coverageFrom !== undefined ? patch.coverageFrom : stored.coverageFrom,
    coverageTo: patch.coverageTo !== undefined ? patch.coverageTo : stored.coverageTo,
  }
}

const sameDate = (a: Date | null, b: Date | null) => (a === null || b === null ? a === b : a.getTime() === b.getTime())

// Which supplied fields actually differ from what is stored. A patch that changes nothing is not
// a write: it is refused and never produces an AuditEvent.
export function changedFields(stored: StoredMembership, patch: MembershipPatch): string[] {
  const changed: string[] = []
  for (const field of ['payerId', 'tpaId', 'networkId', 'insuranceProductId', 'memberIdentifier', 'policyIdentifier'] as const) {
    if (patch[field] !== undefined && patch[field] !== stored[field]) changed.push(field)
  }
  for (const field of ['coverageFrom', 'coverageTo'] as const) {
    const value = patch[field]
    if (value !== undefined && !sameDate(value, stored[field])) changed.push(field)
  }
  return changed
}

// ---- §8 commercial coherence -------------------------------------------------------------------

// What the service read, inside the write transaction, for each referenced master. A master that
// does not exist is null; a master that exists is described by its owning organization (and, for
// a product, its payer). productNetworkExists is only meaningful when both product and network
// were named.
export type CoherenceFacts = {
  patientOrganizationId: string
  payer: { organizationId: string } | null
  tpa: { organizationId: string } | null | 'not-supplied'
  network: { organizationId: string } | null | 'not-supplied'
  product: { organizationId: string; payerId: string } | null | 'not-supplied'
  productNetworkExists: boolean | 'not-applicable'
  payerId: string
}

export type CoherenceDecision =
  | { ok: true }
  | { ok: false; code: 'NOT_FOUND' | 'VALIDATION_ERROR'; message: string }

// Missing and foreign masters are refused identically ("not found"), so a caller can never learn
// that an ID belongs to another organization. A genuine contradiction between two masters of this
// organization is a VALIDATION_ERROR. Nothing is inferred: no contract, tariff, eligibility or
// primary coverage.
export function decideCommercialCoherence(facts: CoherenceFacts): CoherenceDecision {
  const own = (master: { organizationId: string } | null) => master !== null && master.organizationId === facts.patientOrganizationId
  if (!own(facts.payer)) return { ok: false, code: 'NOT_FOUND', message: 'payer not found' }
  if (facts.tpa !== 'not-supplied' && !own(facts.tpa)) return { ok: false, code: 'NOT_FOUND', message: 'tpa not found' }
  if (facts.network !== 'not-supplied' && !own(facts.network)) return { ok: false, code: 'NOT_FOUND', message: 'network not found' }
  if (facts.product !== 'not-supplied') {
    if (!own(facts.product)) return { ok: false, code: 'NOT_FOUND', message: 'insurance product not found' }
    if (facts.product?.payerId !== facts.payerId)
      return { ok: false, code: 'VALIDATION_ERROR', message: 'insuranceProductId belongs to a different payer than payerId' }
  }
  if (facts.productNetworkExists === false)
    return { ok: false, code: 'VALIDATION_ERROR', message: 'insuranceProductId and networkId have no existing ProductNetwork relationship' }
  return { ok: true }
}

export function toMembershipDto(record: {
  id: string
  patientId: string
  payerId: string
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
  memberIdentifier: string
  policyIdentifier: string | null
  coverageFrom: Date | null
  coverageTo: Date | null
  createdAt: Date
  updatedAt: Date
}): InsuranceMembershipDto {
  return {
    id: record.id,
    patientId: record.patientId,
    payerId: record.payerId,
    tpaId: record.tpaId,
    networkId: record.networkId,
    insuranceProductId: record.insuranceProductId,
    memberIdentifier: record.memberIdentifier,
    policyIdentifier: record.policyIdentifier,
    coverageFrom: formatDateOnly(record.coverageFrom),
    coverageTo: formatDateOnly(record.coverageTo),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}
