import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { lockRowForUpdate } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { insuranceMembershipAuditSnapshot } from '../audit/audit.snapshot.ts'
import { findProductNetworkByProductAndNetwork } from '../commercial-coverage/insurance-product.repository.ts'
import {
  createMembershipRecord,
  findInsuranceProductOwnership,
  findMembershipById,
  findMembershipsByPatientId,
  findNetworkOwnership,
  findPatientOwnership,
  findPayerOwnership,
  findTpaOwnership,
  updateMembershipRecord,
} from './insurance-membership.repository.ts'
import type { InsuranceMembershipDto, InsuranceMembershipErrorCode, InsuranceMembershipResult } from './insurance-membership.types.ts'
import {
  changedFields,
  coverageDatesCoherent,
  decideCommercialCoherence,
  isMembershipUuid,
  mergeMembership,
  toMembershipDto,
  validateCreateInput,
  validateUpdateInput,
  type MembershipWriteInput,
} from './insurance-membership.validation.ts'

// A4.3 — the service owns four decisions and nothing else: is the input valid, does the patient's
// organization own every referenced commercial master, is the resulting commercial context
// coherent, and what safe audit is written. It never infers eligibility, primary coverage, a
// provider contract or a tariff, and it never deletes.

function invalid(message: string): InsuranceMembershipResult<never> {
  return { ok: false, code: 'VALIDATION_ERROR', message }
}

const failure = (code: InsuranceMembershipErrorCode, message: string): InsuranceMembershipResult<never> => ({ ok: false, code, message })

// §8 — read the authoritative ancestry of every referenced master INSIDE the caller's write
// transaction, then let the pure rule decide. A contradictory context is refused before the
// membership or its audit is written.
async function checkCommercialCoherence(patientOrganizationId: string, state: MembershipWriteInput, db: DbClient) {
  const payer = await findPayerOwnership(state.payerId, db)
  const tpa = state.tpaId ? await findTpaOwnership(state.tpaId, db) : ('not-supplied' as const)
  const network = state.networkId ? await findNetworkOwnership(state.networkId, db) : ('not-supplied' as const)
  const product = state.insuranceProductId ? await findInsuranceProductOwnership(state.insuranceProductId, db) : ('not-supplied' as const)
  const productNetworkExists =
    state.insuranceProductId && state.networkId
      ? (await findProductNetworkByProductAndNetwork(state.insuranceProductId, state.networkId, db)) !== null
      : ('not-applicable' as const)
  return decideCommercialCoherence({ patientOrganizationId, payer, tpa, network, product, productNetworkExists, payerId: state.payerId })
}

type CreateOutcome =
  | { kind: 'written'; record: Parameters<typeof toMembershipDto>[0] }
  | { kind: 'missing'; what: string }
  | { kind: 'refused'; code: InsuranceMembershipErrorCode; message: string }

type UpdateOutcome = CreateOutcome | { kind: 'unchanged' }

export async function createMembership(
  patientId: string,
  body: unknown,
  actorUserId: string,
): Promise<InsuranceMembershipResult<InsuranceMembershipDto>> {
  if (!isMembershipUuid(patientId)) return invalid('invalid patient id')
  const validated = validateCreateInput(body)
  if (!validated.ok) return invalid(validated.message)

  // Create needs no global serialization: duplicate and overlapping memberships are legitimate, so
  // there is no uniqueness race to close. The coherence read and the write share one transaction.
  const outcome = await prisma.$transaction(async (tx): Promise<CreateOutcome> => {
    const patient = await findPatientOwnership(patientId, tx)
    if (!patient) return { kind: 'missing', what: 'patient' }
    const coherence = await checkCommercialCoherence(patient.organizationId, validated.value, tx)
    if (!coherence.ok) return { kind: 'refused', code: coherence.code, message: coherence.message }

    const record = await createMembershipRecord(patientId, validated.value, tx)
    await recordAuditEvent(
      {
        organizationId: patient.organizationId,
        actorUserId,
        actionCode: 'insuranceMembership.created',
        entityType: 'INSURANCE_MEMBERSHIP',
        entityId: record.id,
        beforeState: null,
        afterState: insuranceMembershipAuditSnapshot(record),
      },
      tx,
    )
    return { kind: 'written', record }
  })

  if (outcome.kind === 'missing') return failure('NOT_FOUND', `${outcome.what} not found`)
  if (outcome.kind === 'refused') return failure(outcome.code, outcome.message)
  return { ok: true, value: toMembershipDto(outcome.record) }
}

