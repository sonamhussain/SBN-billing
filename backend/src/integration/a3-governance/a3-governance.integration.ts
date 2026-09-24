import 'dotenv/config'
import { prisma } from '../../shared/database/prisma.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { apiFixtures } from './a3-governance.fixtures.ts'
import { evaluateExecutability } from '../../modules/rule-source-binding/rule-source-binding.service.ts'
import { evaluateRuleResolution, evaluateRuleResolutionBundle } from '../../modules/rule-resolution/rule-resolution.service.ts'
import { composeRuleDecisionProvenanceRefV1 } from '../../modules/rule-provenance/rule-provenance.composer.ts'
import {
  activateRulePackVersion,
  addRulePackMember,
  createRulePack,
  createRulePackVersion,
  verifyRulePackVersion,
} from '../../modules/rule-pack/rule-pack.service.ts'
import type { RuleResolutionEvaluationBundle } from '../../modules/rule-resolution/rule-resolution.types.ts'
import {
  gitGrep,
  createReport,
  foreignKeyDeleteRules,
  git,
  gitOk,
  hasConstraint,
  hasIndex,
  hasTrigger,
  runCommand,
  runSuite,
  waitFor,
} from './a3-governance.support.ts'

// A3.10 — cumulative A3 integration acceptance (T01–T76). It proves that A3.1–A3.9, REF-01 and the
// approved hard-audit corrections behave as ONE system. It adds no governance truth of its own:
// owner suites are invoked as child processes, cross-module scenarios ask the owning services, and
// structural invariants are read (never written) from PostgreSQL.

const report = createReport()
const { check, exception, section } = report

const runId = `A310-${Date.now()}`
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
const bootstrapUserEmail = process.env.AUTHZ_BOOTSTRAP_USER_EMAIL as string

// Fixed synthetic dates and a fixed clock seam — never wall-clock timing (§9).
const businessDate = '2026-03-15'
const clock = () => new Date('2026-09-20T09:00:00.000Z')
const frontendDir = '../frontend'
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'

const allDimensions = {
  facilityId: null,
  facilityRegulatoryProfileId: null,
  payerId: null,
  tpaId: null,
  networkId: null,
  insuranceProductId: null,
  providerContractId: null,
  tariffScheduleId: null,
  tariffScheduleVersionId: null,
  serviceId: null,
  procedureCodeId: null,
  diagnosisCodeId: null,
}

function gateInputs(context: Record<string, string | null>) {
  return { ...allDimensions, ...context } as Record<keyof typeof allDimensions, unknown>
}

