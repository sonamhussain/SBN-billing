import { getOrganization } from '../organization/organization.service.ts'
import type { RulePackDto, RulePackMemberDto, RulePackResult, RulePackVersionDto } from './rule-pack.types.ts'
import {
  decideActivation,
  decideMemberEligibility,
  decideVerification,
  frozenSnapshotMessage,
  hasCoherentDates,
  isDraft,
  isRulePackUuid,
  normalizePackDisplayName,
  normalizePackJurisdictionCode,
  normalizePackKey,
  normalizePackVersion,
} from './rule-pack.validation.ts'
import {
  createRulePackMemberRecord,
  createRulePackRecord,
  createRulePackVersionRecord,
  deleteRulePackMemberRecord,
  findActiveRulePackVersion,
  findRulePackById,
  findRulePackMemberById,
  findRulePackMemberWithPack,
  findRulePackMembersByVersionId,
  findRulePackMembersForVerification,
  findRulePacksByOrganizationId,
  findRulePackVersionById,
  findRulePackVersionWithPack,
  findRulePackVersionsByPackId,
  findRuleVersionForMembership,
  updateRulePackRecord,
  updateRulePackVersionRecord,
} from './rule-pack.repository.ts'
import { formatDateOnly, normalizeDateOnlyField, parseStrictDateOnly } from '../../shared/rules/date-only.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { lockRowForUpdate } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { Prisma } from '../../../generated/prisma/client.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { rulePackAuditSnapshot, rulePackMemberAuditSnapshot, rulePackVersionAuditSnapshot } from '../audit/audit.snapshot.ts'

type RulePackRecord = {
  id: string
  organizationId: string | null
  packKey: string
  displayName: string
  jurisdictionCode: string
  ownershipScope: string
  createdAt: Date
  updatedAt: Date
}

type RulePackVersionRecord = {
  id: string
  rulePackId: string
  version: string
  effectiveFrom: Date | null
  effectiveTo: Date | null
  verificationStatus: string
  verifiedAt: Date | null
  activationStatus: string
  activatedAt: Date | null
  supersededAt: Date | null
  createdAt: Date
  updatedAt: Date
}

type RulePackMemberRecord = { id: string; rulePackVersionId: string; ruleVersionId: string; createdAt: Date }

