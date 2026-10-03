import type { DbClient } from '../../shared/database/database.types.ts'
// A5.2 owns the recorded verifications, A5.3 the authorization cases and their versions, A5.4 the
// exact scope evaluation. Each is called with this execution's transaction client.
import { findVerificationsByEncounter } from '../eligibility-verification/eligibility-verification.repository.ts'
import { findAuthorizationsByEncounter } from '../prior-authorization/prior-authorization.repository.ts'
import { evaluateAuthorizationScope } from '../authorization-line/authorization-line.service.ts'
import type { AuthorizationScopeOutcome } from '../authorization-line/authorization-line.types.ts'
import { activitySummaryCode, draft, scopeOutcomeCodes, selectEligibility } from './pre-claim-validation.finding-catalog.ts'
import type { MembershipFacts } from './pre-claim-validation.technical.ts'
import { type FindingDraft, ValidationIntegrityDefect } from './pre-claim-validation.types.ts'

// §10–§11 — eligibility, the authorization requirement and authorization scope.
export async function evaluateCoverage(encounterId: string, membership: MembershipFacts | null, serviceDate: Date, evaluatedAt: Date, tx: DbClient): Promise<FindingDraft[]> {
  if (membership === null) return [draft('COVERAGE_MEMBERSHIP_MISSING'), draft('COVERAGE_AUTHORIZATION_REQUIREMENT_UNKNOWN')]

  const findings: FindingDraft[] = []
  const selection = selectEligibility(await findVerificationsByEncounter(encounterId, tx), { ...membership, serviceDate }, evaluatedAt)
  const selected = selection.selected
  // The verification is targeted only when exactly one was selected.
  findings.push(draft(selection.code, { eligibilityVerificationId: selected?.id ?? null }))

  // Only the one usable verification's explicit indicator decides the requirement.
  if (selected === null || selected.authorizationRequired === null) {
    findings.push(draft('COVERAGE_AUTHORIZATION_REQUIREMENT_UNKNOWN', { eligibilityVerificationId: selected?.id ?? null }))
    return findings
  }
  if (selected.authorizationRequired === false) {
    findings.push(draft('COVERAGE_AUTHORIZATION_NOT_REQUIRED', { eligibilityVerificationId: selected.id }))
    return findings
  }

  const cases = await findAuthorizationsByEncounter(encounterId, tx)
  if (cases.length === 0) {
    findings.push(draft('COVERAGE_AUTHORIZATION_MISSING', { eligibilityVerificationId: selected.id }))
    return findings
  }

  // Every case is evaluated; none is chosen by reference, time or id. Each case contributes only its
  // LATEST RECORDED version (highest server-owned number) — and A5.4, not A5.8, decides whether that
  // snapshot actually scopes an activity.
  const outcomesByActivity = new Map<string, AuthorizationScopeOutcome[]>()
  for (const authorizationCase of cases) {
    const latest = authorizationCase.versions[0]
    if (!latest) throw new ValidationIntegrityDefect('an authorization case has no recorded version')
    const evaluation = await evaluateAuthorizationScope(latest.id, tx)
    if (!evaluation.ok) throw new ValidationIntegrityDefect('authorization scope could not be evaluated in this snapshot')
    for (const activity of evaluation.value.activities) {
      findings.push(
        draft(scopeOutcomeCodes[activity.outcome], {
          encounterActivityId: activity.encounterActivityId,
          priorAuthorizationVersionId: latest.id,
          authorizationLineId: activity.authorizationLineId,
        }),
      )
      outcomesByActivity.set(activity.encounterActivityId, [...(outcomesByActivity.get(activity.encounterActivityId) ?? []), activity.outcome])
    }
  }
  for (const [encounterActivityId, outcomes] of outcomesByActivity) findings.push(draft(activitySummaryCode(outcomes), { encounterActivityId }))
  return findings
}
