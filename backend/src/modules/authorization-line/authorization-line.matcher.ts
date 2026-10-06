import { Prisma } from '../../../generated/prisma/client.ts'
import { approvingStatuses, type ActivityScopeDto, type AuthorizationScopeOutcome, type LineUtilizationDto, type QuantityOutcome } from './authorization-line.types.ts'

// A5.4 §12–§16 — the scope matcher. It is pure: every fact it needs is passed in, so the whole
// decision is unit-testable and there is exactly one copy of it.
//
// Three properties hold by construction and are what the rest of this file protects:
//
//   Fail closed. Zero candidate lines is NO_MATCH and more than one is AMBIGUOUS. No winner is ever
//   chosen — not by sequence, not by creation order, not by which line looks more specific. Choosing
//   one would be inventing payer precedence that no governed rule owns.
//
//   Order independent. Every result is computed from sets, and every list that leaves this module is
//   sorted by id, so shuffling the lines or the activities cannot change a single outcome.
//
//   Exact. Quantities are Prisma.Decimal throughout; a JavaScript number never holds one.

export type MatcherLine = {
  id: string
  sequence: number
  serviceId: string | null
  procedureCodeId: string | null
  diagnosisCodeId: string | null
  approvedQty: Prisma.Decimal | null
  unitCode: string | null
  approvedFrom: Date | null
  approvedThrough: Date | null
  status: string
}

export type MatcherActivity = {
  id: string
  serviceId: string | null
  procedureCodeId: string | null
  quantity: Prisma.Decimal
  unitCode: string | null
}

export type MatcherInput = {
  // Whether the frozen A5.3 context still equals the Encounter as it stands now. Decided by the
  // caller from the snapshot; when false nothing below is evaluated.
  contextMatch: boolean
  header: { status: string; validFrom: Date | null; validThrough: Date | null }
  serviceDate: Date
  lines: MatcherLine[]
  activities: MatcherActivity[]
  activeDiagnosisCodeIds: string[]
}

export type MatcherResult = {
  activities: ActivityScopeDto[]
  lineUtilization: LineUtilizationDto[]
}

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const isApproving = (status: string) => (approvingStatuses as readonly string[]).includes(status)

// A line is a candidate for an activity when every dimension the line constrains is met. A null
// dimension on the line constrains nothing. Service and procedure are checked independently — no
// Service-to-Procedure mapping is assumed — and a scoped diagnosis only needs to be ACTIVE on the
// Encounter, because A4 owns no activity-to-diagnosis relationship to check against.
export function isCandidate(line: MatcherLine, activity: MatcherActivity, activeDiagnoses: ReadonlySet<string>): boolean {
  if (line.serviceId !== null && activity.serviceId !== line.serviceId) return false
  if (line.procedureCodeId !== null && activity.procedureCodeId !== line.procedureCodeId) return false
  if (line.diagnosisCodeId !== null && !activeDiagnoses.has(line.diagnosisCodeId)) return false
  return true
}

// A supplied bound on either the header validity window or the line's approved dates that excludes
// the service date puts it out of scope. Bounds are inclusive; a missing bound restricts nothing.
export function serviceDateInScope(serviceDate: Date, header: MatcherInput['header'], line: MatcherLine): boolean {
  const date = serviceDate.getTime()
  for (const lower of [header.validFrom, line.approvedFrom]) if (lower !== null && date < lower.getTime()) return false
  for (const upper of [header.validThrough, line.approvedThrough]) if (upper !== null && date > upper.getTime()) return false
  return true
}

// A line with no unit imposes no unit restriction. A line with a unit requires the activity's unit
// to be exactly that — case and all — because the unit is what makes two quantities comparable.
export const unitCompatible = (line: MatcherLine, activity: MatcherActivity) => line.unitCode === null || line.unitCode === activity.unitCode

