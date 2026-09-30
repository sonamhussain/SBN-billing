import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { lockRowForUpdate } from '../../shared/database/row-lock.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
// A4.6 and A4.5 own master ownership for services, procedures and diagnoses. Their readers are reused
// exactly as written; A5.4 declares no second ownership query for the same masters.
import { findProcedureCodeOwnership, findServiceOwnership } from '../encounter-activity/encounter-activity.repository.ts'
import { findDiagnosisCodeOwnership } from '../encounter-diagnosis/encounter-diagnosis.repository.ts'
// A4.9 owns the current Encounter billing context and the active activity and diagnosis facts. Scope
// evaluation reads them through A4.9's own loaders, inside its own snapshot, rather than copying them.
import {
  findActiveActivities,
  findActiveDiagnoses,
  findEncounterForBillingContext,
  readTransactionTimestamp,
} from '../encounter-billing-context/encounter-billing-context.repository.ts'
import { evaluateScope } from './authorization-line.matcher.ts'
import type {
  AuthorizationLineDto,
  AuthorizationLineInput,
  AuthorizationLineListDto,
  AuthorizationLineResult,
  AuthorizationScopeEvaluationV1,
} from './authorization-line.types.ts'
import {
  frozenContextMatches,
  isAuthorizationLineUuid,
  lineAuditSnapshot,
  toLineDto,
  validateLineBatch,
} from './authorization-line.validation.ts'
import {
  countLinesForVersion,
  createLineRecords,
  findLineById,
  findLinesByVersion,
  findVersionForEvaluation,
  findVersionOrganization,
  versionExists,
} from './authorization-line.repository.ts'

// A5.4 — capturing the line-level scope of one exact A5.3 version, and comparing that scope with the
// Encounter as it stands now.
//
// One write exists: the single batch capture, atomic with one audit record per line. There is no
// update, no delete and no single-line append, because a line set is source truth for one version
// and a correction is a new A5.3 version with its own lines.
//
// Scope evaluation writes nothing — no match row, no audit and no cached result. Every call reads the
// current facts again in one REPEATABLE READ, READ ONLY snapshot, so a result can never go stale in
// storage, because it is never in storage.

function invalid(message: string): AuthorizationLineResult<never> {
  return { ok: false, code: 'VALIDATION_ERROR', message }
}

type OwnershipOutcome = { ok: true } | { ok: false; message: string }

// Every supplied master must belong to the organization that owns the authorization. A missing id
// and another organization's id are refused with the same wording, so a caller never learns that a
// foreign master exists. Each distinct id is read once however many lines name it.
async function verifyMasterOwnership(lines: AuthorizationLineInput[], organizationId: string, tx: DbClient): Promise<OwnershipOutcome> {
  const owned = new Map<string, boolean>()
  const isOwned = async (kind: string, id: string, read: (id: string, db: DbClient) => Promise<{ organizationId: string } | null>) => {
    const key = `${kind}:${id}`
    if (!owned.has(key)) owned.set(key, (await read(id, tx))?.organizationId === organizationId)
    return owned.get(key) === true
  }

  for (const [index, line] of lines.entries()) {
    if (line.serviceId !== null && !(await isOwned('service', line.serviceId, findServiceOwnership)))
      return { ok: false, message: `lines[${index}]: serviceId was not found` }
    if (line.procedureCodeId !== null && !(await isOwned('procedure', line.procedureCodeId, findProcedureCodeOwnership)))
      return { ok: false, message: `lines[${index}]: procedureCodeId was not found` }
    if (line.diagnosisCodeId !== null && !(await isOwned('diagnosis', line.diagnosisCodeId, findDiagnosisCodeOwnership)))
      return { ok: false, message: `lines[${index}]: diagnosisCodeId was not found` }
  }
  return { ok: true }
}

export async function captureAuthorizationLines(
  versionId: string,
  body: unknown,
  actorUserId: string,
): Promise<AuthorizationLineResult<AuthorizationLineListDto>> {
  if (!isAuthorizationLineUuid(versionId)) return invalid('invalid prior authorization version id')

  const validated = validateLineBatch(body)
  if (!validated.ok) return invalid(validated.message)
  const lines = validated.value

  const outcome = await prisma.$transaction(async (tx) => {
    // Lock the exact version first. Two concurrent first batches serialize here, so the second one
    // reads the first one's lines below and is refused, instead of both reading "no lines yet".
    const locked = await lockRowForUpdate(tx, 'prior_authorization_versions', versionId)
    if (!locked) return { kind: 'missing' as const }

    await concurrencyProbe('authorization_line.version_locked')

    const version = await findVersionOrganization(versionId, tx)
    if (!version) return { kind: 'missing' as const }
    const organizationId = version.priorAuthorization.encounter.patient.organizationId

    // One batch per version. A second batch would silently extend scope a decision may already have
    // been made against; the correction path is a new A5.3 version with its own complete line set.
    if ((await countLinesForVersion(versionId, tx)) > 0) return { kind: 'already-captured' as const }

    const ownership = await verifyMasterOwnership(lines, organizationId, tx)
    if (!ownership.ok) return { kind: 'master-not-found' as const, message: ownership.message }

    const created = await createLineRecords(versionId, lines, actorUserId, tx)
    const ordered = [...created].sort((a, b) => a.sequence - b.sequence)

    // One safe audit event per line, in the same transaction. The snapshot names the row and its
    // position only; the scope itself never enters the audit trail.
    for (const line of ordered) {
      await recordAuditEvent(
        {
          organizationId,
          actorUserId,
          actionCode: 'authorization_line.created',
          entityType: 'AUTHORIZATION_LINE',
          entityId: line.id,
          beforeState: null,
          afterState: lineAuditSnapshot(line),
        },
        tx,
      )
    }

    // Acceptance forces a failure here to prove the whole batch rolls back with its audits. In
    // normal operation it is a no-op.
    await concurrencyProbe('authorization_line.created')

    return { kind: 'created' as const, lines: ordered }
  })

  if (outcome.kind === 'missing') return { ok: false, code: 'NOT_FOUND', message: 'prior authorization version not found' }
  if (outcome.kind === 'already-captured')
    return invalid('authorization lines were already captured for this prior authorization version; a correction is a new prior authorization version')
  if (outcome.kind === 'master-not-found') return { ok: false, code: 'NOT_FOUND', message: outcome.message }

  return { ok: true, value: { items: outcome.lines.map(toLineDto) } }
}

