import 'dotenv/config'
import { prisma } from '../shared/database/prisma.ts'
import { validateApplicabilityContextCoherence } from '../modules/rule-applicability/rule-applicability.context-coherence.ts'
import { createRuleApplicability, evaluateRuleApplicability } from '../modules/rule-applicability/rule-applicability.service.ts'
import { createRuleSourceScope } from '../modules/rule-source-scope/rule-source-scope.service.ts'
import { evaluateExecutability } from '../modules/rule-source-binding/rule-source-binding.service.ts'
import { APPLICABILITY_DIMENSIONS_V2, type ApplicabilityContextV2, type ApplicabilityDimensionKeyV2 } from '../shared/rules/applicability-context-v2.ts'
import { scopeDimensionKeys, type ScopeDimensionKey } from '../modules/rule-source-scope/rule-source-scope.validation.ts'

// Audit F06 / C21-C23 — context coherence must follow the ACTUAL ancestry of every supplied child
// (tariff version -> schedule -> contract -> payer/TPA/network/product/facility), even when the
// intermediate IDs are omitted, and must never fill in context fields. Proven through every real
// consumer of the shared validator: A3.6 create + evaluate, RuleSourceScope create, A3.7 evaluate.

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
  console.log(`\n[a3-coherence] ${title}`)
}

const tag = `A3CO-${Date.now()}`
const organizationId = process.env.AUTHZ_BOOTSTRAP_ORGANIZATION_ID
const userEmail = process.env.AUTHZ_BOOTSTRAP_USER_EMAIL

function d(text: string): Date {
  return new Date(`${text}T00:00:00.000Z`)
}

type Partial12 = Partial<Record<ApplicabilityDimensionKeyV2, string>>

function dims12(partial: Partial12): Record<ApplicabilityDimensionKeyV2, unknown> {
  const out = {} as Record<ApplicabilityDimensionKeyV2, unknown>
  for (const key of APPLICABILITY_DIMENSIONS_V2) out[key] = partial[key]
  return out
}

function dims8(partial: Partial12): Record<ScopeDimensionKey, unknown> {
  const out = {} as Record<ScopeDimensionKey, unknown>
  for (const key of scopeDimensionKeys) out[key] = partial[key]
  return out
}

