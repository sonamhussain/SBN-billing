import 'dotenv/config'
import { prisma } from '../shared/database/prisma.ts'
import {
  activateRuleSourceVersion,
  evaluateRuleSourceVersionActivation,
  resumeRuleSourceVersion,
  updateLifecycleMetadata,
} from '../modules/rule-source-version/rule-source-version.service.ts'
import { createRuleVersion, updateRuleVersionMetadata } from '../modules/rule-version/rule-version.service.ts'
import {
  createFacilityRegulatoryProfile,
  updateFacilityRegulatoryProfile,
} from '../modules/facility-regulatory/facility-regulatory.service.ts'
import { createTariffScheduleVersion, updateTariffScheduleVersionMetadata } from '../modules/commercial-coverage/tariff-schedule.service.ts'
import { createProviderContract } from '../modules/commercial-coverage/provider-contract.service.ts'
import { importReferenceDatasetVersion } from '../modules/reference-dataset/reference-dataset.maintenance.ts'
import { evaluateExecutability } from '../modules/rule-source-binding/rule-source-binding.service.ts'
import { APPLICABILITY_DIMENSIONS_V2, type ApplicabilityDimensionKeyV2 } from '../shared/rules/applicability-context-v2.ts'

// Audit F07 / C08 / C24 — proves the strict date boundary at the REAL service entry points that
// consume it (A3.3, RuleVersion, facility regulatory profile, provider contract, tariff version,
// dataset maintenance, A3.7), not only in the shared helper. Every rejected call is checked for
// zero row changes and zero AuditEvents.

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
  console.log(`\n[a3-strict-dates] ${title}`)
}

function d(text: string): Date {
  return new Date(`${text}T00:00:00.000Z`)
}

function day(value: Date | null | undefined): string | null {
  return value ? value.toISOString().slice(0, 10) : null
}

const IMPOSSIBLE = ['2026-02-31', '2026-02-29', '2026-04-31', '2100-02-29'] as const
const tag = `A3SD-${Date.now()}`
const organizationId = process.env.AUTHZ_BOOTSTRAP_ORGANIZATION_ID
const userEmail = process.env.AUTHZ_BOOTSTRAP_USER_EMAIL

type Outcome = { ok: boolean; code?: string; message?: string }

// Runs a call that must be rejected and proves it changed nothing: the watched row count and the
// AuditEvent count are identical before and after.
async function expectRejected(label: string, call: () => Promise<Outcome>, rowCount: () => Promise<number>) {
  const rowsBefore = await rowCount()
  const auditBefore = await prisma.auditEvent.count()
  const result = await call()
  const rowsAfter = await rowCount()
  const auditAfter = await prisma.auditEvent.count()
  const rejected = !result.ok && (result.code === undefined || result.code === 'VALIDATION_ERROR')
  check(
    `${label}: rejected`,
    rejected,
    `(got ok=${result.ok} code=${result.code ?? '-'} message=${result.message ?? '-'})`,
  )
  check(`${label}: no row written`, rowsAfter === rowsBefore, `(before ${rowsBefore}, after ${rowsAfter})`)
  check(`${label}: no AuditEvent written`, auditAfter === auditBefore, `(before ${auditBefore}, after ${auditAfter})`)
}

function emptyContext(): Record<ApplicabilityDimensionKeyV2, unknown> {
  const context = {} as Record<ApplicabilityDimensionKeyV2, unknown>
  for (const key of APPLICABILITY_DIMENSIONS_V2) context[key] = null
  return context
}

