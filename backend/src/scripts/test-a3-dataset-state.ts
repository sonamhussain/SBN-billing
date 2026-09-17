import 'dotenv/config'
import { prisma } from '../shared/database/prisma.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../shared/testing/concurrency-probe.ts'
import {
  activateReferenceDatasetVersion,
  importReferenceDataset,
  importReferenceDatasetVersion,
  retireReferenceDatasetVersion,
  validateReferenceDatasetVersion,
} from '../modules/reference-dataset/reference-dataset.maintenance.ts'

// Audit F11 / C30-C32 — reference dataset state invariants. ACTIVE implies VALIDATED durably (not
// only at the instant of activation), a dataset has at most one ACTIVE version even under
// concurrent activation, and activation versus retirement or validation cannot resurrect a retired
// version or leave an invalid ACTIVE state. Proven through the maintenance service AND directly
// against PostgreSQL, since the doc requires both.

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
  console.log(`\n[a3-dataset] ${title}`)
}

const tag = `A3DS-${Date.now()}`

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
  console.log(`[a3-dataset] run tag ${tag}`)

  let counter = 0
  async function dataset(name: string) {
    counter += 1
    const created = await importReferenceDataset({
      datasetKey: `${tag}-${counter}-${name}`,
      displayName: `Dataset ${name}`,
      jurisdictionCode: 'AE-DU',
      authorityCode: 'DHA',
    })
    if (!created.ok) throw new Error(`fixture dataset failed: ${created.message}`)
    return created.value.id
  }

  async function datasetVersion(datasetId: string, version: string) {
    const created = await importReferenceDatasetVersion({
      datasetId,
      version,
      retrievedAt: '2026-01-01T00:00:00.000Z',
      contentHash: `hash-${tag}-${datasetId}-${version}`,
    })
    if (!created.ok) throw new Error(`fixture version failed: ${created.message}`)
    return created.value.id
  }

  async function validatedVersion(datasetId: string, version: string) {
    const id = await datasetVersion(datasetId, version)
    const validated = await validateReferenceDatasetVersion(id, 'VALIDATED')
    if (!validated.ok) throw new Error(`fixture validate failed: ${validated.message}`)
    return id
  }

  async function stored(id: string) {
    return prisma.referenceDatasetVersion.findUniqueOrThrow({ where: { id } })
  }

  async function activeCount(datasetId: string) {
    return prisma.referenceDatasetVersion.count({ where: { datasetId, activationStatus: 'ACTIVE' } })
  }

  section('C30 an ACTIVE version cannot be downgraded into an invalid state')
  {
    const ds = await dataset('downgrade')
    const v1 = await validatedVersion(ds, '1')
    const activated = await activateReferenceDatasetVersion(v1)
    check('fixture: the validated version activates', activated.ok && activated.value.activationStatus === 'ACTIVE', JSON.stringify(activated))

    for (const requested of ['UNVALIDATED', 'REJECTED'] as const) {
      const result = await validateReferenceDatasetVersion(v1, requested)
      const after = await stored(v1)
      check(`downgrade to ${requested} is refused with a sanitized message`, !result.ok, JSON.stringify(result))
      check(
        `downgrade to ${requested} left the row untouched`,
        after.activationStatus === 'ACTIVE' && after.validationStatus === 'VALIDATED',
        JSON.stringify({ activationStatus: after.activationStatus, validationStatus: after.validationStatus }),
      )
    }

    const reconfirm = await validateReferenceDatasetVersion(v1, 'VALIDATED')
    check('re-confirming VALIDATED while ACTIVE stays allowed', reconfirm.ok, JSON.stringify(reconfirm))

    // The documented controlled path: withdraw the active state first, then invalidate.
    const v2 = await validatedVersion(ds, '2')
    const promoted = await activateReferenceDatasetVersion(v2)
    check('fixture: activating v2 supersedes v1', promoted.ok && (await stored(v1)).activationStatus === 'SUPERSEDED', JSON.stringify(promoted))
    const nowAllowed = await validateReferenceDatasetVersion(v1, 'REJECTED')
    check('once withdrawn from active, the same version CAN be rejected', nowAllowed.ok, JSON.stringify(nowAllowed))
    const v1After = await stored(v1)
    check(
      'the withdrawal kept its history — v1 is still SUPERSEDED with its timestamps',
      v1After.activationStatus === 'SUPERSEDED' && v1After.activatedAt !== null && v1After.supersededAt !== null,
      JSON.stringify({ activationStatus: v1After.activationStatus, activatedAt: v1After.activatedAt, supersededAt: v1After.supersededAt }),
    )

    // The database is the final guard, independent of the service.
    let rawRejected = false
    let rawMessage = ''
    try {
      await prisma.$executeRaw`UPDATE reference_dataset_versions SET validation_status = 'UNVALIDATED' WHERE id = ${v2}::uuid`
    } catch (error) {
      rawRejected = true
      rawMessage = error instanceof Error ? error.message : String(error)
    }
    check(
      'PostgreSQL itself refuses ACTIVE with a non-VALIDATED status',
      rawRejected && rawMessage.includes('reference_dataset_versions_active_implies_validated_chk'),
      rawMessage.slice(0, 200),
    )
    check('the direct write changed nothing', (await stored(v2)).validationStatus === 'VALIDATED')
  }

  // The before/after proof reverts the whole F11 change, and the pre-F11 maintenance module has no
  // probe seams to synchronise on. This mode replaces the barrier-driven sections with one
  // probe-free parallel activation, which is enough to show the invariant breaking.
  if (process.env.A3_DATASET_SEQUENTIAL_ONLY === '1') {
    section('C31 probe-free parallel activation (counterexample mode)')
    const ds = await dataset('race-naive')
    const ids = await Promise.all([validatedVersion(ds, '1'), validatedVersion(ds, '2'), validatedVersion(ds, '3')])
    const results = await Promise.allSettled(ids.map((id) => activateReferenceDatasetVersion(id)))
    const active = await activeCount(ds)
    check('no activation threw a raw exception', results.every((r) => r.status === 'fulfilled'), JSON.stringify(results.map((r) => r.status)))
    check('exactly one ACTIVE version remains after three parallel activations', active === 1, `(ACTIVE versions: ${active})`)
    console.log(`\n[a3-dataset] A3_DATASET_SEQUENTIAL_ONLY=1 — the barrier-driven sections need the F11 probe seams and are skipped`)
    console.log(`\n[a3-dataset] ${passed} passed, ${failed} failed`)
    process.exitCode = failed === 0 ? 0 : 1
    return
  }

  section('C31 two concurrent first activations cannot leave two ACTIVE versions')
  {
    const ds = await dataset('race-first')
    const v1 = await validatedVersion(ds, '1')
    const v2 = await validatedVersion(ds, '2')
    check('fixture: the dataset starts with no ACTIVE version', (await activeCount(ds)) === 0)

    clearConcurrencyProbes()
    const holding = barrier()
    const release = barrier()
    setConcurrencyProbe('reference_dataset.activate', async () => {
      holding.open()
      await release.promise
    })
    const first = activateReferenceDatasetVersion(v1)
    await holding.promise
    const second = activateReferenceDatasetVersion(v2)
    const state = await waitUntilBlockedOrSettled(second)
    release.open()
    const [firstResult, secondResult] = await Promise.all([first, second])
    clearConcurrencyProbes()

    check('the second activation waited on the dataset lock', state === 'blocked', `(observed: ${state})`)
    check('both activations returned a typed result, neither threw', typeof firstResult.ok === 'boolean' && typeof secondResult.ok === 'boolean')
    check('exactly one ACTIVE version remains', (await activeCount(ds)) === 1, String(await activeCount(ds)))
    const [s1, s2] = [await stored(v1), await stored(v2)]
    check(
      'the loser is SUPERSEDED with its own timestamp, not silently lost',
      (s1.activationStatus === 'ACTIVE' && s2.activationStatus === 'SUPERSEDED' && s2.supersededAt !== null) ||
        (s2.activationStatus === 'ACTIVE' && s1.activationStatus === 'SUPERSEDED' && s1.supersededAt !== null),
      JSON.stringify({ v1: s1.activationStatus, v2: s2.activationStatus }),
    )

    // The partial unique index is the final guard here.
    const inactive = s1.activationStatus === 'ACTIVE' ? v2 : v1
    let rawRejected = false
    let rawMessage = ''
    try {
      await prisma.$executeRaw`UPDATE reference_dataset_versions SET activation_status = 'ACTIVE' WHERE id = ${inactive}::uuid`
    } catch (error) {
      rawRejected = true
      rawMessage = error instanceof Error ? error.message : String(error)
    }
    check(
      'PostgreSQL itself refuses a second ACTIVE version for the dataset',
      rawRejected && rawMessage.includes('reference_dataset_versions_one_active_uq'),
      rawMessage.slice(0, 200),
    )
    check('the direct write left exactly one ACTIVE version', (await activeCount(ds)) === 1)
  }

  section('C32 activation versus retirement cannot resurrect a retired version')
  {
    const ds = await dataset('race-retire')
    const v1 = await validatedVersion(ds, '1')
    await activateReferenceDatasetVersion(v1)

    clearConcurrencyProbes()
    const holding = barrier()
    const release = barrier()
    setConcurrencyProbe('reference_dataset.retire', async () => {
      holding.open()
      await release.promise
    })
    const retire = retireReferenceDatasetVersion(v1)
    await holding.promise
    const reactivate = activateReferenceDatasetVersion(v1)
    const state = await waitUntilBlockedOrSettled(reactivate)
    release.open()
    const [retireResult, reactivateResult] = await Promise.all([retire, reactivate])
    clearConcurrencyProbes()

    const after = await stored(v1)
    check('the activation waited on the in-flight retirement', state === 'blocked', `(observed: ${state})`)
    check('the retirement commits', retireResult.ok && after.activationStatus === 'RETIRED', JSON.stringify(retireResult))
    check(
      'the activation is refused — a retired version is never resurrected',
      !reactivateResult.ok && reactivateResult.message.includes('retired'),
      JSON.stringify(reactivateResult),
    )
    check('the dataset has no ACTIVE version left', (await activeCount(ds)) === 0)
    check('the retirement timestamp is intact and activatedAt was not overwritten', after.retiredAt !== null && after.activatedAt !== null)
  }

  section('C32 activation versus validation of the same version')
  {
    const ds = await dataset('race-validate')
    const v1 = await validatedVersion(ds, '1')
    const v2 = await validatedVersion(ds, '2')
    await activateReferenceDatasetVersion(v1)

    clearConcurrencyProbes()
    const holding = barrier()
    const release = barrier()
    setConcurrencyProbe('reference_dataset.activate', async () => {
      holding.open()
      await release.promise
    })
    const activate = activateReferenceDatasetVersion(v2)
    await holding.promise
    // v1 is ACTIVE when this call starts; by the time it runs, v1 has been superseded. Whichever
    // side it observes, the result must be coherent and no invalid ACTIVE state may persist.
    const invalidate = validateReferenceDatasetVersion(v1, 'REJECTED')
    const state = await waitUntilBlockedOrSettled(invalidate)
    release.open()
    const [activateResult, invalidateResult] = await Promise.all([activate, invalidate])
    clearConcurrencyProbes()

    const [s1, s2] = [await stored(v1), await stored(v2)]
    check('the validation waited on the in-flight activation', state === 'blocked', `(observed: ${state})`)
    check('the activation commits and v1 is superseded', activateResult.ok && s1.activationStatus === 'SUPERSEDED' && s2.activationStatus === 'ACTIVE', JSON.stringify({ v1: s1.activationStatus, v2: s2.activationStatus }))
    check(
      'the validation change is decided against the state it actually finds, not a stale read',
      invalidateResult.ok === (s1.validationStatus === 'REJECTED'),
      JSON.stringify({ invalidateResult, v1Validation: s1.validationStatus }),
    )
    check('no ACTIVE version is left in a non-VALIDATED state', s2.validationStatus === 'VALIDATED')
    check('exactly one ACTIVE version remains', (await activeCount(ds)) === 1)
  }

  section('C32 a rejected conflict leaves the prior active version intact')
  {
    const ds = await dataset('rejected-conflict')
    const good = await validatedVersion(ds, '1')
    await activateReferenceDatasetVersion(good)
    const goodBefore = await stored(good)

    const unvalidated = await datasetVersion(ds, '2')
    const refused = await activateReferenceDatasetVersion(unvalidated)
    check('activating an UNVALIDATED version is refused', !refused.ok && refused.message.includes('VALIDATED'), JSON.stringify(refused))
    const goodAfter = await stored(good)
    check(
      'the prior ACTIVE version is completely untouched by the refused activation',
      goodAfter.activationStatus === 'ACTIVE' &&
        goodAfter.supersededAt === null &&
        goodAfter.activatedAt?.getTime() === goodBefore.activatedAt?.getTime(),
      JSON.stringify({ activationStatus: goodAfter.activationStatus, supersededAt: goodAfter.supersededAt }),
    )
    check('the refused activation left its own version INACTIVE', (await stored(unvalidated)).activationStatus === 'INACTIVE')
    check('exactly one ACTIVE version remains', (await activeCount(ds)) === 1)

    const missing = await activateReferenceDatasetVersion('00000000-0000-4000-8000-000000000000')
    check('activating an unknown version is a typed not-found, not a crash', !missing.ok && missing.message.includes('not found'), JSON.stringify(missing))
    check('the prior ACTIVE version survived that too', (await stored(good)).activationStatus === 'ACTIVE')
  }

  console.log(`\n[a3-dataset] ${passed} passed, ${failed} failed`)
  console.log(failed === 0 ? '[a3-dataset] ALL CHECKS PASS' : '[a3-dataset] CHECKS FAILED')
  process.exitCode = failed === 0 ? 0 : 1
}

main()
  .catch((error) => {
    console.error('[a3-dataset] uncaught error (this itself is a FAIL):', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
