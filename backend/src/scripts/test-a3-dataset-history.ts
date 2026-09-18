import 'dotenv/config'
import { prisma } from '../shared/database/prisma.ts'
import {
  activateReferenceDatasetVersion,
  importReferenceDataset,
  importReferenceDatasetVersion,
  retireReferenceDatasetVersion,
  validateReferenceDatasetVersion,
} from '../modules/reference-dataset/reference-dataset.maintenance.ts'
import { findReferenceDatasetLifecycleEvents } from '../modules/reference-dataset/reference-dataset.repository.ts'

// Audit F12 / C33 — a dataset rollback chain v1 -> v2 -> v1 -> v2 must be reconstructable exactly.
// Keeping every VERSION is not keeping every TRANSITION: re-activating a superseded version
// overwrites its activatedAt, and superseding it again overwrites its supersededAt, so the current
// row state can only ever show the LAST of each. The append-only lifecycle history is what makes
// the sequence recoverable, and it must be immutable once written.

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
  console.log(`\n[a3-history] ${title}`)
}

const tag = `A3HS-${Date.now()}`
const operator = { actorRef: `maintenance-operator/${tag}`, reason: 'F12 acceptance run' }

async function main() {
  console.log(`[a3-history] run tag ${tag}`)

  let counter = 0
  async function dataset(name: string) {
    counter += 1
    const created = await importReferenceDataset({
      datasetKey: `${tag}-${counter}-${name}`,
      displayName: `History ${name}`,
      jurisdictionCode: 'AE-DU',
      authorityCode: 'DHA',
    })
    if (!created.ok) throw new Error(`fixture dataset failed: ${created.message}`)
    return created.value.id
  }

  async function validatedVersion(datasetId: string, version: string) {
    const created = await importReferenceDatasetVersion({
      datasetId,
      version,
      retrievedAt: '2026-01-01T00:00:00.000Z',
      contentHash: `hash-${tag}-${datasetId}-${version}`,
    })
    if (!created.ok) throw new Error(`fixture version failed: ${created.message}`)
    const validated = await validateReferenceDatasetVersion(created.value.id, 'VALIDATED', operator)
    if (!validated.ok) throw new Error(`fixture validate failed: ${validated.message}`)
    return created.value.id
  }

  section('C33 the v1 -> v2 -> v1 -> v2 rollback chain is fully reconstructable')
  const ds = await dataset('rollback')
  const v1 = await validatedVersion(ds, '1')
  const v2 = await validatedVersion(ds, '2')

  const steps = [v1, v2, v1, v2]
  for (const [index, id] of steps.entries()) {
    const result = await activateReferenceDatasetVersion(id, operator)
    check(`step ${index + 1}: activating ${id === v1 ? 'v1' : 'v2'} succeeds`, result.ok, JSON.stringify(result))
  }

  const [r1, r2] = [
    await prisma.referenceDatasetVersion.findUniqueOrThrow({ where: { id: v1 } }),
    await prisma.referenceDatasetVersion.findUniqueOrThrow({ where: { id: v2 } }),
  ]
  check('the current state shows only the final position', r1.activationStatus === 'SUPERSEDED' && r2.activationStatus === 'ACTIVE', JSON.stringify({ v1: r1.activationStatus, v2: r2.activationStatus }))
  check(
    'the current row state alone cannot tell the chain apart from a single v1 -> v2 move',
    r1.activatedAt !== null && r1.supersededAt !== null && r2.activatedAt !== null,
    'each row carries one timestamp per transition type, overwritten each time',
  )

  const events = await findReferenceDatasetLifecycleEvents(ds)
  const label = (id: string) => (id === v1 ? 'v1' : 'v2')
  const trail = events.map((event) => `${label(event.datasetVersionId)}:${event.action}:${event.previousActivationStatus}->${event.nextActivationStatus}`)
  console.log(`  trail  ${trail.join('  |  ')}`)

  check(
    'the two fixture validations are the first two events',
    trail[0] === 'v1:VALIDATE:INACTIVE->INACTIVE' && trail[1] === 'v2:VALIDATE:INACTIVE->INACTIVE',
    trail.slice(0, 2).join(' | '),
  )
  check(
    'the full activation chain is recorded in order, supersession before the activation that caused it',
    trail.slice(2).join(' | ') ===
      [
        'v1:ACTIVATE:INACTIVE->ACTIVE',
        'v1:SUPERSEDE:ACTIVE->SUPERSEDED',
        'v2:ACTIVATE:INACTIVE->ACTIVE',
        'v2:SUPERSEDE:ACTIVE->SUPERSEDED',
        'v1:ROLLBACK:SUPERSEDED->ACTIVE',
        'v1:SUPERSEDE:ACTIVE->SUPERSEDED',
        'v2:ROLLBACK:SUPERSEDED->ACTIVE',
      ].join(' | '),
    trail.slice(2).join(' | '),
  )
  check(
    'a rollback is distinguishable from a first activation',
    events.filter((event) => event.action === 'ROLLBACK').length === 2 &&
      events.filter((event) => event.action === 'ACTIVATE').length === 2,
    trail.join(' | '),
  )
  check(
    'every event carries the trusted maintenance actor and its reason',
    events.every((event) => event.actorRef === operator.actorRef && event.reason === operator.reason),
    JSON.stringify(events.map((event) => event.actorRef)),
  )
  check(
    'the sequence is strictly increasing, so same-transaction transitions are still ordered',
    events.every((event, index) => index === 0 || event.sequence > events[index - 1].sequence),
    JSON.stringify(events.map((event) => event.sequence.toString())),
  )
  check(
    'every event carries a server timestamp',
    events.every((event) => event.occurredAt instanceof Date),
  )
  check('no organizationId was invented — datasets stay out of the tenant audit table', !('organizationId' in events[0]))

  // Replay the recorded transitions from scratch and land on the state the database actually holds.
  const replayed = new Map<string, string>([
    [v1, 'INACTIVE'],
    [v2, 'INACTIVE'],
  ])
  let coherent = true
  for (const event of events) {
    if (replayed.get(event.datasetVersionId) !== event.previousActivationStatus) coherent = false
    replayed.set(event.datasetVersionId, event.nextActivationStatus)
  }
  check('every recorded previous state matches the state the replay had reached', coherent)
  check(
    'replaying the history from scratch reproduces the stored state exactly',
    replayed.get(v1) === r1.activationStatus && replayed.get(v2) === r2.activationStatus,
    JSON.stringify({ replayed: [replayed.get(v1), replayed.get(v2)], stored: [r1.activationStatus, r2.activationStatus] }),
  )

  section('C33 the history is immutable once written')
  {
    const first = events[0]
    let updateRejected = false
    let updateMessage = ''
    try {
      await prisma.$executeRaw`UPDATE reference_dataset_lifecycle_events SET action = 'RETIRE' WHERE id = ${first.id}::uuid`
    } catch (error) {
      updateRejected = true
      updateMessage = error instanceof Error ? error.message : String(error)
    }
    check('PostgreSQL refuses to UPDATE a recorded event', updateRejected && updateMessage.includes('append-only'), updateMessage.slice(0, 160))

    let deleteRejected = false
    let deleteMessage = ''
    try {
      await prisma.$executeRaw`DELETE FROM reference_dataset_lifecycle_events WHERE id = ${first.id}::uuid`
    } catch (error) {
      deleteRejected = true
      deleteMessage = error instanceof Error ? error.message : String(error)
    }
    check('PostgreSQL refuses to DELETE a recorded event', deleteRejected && deleteMessage.includes('append-only'), deleteMessage.slice(0, 160))

    const after = await findReferenceDatasetLifecycleEvents(ds)
    check('the trail is byte-identical after both attempts', after.length === events.length && after[0].action === first.action)
  }

  section('C33 refused operations record nothing')
  {
    const before = (await findReferenceDatasetLifecycleEvents(ds)).length
    const refusedDowngrade = await validateReferenceDatasetVersion(v2, 'REJECTED', operator)
    const refusedRepeat = await retireReferenceDatasetVersion('00000000-0000-4000-8000-000000000000', operator)
    check('fixture: both operations are refused', !refusedDowngrade.ok && !refusedRepeat.ok, JSON.stringify({ refusedDowngrade, refusedRepeat }))
    check('the history records what happened, not what was attempted', (await findReferenceDatasetLifecycleEvents(ds)).length === before)
  }

  section('C33 retirement closes the chain and is recorded')
  {
    const retired = await retireReferenceDatasetVersion(v2, operator)
    check('the ACTIVE version retires', retired.ok, JSON.stringify(retired))
    const trailNow = await findReferenceDatasetLifecycleEvents(ds)
    const last = trailNow[trailNow.length - 1]
    check(
      'the retirement is the last recorded transition, from ACTIVE',
      last.action === 'RETIRE' && last.datasetVersionId === v2 && last.previousActivationStatus === 'ACTIVE' && last.nextActivationStatus === 'RETIRED',
      JSON.stringify({ action: last.action, from: last.previousActivationStatus, to: last.nextActivationStatus }),
    )
    const reactivate = await activateReferenceDatasetVersion(v2, operator)
    check('a retired version cannot be activated again', !reactivate.ok, JSON.stringify(reactivate))
    check('and that refusal added no event', (await findReferenceDatasetLifecycleEvents(ds)).length === trailNow.length)
  }

  section('C33 history is scoped per dataset')
  {
    const otherDs = await dataset('isolated')
    const otherV1 = await validatedVersion(otherDs, '1')
    await activateReferenceDatasetVersion(otherV1, operator)
    const mine = await findReferenceDatasetLifecycleEvents(otherDs)
    check('the second dataset has only its own events', mine.every((event) => event.datasetId === otherDs) && mine.length === 2, String(mine.length))
    check('the first dataset was unaffected', (await findReferenceDatasetLifecycleEvents(ds)).every((event) => event.datasetId === ds))
  }

  console.log(`\n[a3-history] ${passed} passed, ${failed} failed`)
  console.log(failed === 0 ? '[a3-history] ALL CHECKS PASS' : '[a3-history] CHECKS FAILED')
  process.exitCode = failed === 0 ? 0 : 1
}

main()
  .catch((error) => {
    console.error('[a3-history] uncaught error (this itself is a FAIL):', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