async function main() {
  if (!organizationId || !userEmail) throw new Error('AUTHZ_BOOTSTRAP_ORGANIZATION_ID and AUTHZ_BOOTSTRAP_USER_EMAIL are required')
  const org = organizationId
  const actor = (await prisma.user.findUniqueOrThrow({ where: { email: userEmail } })).id
  console.log(`[a3-strict-dates] run tag ${tag} — organization ${org}`)

  // ---- A3.3 source version -----------------------------------------------------------------
  section('A3.3 source version lifecycle and evaluation')
  const source = await prisma.ruleSource.create({
    data: {
      organizationId: org,
      jurisdictionCode: 'AE-DU',
      issuingAuthority: 'Synthetic Authority',
      sourceCategory: 'REGULATORY_AUTHORITY',
      referenceNumber: `${tag}-src`,
      title: 'Strict date source',
      ownershipScope: 'ORGANIZATION',
    },
  })
  const sourceVersion = await prisma.ruleSourceVersion.create({
    data: { sourceId: source.id, version: '1', rawEvidenceRef: `synthetic-evidence://${tag}/src` },
  })
  const sourceVersionSnapshot = async () => {
    const row = await prisma.ruleSourceVersion.findUniqueOrThrow({ where: { id: sourceVersion.id } })
    return `${day(row.publicationDate)}|${day(row.effectiveFrom)}|${day(row.effectiveTo)}|${row.activationStatus}|${row.updatedAt.getTime()}`
  }
  const sourceVersionCount = () => prisma.ruleSourceVersion.count()

  for (const bad of IMPOSSIBLE) {
    const before = await sourceVersionSnapshot()
    await expectRejected(`A3.3 metadata effectiveFrom=${bad}`, () => updateLifecycleMetadata(sourceVersion.id, undefined, bad, undefined, actor), sourceVersionCount)
    check(`A3.3 metadata effectiveFrom=${bad}: stored row unchanged`, (await sourceVersionSnapshot()) === before)
  }
  await expectRejected('A3.3 metadata publicationDate=2026-02-31', () => updateLifecycleMetadata(sourceVersion.id, '2026-02-31', undefined, undefined, actor), sourceVersionCount)
  await expectRejected('A3.3 metadata effectiveTo=2026-04-31', () => updateLifecycleMetadata(sourceVersion.id, undefined, undefined, '2026-04-31', actor), sourceVersionCount)

  const accepted = await updateLifecycleMetadata(sourceVersion.id, undefined, '2024-02-29', '2026-12-31', actor)
  check('A3.3 metadata real leap day 2024-02-29 is accepted exactly', accepted.ok && accepted.value.effectiveFrom === '2024-02-29', JSON.stringify(accepted))

  const evalResult = await evaluateRuleSourceVersionActivation(sourceVersion.id, '2026-02-31', 'AE-DU')
  check('A3.3 activation evaluate businessDate=2026-02-31 is rejected', !evalResult.ok && evalResult.code === 'VALIDATION_ERROR', JSON.stringify(evalResult))
  const beforeActivate = await sourceVersionSnapshot()
  await expectRejected('A3.3 activate businessDate=2026-02-31', () => activateRuleSourceVersion(sourceVersion.id, '2026-02-31', 'AE-DU', actor), sourceVersionCount)
  check('A3.3 activate businessDate=2026-02-31: activation status unchanged', (await sourceVersionSnapshot()) === beforeActivate)
  await expectRejected('A3.3 resume businessDate=2026-02-31', () => resumeRuleSourceVersion(sourceVersion.id, '2026-02-31', 'AE-DU', actor), sourceVersionCount)

  // ---- RuleVersion -------------------------------------------------------------------------
  section('RuleVersion create / metadata update, and null versus absent')
  const rule = await prisma.ruleDefinition.create({
    data: { organizationId: org, ruleKey: `${tag}-rule`, displayName: 'Strict date rule', jurisdictionCode: 'AE-DU', ownershipScope: 'ORGANIZATION' },
  })
  const ruleVersionCount = () => prisma.ruleVersion.count()
  for (const bad of IMPOSSIBLE) {
    await expectRejected(`RuleVersion create effectiveFrom=${bad}`, () => createRuleVersion(rule.id, `bad-${bad}`, 'AUTHORIZATION_REQUIREMENT_EFFECT', bad, null, actor), ruleVersionCount)
  }
  await expectRejected('RuleVersion create effectiveTo=2026-04-31', () => createRuleVersion(rule.id, 'bad-to', 'AUTHORIZATION_REQUIREMENT_EFFECT', '2026-01-01', '2026-04-31', actor), ruleVersionCount)

  const created = await createRuleVersion(rule.id, '1', 'AUTHORIZATION_REQUIREMENT_EFFECT', '2024-02-29', '2026-12-31', actor)
  check('RuleVersion create with real leap day succeeds', created.ok && created.value.effectiveFrom === '2024-02-29', JSON.stringify(created))
  if (!created.ok) throw new Error('cannot continue without a RuleVersion')
  const ruleVersionId = created.value.id

  await expectRejected('RuleVersion update effectiveTo=2026-02-31', () => updateRuleVersionMetadata(ruleVersionId, undefined, undefined, '2026-02-31', false, actor), ruleVersionCount)
  const afterBadUpdate = await prisma.ruleVersion.findUniqueOrThrow({ where: { id: ruleVersionId } })
  check('RuleVersion update rejected: stored effectiveTo still 2026-12-31', day(afterBadUpdate.effectiveTo) === '2026-12-31')

  const absentUpdate = await updateRuleVersionMetadata(ruleVersionId, 'CLAIM_EDIT_EFFECT', undefined, undefined, false, actor)
  check('RuleVersion PATCH with effectiveTo absent leaves it unchanged', absentUpdate.ok && absentUpdate.value.effectiveTo === '2026-12-31', JSON.stringify(absentUpdate))
  const nullUpdate = await updateRuleVersionMetadata(ruleVersionId, undefined, undefined, null, false, actor)
  check('RuleVersion PATCH with effectiveTo null clears it', nullUpdate.ok && nullUpdate.value.effectiveTo === null, JSON.stringify(nullUpdate))

  // ---- Facility regulatory profile ---------------------------------------------------------
  section('Facility regulatory profile create / update')
  const facility = await prisma.facility.create({ data: { organizationId: org, name: `${tag} Facility` } })
  const profileCount = () => prisma.facilityRegulatoryProfile.count()
  for (const bad of IMPOSSIBLE) {
    await expectRejected(`Facility profile create effectiveFrom=${bad}`, () => createFacilityRegulatoryProfile(facility.id, 'AE-DU', 'DHA', bad, null, actor), profileCount)
  }
  await expectRejected('Facility profile create effectiveTo=2026-02-31', () => createFacilityRegulatoryProfile(facility.id, 'AE-DU', 'DHA', '2026-01-01', '2026-02-31', actor), profileCount)
  const profile = await createFacilityRegulatoryProfile(facility.id, 'AE-DU', 'DHA', '2024-02-29', null, actor)
  check('Facility profile create with real leap day succeeds', profile.ok && profile.value.effectiveFrom === '2024-02-29', JSON.stringify(profile))
  if (profile.ok) {
    await expectRejected('Facility profile update (INACTIVE) effectiveFrom=2026-04-31', () => updateFacilityRegulatoryProfile(profile.value.id, undefined, undefined, '2026-04-31', undefined, actor), profileCount)
    const stored = await prisma.facilityRegulatoryProfile.findUniqueOrThrow({ where: { id: profile.value.id } })
    check('Facility profile update rejected: stored effectiveFrom still 2024-02-29', day(stored.effectiveFrom) === '2024-02-29')
  }

  // ---- Provider contract + tariff version --------------------------------------------------
  section('Provider contract and tariff schedule version')
  const payer = await prisma.payer.create({ data: { organizationId: org, displayName: `${tag} Payer` } })
  const contractCount = () => prisma.providerContract.count()
  await expectRejected('Provider contract create effectiveFrom=2026-02-31', () => createProviderContract(org, `${tag}-c-bad1`, 'Bad contract', payer.id, null, null, null, '2026-02-31', null, actor), contractCount)
  await expectRejected('Provider contract create effectiveTo=2100-02-29', () => createProviderContract(org, `${tag}-c-bad2`, 'Bad contract', payer.id, null, null, null, '2026-01-01', '2100-02-29', actor), contractCount)
  const contract = await createProviderContract(org, `${tag}-c`, 'Strict date contract', payer.id, null, null, null, '2024-02-29', null, actor)
  check('Provider contract create with real leap day succeeds', contract.ok && contract.value.effectiveFrom === '2024-02-29', JSON.stringify(contract))

  if (contract.ok) {
    const schedule = await prisma.tariffSchedule.create({
      data: { providerContractId: contract.value.id, tariffKey: `${tag}-t`, displayName: 'Strict date schedule' },
    })
    const tariffVersionCount = () => prisma.tariffScheduleVersion.count()
    await expectRejected('Tariff version create effectiveFrom=2026-02-31', () => createTariffScheduleVersion(schedule.id, 'bad', '2026-02-31', null, actor), tariffVersionCount)
    await expectRejected('Tariff version create effectiveTo=2026-06-31', () => createTariffScheduleVersion(schedule.id, 'bad2', '2026-01-01', '2026-06-31', actor), tariffVersionCount)
    const tariffVersion = await createTariffScheduleVersion(schedule.id, '1', '2026-01-01', '2026-12-31', actor)
    check('Tariff version create with valid dates succeeds', tariffVersion.ok, JSON.stringify(tariffVersion))
    if (tariffVersion.ok) {
      await expectRejected('Tariff version update effectiveTo=2026-11-31', () => updateTariffScheduleVersionMetadata(tariffVersion.value.id, undefined, '2026-11-31', actor), tariffVersionCount)
      const stored = await prisma.tariffScheduleVersion.findUniqueOrThrow({ where: { id: tariffVersion.value.id } })
      check('Tariff version update rejected: stored effectiveTo still 2026-12-31', day(stored.effectiveTo) === '2026-12-31')
    }
  }

  // ---- Dataset maintenance (C24) -----------------------------------------------------------
  section('Reference dataset version import (C24)')
  const dataset = await prisma.referenceDataset.create({
    data: { datasetKey: `${tag}-ds`, displayName: 'Strict date dataset', jurisdictionCode: 'AE-DU', authorityCode: 'DHA' },
  })
  const datasetVersionCount = () => prisma.referenceDatasetVersion.count()
  const base = { datasetId: dataset.id, contentHash: 'sha256:synthetic', retrievedAt: '2026-09-17T10:00:00Z' }
  await expectRejected('Dataset import publicationDate=2026-02-31', () => importReferenceDatasetVersion({ ...base, version: 'p', publicationDate: '2026-02-31' }), datasetVersionCount)
  await expectRejected('Dataset import effectiveFrom=2026-02-29', () => importReferenceDatasetVersion({ ...base, version: 'f', effectiveFrom: '2026-02-29' }), datasetVersionCount)
  await expectRejected('Dataset import effectiveTo=2026-04-31', () => importReferenceDatasetVersion({ ...base, version: 't', effectiveTo: '2026-04-31' }), datasetVersionCount)
  await expectRejected('Dataset import effectiveFrom="not-a-date"', () => importReferenceDatasetVersion({ ...base, version: 'n', effectiveFrom: 'not-a-date' }), datasetVersionCount)
  await expectRejected('Dataset import retrievedAt="2026"', () => importReferenceDatasetVersion({ ...base, version: 'r1', retrievedAt: '2026' }), datasetVersionCount)
  await expectRejected('Dataset import retrievedAt="2026-02-31T00:00:00Z"', () => importReferenceDatasetVersion({ ...base, version: 'r2', retrievedAt: '2026-02-31T00:00:00Z' }), datasetVersionCount)
  await expectRejected('Dataset import retrievedAt without timezone', () => importReferenceDatasetVersion({ ...base, version: 'r3', retrievedAt: '2026-09-17T10:00:00' }), datasetVersionCount)

  const undated = await importReferenceDatasetVersion({ ...base, version: 'undated' })
  check('Dataset import with absent dates still supported (undated draft)', undated.ok, JSON.stringify(undated))
  const nulled = await importReferenceDatasetVersion({ ...base, version: 'nulled', publicationDate: null, effectiveFrom: null, effectiveTo: null })
  check('Dataset import with explicit null dates still supported', nulled.ok, JSON.stringify(nulled))
  const dated = await importReferenceDatasetVersion({ ...base, version: 'dated', publicationDate: '2024-02-29', effectiveFrom: '2024-03-01', effectiveTo: '2026-12-31' })
  check('Dataset import with real dates succeeds', dated.ok, JSON.stringify(dated))
  if (dated.ok) {
    const stored = await prisma.referenceDatasetVersion.findUniqueOrThrow({ where: { id: dated.value.id } })
    check('Dataset import stored dates exactly as supplied', day(stored.publicationDate) === '2024-02-29' && day(stored.effectiveFrom) === '2024-03-01' && day(stored.effectiveTo) === '2026-12-31')
  }

  // ---- A3.7 consumer + C08 inclusive boundaries --------------------------------------------
  section('A3.7 executability evaluate and C08 boundaries')
  const gateRule = await prisma.ruleDefinition.create({
    data: { organizationId: org, ruleKey: `${tag}-gate`, displayName: 'Strict date gate rule', jurisdictionCode: 'AE-DU', ownershipScope: 'ORGANIZATION' },
  })
  const gateVersion = await prisma.ruleVersion.create({
    data: { ruleId: gateRule.id, version: '1', effectType: 'AUTHORIZATION_REQUIREMENT_EFFECT', effectiveFrom: d('2020-01-01'), verificationStatus: 'VERIFIED', verifiedAt: new Date() },
  })
  await prisma.ruleApplicability.create({ data: { ruleVersionId: gateVersion.id } })
  const gateSource = await prisma.ruleSource.create({
    data: { organizationId: org, jurisdictionCode: 'AE-DU', issuingAuthority: 'Synthetic Authority', sourceCategory: 'REGULATORY_AUTHORITY', referenceNumber: `${tag}-gate-src`, title: 'Gate source', ownershipScope: 'ORGANIZATION' },
  })
  const gateSourceVersion = await prisma.ruleSourceVersion.create({
    data: {
      sourceId: gateSource.id,
      version: '1',
      rawEvidenceRef: `synthetic-evidence://${tag}/gate`,
      publicationStatus: 'PUBLISHED',
      publicationDate: d('2024-01-01'),
      effectiveFrom: d('2024-02-29'),
      effectiveTo: d('2026-06-30'),
      verificationStatus: 'VERIFIED',
      verifiedAt: new Date(),
      activationStatus: 'ACTIVE',
      activatedAt: new Date(),
      // Audit F09: an ACTIVE row must carry the durable ever-activated fact.
      everActivated: true,
      firstActivatedAt: new Date(),
    },
  })
  const interpretation = await prisma.sourceInterpretation.create({
    data: { sourceVersionId: gateSourceVersion.id, interpretationVersion: '1', normalizedInterpretationRef: `synthetic-interpretation://${tag}/gate`, verificationStatus: 'VERIFIED', verifiedAt: new Date() },
  })
  await prisma.ruleSourceBinding.create({ data: { ruleVersionId: gateVersion.id, sourceInterpretationId: interpretation.id, sourceRole: 'GOVERNING' } })

  for (const bad of IMPOSSIBLE) {
    const result = await evaluateExecutability(gateVersion.id, bad, emptyContext())
    check(`A3.7 evaluate businessDate=${bad} is rejected`, !result.ok && result.code === 'VALIDATION_ERROR', JSON.stringify(result))
  }

  async function gateOn(date: string) {
    const result = await evaluateExecutability(gateVersion.id, date, emptyContext())
    if (!result.ok) throw new Error(`unexpected ${result.code}`)
    return result.value
  }
  const leapStart = await gateOn('2024-02-29')
  check('C08 leap-day start 2024-02-29 is inside the window', leapStart.gateStatus === 'POTENTIALLY_ALLOWED', leapStart.blockers.join(','))
  const beforeStart = await gateOn('2024-02-28')
  check('C08 the day before the start is outside', beforeStart.gateStatus === 'BLOCKED' && beforeStart.blockers.includes('SOURCE_NOT_EFFECTIVE'))
  const endDay = await gateOn('2026-06-30')
  check('C08 the inclusive end day 2026-06-30 is inside', endDay.gateStatus === 'POTENTIALLY_ALLOWED', endDay.blockers.join(','))
  const nextDay = await gateOn('2026-07-01')
  check('C08 the next day 2026-07-01 is outside', nextDay.gateStatus === 'BLOCKED' && nextDay.blockers.includes('SOURCE_NOT_EFFECTIVE') && nextDay.nextGate === null)

  console.log(`\n[a3-strict-dates] ${passed} passed, ${failed} failed`)
  console.log(failed === 0 ? '[a3-strict-dates] ALL CHECKS PASS' : '[a3-strict-dates] CHECKS FAILED')
  process.exitCode = failed === 0 ? 0 : 1
}

main()
  .catch((error) => {
    console.error('[a3-strict-dates] uncaught error (this itself is a FAIL):', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