export async function listAuthorizationLines(versionId: string): Promise<AuthorizationLineResult<AuthorizationLineListDto>> {
  if (!isAuthorizationLineUuid(versionId)) return invalid('invalid prior authorization version id')
  if (!(await versionExists(versionId))) return { ok: false, code: 'NOT_FOUND', message: 'prior authorization version not found' }
  const rows = await findLinesByVersion(versionId)
  return { ok: true, value: { items: rows.map(toLineDto) } }
}

export async function getAuthorizationLine(lineId: string): Promise<AuthorizationLineResult<AuthorizationLineDto>> {
  if (!isAuthorizationLineUuid(lineId)) return invalid('invalid authorization line id')
  const row = await findLineById(lineId)
  if (!row) return { ok: false, code: 'NOT_FOUND', message: 'authorization line not found' }
  return { ok: true, value: toLineDto(row) }
}

// §12 — one snapshot, read-only, recomputed on every call.
export async function evaluateAuthorizationScope(
  versionId: string,
  db?: DbClient,
): Promise<AuthorizationLineResult<AuthorizationScopeEvaluationV1>> {
  if (!isAuthorizationLineUuid(versionId)) return invalid('invalid prior authorization version id')

  const evaluation = await withReadSnapshot(db, async (tx) => {
    const evaluatedAt = await readTransactionTimestamp(tx)

    // Steps 1-2: the exact version, its immutable lines and the frozen context of its parent case.
    const version = await findVersionForEvaluation(versionId, tx)
    if (!version) return null
    const frozen = version.priorAuthorization
    const lines = await findLinesByVersion(versionId, tx)

    // Steps 3-5: the Encounter as it stands now, from A4.9's own loader in the same snapshot, compared
    // field by field with the frozen context. Drift fails closed; nothing is re-resolved.
    const encounter = await findEncounterForBillingContext(frozen.encounterId, tx)
    const contextMatch = frozenContextMatches(
      frozen,
      encounter === null
        ? null
        : {
            insuranceMembershipId: encounter.insuranceMembershipId,
            facilityId: encounter.facilityId,
            clinicianId: encounter.clinicianId,
            serviceDate: encounter.serviceDate,
            membership: encounter.insuranceMembership,
          },
    )

    // Step 6: active facts only. Removed activities are not candidates, and removed diagnoses do not
    // satisfy a diagnosis scope, because A4.9's loaders never return them.
    const activities = await findActiveActivities(frozen.encounterId, tx)
    const diagnoses = await findActiveDiagnoses(frozen.encounterId, tx)

    const result = evaluateScope({
      contextMatch,
      header: { status: version.status, validFrom: version.validFrom, validThrough: version.validThrough },
      serviceDate: frozen.serviceDate,
      lines: lines.map((line) => ({
        id: line.id,
        sequence: line.sequence,
        serviceId: line.serviceId,
        procedureCodeId: line.procedureCodeId,
        diagnosisCodeId: line.diagnosisCodeId,
        approvedQty: line.approvedQty,
        unitCode: line.unitCode,
        approvedFrom: line.approvedFrom,
        approvedThrough: line.approvedThrough,
        status: line.status,
      })),
      activities: activities.map((activity) => ({
        id: activity.id,
        serviceId: activity.serviceId,
        procedureCodeId: activity.procedureCodeId,
        quantity: activity.quantity,
        unitCode: activity.unitCode,
      })),
      activeDiagnosisCodeIds: diagnoses.map((diagnosis) => diagnosis.diagnosisCodeId),
    })

    return {
      schemaVersion: 'AuthorizationScopeEvaluationV1' as const,
      evaluatedAt: evaluatedAt.toISOString(),
      priorAuthorizationId: frozen.id,
      priorAuthorizationVersionId: version.id,
      encounterId: frozen.encounterId,
      contextMatch,
      activities: result.activities,
      lineUtilization: result.lineUtilization,
    }
  })

  if (!evaluation) return { ok: false, code: 'NOT_FOUND', message: 'prior authorization version not found' }
  return { ok: true, value: evaluation }
}