async function main() {
  if (!organizationId || !userEmail) throw new Error('AUTHZ_BOOTSTRAP_ORGANIZATION_ID and AUTHZ_BOOTSTRAP_USER_EMAIL are required')
  const org = organizationId
  const actor = (await prisma.user.findUniqueOrThrow({ where: { email: userEmail } })).id
  console.log(`[a3-coherence] run tag ${tag} — organization ${org}`)

  // ---- commercial hierarchy fixtures -------------------------------------------------------
  //   C1 (payer P1, tpa T1, network N1, product PR1) — facility F1, schedule S1 — version V1
  //   C2 (payer P2, no tpa/network/product)          — facility F2, schedule S2 — version V2
  const P1 = await prisma.payer.create({ data: { organizationId: org, displayName: `${tag} P1` } })
  const P2 = await prisma.payer.create({ data: { organizationId: org, displayName: `${tag} P2` } })
  const T1 = await prisma.tpa.create({ data: { organizationId: org, displayName: `${tag} T1` } })
  const T2 = await prisma.tpa.create({ data: { organizationId: org, displayName: `${tag} T2` } })
  const N1 = await prisma.network.create({ data: { organizationId: org, displayName: `${tag} N1` } })
  const N2 = await prisma.network.create({ data: { organizationId: org, displayName: `${tag} N2` } })
  const PR1 = await prisma.insuranceProduct.create({ data: { organizationId: org, payerId: P1.id, productCode: `${tag}-PR1`, displayName: 'PR1' } })
  const PR2 = await prisma.insuranceProduct.create({ data: { organizationId: org, payerId: P2.id, productCode: `${tag}-PR2`, displayName: 'PR2' } })
  await prisma.productNetwork.create({ data: { insuranceProductId: PR1.id, networkId: N1.id } })
  const C1 = await prisma.providerContract.create({
    data: { organizationId: org, payerId: P1.id, tpaId: T1.id, networkId: N1.id, insuranceProductId: PR1.id, contractKey: `${tag}-C1`, displayName: 'C1', effectiveFrom: d('2020-01-01') },
  })
  const C2 = await prisma.providerContract.create({
    data: { organizationId: org, payerId: P2.id, contractKey: `${tag}-C2`, displayName: 'C2', effectiveFrom: d('2020-01-01') },
  })
  const F1 = await prisma.facility.create({ data: { organizationId: org, name: `${tag} F1` } })
  const F2 = await prisma.facility.create({ data: { organizationId: org, name: `${tag} F2` } })
  await prisma.contractFacility.create({ data: { providerContractId: C1.id, facilityId: F1.id } })
  await prisma.contractFacility.create({ data: { providerContractId: C2.id, facilityId: F2.id } })
  const S1 = await prisma.tariffSchedule.create({ data: { providerContractId: C1.id, tariffKey: `${tag}-S1`, displayName: 'S1' } })
  const S2 = await prisma.tariffSchedule.create({ data: { providerContractId: C2.id, tariffKey: `${tag}-S2`, displayName: 'S2' } })
  const V1 = await prisma.tariffScheduleVersion.create({ data: { tariffScheduleId: S1.id, version: '1' } })
  const V2 = await prisma.tariffScheduleVersion.create({ data: { tariffScheduleId: S2.id, version: '1' } })
  const PF1 = await prisma.facilityRegulatoryProfile.create({ data: { facilityId: F1.id, jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom: d('2020-01-01'), status: 'INACTIVE' } })
  const PF2 = await prisma.facilityRegulatoryProfile.create({ data: { facilityId: F2.id, jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom: d('2020-01-01'), status: 'INACTIVE' } })

  // ---- consumers ---------------------------------------------------------------------------
  const rule = await prisma.ruleDefinition.create({
    data: { organizationId: org, ruleKey: `${tag}-rule`, displayName: 'Coherence rule', jurisdictionCode: 'AE-DU', ownershipScope: 'ORGANIZATION' },
  })
  const draftVersion = await prisma.ruleVersion.create({
    data: { ruleId: rule.id, version: 'draft', effectType: 'PRICE_EFFECT', effectiveFrom: d('2020-01-01') },
  })
  const rowByVersion = await prisma.ruleApplicability.create({ data: { ruleVersionId: draftVersion.id, tariffScheduleVersionId: V1.id } })
  const rowByContract = await prisma.ruleApplicability.create({ data: { ruleVersionId: draftVersion.id, providerContractId: C1.id } })
  const source = await prisma.ruleSource.create({
    data: { organizationId: org, jurisdictionCode: 'AE-DU', issuingAuthority: 'Synthetic', sourceCategory: 'PROVIDER_CONTRACT', referenceNumber: `${tag}-src`, title: 'Coherence source', ownershipScope: 'ORGANIZATION' },
  })

  // scopeable: the context uses only RuleSourceScope's eight dimensions.
  // clientProfile: the context carries a client-supplied facilityRegulatoryProfileId, which A3.7
  // discards and re-derives server-side (REF-01 §10), so A3.7 is not a consumer of that case.
  type Case = { label: string; context: Partial12; scopeable: boolean; clientProfile?: boolean }

  async function expectIncoherent(entry: Case) {
    const direct = await validateApplicabilityContextCoherence(entry.context as ApplicabilityContextV2, org, prisma)
    check(`${entry.label}: shared validator rejects (VALIDATION_ERROR)`, !direct.ok && direct.code === 'VALIDATION_ERROR', JSON.stringify(direct))

    const evaluated = await evaluateRuleApplicability(draftVersion.id, dims12(entry.context))
    check(`${entry.label}: A3.6 evaluate rejects`, !evaluated.ok && evaluated.code === 'VALIDATION_ERROR', JSON.stringify(evaluated))

    const rowsBefore = await prisma.ruleApplicability.count()
    const auditBefore = await prisma.auditEvent.count()
    const created = await createRuleApplicability(draftVersion.id, dims12(entry.context), false, actor)
    check(
      `${entry.label}: A3.6 create rejects with no row and no audit`,
      !created.ok && created.code === 'VALIDATION_ERROR' && (await prisma.ruleApplicability.count()) === rowsBefore && (await prisma.auditEvent.count()) === auditBefore,
      JSON.stringify(created),
    )

    if (entry.scopeable) {
      const scopesBefore = await prisma.ruleSourceScope.count()
      const auditBeforeScope = await prisma.auditEvent.count()
      const scoped = await createRuleSourceScope(source.id, dims8(entry.context), actor)
      check(
        `${entry.label}: RuleSourceScope create rejects with no row and no audit`,
        !scoped.ok && scoped.code === 'VALIDATION_ERROR' && (await prisma.ruleSourceScope.count()) === scopesBefore && (await prisma.auditEvent.count()) === auditBeforeScope,
        JSON.stringify(scoped),
      )
    }

    if (entry.clientProfile) return
    const gate = await evaluateExecutability(draftVersion.id, '2026-06-15', dims12(entry.context))
    check(`${entry.label}: A3.7 evaluate rejects`, !gate.ok && gate.code === 'VALIDATION_ERROR', JSON.stringify(gate))
  }

  async function expectCoherent(entry: Case) {
    const frozen = Object.freeze({ ...entry.context }) as ApplicabilityContextV2
    const snapshot = JSON.stringify(frozen)
    const direct = await validateApplicabilityContextCoherence(frozen, org, prisma)
    check(`${entry.label}: shared validator accepts`, direct.ok, JSON.stringify(direct))
    check(`${entry.label}: context is not filled in or altered`, JSON.stringify(frozen) === snapshot)

    const evaluated = await evaluateRuleApplicability(draftVersion.id, dims12(entry.context))
    check(`${entry.label}: A3.6 evaluate accepts`, evaluated.ok, JSON.stringify(evaluated))

    if (entry.clientProfile) return
    const gate = await evaluateExecutability(draftVersion.id, '2026-06-15', dims12(entry.context))
    check(`${entry.label}: A3.7 evaluate accepts the context`, gate.ok, JSON.stringify(gate))
  }

  // ---- C21 / C22 / Table 6 — omitted intermediate IDs ---------------------------------------
  section('Contradictory ancestry with omitted intermediate IDs (must reject)')
  await expectIncoherent({ label: 'C21 contract C2 + version V1 (V1 is under C1), no schedule', context: { providerContractId: C2.id, tariffScheduleVersionId: V1.id }, scopeable: true })
  await expectIncoherent({ label: 'C22 payer P2 + schedule S1 (S1 is under C1/P1), no contract', context: { payerId: P2.id, tariffScheduleId: S1.id }, scopeable: true })
  await expectIncoherent({ label: 'C22 payer P2 + version V1, no schedule and no contract', context: { payerId: P2.id, tariffScheduleVersionId: V1.id }, scopeable: true })
  await expectIncoherent({ label: 'T6 facility F2 + version V1 (F2 not in C1), no contract', context: { facilityId: F2.id, tariffScheduleVersionId: V1.id }, scopeable: true })
  await expectIncoherent({ label: 'C22 facility F2 + schedule S1, no contract', context: { facilityId: F2.id, tariffScheduleId: S1.id }, scopeable: true })
  await expectIncoherent({ label: 'TPA T2 + schedule S1 (C1 has T1), no contract', context: { tpaId: T2.id, tariffScheduleId: S1.id }, scopeable: true })
  await expectIncoherent({ label: 'network N2 + version V1 (C1 has N1), no contract', context: { networkId: N2.id, tariffScheduleVersionId: V1.id }, scopeable: true })
  await expectIncoherent({ label: 'product PR2 + version V1 (C1 has PR1), no contract', context: { insuranceProductId: PR2.id, tariffScheduleVersionId: V1.id }, scopeable: true })
  await expectIncoherent({ label: 'product PR1 + payer derived from version V2 (C2 is P2)', context: { insuranceProductId: PR1.id, tariffScheduleVersionId: V2.id }, scopeable: true })

  section('Existing pairwise checks still hold')
  await expectIncoherent({ label: 'version V1 + schedule S2', context: { tariffScheduleVersionId: V1.id, tariffScheduleId: S2.id }, scopeable: true })
  await expectIncoherent({ label: 'schedule S1 + contract C2', context: { tariffScheduleId: S1.id, providerContractId: C2.id }, scopeable: true })
  await expectIncoherent({ label: 'product PR1 + payer P2', context: { insuranceProductId: PR1.id, payerId: P2.id }, scopeable: true })
  await expectIncoherent({ label: 'product PR1 + network N2 (no ProductNetwork)', context: { insuranceProductId: PR1.id, networkId: N2.id }, scopeable: true })

  section('Facility chain through a regulatory profile')
  await expectIncoherent({ label: 'profile of F2 + contract C1, no facilityId', context: { facilityRegulatoryProfileId: PF2.id, providerContractId: C1.id }, scopeable: false, clientProfile: true })
  await expectIncoherent({ label: 'profile of F2 + version V1, no facility or contract', context: { facilityRegulatoryProfileId: PF2.id, tariffScheduleVersionId: V1.id }, scopeable: false, clientProfile: true })
  await expectIncoherent({ label: 'profile of F1 + facility F2', context: { facilityRegulatoryProfileId: PF1.id, facilityId: F2.id }, scopeable: false, clientProfile: true })

  section('Nullable contract dimensions keep the safe rejection (meaning not yet decided)')
  await expectIncoherent({ label: 'contract C2 (no TPA) + TPA T1', context: { providerContractId: C2.id, tpaId: T1.id }, scopeable: true })
  await expectIncoherent({ label: 'version V2 (contract has no network) + network N1', context: { tariffScheduleVersionId: V2.id, networkId: N1.id }, scopeable: true })

  // ---- C23 — valid partial input ------------------------------------------------------------
  section('Coherent partial contexts (must accept without filling fields)')
  await expectCoherent({ label: 'C23 version V1 only', context: { tariffScheduleVersionId: V1.id }, scopeable: false })
  await expectCoherent({ label: 'C23 version V1 + payer P1 + facility F1', context: { tariffScheduleVersionId: V1.id, payerId: P1.id, facilityId: F1.id }, scopeable: false })
  await expectCoherent({ label: 'C23 schedule S1 + TPA T1 + network N1 + product PR1', context: { tariffScheduleId: S1.id, tpaId: T1.id, networkId: N1.id, insuranceProductId: PR1.id }, scopeable: false })
  await expectCoherent({
    label: 'C23 full consistent chain',
    context: { tariffScheduleVersionId: V1.id, tariffScheduleId: S1.id, providerContractId: C1.id, payerId: P1.id, tpaId: T1.id, networkId: N1.id, insuranceProductId: PR1.id, facilityId: F1.id },
    scopeable: false,
  })
  await expectCoherent({ label: 'C23 product PR1 + network N1 + payer P1, no contract', context: { insuranceProductId: PR1.id, networkId: N1.id, payerId: P1.id }, scopeable: false })
  await expectCoherent({ label: 'C23 version V2 + payer P2 + facility F2', context: { tariffScheduleVersionId: V2.id, payerId: P2.id, facilityId: F2.id }, scopeable: false })

  await expectCoherent({ label: 'C23 profile of F1 + version V1', context: { facilityRegulatoryProfileId: PF1.id, tariffScheduleVersionId: V1.id }, scopeable: false, clientProfile: true })

  section('C23 matching semantics are unchanged by ancestry validation')
  const onlyVersion = await evaluateRuleApplicability(draftVersion.id, dims12({ tariffScheduleVersionId: V1.id }))
  check(
    'a V1-only context matches the V1 row only — the C1 row is NOT satisfied by an inferred contract',
    onlyVersion.ok && onlyVersion.value.matchedApplicabilityIds.length === 1 && onlyVersion.value.matchedApplicabilityIds[0] === rowByVersion.id,
    JSON.stringify(onlyVersion),
  )
  const withContract = await evaluateRuleApplicability(draftVersion.id, dims12({ tariffScheduleVersionId: V1.id, providerContractId: C1.id }))
  check(
    'supplying C1 explicitly matches both rows',
    withContract.ok && withContract.value.matchedApplicabilityIds.length === 2 && withContract.value.matchedApplicabilityIds.includes(rowByContract.id),
    JSON.stringify(withContract),
  )
  const storedRows = await prisma.ruleApplicability.findMany({ where: { ruleVersionId: draftVersion.id } })
  check(
    'no stored applicability row gained a non-null column',
    storedRows.length === 2 && storedRows.every((row) => APPLICABILITY_DIMENSIONS_V2.filter((key) => row[key] !== null).length === 1),
  )

  const scopeRow = await createRuleSourceScope(source.id, dims8({ tariffScheduleVersionId: V1.id }), actor)
  check('a coherent V1-only scope row is created with only that column set', scopeRow.ok && scopeRow.value.providerContractId === null && scopeRow.value.tariffScheduleVersionId === V1.id, JSON.stringify(scopeRow))

  console.log(`\n[a3-coherence] ${passed} passed, ${failed} failed`)
  console.log(failed === 0 ? '[a3-coherence] ALL CHECKS PASS' : '[a3-coherence] CHECKS FAILED')
  process.exitCode = failed === 0 ? 0 : 1
}

main()
  .catch((error) => {
    console.error('[a3-coherence] uncaught error (this itself is a FAIL):', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