async function auditCount(): Promise<number> {
  return prisma.auditEvent.count({ where: { organizationId: org } })
}

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg, bootstrapUserEmail }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  const headAtStart = git('rev-parse HEAD')
  console.log(`[A3.10] cumulative A3 integration acceptance — run ${runId}`)
  console.log(`[A3.10] HEAD ${headAtStart} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

  const ready = async () => (await fetch(`${baseUrl}/api/ready`).catch(() => null))?.status ?? 0
  const health = async () => (await fetch(`${baseUrl}/api/health`).catch(() => null))?.status ?? 0
  // `db:generate` rewrites the generated Prisma client, which restarts an API started with
  // `npm run dev` (--watch). Waiting for the API to answer again keeps that environment choice from
  // being reported as a product failure; nothing about the checks themselves is relaxed.
  const apiReady = async (what: string) => {
    if (!(await waitFor(async () => (await ready()) === 200, 120_000)))
      throw new Error(`the API at ${baseUrl} is not ready before ${what}; start it with \`npm start\``)
  }

  // ---------------------------------------------------------------- gates (T01–T06)
  section('Start gate, ancestry and schema closure')
  const a38Merge = '7671f0787f46a4f555902d18f2165f7413f4711a'
  const a39Merge = '9a640394fdfc8a72b4aa8f2670a4732ffaf23bac'
  const branch = git('rev-parse --abbrev-ref HEAD')
  check('T01', 'start gate', gitOk(`merge-base --is-ancestor ${a39Merge} HEAD`) && branch === 'feature/a3-10-a3-integration-acceptance', `branch ${branch}, A3.9 merge present`)
  check('T02', 'git ancestry', gitOk(`merge-base --is-ancestor ${a38Merge} HEAD`) && gitOk(`merge-base --is-ancestor ${a39Merge} HEAD`), 'A3.8 7671f078 and A3.9 9a64039 are ancestors')
  const dirty = git('status --porcelain')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3))
    .filter((path) => !path.startsWith('backend/src/integration/a3-governance/') && path !== 'backend/package.json')
  check('T03', 'clean baseline', dirty.length === 0, dirty.length === 0 ? 'only the A3.10 harness differs from main' : `unexpected: ${dirty.join(', ')}`)
  const schemaTouched = git(`diff --name-only ${a39Merge} HEAD`)
    .split(/\r?\n/)
    .concat(git('status --porcelain').split(/\r?\n/).map((line) => line.slice(3)))
    .filter((path) => path.includes('prisma/'))
  check('T04', 'no feature schema', schemaTouched.length === 0, 'no schema.prisma edit and no A3.10 migration folder')

  const validate = runSuite('db:validate')
  const generate = runSuite('db:generate')
  const status = runSuite('db:status')
  check(
    'T05',
    'prisma validate/generate/status',
    validate.ok && generate.ok && status.ok && /up to date/i.test(status.summary),
    `validate PASS, generate PASS, ${status.summary}`,
  )
  const replay = runSuite('db:verify:replay')
  check('T06', 'migration replay', replay.ok, replay.summary)

  // ---------------------------------------------------------------- A1/A2 baseline (T07–T10)
  section('A1 / A2 baseline truth')
  await apiReady('the A1 health/readiness check')
  const upHealth = await health()
  const upReady = await ready()
  const stopped = runCommand('docker', ['stop', dbContainer])
  const downReady = await waitFor(async () => (await ready()) === 503, 30_000)
  const downHealthSamples: number[] = []
  for (let i = 0; i < 5; i += 1) {
    downHealthSamples.push(await health())
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  const downHealth = downHealthSamples.every((status) => status === 200) ? 200 : Math.min(...downHealthSamples)
  const started = runCommand('docker', ['start', dbContainer])
  const recovered = await waitFor(async () => (await ready()) === 200, 90_000)
  check(
    'T07',
    'A1 health/readiness truth',
    upHealth === 200 && upReady === 200 && stopped.ok && downHealth === 200 && downReady && started.ok && recovered,
    `up 200/200, DB down health ${downHealth} ready 503, recovery 200`,
  )
  exception('T08', 'A1 worker proof', 'Windows SIGTERM cannot be delivered by the automated harness; manual `npm run worker:start` + Ctrl+C evidence is attached separately')
  await apiReady('the A2 acceptance suite')
  const a2 = runSuite('test:a2:integration')
  check('T09', 'A2 cumulative', a2.ok && /36\/36 PASS/.test(a2.summary), a2.summary)
  check('T10', 'A2.9 DB CHECK', await hasConstraint('external_identifiers_exactly_one_target_chk'), 'exactly-one-target constraint present')

  // ---------------------------------------------------------------- owner suites (T11–T30)
  section('Existing owner suites — invoked at this exact head, never reimplemented')
  const ownerSuites: [string, string, string][] = [
    ['T11', 'strict dates', 'test:a3:strict-dates'],
    ['T12', 'A3.7 fail-closed translation', 'test:a3:date-gate'],
    ['T13', 'facility profile closure', 'test:a3:facility'],
    ['T14', 'commercial/context ancestry', 'test:a3:coherence'],
    ['T15', 'guarded write atomicity', 'test:a3:atomicity'],
    ['T16', 'ever-activated freeze', 'test:a3:lifecycle'],
    ['T17', 'RuleSource identity freeze', 'test:a3:identity'],
    ['T18', 'A3.4 graph concurrency', 'test:a3:concurrency'],
    ['T19', 'C35 dependency', 'test:a3:dependency'],
    ['T20', 'ReferenceDataset state', 'test:a3:dataset'],
    ['T21', 'ReferenceDataset history', 'test:a3:history'],
    ['T22', 'A3.8 base resolution', 'test:a3:resolution'],
    ['T23', 'A3.8 facility context', 'test:a3:facility-context'],
    ['T24', 'A3.8 candidate completeness', 'test:a3:candidate-set'],
    ['T25', 'A3.8 currentness', 'test:a3:currentness'],
    ['T26', 'A3.8 read snapshot', 'test:a3:snapshot'],
    ['T27', 'A3.8 historical dependency', 'test:a3:dependency-historical'],
    ['T28', 'A3.8 successor usability', 'test:a3:successor-usability'],
    ['T29', 'A3.9 pack focused suite', 'test:a3:rule-pack-http'],
    ['T30', 'A3.9 provenance focused suite', 'test:a3:provenance'],
  ]
  for (const [id, title, script] of ownerSuites) {
    const result = runSuite(script)
    check(id, title, result.ok, `${script}: ${result.summary} (${result.seconds}s)`)
  }

  // ---------------------------------------------------------------- cross-module scenarios (T31–T50)
  section('X01–X20 cross-module governance scenarios')
  // One API session drives both the scenario fixtures and the security checks below. Every valid
  // governed object is created through its owning route, so the scenarios exercise the same
  // boundaries a real caller would (§8).
  const signIn = async (email: string, password: string) => {
    const res = await callApi(baseUrl, '/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl },
      body: JSON.stringify({ email, password }),
    })
    return { status: res.status, cookie: extractCookieHeader(res.setCookies) }
  }
  await apiReady('the cross-module scenarios')
  const admin = await signIn(adminEmail, adminPassword)
  const viewer = await signIn(viewerEmail, viewerPassword)
  if (admin.status !== 200 || viewer.status !== 200) throw new Error(`integration sign-in failed (admin ${admin.status}, viewer ${viewer.status})`)
  const asAdmin = (init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers ?? {}), 'Content-Type': 'application/json', Cookie: admin.cookie } })
  const asViewer = (init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers ?? {}), 'Content-Type': 'application/json', Cookie: viewer.cookie } })

  const fx = apiFixtures(baseUrl, admin.cookie, org, runId)
  const actor = (await prisma.user.findUniqueOrThrow({ where: { email: bootstrapUserEmail } })).id

  // A rule is authored exactly as A3.5/A3.6/A3.7 require: draft version, applicability, bindings,
  // then verification last, because verification freezes the snapshot (H05).
  type RuleOptions = {
    version?: string
    effectType?: string
    effectiveFrom?: string | null
    effectiveTo?: string | null
    dimensions?: Record<string, string | null>
  }
  async function draftRule(name: string, options: RuleOptions = {}) {
    const rule = await fx.ruleDefinition(name)
    const ruleVersion = await fx.draftRuleVersion(rule.id, options.version ?? '1', options)
    const applicability = await fx.applicability(ruleVersion.id, options.dimensions ?? {})
    return { rule, ruleVersion, applicability }
  }

  const facility = await fx.facility()
  const profile = await fx.regulatoryProfile(facility.id, 'AE-DU', '2020-01-01')
  const chain = await fx.commercialChain(facility.id)
  const fullContext = {
    facilityId: facility.id,
    payerId: chain.payer.id,
    tpaId: chain.tpa.id,
    networkId: chain.network.id,
    insuranceProductId: chain.insuranceProduct.id,
    providerContractId: chain.providerContract.id,
    tariffScheduleId: chain.tariffSchedule.id,
    tariffScheduleVersionId: chain.tariffScheduleVersion.id,
    serviceId: chain.service.id,
    procedureCodeId: chain.procedureCode.id,
    diagnosisCodeId: chain.diagnosisCode.id,
  }

  const resolveBundle = async (ruleDefinitionId: string, date: string, context: Record<string, string | null> = fullContext) =>
    evaluateRuleResolutionBundle(ruleDefinitionId, date, context, { clock })
  const statusOf = (bundle: { ok: boolean } & Record<string, any>) => (bundle.ok ? bundle.value.resolution.resolutionStatus : `ERROR:${bundle.code}`)

  // X01 — the full Dubai-compatible chain.
  const main = await draftRule('x01-rule')
  const mainSource = await fx.verifiedSource('x01-gov', { activateOn: businessDate })
  const mainBinding = await fx.bind(main.ruleVersion.id, mainSource.interpretation.id)
  await fx.verifyRuleVersion(main.ruleVersion.id)
  const gate = await evaluateExecutability(main.ruleVersion.id, businessDate, gateInputs(fullContext))
  const x01 = await resolveBundle(main.rule.id, businessDate)
  const x01Pack = await (async () => {
    const pack = await createRulePack(org, `${runId}-pack`, 'A3.10 pack', 'AE-DU', actor)
    if (!pack.ok) throw new Error(pack.message)
    const version = await createRulePackVersion(pack.value.id, 'v1', '2026-01-01', null, false, actor)
    if (!version.ok) throw new Error(version.message)
    const member = await addRulePackMember(version.value.id, main.ruleVersion.id, actor)
    if (!member.ok) throw new Error(member.message)
    const verified = await verifyRulePackVersion(version.value.id, actor)
    if (!verified.ok) throw new Error(verified.message)
    const activated = await activateRulePackVersion(version.value.id, businessDate, actor)
    if (!activated.ok) throw new Error(activated.message)
    return { packId: pack.value.id, versionId: version.value.id }
  })()
  const x01Provenance = x01.ok ? await composeRuleDecisionProvenanceRefV1({ evaluation: x01.value, rulePackVersionId: x01Pack.versionId }) : null
  check(
    'T31',
    'X01 full governance chain',
    gate.ok &&
      gate.value.gateStatus === 'POTENTIALLY_ALLOWED' &&
      gate.value.nextGate === 'A3.8_PRECEDENCE' &&
      x01.ok &&
      x01.value.resolution.resolutionStatus === 'RESOLVED' &&
      x01.value.resolution.ruleVersionId === main.ruleVersion.id &&
      !!x01Provenance?.ok &&
      x01Provenance.value.ruleVersionId === main.ruleVersion.id &&
      x01Provenance.value.governingBindingId === mainBinding.id &&
      x01Provenance.value.matchedApplicabilityIds.includes(main.applicability.id) &&
      x01Provenance.value.context.facilityRegulatoryProfileId === profile.id &&
      x01Provenance.value.rulePackVersionId === x01Pack.versionId,
    `gate ${gate.ok ? gate.value.gateStatus : 'error'}, resolution ${statusOf(x01)}, provenance rule ${x01Provenance?.ok ? x01Provenance.value.ruleVersionId : 'none'}`,
  )

  // X02 — facility jurisdiction conflict.
  const foreignFacility = await fx.facility()
  await fx.regulatoryProfile(foreignFacility.id, 'AE-AZ', '2020-01-01')
  const x02 = await resolveBundle(main.rule.id, businessDate, { facilityId: foreignFacility.id })
  check(
    'T32',
    'X02 jurisdiction attack',
    x02.ok &&
      x02.value.resolution.resolutionStatus === 'BLOCKED_EXECUTABILITY' &&
      x02.value.resolution.governingSourceVersionId === null &&
      x02.value.resolution.governingBindingId === null &&
      x02.value.resolution.blockers.includes('JURISDICTION_INCOMPATIBLE'),
    `${statusOf(x02)}, blockers ${x02.ok ? x02.value.resolution.blockers.join(',') : ''}`,
  )

  // X03 — commercial ancestry contradiction (a tariff schedule from another contract).
  const otherChain = await fx.commercialChain()
  const x03 = await resolveBundle(main.rule.id, businessDate, { ...fullContext, tariffScheduleId: otherChain.tariffSchedule.id })
  check('T33', 'X03 commercial ancestry attack', !x03.ok && x03.code === 'VALIDATION_ERROR', `rejected before resolution: ${x03.ok ? 'RESOLVED' : x03.code}`)

  // X04 — supporting evidence can never govern.
  const supportingRule = await draftRule('x04-rule')
  const supportingSource = await fx.verifiedSource('x04-sup', { activateOn: businessDate })
  await fx.bind(supportingRule.ruleVersion.id, supportingSource.interpretation.id, 'SUPPORTING')
  await fx.verifyRuleVersion(supportingRule.ruleVersion.id)
  const x04Gate = await evaluateExecutability(supportingRule.ruleVersion.id, businessDate, gateInputs(fullContext))
  const x04 = await resolveBundle(supportingRule.rule.id, businessDate)
  check(
    'T34',
    'X04 supporting-only cannot govern',
    x04Gate.ok &&
      x04Gate.value.gateStatus === 'BLOCKED' &&
      x04Gate.value.nextGate === null &&
      x04.ok &&
      x04.value.resolution.governingBindingId === null &&
      x04.value.resolution.governingSourceVersionId === null &&
      x04.value.resolution.blockers.includes('MISSING_GOVERNING_SOURCE'),
    `gate ${x04Gate.ok ? x04Gate.value.gateStatus : 'error'}, resolution ${statusOf(x04)}`,
  )

  // X05 — an undated governing source fails closed in the public vocabulary. The version is
  // published and verified through its owner routes but has no effective date, so A3.3 never
  // activates it; that is exactly the state under test.
  const undatedRule = await draftRule('x05-rule')
  const undatedSource = await fx.verifiedSource('x05-gov', { effectiveFrom: null, activateOn: null })
  await fx.bind(undatedRule.ruleVersion.id, undatedSource.interpretation.id)
  await fx.verifyRuleVersion(undatedRule.ruleVersion.id)
  const x05 = await resolveBundle(undatedRule.rule.id, businessDate)
  const publicVocabulary = ['SOURCE_NOT_EFFECTIVE', 'MISSING_GOVERNING_SOURCE', 'SOURCE_NOT_ACTIVE', 'SOURCE_NOT_PUBLISHED', 'AUTHORITY_UNVERIFIED', 'INTERPRETATION_UNVERIFIED', 'JURISDICTION_INCOMPATIBLE', 'OWNERSHIP_MISMATCH', 'SOURCE_CONFLICT', 'DEPENDENCY_UNRESOLVED', 'SOURCE_SCOPE_MISMATCH', 'SOURCE_SCOPE_INCOMPLETE', 'EFFECT_INCOMPATIBLE', 'SOURCE_CATEGORY_INCOMPATIBLE', 'CONTEXT_INCOMPLETE']
  check(
    'T35',
    'X05 source invalid/undated',
    x05.ok &&
      x05.value.resolution.governingSourceVersionId === null &&
      x05.value.resolution.blockers.length > 0 &&
      x05.value.resolution.blockers.every((code) => publicVocabulary.includes(code)),
    `${statusOf(x05)}, blockers ${x05.ok ? x05.value.resolution.blockers.join(',') : ''}`,
  )

  // X06 — a rule that is not effective on the business date.
  const expiredRule = await draftRule('x06-rule', { effectiveFrom: '2024-01-01', effectiveTo: '2024-12-31' })
  const expiredRuleSource = await fx.verifiedSource('x06-gov', { activateOn: businessDate })
  await fx.bind(expiredRule.ruleVersion.id, expiredRuleSource.interpretation.id)
  await fx.verifyRuleVersion(expiredRule.ruleVersion.id)
  const x06 = await resolveBundle(expiredRule.rule.id, businessDate)
  const x06Provenance = x06.ok ? await composeRuleDecisionProvenanceRefV1({ evaluation: x06.value }) : null
  check(
    'T36',
    'X06 rule not effective',
    x06.ok && x06.value.resolution.resolutionStatus === 'NO_MATCH' && x06.value.resolution.ruleVersionId === null && !!x06Provenance && !x06Provenance.ok && x06Provenance.error.code === 'RESOLUTION_NOT_RESOLVED',
    `${statusOf(x06)}, provenance ${x06Provenance && !x06Provenance.ok ? x06Provenance.error.code : 'produced'}`,
  )

  // X07 — explicit supersession, answered as of the business date. The predecessor becomes
  // SUPERSEDED the way A3.3/A3.4 intend: by activating the successor that supersedes it.
  const supersedeRule = await draftRule('x07-rule')
  const predecessor = await fx.verifiedSource('x07-s1', { activateOn: businessDate })
  const successor = await fx.verifiedSource('x07-s2', { effectiveFrom: '2026-06-01', activateOn: null })
  await fx.bind(supersedeRule.ruleVersion.id, predecessor.interpretation.id)
  await fx.bind(supersedeRule.ruleVersion.id, successor.interpretation.id)
  await fx.verifyRuleVersion(supersedeRule.ruleVersion.id)
  await fx.relate(successor.sourceVersion.id, predecessor.sourceVersion.id, 'SUPERSEDES')
  await fx.activateSourceVersion(successor.sourceVersion.id, '2026-08-15')
  const beforeSuccessor = await resolveBundle(supersedeRule.rule.id, '2026-03-15')
  const afterSuccessor = await resolveBundle(supersedeRule.rule.id, '2026-08-15')
  const predecessorRow = await prisma.ruleSourceVersion.findUniqueOrThrow({ where: { id: predecessor.sourceVersion.id } })
  check(
    'T37',
    'X07 explicit historical supersession',
    beforeSuccessor.ok &&
      beforeSuccessor.value.resolution.governingSourceVersionId === predecessor.sourceVersion.id &&
      afterSuccessor.ok &&
      afterSuccessor.value.resolution.governingSourceVersionId === successor.sourceVersion.id &&
      predecessorRow.activationStatus === 'SUPERSEDED',
    `before: ${beforeSuccessor.ok && beforeSuccessor.value.resolution.governingSourceVersionId === predecessor.sourceVersion.id ? 'predecessor' : 'other'}; after: ${afterSuccessor.ok && afterSuccessor.value.resolution.governingSourceVersionId === successor.sourceVersion.id ? 'successor' : 'other'}; predecessor now ${predecessorRow.activationStatus}`,
  )

  // X08 — an unusable successor in force blocks; an unrelated candidate must not inherit the win.
  const unusableRule = await draftRule('x08-rule')
  const s1 = await fx.verifiedSource('x08-s1', { activateOn: businessDate })
  const unusableS2 = await fx.verifiedSource('x08-s2', { effectiveFrom: '2026-01-01', activateOn: null })
  const unrelatedB = await fx.verifiedSource('x08-b', { activateOn: businessDate })
  for (const source of [s1, unusableS2, unrelatedB]) await fx.bind(unusableRule.ruleVersion.id, source.interpretation.id)
  await fx.verifyRuleVersion(unusableRule.ruleVersion.id)
  await fx.relate(unusableS2.sourceVersion.id, s1.sourceVersion.id, 'SUPERSEDES')
  const x08 = await resolveBundle(unusableRule.rule.id, businessDate)
  check(
    'T38',
    'X08 unusable successor + unrelated candidate',
    x08.ok &&
      x08.value.resolution.resolutionStatus === 'BLOCKED_SOURCE_PRECEDENCE_CONFLICT' &&
      x08.value.resolution.blockers.includes('SUPERSEDES_SUCCESSOR_UNUSABLE') &&
      x08.value.resolution.governingSourceVersionId === null,
    `${statusOf(x08)}, blockers ${x08.ok ? x08.value.resolution.blockers.join(',') : ''}`,
  )

  // X09 — an expired successor no longer suppresses its predecessor. Two rules, because a verified
  // RuleVersion is frozen and the unrelated candidate must be bound before verification.
  const expiredAloneRule = await draftRule('x09-alone')
  const e1 = await fx.verifiedSource('x09-s1', { activateOn: businessDate })
  const e2 = await fx.verifiedSource('x09-s2', { effectiveFrom: '2025-06-01', effectiveTo: '2025-12-31', activateOn: null })
  await fx.bind(expiredAloneRule.ruleVersion.id, e1.interpretation.id)
  await fx.bind(expiredAloneRule.ruleVersion.id, e2.interpretation.id)
  await fx.verifyRuleVersion(expiredAloneRule.ruleVersion.id)
  await fx.relate(e2.sourceVersion.id, e1.sourceVersion.id, 'SUPERSEDES')
  const x09Alone = await resolveBundle(expiredAloneRule.rule.id, businessDate)

  const expiredTieRule = await draftRule('x09-tie')
  const t1 = await fx.verifiedSource('x09-t1', { activateOn: businessDate })
  const t2 = await fx.verifiedSource('x09-t2', { effectiveFrom: '2025-06-01', effectiveTo: '2025-12-31', activateOn: null })
  const tieB = await fx.verifiedSource('x09-tb', { activateOn: businessDate })
  for (const source of [t1, t2, tieB]) await fx.bind(expiredTieRule.ruleVersion.id, source.interpretation.id)
  await fx.verifyRuleVersion(expiredTieRule.ruleVersion.id)
  await fx.relate(t2.sourceVersion.id, t1.sourceVersion.id, 'SUPERSEDES')
  const x09WithB = await resolveBundle(expiredTieRule.rule.id, businessDate)
  check(
    'T39',
    'X09 expired successor boundary',
    x09Alone.ok &&
      x09Alone.value.resolution.governingSourceVersionId === e1.sourceVersion.id &&
      x09WithB.ok &&
      x09WithB.value.resolution.resolutionStatus === 'BLOCKED_SOURCE_PRECEDENCE_CONFLICT' &&
      x09WithB.value.resolution.governingSourceVersionId === null,
    `alone: ${statusOf(x09Alone)} (predecessor answers); with an unrelated candidate: ${statusOf(x09WithB)} — no auto-win`,
  )

  // X10 — DEPENDS_ON lifecycle, never precedence.
  const dependencyRule = await draftRule('x10-rule')
  const dependent = await fx.verifiedSource('x10-gov', { activateOn: businessDate })
  const dependencyTarget = await fx.verifiedSource('x10-target', { activateOn: businessDate })
  await fx.bind(dependencyRule.ruleVersion.id, dependent.interpretation.id)
  await fx.verifyRuleVersion(dependencyRule.ruleVersion.id)
  await fx.relate(dependent.sourceVersion.id, dependencyTarget.sourceVersion.id, 'DEPENDS_ON')
  const dependencyActive = await resolveBundle(dependencyRule.rule.id, businessDate)
  await fx.suspendSourceVersion(dependencyTarget.sourceVersion.id)
  const dependencyBroken = await resolveBundle(dependencyRule.rule.id, businessDate)
  check(
    'T40',
    'X10 dependency lifecycle',
    dependencyActive.ok &&
      dependencyActive.value.resolution.resolutionStatus === 'RESOLVED' &&
      dependencyBroken.ok &&
      dependencyBroken.value.resolution.governingSourceVersionId === null &&
      dependencyBroken.value.resolution.blockers.includes('DEPENDENCY_UNRESOLVED'),
    `ACTIVE target: ${statusOf(dependencyActive)}; SUSPENDED target: ${statusOf(dependencyBroken)}`,
  )

  // X11 — a conflict between two surviving candidates fails closed.
  const conflictRule = await draftRule('x11-rule')
  const c1 = await fx.verifiedSource('x11-c1', { activateOn: businessDate })
  const c2 = await fx.verifiedSource('x11-c2', { activateOn: businessDate })
  await fx.bind(conflictRule.ruleVersion.id, c1.interpretation.id)
  await fx.bind(conflictRule.ruleVersion.id, c2.interpretation.id)
  await fx.verifyRuleVersion(conflictRule.ruleVersion.id)
  await fx.relate(c1.sourceVersion.id, c2.sourceVersion.id, 'CONFLICTS_WITH')
  const x11 = await resolveBundle(conflictRule.rule.id, businessDate)
  check(
    'T41',
    'X11 source conflict',
    x11.ok && x11.value.resolution.governingBindingId === null && x11.value.resolution.governingSourceVersionId === null && x11.value.resolution.blockers.includes('SOURCE_CONFLICT'),
    `${statusOf(x11)}, blockers ${x11.ok ? x11.value.resolution.blockers.join(',') : ''}`,
  )

  // X12 — two RuleVersions of equal specificity block; no version/date/UUID tie-break.
  const tieRule = await fx.ruleDefinition('x12-rule')
  const tieVersions = []
  for (const label of ['1', '2']) {
    const version = await fx.draftRuleVersion(tieRule.id, label)
    await fx.applicability(version.id, { payerId: chain.payer.id })
    const source = await fx.verifiedSource(`x12-${label}`, { activateOn: businessDate })
    await fx.bind(version.id, source.interpretation.id)
    await fx.verifyRuleVersion(version.id)
    tieVersions.push(version)
  }
  const x12 = await resolveBundle(tieRule.id, businessDate)
  check(
    'T42',
    'X12 RuleVersion specificity tie',
    x12.ok && x12.value.resolution.resolutionStatus === 'BLOCKED_RULE_VERSION_CONFLICT' && x12.value.resolution.ruleVersionId === null,
    `${statusOf(x12)} — neither version 1 nor version 2 was picked (${tieVersions.length} tied versions)`,
  )

  // X13 — historicalOnly follows the merged A3.8 currentness contract exactly.
  const currentResult = await resolveBundle(main.rule.id, businessDate)
  const historicalRule = await draftRule('x13-rule', { effectiveFrom: '2025-01-01', effectiveTo: '2025-12-31' })
  const historicalSource = await fx.verifiedSource('x13-gov', { effectiveFrom: '2025-01-01', activateOn: '2025-06-15' })
  await fx.bind(historicalRule.ruleVersion.id, historicalSource.interpretation.id)
  await fx.verifyRuleVersion(historicalRule.ruleVersion.id)
  const historicalResult = await resolveBundle(historicalRule.rule.id, '2025-06-15', {})
  check(
    'T43',
    'X13 historicalOnly truth',
    currentResult.ok &&
      currentResult.value.resolution.historicalOnly === false &&
      historicalResult.ok &&
      historicalResult.value.resolution.resolutionStatus === 'RESOLVED' &&
      historicalResult.value.resolution.historicalOnly === true,
    'current evaluation false; a past businessDate on an expired rule true',
  )

  // X14 — REFERENCE_ONLY is clean only in a compatible context.
  const referenceRule = await draftRule('x14-rule', { effectType: 'REFERENCE_ONLY' })
  const referenceSource = await fx.verifiedSource('x14-src', { category: 'CLINICAL_STANDARD', activateOn: businessDate })
  await fx.bind(referenceRule.ruleVersion.id, referenceSource.interpretation.id)
  await fx.verifyRuleVersion(referenceRule.ruleVersion.id)
  const referenceOk = await resolveBundle(referenceRule.rule.id, businessDate)
  const referenceMismatch = await resolveBundle(referenceRule.rule.id, businessDate, { facilityId: foreignFacility.id })
  check(
    'T44',
    'X14 REFERENCE_ONLY context',
    referenceOk.ok &&
      referenceOk.value.resolution.resolutionStatus === 'REFERENCE_ONLY' &&
      referenceOk.value.resolution.blockers.length === 0 &&
      referenceMismatch.ok &&
      referenceMismatch.value.resolution.resolutionStatus !== 'REFERENCE_ONLY' &&
      referenceMismatch.value.resolution.blockers.includes('JURISDICTION_INCOMPATIBLE'),
    `compatible: ${statusOf(referenceOk)}; mismatched facility: ${statusOf(referenceMismatch)}`,
  )

  // X15 / X16 — exact pack membership, and a mismatch that fails closed.
  check(
    'T45',
    'X15 pack exact membership',
    !!x01Provenance?.ok && x01Provenance.value.rulePackId === x01Pack.packId && x01Provenance.value.ruleVersionId === (x01.ok ? x01.value.resolution.ruleVersionId : null),
    'the composer kept the A3.8 winner and added the exact pack version',
  )
  const nonMemberPackVersion = await (async () => {
    const otherRule = await draftRule('x16-other')
    await fx.verifyRuleVersion(otherRule.ruleVersion.id)
    const pack = await createRulePack(org, `${runId}-other-pack`, 'A3.10 other pack', 'AE-DU', actor)
    if (!pack.ok) throw new Error(pack.message)
    const version = await createRulePackVersion(pack.value.id, 'v1', '2026-01-01', null, false, actor)
    if (!version.ok) throw new Error(version.message)
    const member = await addRulePackMember(version.value.id, otherRule.ruleVersion.id, actor)
    if (!member.ok) throw new Error(member.message)
    await verifyRulePackVersion(version.value.id, actor)
    await activateRulePackVersion(version.value.id, businessDate, actor)
    return version.value.id
  })()
  const x16 = x01.ok ? await composeRuleDecisionProvenanceRefV1({ evaluation: x01.value, rulePackVersionId: nonMemberPackVersion }) : null
  check('T46', 'X16 pack membership mismatch', !!x16 && !x16.ok && x16.error.code === 'PACK_MEMBERSHIP_MISMATCH', 'no provenance produced')

  // X17 — a historical pack version never changes A3.8 historicalOnly.
  const successorPackVersion = await createRulePackVersion(x01Pack.packId, 'v2', '2026-01-01', null, false, actor)
  if (!successorPackVersion.ok) throw new Error(successorPackVersion.message)
  await addRulePackMember(successorPackVersion.value.id, main.ruleVersion.id, actor)
  await verifyRulePackVersion(successorPackVersion.value.id, actor)
  await activateRulePackVersion(successorPackVersion.value.id, businessDate, actor)
  const supersededPack = await prisma.rulePackVersion.findUniqueOrThrow({ where: { id: x01Pack.versionId } })
  const x17 = x01.ok ? await composeRuleDecisionProvenanceRefV1({ evaluation: x01.value, rulePackVersionId: x01Pack.versionId }) : null
  check(
    'T47',
    'X17 historical pack semantics',
    supersededPack.activationStatus === 'SUPERSEDED' && !!x17?.ok && x17.value.historicalOnly === (x01.ok ? x01.value.resolution.historicalOnly : true) && x17.value.historicalOnly === false && x17.value.rulePackVersionId === x01Pack.versionId,
    'SUPERSEDED pack recorded; historicalOnly still false',
  )

  // X18 — the evaluation bundle cannot be mixed.
  const otherEvaluation = await resolveBundle(main.rule.id, businessDate, { facilityId: facility.id })
  const mixes: [string, unknown][] = x01.ok && otherEvaluation.ok
    ? [
        ['context from another evaluation', { ...x01.value, authoritativeContext: otherEvaluation.value.authoritativeContext }],
        ['timestamp from another evaluation', { ...x01.value, evaluationTimestamp: new Date('2020-01-01T00:00:00.000Z') }],
        ['organization swapped', { ...x01.value, organizationId: otherOrg }],
        ['hand-built copy of a real bundle', structuredClone(x01.value)],
      ]
    : []
  const mixResults = []
  for (const [, spliced] of mixes) {
    const outcome = await composeRuleDecisionProvenanceRefV1({ evaluation: spliced as RuleResolutionEvaluationBundle })
    mixResults.push(!outcome.ok && outcome.error.code === 'PROVENANCE_INVARIANT_VIOLATION')
  }
  check('T48', 'X18 evaluation bundle integrity', mixes.length === 4 && mixResults.every(Boolean), 'context / timestamp / organization / copied bundle all rejected')

  // X19 — no dataset is claimed that A3.8 did not use.
  check('T49', 'X19 dataset provenance truth', !!x01Provenance?.ok && Array.isArray(x01Provenance.value.referenceDatasetVersionIds) && x01Provenance.value.referenceDatasetVersionIds.length === 0, 'referenceDatasetVersionIds = []')

  // X20 — evaluation and composition write nothing.
  const beforeCounts = {
    audit: await auditCount(),
    ruleVersions: await prisma.ruleVersion.count(),
    bindings: await prisma.ruleSourceBinding.count(),
    packMembers: await prisma.rulePackMember.count(),
  }
  const storedRuleVersion = await prisma.ruleVersion.findUniqueOrThrow({ where: { id: main.ruleVersion.id } })
  for (let i = 0; i < 3; i += 1) {
    await evaluateRuleResolution(main.rule.id, businessDate, fullContext, { clock })
    const repeat = await resolveBundle(main.rule.id, businessDate)
    if (repeat.ok) await composeRuleDecisionProvenanceRefV1({ evaluation: repeat.value, rulePackVersionId: successorPackVersion.value.id })
  }
  const afterCounts = {
    audit: await auditCount(),
    ruleVersions: await prisma.ruleVersion.count(),
    bindings: await prisma.ruleSourceBinding.count(),
    packMembers: await prisma.rulePackMember.count(),
  }
  const decisionTables = await prisma.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND (table_name ILIKE '%decision%' OR table_name ILIKE '%workflow%')`
  check(
    'T50',
    'X20 read-only evaluation',
    JSON.stringify(beforeCounts) === JSON.stringify(afterCounts) &&
      (await prisma.ruleVersion.findUniqueOrThrow({ where: { id: main.ruleVersion.id } })).updatedAt.getTime() === storedRuleVersion.updatedAt.getTime() &&
      decisionTables.length === 0,
    `audit before=${beforeCounts.audit} after=${afterCounts.audit}; no decision table`,
  )

  // ---------------------------------------------------------------- security / tenancy (T51–T59)
  section('Security, tenancy and audit truth over the API')
  const adminCreate = await callApi(baseUrl, `/api/organizations/${org}/rule-sources`, asAdmin({
    method: 'POST',
    body: JSON.stringify({ jurisdictionCode: 'AE-DU', issuingAuthority: 'DHA', sourceCategory: 'REGULATORY_AUTHORITY', referenceNumber: `${runId}-S51`, title: 'A3.10 admin source' }),
  }))
  const adminRead = await callApi(baseUrl, `/api/organizations/${org}/rule-sources`, asAdmin())
  check('T51', 'admin own-org', admin.status === 200 && adminCreate.status === 201 && adminRead.status === 200, `create ${adminCreate.status}, list ${adminRead.status}`)

  const viewerRead = await callApi(baseUrl, `/api/organizations/${org}/rule-packs`, asViewer())
  const viewerReadSources = await callApi(baseUrl, `/api/organizations/${org}/rule-sources`, asViewer())
  check('T52', 'viewer reads', viewer.status === 200 && viewerRead.status === 200 && viewerReadSources.status === 200, `packs ${viewerRead.status}, sources ${viewerReadSources.status}`)

  const auditBeforeDenials = await auditCount()
  const viewerWrite = await callApi(baseUrl, `/api/organizations/${org}/rule-packs`, asViewer({
    method: 'POST',
    body: JSON.stringify({ packKey: `${runId}-viewer`, displayName: 'denied', jurisdictionCode: 'AE-DU' }),
  }))
  check('T53', 'viewer writes denied', viewerWrite.status === 403, `status ${viewerWrite.status}`)

  const crossTenantSource = await callApi(baseUrl, `/api/organizations/${otherOrg}/rule-sources`, asAdmin())
  const crossTenantPack = await callApi(baseUrl, `/api/organizations/${otherOrg}/rule-packs`, asAdmin())
  const crossTenantRule = await callApi(baseUrl, `/api/organizations/${otherOrg}/rule-definitions`, asAdmin())
  check(
    'T54',
    'cross-tenant denial',
    crossTenantSource.status === 403 && crossTenantPack.status === 403 && crossTenantRule.status === 403 && JSON.stringify([crossTenantSource.body, crossTenantPack.body, crossTenantRule.body]).includes('error'),
    `sources ${crossTenantSource.status}, packs ${crossTenantPack.status}, rules ${crossTenantRule.status}; no records disclosed`,
  )

  const sharedPack = await prisma.rulePack.findFirst({ where: { organizationId: null } })
  const sharedWrite = sharedPack ? await callApi(baseUrl, `/api/rule-packs/${sharedPack.id}`, asAdmin({ method: 'PATCH', body: JSON.stringify({ displayName: 'tenant edit' }) })) : null
  check('T55', 'SYSTEM_SHARED write boundary', sharedPack === null || (sharedWrite !== null && sharedWrite.status >= 400 && sharedWrite.status < 500), sharedPack ? `status ${sharedWrite?.status}` : 'no SYSTEM_SHARED pack exists to mutate')

  // ADVERSARIAL FIXTURE (deliberate owner-boundary bypass): this RuleVersion belongs to ANOTHER
  // organization, which this tenant's routes correctly refuse to author. It exists only so the
  // membership route can be shown to deny it, and nothing here is presented as a valid flow.
  const foreignRuleVersion = await (async () => {
    const foreignRule = await prisma.ruleDefinition.create({
      data: { organizationId: otherOrg, ruleKey: `${runId}-foreign`, displayName: 'A3.10 foreign rule', jurisdictionCode: 'AE-DU', ownershipScope: 'ORGANIZATION' },
    })
    return prisma.ruleVersion.create({
      data: { ruleId: foreignRule.id, version: '1', effectType: 'AUTHORIZATION_REQUIREMENT_EFFECT', effectiveFrom: new Date('2020-01-01T00:00:00.000Z'), verificationStatus: 'VERIFIED', verifiedAt: new Date() },
    })
  })()
  const draftPackVersion = await (async () => {
    const pack = await createRulePack(org, `${runId}-member-check`, 'A3.10 member check', 'AE-DU', actor)
    if (!pack.ok) throw new Error(pack.message)
    const version = await createRulePackVersion(pack.value.id, 'v1', null, null, false, actor)
    if (!version.ok) throw new Error(version.message)
    return version.value.id
  })()
  const foreignMember = await callApi(baseUrl, `/api/rule-pack-versions/${draftPackVersion}/members`, asAdmin({ method: 'POST', body: JSON.stringify({ ruleVersionId: foreignRuleVersion.id }) }))
  check('T56', 'foreign pack member', foreignMember.status === 403, `status ${foreignMember.status}`)

  const malformed = [
    await callApi(baseUrl, '/api/rule-packs/not-a-uuid', asAdmin()),
    await callApi(baseUrl, `/api/organizations/${org}/rule-packs`, asAdmin({ method: 'POST', body: '{' })),
    await callApi(baseUrl, `/api/rule-definitions/not-a-uuid/resolution/evaluate`, asAdmin({ method: 'POST', body: JSON.stringify({ businessDate }) })),
    await callApi(baseUrl, '/api/definitely-unknown-route', asAdmin()),
  ]
  check(
    'T57',
    'malformed routes/bodies',
    malformed.every((res) => res.status >= 400 && res.status < 500) && !JSON.stringify(malformed.map((res) => res.body)).match(/prisma|stack|at Object|sql/i),
    `statuses ${malformed.map((res) => res.status).join(',')}; no internals leaked`,
  )

  const createdSourceId = adminCreate.body?.id
  const patched = createdSourceId ? await callApi(baseUrl, `/api/rule-sources/${createdSourceId}`, asAdmin({ method: 'PATCH', body: JSON.stringify({ title: 'A3.10 renamed source' }) })) : null
  const auditRows = createdSourceId
    ? await prisma.auditEvent.findMany({ where: { organizationId: org, entityId: createdSourceId }, orderBy: { occurredAt: 'asc' } })
    : []
  const createEvent = auditRows.find((row) => row.actionCode.endsWith('.created'))
  const updateEvent = auditRows.find((row) => row.actionCode.endsWith('.updated'))
  check(
    'T58',
    'audit create/update truth',
    patched?.status === 200 &&
      !!createEvent &&
      createEvent.beforeState === null &&
      (createEvent.afterState as any)?.title === 'A3.10 admin source' &&
      !!updateEvent &&
      (updateEvent.beforeState as any)?.title === 'A3.10 admin source' &&
      (updateEvent.afterState as any)?.title === 'A3.10 renamed source',
    'create has no beforeState; update records the exact previous title',
  )

  const auditBeforeInvalid = await auditCount()
  await callApi(baseUrl, `/api/organizations/${org}/rule-packs`, asViewer({ method: 'POST', body: JSON.stringify({ packKey: `${runId}-deny2`, displayName: 'x', jurisdictionCode: 'AE-DU' }) }))
  await callApi(baseUrl, `/api/organizations/${org}/rule-sources`, asAdmin({ method: 'POST', body: JSON.stringify({ jurisdictionCode: '', issuingAuthority: '', sourceCategory: 'REGULATORY_AUTHORITY', referenceNumber: '', title: '' }) }))
  await callApi(baseUrl, `/api/rule-pack-versions/${draftPackVersion}/members`, asAdmin({ method: 'POST', body: JSON.stringify({ ruleVersionId: foreignRuleVersion.id }) }))
  const auditAfterInvalid = await auditCount()
  check('T59', 'no false audit', auditAfterInvalid === auditBeforeInvalid, `before=${auditBeforeInvalid} after=${auditAfterInvalid} (denied and invalid mutations)`)
  void auditBeforeDenials

  // ---------------------------------------------------------------- history / immutability (T60–T64)
  section('Historical truth and immutability')
  const evidenceVersion = await prisma.ruleSourceVersion.findUniqueOrThrow({ where: { id: mainSource.sourceVersion.id } })
  const evidenceInterpretation = await prisma.sourceInterpretation.findUniqueOrThrow({ where: { id: mainSource.interpretation.id } })
  check(
    'T60',
    'source/evidence separation',
    typeof evidenceVersion.rawEvidenceRef === 'string' &&
      evidenceVersion.rawEvidenceRef.length > 0 &&
      typeof evidenceInterpretation.normalizedInterpretationRef === 'string' &&
      evidenceInterpretation.normalizedInterpretationRef !== evidenceVersion.rawEvidenceRef &&
      evidenceInterpretation.sourceVersionId === evidenceVersion.id,
    'raw evidence and reviewed interpretation remain distinct and versioned',
  )

  const supersededStillReadable = await prisma.ruleSourceVersion.findUnique({ where: { id: predecessor.sourceVersion.id } })
  const historicalRuleVersion = await prisma.ruleVersion.findUnique({ where: { id: historicalRule.ruleVersion.id } })
  check(
    'T61',
    'no hard delete history',
    supersededStillReadable !== null && supersededStillReadable.activationStatus === 'SUPERSEDED' && historicalRuleVersion !== null && (beforeSuccessor.ok ? beforeSuccessor.value.resolution.governingSourceVersionId === predecessor.sourceVersion.id : false),
    'superseded source version and historical rule version remain retrievable',
  )

  const frozenMemberAdd = await addRulePackMember(x01Pack.versionId, historicalRule.ruleVersion.id, actor)
  const frozenDateChange = await callApi(baseUrl, `/api/rule-pack-versions/${x01Pack.versionId}`, asAdmin({ method: 'PATCH', body: JSON.stringify({ effectiveTo: '2026-12-31' }) }))
  const packMembersAfter = await prisma.rulePackMember.findMany({ where: { rulePackVersionId: x01Pack.versionId } })
  check(
    'T62',
    'pack immutability',
    !frozenMemberAdd.ok && frozenDateChange.status === 400 && packMembersAfter.length === 1 && packMembersAfter[0].ruleVersionId === main.ruleVersion.id,
    'a superseded pack version rejects member and date changes',
  )

  const activePackVersions = await prisma.rulePackVersion.groupBy({ by: ['rulePackId'], where: { activationStatus: 'ACTIVE' }, _count: { _all: true } })
  const packStructures = {
    ownership: await hasConstraint('rule_packs_ownership_scope_chk'),
    scopedKey: await hasIndex('rule_packs_scope_pack_key_uq'),
    versionKey: await hasIndex('rule_pack_versions_rule_pack_id_version_key'),
    oneActive: await hasIndex('rule_pack_versions_one_active_uq'),
    membership: await hasIndex('rule_pack_members_rule_pack_version_id_rule_version_id_key'),
    restrictiveFks: (await foreignKeyDeleteRules('rule_pack_members')).every((rule) => rule === 'r'),
  }
  check(
    'T63',
    'one ACTIVE pack',
    Object.values(packStructures).every(Boolean) && activePackVersions.every((row) => row._count._all === 1),
    `ownership CHECK, scoped packKey, version uniqueness, one-ACTIVE index, membership uniqueness and RESTRICT FKs all present; ${activePackVersions.length} packs each hold exactly one ACTIVE version`,
  )

  const activeDatasetVersions = await prisma.referenceDatasetVersion.groupBy({ by: ['datasetId'], where: { activationStatus: 'ACTIVE' }, _count: { _all: true } })
  const invalidActiveDatasets = await prisma.referenceDatasetVersion.count({ where: { activationStatus: 'ACTIVE', NOT: { validationStatus: 'VALIDATED' } } })
  check(
    'T64',
    'one ACTIVE dataset',
    (await hasIndex('reference_dataset_versions_one_active_uq')) &&
      (await hasConstraint('reference_dataset_versions_active_implies_validated_chk')) &&
      (await hasTrigger('reference_dataset_lifecycle_events_append_only_trg')) &&
      activeDatasetVersions.every((row) => row._count._all === 1) &&
      invalidActiveDatasets === 0,
    `one ACTIVE per dataset across ${activeDatasetVersions.length} datasets; every ACTIVE version is VALIDATED; dataset history trigger present`,
  )

  // ---------------------------------------------------------------- scope guards (T65–T68)
  section('Scope guards — nothing from A4+ has leaked into A3')
  const scopeSuite = runSuite('test:a3:scope')
  const modelNames = (await prisma.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`).map((row) => row.table_name)
  check('T65', 'no generic rules engine', scopeSuite.ok && !modelNames.some((name) => /decision|workflow|expression|dsl/i.test(name)), `A3.9 scope suite: ${scopeSuite.summary}`)
  const a4TableNames = ['patients', 'patient_identifiers', 'insurance_memberships', 'coverage_members', 'encounters', 'encounter_lines']
  const a4Tables = modelNames.filter((name) => a4TableNames.includes(name.toLowerCase()))
  const a4Routes = gitGrep('/api/(patients|encounters|insurance-memberships|coverage-members)', ['backend/src', 'frontend/src'])
  check(
    'T66',
    'no A4 entities',
    a4Tables.length === 0 && !a4Routes.matched && a4Routes.failed === null,
    a4Routes.failed ?? 'no Patient / InsuranceMembership / Encounter table or route (A1 membership_roles is RBAC, not A4)',
  )
  const a5Tables = modelNames.filter((name) => /^(claims|claim_lines|claim_submissions|remittances|payments|payment_allocations|authorization_requests|eligibility_verifications)$/i.test(name))
  check('T67', 'no A5+ runtime', a5Tables.length === 0, 'no eligibility / authorization / claim / payment execution schema')
  const realIntegration = gitGrep('(dhpo|eclaimlink|dha_(api|client|secret)|payer_api_key|shafafiya)', ['backend/src', 'frontend/src'])
  check(
    'T68',
    'no real integration',
    !realIntegration.matched && realIntegration.failed === null,
    realIntegration.failed ?? 'no DHA/DHPO/eClaimLink credentials or endpoints in source',
  )

  // ---------------------------------------------------------------- build gates (T69–T72)
  section('Unit, typecheck, frontend build and repeatability')
  const unit = runSuite('test:unit')
  check('T69', 'unit tests', unit.ok, unit.summary)
  const typecheck = runSuite('typecheck')
  check('T70', 'backend typecheck', typecheck.ok, typecheck.ok ? 'clean' : typecheck.summary)
  const build = runSuite('build', frontendDir)
  check('T71', 'frontend production build', build.ok, build.summary)

  const priorRuns = await prisma.ruleDefinition.findMany({ where: { ruleKey: { startsWith: 'A310-' }, NOT: { ruleKey: { startsWith: runId } } }, select: { ruleKey: true } })
  const priorRunIds = new Set(priorRuns.map((row) => row.ruleKey.split('-').slice(0, 2).join('-')))
  if (priorRunIds.size === 0)
    exception('T72', 'harness repeatability', 'this is the first A3.10 run in this database; run the harness again to prove repeatability with fresh synthetic IDs')
  else
    check('T72', 'harness repeatability', true, `${priorRunIds.size} earlier A3.10 run(s) present; this run used fresh IDs (${runId})`)

  // ---------------------------------------------------------------- git / evidence (T73–T76)
  section('Git scope and same-SHA evidence')
  const changed = git(`diff --name-only ${a39Merge} HEAD`).split(/\r?\n/).filter(Boolean)
  const working = git('status --porcelain').split(/\r?\n/).filter(Boolean).map((line) => line.slice(3))
  const allPaths = [...changed, ...working]
  const outOfScope = allPaths.filter((path) => !path.startsWith('backend/src/integration/a3-governance/') && path !== 'backend/package.json')
  check('T73', 'git scope', outOfScope.length === 0, outOfScope.length === 0 ? `${allPaths.length} path(s), acceptance harness only` : `unexpected: ${outOfScope.join(', ')}`)
  const cleanTree = git('status --porcelain') === ''
  if (cleanTree) check('T74', 'git clean', true, 'working tree clean')
  else exception('T74', 'git clean', `harness not committed yet: ${working.join(', ')} — rerun after the A3.10 commit for the final evidence`)
  const headAtEnd = git('rev-parse HEAD')
  check('T75', 'same-SHA evidence', headAtStart === headAtEnd && headAtStart.length === 40, `HEAD unchanged during the run: ${headAtEnd}`)
  const mergeBase = git(`merge-base ${a39Merge} HEAD`)
  check('T76', 'PR targets main', mergeBase === a39Merge && branch === 'feature/a3-10-a3-integration-acceptance' && outOfScope.length === 0, 'single A3.10 branch off the merged main; no stacked A4 work')

  report.finish(runId, headAtStart, headAtEnd)
}

main()
  .catch((error) => {
    console.error('[A3.10] uncaught error (this itself is a FAIL):', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
