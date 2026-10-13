import type { DbClient } from '../../shared/database/database.types.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { findActivePointersForDiagnosis, findClaimForStructure, markPointersRemoved } from '../claim-line/claim-line.repository.ts'
import { applySequenceChanges, ClaimStructureRefusal, invalid, openClaimStructureGate, refuse, runClaimStructureWrite } from '../claim-line/claim-line.service.ts'
import type { ClaimStructureResult } from '../claim-line/claim-line.types.ts'
import { checkActiveOrder, isClaimStructureUuid, planCompaction, planReorder, validateRemoveBody } from '../claim-line/claim-line.validation.ts'
import {
  createClaimDiagnosisRecord,
  findActiveClaimDiagnoses,
  findActiveClaimDiagnosisForSource,
  findClaimDiagnosisById,
  findClaimDiagnosisLocation,
  findEncounterDiagnosisSource,
  markClaimDiagnosisRemoved,
  setClaimDiagnosisSequence,
} from './claim-diagnosis.repository.ts'
import { CLAIM_DIAGNOSIS_CONTRACT_VERSION, type ClaimDiagnosisDto, type ClaimDiagnosisListDto } from './claim-diagnosis.types.ts'
import { validateCreateDiagnosisBody, validateDiagnosisOrderBody } from './claim-diagnosis.validation.ts'

// A6.2 §8/§10 — ClaimDiagnosis create, list, reorder and remove. Every write runs the same Claim
// structure gate as ClaimLine writes (Claim lock + the A5.9 handoff composer on the same snapshot), so
// line, diagnosis and pointer changes of one Claim serialize on one row.

type DiagnosisRecord = NonNullable<Awaited<ReturnType<typeof findClaimDiagnosisById>>>

function toClaimDiagnosisDto(record: DiagnosisRecord): ClaimDiagnosisDto {
  return {
    id: record.id,
    claimId: record.claimId,
    encounterDiagnosisId: record.encounterDiagnosisId,
    sequence: record.sequence,
    roleCode: record.roleCode,
    claimDiagnosisContractVersion: record.claimDiagnosisContractVersion,
    removedAt: record.removedAt ? record.removedAt.toISOString() : null,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    source: {
      diagnosisCodeId: record.encounterDiagnosis.diagnosisCodeId,
      code: record.encounterDiagnosis.diagnosisCode.code,
      displayName: record.encounterDiagnosis.diagnosisCode.displayName,
    },
  }
}

// Active diagnoses verified 1..N — never repaired.
async function activeDiagnoses(claimId: string, db: DbClient) {
  const rows = await findActiveClaimDiagnoses(claimId, db)
  const order = checkActiveOrder(rows)
  if (!order.ok) refuse('INTEGRITY_CONFLICT', order.message)
  return rows
}

async function diagnosisDto(id: string, db: DbClient) {
  const record = await findClaimDiagnosisById(id, db)
  if (!record) return refuse('NOT_FOUND', 'claim diagnosis not found')
  return toClaimDiagnosisDto(record)
}

// ---- create (§10) --------------------------------------------------------------------------------

export async function createClaimDiagnosis(claimId: string, body: unknown, actorUserId: string): Promise<ClaimStructureResult<ClaimDiagnosisDto>> {
  if (!isClaimStructureUuid(claimId)) return invalid('invalid claim id')
  const validated = validateCreateDiagnosisBody(body)
  if (!validated.ok) return invalid(validated.message)
  const { encounterDiagnosisId, roleCode } = validated.value

  return runClaimStructureWrite(async (tx) => {
    const gate = await openClaimStructureGate(claimId, 'claimDiagnosis.create', tx)
    const active = await activeDiagnoses(claimId, tx)

    // A missing and a foreign diagnosis are refused identically and disclose nothing.
    const source = await findEncounterDiagnosisSource(encounterDiagnosisId, tx)
    if (!source || source.organizationId !== gate.organizationId) refuse('NOT_FOUND', 'encounter diagnosis not found')
    if (source.encounterId !== gate.encounterId) refuse('CLAIM_SOURCE_ENCOUNTER_MISMATCH', 'the encounter diagnosis does not belong to the claim encounter')
    if (!gate.encounterDiagnosisIds.has(encounterDiagnosisId)) refuse('CLAIM_SOURCE_NOT_IN_HANDOFF', 'the encounter diagnosis is not in the bound handoff reference set')
    if (await findActiveClaimDiagnosisForSource(claimId, encounterDiagnosisId, tx)) refuse('CLAIM_DIAGNOSIS_ALREADY_ACTIVE', 'this encounter diagnosis is already active on this claim')

    const record = await createClaimDiagnosisRecord(
      { claimId, encounterDiagnosisId, sequence: active.length + 1, roleCode, claimDiagnosisContractVersion: CLAIM_DIAGNOSIS_CONTRACT_VERSION, createdByUserId: actorUserId },
      tx,
    )
    await concurrencyProbe('claimDiagnosis.inserted')
    // §15 — the role is a canonical claim construct, not a clinical value; no code or text is recorded.
    await recordAuditEvent(
      {
        organizationId: gate.organizationId,
        actorUserId,
        actionCode: 'claim_diagnosis.added',
        entityType: 'CLAIM_DIAGNOSIS',
        entityId: record.id,
        beforeState: null,
        afterState: {
          id: record.id,
          sequence: record.sequence,
          roleCode: record.roleCode,
          claimDiagnosisContractVersion: record.claimDiagnosisContractVersion,
          createdAt: record.createdAt.toISOString(),
        },
      },
      tx,
    )
    await concurrencyProbe('claimDiagnosis.audited')
    return diagnosisDto(record.id, tx)
  })
}

