// A3.9 — Rule Pack Version & Provenance Contract. A RulePack is a stable grouping identity; a
// RulePackVersion is an exact governed snapshot; a RulePackMember says "this exact RuleVersion UUID
// belongs to this exact snapshot" and nothing more. Membership never creates applicability,
// executability or precedence — those stay with A3.6, A3.7 and A3.8.

export type RulePackDto = {
  id: string
  organizationId: string | null
  packKey: string
  displayName: string
  jurisdictionCode: string
  ownershipScope: string
  createdAt: string
  updatedAt: string
}

export type RulePackVersionDto = {
  id: string
  rulePackId: string
  version: string
  effectiveFrom: string | null
  effectiveTo: string | null
  verificationStatus: string
  verifiedAt: string | null
  activationStatus: string
  activatedAt: string | null
  supersededAt: string | null
  createdAt: string
  updatedAt: string
}

export type RulePackMemberDto = {
  id: string
  rulePackVersionId: string
  ruleVersionId: string
  createdAt: string
}

export type RulePackErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'FORBIDDEN'

export type RulePackResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: RulePackErrorCode; message: string }
