import { createHash } from 'node:crypto'
import { Prisma } from '../../../generated/prisma/client.ts'
import { supportedCurrencyMinorUnits } from '../tariff-rate/tariff-rate.types.ts'
import { canonicalModifierSignature } from '../tariff-rate/tariff-rate.validation.ts'
import type { LineOutcome, OverallResult } from './claim-pricing.types.ts'

// A6.3 §3/§6 — the pure pricing rules: exact rate matching, Decimal arithmetic with half-up rounding at
// the currency's minor units, the run result and the canonical fingerprints. No database access, no
// JavaScript number for money, no "latest", "best fit" or price-based precedence.

export type SourceFacts = {
  claimLineId: string
  sequence: number
  encounterActivityId: string
  serviceId: string | null
  procedureCodeId: string | null
  quantity: Prisma.Decimal
  unitCode: string | null
  // In the activity's stored order.
  modifierCodes: string[]
  removed: boolean
}

export type RateCandidate = {
  id: string
  selectorKind: string
  serviceId: string | null
  procedureCodeId: string | null
  unitCodeKey: string | null
  modifierSignature: string[]
  currencyCode: string
  unitTariffAmount: Prisma.Decimal
}

export type LineEvaluation = {
  claimLineId: string
  encounterActivityId: string
  sequence: number
  outcome: LineOutcome
  tariffRateId: string | null
  unitTariffAmount: Prisma.Decimal | null
  quantity: Prisma.Decimal
  extendedAmount: Prisma.Decimal | null
  currencyCode: string | null
  candidateRateIds: string[]
}

const sameSignature = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((code, index) => code === b[index])

// §3 — a source the calculation cannot trust is never priced: a removed activity, an activity with no
// Service and no ProcedureCode, a non-positive or non-finite quantity, or a blank or repeated code.
export function isSourceValid(source: SourceFacts): boolean {
  if (source.removed) return false
  if (source.serviceId === null && source.procedureCodeId === null) return false
  if (!source.quantity.isFinite() || !source.quantity.isPositive() || source.quantity.isZero()) return false
  if (source.unitCode !== null && source.unitCode.trim() === '') return false
  if (source.modifierCodes.some((code) => code.trim() === '')) return false
  return new Set(source.modifierCodes).size === source.modifierCodes.length
}

// §3 — every active rate whose one identity equals the source's identity of that kind, whose unit equals
// the source unit exactly (null only matches null) and whose canonical modifier set equals the source's.
// Rates of both kinds compete: a source carrying a Service and a ProcedureCode that each match is
// ambiguous, even at equal prices.
export function matchingRates(source: SourceFacts, rates: readonly RateCandidate[]): RateCandidate[] {
  const signature = canonicalModifierSignature(source.modifierCodes)
  return rates.filter((rate) => {
    const identity =
      (rate.selectorKind === 'SERVICE' && source.serviceId !== null && rate.serviceId === source.serviceId) ||
      (rate.selectorKind === 'PROCEDURE_CODE' && source.procedureCodeId !== null && rate.procedureCodeId === source.procedureCodeId)
    return identity && rate.unitCodeKey === source.unitCode && sameSignature(rate.modifierSignature, signature)
  })
}

// §6 — extended = round_half_up(quantity × unit amount, minor units). The unit amount is never rounded
// before multiplying.
export function extendedAmount(quantity: Prisma.Decimal, unitAmount: Prisma.Decimal, minorUnits: number): Prisma.Decimal {
  return quantity.times(unitAmount).toDecimalPlaces(minorUnits, Prisma.Decimal.ROUND_HALF_UP)
}