export async function listMemberships(patientId: string): Promise<InsuranceMembershipResult<InsuranceMembershipDto[]>> {
  if (!isMembershipUuid(patientId)) return invalid('invalid patient id')
  if (!(await findPatientOwnership(patientId))) return failure('NOT_FOUND', 'patient not found')
  const records = await findMembershipsByPatientId(patientId)
  return { ok: true, value: records.map(toMembershipDto) }
}

export async function getMembership(id: string): Promise<InsuranceMembershipResult<InsuranceMembershipDto>> {
  if (!isMembershipUuid(id)) return invalid('invalid membership id')
  const record = await findMembershipById(id)
  if (!record) return failure('NOT_FOUND', 'membership not found')
  return { ok: true, value: toMembershipDto(record) }
}

export async function updateMembership(
  id: string,
  body: unknown,
  actorUserId: string,
): Promise<InsuranceMembershipResult<InsuranceMembershipDto>> {
  if (!isMembershipUuid(id)) return invalid('invalid membership id')
  const validated = validateUpdateInput(body)
  if (!validated.ok) return invalid(validated.message)

  // Guarded-writer protocol: lock the membership row, re-read it inside the transaction, judge the
  // MERGED state (dates and full commercial coherence), then write only the changed fields and
  // their safe audit. The before-state is never read outside this transaction, so two concurrent
  // partial corrections serialize and neither erases the other's field.
  const outcome = await prisma.$transaction(async (tx): Promise<UpdateOutcome> => {
    const locked = await lockRowForUpdate(tx, 'insurance_memberships', id)
    if (!locked) return { kind: 'missing', what: 'membership' }
    await concurrencyProbe('insuranceMembership.update')
    const existing = await findMembershipById(id, tx)
    if (!existing) return { kind: 'missing', what: 'membership' }

    const changed = changedFields(existing, validated.value)
    if (changed.length === 0) return { kind: 'unchanged' }

    const merged = mergeMembership(existing, validated.value)
    if (!coverageDatesCoherent(merged.coverageFrom, merged.coverageTo))
      return { kind: 'refused', code: 'VALIDATION_ERROR', message: 'coverageTo must not be before coverageFrom' }

    const patient = await findPatientOwnership(existing.patientId, tx)
    if (!patient) return { kind: 'missing', what: 'membership' }
    const coherence = await checkCommercialCoherence(patient.organizationId, merged, tx)
    if (!coherence.ok) return { kind: 'refused', code: coherence.code, message: coherence.message }

    const patch = Object.fromEntries(changed.map((field) => [field, merged[field as keyof MembershipWriteInput]]))
    const updated = await updateMembershipRecord(id, patch, tx)
    await recordAuditEvent(
      {
        organizationId: patient.organizationId,
        actorUserId,
        actionCode: 'insuranceMembership.updated',
        entityType: 'INSURANCE_MEMBERSHIP',
        entityId: id,
        beforeState: insuranceMembershipAuditSnapshot(existing),
        afterState: insuranceMembershipAuditSnapshot(updated, changed),
      },
      tx,
    )
    return { kind: 'written', record: updated }
  })

  if (outcome.kind === 'missing') return failure('NOT_FOUND', `${outcome.what} not found`)
  if (outcome.kind === 'refused') return failure(outcome.code, outcome.message)
  // A patch that changes nothing is refused rather than recorded: audit must describe what
  // happened, and nothing happened.
  if (outcome.kind === 'unchanged') return invalid('a patch must change at least one field')
  return { ok: true, value: toMembershipDto(outcome.record) }
}