export function evaluateScope(input: MatcherInput): MatcherResult {
  const activities = [...input.activities].sort(byId)
  const lines = [...input.lines].sort(byId)

  // §12 step 5 — a context that has drifted is not evaluated at all, and no other authorization is
  // substituted for it. No line is utilized either: nothing was allocated, and reporting a zero
  // utilization as WITHIN would state a fact the evaluation never established.
  if (!input.contextMatch) {
    return {
      activities: activities.map((activity) => ({
        encounterActivityId: activity.id,
        outcome: 'CONTEXT_MISMATCH' as const,
        authorizationLineId: null,
        candidateAuthorizationLineIds: [],
      })),
      lineUtilization: [],
    }
  }

  const activeDiagnoses = new Set(input.activeDiagnosisCodeIds)
  const candidatesOf = new Map(activities.map((activity) => [activity.id, lines.filter((line) => isCandidate(line, activity, activeDiagnoses))]))

  // §14 — only an activity with exactly one candidate is allocated to a line. An AMBIGUOUS activity is
  // allocated to none. An activity whose unit differs from its line's unit is not added either: the
  // unit exists precisely so quantities in different units are never summed, and adding 5 TABLET to a
  // line approved for 10 ML would compare two numbers that do not measure the same thing.
  const allocated = new Map<string, MatcherActivity[]>(lines.map((line) => [line.id, []]))
  for (const activity of activities) {
    const candidates = candidatesOf.get(activity.id) ?? []
    if (candidates.length === 1 && unitCompatible(candidates[0], activity)) allocated.get(candidates[0].id)?.push(activity)
  }

  const quantityOf = new Map<string, QuantityOutcome>()
  const lineUtilization: LineUtilizationDto[] = [...input.lines]
    .sort((a, b) => a.sequence - b.sequence || (a.id < b.id ? -1 : 1))
    .map((line) => {
      const assigned = allocated.get(line.id) ?? []
      const matchedQty = assigned.reduce((sum, activity) => sum.plus(activity.quantity), new Prisma.Decimal(0))
      // The whole line is judged at once against its capacity. There is no first-come allocation:
      // if the total exceeds approvedQty, every activity allocated to the line exceeds it together,
      // because which of them "used up" the capacity is not a question the source data answers.
      const quantityOutcome: QuantityOutcome = line.approvedQty === null ? 'UNKNOWN' : matchedQty.gt(line.approvedQty) ? 'EXCEEDED' : 'WITHIN'
      quantityOf.set(line.id, quantityOutcome)
      return {
        authorizationLineId: line.id,
        matchedActivityIds: assigned.map((activity) => activity.id),
        matchedQty: matchedQty.toString(),
        approvedQty: line.approvedQty === null ? null : new Prisma.Decimal(line.approvedQty).toString(),
        quantityOutcome,
      }
    })

  const results: ActivityScopeDto[] = activities.map((activity) => {
    const candidates = candidatesOf.get(activity.id) ?? []
    const candidateAuthorizationLineIds = candidates.map((line) => line.id)
    if (candidates.length === 0) return { encounterActivityId: activity.id, outcome: 'NO_MATCH', authorizationLineId: null, candidateAuthorizationLineIds }
    if (candidates.length > 1) return { encounterActivityId: activity.id, outcome: 'AMBIGUOUS', authorizationLineId: null, candidateAuthorizationLineIds }

    const line = candidates[0]
    // The order the doc gives in §12 step 10 and §13: statuses, then dates, then unit, then quantity.
    // The first that fails is the fact reported; a fact further down is never reached.
    let outcome: AuthorizationScopeOutcome = 'MATCHED'
    if (!isApproving(input.header.status)) outcome = 'HEADER_STATUS_NOT_APPROVED'
    else if (!isApproving(line.status)) outcome = 'LINE_STATUS_NOT_APPROVED'
    else if (!serviceDateInScope(input.serviceDate, input.header, line)) outcome = 'DATE_OUTSIDE_SCOPE'
    else if (!unitCompatible(line, activity)) outcome = 'UNIT_MISMATCH'
    else if (quantityOf.get(line.id) === 'UNKNOWN') outcome = 'QUANTITY_UNKNOWN'
    else if (quantityOf.get(line.id) === 'EXCEEDED') outcome = 'QUANTITY_EXCEEDED'
    return { encounterActivityId: activity.id, outcome, authorizationLineId: line.id, candidateAuthorizationLineIds }
  })

  return { activities: results, lineUtilization }
}
