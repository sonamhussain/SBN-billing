import { prisma } from '../../shared/database/prisma.ts'
import { lockRowForUpdate } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { getOrganization } from '../organization/organization.service.ts'
import type {
  EvidenceArtifactDto,
  EvidenceArtifactListDto,
  EvidenceArtifactResult,
  EvidenceArtifactVersionDto,
  EvidenceArtifactVersionListDto,
} from './evidence-artifact.types.ts'
import {
  evidenceAuditSnapshot,
  isEvidenceUuid,
  nextVersionNumber,
  toEvidenceVersionDto,
  validateVersionBody,
} from './evidence-artifact.validation.ts'
import {
  createEvidenceArtifactRecord,
  createEvidenceVersionRecord,
  findEvidenceArtifactWithLatestVersion,
  findEvidenceArtifactsByOrganization,
  findEvidenceVersionById,
  findEvidenceVersions,
  findMaxVersionNumber,
} from './evidence-artifact.repository.ts'

// A5.1 — evidence identity and its immutable versions.
//
// Two writes exist and both are atomic with their audit record: creating an artifact together with
// its first version, and appending a later version. Nothing else writes. There is no update, no
// delete and no content transport, because a correction is a new version and the bytes live outside
// this system entirely.
//
// Version numbers are server-owned and gap-free. The number is read and claimed inside a lock on
// the ARTIFACT row, never on the version being written: a number nobody holds yet cannot be locked,
// so two writers reading the maximum outside a lock would both see the same value and both try to
// claim it. Locking the parent is what makes the sequence deterministic.

function toArtifactDto(record: { id: string; organizationId: string; createdAt: Date }, latest: EvidenceArtifactVersionDto): EvidenceArtifactDto {
  return {
    id: record.id,
    organizationId: record.organizationId,
    createdAt: record.createdAt.toISOString(),
    latestVersion: latest,
  }
}

export async function createEvidenceArtifact(
  organizationId: string,
  body: unknown,
  actorUserId: string,
): Promise<EvidenceArtifactResult<EvidenceArtifactDto>> {
  if (!isEvidenceUuid(organizationId)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }

  const organization = await getOrganization(organizationId)
  if (!organization.ok) return { ok: false, code: organization.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'VALIDATION_ERROR', message: organization.message }

  const validated = validateVersionBody(body, new Date())
  if (!validated.ok) return { ok: false, code: 'VALIDATION_ERROR', message: validated.message }
  const input = validated.value

  // An artifact never exists without the representation that brought it into being, so the artifact,
  // its version 1 and both audit records are one transaction. If any part fails, none of it happened.
  const created = await prisma.$transaction(async (tx) => {
    const artifact = await createEvidenceArtifactRecord(organizationId, tx)
    const version = await createEvidenceVersionRecord(
      { evidenceArtifactId: artifact.id, version: 1, ...input, createdByUserId: actorUserId },
      tx,
    )

    await recordAuditEvent(
      {
        organizationId,
        actorUserId,
        actionCode: 'evidence_artifact.created',
        entityType: 'EVIDENCE_ARTIFACT',
        entityId: artifact.id,
        beforeState: null,
        afterState: evidenceAuditSnapshot({ id: artifact.id, organizationId, createdAt: artifact.createdAt }),
      },
      tx,
    )
    await recordAuditEvent(
      {
        organizationId,
        actorUserId,
        actionCode: 'evidence_artifact_version.created',
        entityType: 'EVIDENCE_ARTIFACT_VERSION',
        entityId: version.id,
        beforeState: null,
        afterState: evidenceAuditSnapshot({ id: version.id, version: version.version, evidenceArtifactId: artifact.id, createdAt: version.createdAt }),
      },
      tx,
    )

    // Acceptance forces a failure here to prove the whole unit rolls back. In normal operation it
    // is a no-op.
    await concurrencyProbe('evidence_artifact.created')

    return { artifact, version }
  })

  return { ok: true, value: toArtifactDto(created.artifact, toEvidenceVersionDto(created.version)) }
}

