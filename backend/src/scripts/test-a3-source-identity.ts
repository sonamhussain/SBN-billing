import 'dotenv/config'
import { prisma } from '../shared/database/prisma.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../shared/testing/concurrency-probe.ts'
import { createRuleSource, updateRuleSource } from '../modules/rule-source/rule-source.service.ts'
import { createRuleSourceVersion } from '../modules/rule-source-version/rule-source-version.service.ts'

// Audit F10 / C29 — once a RuleSource has any version, its jurisdiction, issuing authority and
// source category are the identity that every existing version, interpretation and binding was
// governed under. A3.7/A3.8 read those parent fields live, so a later edit would silently relabel
// historical IDs into a different authority class.

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
  console.log(`\n[a3-identity] ${title}`)
}

const tag = `A3ID-${Date.now()}`
const organizationId = process.env.AUTHZ_BOOTSTRAP_ORGANIZATION_ID
const userEmail = process.env.AUTHZ_BOOTSTRAP_USER_EMAIL

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
  console.log(`[a3-identity] run tag ${tag} — organization ${org}`)

  let sourceCounter = 0
  async function source(name: string) {
    sourceCounter += 1
    const created = await createRuleSource(org, 'AE-DU', 'DHA', 'REGULATORY_AUTHORITY', `${tag}-${sourceCounter}`, `Identity ${name}`, actor)
    if (!created.ok) throw new Error(`fixture create failed: ${created.message}`)
    return created.value.id
  }

  async function stored(id: string) {
    return prisma.ruleSource.findUniqueOrThrow({ where: { id } })
  }

  async function expectRejected(label: string, id: string, patch: { jurisdictionCode?: unknown; issuingAuthority?: unknown; sourceCategory?: unknown; title?: unknown }) {
    const before = await stored(id)
    const auditBefore = await prisma.auditEvent.count()
    const result = await updateRuleSource(
      id,
      patch.jurisdictionCode,
      patch.issuingAuthority,
      patch.sourceCategory,
      undefined,
      patch.title,
      false,
      actor,
    )
    const after = await stored(id)
    check(`${label}: rejected`, !result.ok && result.code === 'VALIDATION_ERROR', JSON.stringify(result))
    check(
      `${label}: identity unchanged`,
      before.jurisdictionCode === after.jurisdictionCode && before.issuingAuthority === after.issuingAuthority && before.sourceCategory === after.sourceCategory,
      JSON.stringify({ before: [before.jurisdictionCode, before.issuingAuthority, before.sourceCategory], after: [after.jurisdictionCode, after.issuingAuthority, after.sourceCategory] }),
    )
    check(`${label}: no AuditEvent written`, (await prisma.auditEvent.count()) === auditBefore)
  }

  section('C29 parent edits before any child behave as documented')
  const fresh = await source('fresh')
  const editedJurisdiction = await updateRuleSource(fresh, 'AE-AZ', undefined, undefined, undefined, undefined, false, actor)
  check('jurisdiction is editable while the source has no version', editedJurisdiction.ok && editedJurisdiction.value.jurisdictionCode === 'AE-AZ', JSON.stringify(editedJurisdiction))
  const editedCategory = await updateRuleSource(fresh, undefined, 'HAAD', 'CLAIMS_STANDARD', undefined, undefined, false, actor)
  check('authority and category are editable while the source has no version', editedCategory.ok && editedCategory.value.sourceCategory === 'CLAIMS_STANDARD', JSON.stringify(editedCategory))

  section('C29 prohibited edits after child creation fail without audit')
  const governed = await source('governed')
  const firstChild = await createRuleSourceVersion(governed, '1', `synthetic-evidence://${tag}/governed`, actor)
  check('the first version is created', firstChild.ok, JSON.stringify(firstChild))

  await expectRejected('jurisdiction change after a version exists', governed, { jurisdictionCode: 'AE-AZ' })
  await expectRejected('issuing authority change after a version exists', governed, { issuingAuthority: 'HAAD' })
  await expectRejected('source category change after a version exists', governed, { sourceCategory: 'PAYER_POLICY' })
  await expectRejected('a mixed patch is rejected as a whole, so the title is not applied either', governed, {
    sourceCategory: 'TARIFF',
    title: 'Should not be applied',
  })

  // Checked BEFORE the allowed edits below: re-sending the original identity values would restore
  // them under the pre-F10 behaviour and hide the relabelling this check is meant to catch.
  const afterEdits = await stored(governed)
  check(
    'historical source IDs were never relabelled into a different authority class',
    afterEdits.jurisdictionCode === 'AE-DU' && afterEdits.issuingAuthority === 'DHA' && afterEdits.sourceCategory === 'REGULATORY_AUTHORITY',
    JSON.stringify({ jurisdictionCode: afterEdits.jurisdictionCode, issuingAuthority: afterEdits.issuingAuthority, sourceCategory: afterEdits.sourceCategory }),
  )

  const titleEdit = await updateRuleSource(governed, undefined, undefined, undefined, undefined, 'Corrected display title', false, actor)
  check('display-only corrections stay allowed', titleEdit.ok && titleEdit.value.title === 'Corrected display title', JSON.stringify(titleEdit))

  const unchangedIdentity = await updateRuleSource(governed, 'AE-DU', 'DHA', 'REGULATORY_AUTHORITY', undefined, 'Another title', false, actor)
  check('re-sending the SAME identity values is not a change and is allowed', unchangedIdentity.ok, JSON.stringify(unchangedIdentity))

  // The before/after proof reverts the whole F10 change, and the pre-F10 code has no probe seams
  // to synchronise on, so the counterexample run covers the sequential sections only.
  if (process.env.A3_IDENTITY_SEQUENTIAL_ONLY === '1') {
    console.log('\n[a3-identity] A3_IDENTITY_SEQUENTIAL_ONLY=1 — the concurrency sections need the F10 probe seams and are skipped')
    console.log(`\n[a3-identity] ${passed} passed, ${failed} failed`)
    process.exitCode = failed === 0 ? 0 : 1
    return
  }

  section('C29 parallel first-child creation versus parent identity change')
  {
    const racing = await source('race-child-first')
    clearConcurrencyProbes()
    const holding = barrier()
    const release = barrier()
    setConcurrencyProbe('rule_source_version.create', async () => {
      holding.open()
      await release.promise
    })
    const child = createRuleSourceVersion(racing, '1', `synthetic-evidence://${tag}/race1`, actor)
    await holding.promise
    const identityEdit = updateRuleSource(racing, 'AE-AZ', undefined, undefined, undefined, undefined, false, actor)
    const state = await waitUntilBlockedOrSettled(identityEdit)
    release.open()
    const [childResult, editResult] = await Promise.all([child, identityEdit])
    clearConcurrencyProbes()
    const row = await stored(racing)
    const versions = await prisma.ruleSourceVersion.count({ where: { sourceId: racing } })
    check('child-first: the identity edit waited on the parent lock', state === 'blocked', `(observed: ${state})`)
    check(
      'child-first: one coherent outcome — the version exists and the identity edit is rejected',
      childResult.ok && !editResult.ok && versions === 1 && row.jurisdictionCode === 'AE-DU',
      JSON.stringify({ childResult: childResult.ok, editResult, versions, jurisdiction: row.jurisdictionCode }),
    )
  }
  {
    const racing = await source('race-edit-first')
    clearConcurrencyProbes()
    const holding = barrier()
    const release = barrier()
    setConcurrencyProbe('rule_source.update', async () => {
      holding.open()
      await release.promise
    })
    const identityEdit = updateRuleSource(racing, 'AE-AZ', undefined, undefined, undefined, undefined, false, actor)
    await holding.promise
    const child = createRuleSourceVersion(racing, '1', `synthetic-evidence://${tag}/race2`, actor)
    const state = await waitUntilBlockedOrSettled(child)
    release.open()
    const [editResult, childResult] = await Promise.all([identityEdit, child])
    clearConcurrencyProbes()
    const row = await stored(racing)
    check('edit-first: the child create waited on the parent lock', state === 'blocked', `(observed: ${state})`)
    check(
      'edit-first: one coherent outcome — the identity change commits, then the child is created under it',
      editResult.ok && childResult.ok && row.jurisdictionCode === 'AE-AZ',
      JSON.stringify({ editResult: editResult.ok, childResult: childResult.ok, jurisdiction: row.jurisdictionCode }),
    )
    const versionRow = await prisma.ruleSourceVersion.findFirstOrThrow({ where: { sourceId: racing } })
    check('edit-first: the new version belongs to the already-changed identity', versionRow.sourceId === racing)
    await expectRejected('edit-first: a further identity change is now frozen', racing, { jurisdictionCode: 'AE-DU' })
  }

  console.log(`\n[a3-identity] ${passed} passed, ${failed} failed`)
  console.log(failed === 0 ? '[a3-identity] ALL CHECKS PASS' : '[a3-identity] CHECKS FAILED')
  process.exitCode = failed === 0 ? 0 : 1
}

main()
  .catch((error) => {
    console.error('[a3-identity] uncaught error (this itself is a FAIL):', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
