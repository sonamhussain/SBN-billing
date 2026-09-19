// A3.9 — pure rule-pack rules. Every lifecycle and membership decision lives here as a pure
// function, so the service and the tests share one definition and no rule is re-derived per route.

const uuidShape =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isRulePackUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidShape.test(value)
}

function normalizeTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

export function normalizePackKey(value: unknown): string | null {
  return normalizeTrimmedString(value)
}

export function normalizePackDisplayName(value: unknown): string | null {
  return normalizeTrimmedString(value)
}

export function normalizePackJurisdictionCode(value: unknown): string | null {
  return normalizeTrimmedString(value)
}

// The version text is an identifier only. It is never parsed, compared or used to rank versions.
export function normalizePackVersion(value: unknown): string | null {
  return normalizeTrimmedString(value)
}

export const rulePackVerificationStatuses = ['UNVERIFIED', 'VERIFIED'] as const
export const rulePackActivationStatuses = ['INACTIVE', 'ACTIVE', 'SUPERSEDED'] as const

// Jurisdiction compatibility uses the same normalized comparison as the rest of A3.
export function jurisdictionsMatch(a: string, b: string): boolean {
  return a.trim().toUpperCase() === b.trim().toUpperCase()
}

type PackIdentity = { organizationId: string | null; jurisdictionCode: string }
type MemberRule = { organizationId: string | null; jurisdictionCode: string }

// Which exact RuleVersions may belong to a pack (A3.9 §10):
// - an ORGANIZATION pack takes its own organization's rules and compatible SYSTEM_SHARED rules;
// - a SYSTEM_SHARED pack takes SYSTEM_SHARED rules only;
// - another organization's rule is never a member;
// - the jurisdictions must match after normalized trim/case comparison.
export type MemberEligibility =
  | { kind: 'eligible' }
  | { kind: 'foreign' }
  | { kind: 'shared_pack_requires_shared_rule' }
  | { kind: 'jurisdiction_mismatch' }

export function decideMemberEligibility(pack: PackIdentity, rule: MemberRule): MemberEligibility {
  if (pack.organizationId === null) {
    if (rule.organizationId !== null) return { kind: 'shared_pack_requires_shared_rule' }
  } else if (rule.organizationId !== null && rule.organizationId !== pack.organizationId) {
    return { kind: 'foreign' }
  }
  if (!jurisdictionsMatch(pack.jurisdictionCode, rule.jurisdictionCode)) return { kind: 'jurisdiction_mismatch' }
  return { kind: 'eligible' }
}

type VersionState = { verificationStatus: string; activationStatus: string }

// Only the working draft (UNVERIFIED + INACTIVE) may change dates or membership. Every other
// state is an immutable snapshot.
export function isDraft(version: VersionState): boolean {
  return version.verificationStatus === 'UNVERIFIED' && version.activationStatus === 'INACTIVE'
}

export const frozenSnapshotMessage =
  'this rule pack version is no longer a draft (UNVERIFIED and INACTIVE); its members and dates cannot change'

type VerificationMember = {
  ruleVersionId: string
  verificationStatus: string
  organizationId: string | null
  jurisdictionCode: string
}

export type VerificationDecision = { kind: 'verifiable' } | { kind: 'rejected'; message: string }

// Verification requires a draft with at least one member, every member RuleVersion VERIFIED, and
// every member still eligible for the pack (ownership and jurisdiction are rechecked, not trusted).
export function decideVerification(
  version: VersionState,
  pack: PackIdentity,
  members: VerificationMember[],
): VerificationDecision {
  if (!isDraft(version)) return { kind: 'rejected', message: 'only an UNVERIFIED, INACTIVE rule pack version can be verified' }
  if (members.length === 0) return { kind: 'rejected', message: 'a rule pack version needs at least one member to be verified' }

  const unverified = members.filter((member) => member.verificationStatus !== 'VERIFIED').map((member) => member.ruleVersionId)
  if (unverified.length > 0)
    return { kind: 'rejected', message: `every member rule version must be VERIFIED; not verified: ${unverified.sort().join(', ')}` }

  const ineligible = members.filter((member) => decideMemberEligibility(pack, member).kind !== 'eligible').map((member) => member.ruleVersionId)
  if (ineligible.length > 0)
    return { kind: 'rejected', message: `members no longer eligible for this pack (ownership or jurisdiction): ${ineligible.sort().join(', ')}` }

  return { kind: 'verifiable' }
}

type DatedVersion = VersionState & { effectiveFrom: Date | null; effectiveTo: Date | null }

// Inclusive window where either end may be open. A missing end is not "not in force": a pack
// version with no dates at all has no date restriction.
export function isWithinPackPeriod(version: { effectiveFrom: Date | null; effectiveTo: Date | null }, date: Date): boolean {
  if (!Number.isFinite(date.getTime())) return false
  if (version.effectiveFrom && date.getTime() < version.effectiveFrom.getTime()) return false
  if (version.effectiveTo && date.getTime() > version.effectiveTo.getTime()) return false
  return true
}

export function hasCoherentDates(version: { effectiveFrom: Date | null; effectiveTo: Date | null }): boolean {
  if (version.effectiveFrom && !Number.isFinite(version.effectiveFrom.getTime())) return false
  if (version.effectiveTo && !Number.isFinite(version.effectiveTo.getTime())) return false
  if (version.effectiveFrom && version.effectiveTo) return version.effectiveTo.getTime() >= version.effectiveFrom.getTime()
  return true
}

export type ActivationDecision = { kind: 'activatable' } | { kind: 'rejected'; message: string }

// Activation requires a VERIFIED, INACTIVE snapshot with coherent dates, and a businessDate inside
// its period when dates exist. An ACTIVE version is already current; a SUPERSEDED one is history
// and is never reactivated. Nothing here consults the version text or createdAt.
export function decideActivation(version: DatedVersion, businessDate: Date): ActivationDecision {
  if (version.verificationStatus !== 'VERIFIED')
    return { kind: 'rejected', message: 'only a VERIFIED rule pack version can be activated' }
  if (version.activationStatus === 'ACTIVE') return { kind: 'rejected', message: 'this rule pack version is already ACTIVE' }
  if (version.activationStatus === 'SUPERSEDED')
    return { kind: 'rejected', message: 'a SUPERSEDED rule pack version is historical and cannot be activated again' }
  if (!hasCoherentDates(version)) return { kind: 'rejected', message: 'the rule pack version effective dates are not coherent' }
  if (!isWithinPackPeriod(version, businessDate))
    return { kind: 'rejected', message: 'businessDate is outside the rule pack version effective period' }
  return { kind: 'activatable' }
}
