import { prisma } from '../../shared/database/prisma.ts'
import { lockRowForUpdate } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
// A5.1 owns evidence; its organization is read through A5.3's existing minimal projection, which
// selects no storage reference, hash or document type.
import { findEvidenceVersionOrganization } from '../prior-authorization/prior-authorization.repository.ts'
import type { EncounterEvidenceLinkDto, EncounterEvidenceLinkListDto, EvidenceRequirementResult } from '../evidence-requirement/evidence-requirement.types.ts'
import { isEvidenceRequirementUuid } from '../evidence-requirement/evidence-requirement.validation.ts'
import {
  createLinkRecord,
  findActiveLink,
  findActiveLinks,
  findEncounterOrganization,
  findLinkById,
  findLinkWithOrganization,
  removeLinkRecord,
} from './encounter-evidence.repository.ts'

// A5.6 §7 — associating an exact A5.1 evidence version with an Encounter where no narrower owner
// already links it. The link copies nothing about the evidence. It is corrected only by removing it
// once; a removed link stays readable as history, and re-linking is a new row.

const invalid = (message: string): EvidenceRequirementResult<never> => ({ ok: false, code: 'VALIDATION_ERROR', message })

type StoredLink = {
  id: string
  encounterId: string
  evidenceArtifactVersionId: string
  removedAt: Date | null
  createdByUserId: string
  createdAt: Date
  updatedAt: Date
}

export function toLinkDto(record: StoredLink): EncounterEvidenceLinkDto {
  return {
    id: record.id,
    encounterId: record.encounterId,
    evidenceArtifactVersionId: record.evidenceArtifactVersionId,
    removedAt: record.removedAt ? record.removedAt.toISOString() : null,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

// The audit trail proves the link existed and when it was removed — never which evidence, which
// Encounter or what the evidence was.
export const linkAuditSnapshot = (record: StoredLink) => ({
  id: record.id,
  ...(record.removedAt ? { removedAt: record.removedAt.toISOString() } : {}),
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
})

export async function createEncounterEvidenceLink(encounterId: string, body: unknown, actorUserId: string): Promise<EvidenceRequirementResult<EncounterEvidenceLinkDto>> {
  if (!isEvidenceRequirementUuid(encounterId)) return invalid('invalid encounter id')
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return invalid('a body of the form { evidenceArtifactVersionId } is required')
  const unknown = Object.keys(body as Record<string, unknown>).filter((key) => key !== 'evidenceArtifactVersionId')
  if (unknown.length > 0) return invalid(`unknown field(s): ${unknown.join(', ')}`)
  const versionId = (body as Record<string, unknown>).evidenceArtifactVersionId
  if (!isEvidenceRequirementUuid(versionId)) return invalid('evidenceArtifactVersionId must be a UUID')

  const outcome = await prisma.$transaction(async (tx) => {
    // The Encounter row lock serializes concurrent links to it, so two identical first links cannot
    // both read "no active link yet". The partial unique index backs this up.
    if (!(await lockRowForUpdate(tx, 'encounters', encounterId))) return { kind: 'missing-encounter' as const }
    await concurrencyProbe('encounter_evidence_link.encounter_locked')
    const encounter = await findEncounterOrganization(encounterId, tx)
    if (!encounter) return { kind: 'missing-encounter' as const }
    const organizationId = encounter.patient.organizationId

    // A missing version and another organization's version are refused identically, before any of
    // its metadata is read, so a caller never learns that foreign evidence exists.
    const version = await findEvidenceVersionOrganization(versionId, tx)
    if (!version || version.evidenceArtifact.organizationId !== organizationId) return { kind: 'missing-evidence' as const }
    if (await findActiveLink(encounterId, versionId, tx)) return { kind: 'duplicate' as const }

    const record = await createLinkRecord(encounterId, versionId, actorUserId, tx)
    await recordAuditEvent(
      {
        organizationId,
        actorUserId,
        actionCode: 'encounter_evidence_link.created',
        entityType: 'ENCOUNTER_EVIDENCE_LINK',
        entityId: record.id,
        beforeState: null,
        afterState: linkAuditSnapshot(record),
      },
      tx,
    )
    await concurrencyProbe('encounter_evidence_link.created')
    return { kind: 'created' as const, record }
  })

  if (outcome.kind === 'missing-encounter') return { ok: false, code: 'NOT_FOUND', message: 'encounter not found' }
  if (outcome.kind === 'missing-evidence') return { ok: false, code: 'NOT_FOUND', message: 'evidenceArtifactVersionId was not found' }
  if (outcome.kind === 'duplicate') return invalid('this evidence version is already actively linked to this encounter')
  return { ok: true, value: toLinkDto(outcome.record) }
}

export async function listEncounterEvidenceLinks(encounterId: string): Promise<EvidenceRequirementResult<EncounterEvidenceLinkListDto>> {
  if (!isEvidenceRequirementUuid(encounterId)) return invalid('invalid encounter id')
  return { ok: true, value: { items: (await findActiveLinks(encounterId)).map(toLinkDto) } }
}

export async function getEncounterEvidenceLink(linkId: string): Promise<EvidenceRequirementResult<EncounterEvidenceLinkDto>> {
  if (!isEvidenceRequirementUuid(linkId)) return invalid('invalid evidence link id')
  const record = await findLinkById(linkId)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'evidence link not found' }
  return { ok: true, value: toLinkDto(record) }
}

export async function removeEncounterEvidenceLink(linkId: string, body: unknown, actorUserId: string): Promise<EvidenceRequirementResult<EncounterEvidenceLinkDto>> {
  if (!isEvidenceRequirementUuid(linkId)) return invalid('invalid evidence link id')
  if (body !== undefined && body !== null && (typeof body !== 'object' || Array.isArray(body) || Object.keys(body as object).length > 0))
    return invalid('the remove body must be empty')

  const outcome = await prisma.$transaction(async (tx) => {
    if (!(await lockRowForUpdate(tx, 'encounter_evidence_links', linkId))) return { kind: 'missing' as const }
    await concurrencyProbe('encounter_evidence_link.locked')
    const existing = await findLinkWithOrganization(linkId, tx)
    if (!existing) return { kind: 'missing' as const }
    // One-way and once: a removed link keeps its first removal time and is never reactivated.
    if (existing.removedAt !== null) return { kind: 'already-removed' as const }

    const record = await removeLinkRecord(linkId, new Date(), tx)
    await recordAuditEvent(
      {
        organizationId: existing.encounter.patient.organizationId,
        actorUserId,
        actionCode: 'encounter_evidence_link.removed',
        entityType: 'ENCOUNTER_EVIDENCE_LINK',
        entityId: linkId,
        beforeState: linkAuditSnapshot(existing),
        afterState: linkAuditSnapshot(record),
      },
      tx,
    )
    await concurrencyProbe('encounter_evidence_link.removed')
    return { kind: 'removed' as const, record }
  })

  if (outcome.kind === 'missing') return { ok: false, code: 'NOT_FOUND', message: 'evidence link not found' }
  if (outcome.kind === 'already-removed') return invalid('this evidence link has already been removed')
  return { ok: true, value: toLinkDto(outcome.record) }
}
