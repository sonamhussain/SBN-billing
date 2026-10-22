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
      // A5.6: one payload per RuleVersion, one row per accepted document type, and — as a partial
      // index the Prisma model cannot express — one ACTIVE link per Encounter and evidence version.
      'evidence_requirements_rule_version_id_key',
      'evidence_requirement_document_types_evidence_requirement_id_key',
      'encounter_evidence_links_active_uq',
      'encounter_evidence_links_encounter_id_removed_at_idx',
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
      // A5.6: requirement CHECKs, the trimmed document-type CHECK, and the RESTRICT foreign keys that
      // stop a payload losing its RuleVersion or a link losing its Encounter, evidence or author.
      'evidence_requirements_minimum_count_chk',
      'evidence_requirements_max_source_age_nonnegative_chk',
      'evidence_requirements_freshness_requires_date_chk',
      'evidence_requirement_document_types_document_type_chk',
      'evidence_requirements_rule_version_id_fkey',
      'evidence_requirement_document_types_evidence_requirement_i_fkey',
      'encounter_evidence_links_encounter_id_fkey',
      'encounter_evidence_links_evidence_artifact_version_id_fkey',
      'encounter_evidence_links_created_by_user_id_fkey',
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

    // A5.6 — requirement payloads and their document types are immutable, and an evidence link is
    // corrected only by one-way removal. A replay that lost any of these triggers would leave a
    // database where a governed requirement or the evidence history could be rewritten.
    for (const [trigger, label] of [
      ['evidence_requirements_append_only_trg', 'evidence requirements'],
      ['evidence_requirement_document_types_append_only_trg', 'evidence requirement document types'],
      ['encounter_evidence_links_guard_trg', 'encounter evidence links'],
    ] as const) {
      check(
        `the immutability trigger on ${label} is present after a clean replay`,
        replay.triggers.some((line) => line.includes(trigger)),
      )
    }

    // A5.6 §19 — completeness is computed, never stored, and a link copies nothing about the evidence.
    // No completeness-result table, no copied A3 scope on a requirement, and no storage metadata on
    // a link. Asserted structurally so a future migration cannot add one quietly.
    const requirementColumns = replay.columns.filter((line) => line.startsWith('evidence_requirements.'))
    const linkColumns = replay.columns.filter((line) => line.startsWith('encounter_evidence_links.'))
    const copiedScope = requirementColumns.filter((line) =>
      /(payer|tpa|network|product|contract|tariff|service|procedure|diagnosis|jurisdiction|facility)/i.test(line),
    )
    const copiedEvidence = linkColumns.filter((line) => /(storage|content_hash|document_type|source_date|received_at)/i.test(line))
    // validation_runs and validation_findings are A5.7's own tables, asserted below; a completeness
    // result table remains forbidden.
    const resultTables = replay.columns.filter((line) => /^(evidence_completeness|completeness_result)/i.test(line))
    check(
      'evidence requirements copy no A3 scope, links copy no evidence metadata, and no completeness-result table exists, after a clean replay',
      requirementColumns.length > 0 && linkColumns.length > 0 && copiedScope.length === 0 && copiedEvidence.length === 0 && resultTables.length === 0,
      requirementColumns.length === 0 || linkColumns.length === 0
        ? 'the column catalog did not reach the tables, so this absence is unproven'
        : [...copiedScope, ...copiedEvidence, ...resultTables].join(', '),
    )

    // A5.7 — a run and its findings are historical evidence: neither can be updated or deleted, a
    // finding can only be recorded in its run's own transaction, and a run cannot commit empty. A
    // replay that lost any of these would leave validation history editable or incomplete.
    for (const [trigger, label] of [
      ['validation_runs_append_only_trg', 'the append-only trigger on validation runs'],
      ['validation_findings_append_only_trg', 'the append-only trigger on validation findings'],
      ['validation_findings_same_transaction_trg', 'the same-transaction trigger on validation findings'],
      ['validation_runs_require_findings_trg', 'the deferred non-empty-run trigger on validation runs'],
    ] as const) {
      check(`${label} is present after a clean replay`, replay.triggers.some((line) => line.includes(trigger)))
    }

    // A5.7 §13 — the vocabularies, safe-text bounds, sequence rule and every RESTRICT foreign key.
    for (const name of [
      'validation_runs_validator_version_chk',
      'validation_findings_sequence_positive_chk',
      'validation_findings_layer_chk',
      'validation_findings_outcome_chk',
      'validation_findings_finding_code_chk',
      'validation_findings_message_chk',
      'validation_findings_field_path_chk',
      'validation_runs_encounter_id_fkey',
      'validation_runs_facility_id_fkey',
      'validation_runs_facility_regulatory_profile_id_fkey',
      'validation_runs_insurance_membership_id_fkey',
      'validation_runs_payer_id_fkey',
      'validation_runs_tpa_id_fkey',
      'validation_runs_network_id_fkey',
      'validation_runs_insurance_product_id_fkey',
      'validation_runs_provider_contract_id_fkey',
      'validation_runs_tariff_schedule_id_fkey',
      'validation_runs_tariff_schedule_version_id_fkey',
      'validation_runs_created_by_user_id_fkey',
      'validation_findings_validation_run_id_fkey',
      'validation_findings_rule_version_id_fkey',
      'validation_findings_governing_source_version_id_fkey',
      'validation_findings_reference_dataset_version_id_fkey',
      'validation_findings_encounter_activity_id_fkey',
      'validation_findings_encounter_diagnosis_id_fkey',
      'validation_findings_eligibility_verification_id_fkey',
      'validation_findings_prior_authorization_version_id_fkey',
      'validation_findings_authorization_line_id_fkey',
      'validation_findings_evidence_requirement_id_fkey',
      'validation_findings_evidence_artifact_version_id_fkey',
    ]) {
      const line = replay.constraints.find((candidate) => candidate.includes(name)) ?? ''
      check(`${name} is present after a clean replay`, line !== '' && (!name.endsWith('_fkey') || line.includes('ON DELETE RESTRICT')), line.slice(0, 160))
    }
    for (const name of ['validation_findings_validation_run_id_sequence_key', 'validation_runs_encounter_id_evaluated_at_idx', 'validation_findings_finding_code_idx']) {
      check(`${name} is present after a clean replay`, replay.indexes.some((line) => line.startsWith(`${name}:`)))
    }

    // A5.7 §3/§23 — no run status, no current/latest pointer, no overall outcome or readiness, no
    // organization copy, no sensitive identity copy, no ClaimLine and no generic JSON blob. Asserted
    // structurally so a future migration cannot add one quietly.
    const runColumns = replay.columns.filter((line) => line.startsWith('validation_runs.'))
    const findingColumns = replay.columns.filter((line) => line.startsWith('validation_findings.'))
    const forbiddenRunColumns = runColumns.filter((line) =>
      /\.(status|is_current|is_latest|current|latest|overall_outcome|outcome|readiness|ready|approved_for_submission|payer_accepted|organization_id|member_identifier|policy_identifier|authorization_reference)\b/i.test(line),
    )
    const forbiddenFindingColumns = findingColumns.filter((line) => /\.(claim_line_id|claim_id|readiness|is_current)\b/i.test(line))
    const jsonColumns = [...runColumns, ...findingColumns].filter((line) => /\b(json|jsonb)\b/i.test(line))
    check(
      'validation runs and findings carry no status, current/latest, overall outcome, readiness, organization, sensitive identity, ClaimLine or JSON column after a clean replay',
      runColumns.length > 0 && findingColumns.length > 0 && forbiddenRunColumns.length === 0 && forbiddenFindingColumns.length === 0 && jsonColumns.length === 0,
      runColumns.length === 0 || findingColumns.length === 0
        ? 'the column catalog did not reach the tables, so this absence is unproven'
        : [...forbiddenRunColumns, ...forbiddenFindingColumns, ...jsonColumns].join(', '),
    )

    // A5.8 — the normalized A3-PROV-1 provenance of governed findings. All four tables are append-only,
    // and a row can only be written with its own finding. A replay that lost any of these would leave
    // the decision basis of a historical finding editable, or attachable after the fact.
    const provenanceTables = [
      'validation_finding_rule_provenances',
      'validation_finding_supporting_bindings',
      'validation_finding_matched_applicabilities',
      'validation_finding_reference_dataset_versions',
    ]
    // Trigger names are listed exactly: Postgres truncates an identifier beyond 63 characters, so a
    // derived name could silently stop matching the trigger it means.
    for (const trigger of [
      'validation_finding_rule_provenances_append_only_trg',
      'validation_finding_supporting_bindings_append_only_trg',
      'validation_finding_matched_applicabilities_append_only_trg',
      'validation_finding_reference_dataset_versions_append_only_trg',
      'validation_finding_rule_provenances_same_transaction_trg',
      'validation_finding_supporting_bindings_same_transaction_trg',
      'validation_finding_matched_applicabilities_same_transaction_trg',
      'validation_finding_ref_dataset_versions_same_transaction_trg',
    ]) {
      check(`${trigger} is present after a clean replay`, replay.triggers.some((line) => line.endsWith(`:${trigger}`)))
    }
    for (const table of provenanceTables) {
      check(`${table}_pkey is present after a clean replay`, replay.constraints.some((line) => line.includes(`${table}_pkey`)))
    }
    // §16 — every provenance foreign key is ON DELETE RESTRICT, and the two label CHECKs survive.
    for (const name of [
      'validation_finding_rule_provenances_contract_version_chk',
      'validation_finding_rule_provenances_policy_version_chk',
      'validation_finding_rule_provenances_validation_finding_id_fkey',
      'validation_finding_rule_provenances_rule_pack_version_id_fkey',
      'validation_finding_rule_provenances_governing_binding_id_fkey',
      'validation_finding_rule_provenances_governing_source_inter_fkey',
      'validation_finding_supporting_bindings_validation_finding__fkey',
      'validation_finding_supporting_bindings_rule_source_binding_fkey',
      'validation_finding_matched_applicabilities_validation_find_fkey',
      'validation_finding_matched_applicabilities_rule_applicabil_fkey',
      'validation_finding_reference_dataset_versions_validation_f_fkey',
      'validation_finding_reference_dataset_versions_reference_da_fkey',
    ]) {
      const line = replay.constraints.find((candidate) => candidate.includes(name)) ?? ''
      check(`${name} is present after a clean replay`, line !== '' && (!name.endsWith('_fkey') || line.includes('ON DELETE RESTRICT')), line.slice(0, 160))
    }
    // §16 — no provenance JSON/JSONB column anywhere in the four tables.
    const provenanceColumns = replay.columns.filter((line) => provenanceTables.some((table) => line.startsWith(`${table}.`)))
    const provenanceJson = provenanceColumns.filter((line) => /\b(json|jsonb)\b/i.test(line))
    check(
      'the four provenance tables carry no JSON or JSONB column after a clean replay',
      provenanceColumns.length > 0 && provenanceJson.length === 0,
      provenanceColumns.length === 0 ? 'the column catalog did not reach the tables, so this absence is unproven' : provenanceJson.join(', '),
    )

    // A5.9 — a readiness assessment is historical business truth: the database refuses UPDATE and
    // DELETE, holds the state vocabulary and the policy label, keeps one assessment per run and policy,
    // and restricts deletion of the run and the actor it names.
    check(
      'pre_claim_readiness_assessments_append_only_trg is present after a clean replay',
      replay.triggers.some((line) => line.endsWith(':pre_claim_readiness_assessments_append_only_trg')),
    )
    for (const name of [
      'pre_claim_readiness_assessments_pkey',
      'pre_claim_readiness_assessments_state_chk',
      'pre_claim_readiness_assessments_policy_version_chk',
      'pre_claim_readiness_assessments_validation_run_id_fkey',
      'pre_claim_readiness_assessments_created_by_user_id_fkey',
    ]) {
      const line = replay.constraints.find((candidate) => candidate.includes(name)) ?? ''
      check(`${name} is present after a clean replay`, line !== '' && (!name.endsWith('_fkey') || line.includes('ON DELETE RESTRICT')), line.slice(0, 160))
    }
    check(
      'the one-assessment-per-run-and-policy unique index is present after a clean replay',
      replay.indexes.some((line) => line.startsWith('pre_claim_readiness_assessments_validation_run_id_readiness_key:') && /UNIQUE/i.test(line)),
    )
    // §6 — the assessment copies no counts, reasons, context, claim or payer state, and there is no
    // handoff, reason or current-pointer table: the A6 handoff is a read-time contract.
    const readinessColumns = replay.columns.filter((line) => line.startsWith('pre_claim_readiness_assessments.'))
    const forbiddenReadinessColumns = readinessColumns.filter((line) =>
      /\.(\w*count\w*|\w*reason\w*|encounter_id|facility_id|payer_id|organization_id|is_current|is_latest|current|latest|claim\w*|approved\w*|submitted\w*|status)[:]|[:](json|jsonb)[:]/i.test(line),
    )
    const handoffTables = replay.columns.filter((line) => /^(pre_claim_a6_handoff|a6_handoff|pre_claim_readiness_reason|readiness_current)/i.test(line))
    check(
      'readiness assessments copy no counts, reasons, context, claim or payer state, and no handoff or pointer table exists, after a clean replay',
      readinessColumns.length > 0 && forbiddenReadinessColumns.length === 0 && handoffTables.length === 0,
      readinessColumns.length === 0
        ? 'the column catalog did not reach the table, so this absence is unproven'
        : [...forbiddenReadinessColumns, ...handoffTables].join(', '),
    )

    // A6.1 — the Claim is a stable identity bound to one exact readiness assessment of its own
    // Encounter. The database holds both contract labels, keeps one Claim per assessment, refuses a
    // cross-Encounter binding and refuses any change to the identity or a delete.
    for (const trigger of ['claims_binding_coherence_trg', 'claims_identity_guard_trg']) {
      check(`${trigger} is present after a clean replay`, replay.triggers.some((line) => line.endsWith(`:${trigger}`)))
    }
    for (const name of [
      'claims_pkey',
      'claims_claim_contract_version_chk',
      'claims_handoff_schema_version_chk',
      'claims_encounter_id_fkey',
      'claims_pre_claim_readiness_assessment_id_fkey',
      'claims_created_by_user_id_fkey',
    ]) {
      const line = replay.constraints.find((candidate) => candidate.includes(name)) ?? ''
      check(`${name} is present after a clean replay`, line !== '' && (!name.endsWith('_fkey') || line.includes('ON DELETE RESTRICT')), line.slice(0, 160))
    }
    const contractCheck = replay.constraints.find((line) => line.includes('claims_claim_contract_version_chk')) ?? ''
    const handoffCheck = replay.constraints.find((line) => line.includes('claims_handoff_schema_version_chk')) ?? ''
    check(
      'the two Claim CHECKs pin A6-CLAIM-1 and PreClaimA6HandoffV1 after a clean replay',
      contractCheck.includes("'A6-CLAIM-1'") && handoffCheck.includes("'PreClaimA6HandoffV1'"),
      `${contractCheck.slice(0, 120)} | ${handoffCheck.slice(0, 120)}`,
    )
    check(
      'the one-Claim-per-assessment unique index is present after a clean replay',
      replay.indexes.some((line) => line.startsWith('claims_pre_claim_readiness_assessment_id_key:') && /UNIQUE/i.test(line)),
    )
    // §6/§T027 — many Claims may exist for one Encounter, and no A5 context, money, lifecycle,
    // approval, payload or current pointer is copied onto the row.
    check(
      'no unique index on claims.encounter_id after a clean replay',
      !replay.indexes.some((line) => line.startsWith('claims_') && /UNIQUE/i.test(line) && /\(encounter_id\)/.test(line)),
    )
    const claimColumns = replay.columns.filter((line) => line.startsWith('claims.'))
    const allowedClaimColumns = ['id', 'encounter_id', 'pre_claim_readiness_assessment_id', 'claim_contract_version', 'handoff_schema_version', 'created_by_user_id', 'created_at']
    const unexpectedClaimColumns = claimColumns.filter((line) => !allowedClaimColumns.includes(line.slice('claims.'.length).split(':')[0]))
    check(
      'claims carries exactly its seven identity columns after a clean replay',
      claimColumns.length === allowedClaimColumns.length && unexpectedClaimColumns.length === 0,
      claimColumns.length === 0 ? 'the column catalog did not reach the table, so this absence is unproven' : unexpectedClaimColumns.join(', '),
    )

    // A6.2 — the Claim's draft line and diagnosis structure. Positions, contracts and roles are held by
    // the database; sources must be of the Claim's Encounter and in its bound handoff reference set; a
    // pointer joins an active line and an active diagnosis of the same Claim; history is one-way and
    // nothing is deleted. Exactly four tables, none carrying a copied source fact, price or payload.
    for (const trigger of [
      'claim_lines_insert_guard_trg',
      'claim_lines_source_required_trg',
      'claim_lines_history_guard_trg',
      'claim_line_source_activities_insert_guard_trg',
      'claim_line_source_activities_append_only_trg',
      'claim_diagnoses_insert_guard_trg',
      'claim_diagnoses_history_guard_trg',
      'claim_line_diagnosis_pointers_insert_guard_trg',
      'claim_line_diagnosis_pointers_history_guard_trg',
    ]) {
      check(`${trigger} is present after a clean replay`, replay.triggers.some((line) => line.endsWith(`:${trigger}`)))
    }
    for (const name of [
      'claim_lines_pkey',
      'claim_lines_sequence_chk',
      'claim_lines_contract_version_chk',
      'claim_lines_claim_id_fkey',
      'claim_lines_created_by_user_id_fkey',
      'claim_line_source_activities_pkey',
      'claim_line_source_activities_claim_line_id_fkey',
      'claim_line_source_activities_encounter_activity_id_fkey',
      'claim_diagnoses_pkey',
      'claim_diagnoses_sequence_chk',
      'claim_diagnoses_contract_version_chk',
      'claim_diagnoses_role_code_chk',
      'claim_diagnoses_claim_id_fkey',
      'claim_diagnoses_encounter_diagnosis_id_fkey',
      'claim_diagnoses_created_by_user_id_fkey',
      'claim_line_diagnosis_pointers_pkey',
      'claim_line_diagnosis_pointers_claim_line_id_fkey',
      'claim_line_diagnosis_pointers_claim_diagnosis_id_fkey',
      'claim_line_diagnosis_pointers_created_by_user_id_fkey',
    ]) {
      const line = replay.constraints.find((candidate) => candidate.includes(`:${name}:`)) ?? ''
      check(`${name} is present after a clean replay`, line !== '' && (!name.endsWith('_fkey') || line.includes('ON DELETE RESTRICT')), line.slice(0, 160))
    }
    const lineContract = replay.constraints.find((line) => line.includes('claim_lines_contract_version_chk')) ?? ''
    const diagnosisContract = replay.constraints.find((line) => line.includes('claim_diagnoses_contract_version_chk')) ?? ''
    const roleCheck = replay.constraints.find((line) => line.includes('claim_diagnoses_role_code_chk')) ?? ''
    check(
      'the A6.2 CHECKs pin A6-LINE-1, A6-DX-1 and exactly PRIMARY, SECONDARY and ADMITTING after a clean replay',
      lineContract.includes("'A6-LINE-1'") && diagnosisContract.includes("'A6-DX-1'") && ['PRIMARY', 'SECONDARY', 'ADMITTING'].every((role) => roleCheck.includes(`'${role}'`)),
      `${lineContract.slice(0, 80)} | ${diagnosisContract.slice(0, 80)} | ${roleCheck.slice(0, 120)}`,
    )
    for (const [name, columns] of [
      ['claim_lines_active_sequence_uidx', '(claim_id, sequence)'],
      ['claim_diagnoses_active_sequence_uidx', '(claim_id, sequence)'],
      ['claim_diagnoses_active_source_uidx', '(claim_id, encounter_diagnosis_id)'],
      ['claim_line_diagnosis_pointers_active_uidx', '(claim_line_id, claim_diagnosis_id)'],
    ] as const) {
      const line = replay.indexes.find((candidate) => candidate.startsWith(`${name}:`)) ?? ''
      check(`${name} is a partial unique index on ${columns} over active rows after a clean replay`, /UNIQUE/i.test(line) && line.includes(columns) && /WHERE \(removed_at IS NULL\)/.test(line), line.slice(0, 200))
    }
    const a62Tables = {
      claim_lines: ['id', 'claim_id', 'sequence', 'claim_line_contract_version', 'removed_at', 'created_by_user_id', 'created_at', 'updated_at'],
      claim_line_source_activities: ['id', 'claim_line_id', 'encounter_activity_id', 'created_at'],
      claim_diagnoses: ['id', 'claim_id', 'encounter_diagnosis_id', 'sequence', 'role_code', 'claim_diagnosis_contract_version', 'removed_at', 'created_by_user_id', 'created_at', 'updated_at'],
      claim_line_diagnosis_pointers: ['id', 'claim_line_id', 'claim_diagnosis_id', 'removed_at', 'created_by_user_id', 'created_at', 'updated_at'],
    }
    for (const [table, allowed] of Object.entries(a62Tables)) {
      const columns = replay.columns.filter((line) => line.startsWith(`${table}.`)).map((line) => line.slice(table.length + 1).split(':')[0])
      const unexpected = columns.filter((column) => !allowed.includes(column))
      check(
        `${table} carries exactly its ${allowed.length} A6.2 columns after a clean replay`,
        columns.length === allowed.length && unexpected.length === 0,
        columns.length === 0 ? 'the column catalog did not reach the table, so this absence is unproven' : unexpected.join(', '),
      )
    }
    // No other claim-line, claim-diagnosis, lifecycle, payload or submission table exists. The two A6.3
    // pricing tables, the two A6.4 draft tables, the A6.5 review decision table, the A6.7/A6.8 freeze tables
    // and the A6.9 correction link table are owned and verified by their own blocks below, so they are set
    // aside here.
    const claimTables = [
      ...new Set(
        replay.columns.map((line) => line.split('.')[0]).filter((table) => /^claim/.test(table) && !/^claim_(pricing|draft|review)_/.test(table) && !/^claim_freeze/.test(table) && !/^claim_correction/.test(table)),
      ),
    ].sort()
    check(
      'the claim tables are exactly claims plus the four A6.2 tables after a clean replay',
      JSON.stringify(claimTables) === JSON.stringify(['claim_diagnoses', 'claim_line_diagnosis_pointers', 'claim_line_source_activities', 'claim_lines', 'claims']),
      claimTables.join(', '),
    )

    // A6.3 — governed tariff rates and immutable draft pricing runs. Selector, currency, amount, unit and
    // contract are held by the database; an active rate identity is unique (NULLS NOT DISTINCT); rates are
    // written and retired only under an UNVERIFIED version and never deleted; a run prices exactly the
    // Claim's bound commercial lineage, is complete at commit and is append-only with its line results.
    for (const trigger of [
      'tariff_rates_insert_guard_trg',
      'tariff_rates_history_guard_trg',
      'claim_pricing_runs_insert_guard_trg',
      'claim_pricing_runs_append_only_trg',
      'claim_pricing_runs_complete_trg',
      'claim_pricing_line_results_insert_guard_trg',
      'claim_pricing_line_results_append_only_trg',
    ]) {
      check(`${trigger} is present after a clean replay`, replay.triggers.some((line) => line.endsWith(`:${trigger}`)))
    }
    for (const name of [
      'tariff_rates_pkey',
      'tariff_rates_selector_chk',
      'tariff_rates_currency_chk',
      'tariff_rates_amount_chk',
      'tariff_rates_unit_code_chk',
      'tariff_rates_contract_version_chk',
      'tariff_rates_tariff_schedule_version_id_fkey',
      'tariff_rates_service_id_fkey',
      'tariff_rates_procedure_code_id_fkey',
      'tariff_rates_created_by_user_id_fkey',
      'claim_pricing_runs_pkey',
      'claim_pricing_runs_contract_version_chk',
      'claim_pricing_runs_counts_chk',
      'claim_pricing_runs_result_chk',
      'claim_pricing_runs_fingerprint_chk',
      'claim_pricing_runs_claim_id_fkey',
      'claim_pricing_runs_tariff_schedule_version_id_fkey',
      'claim_pricing_runs_provider_contract_id_fkey',
      'claim_pricing_runs_tariff_schedule_id_fkey',
      'claim_pricing_runs_created_by_user_id_fkey',
      'claim_pricing_line_results_pkey',
      'claim_pricing_line_results_outcome_chk',
      'claim_pricing_line_results_quantity_chk',
      'claim_pricing_line_results_sequence_chk',
      'claim_pricing_line_results_fingerprint_chk',
      'claim_pricing_line_results_pricing_run_id_fkey',
      'claim_pricing_line_results_claim_line_id_fkey',
      'claim_pricing_line_results_encounter_activity_id_fkey',
      'claim_pricing_line_results_tariff_rate_id_fkey',
    ]) {
      const line = replay.constraints.find((candidate) => candidate.includes(`:${name}:`)) ?? ''
      check(`${name} is present after a clean replay`, line !== '' && (!name.endsWith('_fkey') || line.includes('ON DELETE RESTRICT')), line.slice(0, 160))
    }
    const rateContract = replay.constraints.find((line) => line.includes('tariff_rates_contract_version_chk')) ?? ''
    const pricingContract = replay.constraints.find((line) => line.includes('claim_pricing_runs_contract_version_chk')) ?? ''
    check(
      'the A6.3 CHECKs pin A6-RATE-1 and A6-PRICE-1 after a clean replay',
      rateContract.includes("'A6-RATE-1'") && pricingContract.includes("'A6-PRICE-1'"),
      `${rateContract.slice(0, 100)} | ${pricingContract.slice(0, 100)}`,
    )
    const rateIdentityIndex = replay.indexes.find((line) => line.startsWith('tariff_rates_active_identity_uidx:')) ?? ''
    check(
      'tariff_rates_active_identity_uidx is a partial NULLS NOT DISTINCT unique index over active rates after a clean replay',
      /UNIQUE/i.test(rateIdentityIndex) && /NULLS NOT DISTINCT/i.test(rateIdentityIndex) && /WHERE \(removed_at IS NULL\)/.test(rateIdentityIndex),
      rateIdentityIndex.slice(0, 220),
    )
    check(
      'one result per line per pricing run is unique after a clean replay',
      replay.indexes.some((line) => line.startsWith('claim_pricing_line_results_pricing_run_id_claim_line_id_key:') && /UNIQUE/i.test(line)),
    )
    const a63Tables = {
      tariff_rates: ['id', 'tariff_schedule_version_id', 'selector_kind', 'service_id', 'procedure_code_id', 'unit_code_key', 'modifier_signature', 'currency_code', 'unit_tariff_amount', 'rate_contract_version', 'removed_at', 'created_by_user_id', 'created_at'],
      claim_pricing_runs: ['id', 'claim_id', 'pricing_contract_version', 'tariff_schedule_version_id', 'provider_contract_id', 'tariff_schedule_id', 'evaluated_at', 'created_by_user_id', 'input_structure_fingerprint', 'overall_result', 'line_count', 'priced_count', 'currency_code', 'total_extended_amount', 'created_at'],
      claim_pricing_line_results: ['id', 'pricing_run_id', 'claim_line_id', 'encounter_activity_id', 'tariff_rate_id', 'line_sequence_at_evaluation', 'outcome', 'unit_tariff_amount', 'quantity_at_evaluation', 'extended_amount', 'currency_code', 'input_fingerprint', 'created_at'],
    }
    for (const [table, allowed] of Object.entries(a63Tables)) {
      const columns = replay.columns.filter((line) => line.startsWith(`${table}.`)).map((line) => line.slice(table.length + 1).split(':')[0])
      const unexpected = columns.filter((column) => !allowed.includes(column))
      check(
        `${table} carries exactly its ${allowed.length} A6.3 columns after a clean replay`,
        columns.length === allowed.length && unexpected.length === 0,
        columns.length === 0 ? 'the column catalog did not reach the table, so this absence is unproven' : unexpected.join(', '),
      )
    }
    const pricingTables = [...new Set(replay.columns.map((line) => line.split('.')[0]).filter((table) => /^claim_pricing_|^tariff_rate/.test(table)))].sort()
    check(
      'the A6.3 tables are exactly tariff_rates, claim_pricing_runs and claim_pricing_line_results after a clean replay',
      JSON.stringify(pricingTables) === JSON.stringify(['claim_pricing_line_results', 'claim_pricing_runs', 'tariff_rates']),
      pricingTables.join(', '),
    )

    // A6.4 — immutable claim draft assessments and their structured findings. The contract, the four
    // outcomes, the fingerprints, the finding vocabulary and the 1..N ordinals are held by the database; an
    // assessment judges only a pricing run of its own Claim under that Claim's bound readiness assessment,
    // a finding is written with its own assessment about that Claim's rows, both are append-only, and an
    // assessment is complete at commit with REVIEWABLE exactly when no finding is a blocker.
    for (const trigger of [
      'claim_draft_assessments_insert_guard_trg',
      'claim_draft_assessments_append_only_trg',
      'claim_draft_assessments_complete_trg',
      'claim_draft_findings_insert_guard_trg',
      'claim_draft_findings_append_only_trg',
    ]) {
      check(`${trigger} is present after a clean replay`, replay.triggers.some((line) => line.endsWith(`:${trigger}`)))
    }
    for (const name of [
      'claim_draft_assessments_pkey',
      'claim_draft_assessments_contract_version_chk',
      'claim_draft_assessments_outcome_chk',
      'claim_draft_assessments_fingerprint_chk',
      'claim_draft_assessments_counts_chk',
      'claim_draft_assessments_claim_id_fkey',
      'claim_draft_assessments_pricing_run_id_fkey',
      'claim_draft_assessments_handoff_assessment_id_fkey',
      'claim_draft_assessments_created_by_user_id_fkey',
      'claim_draft_findings_pkey',
      'claim_draft_findings_ordinal_chk',
      'claim_draft_findings_code_chk',
      'claim_draft_findings_severity_chk',
      'claim_draft_findings_owner_scope_chk',
      'claim_draft_findings_draft_assessment_id_fkey',
      'claim_draft_findings_related_claim_line_id_fkey',
      'claim_draft_findings_related_claim_diagnosis_id_fkey',
    ]) {
      const line = replay.constraints.find((candidate) => candidate.includes(`:${name}:`)) ?? ''
      check(`${name} is present after a clean replay`, line !== '' && (!name.endsWith('_fkey') || line.includes('ON DELETE RESTRICT')), line.slice(0, 160))
    }
    const draftContract = replay.constraints.find((line) => line.includes('claim_draft_assessments_contract_version_chk')) ?? ''
    const draftOutcome = replay.constraints.find((line) => line.includes('claim_draft_assessments_outcome_chk')) ?? ''
    check(
      'the A6.4 CHECKs pin A6-DRAFT-1 and exactly REVIEWABLE, INCOMPLETE, STALE and INVALID after a clean replay',
      draftContract.includes("'A6-DRAFT-1'") && ['REVIEWABLE', 'INCOMPLETE', 'STALE', 'INVALID'].every((outcome) => draftOutcome.includes(`'${outcome}'`)) && !/APPROV|SUBMIT/i.test(draftOutcome),
      `${draftContract.slice(0, 100)} | ${draftOutcome.slice(0, 160)}`,
    )
    check(
      'one finding per ordinal per assessment is unique after a clean replay',
      replay.indexes.some((line) => line.startsWith('claim_draft_findings_draft_assessment_id_ordinal_key:') && /UNIQUE/i.test(line)),
    )
    const a64Tables = {
      claim_draft_assessments: ['id', 'claim_id', 'pricing_run_id', 'draft_contract_version', 'handoff_assessment_id', 'outcome', 'assembly_fingerprint', 'pricing_input_fingerprint', 'active_line_count', 'active_diagnosis_count', 'finding_count', 'evaluated_at', 'created_by_user_id', 'created_at'],
      claim_draft_findings: ['id', 'draft_assessment_id', 'ordinal', 'finding_code', 'severity', 'owner_scope', 'related_claim_line_id', 'related_claim_diagnosis_id', 'created_at'],
    }
    for (const [table, allowed] of Object.entries(a64Tables)) {
      const columns = replay.columns.filter((line) => line.startsWith(`${table}.`)).map((line) => line.slice(table.length + 1).split(':')[0])
      const unexpected = columns.filter((column) => !allowed.includes(column))
      check(
        `${table} carries exactly its ${allowed.length} A6.4 columns after a clean replay`,
        columns.length === allowed.length && unexpected.length === 0,
        columns.length === 0 ? 'the column catalog did not reach the table, so this absence is unproven' : unexpected.join(', '),
      )
    }
    const draftTables = [...new Set(replay.columns.map((line) => line.split('.')[0]).filter((table) => /^claim_draft_/.test(table)))].sort()
    check(
      'the A6.4 tables are exactly claim_draft_assessments and claim_draft_findings after a clean replay',
      JSON.stringify(draftTables) === JSON.stringify(['claim_draft_assessments', 'claim_draft_findings']),
      draftTables.join(', '),
    )

    // A6.5 — immutable human review decisions. The contract, the four decision codes, the controlled reason
    // vocabulary, the per-decision shape and the positive sequence are held by the database; a decision is
    // about an assessment of its own Claim at exactly the next Claim-local sequence and at the database's
    // own time, an APPROVE names a REVIEWABLE assessment with its own fingerprint and a separate reviewer, a
    // REVOKE withdraws exactly the latest approval, and the table is append-only.
    for (const trigger of ['claim_review_events_insert_guard_trg', 'claim_review_events_append_only_trg']) {
      check(`${trigger} is present after a clean replay`, replay.triggers.some((line) => line.endsWith(`:${trigger}`)))
    }
    for (const name of [
      'claim_review_events_pkey',
      'claim_review_events_contract_version_chk',
      'claim_review_events_decision_chk',
      'claim_review_events_sequence_chk',
      'claim_review_events_reason_chk',
      'claim_review_events_shape_chk',
      'claim_review_events_claim_id_fkey',
      'claim_review_events_draft_assessment_id_fkey',
      'claim_review_events_reviewer_user_id_fkey',
      'claim_review_events_referenced_approval_id_fkey',
    ]) {
      const line = replay.constraints.find((candidate) => candidate.includes(`:${name}:`)) ?? ''
      check(`${name} is present after a clean replay`, line !== '' && (!name.endsWith('_fkey') || line.includes('ON DELETE RESTRICT')), line.slice(0, 160))
    }
    const reviewContract = replay.constraints.find((line) => line.includes('claim_review_events_contract_version_chk')) ?? ''
    const reviewDecision = replay.constraints.find((line) => line.includes('claim_review_events_decision_chk')) ?? ''
    check(
      'the A6.5 CHECKs pin A6-REVIEW-1 and exactly APPROVE, RETURN, REJECT and REVOKE after a clean replay',
      reviewContract.includes("'A6-REVIEW-1'") && ['APPROVE', 'RETURN', 'REJECT', 'REVOKE'].every((code) => reviewDecision.includes(`'${code}'`)) && !/SUBMIT|APPROVED/i.test(reviewDecision),
      `${reviewContract.slice(0, 100)} | ${reviewDecision.slice(0, 160)}`,
    )
    check(
      'one decision per sequence per claim and one revocation per approval are unique after a clean replay',
      replay.indexes.some((line) => line.startsWith('claim_review_events_claim_id_sequence_key:') && /UNIQUE/i.test(line)) &&
        replay.indexes.some((line) => line.startsWith('claim_review_events_referenced_approval_id_key:') && /UNIQUE/i.test(line)),
    )
    const a65Columns = ['id', 'claim_id', 'draft_assessment_id', 'reviewer_user_id', 'decision_code', 'sequence', 'approval_fingerprint', 'reason_code', 'referenced_approval_id', 'reviewed_at', 'review_contract_version', 'created_at']
    const reviewColumns = replay.columns.filter((line) => line.startsWith('claim_review_events.')).map((line) => line.slice('claim_review_events.'.length).split(':')[0])
    check(
      `claim_review_events carries exactly its ${a65Columns.length} A6.5 columns after a clean replay`,
      reviewColumns.length === a65Columns.length && reviewColumns.every((column) => a65Columns.includes(column)),
      reviewColumns.length === 0 ? 'the column catalog did not reach the table, so this absence is unproven' : reviewColumns.filter((column) => !a65Columns.includes(column)).join(', '),
    )
    const reviewTables = [...new Set(replay.columns.map((line) => line.split('.')[0]).filter((table) => /^claim_review_/.test(table)))].sort()
    check(
      'the A6.5 tables are exactly claim_review_events after a clean replay',
      JSON.stringify(reviewTables) === JSON.stringify(['claim_review_events']),
      reviewTables.join(', '),
    )

    // A6.7 — the immutable claim freeze (ClaimSubmission), its evidence package and ordered entries. The
    // contracts, digest shapes, kind/role vocabulary, version and content-hash rules are held by the
    // database; the insert guards recompute the payload digest, manifest digest and seal and refuse any
    // reference outside the freeze's own lineage; completeness is checked at commit; all three tables are
    // append-only. One freeze per approval, one package per freeze, one entry per ordinal.
    for (const trigger of [
      'claim_freezes_insert_guard_trg',
      'claim_freezes_require_evidence_package_trg',
      'claim_freezes_append_only_trg',
      'claim_freeze_evidence_manifests_insert_guard_trg',
      'claim_freeze_evidence_manifests_append_only_trg',
      'claim_freeze_evidence_entries_insert_guard_trg',
      'claim_freeze_evidence_entries_append_only_trg',
    ]) {
      check(`${trigger} is present after a clean replay`, replay.triggers.some((line) => line.endsWith(`:${trigger}`)))
    }
    for (const name of [
      'claim_freezes_pkey',
      'claim_freezes_contract_version_chk',
      'claim_freezes_payload_schema_version_chk',
      'claim_freezes_digest_shape_chk',
      'claim_freezes_claim_id_fkey',
      'claim_freezes_draft_assessment_id_fkey',
      'claim_freezes_approval_review_event_id_fkey',
      'claim_freezes_pricing_run_id_fkey',
      'claim_freezes_created_by_user_id_fkey',
      'claim_freeze_evidence_manifests_pkey',
      'claim_freeze_evidence_manifests_contract_version_chk',
      'claim_freeze_evidence_manifests_shape_chk',
      'claim_freeze_evidence_manifests_claim_submission_id_fkey',
      'claim_freeze_evidence_entries_pkey',
      'claim_freeze_evidence_entries_ordinal_chk',
      'claim_freeze_evidence_entries_kind_chk',
      'claim_freeze_evidence_entries_role_chk',
      'claim_freeze_evidence_entries_version_chk',
      'claim_freeze_evidence_entries_content_hash_chk',
      'claim_freeze_evidence_entries_evidence_package_id_fkey',
    ]) {
      const line = replay.constraints.find((candidate) => candidate.includes(`:${name}:`)) ?? ''
      check(`${name} is present after a clean replay`, line !== '' && (!name.endsWith('_fkey') || line.includes('ON DELETE RESTRICT')), line.slice(0, 160))
    }
    const freezeContract = replay.constraints.find((line) => line.includes('claim_freezes_contract_version_chk')) ?? ''
    const manifestContract = replay.constraints.find((line) => line.includes('claim_freeze_evidence_manifests_contract_version_chk')) ?? ''
    check(
      'the A6.7 CHECKs pin A6-SUBMISSION-1 and A6-EVIDENCE-1 after a clean replay',
      freezeContract.includes("'A6-SUBMISSION-1'") && manifestContract.includes("'A6-EVIDENCE-1'"),
      `${freezeContract.slice(0, 100)} | ${manifestContract.slice(0, 100)}`,
    )
    check(
      'one freeze per approval, one package per freeze and one entry per ordinal are unique after a clean replay',
      replay.indexes.some((line) => line.startsWith('claim_freezes_approval_review_event_id_key:') && /UNIQUE/i.test(line)) &&
        replay.indexes.some((line) => line.startsWith('claim_freeze_evidence_manifests_claim_submission_id_key:') && /UNIQUE/i.test(line)) &&
        replay.indexes.some((line) => line.startsWith('claim_freeze_evidence_entries_evidence_package_id_ordinal_key:') && /UNIQUE/i.test(line)),
    )
    const a67Columns: Record<string, string[]> = {
      claim_freezes: [
        'id',
        'claim_id',
        'draft_assessment_id',
        'approval_review_event_id',
        'pricing_run_id',
        'submission_contract_version',
        'payload_schema_version',
        'approved_assembly_fingerprint',
        'canonical_payload_bytes',
        'payload_sha256',
        'frozen_at',
        'created_by_user_id',
        'created_at',
      ],
      claim_freeze_evidence_manifests: ['id', 'claim_submission_id', 'manifest_contract_version', 'entry_count', 'manifest_bytes', 'manifest_sha256', 'package_seal_sha256', 'created_at'],
      claim_freeze_evidence_entries: ['id', 'evidence_package_id', 'ordinal', 'reference_kind', 'reference_id', 'reference_version_id', 'content_hash', 'evidence_role', 'created_at'],
    }
    for (const [table, allowed] of Object.entries(a67Columns)) {
      const columns = replay.columns.filter((line) => line.startsWith(`${table}.`)).map((line) => line.slice(table.length + 1).split(':')[0])
      check(
        `${table} carries exactly its ${allowed.length} A6.7 columns after a clean replay`,
        columns.length === allowed.length && columns.every((column) => allowed.includes(column)),
        columns.length === 0 ? 'the column catalog did not reach the table, so this absence is unproven' : columns.filter((column) => !allowed.includes(column)).join(', '),
      )
    }
    // The A6.8 lifecycle table belongs to claim_freezes but is owned and verified by its own block below.
    const freezeTables = [...new Set(replay.columns.map((line) => line.split('.')[0]).filter((table) => /^claim_freeze/.test(table) && !/^claim_freeze_lifecycle/.test(table)))].sort()
    check(
      'the A6.7 tables are exactly claim_freezes and its evidence manifest and entry tables after a clean replay',
      JSON.stringify(freezeTables) === JSON.stringify(['claim_freeze_evidence_entries', 'claim_freeze_evidence_manifests', 'claim_freezes']),
      freezeTables.join(', '),
    )

    // A6.8 — the append-only internal lifecycle events of a frozen submission. The contract, the four event
    // codes, the positive sequence and the event/reason shape are held by the database; an event is recorded
    // at the database's own time, at exactly the next submission-local sequence and only as a legal
    // A6-LIFECYCLE-1 edge from the current disposition; the table is append-only and stores no state.
    for (const trigger of ['claim_freeze_lifecycle_events_insert_guard_trg', 'claim_freeze_lifecycle_events_append_only_trg']) {
      check(`${trigger} is present after a clean replay`, replay.triggers.some((line) => line.endsWith(`:${trigger}`)))
    }
    for (const name of [
      'claim_freeze_lifecycle_events_pkey',
      'claim_freeze_lifecycle_events_contract_version_chk',
      'claim_freeze_lifecycle_events_event_code_chk',
      'claim_freeze_lifecycle_events_sequence_chk',
      'claim_freeze_lifecycle_events_reason_chk',
      'claim_freeze_lifecycle_events_claim_submission_id_fkey',
      'claim_freeze_lifecycle_events_actor_user_id_fkey',
    ]) {
      const line = replay.constraints.find((candidate) => candidate.includes(`:${name}:`)) ?? ''
      check(`${name} is present after a clean replay`, line !== '' && (!name.endsWith('_fkey') || line.includes('ON DELETE RESTRICT')), line.slice(0, 160))
    }
    const lifecycleContract = replay.constraints.find((line) => line.includes('claim_freeze_lifecycle_events_contract_version_chk')) ?? ''
    const lifecycleEvents = replay.constraints.find((line) => line.includes('claim_freeze_lifecycle_events_event_code_chk')) ?? ''
    check(
      'the A6.8 CHECKs pin A6-LIFECYCLE-1 and exactly PLACE_HOLD, RELEASE_HOLD, AUTHORIZE_RELEASE and WITHDRAW_INTERNAL after a clean replay',
      lifecycleContract.includes("'A6-LIFECYCLE-1'") && ['PLACE_HOLD', 'RELEASE_HOLD', 'AUTHORIZE_RELEASE', 'WITHDRAW_INTERNAL'].every((code) => lifecycleEvents.includes(`'${code}'`)) && !/SEND|SUBMIT|ACK|PAID/i.test(lifecycleEvents),
      `${lifecycleContract.slice(0, 100)} | ${lifecycleEvents.slice(0, 160)}`,
    )
    check(
      'one lifecycle event per sequence per frozen submission is unique after a clean replay',
      replay.indexes.some((line) => line.startsWith('claim_freeze_lifecycle_events_claim_submission_id_sequence_key:') && /UNIQUE/i.test(line)),
    )
    const a68Columns = ['id', 'claim_submission_id', 'sequence', 'event_code', 'reason_code', 'actor_user_id', 'occurred_at', 'lifecycle_contract_version', 'created_at']
    const lifecycleColumns = replay.columns.filter((line) => line.startsWith('claim_freeze_lifecycle_events.')).map((line) => line.slice('claim_freeze_lifecycle_events.'.length).split(':')[0])
    check(
      `claim_freeze_lifecycle_events carries exactly its ${a68Columns.length} A6.8 columns after a clean replay`,
      lifecycleColumns.length === a68Columns.length && lifecycleColumns.every((column) => a68Columns.includes(column)),
      lifecycleColumns.length === 0 ? 'the column catalog did not reach the table, so this absence is unproven' : lifecycleColumns.filter((column) => !a68Columns.includes(column)).join(', '),
    )
    const lifecycleTables = [...new Set(replay.columns.map((line) => line.split('.')[0]).filter((table) => /lifecycle/.test(table) && /^claim/.test(table)))].sort()
    check(
      'the A6.8 tables are exactly claim_freeze_lifecycle_events after a clean replay',
      JSON.stringify(lifecycleTables) === JSON.stringify(['claim_freeze_lifecycle_events']),
      lifecycleTables.join(', '),
    )

    // A6.9 — append-only correction links between two freezes of one Claim. The contract, the controlled
    // reason vocabulary and two distinct freezes are held by CHECKs; one prior and one correction per freeze
    // by UNIQUE keys (no fork, no join); the insert guard holds database time, the same Claim, distinct draft
    // assessments, strict chronology and growth at the chain's tail; the table is append-only.
    for (const trigger of ['claim_correction_links_insert_guard_trg', 'claim_correction_links_append_only_trg']) {
      check(`${trigger} is present after a clean replay`, replay.triggers.some((line) => line.endsWith(`:${trigger}`)))
    }
    for (const name of [
      'claim_correction_links_pkey',
      'claim_correction_links_contract_version_chk',
      'claim_correction_links_reason_chk',
      'claim_correction_links_distinct_chk',
      'claim_correction_links_claim_id_fkey',
      'claim_correction_links_prior_submission_id_fkey',
      'claim_correction_links_corrected_submission_id_fkey',
      'claim_correction_links_recorded_by_user_id_fkey',
    ]) {
      const line = replay.constraints.find((candidate) => candidate.includes(`:${name}:`)) ?? ''
      check(`${name} is present after a clean replay`, line !== '' && (!name.endsWith('_fkey') || line.includes('ON DELETE RESTRICT')), line.slice(0, 160))
    }
    const correctionContract = replay.constraints.find((line) => line.includes('claim_correction_links_contract_version_chk')) ?? ''
    const correctionReasons = replay.constraints.find((line) => line.includes('claim_correction_links_reason_chk')) ?? ''
    check(
      'the A6.9 CHECKs pin A6-CORRECTION-1 and exactly the five controlled correction reasons after a clean replay',
      correctionContract.includes("'A6-CORRECTION-1'") && ['CORRECTED_CODING', 'CORRECTED_SOURCE', 'CORRECTED_PRICING', 'CORRECTED_DOCUMENTATION', 'INTERNAL_OTHER'].every((code) => correctionReasons.includes(`'${code}'`)) && /IS NOT NULL/i.test(correctionReasons),
      `${correctionContract.slice(0, 100)} | ${correctionReasons.slice(0, 160)}`,
    )
    check(
      'one correction per prior freeze and one prior per corrected freeze are unique after a clean replay',
      replay.indexes.some((line) => line.startsWith('claim_correction_links_prior_submission_id_key:') && /UNIQUE/i.test(line)) &&
        replay.indexes.some((line) => line.startsWith('claim_correction_links_corrected_submission_id_key:') && /UNIQUE/i.test(line)),
    )
    const a69Columns = ['id', 'claim_id', 'prior_submission_id', 'corrected_submission_id', 'reason_code', 'recorded_by_user_id', 'recorded_at', 'contract_version', 'created_at']
    const correctionColumns = replay.columns.filter((line) => line.startsWith('claim_correction_links.')).map((line) => line.slice('claim_correction_links.'.length).split(':')[0])
    check(
      `claim_correction_links carries exactly its ${a69Columns.length} A6.9 columns after a clean replay`,
      correctionColumns.length === a69Columns.length && correctionColumns.every((column) => a69Columns.includes(column)),
      correctionColumns.length === 0 ? 'the column catalog did not reach the table, so this absence is unproven' : correctionColumns.filter((column) => !a69Columns.includes(column)).join(', '),
    )
    const correctionTables = [...new Set(replay.columns.map((line) => line.split('.')[0]).filter((table) => /correction|successor|supersed|resubmi/.test(table)))].sort()
    check(
      'the A6.9 tables are exactly claim_correction_links after a clean replay',
      JSON.stringify(correctionTables) === JSON.stringify(['claim_correction_links']),
      correctionTables.join(', '),
    )

    // A7.1 — append-only revenue source evidence for exact frozen submissions. The contract, the one accepted
    // kind (INTERNAL_SYNTHETIC), the opaque reference shape and the absent digest are held by CHECKs; the stable
    // identity by a UNIQUE index; the insert guard holds database time and the owning organization; the table is
    // append-only. No amount, payer, status or remittance column or table exists.
    for (const trigger of ['revenue_source_evidence_insert_guard_trg', 'revenue_source_evidence_append_only_trg', 'revenue_source_evidence_no_truncate_trg']) {
      check(`${trigger} is present after a clean replay`, replay.triggers.some((line) => line.endsWith(`:${trigger}`)))
    }
    for (const name of [
      'revenue_source_evidence_pkey',
      'revenue_source_evidence_version_chk',
      'revenue_source_evidence_kind_chk',
      'revenue_source_evidence_reference_chk',
      'revenue_source_evidence_digest_chk',
      'revenue_source_evidence_organization_id_fkey',
      'revenue_source_evidence_claim_submission_id_fkey',
      'revenue_source_evidence_recorded_by_user_id_fkey',
    ]) {
      const line = replay.constraints.find((candidate) => candidate.includes(`:${name}:`)) ?? ''
      check(`${name} is present after a clean replay`, line !== '' && (!name.endsWith('_fkey') || line.includes('ON DELETE RESTRICT')), line.slice(0, 160))
    }
    const revenueVersion = replay.constraints.find((line) => line.includes('revenue_source_evidence_version_chk')) ?? ''
    const revenueKind = replay.constraints.find((line) => line.includes('revenue_source_evidence_kind_chk')) ?? ''
    const revenueDigest = replay.constraints.find((line) => line.includes('revenue_source_evidence_digest_chk')) ?? ''
    check(
      'the A7.1 CHECKs pin A7-REVENUE-SOURCE-1, INTERNAL_SYNTHETIC only and no source digest after a clean replay',
      revenueVersion.includes("'A7-REVENUE-SOURCE-1'") && revenueKind.includes("'INTERNAL_SYNTHETIC'") && !revenueKind.includes('EXTERNAL_VERIFIED') && /IS NOT NULL/i.test(revenueKind) && /source_digest_sha256 IS NULL/i.test(revenueDigest),
      `${revenueVersion.slice(0, 100)} | ${revenueKind.slice(0, 100)} | ${revenueDigest.slice(0, 80)}`,
    )
    check(
      'one registration per submission, kind, reference and contract is unique after a clean replay',
      replay.indexes.some((line) => line.startsWith('revenue_source_evidence_identity_key:') && /UNIQUE/i.test(line) && /claim_submission_id, source_kind, source_reference, source_version/.test(line)),
    )
    const a71Columns = ['id', 'organization_id', 'claim_submission_id', 'source_kind', 'source_reference', 'source_version', 'source_digest_sha256', 'received_at', 'recorded_by_user_id', 'created_at']
    const revenueColumns = replay.columns.filter((line) => line.startsWith('revenue_source_evidence.')).map((line) => line.slice('revenue_source_evidence.'.length).split(':')[0])
    check(
      `revenue_source_evidence carries exactly its ${a71Columns.length} A7.1 columns after a clean replay`,
      revenueColumns.length === a71Columns.length && revenueColumns.every((column) => a71Columns.includes(column)),
      revenueColumns.length === 0 ? 'the column catalog did not reach the table, so this absence is unproven' : revenueColumns.filter((column) => !a71Columns.includes(column)).join(', '),
    )
    const revenueTables = [...new Set(replay.columns.map((line) => line.split('.')[0]).filter((table) => /revenue|remittance|payment|receivable|adjudicat|denial|settlement|posting/.test(table)))].sort()
    check(
      'the A7.1 tables are exactly revenue_source_evidence after a clean replay',
      JSON.stringify(revenueTables) === JSON.stringify(['revenue_source_evidence']),
      revenueTables.join(', '),
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
