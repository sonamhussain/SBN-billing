export const activationBlockerCodes = [
  'SOURCE_NOT_PUBLISHED',
  'EFFECTIVE_DATE_INCOMPLETE',
  'SOURCE_NOT_EFFECTIVE',
  'AUTHORITY_UNVERIFIED',
  'INTERPRETATION_UNVERIFIED',
  'CONTRADICTORY_DATES',
  'JURISDICTION_INCOMPATIBLE',
  'OWNERSHIP_MISMATCH',
] as const

export type ActivationBlockerCode = (typeof activationBlockerCodes)[number]

export type ActivationEvaluationVersion = {
  publicationStatus: string
  effectiveFrom: Date | null
  effectiveTo: Date | null
  verificationStatus: string
}

export type ActivationEvaluationSource = {
  jurisdictionCode: string
  organizationId: string | null
}

export type ActivationEvaluationInterpretation = {
  verificationStatus: string
}

export type ActivationContext = {
  businessDate: Date
  jurisdictionCode: string
  requestingOrganizationId: string | null
}

export function isEffective(effectiveFrom: Date | null, effectiveTo: Date | null, businessDate: Date): boolean {
  if (!effectiveFrom) return false
  if (businessDate.getTime() < effectiveFrom.getTime()) return false
  if (effectiveTo && businessDate.getTime() > effectiveTo.getTime()) return false
  return true
}

function normalizeJurisdictionForCompare(value: string): string {
  return value.trim().toUpperCase()
}

// Deterministic and pure: never guesses, never performs I/O, returns unique sorted blocker codes.
export function evaluateActivationBlockers(
  version: ActivationEvaluationVersion,
  source: ActivationEvaluationSource,
  interpretations: ActivationEvaluationInterpretation[],
  context: ActivationContext,
): ActivationBlockerCode[] {
  const blockers = new Set<ActivationBlockerCode>()

  if (version.publicationStatus !== 'PUBLISHED') blockers.add('SOURCE_NOT_PUBLISHED')

  if (!version.effectiveFrom) {
    blockers.add('EFFECTIVE_DATE_INCOMPLETE')
  } else {
    if (version.effectiveTo && version.effectiveFrom.getTime() > version.effectiveTo.getTime()) {
      blockers.add('CONTRADICTORY_DATES')
    }
    if (!isEffective(version.effectiveFrom, version.effectiveTo, context.businessDate)) {
      blockers.add('SOURCE_NOT_EFFECTIVE')
    }
  }

  if (version.verificationStatus !== 'VERIFIED') blockers.add('AUTHORITY_UNVERIFIED')

  if (!interpretations.some((interpretation) => interpretation.verificationStatus === 'VERIFIED')) {
    blockers.add('INTERPRETATION_UNVERIFIED')
  }

  if (normalizeJurisdictionForCompare(context.jurisdictionCode) !== normalizeJurisdictionForCompare(source.jurisdictionCode)) {
    blockers.add('JURISDICTION_INCOMPATIBLE')
  }

  if (source.organizationId !== context.requestingOrganizationId) blockers.add('OWNERSHIP_MISMATCH')

  return [...blockers].sort()
}
