import { formatDateOnly, parseStrictDateOnly, parseStrictTimestamp } from '../../shared/rules/date-only.ts'
import {
  authorizationStatuses,
  decisionStatuses,
  evidenceLinkFields,
  evidenceRoles,
  responseBearingKinds,
  versionInputFields,
  versionKinds,
  versionServerOwnedFields,
  type AuthorizationStatus,
  type EvidenceLinkInput,
  type EvidenceRole,
  type PriorAuthorizationDto,
  type PriorAuthorizationVersionDto,
  type VersionInput,
  type VersionKind,
} from './prior-authorization.types.ts'

// A5.3 — the pure rules. No database access lives here, so every decision is unit-testable on its
// own and there is exactly one copy of each.
//
// The shared strict date and timestamp parsers are reused; there is deliberately no second one.
// Error messages name the field that was wrong and never echo the authorization reference, evidence
// metadata, member or policy identifiers, or any condition or document content.

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isAuthorizationUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidShape.test(value)
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; message: string }

const REFERENCE_MAX = 128
// Control characters, including the line breaks that would let a reference smuggle a second line
// into a log or a report.
const hasControlCharacters = (value: string) => /[\u0000-\u001f\u007f]/.test(value)

export function normalizeVersionKind(value: unknown): Outcome<VersionKind> {
  if (typeof value !== 'string' || !(versionKinds as readonly string[]).includes(value))
    return { ok: false, message: `versionKind must be one of ${versionKinds.join(', ')}` }
  return { ok: true, value: value as VersionKind }
}

export function normalizeAuthorizationStatus(value: unknown): Outcome<AuthorizationStatus> {
  if (typeof value !== 'string' || !(authorizationStatuses as readonly string[]).includes(value))
    return { ok: false, message: `status must be one of ${authorizationStatuses.join(', ')}` }
  return { ok: true, value: value as AuthorizationStatus }
}

// Optional and opaque. Case is preserved because a payer reference is theirs, not ours to
// normalize, and nothing about it is unique: payer semantics are external and a reference may be
// absent or reused across cases.
export function normalizeAuthorizationReference(value: unknown): Outcome<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false, message: 'authorizationReference must be a string or null' }
  const trimmed = value.trim()
  if (trimmed === '') return { ok: false, message: 'authorizationReference must not be blank' }
  if (hasControlCharacters(trimmed)) return { ok: false, message: 'authorizationReference must not contain control characters' }
  if (trimmed.length > REFERENCE_MAX) return { ok: false, message: `authorizationReference must be at most ${REFERENCE_MAX} characters` }
  return { ok: true, value: trimmed }
}

export function normalizeOptionalInstant(value: unknown, field: string): Outcome<Date | null> {
  if (value === undefined || value === null) return { ok: true, value: null }
  const parsed = parseStrictTimestamp(value)
  if (!parsed) return { ok: false, message: `${field} must be a valid ISO-8601 instant, or null` }
  return { ok: true, value: parsed }
}

export function normalizeOptionalDate(value: unknown, field: string): Outcome<Date | null> {
  if (value === undefined || value === null) return { ok: true, value: null }
  const parsed = parseStrictDateOnly(value)
  if (!parsed) return { ok: false, message: `${field} must be a real calendar date in YYYY-MM-DD format, or null` }
  return { ok: true, value: parsed }
}

export function normalizeEvidenceRole(value: unknown): Outcome<EvidenceRole> {
  if (typeof value !== 'string' || !(evidenceRoles as readonly string[]).includes(value))
    return { ok: false, message: `evidence role must be one of ${evidenceRoles.join(', ')}` }
  return { ok: true, value: value as EvidenceRole }
}

// Every version must be evidence-bearing: a lifecycle snapshot nobody can point at is not a record
// of anything. Duplicates of the same version and role are refused rather than silently collapsed,
// because a caller who sent one twice did not mean to.
export function normalizeEvidenceLinks(value: unknown): Outcome<EvidenceLinkInput[]> {
  if (!Array.isArray(value) || value.length === 0)
    return { ok: false, message: 'evidenceLinks must be a non-empty array' }

  const allowed = new Set<string>(evidenceLinkFields)
  const links: EvidenceLinkInput[] = []
  const seen = new Set<string>()

  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
      return { ok: false, message: 'each evidence link must be an object with role and evidenceArtifactVersionId' }
    const unknown = Object.keys(entry as Record<string, unknown>).filter((key) => !allowed.has(key))
    if (unknown.length > 0) return { ok: false, message: `unknown field(s) in evidenceLinks: ${unknown.join(', ')}` }

    const record = entry as Record<string, unknown>
    const role = normalizeEvidenceRole(record.role)
    if (!role.ok) return role
    if (!isAuthorizationUuid(record.evidenceArtifactVersionId))
      return { ok: false, message: 'evidenceArtifactVersionId must be a UUID' }

    const key = `${record.evidenceArtifactVersionId}:${role.value}`
    if (seen.has(key)) return { ok: false, message: 'evidenceLinks must not repeat the same evidence version in the same role' }
    seen.add(key)
    links.push({ role: role.value, evidenceArtifactVersionId: record.evidenceArtifactVersionId })
  }

  return { ok: true, value: links }
}

