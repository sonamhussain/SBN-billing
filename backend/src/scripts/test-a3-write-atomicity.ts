import 'dotenv/config'
import { prisma } from '../shared/database/prisma.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../shared/testing/concurrency-probe.ts'
import { updateRuleVersionMetadata, updateRuleVersionVerification } from '../modules/rule-version/rule-version.service.ts'
import { createRuleApplicability } from '../modules/rule-applicability/rule-applicability.service.ts'
import { createRuleSourceBinding } from '../modules/rule-source-binding/rule-source-binding.service.ts'
import { updateSourceInterpretation } from '../modules/source-interpretation/source-interpretation.service.ts'
import {
  updateTariffScheduleVersionMetadata,
  updateTariffScheduleVersionVerification,
} from '../modules/commercial-coverage/tariff-schedule.service.ts'
import { activateRuleSourceVersion, updateLifecycleMetadata } from '../modules/rule-source-version/rule-source-version.service.ts'
import { updateOrganization } from '../modules/organization/organization.service.ts'
import { updateFacility } from '../modules/facility/facility.service.ts'
import { updateExternalIdentifier } from '../modules/external-identifier/external-identifier.service.ts'
import { APPLICABILITY_DIMENSIONS_V2, type ApplicabilityDimensionKeyV2 } from '../shared/rules/applicability-context-v2.ts'

// Audit F08 / C25-C27 — guarded writers must be atomic with the state they check. Each case pauses
// one real service call immediately after its read (deterministic probe), lets a competing call run,
// observes in PostgreSQL whether that competitor is blocked on the row lock, then releases. The
// invariants below must hold for whatever legal serial order results.

let passed = 0
let failed = 0

