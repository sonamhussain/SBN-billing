import type { DbClient } from '../../shared/database/database.types.ts'
// A5.5 owns commercial identity resolution; it is called in this execution's transaction.
import { resolvePreClaimCommercialContext } from '../pre-claim-commercial-context/pre-claim-commercial-context.service.ts'
import { contractReasonCodes, draft } from './pre-claim-validation.finding-catalog.ts'
import { type FindingDraft, ValidationIntegrityDefect } from './pre-claim-validation.types.ts'

export type CommercialIds = { providerContractId: string; tariffScheduleId: string; tariffScheduleVersionId: string }

// §12 — the exact A5.5 result is mapped; nothing is priced. A resolved context's ids are copied into
// the run; an unresolved one leaves them null and is recorded as a finding, not an HTTP failure.
export async function evaluateContract(encounterId: string, tx: DbClient): Promise<{ findings: FindingDraft[]; commercial: CommercialIds | null }> {
  const result = await resolvePreClaimCommercialContext(encounterId, tx)
  if (result.ok) {
    const { providerContractId, tariffScheduleId, tariffScheduleVersionId } = result.value
    return { findings: [draft('CONTRACT_CONTEXT_RESOLVED')], commercial: { providerContractId, tariffScheduleId, tariffScheduleVersionId } }
  }
  const code = result.code === 'COMMERCIAL_CONTEXT_UNRESOLVED' && result.reason ? contractReasonCodes[result.reason] : undefined
  // Anything else — an A4 conflict the TECHNICAL gate already excluded, or a tariff master defect — is
  // an integrity defect, never a finding (owner decision).
  if (!code) throw new ValidationIntegrityDefect('the commercial context could not be resolved because of an integrity defect')
  return { findings: [draft(code)], commercial: null }
}