export async function appendEvidenceVersion(
  artifactId: string,
  body: unknown,
  actorUserId: string,
): Promise<EvidenceArtifactResult<EvidenceArtifactVersionDto>> {
  if (!isEvidenceUuid(artifactId)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid evidence artifact id' }

  const validated = validateVersionBody(body, new Date())
  if (!validated.ok) return { ok: false, code: 'VALIDATION_ERROR', message: validated.message }
  const input = validated.value

  const outcome = await prisma.$transaction(async (tx) => {
    // Lock the artifact first. Every append for this artifact serializes here, so the maximum read
    // below cannot be invalidated between reading it and claiming the next number.
    const locked = await lockRowForUpdate(tx, 'evidence_artifacts', artifactId)
    if (!locked) return { kind: 'missing' as const }

    await concurrencyProbe('evidence_artifact_version.locked')

    const currentMax = await findMaxVersionNumber(artifactId, tx)
    const version = await createEvidenceVersionRecord(
      { evidenceArtifactId: artifactId, version: nextVersionNumber(currentMax), ...input, createdByUserId: actorUserId },
      tx,
    )

    const artifact = await tx.evidenceArtifact.findUniqueOrThrow({ where: { id: artifactId }, select: { organizationId: true } })
    await recordAuditEvent(
      {
        organizationId: artifact.organizationId,
        actorUserId,
        actionCode: 'evidence_artifact_version.created',
        entityType: 'EVIDENCE_ARTIFACT_VERSION',
        entityId: version.id,
        beforeState: null,
        afterState: evidenceAuditSnapshot({ id: version.id, version: version.version, evidenceArtifactId: artifactId, createdAt: version.createdAt }),
      },
      tx,
    )

    await concurrencyProbe('evidence_artifact_version.created')

    return { kind: 'created' as const, version }
  })

  if (outcome.kind === 'missing') return { ok: false, code: 'NOT_FOUND', message: 'evidence artifact not found' }
  return { ok: true, value: toEvidenceVersionDto(outcome.version) }
}

export async function listEvidenceArtifacts(organizationId: string): Promise<EvidenceArtifactResult<EvidenceArtifactListDto>> {
  if (!isEvidenceUuid(organizationId)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }
  const rows = await findEvidenceArtifactsByOrganization(organizationId)
  return {
    ok: true,
    value: {
      // Every artifact has a version 1, so the include always yields one; the guard is here because
      // a row that somehow had none would be a broken artifact, not an empty list entry.
      items: rows
        .filter((row) => row.versions.length > 0)
        .map((row) => toArtifactDto(row, toEvidenceVersionDto(row.versions[0]))),
    },
  }
}

export async function getEvidenceArtifact(artifactId: string): Promise<EvidenceArtifactResult<EvidenceArtifactDto>> {
  if (!isEvidenceUuid(artifactId)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid evidence artifact id' }
  const row = await findEvidenceArtifactWithLatestVersion(artifactId)
  if (!row || row.versions.length === 0) return { ok: false, code: 'NOT_FOUND', message: 'evidence artifact not found' }
  return { ok: true, value: toArtifactDto(row, toEvidenceVersionDto(row.versions[0])) }
}

export async function listEvidenceVersions(artifactId: string): Promise<EvidenceArtifactResult<EvidenceArtifactVersionListDto>> {
  if (!isEvidenceUuid(artifactId)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid evidence artifact id' }
  const rows = await findEvidenceVersions(artifactId)
  if (rows.length === 0) return { ok: false, code: 'NOT_FOUND', message: 'evidence artifact not found' }
  return { ok: true, value: { items: rows.map((row) => toEvidenceVersionDto(row)) } }
}

export async function getEvidenceVersion(versionId: string): Promise<EvidenceArtifactResult<EvidenceArtifactVersionDto>> {
  if (!isEvidenceUuid(versionId)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid evidence version id' }
  const row = await findEvidenceVersionById(versionId)
  if (!row) return { ok: false, code: 'NOT_FOUND', message: 'evidence version not found' }
  return { ok: true, value: toEvidenceVersionDto(row) }
}