function check(label: string, condition: boolean, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${label} ${detail}`)
  }
}

function section(title: string) {
  console.log(`\n[a3-atomicity] ${title}`)
}

const tag = `A3WA-${Date.now()}`
const organizationId = process.env.AUTHZ_BOOTSTRAP_ORGANIZATION_ID
const userEmail = process.env.AUTHZ_BOOTSTRAP_USER_EMAIL

function d(text: string): Date {
  return new Date(`${text}T00:00:00.000Z`)
}

function barrier() {
  let open: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

async function waitUntilBlockedOrSettled(settled: Promise<unknown>, timeoutMs = 10_000): Promise<'blocked' | 'settled'> {
  let done = false
  settled.then(
    () => (done = true),
    () => (done = true),
  )
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (done) return 'settled'
    const rows = await prisma.$queryRaw<{ waiting: bigint }[]>`
      SELECT count(*) AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`
    if (Number(rows[0].waiting) > 0) return 'blocked'
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('neither blocked nor settled within the timeout')
}

// Pauses `first` at the named probe, starts `second`, waits until `second` is either blocked on a
// lock (protected) or finished (unprotected), then releases `first`. `afterSecond` runs as part of
// `second`, so in the unprotected case it completes BEFORE `first` is released.
async function race<A, B>(
  probe: string,
  first: () => Promise<A>,
  second: () => Promise<B>,
  afterSecond?: (result: B) => Promise<void>,
) {
  clearConcurrencyProbes()
  const holding = barrier()
  const release = barrier()
  setConcurrencyProbe(probe, async () => {
    holding.open()
    await release.promise
  })
  const firstRun = first()
  await holding.promise
  const secondRun = second().then(async (result) => {
    await afterSecond?.(result)
    return result
  })
  const state = await waitUntilBlockedOrSettled(secondRun)
  release.open()
  const [firstResult, secondResult] = await Promise.all([firstRun, secondRun])
  clearConcurrencyProbes()
  return { firstResult, secondResult, state }
}

function wildcard(): Record<ApplicabilityDimensionKeyV2, unknown> {
  const out = {} as Record<ApplicabilityDimensionKeyV2, unknown>
  for (const key of APPLICABILITY_DIMENSIONS_V2) out[key] = null
  return out
}

async function latestAudit(entityId: string, actionCode: string) {
  return prisma.auditEvent.findFirst({ where: { entityId, actionCode }, orderBy: { occurredAt: 'desc' } })
}

async function main() {
  if (!organizationId || !userEmail) throw new Error('AUTHZ_BOOTSTRAP_ORGANIZATION_ID and AUTHZ_BOOTSTRAP_USER_EMAIL are required')
  const org = organizationId
  const actor = (await prisma.user.findUniqueOrThrow({ where: { email: userEmail } })).id
  console.log(`[a3-atomicity] run tag ${tag} — organization ${org}`)

  const rule = await prisma.ruleDefinition.create({
    data: { organizationId: org, ruleKey: `${tag}-rule`, displayName: 'Atomicity rule', jurisdictionCode: 'AE-DU', ownershipScope: 'ORGANIZATION' },
  })
  let versionCounter = 0
  async function draftVersion() {
    versionCounter += 1
    return prisma.ruleVersion.create({
      data: { ruleId: rule.id, version: `v${versionCounter}`, effectType: 'CLAIM_EDIT_EFFECT', effectiveFrom: d('2020-01-01') },
    })
  }

  // ---- C25 -----------------------------------------------------------------------------------
  section('C25 RuleVersion metadata edit versus verification')
  {
    const version = await draftVersion()
    const { firstResult: edit, secondResult: verify, state } = await race(
      'rule_version.metadata',
      () => updateRuleVersionMetadata(version.id, 'PRICE_EFFECT', undefined, undefined, false, actor),
      () => updateRuleVersionVerification(version.id, 'VERIFIED', actor),
    )
    const stored = await prisma.ruleVersion.findUniqueOrThrow({ where: { id: version.id } })
    const verification = await latestAudit(version.id, 'rule_version.verification_updated')
    const verifiedSnapshot = verification?.afterState as { effectType?: string } | null
    check('C25a verification waited for the in-flight edit', state === 'blocked', `(observed: ${state})`)
    check('C25a both succeed in serial order (edit, then verify)', edit.ok && verify.ok, JSON.stringify({ edit, verify }))
    check(
      'C25a the VERIFIED snapshot is the final state (no post-verification change)',
      stored.verificationStatus === 'VERIFIED' && verifiedSnapshot?.effectType === stored.effectType,
      JSON.stringify({ verified: verifiedSnapshot?.effectType, final: stored.effectType }),
    )
  }
  {
    const version = await draftVersion()
    const auditBefore = await prisma.auditEvent.count()
    const { firstResult: verify, secondResult: edit, state } = await race(
      'rule_version.verification',
      () => updateRuleVersionVerification(version.id, 'VERIFIED', actor),
      () => updateRuleVersionMetadata(version.id, 'PRICE_EFFECT', undefined, undefined, false, actor),
    )
    const stored = await prisma.ruleVersion.findUniqueOrThrow({ where: { id: version.id } })
    check('C25b the edit waited for the in-flight verification', state === 'blocked', `(observed: ${state})`)
    check('C25b verification wins and the edit is rejected as frozen', verify.ok && !edit.ok, JSON.stringify({ verify, edit }))
    check('C25b the verified effectType is unchanged', stored.effectType === 'CLAIM_EDIT_EFFECT', stored.effectType)
    check('C25b only the verification wrote an AuditEvent', (await prisma.auditEvent.count()) === auditBefore + 1)
  }

  // ---- C26 -----------------------------------------------------------------------------------
  section('C26 applicability append versus verification')
  {
    const version = await draftVersion()
    let rowsWhenVerified = -1
    const { firstResult: append, secondResult: verify, state } = await race(
      'rule_applicability.create',
      () => createRuleApplicability(version.id, wildcard(), false, actor),
      () => updateRuleVersionVerification(version.id, 'VERIFIED', actor),
      async () => {
        rowsWhenVerified = await prisma.ruleApplicability.count({ where: { ruleVersionId: version.id } })
      },
    )
    const rowsFinal = await prisma.ruleApplicability.count({ where: { ruleVersionId: version.id } })
    check('C26a verification waited for the in-flight append', state === 'blocked', `(observed: ${state})`)
    check('C26a both succeed in serial order (append, then verify)', append.ok && verify.ok, JSON.stringify({ append, verify }))
    check('C26a no applicability row was appended after verification', rowsFinal === rowsWhenVerified, `(at verification ${rowsWhenVerified}, final ${rowsFinal})`)
  }
  {
    const version = await draftVersion()
    const auditBefore = await prisma.auditEvent.count()
    const { firstResult: verify, secondResult: append, state } = await race(
      'rule_version.verification',
      () => updateRuleVersionVerification(version.id, 'VERIFIED', actor),
      () => createRuleApplicability(version.id, wildcard(), false, actor),
    )
    const rows = await prisma.ruleApplicability.count({ where: { ruleVersionId: version.id } })
    check('C26b the append waited for the in-flight verification', state === 'blocked', `(observed: ${state})`)
    check('C26b the append is rejected after the freeze', verify.ok && !append.ok && rows === 0, JSON.stringify({ verify, append, rows }))
    check('C26b the rejected append wrote no success audit', (await prisma.auditEvent.count()) === auditBefore + 1)
  }

  section('RuleSourceBinding append versus rejection (same parent freeze)')
  {
    const source = await prisma.ruleSource.create({
      data: { organizationId: org, jurisdictionCode: 'AE-DU', issuingAuthority: 'Synthetic', sourceCategory: 'REGULATORY_AUTHORITY', referenceNumber: `${tag}-bind`, title: 'Binding source', ownershipScope: 'ORGANIZATION' },
    })
    const sourceVersion = await prisma.ruleSourceVersion.create({ data: { sourceId: source.id, version: '1', rawEvidenceRef: `synthetic-evidence://${tag}/bind` } })
    const interpretation = await prisma.sourceInterpretation.create({
      data: { sourceVersionId: sourceVersion.id, interpretationVersion: '1', normalizedInterpretationRef: 'synthetic://bind', verificationStatus: 'UNVERIFIED' },
    })
    const version = await draftVersion()
    let bindingsWhenRejected = -1
    const { firstResult: bind, secondResult: reject, state } = await race(
      'rule_source_binding.create',
      () => createRuleSourceBinding(version.id, interpretation.id, 'SUPPORTING', actor),
      () => updateRuleVersionVerification(version.id, 'REJECTED', actor),
      async () => {
        bindingsWhenRejected = await prisma.ruleSourceBinding.count({ where: { ruleVersionId: version.id } })
      },
    )
    const bindingsFinal = await prisma.ruleSourceBinding.count({ where: { ruleVersionId: version.id } })
    check('binding: rejection waited for the in-flight append', state === 'blocked', `(observed: ${state})`)
    check('binding: both succeed in serial order (bind, then reject)', bind.ok && reject.ok, JSON.stringify({ bind, reject }))
    check('binding: no binding was appended after REJECTED', bindingsFinal === bindingsWhenRejected, `(at rejection ${bindingsWhenRejected}, final ${bindingsFinal})`)
  }

  // ---- sibling guarded writers --------------------------------------------------------------
  section('Source interpretation edit versus verification')
  {
    const source = await prisma.ruleSource.create({
      data: { organizationId: org, jurisdictionCode: 'AE-DU', issuingAuthority: 'Synthetic', sourceCategory: 'REGULATORY_AUTHORITY', referenceNumber: `${tag}-interp`, title: 'Interpretation source', ownershipScope: 'ORGANIZATION' },
    })
    const sourceVersion = await prisma.ruleSourceVersion.create({ data: { sourceId: source.id, version: '1', rawEvidenceRef: `synthetic-evidence://${tag}/interp` } })
    const interpretation = await prisma.sourceInterpretation.create({
      data: { sourceVersionId: sourceVersion.id, interpretationVersion: '1', normalizedInterpretationRef: 'synthetic://original', verificationStatus: 'UNVERIFIED' },
    })
    const { firstResult: edit, secondResult: verify, state } = await race(
      'source_interpretation.update',
      () => updateSourceInterpretation(interpretation.id, 'synthetic://edited', undefined, false, actor),
      () => updateSourceInterpretation(interpretation.id, undefined, 'VERIFIED', false, actor),
    )
    const stored = await prisma.sourceInterpretation.findUniqueOrThrow({ where: { id: interpretation.id } })
    const audits = await prisma.auditEvent.findMany({ where: { entityId: interpretation.id, actionCode: 'source_interpretation.updated' } })
    const verifiedAudit = audits.find((audit) => (audit.afterState as { verificationStatus?: string }).verificationStatus === 'VERIFIED')
    check('interpretation: verification waited for the in-flight edit', state === 'blocked', `(observed: ${state})`)
    check('interpretation: both succeed in serial order', edit.ok && verify.ok, JSON.stringify({ edit, verify }))
    check(
      'interpretation: the VERIFIED snapshot is the final content',
      (verifiedAudit?.afterState as { normalizedInterpretationRef?: string } | undefined)?.normalizedInterpretationRef === stored.normalizedInterpretationRef &&
        stored.normalizedInterpretationRef === 'synthetic://edited',
      JSON.stringify({ verified: verifiedAudit?.afterState, final: stored.normalizedInterpretationRef }),
    )
    check(
      'interpretation: the verification audit records the edited predecessor',
      (verifiedAudit?.beforeState as { normalizedInterpretationRef?: string } | undefined)?.normalizedInterpretationRef === 'synthetic://edited',
      JSON.stringify(verifiedAudit?.beforeState),
    )
  }

  section('Tariff schedule version metadata versus verification')
  {
    const payer = await prisma.payer.create({ data: { organizationId: org, displayName: `${tag} payer` } })
    const contract = await prisma.providerContract.create({
      data: { organizationId: org, payerId: payer.id, contractKey: `${tag}-c`, displayName: 'Atomicity contract', effectiveFrom: d('2020-01-01') },
    })
    const schedule = await prisma.tariffSchedule.create({ data: { providerContractId: contract.id, tariffKey: `${tag}-t`, displayName: 'Atomicity schedule' } })
    const tariffVersion = await prisma.tariffScheduleVersion.create({
      data: { tariffScheduleId: schedule.id, version: '1', effectiveFrom: d('2026-01-01'), effectiveTo: d('2026-12-31') },
    })
    const { firstResult: edit, secondResult: verify, state } = await race(
      'tariff_schedule_version.metadata',
      () => updateTariffScheduleVersionMetadata(tariffVersion.id, undefined, '2026-11-30', actor),
      () => updateTariffScheduleVersionVerification(tariffVersion.id, 'VERIFIED', actor),
    )
    const stored = await prisma.tariffScheduleVersion.findUniqueOrThrow({ where: { id: tariffVersion.id } })
    const verification = await latestAudit(tariffVersion.id, 'tariff_schedule_version.verification_updated')
    check('tariff: verification waited for the in-flight edit', state === 'blocked', `(observed: ${state})`)
    check('tariff: both succeed in serial order', edit.ok && verify.ok, JSON.stringify({ edit, verify }))
    check(
      'tariff: the VERIFIED snapshot is the final period',
      (verification?.afterState as { effectiveTo?: string } | null)?.effectiveTo === stored.effectiveTo?.toISOString().slice(0, 10),
      JSON.stringify({ verified: verification?.afterState, final: stored.effectiveTo }),
    )
  }

  section('Source version lifecycle metadata versus activation')
  {
    const source = await prisma.ruleSource.create({
      data: { organizationId: org, jurisdictionCode: 'AE-DU', issuingAuthority: 'Synthetic', sourceCategory: 'REGULATORY_AUTHORITY', referenceNumber: `${tag}-life`, title: 'Lifecycle source', ownershipScope: 'ORGANIZATION' },
    })
    const sourceVersion = await prisma.ruleSourceVersion.create({
      data: {
        sourceId: source.id,
        version: '1',
        rawEvidenceRef: `synthetic-evidence://${tag}/life`,
        publicationStatus: 'PUBLISHED',
        publicationDate: d('2020-01-01'),
        effectiveFrom: d('2020-01-01'),
        effectiveTo: d('2030-12-31'),
        verificationStatus: 'VERIFIED',
        verifiedAt: new Date(),
      },
    })
    await prisma.sourceInterpretation.create({
      data: { sourceVersionId: sourceVersion.id, interpretationVersion: '1', normalizedInterpretationRef: 'synthetic://life', verificationStatus: 'VERIFIED', verifiedAt: new Date() },
    })
    const { firstResult: edit, secondResult: activate, state } = await race(
      'rule_source_version.metadata',
      () => updateLifecycleMetadata(sourceVersion.id, undefined, undefined, '2029-12-31', actor),
      () => activateRuleSourceVersion(sourceVersion.id, '2026-06-15', 'AE-DU', actor),
    )
    const stored = await prisma.ruleSourceVersion.findUniqueOrThrow({ where: { id: sourceVersion.id } })
    const activation = await latestAudit(sourceVersion.id, 'rule_source_version.activated')
    check('lifecycle: activation waited for the in-flight date edit', state === 'blocked', `(observed: ${state})`)
    check('lifecycle: both succeed in serial order', edit.ok && activate.ok && stored.activationStatus === 'ACTIVE', JSON.stringify({ edit, activate }))
    check(
      'lifecycle: the dates frozen at activation are the final dates',
      (activation?.afterState as { effectiveTo?: string } | null)?.effectiveTo === stored.effectiveTo?.toISOString().slice(0, 10),
      JSON.stringify({ activated: activation?.afterState, final: stored.effectiveTo }),
    )
  }

  // ---- C27 -----------------------------------------------------------------------------------
  section('C27 concurrent ordinary master edits keep a truthful audit chain')

  type Named = { name?: string; externalValue?: string }
  async function auditChain(entityId: string, actionCode: string, field: 'name' | 'externalValue', firstValue: string, secondValue: string) {
    const audits = await prisma.auditEvent.findMany({ where: { entityId, actionCode } })
    const first = audits.find((audit) => (audit.afterState as Named)[field] === firstValue)
    const second = audits.find((audit) => (audit.afterState as Named)[field] === secondValue)
    return { first, second }
  }

  {
    const organization = await prisma.organization.create({ data: { name: `${tag} Org original` } })
    const { firstResult: a, secondResult: b, state } = await race(
      'organization.update',
      () => updateOrganization(organization.id, `${tag} Org first`, actor),
      () => updateOrganization(organization.id, `${tag} Org second`, actor),
    )
    const { first, second } = await auditChain(organization.id, 'organization.updated', 'name', `${tag} Org first`, `${tag} Org second`)
    const stored = await prisma.organization.findUniqueOrThrow({ where: { id: organization.id } })
    check('C27 organization: second edit waited for the first', state === 'blocked', `(observed: ${state})`)
    check('C27 organization: both edits succeed', a.ok && b.ok)
    check(
      "C27 organization: the second audit's beforeState is the first edit's result",
      (second?.beforeState as Named | null)?.name === `${tag} Org first` && (first?.beforeState as Named | null)?.name === `${tag} Org original`,
      JSON.stringify({ firstBefore: first?.beforeState, secondBefore: second?.beforeState }),
    )
    check('C27 organization: final row is the last audited value', stored.name === `${tag} Org second`)
  }
  {
    const facility = await prisma.facility.create({ data: { organizationId: org, name: `${tag} Facility original` } })
    const { firstResult: a, secondResult: b, state } = await race(
      'facility.update',
      () => updateFacility(facility.id, `${tag} Facility first`, actor),
      () => updateFacility(facility.id, `${tag} Facility second`, actor),
    )
    const { first, second } = await auditChain(facility.id, 'facility.updated', 'name', `${tag} Facility first`, `${tag} Facility second`)
    check('C27 facility: second edit waited for the first', state === 'blocked', `(observed: ${state})`)
    check('C27 facility: both edits succeed', a.ok && b.ok)
    check(
      "C27 facility: the second audit's beforeState is the first edit's result",
      (second?.beforeState as Named | null)?.name === `${tag} Facility first` && (first?.beforeState as Named | null)?.name === `${tag} Facility original`,
      JSON.stringify({ firstBefore: first?.beforeState, secondBefore: second?.beforeState }),
    )
  }
  {
    const payer = await prisma.payer.create({ data: { organizationId: org, displayName: `${tag} ext payer` } })
    const identifier = await prisma.externalIdentifier.create({
      data: { organizationId: org, sourceSystem: `${tag}-sys`, externalValue: 'original', payerId: payer.id },
    })
    const { firstResult: a, secondResult: b, state } = await race(
      'external_identifier.update',
      () => updateExternalIdentifier(identifier.id, undefined, 'first', undefined, undefined, undefined, actor),
      () => updateExternalIdentifier(identifier.id, undefined, 'second', undefined, undefined, undefined, actor),
    )
    const { first, second } = await auditChain(identifier.id, 'external_identifier.updated', 'externalValue', 'first', 'second')
    check('C27 external identifier: second edit waited for the first', state === 'blocked', `(observed: ${state})`)
    check('C27 external identifier: both edits succeed', a.ok && b.ok)
    check(
      "C27 external identifier: the second audit's beforeState is the first edit's result",
      (second?.beforeState as Named | null)?.externalValue === 'first' && (first?.beforeState as Named | null)?.externalValue === 'original',
      JSON.stringify({ firstBefore: first?.beforeState, secondBefore: second?.beforeState }),
    )
  }

  console.log(`\n[a3-atomicity] ${passed} passed, ${failed} failed`)
  console.log(failed === 0 ? '[a3-atomicity] ALL CHECKS PASS' : '[a3-atomicity] CHECKS FAILED')
  process.exitCode = failed === 0 ? 0 : 1
}

main()
  .catch((error) => {
    console.error('[a3-atomicity] uncaught error (this itself is a FAIL):', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
