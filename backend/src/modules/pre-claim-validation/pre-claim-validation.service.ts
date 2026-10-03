import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import { formatDateOnly } from '../../shared/rules/date-only.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { findEncounterForBillingContext, readTransactionTimestamp } from '../encounter-billing-context/encounter-billing-context.repository.ts'
import { findActiveEncounterActivities } from '../encounter-activity/encounter-activity.repository.ts'
import { findActiveEncounterDiagnoses } from '../encounter-diagnosis/encounter-diagnosis.repository.ts'
// A5.7 owns persistence. Its internal recorder is the only way a run is written.
import { recordValidationRunInTransaction } from '../validation-run/validation-run.recorder.ts'
import { isValidationRunUuid } from '../validation-run/validation-run.validation.ts'
import type { ValidationFindingDraft, ValidationRunContextSnapshot } from '../validation-run/validation-run.types.ts'
import { orderFindings } from './pre-claim-validation.finding-catalog.ts'
import { evaluateTechnical } from './pre-claim-validation.technical.ts'
import { evaluateCoding } from './pre-claim-validation.coding.ts'
import { evaluateCoverage } from './pre-claim-validation.coverage.ts'
import { evaluateContract } from './pre-claim-validation.contract.ts'
import { evaluateEvidence } from './pre-claim-validation.evidence.ts'
import { insertGovernedProvenance, type TargetCodes, verifyGovernedProvenance } from './pre-claim-validation.provenance.ts'
import {
  type FindingDraft,
  type PreClaimValidationExecutionDto,
  type PreClaimValidationResult,
  VALIDATOR_VERSION,
  ValidationIntegrityDefect,
} from './pre-claim-validation.types.ts'

// A5.8 §5 — one REPEATABLE READ read-write transaction per execution. It is deliberately NOT read-only:
// the run is recorded before commit. Every owner function receives this same client, so the whole
// evaluation is one snapshot; no upstream business row is locked. A deterministic FAIL or RESTRICT is
// a recorded finding and a successful execution; only a malformed, missing or foreign Encounter, or an
// integrity defect, prevents a run — and then nothing at all is committed.

const invalid = (message: string): PreClaimValidationResult<never> => ({ ok: false, code: 'VALIDATION_ERROR', message })

// §18 — the body is {} or absent. The client never supplies a context id, business date, finding,
// outcome, provenance or validatorVersion; any field is refused by name, never by value.
function validateExecuteBody(body: unknown): string | null {
  if (body === undefined || body === null) return null
  if (typeof body !== 'object' || Array.isArray(body)) return 'the execute body must be empty'
  const fields = Object.keys(body as object)
  return fields.length === 0 ? null : `field(s) not accepted for execution: ${fields.join(', ')}`
}

const stripProvenance = ({ provenance: _provenance, ...finding }: FindingDraft): ValidationFindingDraft => finding

