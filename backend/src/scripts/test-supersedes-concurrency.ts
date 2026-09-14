import 'dotenv/config'
import { prisma } from '../shared/database/prisma.ts'
import { createRelationship } from '../modules/rule-source-relationship/rule-source-relationship.service.ts'

// Reproducible proof for the A3.4 auditor's concurrency finding: two opposite SUPERSEDES
// creates (X SUPERSEDES Y and Y SUPERSEDES X) fired truly concurrently, in the same process,
// via Promise.all against the real service function — not sequential HTTP calls, which cannot
// reliably reproduce a genuine transaction race. Proves: (1) at most one commits, (2) the loser
// fails safely (never a raw 500 / uncaught exception), (3) the resulting graph is never cyclic.

async function main() {
  const userEmail = process.env.AUTHZ_BOOTSTRAP_USER_EMAIL
  const organizationId = process.env.AUTHZ_BOOTSTRAP_ORGANIZATION_ID
  if (!userEmail || !organizationId) {
    throw new Error('AUTHZ_BOOTSTRAP_USER_EMAIL and AUTHZ_BOOTSTRAP_ORGANIZATION_ID are required')
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { email: userEmail } })

  const source = await prisma.ruleSource.create({
    data: {
      organizationId,
      jurisdictionCode: 'AE-DU',
      issuingAuthority: 'Concurrency Test Authority',
      sourceCategory: 'OTHER',
      referenceNumber: `CONC-${Date.now()}`,
      title: 'Concurrency Test Source',
      ownershipScope: 'ORGANIZATION',
    },
  })

  const versionX = await prisma.ruleSourceVersion.create({
    data: { sourceId: source.id, version: 'x', rawEvidenceRef: 'synthetic-evidence://concurrency/x' },
  })
  const versionY = await prisma.ruleSourceVersion.create({
    data: { sourceId: source.id, version: 'y', rawEvidenceRef: 'synthetic-evidence://concurrency/y' },
  })

  console.log(`[concurrency] source=${source.id} X=${versionX.id} Y=${versionY.id}`)
  console.log('[concurrency] firing X SUPERSEDES Y and Y SUPERSEDES X concurrently via Promise.all (5 simultaneous attempts each side) ...')

  const attempts = Array.from({ length: 5 }, () => [
    createRelationship(versionX.id, versionY.id, 'SUPERSEDES', user.id),
    createRelationship(versionY.id, versionX.id, 'SUPERSEDES', user.id),
  ]).flat()

  const allResults = await Promise.allSettled(attempts)
  console.log(`[concurrency] fired ${attempts.length} concurrent requests total (5x X->Y, 5x Y->X)`)
  allResults.forEach((r, i) => {
    const label = i % 2 === 0 ? 'X->Y' : 'Y->X'
    console.log(`[concurrency] attempt ${i} (${label}):`, r.status === 'fulfilled' ? JSON.stringify(r.value) : `REJECTED: ${r.reason}`)
  })

  let pass = true

  const crashed = allResults.filter((r) => r.status === 'rejected')
  if (crashed.length > 0) {
    console.log(`[concurrency] FAIL — ${crashed.length} request(s) threw/crashed instead of returning a safe result`)
    pass = false
  } else {
    console.log('[concurrency] PASS — every request resolved to a safe typed result, none threw a raw exception')
  }

  const fulfilled = allResults.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof createRelationship>>>).value)
  const succeeded = fulfilled.filter((r) => r.ok)

  if (succeeded.length !== 1) {
    console.log(`[concurrency] FAIL — expected exactly 1 success across all ${attempts.length} concurrent attempts, got ${succeeded.length}`)
    pass = false
  } else {
    console.log('[concurrency] PASS — exactly one edge committed across all concurrent attempts')
  }

  const edges = await prisma.ruleSourceRelationship.findMany({
    where: { relationshipType: 'SUPERSEDES', fromSourceVersionId: { in: [versionX.id, versionY.id] } },
  })
  console.log(`[concurrency] SUPERSEDES edges between X/Y after race: ${edges.length}`, edges.map((e) => `${e.fromSourceVersionId}->${e.toSourceVersionId}`))

  if (edges.length !== 1) {
    console.log(`[concurrency] FAIL — graph must contain exactly 1 edge (no cycle possible), found ${edges.length}`)
    pass = false
  } else {
    console.log('[concurrency] PASS — graph contains exactly one SUPERSEDES edge; no cycle formed')
  }

  console.log(pass ? '[concurrency] ALL CHECKS PASS' : '[concurrency] CHECKS FAILED')
  process.exitCode = pass ? 0 : 1
}

main()
  .catch((error) => {
    console.error('[concurrency] uncaught error (this itself is a FAIL — no raw crash expected):', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
