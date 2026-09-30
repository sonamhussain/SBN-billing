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
      // A4.8: the two lookup indexes for the additive Patient/Encounter identity targets.
      'external_identifiers_patient_id_idx',
      'external_identifiers_encounter_id_idx',
      // A5.1: version numbering is unique per artifact, which is half of what makes the
      // sequence gap-free; the row lock in the service is the other half.
      'evidence_artifact_versions_evidence_artifact_id_version_key',
      // A5.2: the lookup indexes a verification history is read through. There is deliberately no
      // unique index among them — repeated verification of one encounter is legitimate, and one
      // external response may support more than one encounter.
      'eligibility_verifications_encounter_id_idx',
      'eligibility_verifications_response_evidence_version_id_idx',
      'eligibility_verifications_responded_at_idx',
      'eligibility_verifications_valid_through_idx',
      // A5.3: version numbering is unique per authorization, which is half of what makes the
      // sequence gap-free; the parent row lock in the service is the other half. The evidence
      // triple stops the same version being linked to the same evidence twice in one role.
      'prior_authorization_versions_prior_authorization_id_version_key',
      'prior_authorization_version_evidence_prior_authorization_ve_key',
      'prior_authorizations_encounter_id_idx',
      'prior_authorization_versions_status_idx',
      'prior_authorization_versions_valid_through_idx',
      // A5.4: line numbering is unique per authorization version. There is deliberately no unique index
      // on the service, procedure or diagnosis combination.
      'authorization_lines_prior_authorization_version_id_sequence_key',
      'authorization_lines_prior_authorization_version_id_idx',
      'authorization_lines_status_idx',
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
      // A4.8: the exact-one-target gate is dropped and re-added under its original name, so a
      // replay that lost it would leave the identity table with no target invariant at all.
      // Its column list is asserted separately below.
      'external_identifiers_exactly_one_target_chk',
      'external_identifiers_patient_id_fkey',
      'external_identifiers_encounter_id_fkey',
      // A5.1: the four evidence-version CHECKs and the three RESTRICT foreign keys that
      // keep evidence, its organization and its author from being deleted out from under it.
      'evidence_artifact_versions_version_positive_chk',
      'evidence_artifact_versions_storage_ref_nonblank_chk',
      'evidence_artifact_versions_content_hash_nonblank_chk',
      'evidence_artifact_versions_document_type_nonblank_chk',
      'evidence_artifacts_organization_id_fkey',
      'evidence_artifact_versions_evidence_artifact_id_fkey',
      'evidence_artifact_versions_created_by_user_id_fkey',
      // A5.2: the closed status and method vocabularies, the two timestamp-ordering CHECKs, and
      // the RESTRICT foreign keys that stop a verification losing the encounter, membership,
      // commercial identity or evidence it was recorded against. A replay that lost the status
      // CHECK would leave a table where a verification could claim a result this domain has never
      // defined.
      'eligibility_verifications_status_chk',
      'eligibility_verifications_method_chk',
      'eligibility_verifications_request_response_order_chk',
      'eligibility_verifications_validity_order_chk',
      'eligibility_verifications_encounter_id_fkey',
      'eligibility_verifications_insurance_membership_id_fkey',
      'eligibility_verifications_payer_id_fkey',
      'eligibility_verifications_tpa_id_fkey',
      'eligibility_verifications_network_id_fkey',
      'eligibility_verifications_insurance_product_id_fkey',
      'eligibility_verifications_request_evidence_version_id_fkey',
      'eligibility_verifications_response_evidence_version_id_fkey',
      // A5.3: the three closed vocabularies, the numbering and ordering CHECKs, the rule that a
      // decision must say when it was made, and the RESTRICT foreign keys that stop an authorization
      // losing the encounter, membership, commercial identity, provider, eligibility or evidence it
      // was recorded against. A replay that lost the status CHECK would leave a table where an
      // authorization could claim a result this domain has never defined.
      'prior_authorization_versions_version_positive_chk',
      'prior_authorization_versions_kind_chk',
      'prior_authorization_versions_status_chk',
      'prior_authorization_versions_reference_nonblank_chk',
      'prior_authorization_versions_timing_order_chk',
      'prior_authorization_versions_validity_order_chk',
      'prior_authorization_versions_decision_response_chk',
      'prior_authorization_version_evidence_role_chk',
      'prior_authorizations_encounter_id_fkey',
      'prior_authorizations_insurance_membership_id_fkey',
      'prior_authorizations_facility_id_fkey',
      'prior_authorizations_clinician_id_fkey',
      'prior_authorization_versions_prior_authorization_id_fkey',
      'prior_authorization_versions_eligibility_verification_id_fkey',
      'prior_authorization_versions_created_by_user_id_fkey',
      'prior_authorization_version_evidence_prior_authorization_v_fkey',
      'prior_authorization_version_evidence_evidence_artifact_ver_fkey',
      // A5.4: identity, quantity, unit, date and status CHECKs, and the RESTRICT foreign keys that stop a
      // line losing the version, masters or author it was recorded against.
      'authorization_lines_sequence_positive_chk',
      'authorization_lines_identity_chk',
      'authorization_lines_requested_qty_positive_chk',
      'authorization_lines_approved_qty_nonnegative_chk',
      'authorization_lines_unit_code_nonblank_chk',
      'authorization_lines_approved_dates_order_chk',
      'authorization_lines_status_chk',
      'authorization_lines_prior_authorization_version_id_fkey',
      'authorization_lines_service_id_fkey',
      'authorization_lines_procedure_code_id_fkey',
      'authorization_lines_diagnosis_code_id_fkey',
      'authorization_lines_created_by_user_id_fkey',
    ]) {
      check(`${name} is present after a clean replay`, replay.constraints.some((line) => line.includes(name)))
    }

    check(
      'the append-only trigger on the dataset history is present after a clean replay',
      replay.triggers.some((line) => line.includes('reference_dataset_lifecycle_events_append_only_trg')),
    )

    // A5.1 — the immutability of evidence versions is the package's central promise, and it is
    // kept by a trigger rather than by convention. A replay that lost it would leave a database
    // where a past representation could be edited after a decision had been made against it.
    check(
      'the append-only trigger on evidence versions is present after a clean replay',
      replay.triggers.some((line) => line.includes('evidence_artifact_versions_append_only_trg')),
    )

    // A5.2 — an eligibility verification is a historical event, so correcting one means recording a
    // new row. A replay that lost this trigger would leave a database where a past verification's
    // status, timing or evidence could be rewritten after a decision had been made against it.
    check(
      'the append-only trigger on eligibility verifications is present after a clean replay',
      replay.triggers.some((line) => line.includes('eligibility_verifications_append_only_trg')),
    )

    // A5.3 — an authorization case, its lifecycle versions and the evidence backing them are all
    // historical fact. A replay that lost any of these three triggers would leave a database where a
    // past authorization's status, validity or evidence could be rewritten after a decision had been
    // made against it.
    for (const [table, trigger] of [
      ['prior authorizations', 'prior_authorizations_append_only_trg'],
      ['prior authorization versions', 'prior_authorization_versions_append_only_trg'],
      ['prior authorization evidence links', 'prior_authorization_version_evidence_append_only_trg'],
    ] as const) {
      check(`the append-only trigger on ${table} is present after a clean replay`, replay.triggers.some((line) => line.includes(trigger)))
    }

    // A5.3 — line scope belongs to A5.4. A5.3 records the authorization header; it must never grow a
    // service, procedure, diagnosis, quantity or approved-date column, and there must be no current
    // or satisfied flag. This is asserted structurally so a future migration cannot add one quietly.
    const authorizationColumns = replay.columns.filter((line) => line.startsWith('prior_authorization'))
    const lineScope = authorizationColumns.filter((line) =>
      /(service_id|procedure|diagnosis|quantity|approved_from|approved_through|line_status|is_current|is_active|is_satisfied|current_version)/i.test(line),
    )
    check(
      'prior authorization tables carry no A5.4 line scope or current-state flag after a clean replay',
      authorizationColumns.length > 0 && lineScope.length === 0,
      authorizationColumns.length === 0 ? 'the column catalog did not reach the tables, so this absence is unproven' : lineScope.join(', '),
    )

    // A5.4 — an authorization line is reported scope for one exact version. A replay that lost the
    // trigger would leave a database where approved quantities or dates could be rewritten after a
    // decision had been made against them.
    check(
      'the append-only trigger on authorization lines is present after a clean replay',
      replay.triggers.some((line) => line.includes('authorization_lines_append_only_trg')),
    )

    // A5.4 §23 — matching is computed, never stored. No line may carry the activity or claim line it
    // matched, a consumed quantity, a readiness or satisfaction state, or a price, and no table may
    // persist match results. Asserted structurally so a future migration cannot add one quietly.
    const lineColumns = replay.columns.filter((line) => line.startsWith('authorization_lines.'))
    const forbiddenLineColumns = lineColumns.filter((line) =>
      /(matched|encounter_activity|claim_line|consumed|utilized|is_current|is_satisfied|satisfied|ready|readiness|price|amount|tariff|contract)/i.test(line),
    )
    const matchTables = replay.columns.filter((line) => /^(authorization_line_match|scope_evaluation|authorization_match)/i.test(line))
    check(
      'authorization lines carry no match, claim-line, readiness or pricing column, and no match table exists, after a clean replay',
      lineColumns.length > 0 && forbiddenLineColumns.length === 0 && matchTables.length === 0,
      lineColumns.length === 0 ? 'the column catalog did not reach the table, so this absence is unproven' : [...forbiddenLineColumns, ...matchTables].join(', '),
    )

    // A5.2 — freshness is derived from valid_through at read time and must never become a column.
    // A stored flag would be wrong the moment the clock moved past it, and FRESH would start to be
    // read as ELIGIBLE, which it never means. This is asserted structurally so a future migration
    // cannot add one quietly.
    const verificationColumns = replay.columns.filter((line) => line.startsWith('eligibility_verifications.'))
    check(
      'eligibility verifications store no freshness column after a clean replay',
      verificationColumns.length > 0 && !verificationColumns.some((line) => /fresh|stale|is_current|is_primary/i.test(line)),
      verificationColumns.length === 0 ? 'the column catalog did not reach the table, so this absence is unproven' : '',
    )

    // A4.8 — the exact-one-target CHECK surviving is not enough: after a clean replay it must
    // still name all twelve approved target columns. A replay that rebuilt the A2.9 version
    // would pass the presence check above while silently allowing a Patient or Encounter row
    // to carry a second target.
    const exactOneTarget = replay.constraints.find((line) => line.includes('external_identifiers_exactly_one_target_chk')) ?? ''
    const targetColumns = [
      'organization_target_id',
      'facility_id',
      'clinician_id',
      'specialty_id',
      'payer_id',
      'tpa_id',
      'network_id',
      'service_id',
      'procedure_code_id',
      'diagnosis_code_id',
      'patient_id',
      'encounter_id',
    ]
    const missingTargets = targetColumns.filter((column) => !exactOneTarget.includes(column))
    check(
      'the exact-one-target CHECK names all 12 approved targets after a clean replay',
      missingTargets.length === 0 && exactOneTarget.includes('= 1'),
      JSON.stringify({ missingTargets, definition: exactOneTarget.slice(0, 200) }),
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
