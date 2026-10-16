import 'dotenv/config'
import { writeFileSync } from 'node:fs'
import pg from 'pg'

// A5.6/A3.8 performance measurement — where an A5.6 evidence-completeness evaluation (the governed part of
// every A5.8 pre-claim validation execute) spends its time on the existing synthetic rule catalogue.
//
// Read-only: every evaluation runs inside a REPEATABLE READ transaction that is rolled back. Nothing is
// written. The pg driver's query method is wrapped in this process only, so the application code is
// measured exactly as it runs: the number of SQL statements, their total and slowest duration, and the
// rows they returned. Database activity is read from pg_stat_database before and after each evaluation
// on a separate connection that is not counted.
//
//   node --env-file=.env src/scripts/measure-a5-6-resolution.ts [label] [encounterCount] [resultJsonPath]

type QueryStat = { text: string; ms: number; rows: number }
let recording: QueryStat[] | null = null

const originalQuery = pg.Client.prototype.query as (...args: unknown[]) => unknown
pg.Client.prototype.query = function patchedQuery(this: unknown, ...args: unknown[]) {
  const started = performance.now()
  const result = originalQuery.apply(this, args)
  const sink = recording
  if (sink && result && typeof (result as Promise<unknown>).then === 'function') {
    const text = typeof args[0] === 'string' ? args[0] : String((args[0] as { text?: string })?.text ?? '')
    return (result as Promise<{ rowCount?: number | null; rows?: unknown[] }>).then(
      (value) => {
        sink.push({ text, ms: performance.now() - started, rows: value?.rowCount ?? value?.rows?.length ?? 0 })
        return value
      },
      (error) => {
        sink.push({ text, ms: performance.now() - started, rows: 0 })
        throw error
      },
    )
  }
  return result
} as typeof pg.Client.prototype.query

const label = process.argv[2] ?? 'measurement'
const encounterCount = Number(process.argv[3] ?? '4')
const organizationId = process.env.A1_IT_ORGANIZATION_ID as string

