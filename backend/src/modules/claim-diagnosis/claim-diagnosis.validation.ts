import { isClaimStructureUuid, isPlainObject, refuseForeignKeys, validateIdList, type Outcome } from '../claim-line/claim-line.validation.ts'
import { claimDiagnosisRoles, createDiagnosisBodyFields, orderDiagnosisBodyFields, serverOwnedDiagnosisFields, type ClaimDiagnosisRole } from './claim-diagnosis.types.ts'

// A6.2 — ClaimDiagnosis request shapes. The position, contract, creator and timestamps are the server's;
// the diagnosis code and text are A2/A4.5 facts and are never accepted.

export const isClaimDiagnosisRole = (value: unknown): value is ClaimDiagnosisRole =>
  typeof value === 'string' && (claimDiagnosisRoles as readonly string[]).includes(value)

// §10 — create: exactly { encounterDiagnosisId, roleCode }. The role is compared exactly: a blank,
// lowercase, padded or invented value is refused, never normalized or guessed.
export function validateCreateDiagnosisBody(body: unknown): Outcome<{ encounterDiagnosisId: string; roleCode: ClaimDiagnosisRole }> {
  if (!isPlainObject(body)) return { ok: false, message: 'a claim diagnosis body is required' }
  const refused = refuseForeignKeys(body, createDiagnosisBodyFields, serverOwnedDiagnosisFields)
  if (refused) return { ok: false, message: refused }
  if (!isClaimStructureUuid(body.encounterDiagnosisId)) return { ok: false, message: 'encounterDiagnosisId is required and must be a UUID' }
  if (!isClaimDiagnosisRole(body.roleCode)) return { ok: false, message: `roleCode is required and must be one of ${claimDiagnosisRoles.join(', ')}` }
  return { ok: true, value: { encounterDiagnosisId: body.encounterDiagnosisId, roleCode: body.roleCode } }
}

export const validateDiagnosisOrderBody = (body: unknown) => validateIdList(body, 'claimDiagnosisIds', orderDiagnosisBodyFields, serverOwnedDiagnosisFields)