function suppliedKeys(body: unknown): string[] {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return []
  return Object.keys(body as Record<string, unknown>)
}

// One body shape serves both creating a case with its first version and appending a later one. The
// caller describes a complete lifecycle snapshot; the server decides which version number it becomes
// and what context it is frozen against.
//
// `expect` says which end of the lifecycle this is. §14: creating a case FORCES INITIAL regardless
// of what the client attempted, because the server owns the shape of the sequence exactly as it owns
// the version number — version 1 is where a case begins, and that is not a caller's choice. The
// value must still be a valid enum, and the response returns the kind that was actually recorded, so
// a caller who sent something else sees immediately what happened. Appending forbids INITIAL: only
// the first version begins a case.
export function validateVersionBody(body: unknown, expect: 'first' | 'append'): Outcome<VersionInput> {
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return { ok: false, message: 'a prior authorization version body is required' }

  const keys = suppliedKeys(body)
  const serverOwned = versionServerOwnedFields.filter((field) => keys.includes(field))
  if (serverOwned.length > 0)
    return { ok: false, message: `${serverOwned.join(', ')} is derived by the server and cannot be supplied` }

  const allowed = new Set<string>(versionInputFields)
  const unknown = keys.filter((key) => !allowed.has(key))
  if (unknown.length > 0) return { ok: false, message: `unknown field(s): ${unknown.join(', ')}` }

  const record = body as Record<string, unknown>

  const versionKind = normalizeVersionKind(record.versionKind)
  if (!versionKind.ok) return versionKind
  if (expect === 'append' && versionKind.value === 'INITIAL')
    return { ok: false, message: 'only the first version may be INITIAL; a later version records what changed' }
  // Forced, not refused. Every rule below is then applied to the kind that will actually be stored,
  // so a create that named RESPONSE does not inherit RESPONSE's evidence obligation.
  const effectiveKind: VersionKind = expect === 'first' ? 'INITIAL' : versionKind.value

  const status = normalizeAuthorizationStatus(record.status)
  if (!status.ok) return status
  const authorizationReference = normalizeAuthorizationReference(record.authorizationReference)
  if (!authorizationReference.ok) return authorizationReference
  const requestedAt = normalizeOptionalInstant(record.requestedAt, 'requestedAt')
  if (!requestedAt.ok) return requestedAt
  const respondedAt = normalizeOptionalInstant(record.respondedAt, 'respondedAt')
  if (!respondedAt.ok) return respondedAt
  const validFrom = normalizeOptionalDate(record.validFrom, 'validFrom')
  if (!validFrom.ok) return validFrom
  const validThrough = normalizeOptionalDate(record.validThrough, 'validThrough')
  if (!validThrough.ok) return validThrough

  if (record.eligibilityVerificationId !== undefined && record.eligibilityVerificationId !== null && !isAuthorizationUuid(record.eligibilityVerificationId))
    return { ok: false, message: 'eligibilityVerificationId must be a UUID or null' }
  const eligibilityVerificationId = (record.eligibilityVerificationId ?? null) as string | null

  const evidenceLinks = normalizeEvidenceLinks(record.evidenceLinks)
  if (!evidenceLinks.ok) return evidenceLinks

  // A response cannot precede its own request, and a validity window cannot end before it begins.
  if (requestedAt.value !== null && respondedAt.value !== null && respondedAt.value.getTime() < requestedAt.value.getTime())
    return { ok: false, message: 'respondedAt must not be earlier than requestedAt' }
  if (validFrom.value !== null && validThrough.value !== null && validThrough.value.getTime() < validFrom.value.getTime())
    return { ok: false, message: 'validThrough must not be earlier than validFrom' }

  // A decision the payer actually made must say when it was made, and must be backed by the
  // response that carries it. REQUESTED, PENDING and UNKNOWN carry neither obligation, because
  // nothing was decided.
  const isDecision = (decisionStatuses as readonly string[]).includes(status.value)
  if (isDecision && respondedAt.value === null)
    return { ok: false, message: `status ${status.value} requires respondedAt: a decision must say when it was made` }

  const hasResponseEvidence = evidenceLinks.value.some((link) => link.role === 'RESPONSE')
  if (isDecision && !hasResponseEvidence)
    return { ok: false, message: `status ${status.value} requires at least one RESPONSE evidence link` }
  if ((responseBearingKinds as readonly string[]).includes(effectiveKind) && !hasResponseEvidence)
    return { ok: false, message: `versionKind ${effectiveKind} requires at least one RESPONSE evidence link` }

  return {
    ok: true,
    value: {
      versionKind: effectiveKind,
      status: status.value,
      authorizationReference: authorizationReference.value,
      eligibilityVerificationId,
      requestedAt: requestedAt.value,
      respondedAt: respondedAt.value,
      validFrom: validFrom.value,
      validThrough: validThrough.value,
      evidenceLinks: evidenceLinks.value,
    },
  }
}

