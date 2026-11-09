import type { DbClient } from '../../shared/database/database.types.ts'
// CRG-01 Checkpoint B owns the coding-release decision, its receipts and the validator selection; A5.8 consults them.
import { evaluateCodingRelease } from '../coding-validation/coding-validation.service.ts'
import type { ReceiptPlan } from '../coding-validation/coding-validation.types.ts'
import type { FindingDraft } from './pre-claim-validation.types.ts'

// A5-VAL-2 §5 — the CRG coding check: one CODING finding per active diagnosis and per coded activity, each with its
// receipt plan. It runs only in an A5-VAL-2 run and only after the TECHNICAL layer passed, beside — never instead of —
// the A5-VAL-1 CODING owner invariants. A5-VAL-1 is unchanged and consumes no reference dataset.
export async function evaluateCodingReleaseLayer(encounterId: string, tx: DbClient): Promise<{ findings: FindingDraft[]; plans: ReceiptPlan[] }> {
  const { drafts, plans } = await evaluateCodingRelease(encounterId, tx)
  const findings: FindingDraft[] = drafts.map((entry) => ({
    layer: 'CODING',
    outcome: entry.outcome,
    findingCode: entry.findingCode,
    fieldPath: null,
    message: entry.message,
    ruleVersionId: null,
    governingSourceVersionId: null,
    referenceDatasetVersionId: entry.referenceDatasetVersionId,
    encounterActivityId: entry.encounterActivityId,
    encounterDiagnosisId: entry.encounterDiagnosisId,
    eligibilityVerificationId: null,
    priorAuthorizationVersionId: null,
    authorizationLineId: null,
    evidenceRequirementId: null,
    evidenceArtifactVersionId: null,
    provenance: null,
  }))
  return { findings, plans }
}
