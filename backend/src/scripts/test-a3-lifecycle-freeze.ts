import 'dotenv/config'
import { prisma } from '../shared/database/prisma.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../shared/testing/concurrency-probe.ts'
import {
  activateRuleSourceVersion,
  resumeRuleSourceVersion,
  suspendRuleSourceVersion,
  updateLifecycleMetadata,
} from '../modules/rule-source-version/rule-source-version.service.ts'

// Audit F09 / C28 — ACTIVE -> SUSPENDED -> failed resume must not unlock the effective dates of a
// version that was already governing, and repeated lifecycle operations must not erase the original
// activation evidence.

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
  console.log(`\n[a3-lifecycle] ${title}`)
}

const tag = `A3LF-${Date.now()}`
const organizationId = process.env.AUTHZ_BOOTSTRAP_ORGANIZATION_ID
const userEmail = process.env.AUTHZ_BOOTSTRAP_USER_EMAIL

function d(text: string): Date {
  return new Date(`${text}T00:00:00.000Z`)
}

function day(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null
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

async function main() {
  if (!organizationId || !userEmail) throw new Error('AUTHZ_BOOTSTRAP_ORGANIZATION_ID and AUTHZ_BOOTSTRAP_USER_EMAIL are required')
  const org = organizationId
  const actor = (await prisma.user.findUniqueOrThrow({ where: { email: userEmail } })).id
  console.log(`[a3-lifecycle] run tag ${tag} — organization ${org}`)

  // A fully activatable source version: PUBLISHED, VERIFIED, dated, with a VERIFIED interpretation.
  async function activatableVersion(name: string, effectiveTo: string | null = '2030-12-31') {
    const source = await prisma.ruleSource.create({
      data: {
        organizationId: org,
        jurisdictionCode: 'AE-DU',
        issuingAuthority: 'Synthetic Authority',
        sourceCategory: 'REGULATORY_AUTHORITY',
        referenceNumber: `${tag}-${name}`,
        title: `Lifecycle ${name}`,
        ownershipScope: 'ORGANIZATION',
      },
    })
    const version = await prisma.ruleSourceVersion.create({
      data: {
        sourceId: source.id,
        version: '1',
        rawEvidenceRef: `synthetic-evidence://${tag}/${name}`,
        publicationStatus: 'PUBLISHED',
        publicationDate: d('2020-01-01'),
        effectiveFrom: d('2020-01-01'),
        effectiveTo: effectiveTo ? d(effectiveTo) : null,
        verificationStatus: 'VERIFIED',
        verifiedAt: new Date(),
      },
    })
    await prisma.sourceInterpretation.create({
      data: {
        sourceVersionId: version.id,
        interpretationVersion: '1',
        normalizedInterpretationRef: `synthetic-interpretation://${tag}/${name}`,
        verificationStatus: 'VERIFIED',
        verifiedAt: new Date(),
      },
    })
    return version
  }

  async function stored(id: string) {
    return prisma.ruleSourceVersion.findUniqueOrThrow({ where: { id } })
  }

  async function expectDateEditRejected(label: string, id: string) {
    const before = await stored(id)
    const auditBefore = await prisma.auditEvent.count()
    const result = await updateLifecycleMetadata(id, undefined, undefined, '2027-01-01', actor)
    const after = await stored(id)
    check(`${label}: rejected`, !result.ok && result.code === 'VALIDATION_ERROR', JSON.stringify(result))
    check(
      `${label}: stored dates unchanged`,
      day(before.effectiveFrom) === day(after.effectiveFrom) && day(before.effectiveTo) === day(after.effectiveTo),
      `(effectiveTo ${day(before.effectiveTo)} -> ${day(after.effectiveTo)})`,
    )
    check(`${label}: no AuditEvent written`, (await prisma.auditEvent.count()) === auditBefore)
  }

  section('C28 activation, suspension, failed resume, attempted date edit, recovery')
  const version = await activatableVersion('main')
  const dependency = await activatableVersion('dependency')
  await prisma.ruleSourceRelationship.create({
    data: { fromSourceVersionId: version.id, toSourceVersionId: dependency.id, relationshipType: 'DEPENDS_ON' },
  })

  const beforeActivation = await stored(version.id)
  check('a never-activated version is not marked ever-activated', beforeActivation.everActivated === false && beforeActivation.firstActivatedAt === null)

  const editWhileInactive = await updateLifecycleMetadata(version.id, undefined, undefined, '2031-12-31', actor)
  check('dates are editable while INACTIVE and never activated', editWhileInactive.ok && editWhileInactive.value.effectiveTo === '2031-12-31', JSON.stringify(editWhileInactive))

  // The dependency must be ACTIVE for the first activation to succeed.
  const dependencyActivated = await activateRuleSourceVersion(dependency.id, '2026-06-15', 'AE-DU', actor)
  check('fixture: the dependency activates', dependencyActivated.ok, JSON.stringify(dependencyActivated))

  const activated = await activateRuleSourceVersion(version.id, '2026-06-15', 'AE-DU', actor)
  check('activation succeeds', activated.ok && activated.value.activationStatus === 'ACTIVE', JSON.stringify(activated))
  const afterActivation = await stored(version.id)
  check('activation records the durable fact and the original evidence', afterActivation.everActivated === true && afterActivation.firstActivatedAt !== null)
  const originalFirstActivatedAt = afterActivation.firstActivatedAt?.toISOString() ?? null
  const governedFrom = day(afterActivation.effectiveFrom)
  const governedTo = day(afterActivation.effectiveTo)

  await expectDateEditRejected('date edit while ACTIVE', version.id)

  const suspended = await suspendRuleSourceVersion(version.id, actor)
  check('suspension succeeds', suspended.ok && suspended.value.activationStatus === 'SUSPENDED', JSON.stringify(suspended))
  await expectDateEditRejected('date edit while SUSPENDED', version.id)

  // Break the dependency so the resume fails: the target is suspended, so it is no longer ACTIVE.
  const dependencySuspended = await suspendRuleSourceVersion(dependency.id, actor)
  check('fixture: the dependency is suspended, making the dependency unresolved', dependencySuspended.ok)

  const failedResume = await resumeRuleSourceVersion(version.id, '2026-06-15', 'AE-DU', actor)
  const afterFailedResume = await stored(version.id)
  check('the resume fails and lands on BLOCKED', failedResume.ok && afterFailedResume.activationStatus === 'BLOCKED', JSON.stringify(failedResume))
  check('the failed resume reports the unresolved dependency', afterFailedResume.activationBlockers.includes('DEPENDENCY_UNRESOLVED'), afterFailedResume.activationBlockers.join(','))
  check('the failed resume clears activatedAt (DB check requires it)', afterFailedResume.activatedAt === null)
  check(
    'the failed resume does NOT erase the ever-activated fact or the original evidence',
    afterFailedResume.everActivated === true && afterFailedResume.firstActivatedAt?.toISOString() === originalFirstActivatedAt,
    JSON.stringify({ everActivated: afterFailedResume.everActivated, firstActivatedAt: afterFailedResume.firstActivatedAt }),
  )

  await expectDateEditRejected('date edit after a failed resume (the F09 counterexample)', version.id)

  check(
    'historical retrieval keeps the original governed dates and identity',
    day(afterFailedResume.effectiveFrom) === governedFrom &&
      day(afterFailedResume.effectiveTo) === governedTo &&
      afterFailedResume.id === version.id &&
      afterFailedResume.version === beforeActivation.version,
  )

  section('C28 valid recovery keeps the original evidence')
  const dependencyResumed = await resumeRuleSourceVersion(dependency.id, '2026-06-15', 'AE-DU', actor)
  check('fixture: the dependency resumes to ACTIVE', dependencyResumed.ok && dependencyResumed.value.activationStatus === 'ACTIVE', JSON.stringify(dependencyResumed))
  // A failed resume lands on BLOCKED, and resume is only reachable from SUSPENDED, so the
  // documented recovery path from BLOCKED is activate.
  const recovered = await activateRuleSourceVersion(version.id, '2026-06-15', 'AE-DU', actor)
  const afterRecovery = await stored(version.id)
  check('the version activates again from BLOCKED (documented recovery path)', recovered.ok && afterRecovery.activationStatus === 'ACTIVE', JSON.stringify(recovered))
  check(
    'recovery sets a new activatedAt but keeps the FIRST activation evidence',
    afterRecovery.activatedAt !== null && afterRecovery.firstActivatedAt?.toISOString() === originalFirstActivatedAt,
    JSON.stringify({ activatedAt: afterRecovery.activatedAt, firstActivatedAt: afterRecovery.firstActivatedAt }),
  )
  check('recovery keeps the governed dates', day(afterRecovery.effectiveFrom) === governedFrom && day(afterRecovery.effectiveTo) === governedTo)
  await expectDateEditRejected('date edit after recovery', version.id)

  section('C28 concurrent failed resume versus date edit')
  {
    const raceVersion = await activatableVersion('race')
    const activateRace = await activateRuleSourceVersion(raceVersion.id, '2026-06-15', 'AE-DU', actor)
    check('fixture: the race version activates', activateRace.ok)
    await suspendRuleSourceVersion(raceVersion.id, actor)
    await prisma.ruleSourceRelationship.create({
      data: { fromSourceVersionId: raceVersion.id, toSourceVersionId: dependency.id, relationshipType: 'DEPENDS_ON' },
    })
    await suspendRuleSourceVersion(dependency.id, actor)

    clearConcurrencyProbes()
    const holding = barrier()
    const release = barrier()
    setConcurrencyProbe('rule_source_version.resume', async () => {
      holding.open()
      await release.promise
    })
    const resume = resumeRuleSourceVersion(raceVersion.id, '2026-06-15', 'AE-DU', actor)
    await holding.promise
    const edit = updateLifecycleMetadata(raceVersion.id, undefined, undefined, '2027-01-01', actor)
    const state = await waitUntilBlockedOrSettled(edit)
    release.open()
    const [resumeResult, editResult] = await Promise.all([resume, edit])
    clearConcurrencyProbes()
    const raceStored = await stored(raceVersion.id)
    check('the date edit waited for the in-flight resume', state === 'blocked', `(observed: ${state})`)
    check('the resume completes and the edit is rejected as frozen', resumeResult.ok && !editResult.ok, JSON.stringify({ resumeResult, editResult }))
    check('the governed dates survived the race', day(raceStored.effectiveTo) === '2030-12-31', day(raceStored.effectiveTo) ?? 'null')
    check('the ever-activated fact survived the race', raceStored.everActivated === true)
  }

  console.log(`\n[a3-lifecycle] ${passed} passed, ${failed} failed`)
  console.log(failed === 0 ? '[a3-lifecycle] ALL CHECKS PASS' : '[a3-lifecycle] CHECKS FAILED')
  process.exitCode = failed === 0 ? 0 : 1
}

main()
  .catch((error) => {
    console.error('[a3-lifecycle] uncaught error (this itself is a FAIL):', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
