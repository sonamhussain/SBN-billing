import { isClaimStructureUuid, isPlainObject, type Outcome } from '../claim-line/claim-line.validation.ts'

// A6.4 §9 — request shapes. The only client inputs are the Claim id in the path and the exact pricing run
// to judge. Outcome, findings, fingerprints, counts, lineage, evaluator and timestamps are the server's,
// so every other field or query parameter is refused by name, never by value.

export const isClaimDraftUuid = (value: unknown): value is string => isClaimStructureUuid(value)

const serverOwnedAssessmentFields = [
  'id',
  'claimId',
  'outcome',
  'findings',
  'assemblyFingerprint',
  'pricingInputFingerprint',
  'draftContractVersion',
  'handoffAssessmentId',
  'activeLineCount',
  'activeDiagnosisCount',
  'findingCount',
  'evaluatedAt',
  'createdByUserId',
  'createdAt',
] as const

// POST draft-assessments: exactly { pricingRunId }. There is no default: the server never picks a run.
export function validateCreateAssessmentBody(body: unknown): Outcome<{ pricingRunId: string }> {
  if (!isPlainObject(body)) return { ok: false, message: 'a { pricingRunId } body is required' }
  const keys = Object.keys(body)
  const forged = serverOwnedAssessmentFields.filter((field) => keys.includes(field))
  if (forged.length > 0) return { ok: false, message: `${forged.join(', ')} is owned by the server and cannot be supplied` }
  const unknown = keys.filter((key) => key !== 'pricingRunId')
  if (unknown.length > 0) return { ok: false, message: `unknown field(s): ${unknown.join(', ')}` }
  if (!isClaimDraftUuid(body.pricingRunId)) return { ok: false, message: 'pricingRunId is required and must be a UUID' }
  return { ok: true, value: { pricingRunId: body.pricingRunId } }
}

// GET draft: the only accepted query parameter is one optional pricingRunId UUID. Without it the preview
// reports the missing pricing evidence; it never selects a run.
export function validatePreviewQuery(query: unknown): Outcome<{ pricingRunId: string | null }> {
  if (!isPlainObject(query)) return { ok: true, value: { pricingRunId: null } }
  const keys = Object.keys(query)
  const unknown = keys.filter((key) => key !== 'pricingRunId')
  if (unknown.length > 0) return { ok: false, message: `unknown query parameter(s): ${unknown.join(', ')}` }
  if (!keys.includes('pricingRunId')) return { ok: true, value: { pricingRunId: null } }
  if (!isClaimDraftUuid(query.pricingRunId)) return { ok: false, message: 'pricingRunId must be one UUID' }
  return { ok: true, value: { pricingRunId: query.pricingRunId } }
}