// ---- list (§10) ----------------------------------------------------------------------------------

export async function listClaimDiagnoses(claimId: string): Promise<ClaimStructureResult<ClaimDiagnosisListDto>> {
  if (!isClaimStructureUuid(claimId)) return invalid('invalid claim id')
  try {
    return await withReadSnapshot(undefined, async (tx) => {
      if (!(await findClaimForStructure(claimId, tx))) return { ok: false as const, code: 'NOT_FOUND' as const, message: 'claim not found' }
      return { ok: true as const, value: { items: (await activeDiagnoses(claimId, tx)).map(toClaimDiagnosisDto) } }
    })
  } catch (error) {
    if (error instanceof ClaimStructureRefusal) return { ok: false, code: error.code, message: error.message }
    throw error
  }
}

// ---- reorder (§10) -------------------------------------------------------------------------------

export async function reorderClaimDiagnoses(claimId: string, body: unknown, actorUserId: string): Promise<ClaimStructureResult<ClaimDiagnosisListDto>> {
  if (!isClaimStructureUuid(claimId)) return invalid('invalid claim id')
  const validated = validateDiagnosisOrderBody(body)
  if (!validated.ok) return invalid(validated.message)

  return runClaimStructureWrite(async (tx) => {
    const gate = await openClaimStructureGate(claimId, 'claimDiagnosis.reorder', tx)
    const active = await activeDiagnoses(claimId, tx)
    const plan = planReorder(active, validated.value, 'claimDiagnosisIds')
    if (!plan.ok) return refuse('VALIDATION_ERROR', plan.message)
    if (plan.value.length === 0) return { items: active.map(toClaimDiagnosisDto) }

    await applySequenceChanges(plan.value, setClaimDiagnosisSequence, tx)
    await recordAuditEvent(
      {
        organizationId: gate.organizationId,
        actorUserId,
        actionCode: 'claim_diagnosis.reordered',
        entityType: 'CLAIM',
        entityId: claimId,
        beforeState: { claimDiagnosisIds: active.map((row) => row.id) },
        afterState: { claimDiagnosisIds: validated.value },
      },
      tx,
    )
    return { items: (await activeDiagnoses(claimId, tx)).map(toClaimDiagnosisDto) }
  })
}

// ---- remove (§10) --------------------------------------------------------------------------------

export async function removeClaimDiagnosis(id: string, body: unknown, actorUserId: string): Promise<ClaimStructureResult<ClaimDiagnosisDto>> {
  if (!isClaimStructureUuid(id)) return invalid('invalid claim diagnosis id')
  const validated = validateRemoveBody(body)
  if (!validated.ok) return invalid(validated.message)

  return runClaimStructureWrite(async (tx) => {
    const located = await findClaimDiagnosisLocation(id, tx)
    if (!located) return refuse('NOT_FOUND', 'claim diagnosis not found')
    const gate = await openClaimStructureGate(located.claimId, 'claimDiagnosis.remove', tx)
    const current = await findClaimDiagnosisById(id, tx)
    if (!current) return refuse('NOT_FOUND', 'claim diagnosis not found')
    if (current.removedAt !== null) refuse('CLAIM_STRUCTURE_INACTIVE', 'this claim diagnosis is already removed')
    const active = await activeDiagnoses(located.claimId, tx)

    // §10 — every active line pointer to this diagnosis ends with it, in the same transaction and event.
    await markPointersRemoved((await findActivePointersForDiagnosis(id, tx)).map((pointer) => pointer.id), tx)
    const removed = await markClaimDiagnosisRemoved(id, tx)
    await applySequenceChanges(planCompaction(active.filter((row) => row.id !== id)), setClaimDiagnosisSequence, tx)
    await concurrencyProbe('claimDiagnosis.removed')
    await recordAuditEvent(
      {
        organizationId: gate.organizationId,
        actorUserId,
        actionCode: 'claim_diagnosis.removed',
        entityType: 'CLAIM_DIAGNOSIS',
        entityId: id,
        beforeState: { id, removedAt: null },
        afterState: { id, removedAt: removed.removedAt ? removed.removedAt.toISOString() : null },
      },
      tx,
    )
    return diagnosisDto(id, tx)
  })
}
