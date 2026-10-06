import type { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
// The transaction's own timestamp, shared with A4.9/A5.4: evaluatedAt is the database instant of the
// caller's transaction, never the application clock or a client value.
import { readTransactionTimestamp } from '../encounter-billing-context/encounter-billing-context.repository.ts'
import { checkContextIntegrity, checkFindingReferences, type RunOwner } from './validation-run.reference-integrity.ts'
import { createFindingRecords, createRunRecord, findEncounterForRun, findRunById, findSensitiveValues } from './validation-run.repository.ts'
import { toRunDto } from './validation-run.service.ts'
import type { ValidationRunDto, ValidationRunResult } from './validation-run.types.ts'
import { findSensitiveEcho, isValidationRunUuid, validateRunDraft } from './validation-run.validation.ts'
import { parseStrictDateOnly } from '../../shared/rules/date-only.ts'

// A5.7 §9 — the internal production recorder A5.8 calls inside its own write transaction. There is no
// HTTP route to it. It never opens a transaction of its own: the run, every finding and the one audit
// event are written on the caller's client, so they commit or roll back together with the caller's
// decision. A refusal is returned before anything is written; any later failure throws, which rolls
// the caller's whole transaction back — a partial run can never be committed (and the database's
// deferred trigger refuses an empty one regardless).

const invalid = (message: string): ValidationRunResult<never> => ({ ok: false, code: 'VALIDATION_ERROR', message })

// The audit trail proves a complete run was recorded, when, and by which validator contract — never
// its findings, context, targets or provenance.
export const runAuditSnapshot = (record: { id: string; evaluatedAt: Date; validatorVersion: string; createdAt: Date }) => ({
  id: record.id,
  evaluatedAt: record.evaluatedAt.toISOString(),
  validatorVersion: record.validatorVersion,
  createdAt: record.createdAt.toISOString(),
})

export async function recordValidationRunInTransaction(draft: unknown, actorUserId: string, tx: Prisma.TransactionClient): Promise<ValidationRunResult<ValidationRunDto>> {
  // The shared root client would autocommit each statement, so the run would commit before its
  // findings. This is a programming error in the caller, not a business refusal.
  if ((tx as unknown) === prisma) throw new Error('recordValidationRunInTransaction requires the caller’s transaction client')
  if (!isValidationRunUuid(actorUserId)) return invalid('actorUserId must be a UUID')

  const parsed = validateRunDraft(draft)
  if (!parsed.ok) return invalid(parsed.message)
  const { encounterId, contextSnapshot, validatorVersion, findings } = parsed.value

  const encounter = await findEncounterForRun(encounterId, tx)
  if (!encounter) return { ok: false, code: 'NOT_FOUND', message: 'encounter not found' }
  const owner: RunOwner = { encounterId, patientId: encounter.patientId, organizationId: encounter.patient.organizationId }

  const context = await checkContextIntegrity(owner, contextSnapshot, tx)
  if (!context.ok) return invalid(context.message)
  const references = await checkFindingReferences(owner, findings, tx)
  if (!references.ok) return invalid(references.message)

  // Owner-approved (A5.7 decision 4): the exact member/policy identifiers, authorization references
  // and evidence storage values connected to this run must not appear in any finding's text.
  const membershipIds = [...new Set([contextSnapshot.insuranceMembershipId, encounter.insuranceMembershipId].filter((id): id is string => id !== null))]
  const evidenceVersionIds = [...new Set(findings.map((finding) => finding.evidenceArtifactVersionId).filter((id): id is string => id !== null))]
  const echo = findSensitiveEcho(findings, await findSensitiveValues(encounterId, membershipIds, evidenceVersionIds, tx))
  if (echo) return invalid(echo)

  const evaluatedAt = await readTransactionTimestamp(tx)
  const run = await createRunRecord(
    {
      encounterId,
      serviceDate: parseStrictDateOnly(contextSnapshot.serviceDate) as Date,
      facilityId: contextSnapshot.facilityId,
      facilityRegulatoryProfileId: contextSnapshot.facilityRegulatoryProfileId,
      insuranceMembershipId: contextSnapshot.insuranceMembershipId,
      payerId: contextSnapshot.payerId,
      tpaId: contextSnapshot.tpaId,
      networkId: contextSnapshot.networkId,
      insuranceProductId: contextSnapshot.insuranceProductId,
      providerContractId: contextSnapshot.providerContractId,
      tariffScheduleId: contextSnapshot.tariffScheduleId,
      tariffScheduleVersionId: contextSnapshot.tariffScheduleVersionId,
      validatorVersion,
      evaluatedAt,
      createdByUserId: actorUserId,
    },
    tx,
  )
  await concurrencyProbe('validation_run.run_inserted')

  // §9 — the recorder numbers findings 1..N in the order the validator produced them; no caller ever
  // supplies a sequence.
  await createFindingRecords(
    findings.map((finding, index) => ({ validationRunId: run.id, sequence: index + 1, ...finding })),
    tx,
  )
  await concurrencyProbe('validation_run.findings_inserted')

  await recordAuditEvent(
    {
      organizationId: owner.organizationId,
      actorUserId,
      actionCode: 'validation_run.recorded',
      entityType: 'VALIDATION_RUN',
      entityId: run.id,
      beforeState: null,
      afterState: runAuditSnapshot(run),
    },
    tx,
  )
  await concurrencyProbe('validation_run.recorded')

  const stored = await findRunById(run.id, tx)
  if (!stored) throw new Error('the recorded validation run could not be read back in its own transaction')
  return { ok: true, value: toRunDto(stored) }
}
