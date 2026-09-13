import { findRuleSourceVersionWithOrganization } from '../rule-source-version/rule-source-version.repository.ts'
import type { SourceInterpretationDto, SourceInterpretationResult } from './source-interpretation.types.ts'
import {
  isSourceInterpretationUuid,
  normalizeInterpretationVersion,
  normalizeNormalizedInterpretationRef,
  normalizeVerificationStatus,
  type VerificationStatus,
} from './source-interpretation.validation.ts'
import {
  createSourceInterpretationRecord,
  findSourceInterpretationById,
  findSourceInterpretationsByVersionId,
  findSourceInterpretationWithOrganization,
  updateSourceInterpretationRecord,
} from './source-interpretation.repository.ts'
import { prisma } from '../../shared/database/prisma.ts'
import { Prisma } from '../../../generated/prisma/client.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { sourceInterpretationAuditSnapshot } from '../audit/audit.snapshot.ts'

type SourceInterpretationRecord = {
  id: string
  sourceVersionId: string
  interpretationVersion: string
  normalizedInterpretationRef: string
  verificationStatus: string
  verifiedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

function toDto(record: SourceInterpretationRecord): SourceInterpretationDto {
  return {
    id: record.id,
    sourceVersionId: record.sourceVersionId,
    interpretationVersion: record.interpretationVersion,
    normalizedInterpretationRef: record.normalizedInterpretationRef,
    verificationStatus: record.verificationStatus,
    verifiedAt: record.verifiedAt ? record.verifiedAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

const terminalStatuses: readonly string[] = ['VERIFIED', 'REJECTED']

export async function createSourceInterpretation(
  sourceVersionId: string,
  interpretationVersionInput: unknown,
  normalizedInterpretationRefInput: unknown,
  actorUserId: string,
): Promise<SourceInterpretationResult<SourceInterpretationDto>> {
  if (!isSourceInterpretationUuid(sourceVersionId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule source version id' }

  const interpretationVersion = normalizeInterpretationVersion(interpretationVersionInput)
  if (!interpretationVersion) return { ok: false, code: 'VALIDATION_ERROR', message: 'interpretationVersion is required' }

  const normalizedInterpretationRef = normalizeNormalizedInterpretationRef(normalizedInterpretationRefInput)
  if (!normalizedInterpretationRef)
    return { ok: false, code: 'VALIDATION_ERROR', message: 'normalizedInterpretationRef is required' }

  const sourceVersion = await findRuleSourceVersionWithOrganization(sourceVersionId)
  if (!sourceVersion) return { ok: false, code: 'NOT_FOUND', message: 'rule source version not found' }

  try {
    const created = await prisma.$transaction(async (tx) => {
      // New interpretations always start UNVERIFIED with no verifiedAt — the client
      // never supplies verificationStatus or verifiedAt on create.
      const record = await createSourceInterpretationRecord(
        { sourceVersionId, interpretationVersion, normalizedInterpretationRef, verificationStatus: 'UNVERIFIED' },
        tx,
      )

      await recordAuditEvent(
        {
          organizationId: sourceVersion.source.organizationId as string,
          actorUserId,
          actionCode: 'source_interpretation.created',
          entityType: 'SOURCE_INTERPRETATION',
          entityId: record.id,
          beforeState: null,
          afterState: sourceInterpretationAuditSnapshot(record),
        },
        tx,
      )

      return record
    })

    return { ok: true, value: toDto(created) }
  } catch (error) {
    if (isUniqueConstraintViolation(error))
      return { ok: false, code: 'VALIDATION_ERROR', message: 'interpretationVersion already exists for this rule source version' }
    throw error
  }
}

export async function getSourceInterpretation(id: string): Promise<SourceInterpretationResult<SourceInterpretationDto>> {
  if (!isSourceInterpretationUuid(id))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid source interpretation id' }
  const record = await findSourceInterpretationById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'source interpretation not found' }
  return { ok: true, value: toDto(record) }
}

export async function listSourceInterpretations(
  sourceVersionId: string,
): Promise<SourceInterpretationResult<SourceInterpretationDto[]>> {
  if (!isSourceInterpretationUuid(sourceVersionId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule source version id' }

  const sourceVersion = await findRuleSourceVersionWithOrganization(sourceVersionId)
  if (!sourceVersion) return { ok: false, code: 'NOT_FOUND', message: 'rule source version not found' }

  const records = await findSourceInterpretationsByVersionId(sourceVersionId)
  return { ok: true, value: records.map(toDto) }
}

export async function updateSourceInterpretation(
  id: string,
  normalizedInterpretationRefInput: unknown,
  verificationStatusInput: unknown,
  hasImmutableFieldAttempt: boolean,
  actorUserId: string,
): Promise<SourceInterpretationResult<SourceInterpretationDto>> {
  if (!isSourceInterpretationUuid(id))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid source interpretation id' }

  if (hasImmutableFieldAttempt)
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'id, sourceVersionId, verifiedAt, createdAt and updatedAt cannot be changed',
    }

  const hasNormalizedInterpretationRef = normalizedInterpretationRefInput !== undefined
  const hasVerificationStatus = verificationStatusInput !== undefined

  if (!hasNormalizedInterpretationRef && !hasVerificationStatus)
    return { ok: false, code: 'VALIDATION_ERROR', message: 'at least one field is required' }

  let normalizedInterpretationRef: string | null = null
  if (hasNormalizedInterpretationRef) {
    normalizedInterpretationRef = normalizeNormalizedInterpretationRef(normalizedInterpretationRefInput)
    if (!normalizedInterpretationRef)
      return { ok: false, code: 'VALIDATION_ERROR', message: 'normalizedInterpretationRef is required' }
  }

  let verificationStatus: VerificationStatus | null = null
  if (hasVerificationStatus) {
    verificationStatus = normalizeVerificationStatus(verificationStatusInput)
    if (!verificationStatus) return { ok: false, code: 'VALIDATION_ERROR', message: 'verificationStatus is invalid' }
  }

  const outcome = await prisma.$transaction(async (tx) => {
    const existing = await findSourceInterpretationWithOrganization(id, tx)
    if (!existing) return { kind: 'not_found' as const }

    if (terminalStatuses.includes(existing.verificationStatus)) return { kind: 'terminal' as const }

    // verifiedAt is server-generated: non-null only the moment status becomes VERIFIED,
    // and forced back to null for every other status per the DB CHECK invariant.
    const nextVerifiedAt = verificationStatus === 'VERIFIED' ? new Date() : null

    const record = await updateSourceInterpretationRecord(
      id,
      {
        ...(normalizedInterpretationRef ? { normalizedInterpretationRef } : {}),
        ...(verificationStatus ? { verificationStatus, verifiedAt: nextVerifiedAt } : {}),
      },
      tx,
    )

    await recordAuditEvent(
      {
        organizationId: existing.sourceVersion.source.organizationId as string,
        actorUserId,
        actionCode: 'source_interpretation.updated',
        entityType: 'SOURCE_INTERPRETATION',
        entityId: id,
        beforeState: sourceInterpretationAuditSnapshot(existing),
        afterState: sourceInterpretationAuditSnapshot(record),
      },
      tx,
    )

    return { kind: 'updated' as const, record }
  })

  if (outcome.kind === 'not_found') return { ok: false, code: 'NOT_FOUND', message: 'source interpretation not found' }
  if (outcome.kind === 'terminal')
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'interpretation is VERIFIED or REJECTED and cannot be changed; create a new interpretation version instead',
    }

  return { ok: true, value: toDto(outcome.record) }
}