export function evaluateLine(source: SourceFacts, rates: readonly RateCandidate[]): LineEvaluation {
  const base = {
    claimLineId: source.claimLineId,
    encounterActivityId: source.encounterActivityId,
    sequence: source.sequence,
    quantity: source.quantity,
  }
  const unpriced = (outcome: LineOutcome, candidateRateIds: string[] = []): LineEvaluation => ({
    ...base,
    outcome,
    tariffRateId: null,
    unitTariffAmount: null,
    extendedAmount: null,
    currencyCode: null,
    candidateRateIds,
  })
  if (!isSourceValid(source)) return unpriced('UNPRICED_SOURCE_INVALID')
  const candidates = matchingRates(source, rates)
  const candidateIds = candidates.map((rate) => rate.id).sort()
  if (candidates.length === 0) return unpriced('UNPRICED_RATE_MISSING')
  if (candidates.length > 1) return unpriced('UNPRICED_RATE_AMBIGUOUS', candidateIds)
  const rate = candidates[0]
  const minorUnits = supportedCurrencyMinorUnits[rate.currencyCode]
  if (minorUnits === undefined) return unpriced('UNPRICED_UNSUPPORTED_CURRENCY', candidateIds)
  return {
    ...base,
    outcome: 'PRICED',
    tariffRateId: rate.id,
    unitTariffAmount: rate.unitTariffAmount,
    extendedAmount: extendedAmount(source.quantity, rate.unitTariffAmount, minorUnits),
    currencyCode: rate.currencyCode,
    candidateRateIds: candidateIds,
  }
}

export type RunEvaluation = {
  overallResult: OverallResult
  lineCount: number
  pricedCount: number
  currencyCode: string | null
  total: Prisma.Decimal | null
}

// §6 — PRICED iff there is at least one line, every line priced and all priced lines share one currency;
// the total is the sum of the rounded line amounts. Otherwise INCOMPLETE with no currency and no total.
export function evaluateRun(lines: readonly LineEvaluation[]): RunEvaluation {
  const priced = lines.filter((line) => line.outcome === 'PRICED')
  const currencies = new Set(priced.map((line) => line.currencyCode))
  if (lines.length === 0 || priced.length !== lines.length || currencies.size !== 1)
    return { overallResult: 'INCOMPLETE', lineCount: lines.length, pricedCount: priced.length, currencyCode: null, total: null }
  const total = priced.reduce((sum, line) => sum.plus(line.extendedAmount as Prisma.Decimal), new Prisma.Decimal(0))
  return { overallResult: 'PRICED', lineCount: lines.length, pricedCount: priced.length, currencyCode: priced[0].currencyCode, total }
}

// §7 — canonical currentness evidence: SHA-256 over a fixed-order JSON of identifiers, quantities,
// modifier order and rate values. It holds no patient, member, code text or clinical value, and it is
// not the A6.6 payload serialization.
const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

const amountText = (value: Prisma.Decimal | null) => (value === null ? null : value.toFixed(4))

export function lineFingerprint(source: SourceFacts, line: LineEvaluation, tariffScheduleVersionId: string): string {
  return sha256([
    'A6-PRICE-1/line',
    source.claimLineId,
    source.sequence,
    source.encounterActivityId,
    source.serviceId,
    source.procedureCodeId,
    source.quantity.toFixed(4),
    source.unitCode,
    source.modifierCodes,
    source.removed,
    tariffScheduleVersionId,
    line.outcome,
    line.tariffRateId,
    amountText(line.unitTariffAmount),
    line.currencyCode,
    line.candidateRateIds,
  ])
}

export function runFingerprint(claimId: string, tariffScheduleVersionId: string, lineFingerprints: readonly string[]): string {
  return sha256(['A6-PRICE-1/run', claimId, tariffScheduleVersionId, lineFingerprints])
}

// Display text for a stored amount: money at the currency's minor units, unit amounts at 4 decimals.
export function moneyText(value: Prisma.Decimal | null, currencyCode: string | null): string | null {
  if (value === null) return null
  const minorUnits = currencyCode === null ? undefined : supportedCurrencyMinorUnits[currencyCode]
  return value.toFixed(minorUnits ?? 4)
}