async function main() {
  const { prisma } = await import('../shared/database/prisma.ts')
  const { Prisma } = await import('../../generated/prisma/client.ts')
  const { evaluateEvidenceCompleteness } = await import('../modules/evidence-requirement/evidence-requirement.service.ts')
  const { findDocumentationRuleDefinitionIds } = await import('../modules/evidence-requirement/evidence-requirement.repository.ts')

  const stats = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await stats.connect()
  const activity = async () =>
    (
      await stats.query(
        `SELECT xact_commit + xact_rollback AS xacts, tup_returned, tup_fetched, blks_hit, blks_read FROM pg_stat_database WHERE datname = current_database()`,
      )
    ).rows[0] as Record<string, string>
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  // Representative encounters: the latest encounters of the test organization whose validation run
  // recorded a full commercial context (payer, contract, schedule, version).
  const encounters = await prisma.$queryRaw<{ encounter_id: string }[]>`
    SELECT encounter_id::text FROM (
      SELECT DISTINCT ON (vr.encounter_id) vr.encounter_id, vr.created_at
      FROM validation_runs vr JOIN encounters e ON e.id = vr.encounter_id JOIN patients p ON p.id = e.patient_id
      WHERE p.organization_id = ${organizationId}::uuid AND vr.tariff_schedule_version_id IS NOT NULL
      ORDER BY vr.encounter_id, vr.created_at DESC
    ) latest ORDER BY created_at DESC LIMIT ${encounterCount}`
  const catalogue = (
    await prisma.$queryRaw<{ definitions: bigint; versions: bigint; applicabilities: bigint }[]>`
      SELECT (SELECT count(*) FROM rule_definitions WHERE organization_id = ${organizationId}::uuid) AS definitions,
             (SELECT count(*) FROM rule_versions v JOIN rule_definitions d ON d.id = v.rule_id WHERE d.organization_id = ${organizationId}::uuid) AS versions,
             (SELECT count(*) FROM rule_applicabilities a JOIN rule_versions v ON v.id = a.rule_version_id JOIN rule_definitions d ON d.id = v.rule_id WHERE d.organization_id = ${organizationId}::uuid) AS applicabilities`
  )[0]
  const documentationDefinitions = (await findDocumentationRuleDefinitionIds(organizationId, 'DOCUMENTATION_REQUIREMENT_EFFECT', prisma)).length

  console.log(`[measure] ${label}: org catalogue ${catalogue.definitions} rule definitions, ${catalogue.versions} versions, ${catalogue.applicabilities} applicability rows; ${documentationDefinitions} documentation definitions; ${encounters.length} encounter(s)`)
  const results: Record<string, unknown>[] = []
  for (const { encounter_id: encounterId } of encounters) {
    const before = await activity()
    const queries: QueryStat[] = []
    recording = queries
    const started = performance.now()
    let outcome = ''
    try {
      await prisma.$transaction(
        async (tx) => {
          const result = await evaluateEvidenceCompleteness(encounterId, {}, tx)
          outcome = result.ok ? `ok, ${result.value.requirements.length} requirement(s)` : `${result.code}: ${result.message.slice(0, 120)}`
          throw new Prisma.PrismaClientKnownRequestError('measurement rollback', { code: 'MEASURE', clientVersion: 'measure' })
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 10_000, timeout: 1_800_000 },
      )
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('measurement rollback')) outcome = `error: ${String((error as Error).message ?? error).slice(0, 160)}`
    }
    const ms = performance.now() - started
    recording = null
    await pause(2_000) // let pg_stat_database settle (backend statistics are flushed asynchronously)
    const after = await activity()
    const delta = (key: string) => Number(after[key]) - Number(before[key])
    const byShape = new Map<string, { count: number; ms: number; rows: number }>()
    for (const q of queries) {
      const shape = q.text.replace(/\$\d+/g, '?').replace(/\s+/g, ' ').slice(0, 110)
      const entry = byShape.get(shape) ?? { count: 0, ms: 0, rows: 0 }
      entry.count += 1
      entry.ms += q.ms
      entry.rows += q.rows
      byShape.set(shape, entry)
    }
    const top = [...byShape.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 6)
    const row = {
      label,
      encounterId,
      outcome,
      seconds: Number((ms / 1000).toFixed(2)),
      queries: queries.length,
      querySeconds: Number((queries.reduce((s, q) => s + q.ms, 0) / 1000).toFixed(2)),
      rowsReturned: queries.reduce((s, q) => s + q.rows, 0),
      db: { tupReturned: delta('tup_returned'), tupFetched: delta('tup_fetched'), blksHit: delta('blks_hit'), blksRead: delta('blks_read') },
      topQueryShapes: top.map(([shape, s]) => ({ shape, count: s.count, seconds: Number((s.ms / 1000).toFixed(2)), rows: s.rows })),
    }
    results.push(row)
    console.log(`[measure] ${encounterId}: ${row.seconds}s, ${row.queries} queries (${row.querySeconds}s in SQL), ${row.rowsReturned} rows returned, tup_returned ${row.db.tupReturned}, tup_fetched ${row.db.tupFetched} — ${outcome}`)
    for (const t of row.topQueryShapes) console.log(`[measure]      ${t.count}x ${t.seconds}s ${t.rows} rows  ${t.shape}`)
  }
  // The machine-readable result goes to the path given as the third argument (never inside the repository).
  if (process.argv[4]) writeFileSync(process.argv[4], JSON.stringify({ label, catalogue: { ...catalogue, definitions: String(catalogue.definitions), versions: String(catalogue.versions), applicabilities: String(catalogue.applicabilities) }, documentationDefinitions, results }, null, 2))
  await stats.end()
  await prisma.$disconnect()
}

main().catch((error) => {
  console.error('[measure] failed:', error)
  process.exitCode = 1
})
