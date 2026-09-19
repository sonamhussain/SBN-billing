import 'dotenv/config'
import { prisma } from '../shared/database/prisma.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../shared/testing/concurrency-probe.ts'
import { evaluateRuleResolutionWithEvidence } from '../modules/rule-resolution/rule-resolution.service.ts'
import { composeRuleDecisionProvenanceRefV1 } from '../modules/rule-provenance/rule-provenance.composer.ts'
import type { RuleResolutionDto } from '../modules/rule-resolution/rule-resolution.types.ts'
import {
  activateRulePackVersion,
  addRulePackMember,
  createRulePack,
  createRulePackVersion,
  verifyRulePackVersion,
} from '../modules/rule-pack/rule-pack.service.ts'
import { a38Fixtures, createChecker, d } from './support/a3-8-fixtures.ts'

// A3.9 — the internal A3-PROV-1 composer against real rows (T36–T51, T57–T58), plus the two
// rule-pack races that need in-process barriers (T31 one-ACTIVE, verification freeze).
// Every input comes from a REAL A3.8 evaluation (evaluateRuleResolutionWithEvidence), so the
// composer is exercised exactly as a later business module would call it.

const { check, eq, section, finish } = createChecker('a3.9-provenance')

const tag = `A39P-${Date.now()}`
const organizationId = process.env.AUTHZ_BOOTSTRAP_ORGANIZATION_ID
const userEmail = process.env.AUTHZ_BOOTSTRAP_USER_EMAIL
const businessDate = '2026-03-15'
const clock = () => new Date('2026-09-19T10:00:00.000Z')

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
      SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`
    if (Number(rows[0].waiting) > 0) return 'blocked'
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('neither blocked nor settled within the timeout')
}

async function tableCounts() {
  const [packs, versions, members, ruleVersions, sourceVersions, bindings, applicabilities, audits] = await Promise.all([
    prisma.rulePack.count(),
    prisma.rulePackVersion.count(),
    prisma.rulePackMember.count(),
    prisma.ruleVersion.count(),
    prisma.ruleSourceVersion.count(),
    prisma.ruleSourceBinding.count(),
    prisma.ruleApplicability.count(),
    prisma.auditEvent.count(),
  ])
  return { packs, versions, members, ruleVersions, sourceVersions, bindings, applicabilities, audits }
}

async function main() {
  if (!organizationId || !userEmail) throw new Error('AUTHZ_BOOTSTRAP_ORGANIZATION_ID and AUTHZ_BOOTSTRAP_USER_EMAIL are required')
  const org = organizationId
  const actor = (await prisma.user.findUniqueOrThrow({ where: { email: userEmail } })).id
  console.log(`[a3.9-provenance] run tag ${tag} — organization ${org}`)
  const fx = a38Fixtures(org, tag)

  // ---- a full, coherent twelve-dimension context (REF-01 commercial chain + masters) ----------
  const P1 = await prisma.payer.create({ data: { organizationId: org, displayName: `${tag} P1` } })
  const T1 = await prisma.tpa.create({ data: { organizationId: org, displayName: `${tag} T1` } })
  const N1 = await prisma.network.create({ data: { organizationId: org, displayName: `${tag} N1` } })
  const PR1 = await prisma.insuranceProduct.create({ data: { organizationId: org, payerId: P1.id, productCode: `${tag}-PR1`, displayName: 'PR1' } })
  await prisma.productNetwork.create({ data: { insuranceProductId: PR1.id, networkId: N1.id } })
  const C1 = await prisma.providerContract.create({
    data: { organizationId: org, payerId: P1.id, tpaId: T1.id, networkId: N1.id, insuranceProductId: PR1.id, contractKey: `${tag}-C1`, displayName: 'C1', effectiveFrom: d('2020-01-01') },
  })
  const F1 = await prisma.facility.create({ data: { organizationId: org, name: `${tag} F1` } })
  await prisma.contractFacility.create({ data: { providerContractId: C1.id, facilityId: F1.id } })
  const S1 = await prisma.tariffSchedule.create({ data: { providerContractId: C1.id, tariffKey: `${tag}-S1`, displayName: 'S1' } })
  const V1 = await prisma.tariffScheduleVersion.create({ data: { tariffScheduleId: S1.id, version: '1' } })
  const PF1 = await fx.profile(F1.id, '2020-01-01', null, 'AE-DU')
  const service = await prisma.service.create({ data: { organizationId: org, internalCode: `${tag}-SVC`, displayName: 'svc' } })
  const procedure = await prisma.procedureCode.create({ data: { organizationId: org, internalCode: `${tag}-PROC`, displayName: 'proc' } })
  const diagnosis = await prisma.diagnosisCode.create({ data: { organizationId: org, code: `${tag}-DX`, displayName: 'dx' } })
  const fullContext = {
    facilityId: F1.id,
    payerId: P1.id,
    tpaId: T1.id,
    networkId: N1.id,
    insuranceProductId: PR1.id,
    providerContractId: C1.id,
    tariffScheduleId: S1.id,
    tariffScheduleVersionId: V1.id,
    serviceId: service.id,
    procedureCodeId: procedure.id,
    diagnosisCodeId: diagnosis.id,
  }

  // ---- a rule with one governing and two supporting sources --------------------------------
  const rule = await fx.makeRule('prov')
  const ruleVersion = await fx.makeRuleVersion(rule.id, '1')
  const applicability = await fx.makeApplicability(ruleVersion.id)
  const governing = await fx.attachSource(ruleVersion.id, 'gov')
  const supportA = await fx.attachSource(ruleVersion.id, 'sup-a', { role: 'SUPPORTING' })
  const supportB = await fx.attachSource(ruleVersion.id, 'sup-b', { role: 'SUPPORTING' })

  // A real A3.8 evaluation. A forged facilityRegulatoryProfileId in the request must not survive:
  // A3.8 derives the profile server-side and the composer reuses exactly that.
  const evaluated = await evaluateRuleResolutionWithEvidence(rule.id, businessDate, { ...fullContext, facilityRegulatoryProfileId: F1.id }, { clock })
  if (!evaluated.ok) throw new Error(`A3.8 evaluation failed: ${evaluated.code} ${evaluated.message}`)
  const ev = evaluated.value
  check('fixture: the real A3.8 evaluation RESOLVED', ev.resolution.resolutionStatus === 'RESOLVED', JSON.stringify(ev.resolution))

  const compose = (resolution: RuleResolutionDto, rulePackVersionId: string | null = null) =>
    composeRuleDecisionProvenanceRefV1({
      resolution,
      authoritativeContext: ev.authoritativeContext,
      organizationId: ev.organizationId,
      rulePackVersionId,
      evaluationTimestamp: ev.evaluationTimestamp,
    })

  section('T36 an unresolved A3.8 result produces no provenance')
  {
    const noMatchRule = await fx.makeRule('no-match')
    const noMatch = await evaluateRuleResolutionWithEvidence(noMatchRule.id, businessDate, {}, { clock })
    if (!noMatch.ok) throw new Error('no-match evaluation failed')
    const out = await composeRuleDecisionProvenanceRefV1({
      resolution: noMatch.value.resolution,
      authoritativeContext: noMatch.value.authoritativeContext,
      organizationId: noMatch.value.organizationId,
      evaluationTimestamp: noMatch.value.evaluationTimestamp,
    })
    check('T36 a real NO_MATCH result -> RESOLUTION_NOT_RESOLVED, no provenance object', !out.ok && out.error.code === 'RESOLUTION_NOT_RESOLVED' && !('value' in out))
  }

  section('T37–T46 exact copies, from a real RESOLVED result, with no pack')
  const base = await compose(ev.resolution)
  if (!base.ok) throw new Error(`composition failed: ${base.error.code} ${base.error.message}`)
  const p = base.value
  check('T37 exact RuleDefinition / RuleVersion / version label', p.ruleDefinitionId === rule.id && p.ruleVersionId === ruleVersion.id && p.ruleVersion === '1')
  check(
    'T38 exact governing binding / source / source version / interpretation',
    p.governingBindingId === governing.binding.id &&
      p.governingSourceId === governing.source.id &&
      p.governingSourceVersionId === governing.sourceVersion.id &&
      p.governingSourceInterpretationId === governing.interpretation.id,
  )
  eq('T38 governingSourceVersion is the stored version label of that exact source version', p.governingSourceVersion, governing.sourceVersion.version)
  check(
    'T39 supporting source version IDs are derived from the exact supporting bindings',
    JSON.stringify([...p.supportingSourceVersionIds].sort()) === JSON.stringify([supportA.sourceVersion.id, supportB.sourceVersion.id].sort()) &&
      JSON.stringify(p.supportingBindingIds) === JSON.stringify(ev.resolution.supportingBindingIds),
  )
  check('T40 matchedApplicabilityIds copied exactly', JSON.stringify(p.matchedApplicabilityIds) === JSON.stringify(ev.resolution.matchedApplicabilityIds) && p.matchedApplicabilityIds.includes(applicability.id))
  eq('T41 precedencePolicyVersion equals the A3.8 result (currently A3-PREC-1)', p.precedencePolicyVersion, ev.resolution.precedencePolicyVersion)
  {
    const future = await compose({ ...ev.resolution, precedencePolicyVersion: 'A3-PREC-2-FUTURE' })
    check('T41 the policy string is copied verbatim, not hard-coded (a future policy passes through)', future.ok && future.value.precedencePolicyVersion === 'A3-PREC-2-FUTURE')
  }
  check('T42 all twelve context dimensions are present', Object.keys(p.context).length === 12)
  check(
    'T42 every supplied dimension is preserved exactly',
    p.context.facilityId === F1.id && p.context.payerId === P1.id && p.context.tpaId === T1.id && p.context.networkId === N1.id &&
      p.context.serviceId === service.id && p.context.procedureCodeId === procedure.id && p.context.diagnosisCodeId === diagnosis.id,
    JSON.stringify(p.context),
  )
  eq('T43 facilityRegulatoryProfileId is the one A3.8 derived server-side', p.context.facilityRegulatoryProfileId, PF1.id)
  check('T43 the forged client profile value never reached provenance', p.context.facilityRegulatoryProfileId !== F1.id)
  check(
    'T44 REF-01 commercial IDs preserved (product / contract / tariff schedule / tariff version)',
    p.context.insuranceProductId === PR1.id && p.context.providerContractId === C1.id && p.context.tariffScheduleId === S1.id && p.context.tariffScheduleVersionId === V1.id,
  )
  check('T45 referenceDatasetVersionIds is an empty list — no fake dataset', Array.isArray(p.referenceDatasetVersionIds) && p.referenceDatasetVersionIds.length === 0)
  check('T46 no pack -> all three pack fields null', p.rulePackId === null && p.rulePackVersionId === null && p.rulePackVersion === null)
  check('contract version, organization, jurisdiction, businessDate and evaluation instant', p.provenanceContractVersion === 'A3-PROV-1' && p.organizationId === org && p.jurisdictionCode === 'AE-DU' && p.businessDate === businessDate && p.evaluationTimestamp === '2026-09-19T10:00:00.000Z')

  section('T47–T50 the optional exact RulePackVersion')
  async function packVersionWith(label: string, memberRuleVersionIds: string[], opts: { from?: string; to?: string; jurisdiction?: string; verify?: boolean; activate?: boolean } = {}) {
    const pack = await createRulePack(org, `${tag}-${label}`, `pack ${label}`, opts.jurisdiction ?? 'AE-DU', actor)
    if (!pack.ok) throw new Error(`pack: ${pack.message}`)
    const v = await createRulePackVersion(pack.value.id, 'v1', opts.from ?? '2026-01-01', opts.to ?? null, false, actor)
    if (!v.ok) throw new Error(`version: ${v.message}`)
    for (const id of memberRuleVersionIds) {
      const m = await addRulePackMember(v.value.id, id, actor)
      if (!m.ok) throw new Error(`member: ${m.message}`)
    }
    if (opts.verify ?? true) {
      const verified = await verifyRulePackVersion(v.value.id, actor)
      if (!verified.ok) throw new Error(`verify: ${verified.message}`)
    }
    if (opts.activate ?? true) {
      const activated = await activateRulePackVersion(v.value.id, businessDate, actor)
      if (!activated.ok) throw new Error(`activate: ${activated.message}`)
    }
    return { packId: pack.value.id, versionId: v.value.id }
  }

  {
    const member = await packVersionWith('member', [ruleVersion.id])
    const out = await compose(ev.resolution, member.versionId)
    check('T47 an exact member -> pack fields populated', out.ok && out.value.rulePackId === member.packId && out.value.rulePackVersionId === member.versionId && out.value.rulePackVersion === 'v1', JSON.stringify(out))
  }
  {
    const otherRule = await fx.makeRule('other')
    const otherVersion = await fx.makeRuleVersion(otherRule.id, '1')
    const notMember = await packVersionWith('not-member', [otherVersion.id])
    const out = await compose(ev.resolution, notMember.versionId)
    check('T48 the resolved RuleVersion is not a member -> PACK_MEMBERSHIP_MISMATCH, no provenance', !out.ok && out.error.code === 'PACK_MEMBERSHIP_MISMATCH')
  }
  {
    const cases: [string, Awaited<ReturnType<typeof packVersionWith>>][] = [
      ['UNVERIFIED draft', await packVersionWith('draft', [ruleVersion.id], { verify: false, activate: false })],
      ['VERIFIED but never activated', await packVersionWith('never-active', [ruleVersion.id], { activate: false })],
      ['businessDate outside the pack period', await packVersionWith('out-of-period', [ruleVersion.id], { from: '2026-01-01', to: '2026-03-31' }).then(async (pv) => {
        // Activated inside its window; the resolution date is then moved outside it below.
        return pv
      })],
    ]
    for (const [label, pv] of cases.slice(0, 2)) {
      const out = await compose(ev.resolution, pv.versionId)
      check(`T49 ${label} -> PACK_VERSION_NOT_USABLE`, !out.ok && out.error.code === 'PACK_VERSION_NOT_USABLE', JSON.stringify(out))
    }
    const outOfPeriod = await compose({ ...ev.resolution, businessDate: '2026-05-01' }, cases[2][1].versionId)
    check('T49 businessDate outside the pack period -> PACK_VERSION_NOT_USABLE', !outOfPeriod.ok && outOfPeriod.error.code === 'PACK_VERSION_NOT_USABLE', JSON.stringify(outOfPeriod))
    const unknown = await compose(ev.resolution, '00000000-0000-4000-8000-000000000000')
    check('T49 an unknown pack version -> PACK_VERSION_NOT_USABLE', !unknown.ok && unknown.error.code === 'PACK_VERSION_NOT_USABLE')
    const foreignOrgPack = await prisma.rulePack.create({
      data: { organizationId: process.env.A1_IT_OTHER_ORGANIZATION_ID as string, ownershipScope: 'ORGANIZATION', packKey: `${tag}-foreign`, displayName: 'f', jurisdictionCode: 'AE-DU' },
    })
    const foreignVersion = await prisma.rulePackVersion.create({
      data: { rulePackId: foreignOrgPack.id, version: 'v1', verificationStatus: 'VERIFIED', verifiedAt: new Date(), activationStatus: 'ACTIVE', activatedAt: new Date() },
    })
    await prisma.rulePackMember.create({ data: { rulePackVersionId: foreignVersion.id, ruleVersionId: ruleVersion.id } })
    const foreign = await compose(ev.resolution, foreignVersion.id)
    check('T49 another organization pack -> PACK_VERSION_NOT_USABLE even when it lists the RuleVersion', !foreign.ok && foreign.error.code === 'PACK_VERSION_NOT_USABLE')
  }
  {
    const historical = await packVersionWith('historical', [ruleVersion.id], { from: '2026-01-01' })
    const successor = await createRulePackVersion(historical.packId, 'v2', '2026-01-01', null, false, actor)
    if (!successor.ok) throw new Error(successor.message)
    await addRulePackMember(successor.value.id, ruleVersion.id, actor)
    await verifyRulePackVersion(successor.value.id, actor)
    await activateRulePackVersion(successor.value.id, businessDate, actor)
    const old = await prisma.rulePackVersion.findUniqueOrThrow({ where: { id: historical.versionId } })
    check('fixture: the first version is now SUPERSEDED', old.activationStatus === 'SUPERSEDED')
    const out = await compose(ev.resolution, historical.versionId)
    check('T50 the exact SUPERSEDED pack version is referenced for a date inside its period', out.ok && out.value.rulePackVersionId === historical.versionId && out.value.rulePackVersion === 'v1', JSON.stringify(out))
  }

  section('T51 historicalOnly is copied exactly — never recalculated or downgraded')
  {
    check('current A3.8 result: historicalOnly false is copied', p.historicalOnly === ev.resolution.historicalOnly && p.historicalOnly === false)
    const histRule = await fx.makeRule('hist')
    const histVersion = await fx.makeRuleVersion(histRule.id, '1', { effectiveFrom: d('2025-01-01'), effectiveTo: d('2025-12-31') })
    await fx.makeApplicability(histVersion.id)
    await fx.attachSource(histVersion.id, 'hist-gov', { effectiveFrom: d('2025-01-01') })
    const hist = await evaluateRuleResolutionWithEvidence(histRule.id, '2025-06-15', {}, { clock })
    if (!hist.ok) throw new Error('historical evaluation failed')
    const out = await composeRuleDecisionProvenanceRefV1({
      resolution: hist.value.resolution,
      authoritativeContext: hist.value.authoritativeContext,
      organizationId: hist.value.organizationId,
      evaluationTimestamp: hist.value.evaluationTimestamp,
    })
    check('a real historical A3.8 result (rule expired by evaluation date): historicalOnly true is copied', hist.value.resolution.historicalOnly === true && out.ok && out.value.historicalOnly === true)
    const notDowngraded = await compose({ ...ev.resolution, historicalOnly: true })
    check('the composer never downgrades: an input flagged true stays true although everything is current', notDowngraded.ok && notDowngraded.value.historicalOnly === true)
  }

  section('Fail closed on inconsistent input (PROVENANCE_INVARIANT_VIOLATION)')
  {
    const tampered: [string, RuleResolutionDto][] = [
      ['a governing source that does not match the binding', { ...ev.resolution, governingSourceId: supportA.source.id }],
      ['a governing binding that is really SUPPORTING', { ...ev.resolution, governingBindingId: supportA.binding.id }],
      ['a supporting binding of another rule', { ...ev.resolution, supportingBindingIds: [(await fx.attachSource((await fx.makeRuleVersion((await fx.makeRule('elsewhere')).id, '1')).id, 'x', { role: 'SUPPORTING' })).binding.id] }],
      ['a RuleVersion of another RuleDefinition', { ...ev.resolution, ruleDefinitionId: (await fx.makeRule('wrong-def')).id }],
      ['a wrong version label', { ...ev.resolution, ruleVersion: '2' }],
    ]
    for (const [label, resolution] of tampered) {
      const out = await compose(resolution)
      check(`${label} -> PROVENANCE_INVARIANT_VIOLATION`, !out.ok && out.error.code === 'PROVENANCE_INVARIANT_VIOLATION', JSON.stringify(out))
    }
    const wrongOrg = await composeRuleDecisionProvenanceRefV1({
      resolution: ev.resolution,
      authoritativeContext: ev.authoritativeContext,
      organizationId: process.env.A1_IT_OTHER_ORGANIZATION_ID as string,
      evaluationTimestamp: ev.evaluationTimestamp,
    })
    check('an organization that does not own the rule -> PROVENANCE_INVARIANT_VIOLATION', !wrongOrg.ok && wrongOrg.error.code === 'PROVENANCE_INVARIANT_VIOLATION')
  }

  section('T57–T58 the composer writes nothing')
  {
    const member = await packVersionWith('no-write', [ruleVersion.id])
    const rvBefore = await prisma.ruleVersion.findUniqueOrThrow({ where: { id: ruleVersion.id } })
    const before = await tableCounts()
    for (let i = 0; i < 3; i += 1) {
      await compose(ev.resolution)
      await compose(ev.resolution, member.versionId)
      await compose({ ...ev.resolution, resolutionStatus: 'NO_MATCH' })
    }
    const after = await tableCounts()
    const { audits: auditsBefore, ...rowsBefore } = before
    const { audits: auditsAfter, ...rowsAfter } = after
    check('T57 row counts of every touched table are unchanged', JSON.stringify(rowsBefore) === JSON.stringify(rowsAfter), JSON.stringify({ rowsBefore, rowsAfter }))
    check('T57 the RuleVersion row is untouched (updatedAt unchanged)', (await prisma.ruleVersion.findUniqueOrThrow({ where: { id: ruleVersion.id } })).updatedAt.getTime() === rvBefore.updatedAt.getTime())
    check('T58 no AuditEvent was written', auditsBefore === auditsAfter)
  }

  section('T31 one ACTIVE version under a real race (in-process barrier)')
  {
    const pack = await createRulePack(org, `${tag}-race`, 'race pack', 'AE-DU', actor)
    if (!pack.ok) throw new Error(pack.message)
    const ids: string[] = []
    for (const label of ['r1', 'r2']) {
      const v = await createRulePackVersion(pack.value.id, label, null, null, false, actor)
      if (!v.ok) throw new Error(v.message)
      await addRulePackMember(v.value.id, ruleVersion.id, actor)
      await verifyRulePackVersion(v.value.id, actor)
      ids.push(v.value.id)
    }
    clearConcurrencyProbes()
    const holding = barrier()
    const release = barrier()
    setConcurrencyProbe('rule_pack_version.activate', async () => {
      holding.open()
      await release.promise
    })
    const first = activateRulePackVersion(ids[0], businessDate, actor)
    await holding.promise
    const second = activateRulePackVersion(ids[1], businessDate, actor)
    const state = await waitUntilBlockedOrSettled(second)
    release.open()
    const [firstResult, secondResult] = await Promise.all([first, second])
    clearConcurrencyProbes()
    const rows = await prisma.rulePackVersion.findMany({ where: { rulePackId: pack.value.id } })
    const byId = new Map(rows.map((row) => [row.id, row.activationStatus]))
    check('T31 the second activation waited on the pack lock', state === 'blocked', `(observed: ${state})`)
    check('T31 both activations returned typed results, neither threw', firstResult.ok && secondResult.ok)
    check('T31 exactly one ACTIVE version remains', rows.filter((row) => row.activationStatus === 'ACTIVE').length === 1)
    check('T31 serial outcome: the later activation is ACTIVE and the first is SUPERSEDED', byId.get(ids[1]) === 'ACTIVE' && byId.get(ids[0]) === 'SUPERSEDED', JSON.stringify([...byId]))
  }

  section('Verification freeze under a race: a member add waiting on verification is rejected')
  {
    const pack = await createRulePack(org, `${tag}-freeze`, 'freeze pack', 'AE-DU', actor)
    if (!pack.ok) throw new Error(pack.message)
    const v = await createRulePackVersion(pack.value.id, 'f1', null, null, false, actor)
    if (!v.ok) throw new Error(v.message)
    await addRulePackMember(v.value.id, ruleVersion.id, actor)
    const extraRule = await fx.makeRule('late-member')
    const extraVersion = await fx.makeRuleVersion(extraRule.id, '1')
    clearConcurrencyProbes()
    const holding = barrier()
    const release = barrier()
    setConcurrencyProbe('rule_pack_version.verify', async () => {
      holding.open()
      await release.promise
    })
    const verify = verifyRulePackVersion(v.value.id, actor)
    await holding.promise
    const lateAdd = addRulePackMember(v.value.id, extraVersion.id, actor)
    const state = await waitUntilBlockedOrSettled(lateAdd)
    release.open()
    const [verifyResult, addResult] = await Promise.all([verify, lateAdd])
    clearConcurrencyProbes()
    const members = await prisma.rulePackMember.findMany({ where: { rulePackVersionId: v.value.id } })
    check('the member add waited for the in-flight verification', state === 'blocked', `(observed: ${state})`)
    check('verification commits; the late add is rejected as frozen', verifyResult.ok && !addResult.ok && addResult.code === 'VALIDATION_ERROR', JSON.stringify(addResult))
    check('the verified snapshot has exactly its one original member', members.length === 1 && members[0].ruleVersionId === ruleVersion.id)
  }

  section('Before/after: each A3.9 database backstop is what rejects the bad row')
  {
    // Inside one transaction that is always rolled back: the bad write fails WITH the guard
    // (after), then the guard is dropped and the SAME write succeeds (before). Nothing persists.
    const pack = await createRulePack(org, `${tag}-guards`, 'guards', 'AE-DU', actor)
    if (!pack.ok) throw new Error(pack.message)
    const packId = pack.value.id
    const versionColumns = 'id, rule_pack_id, version, verification_status, verified_at, activation_status, activated_at, effective_from, effective_to, updated_at'
    const packColumns = 'id, organization_id, ownership_scope, pack_key, display_name, jurisdiction_code, updated_at'
    type Guard = { name: string; drop: string; bad: string; setup?: string }
    const guards: Guard[] = [
      {
        name: 'rule_pack_versions_one_active_uq',
        drop: 'DROP INDEX rule_pack_versions_one_active_uq',
        setup: `INSERT INTO rule_pack_versions (${versionColumns}) VALUES (gen_random_uuid(), '${packId}', 'a1', 'VERIFIED', now(), 'ACTIVE', now(), NULL, NULL, now())`,
        bad: `INSERT INTO rule_pack_versions (${versionColumns}) VALUES (gen_random_uuid(), '${packId}', 'a2', 'VERIFIED', now(), 'ACTIVE', now(), NULL, NULL, now())`,
      },
      {
        name: 'rule_pack_versions_lifecycle_chk',
        drop: 'ALTER TABLE rule_pack_versions DROP CONSTRAINT rule_pack_versions_lifecycle_chk',
        bad: `INSERT INTO rule_pack_versions (${versionColumns}) VALUES (gen_random_uuid(), '${packId}', 'u1', 'UNVERIFIED', NULL, 'ACTIVE', now(), NULL, NULL, now())`,
      },
      {
        name: 'rule_pack_versions_activated_at_chk',
        drop: 'ALTER TABLE rule_pack_versions DROP CONSTRAINT rule_pack_versions_activated_at_chk',
        bad: `INSERT INTO rule_pack_versions (${versionColumns}) VALUES (gen_random_uuid(), '${packId}', 'n1', 'VERIFIED', now(), 'ACTIVE', NULL, NULL, NULL, now())`,
      },
      {
        name: 'rule_pack_versions_effective_date_chk',
        drop: 'ALTER TABLE rule_pack_versions DROP CONSTRAINT rule_pack_versions_effective_date_chk',
        bad: `INSERT INTO rule_pack_versions (${versionColumns}) VALUES (gen_random_uuid(), '${packId}', 'd1', 'UNVERIFIED', NULL, 'INACTIVE', NULL, '2026-06-01', '2026-01-01', now())`,
      },
      {
        name: 'rule_packs_ownership_scope_chk',
        drop: 'ALTER TABLE rule_packs DROP CONSTRAINT rule_packs_ownership_scope_chk',
        bad: `INSERT INTO rule_packs (${packColumns}) VALUES (gen_random_uuid(), NULL, 'ORGANIZATION', '${tag}-own', 'x', 'AE-DU', now())`,
      },
      {
        name: 'rule_packs_scope_pack_key_uq',
        drop: 'DROP INDEX rule_packs_scope_pack_key_uq',
        setup: `INSERT INTO rule_packs (${packColumns}) VALUES (gen_random_uuid(), NULL, 'SYSTEM_SHARED', '${tag}-shared', 'x', 'AE-DU', now())`,
        bad: `INSERT INTO rule_packs (${packColumns}) VALUES (gen_random_uuid(), NULL, 'SYSTEM_SHARED', '${tag}-shared', 'y', 'AE-DU', now())`,
      },
    ]
    const rollback = new Error('rollback')
    for (const guard of guards) {
      let after = 'accepted'
      let before = 'rejected'
      try {
        await prisma.$transaction(async (tx) => {
          if (guard.setup) await tx.$executeRawUnsafe(guard.setup)
          await tx.$executeRawUnsafe('SAVEPOINT guarded')
          try {
            await tx.$executeRawUnsafe(guard.bad)
          } catch (error) {
            after = String(error).includes(guard.name) ? 'rejected by guard' : `rejected (other: ${String(error).slice(0, 160)})`
          }
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT guarded')
          await tx.$executeRawUnsafe(guard.drop)
          await tx.$executeRawUnsafe(guard.bad)
          before = 'accepted'
          throw rollback
        })
      } catch (error) {
        if (error !== rollback) before = `error: ${String(error).slice(0, 160)}`
      }
      check(`${guard.name}: after (guard present) the bad row is rejected by this guard`, after === 'rejected by guard', after)
      check(`${guard.name}: before (guard dropped) the same row is accepted`, before === 'accepted', before)
    }
    const indexes = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_indexes WHERE indexname IN ('rule_pack_versions_one_active_uq', 'rule_packs_scope_pack_key_uq')`
    const constraints = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_constraint WHERE conname IN ('rule_pack_versions_lifecycle_chk', 'rule_pack_versions_activated_at_chk', 'rule_pack_versions_effective_date_chk', 'rule_packs_ownership_scope_chk')`
    const leaked = await prisma.rulePack.count({ where: { packKey: { in: [`${tag}-own`, `${tag}-shared`] } } })
    check('every dropped guard is back after the rollback (2 indexes, 4 constraints) and no probe row persisted', Number(indexes[0].n) === 2 && Number(constraints[0].n) === 4 && leaked === 0)
  }

  finish()
}

main()
  .catch((error) => {
    console.error('[a3.9-provenance] uncaught error (this itself is a FAIL):', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
