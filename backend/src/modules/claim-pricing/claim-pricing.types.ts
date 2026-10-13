import type { ClaimStructureErrorCode } from '../claim-line/claim-line.types.ts'

// A6.3 — a ClaimPricingRun is one immutable draft evaluation of one Claim's active lines against the
// exact tariff version bound to that Claim through its A5 handoff. It records an extended tariff amount
// per line and, only when every line priced in one currency, a total. It is never payer Net, patient
// share, approval, a "current" price or submission authority; A6.4/A6.5 judge currentness and approval.

export const PRICING_CONTRACT_VERSION = 'A6-PRICE-1'

export const lineOutcomes = ['PRICED', 'UNPRICED_RATE_MISSING', 'UNPRICED_RATE_AMBIGUOUS', 'UNPRICED_SOURCE_INVALID', 'UNPRICED_UNSUPPORTED_CURRENCY'] as const
export type LineOutcome = (typeof lineOutcomes)[number]
export type OverallResult = 'PRICED' | 'INCOMPLETE'

export type PricingLineDto = {
  claimLineId: string
  encounterActivityId: string
  lineSequenceAtEvaluation: number
  outcome: string
  tariffRateId: string | null
  unitTariffAmount: string | null
  quantityAtEvaluation: string
  extendedTariffAmount: string | null
  currencyCode: string | null
  inputFingerprint: string
}

export type PricingRunSummaryDto = {
  id: string
  claimId: string
  pricingContractVersion: string
  tariffScheduleVersionId: string
  providerContractId: string
  tariffScheduleId: string
  evaluatedAt: string
  overallResult: string
  lineCount: number
  pricedCount: number
  currencyCode: string | null
  // Present only for a PRICED run; never a guessed or partial total.
  totalExtendedTariffAmount: string | null
  inputStructureFingerprint: string
  createdByUserId: string
  createdAt: string
}

export type PricingRunDto = PricingRunSummaryDto & { lines: PricingLineDto[] }
export type PricingRunListDto = { items: PricingRunSummaryDto[] }

// §10 — pricing refusals. The Claim structure gate (A6.2) supplies the handoff and source refusals in its
// own vocabulary; a persisted INCOMPLETE run is a success, not an error.
export type ClaimPricingErrorCode =
  | ClaimStructureErrorCode
  | 'PRICING_COMMERCIAL_CONTEXT_UNRESOLVED'
  | 'PRICING_SOURCE_INTEGRITY'
  | 'PRICING_CONFLICT'

export type ClaimPricingResult<T> = { ok: true; value: T } | { ok: false; code: ClaimPricingErrorCode; message: string }