export async function executePreClaimValidation(encounterId: string, body: unknown, actorUserId: string): Promise<PreClaimValidationResult<PreClaimValidationExecutionDto>> {
  if (!isValidationRunUuid(encounterId)) return invalid('invalid encounter id')
  const refused = validateExecuteBody(body)
  if (refused) return invalid(refused)

  try {
    return await prisma.$transaction(
      async (tx): Promise<PreClaimValidationResult<PreClaimValidationExecutionDto>> => {
        // The first statement fixes the snapshot; it is also the run's evaluation instant.
        const evaluatedAt = await readTransactionTimestamp(tx)
        // Acceptance holds the execution here and commits a correction from another connection; every
        // read below must still see the earlier state. A no-op in normal operation.
        await concurrencyProbe('pre_claim_validation.snapshot')

        // §6 — the raw Encounter first, so an upstream integrity failure can still be recorded.
        const encounter = await findEncounterForBillingContext(encounterId, tx)
        if (!encounter) return { ok: false, code: 'NOT_FOUND', message: 'encounter not found' }

        const context: ValidationRunContextSnapshot = {
          serviceDate: formatDateOnly(encounter.serviceDate) as string,
          facilityId: encounter.facilityId,
          facilityRegulatoryProfileId: encounter.facilityRegulatoryProfileId,
          insuranceMembershipId: null,
          payerId: null,
          tpaId: null,
          networkId: null,
          insuranceProductId: null,
          providerContractId: null,
          tariffScheduleId: null,
          tariffScheduleVersionId: null,
        }

        const technical = await evaluateTechnical(encounter, tx)
        const drafts: FindingDraft[] = [technical.finding]
        // §8 — after a TECHNICAL failure no dependent layer runs and nothing is guessed.
        if (technical.passed) {
          if (technical.membership) Object.assign(context, technical.membership)
          drafts.push(...(await evaluateCoding(encounterId, tx)))
          drafts.push(...(await evaluateCoverage(encounterId, technical.membership, encounter.serviceDate, evaluatedAt, tx)))
          const contract = await evaluateContract(encounterId, tx)
          drafts.push(...contract.findings)
          if (contract.commercial) Object.assign(context, contract.commercial)
          drafts.push(...(await evaluateEvidence(encounterId, contract.commercial !== null, tx)))
        }
        const findings = orderFindings(drafts)

        // §17 — every governed finding's provenance is verified against this run before anything is
        // written. The target codes come from the Encounter's own active rows in this snapshot.
        const activities = new Map((await findActiveEncounterActivities(encounterId, tx)).map((row) => [row.id, row]))
        const diagnoses = new Map((await findActiveEncounterDiagnoses(encounterId, tx)).map((row) => [row.id, row]))
        const targetCodes = (finding: FindingDraft): TargetCodes => {
          const activity = finding.encounterActivityId ? activities.get(finding.encounterActivityId) : undefined
          const diagnosis = finding.encounterDiagnosisId ? diagnoses.get(finding.encounterDiagnosisId) : undefined
          return { serviceId: activity?.serviceId ?? null, procedureCodeId: activity?.procedureCodeId ?? null, diagnosisCodeId: diagnosis?.diagnosisCodeId ?? null }
        }
        for (const finding of findings) {
          if (finding.provenance) await verifyGovernedProvenance(finding, finding.provenance, { context, evaluatedAt }, targetCodes(finding), tx)
        }

        const recorded = await recordValidationRunInTransaction(
          { encounterId, contextSnapshot: context, validatorVersion: VALIDATOR_VERSION, findings: findings.map(stripProvenance) },
          actorUserId,
          tx,
        )
        if (!recorded.ok) throw new ValidationIntegrityDefect('the validation run was refused by its recorder')
        await concurrencyProbe('pre_claim_validation.recorded')

        // A5.7 numbered the findings 1..N in exactly this order, so position i is sequence i + 1.
        const rows = await tx.validationFinding.findMany({ where: { validationRunId: recorded.value.id }, orderBy: [{ sequence: 'asc' }], select: { id: true, sequence: true } })
        if (rows.length !== findings.length) throw new ValidationIntegrityDefect('the recorded findings do not match the validator output')
        for (const [index, finding] of findings.entries()) {
          if (finding.provenance) await insertGovernedProvenance(rows[index].id, finding.provenance, tx)
        }
        await concurrencyProbe('pre_claim_validation.provenance_inserted')

        return {
          ok: true,
          value: { validationRunId: recorded.value.id, evaluatedAt: recorded.value.evaluatedAt, validatorVersion: VALIDATOR_VERSION, findingCount: recorded.value.findingCount },
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 10_000, timeout: 300_000 },
    )
  } catch (error) {
    if (error instanceof ValidationIntegrityDefect) return { ok: false, code: 'INTEGRITY_CONFLICT', message: 'the validation could not be recorded because of an integrity defect' }
    throw error
  }
}