// The server owns the number. A client-supplied version would let a caller overwrite history by
// claiming a number that already exists, or leave a gap by skipping one.
export function nextVersionNumber(currentMax: number | null): number {
  return (currentMax ?? 0) + 1
}

// An optional A5.2 verification may be linked only when it describes the SAME situation this
// authorization is frozen against. This is a context match, not an eligibility decision: the
// verification's status and freshness are never consulted.
export type EligibilityContextFacts = {
  encounterId: string
  insuranceMembershipId: string
  payerId: string
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
  serviceDate: Date
}

export function eligibilityContextMatches(authorization: EligibilityContextFacts, verification: EligibilityContextFacts): boolean {
  return (
    authorization.encounterId === verification.encounterId &&
    authorization.insuranceMembershipId === verification.insuranceMembershipId &&
    authorization.payerId === verification.payerId &&
    authorization.tpaId === verification.tpaId &&
    authorization.networkId === verification.networkId &&
    authorization.insuranceProductId === verification.insuranceProductId &&
    authorization.serviceDate.getTime() === verification.serviceDate.getTime()
  )
}

export type StoredEvidenceLink = {
  id: string
  evidenceArtifactVersionId: string
  role: string
  createdAt: Date
}

export type StoredVersion = {
  id: string
  priorAuthorizationId: string
  version: number
  versionKind: string
  status: string
  authorizationReference: string | null
  eligibilityVerificationId: string | null
  requestedAt: Date | null
  respondedAt: Date | null
  validFrom: Date | null
  validThrough: Date | null
  createdByUserId: string
  createdAt: Date
  evidenceLinks: StoredEvidenceLink[]
}

export function toVersionDto(record: StoredVersion): PriorAuthorizationVersionDto {
  return {
    id: record.id,
    priorAuthorizationId: record.priorAuthorizationId,
    version: record.version,
    versionKind: record.versionKind as VersionKind,
    status: record.status as AuthorizationStatus,
    authorizationReference: record.authorizationReference,
    eligibilityVerificationId: record.eligibilityVerificationId,
    requestedAt: record.requestedAt === null ? null : record.requestedAt.toISOString(),
    respondedAt: record.respondedAt === null ? null : record.respondedAt.toISOString(),
    validFrom: formatDateOnly(record.validFrom),
    validThrough: formatDateOnly(record.validThrough),
    evidenceLinks: record.evidenceLinks.map((link) => ({
      id: link.id,
      evidenceArtifactVersionId: link.evidenceArtifactVersionId,
      role: link.role as EvidenceRole,
      createdAt: link.createdAt.toISOString(),
    })),
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
  }
}

export type StoredAuthorization = {
  id: string
  encounterId: string
  insuranceMembershipId: string
  payerId: string
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
  facilityId: string
  clinicianId: string
  serviceDate: Date
  createdAt: Date
}

export function toAuthorizationDto(record: StoredAuthorization, latest: PriorAuthorizationVersionDto): PriorAuthorizationDto {
  return {
    id: record.id,
    encounterId: record.encounterId,
    insuranceMembershipId: record.insuranceMembershipId,
    payerId: record.payerId,
    tpaId: record.tpaId,
    networkId: record.networkId,
    insuranceProductId: record.insuranceProductId,
    facilityId: record.facilityId,
    clinicianId: record.clinicianId,
    serviceDate: formatDateOnly(record.serviceDate) as string,
    latestRecordedVersion: latest,
    createdAt: record.createdAt.toISOString(),
  }
}

// The audit snapshot for an authorization action. It proves the action happened and nothing more.
// The status, the authorization reference, the encounter, membership, commercial and provider
// identities, the validity dates, the eligibility link and the evidence ids are all deliberately
// absent: an audit trail carrying them would become a second authorization store, and authorization
// facts alone reveal a patient's clinical and insurance situation.
export function authorizationAuditSnapshot(record: { id: string; createdAt: Date }) {
  return { id: record.id, createdAt: record.createdAt.toISOString() }
}

export function versionAuditSnapshot(record: { id: string; priorAuthorizationId: string; version: number; createdAt: Date }) {
  return {
    id: record.id,
    priorAuthorizationId: record.priorAuthorizationId,
    version: record.version,
    createdAt: record.createdAt.toISOString(),
  }
}