function toPackDto(record: RulePackRecord): RulePackDto {
  return {
    id: record.id,
    organizationId: record.organizationId,
    packKey: record.packKey,
    displayName: record.displayName,
    jurisdictionCode: record.jurisdictionCode,
    ownershipScope: record.ownershipScope,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

function toVersionDto(record: RulePackVersionRecord): RulePackVersionDto {
  return {
    id: record.id,
    rulePackId: record.rulePackId,
    version: record.version,
    effectiveFrom: formatDateOnly(record.effectiveFrom),
    effectiveTo: formatDateOnly(record.effectiveTo),
    verificationStatus: record.verificationStatus,
    verifiedAt: record.verifiedAt ? record.verifiedAt.toISOString() : null,
    activationStatus: record.activationStatus,
    activatedAt: record.activatedAt ? record.activatedAt.toISOString() : null,
    supersededAt: record.supersededAt ? record.supersededAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

function toMemberDto(record: RulePackMemberRecord): RulePackMemberDto {
  return {
    id: record.id,
    rulePackVersionId: record.rulePackVersionId,
    ruleVersionId: record.ruleVersionId,
    createdAt: record.createdAt.toISOString(),
  }
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

type Outcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'not_found'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'invalid'; message: string }

function toResult<T, D>(outcome: Outcome<T>, map: (value: T) => D): RulePackResult<D> {
  if (outcome.kind === 'not_found') return { ok: false, code: 'NOT_FOUND', message: outcome.message }
  if (outcome.kind === 'forbidden') return { ok: false, code: 'FORBIDDEN', message: outcome.message }
  if (outcome.kind === 'invalid') return { ok: false, code: 'VALIDATION_ERROR', message: outcome.message }
  return { ok: true, value: map(outcome.value) }
}

// A3.9 guarded-writer protocol: every write that depends on a pack version's lifecycle state locks
// the PARENT pack row FOR UPDATE, then re-reads what it decides on inside that transaction. Date
// edits, member changes, verification and activation of any version of one pack therefore never
// interleave, and a freeze or one-ACTIVE decision is never taken on a stale read. The first read
// here only learns which pack to lock; the decision always uses the locked re-read.
async function withPackLock<T>(
  rulePackId: string,
  probeName: string,
  run: (tx: DbClient) => Promise<Outcome<T>>,
): Promise<Outcome<T>> {
  return prisma.$transaction(async (tx) => {
    const locked = await lockRowForUpdate(tx, 'rule_packs', rulePackId)
    if (!locked) return { kind: 'not_found' as const, message: 'rule pack not found' }
    await concurrencyProbe(probeName)
    return run(tx)
  })
}

// ---------------------------------------------------------------------------------------------
// RulePack
// ---------------------------------------------------------------------------------------------

export async function createRulePack(
  organizationId: string,
  packKeyInput: unknown,
  displayNameInput: unknown,
  jurisdictionCodeInput: unknown,
  actorUserId: string,
): Promise<RulePackResult<RulePackDto>> {
  if (!isRulePackUuid(organizationId)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }

  const packKey = normalizePackKey(packKeyInput)
  if (!packKey) return { ok: false, code: 'VALIDATION_ERROR', message: 'packKey is required' }
  const displayName = normalizePackDisplayName(displayNameInput)
  if (!displayName) return { ok: false, code: 'VALIDATION_ERROR', message: 'displayName is required' }
  const jurisdictionCode = normalizePackJurisdictionCode(jurisdictionCodeInput)
  if (!jurisdictionCode) return { ok: false, code: 'VALIDATION_ERROR', message: 'jurisdictionCode is required' }

  const organization = await getOrganization(organizationId)
  if (!organization.ok) return { ok: false, code: organization.code, message: organization.message }

  try {
    const created = await prisma.$transaction(async (tx) => {
      // Tenant POST always creates an ORGANIZATION pack. ownershipScope and organizationId are
      // derived here from the route, never from the request body.
      const record = await createRulePackRecord(
        { organizationId, packKey, displayName, jurisdictionCode, ownershipScope: 'ORGANIZATION' },
        tx,
      )
      await recordAuditEvent(
        {
          organizationId,
          actorUserId,
          actionCode: 'rule_pack.created',
          entityType: 'RULE_PACK',
          entityId: record.id,
          beforeState: null,
          afterState: rulePackAuditSnapshot(record),
        },
        tx,
      )
      return record
    })
    return { ok: true, value: toPackDto(created) }
  } catch (error) {
    if (isUniqueConstraintViolation(error))
      return { ok: false, code: 'VALIDATION_ERROR', message: 'packKey already exists for this organization' }
    throw error
  }
}

export async function listRulePacks(organizationId: string): Promise<RulePackResult<RulePackDto[]>> {
  if (!isRulePackUuid(organizationId)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }
  const organization = await getOrganization(organizationId)
  if (!organization.ok) return { ok: false, code: organization.code, message: organization.message }
  const records = await findRulePacksByOrganizationId(organizationId)
  return { ok: true, value: records.map(toPackDto) }
}

export async function getRulePack(id: string): Promise<RulePackResult<RulePackDto>> {
  if (!isRulePackUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule pack id' }
  const record = await findRulePackById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'rule pack not found' }
  return { ok: true, value: toPackDto(record) }
}

export async function updateRulePack(
  id: string,
  displayNameInput: unknown,
  hasIdentityFieldAttempt: boolean,
  actorUserId: string,
): Promise<RulePackResult<RulePackDto>> {
  if (!isRulePackUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule pack id' }
  if (hasIdentityFieldAttempt)
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'id, organizationId, ownershipScope, packKey, jurisdictionCode, createdAt and updatedAt cannot be changed',
    }
  const displayName = normalizePackDisplayName(displayNameInput)
  if (!displayName) return { ok: false, code: 'VALIDATION_ERROR', message: 'displayName is required' }

  const outcome = await withPackLock(id, 'rule_pack.update', async (tx) => {
    const existing = await findRulePackById(id, tx)
    // Defense in depth: the route already 404s a SYSTEM_SHARED pack for tenant callers.
    if (!existing || existing.organizationId === null) return { kind: 'not_found' as const, message: 'rule pack not found' }
    const record = await updateRulePackRecord(id, { displayName }, tx)
    await recordAuditEvent(
      {
        organizationId: existing.organizationId,
        actorUserId,
        actionCode: 'rule_pack.updated',
        entityType: 'RULE_PACK',
        entityId: id,
        beforeState: rulePackAuditSnapshot(existing),
        afterState: rulePackAuditSnapshot(record),
      },
      tx,
    )
    return { kind: 'ok' as const, value: record }
  })
  return toResult(outcome, toPackDto)
}

// ---------------------------------------------------------------------------------------------
// RulePackVersion
// ---------------------------------------------------------------------------------------------

type DateInputs = { from: Date | null; to: Date | null } | { error: string }

function parseCreateDates(effectiveFromInput: unknown, effectiveToInput: unknown): DateInputs {
  const from = normalizeDateOnlyField(effectiveFromInput)
  const to = normalizeDateOnlyField(effectiveToInput)
  if (from.present && !from.valid) return { error: 'effectiveFrom must be a real YYYY-MM-DD date or null' }
  if (to.present && !to.valid) return { error: 'effectiveTo must be a real YYYY-MM-DD date or null' }
  return { from: from.present && from.valid ? from.value : null, to: to.present && to.valid ? to.value : null }
}

export async function createRulePackVersion(
  rulePackId: string,
  versionInput: unknown,
  effectiveFromInput: unknown,
  effectiveToInput: unknown,
  hasLifecycleFieldAttempt: boolean,
  actorUserId: string,
): Promise<RulePackResult<RulePackVersionDto>> {
  if (!isRulePackUuid(rulePackId)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule pack id' }
  if (hasLifecycleFieldAttempt)
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'a new rule pack version is always UNVERIFIED and INACTIVE; lifecycle fields cannot be supplied',
    }
  const version = normalizePackVersion(versionInput)
  if (!version) return { ok: false, code: 'VALIDATION_ERROR', message: 'version is required' }
  const dates = parseCreateDates(effectiveFromInput, effectiveToInput)
  if ('error' in dates) return { ok: false, code: 'VALIDATION_ERROR', message: dates.error }
  if (!hasCoherentDates({ effectiveFrom: dates.from, effectiveTo: dates.to }))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'effectiveTo must not be before effectiveFrom' }

  try {
    const outcome = await withPackLock(rulePackId, 'rule_pack_version.create', async (tx) => {
      const pack = await findRulePackById(rulePackId, tx)
      if (!pack || pack.organizationId === null) return { kind: 'not_found' as const, message: 'rule pack not found' }
      const record = await createRulePackVersionRecord({ rulePackId, version, effectiveFrom: dates.from, effectiveTo: dates.to }, tx)
      await recordAuditEvent(
        {
          organizationId: pack.organizationId,
          actorUserId,
          actionCode: 'rule_pack_version.created',
          entityType: 'RULE_PACK_VERSION',
          entityId: record.id,
          beforeState: null,
          afterState: rulePackVersionAuditSnapshot(record),
        },
        tx,
      )
      return { kind: 'ok' as const, value: record }
    })
    return toResult(outcome, toVersionDto)
  } catch (error) {
    if (isUniqueConstraintViolation(error))
      return { ok: false, code: 'VALIDATION_ERROR', message: 'this version already exists for the rule pack' }
    throw error
  }
}

export async function listRulePackVersions(rulePackId: string): Promise<RulePackResult<RulePackVersionDto[]>> {
  if (!isRulePackUuid(rulePackId)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule pack id' }
  const pack = await findRulePackById(rulePackId)
  if (!pack) return { ok: false, code: 'NOT_FOUND', message: 'rule pack not found' }
  const records = await findRulePackVersionsByPackId(rulePackId)
  return { ok: true, value: records.map(toVersionDto) }
}

export async function getRulePackVersion(id: string): Promise<RulePackResult<RulePackVersionDto>> {
  if (!isRulePackUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule pack version id' }
  const record = await findRulePackVersionById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'rule pack version not found' }
  return { ok: true, value: toVersionDto(record) }
}

export async function updateRulePackVersion(
  id: string,
  effectiveFromInput: unknown,
  effectiveToInput: unknown,
  hasNonDateFieldAttempt: boolean,
  actorUserId: string,
): Promise<RulePackResult<RulePackVersionDto>> {
  if (!isRulePackUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule pack version id' }
  if (hasNonDateFieldAttempt)
    return { ok: false, code: 'VALIDATION_ERROR', message: 'only effectiveFrom and effectiveTo of a draft rule pack version can be changed' }

  const from = normalizeDateOnlyField(effectiveFromInput)
  const to = normalizeDateOnlyField(effectiveToInput)
  if (!from.present && !to.present) return { ok: false, code: 'VALIDATION_ERROR', message: 'effectiveFrom or effectiveTo is required' }
  if (from.present && !from.valid) return { ok: false, code: 'VALIDATION_ERROR', message: 'effectiveFrom must be a real YYYY-MM-DD date or null' }
  if (to.present && !to.valid) return { ok: false, code: 'VALIDATION_ERROR', message: 'effectiveTo must be a real YYYY-MM-DD date or null' }

  const target = await findRulePackVersionById(id)
  if (!target) return { ok: false, code: 'NOT_FOUND', message: 'rule pack version not found' }

  const outcome = await withPackLock(target.rulePackId, 'rule_pack_version.update', async (tx) => {
    const existing = await findRulePackVersionWithPack(id, tx)
    if (!existing || existing.rulePack.organizationId === null)
      return { kind: 'not_found' as const, message: 'rule pack version not found' }
    if (!isDraft(existing)) return { kind: 'invalid' as const, message: frozenSnapshotMessage }

    const effectiveFrom = from.present ? (from.valid ? from.value : null) : existing.effectiveFrom
    const effectiveTo = to.present ? (to.valid ? to.value : null) : existing.effectiveTo
    if (!hasCoherentDates({ effectiveFrom, effectiveTo }))
      return { kind: 'invalid' as const, message: 'effectiveTo must not be before effectiveFrom' }

    const record = await updateRulePackVersionRecord(id, { effectiveFrom, effectiveTo }, tx)
    await recordAuditEvent(
      {
        organizationId: existing.rulePack.organizationId,
        actorUserId,
        actionCode: 'rule_pack_version.updated',
        entityType: 'RULE_PACK_VERSION',
        entityId: id,
        beforeState: rulePackVersionAuditSnapshot(existing),
        afterState: rulePackVersionAuditSnapshot(record),
      },
      tx,
    )
    return { kind: 'ok' as const, value: record }
  })
  return toResult(outcome, toVersionDto)
}

// ---------------------------------------------------------------------------------------------
// RulePackMember
// ---------------------------------------------------------------------------------------------

export async function addRulePackMember(
  rulePackVersionId: string,
  ruleVersionIdInput: unknown,
  actorUserId: string,
): Promise<RulePackResult<RulePackMemberDto>> {
  if (!isRulePackUuid(rulePackVersionId)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule pack version id' }
  if (!isRulePackUuid(ruleVersionIdInput))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'ruleVersionId is required and must be a valid UUID' }
  const ruleVersionId = ruleVersionIdInput

  const target = await findRulePackVersionById(rulePackVersionId)
  if (!target) return { ok: false, code: 'NOT_FOUND', message: 'rule pack version not found' }

  try {
    const outcome = await withPackLock(target.rulePackId, 'rule_pack_member.add', async (tx) => {
      // Parent and RuleVersion are both read inside the locked transaction (A3.9 §17).
      const version = await findRulePackVersionWithPack(rulePackVersionId, tx)
      if (!version || version.rulePack.organizationId === null)
        return { kind: 'not_found' as const, message: 'rule pack version not found' }
      if (!isDraft(version)) return { kind: 'invalid' as const, message: frozenSnapshotMessage }

      const ruleVersion = await findRuleVersionForMembership(ruleVersionId, tx)
      if (!ruleVersion) return { kind: 'not_found' as const, message: 'rule version not found' }

      const eligibility = decideMemberEligibility(version.rulePack, ruleVersion.rule)
      if (eligibility.kind === 'foreign')
        return { kind: 'forbidden' as const, message: 'rule version belongs to a different organization' }
      if (eligibility.kind === 'shared_pack_requires_shared_rule')
        return { kind: 'invalid' as const, message: 'a SYSTEM_SHARED rule pack may contain only SYSTEM_SHARED rules' }
      if (eligibility.kind === 'jurisdiction_mismatch')
        return { kind: 'invalid' as const, message: 'rule version jurisdiction does not match the rule pack jurisdiction' }

      // Membership is the exact RuleVersion UUID only — no source, applicability or context copy.
      const record = await createRulePackMemberRecord({ rulePackVersionId, ruleVersionId }, tx)
      await recordAuditEvent(
        {
          organizationId: version.rulePack.organizationId,
          actorUserId,
          actionCode: 'rule_pack_member.added',
          entityType: 'RULE_PACK_MEMBER',
          entityId: record.id,
          beforeState: null,
          afterState: rulePackMemberAuditSnapshot(record),
        },
        tx,
      )
      return { kind: 'ok' as const, value: record }
    })
    return toResult(outcome, toMemberDto)
  } catch (error) {
    if (isUniqueConstraintViolation(error))
      return { ok: false, code: 'VALIDATION_ERROR', message: 'this rule version is already a member of the rule pack version' }
    throw error
  }
}

export async function listRulePackMembers(rulePackVersionId: string): Promise<RulePackResult<RulePackMemberDto[]>> {
  if (!isRulePackUuid(rulePackVersionId)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule pack version id' }
  const version = await findRulePackVersionById(rulePackVersionId)
  if (!version) return { ok: false, code: 'NOT_FOUND', message: 'rule pack version not found' }
  const records = await findRulePackMembersByVersionId(rulePackVersionId)
  return { ok: true, value: records.map(toMemberDto) }
}

export async function removeRulePackMember(memberId: string, actorUserId: string): Promise<RulePackResult<RulePackMemberDto>> {
  if (!isRulePackUuid(memberId)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule pack member id' }
  const target = await findRulePackMemberWithPack(memberId)
  if (!target) return { ok: false, code: 'NOT_FOUND', message: 'rule pack member not found' }

  const outcome = await withPackLock(target.rulePackVersion.rulePackId, 'rule_pack_member.remove', async (tx) => {
    const member = await findRulePackMemberById(memberId, tx)
    if (!member) return { kind: 'not_found' as const, message: 'rule pack member not found' }
    const version = await findRulePackVersionWithPack(member.rulePackVersionId, tx)
    if (!version || version.rulePack.organizationId === null)
      return { kind: 'not_found' as const, message: 'rule pack member not found' }
    if (!isDraft(version)) return { kind: 'invalid' as const, message: frozenSnapshotMessage }

    await deleteRulePackMemberRecord(memberId, tx)
    await recordAuditEvent(
      {
        organizationId: version.rulePack.organizationId,
        actorUserId,
        actionCode: 'rule_pack_member.removed',
        entityType: 'RULE_PACK_MEMBER',
        entityId: memberId,
        beforeState: rulePackMemberAuditSnapshot(member),
        afterState: null,
      },
      tx,
    )
    return { kind: 'ok' as const, value: member }
  })
  return toResult(outcome, toMemberDto)
}

// ---------------------------------------------------------------------------------------------
// Verification and activation
// ---------------------------------------------------------------------------------------------

export async function verifyRulePackVersion(id: string, actorUserId: string): Promise<RulePackResult<RulePackVersionDto>> {
  if (!isRulePackUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule pack version id' }
  const target = await findRulePackVersionById(id)
  if (!target) return { ok: false, code: 'NOT_FOUND', message: 'rule pack version not found' }

  const outcome = await withPackLock(target.rulePackId, 'rule_pack_version.verify', async (tx) => {
    const version = await findRulePackVersionWithPack(id, tx)
    if (!version || version.rulePack.organizationId === null)
      return { kind: 'not_found' as const, message: 'rule pack version not found' }

    // Every member RuleVersion row is locked too, in a fixed order, so a concurrent change to a
    // member's verification status either commits first (and is seen here) or waits for this
    // verification — the recheck is read-consistent, never trusted from the time of adding.
    const memberIds = (await findRulePackMembersByVersionId(id, tx)).map((member) => member.ruleVersionId).sort()
    for (const ruleVersionId of memberIds) await lockRowForUpdate(tx, 'rule_versions', ruleVersionId)
    const members = await findRulePackMembersForVerification(id, tx)

    const decision = decideVerification(
      version,
      version.rulePack,
      members.map((member) => ({
        ruleVersionId: member.ruleVersionId,
        verificationStatus: member.ruleVersion.verificationStatus,
        organizationId: member.ruleVersion.rule.organizationId,
        jurisdictionCode: member.ruleVersion.rule.jurisdictionCode,
      })),
    )
    if (decision.kind === 'rejected') return { kind: 'invalid' as const, message: decision.message }

    const record = await updateRulePackVersionRecord(id, { verificationStatus: 'VERIFIED', verifiedAt: new Date() }, tx)
    await recordAuditEvent(
      {
        organizationId: version.rulePack.organizationId,
        actorUserId,
        actionCode: 'rule_pack_version.verified',
        entityType: 'RULE_PACK_VERSION',
        entityId: id,
        beforeState: rulePackVersionAuditSnapshot(version),
        afterState: rulePackVersionAuditSnapshot(record),
      },
      tx,
    )
    return { kind: 'ok' as const, value: record }
  })
  return toResult(outcome, toVersionDto)
}

export async function activateRulePackVersion(
  id: string,
  businessDateInput: unknown,
  actorUserId: string,
): Promise<RulePackResult<RulePackVersionDto>> {
  if (!isRulePackUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid rule pack version id' }
  const businessDate = parseStrictDateOnly(businessDateInput)
  if (!businessDate) return { ok: false, code: 'VALIDATION_ERROR', message: 'businessDate must be a real YYYY-MM-DD date' }

  const target = await findRulePackVersionById(id)
  if (!target) return { ok: false, code: 'NOT_FOUND', message: 'rule pack version not found' }

  try {
    const outcome = await withPackLock(target.rulePackId, 'rule_pack_version.activate', async (tx) => {
      const version = await findRulePackVersionWithPack(id, tx)
      if (!version || version.rulePack.organizationId === null)
        return { kind: 'not_found' as const, message: 'rule pack version not found' }

      const decision = decideActivation(version, businessDate)
      if (decision.kind === 'rejected') return { kind: 'invalid' as const, message: decision.message }

      // The current version is whichever is ACTIVE — never chosen by version text or createdAt.
      // Read under the pack lock, so a competing activation has either committed or is waiting.
      const current = await findActiveRulePackVersion(version.rulePackId, id, tx)
      if (current) {
        const superseded = await updateRulePackVersionRecord(
          current.id,
          { activationStatus: 'SUPERSEDED', supersededAt: new Date() },
          tx,
        )
        await recordAuditEvent(
          {
            organizationId: version.rulePack.organizationId,
            actorUserId,
            actionCode: 'rule_pack_version.superseded',
            entityType: 'RULE_PACK_VERSION',
            entityId: current.id,
            beforeState: rulePackVersionAuditSnapshot(current),
            afterState: rulePackVersionAuditSnapshot(superseded),
          },
          tx,
        )
      }

      // Activation changes only this snapshot's own lifecycle fields: no RuleVersion, source
      // version, applicability, binding or A3.8 precedence data is touched, and the members of
      // both the new and the superseded version stay exactly as they were.
      const record = await updateRulePackVersionRecord(id, { activationStatus: 'ACTIVE', activatedAt: new Date() }, tx)
      await recordAuditEvent(
        {
          organizationId: version.rulePack.organizationId,
          actorUserId,
          actionCode: 'rule_pack_version.activated',
          entityType: 'RULE_PACK_VERSION',
          entityId: id,
          beforeState: rulePackVersionAuditSnapshot(version),
          afterState: rulePackVersionAuditSnapshot(record),
        },
        tx,
      )
      return { kind: 'ok' as const, value: record }
    })
    return toResult(outcome, toVersionDto)
  } catch (error) {
    // The one-ACTIVE partial unique index is the final race guard; if it ever fires, report a
    // sanitized conflict rather than a raw database error.
    if (isUniqueConstraintViolation(error))
      return { ok: false, code: 'VALIDATION_ERROR', message: 'another version of this rule pack was activated concurrently; please retry' }
    throw error
  }
}
