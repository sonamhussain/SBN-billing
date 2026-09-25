import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { Client } from 'pg'

// Audit F12 / C34 — a fresh empty-chain deployment is not the same thing as an intermediate
// database that already contains data. This script proves they converge: it replays every applied
// migration, in order, into a brand-new empty database, then compares that schema against the
// working database (which reached the same point by upgrading in place, with rows present).
//
// It never resets, rewrites or touches the working database — it only reads its catalog. The
// scratch database is created and dropped by this script alone.

const REPLAY_DB = 'sbn_migration_replay_proof'

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

const columnsQuery = `
  SELECT table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '-') AS line
  FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1`

const constraintsQuery = `
  SELECT conrelid::regclass || ':' || conname || ':' || pg_get_constraintdef(oid) AS line
  FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1`

const indexesQuery = `
  SELECT indexname || ':' || indexdef AS line FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`

const triggersQuery = `
  SELECT c.relname || ':' || t.tgname AS line
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
  WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace ORDER BY 1`

async function catalog(url: string): Promise<Record<string, string[]>> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    const read = async (sql: string) => (await client.query<{ line: string }>(sql)).rows.map((row) => row.line)
    return {
      columns: await read(columnsQuery),
      constraints: await read(constraintsQuery),
      indexes: await read(indexesQuery),
      triggers: await read(triggersQuery),
    }
  } finally {
    await client.end()
  }
}

function firstDifference(a: string[], b: string[]): string {
  const missing = a.filter((line) => !b.includes(line))
  const extra = b.filter((line) => !a.includes(line))
  return JSON.stringify({ onlyInWorking: missing.slice(0, 3), onlyInReplay: extra.slice(0, 3) })
}

async function withAdmin<T>(url: string, run: (client: Client) => Promise<T>): Promise<T> {
  const admin = new URL(url)
  admin.pathname = '/postgres'
  const client = new Client({ connectionString: admin.toString() })
  await client.connect()
  try {
    return await run(client)
  } finally {
    await client.end()
  }
}

async function main() {
  const workingUrl = process.env.DATABASE_URL
  if (!workingUrl) throw new Error('DATABASE_URL is required')

  const replayUrl = new URL(workingUrl)
  const workingName = replayUrl.pathname.replace(/^\//, '')
  replayUrl.pathname = `/${REPLAY_DB}`
  console.log(`[replay] working database ${workingName} -> scratch replay database ${REPLAY_DB}`)

  await withAdmin(workingUrl, async (client) => {
    await client.query(`DROP DATABASE IF EXISTS "${REPLAY_DB}" WITH (FORCE)`)
    await client.query(`CREATE DATABASE "${REPLAY_DB}"`)
  })

  try {
    console.log('[replay] applying every migration into the empty database...')
    // The Prisma CLI entry point is invoked directly rather than through npx, so this works the
    // same on Windows and POSIX without a shell.
    execFileSync(process.execPath, [createRequire(import.meta.url).resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: replayUrl.toString() },
      stdio: 'pipe',
    })

    const [working, replay] = [await catalog(workingUrl), await catalog(replayUrl.toString())]

    for (const part of ['columns', 'constraints', 'indexes', 'triggers'] as const) {
      const a = working[part]
      const b = replay[part]
      check(
        `${part}: the in-place upgrade and the clean replay agree (${a.length})`,
        a.length === b.length && a.every((line, index) => line === b[index]),
        firstDifference(a, b),
      )
    }

    // The hand-written objects the Migration Drift Guard exists to protect must survive a full
    // replay, not only the incremental path.
    const required = [
      'rule_applicabilities_exact_scope_uq',
      'rule_source_scopes_exact_scope_uq',
      'reference_dataset_versions_one_active_uq',
      'rule_packs_scope_pack_key_uq',
      'rule_pack_versions_one_active_uq',
      // A4.5: the two active-row partial unique indexes Prisma cannot express.
      'encounter_diagnoses_active_code_uidx',
      'encounter_diagnoses_active_sequence_uidx',
      // A4.6: modifier position and code are each unique within one activity.
      'encounter_activity_modifiers_encounter_activity_id_sequence_key',
      'encounter_activity_modifiers_encounter_activity_id_code_key',
    ]
    for (const name of required) {
      check(`${name} is present after a clean replay`, replay.indexes.some((line) => line.startsWith(`${name}:`)))
    }
    // A4.1–A4.7: the hand-written Patient, assignment-period, coverage-period, diagnosis-sequence,
    // activity identity/quantity/unit/modifier and observation typed-value CHECKs (plus the two
    // observation anchor FKs) must survive a clean replay too.
    for (const name of [
      'patients_given_name_not_blank_chk',
      'patients_family_name_not_blank_chk',
      'patients_middle_name_not_blank_chk',
      'clinician_facility_assignments_effective_period_chk',
      'clinician_specialty_assignments_effective_period_chk',
      'insurance_memberships_coverage_period_chk',
      'encounter_diagnoses_sequence_positive_chk',
      'encounter_activities_identity_chk',
      'encounter_activities_quantity_positive_chk',
      'encounter_activities_unit_code_nonblank_chk',
      'encounter_activity_modifiers_sequence_positive_chk',
      'encounter_activity_modifiers_code_nonblank_chk',
      'encounter_observations_fact_key_nonblank_chk',
      'encounter_observations_value_type_chk',
      'encounter_observations_text_nonblank_chk',
      'encounter_observations_unit_nonblank_chk',
      'encounter_observations_typed_value_chk',
      'encounter_observations_encounter_id_fkey',
      'encounter_observations_encounter_activity_id_fkey',
    ]) {
      check(`${name} is present after a clean replay`, replay.constraints.some((line) => line.includes(name)))
    }

    check(
      'the append-only trigger on the dataset history is present after a clean replay',
      replay.triggers.some((line) => line.includes('reference_dataset_lifecycle_events_append_only_trg')),
    )

    const appliedCount = await (async () => {
      const client = new Client({ connectionString: replayUrl.toString() })
      await client.connect()
      try {
        const rows = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
        )
        return Number(rows.rows[0].count)
      } finally {
        await client.end()
      }
    })()
    console.log(`[replay] ${appliedCount} migrations applied cleanly from empty`)
    check('every migration applied without a failure or rollback', appliedCount > 0)
  } finally {
    await withAdmin(workingUrl, async (client) => {
      await client.query(`DROP DATABASE IF EXISTS "${REPLAY_DB}" WITH (FORCE)`)
    })
    console.log('[replay] scratch database dropped; the working database was only ever read')
  }

  console.log(`\n[replay] ${passed} passed, ${failed} failed`)
  console.log(failed === 0 ? '[replay] ALL CHECKS PASS' : '[replay] CHECKS FAILED')
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((error) => {
  console.error('[replay] uncaught error (this itself is a FAIL):', error)
  process.exitCode = 1
})
