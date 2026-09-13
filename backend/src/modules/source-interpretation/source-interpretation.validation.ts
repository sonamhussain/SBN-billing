const uuidShape =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const verificationStatuses = ['UNVERIFIED', 'IN_REVIEW', 'VERIFIED', 'REJECTED'] as const

export type VerificationStatus = (typeof verificationStatuses)[number]

export function isVerificationStatus(value: unknown): value is VerificationStatus {
  return typeof value === 'string' && (verificationStatuses as readonly string[]).includes(value)
}

function normalizeTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

export function normalizeInterpretationVersion(value: unknown): string | null {
  return normalizeTrimmedString(value)
}

export function normalizeNormalizedInterpretationRef(value: unknown): string | null {
  return normalizeTrimmedString(value)
}

export function normalizeVerificationStatus(value: unknown): VerificationStatus | null {
  const trimmed = normalizeTrimmedString(value)
  if (!trimmed) return null
  return isVerificationStatus(trimmed) ? trimmed : null
}

export function isSourceInterpretationUuid(value: string): boolean {
  return uuidShape.test(value)
}
