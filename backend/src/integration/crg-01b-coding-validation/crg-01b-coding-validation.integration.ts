import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { delimiter } from 'node:path'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { auth } from '../../shared/auth/auth.ts'
import { formatDateOnly } from '../../shared/rules/date-only.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordValidationRunInTransaction } from '../../modules/validation-run/validation-run.recorder.ts'
import { activateReferenceDatasetVersion, importReferenceDataset, importReferenceDatasetVersion, validateReferenceDatasetVersion } from '../../modules/reference-dataset/reference-dataset.maintenance.ts'
import { getCodingReleaseCheckOf, importRelease, recordRightsDecision, registerDatasetCodeSystem } from '../../modules/coding-release/coding-release.service.ts'
import {
  evaluateCodingRelease,
  getRunCodingReceiptsOf,
  getSubmissionCodingProvenanceOf,
  recordCodingReceipts,
  recordValidationScope,
} from '../../modules/coding-validation/coding-validation.service.ts'
import { codingReleaseFindings, RECEIPT_CONTRACT_VERSION, VALSCOPE_CONTRACT_VERSION } from '../../modules/coding-validation/coding-validation.types.ts'
import { composeA6Handoff } from '../../modules/pre-claim-readiness/pre-claim-readiness.service.ts'
import { composeCanonicalClaimPayload } from '../../modules/claim-payload/claim-payload.composer.ts'
import { VALIDATOR_VERSION, VALIDATOR_VERSION_V2 } from '../../modules/pre-claim-validation/pre-claim-validation.types.ts'

// CRG-01 FINAL Checkpoint B — versioned coding validation and freeze (design freeze revision 1.2): acceptance of
// CRG-051–CRG-090, CRG-119, CRG-122, B-G01–B-G06, the governance and build gates and the cumulative substantive
// regressions (the Checkpoint A suite and the A8.5 suite, each nesting its own chain down to A1).
//
// Everything is synthetic: per-run SYN- authorities, synthetic editions imported through the Checkpoint A writers,
// synthetic validation scopes through the Checkpoint B maintenance writer, and facilities, encounters, codes, claims and
// freezes through their owner routes. A real A5.8 execution proves the validator itself; a READY_FOR_REVIEW A5-VAL-2 run
// (which needs live coverage outside CRG) is recorded through the same production write path A5.8 uses — the A5.7
// recorder, then the CRG coding-release findings and receipts — with synthetic commercial findings. Direct SQL is
// adversarial only and ALWAYS rolled back; deferred guards are fired inside the rolled-back transaction with
// SET CONSTRAINTS ALL IMMEDIATE. No REGULATORY row is ever committed; real DHA/DOH scopes stay disabled.

const TAG = 'CRG-01B'
let passed = 0
let failed = 0
let notApplicable = 0
const failures: string[] = []
const printed: string[] = []
const say = (line: string) => {
  printed.push(line)
  console.log(line)
}
function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 50 - title.length))
  if (condition) {
    passed += 1
    say(`[${TAG}] ${id} ${title} ${dots} PASS${detail ? ` - ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(`${id} ${title} ${detail}`)
    say(`[${TAG}] ${id} ${title} ${dots} FAIL${detail ? ` - ${detail}` : ''}`)
  }
}
function notApplicableCheck(id: string, title: string, reason: string) {
  notApplicable += 1
  say(`[${TAG}] ${id} ${title} ${'.'.repeat(Math.max(3, 50 - title.length))} N/A  - ${reason}`)
}
const section = (title: string) => say(`\n[${TAG}] ${title}`)
const progress = (text: string) => say(`[${TAG}]      ${text}`)

const pathKey = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
const childEnv = (extra: Record<string, string> = {}) => ({
  ...process.env,
  [pathKey]: (process.env[pathKey] ?? '').split(delimiter).filter((entry) => !/[\\/]node_modules[\\/]\.bin[\\/]?$|[\\/]node-gyp-bin[\\/]?$/i.test(entry)).join(delimiter),
  ...extra,
})
function run(command: string, extra: Record<string, string> = {}): { ok: boolean; output: string } {
  const out = spawnSync(command, { encoding: 'utf8', shell: true, cwd: process.cwd(), env: childEnv(extra), maxBuffer: 256 * 1024 * 1024 })
  return { ok: out.status === 0, output: `${out.stdout ?? ''}${out.stderr ?? ''}` }
}
const gitArgs = (args: string[]) => (spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout ?? '').replace(/\s+$/, '')
const git = (args: string) => gitArgs(args.split(' '))
const gitOk = (args: string) => spawnSync('git', args.split(' '), { encoding: 'utf8' }).status === 0
const committedText = (path: string) => git(`show HEAD:${path}`)
const committedCode = (path: string) =>
  committedText(path)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n')

class RunAborted extends Error {}

const runId = `CRGB-${Date.now()}`
const runStartedAt = new Date(Number(runId.slice(5)))
const runToken = runId.slice(5)
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const crgbBranch = 'feature/crg-01b-coding-validation-freeze'
const crgABranch = 'fix/crg-01-final-coding-release'
const a85Branch = 'feature/a8-5-exception-remediation'
const a83Branch = 'feature/a8-3-exception-investigation'
const a82Branch = 'feature/a8-2-exception-triage'
const a81Branch = 'feature/a8-1-exception-intake'
const a81FixBranch = 'fix/a8-1-harness-later-phase-recognition'
const a710Branch = 'feature/a7-10-a7-integration-acceptance'
const a79Branch = 'feature/a7-9-revenue-evidence-continuity'
const a78Branch = 'feature/a7-8-revenue-evidence-delta'
// The baseline recorded in the register: clean main with Checkpoint A (PR #103) and A8.5 (PR #104).
const MAIN_AT_START = '0f8f9d3bc18347b1360b72b93056724b594a6e00'
const CRG_A_MERGE = 'c8ebf2c4cc385dadeaacafca0bca69db5c534b7a'
const MIGRATION_NAME = '20261106090000_crg_01b_coding_validation_freeze'
const MIGRATION = `backend/prisma/migrations/${MIGRATION_NAME}/migration.sql`
const MODULE_DIR = 'backend/src/modules/coding-validation'
const HARNESS_DIR = 'backend/src/integration/crg-01b-coding-validation'
const REGISTER_DOC = 'docs/CRG-01_Checkpoint_B_Register.md'
const CORRECTIONS_DOC = 'docs/Harness_Corrections.md'
const UNIT_TESTS = [`${MODULE_DIR}/coding-validation.manifest.test.ts`, 'backend/src/modules/pre-claim-readiness/pre-claim-readiness.policy-v2.test.ts', 'backend/src/modules/claim-payload/claim-payload.v2.test.ts']
const NEW_TABLES = ['crg_validation_code_receipts', 'crg_validation_receipt_manifests', 'crg_validation_scopes']
const NEW_CONTRACTS = ['A5-VAL-2', 'A5-READY-2', 'PreClaimA6HandoffV2', 'A6-PAYLOAD-2', 'A6-SUBMISSION-2', 'CRG-RECEIPT-1', 'CRG-VALSCOPE-1']
const MISSING = '11111111-1111-4111-8111-111111111111'
// The production paths Checkpoint B may change (each a disclosed version-specific branch; design freeze §8, §12).
const ALLOWED = [
  'backend/package.json', 'backend/prisma/schema.prisma', MIGRATION, 'backend/src/app.ts', 'backend/src/shared/errors/error.types.ts', 'backend/src/scripts/verify-migration-replay.ts', REGISTER_DOC, CORRECTIONS_DOC,
  'backend/src/modules/pre-claim-validation/pre-claim-validation.service.ts', 'backend/src/modules/pre-claim-validation/pre-claim-validation.types.ts', 'backend/src/modules/pre-claim-validation/pre-claim-validation.coding-release.ts',
  'backend/src/modules/pre-claim-readiness/pre-claim-readiness.policy.ts', 'backend/src/modules/pre-claim-readiness/pre-claim-readiness.types.ts', 'backend/src/modules/pre-claim-readiness/pre-claim-readiness.service.ts',
  'backend/src/modules/pre-claim-readiness/pre-claim-readiness.policy-v2.test.ts', 'backend/src/modules/claim/claim.service.ts', 'backend/src/modules/claim-line/claim-line.service.ts', 'backend/src/modules/claim-draft/claim-draft.assembly.ts',
  'backend/src/modules/claim-payload/claim-payload.composer.ts', 'backend/src/modules/claim-payload/claim-payload.types.ts', 'backend/src/modules/claim-payload/claim-payload.v2.ts', 'backend/src/modules/claim-payload/claim-payload.v2.test.ts',
  'backend/src/modules/claim-submission/claim-submission.service.ts', 'backend/src/modules/claim-submission/claim-submission.types.ts', 'backend/src/modules/claim-evidence/claim-evidence.manifest.ts',
]
// Earlier harnesses corrected under design freeze §12 (each with its negative test, B-G06). Filled from the clone proof.
const CORRECTED_HARNESSES: string[] = [
  'backend/src/integration/a5-phase-closure/a5-phase-closure.integration.ts',
  'backend/src/integration/a5-readiness/a5-readiness.integration.ts',
  'backend/src/integration/a6-claim-foundation/a6-claim-foundation.integration.ts',
  // The A7 cash-receipt boundaries (A7.2 T106; A7.3 T096/T109; A7.4 T095/T109; A7.5 T094/T109; A7.6 T095/T109; A7.8 T050;
  // A7.9 T050): the accepted later-phase table rule.
  'backend/src/integration/a7-evidence-classification/a7-evidence-classification.integration.ts',
  'backend/src/integration/a7-evidence-gate/a7-evidence-gate.integration.ts',
  'backend/src/integration/a7-evidence-case/a7-evidence-case.integration.ts',
  'backend/src/integration/a7-case-prerequisite/a7-case-prerequisite.integration.ts',
  'backend/src/integration/a7-closure-basis-trace/a7-closure-basis-trace.integration.ts',
  'backend/src/integration/a7-revenue-delta/a7-revenue-delta.integration.ts',
  'backend/src/integration/a7-revenue-continuity/a7-revenue-continuity.integration.ts',
  // A6.7, A6.8 and A6.9 T009: the owner term over the package's own range (the accepted A7.1–A7.9 T009 rule).
  'backend/src/integration/a6-claim-submission/a6-claim-submission.integration.ts',
  'backend/src/integration/a6-claim-lifecycle/a6-claim-lifecycle.integration.ts',
  'backend/src/integration/a6-claim-correction/a6-claim-correction.integration.ts',
  // The A5.8 and A6.6 scan-reach guards admit the one named Checkpoint B file in the scanned directory.
  'backend/src/integration/a5-pre-claim-validation/a5-pre-claim-validation.integration.ts',
  'backend/src/integration/a6-canonical-payload/a6-canonical-payload.integration.ts',
]
const COUNT_TABLES = ['validation_runs', 'validation_findings', 'crg_validation_code_receipts', 'crg_validation_receipt_manifests', 'crg_validation_scopes', 'pre_claim_readiness_assessments', 'claims', 'claim_freezes', 'audit_events']

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const sha256Of = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const withoutEvaluatedAt = (body: unknown) => JSON.stringify(body, (k, v) => (k === 'evaluatedAt' || k === 'requestId' ? undefined : v))
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const settledWithin = async (promise: Promise<unknown>, ms: number) => Promise.race([promise.then(() => true, () => true), pause(ms).then(() => false)])
async function attemptAdversarial(write: () => Promise<unknown>): Promise<string> {
  try {
    await write()
    return ''
  } catch (error) {
    return `${(error as { code?: string }).code ?? ''} ${String((error as Error).message ?? error)}`
  }
}
function holdAt(probe: string) {
  clearConcurrencyProbes()
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  let reached: () => void = () => {}
  const arrived = new Promise<void>((resolve) => (reached = resolve))
  setConcurrencyProbe(probe, async () => {
    reached()
    await held
  })
  return { arrived, release }
}
function failOnce(probe: string, message: string) {
  clearConcurrencyProbes()
  const state = { reached: 0 }
  setConcurrencyProbe(probe, async () => {
    state.reached += 1
    throw new Error(message)
  })
  return state
}
type SuiteLine = { id: string; verdict: 'PASS' | 'FAIL' | 'N/A' | 'OTHER'; line: string }
function suiteLines(output: string, tag: string, idPattern: RegExp): SuiteLine[] {
  const prefix = `[${tag}] `
  const rows: SuiteLine[] = []
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith(prefix)) continue
    const rest = line.slice(prefix.length)
    const id = rest.split(' ')[0]
    if (!idPattern.test(id)) continue
    const verdict = / \.{3,} PASS/.test(rest) ? 'PASS' : / \.{3,} FAIL/.test(rest) ? 'FAIL' : / \.{3,} N\/A /.test(rest) ? 'N/A' : / \.{3,} [A-Z]+/.test(rest) ? 'OTHER' : null
    if (verdict) rows.push({ id, verdict, line })
  }
  return rows
}

// The manifest of a run's receipts, computed by THIS suite independently of the module (CRG-070).
type ReceiptRow = Record<string, string | null>
const independentManifest = (rows: ReceiptRow[]) => {
  const line = (r: ReceiptRow) =>
    [
      r.subject_kind, r.encounter_diagnosis_id ?? r.encounter_activity_id, r.validation_finding_id, r.master_code_id, r.code_system ?? '-', r.canonical_code ?? '-', r.decision_code, r.code_system_dataset_id ?? '-',
      r.release_import_id ?? '-', r.reference_dataset_version_id ?? '-', r.membership_id ?? '-', r.source_row_sha256 ?? '-',
    ].join('\t') + '\n'
  const ordered = [...rows].sort((a, b) => {
    const ka = `${a.subject_kind}`
    const kb = `${b.subject_kind}`
    if (ka !== kb) return ka < kb ? -1 : 1
    const ta = `${a.encounter_diagnosis_id ?? a.encounter_activity_id}`
    const tb = `${b.encounter_diagnosis_id ?? b.encounter_activity_id}`
    return ta < tb ? -1 : ta > tb ? 1 : 0
  })
  return { count: rows.length, sha256: sha256Of(Buffer.from(ordered.map(line).join(''), 'utf8')) }
}

async function main() {
  for (const [k, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg })) if (!value) throw new Error(`missing integration env for ${k}`)
  const headAtStart = git('rev-parse HEAD')
  say(`[${TAG}] CRG-01 FINAL Checkpoint B, versioned coding validation and freeze (${RECEIPT_CONTRACT_VERSION}, ${VALSCOPE_CONTRACT_VERSION}) — run ${runId}`)
  say(`[${TAG}] HEAD ${headAtStart} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

  const databaseUp = async () => {
    try {
      await prisma.$queryRaw`SELECT 1`
      return true
    } catch {
      return false
    }
  }
  const waitFor = async (predicate: () => Promise<boolean>, timeoutMs: number) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (await predicate()) return true
      await pause(400)
    }
    return false
  }
  if (!(await waitFor(databaseUp, 60_000))) throw new RunAborted(`the database is not reachable; start it with \`docker start ${dbContainer}\` and run this suite again.`)
  const ready = async () => (await fetch(`${baseUrl}/api/ready`).catch(() => null))?.status ?? 0
  const health = async () => (await fetch(`${baseUrl}/api/health`).catch(() => null))?.status ?? 0
  const apiReady = async (what: string) => {
    if (!(await waitFor(async () => (await ready()) === 200, 60_000))) throw new RunAborted(`the API at ${baseUrl} is not ready before ${what}; start it with \`npm start\``)
  }

  // ---------------------------------------------------------------- governance gates (CRGB-G01–G08, B-G04)
  section('Governance: clean main base, one additive migration, Prisma, replay, three tables and seven contracts, verified existing constraints, changed-file allowlist, no new permission, two read routes')
  const branch = git('rev-parse --abbrev-ref HEAD')
  const mergeOf = (name: string) => gitArgs(['log', 'origin/main', '--merges', `--grep=${name}$`, '-n', '1', '--format=%H'])
  const crgAMerge = mergeOf(crgABranch)
  const a85Merge = mergeOf(a85Branch)
  const a83Merge = mergeOf(a83Branch)
  const a82Merge = mergeOf(a82Branch)
  const a81Merge = mergeOf(a81Branch)
  const a81FixMerge = mergeOf(a81FixBranch)
  const a710Merge = mergeOf(a710Branch)
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check(
    'CRGB-G01',
    'Clean main base with Checkpoint A and A8.5',
    branch === crgbBranch && crgAMerge === CRG_A_MERGE && a85Merge.length === 40 && gitOk(`merge-base --is-ancestor ${MAIN_AT_START} HEAD`) && gitOk('merge-base --is-ancestor origin/main HEAD') &&
      gitOk(`merge-base --is-ancestor ${a85Merge} HEAD`) && dirty.length === 0 && tracking.includes(`origin/${crgbBranch}`) && !/ahead|behind/.test(tracking),
    `branch ${branch} from main ${MAIN_AT_START.slice(0, 7)} (Checkpoint A ${crgAMerge.slice(0, 7) || 'NOT FOUND'}, A8.5 ${a85Merge.slice(0, 7) || 'NOT FOUND'}); ${dirty.length === 0 ? 'clean' : `uncommitted: ${dirty.length} path(s)`}; ${tracking}`,
  )
  const ownMerge = branch === crgbBranch ? '' : mergeOf(crgbBranch)
  const ownRange = ownMerge ? `${ownMerge}^1..${ownMerge}` : 'origin/main...HEAD'
  const ownBase = ownMerge ? gitArgs(['rev-parse', `${ownMerge}^1`]) : 'origin/main'
  const ownTip = ownMerge || 'HEAD'
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const ownChangedPaths = gitArgs(['diff', '--name-only', ownRange]).split(/\r?\n/).filter(Boolean)
  const ownPrismaStatus = gitArgs(['diff', '--name-status', ownRange, '--', ':/backend/prisma']).split(/\r?\n/).filter(Boolean)
  const migrationDirsAt = (ref: string) => git(`ls-tree -d --name-only --full-tree ${ref} backend/prisma/migrations/`).split(/\r?\n/).filter((line) => /\/\d{14}_/.test(line))
  const headMigrationDirs = migrationDirsAt('HEAD')
  check(
    'CRGB-G02',
    'One additive migration; no applied one changed',
    same(ownPrismaStatus, [`A\t${MIGRATION}`, 'M\tbackend/prisma/schema.prisma']) && migrationDirsAt(ownTip).length === migrationDirsAt(ownBase).length + 1 && migrationDirsAt(ownBase).every((d) => migrationDirsAt(ownTip).includes(d)),
    `exactly ${MIGRATION_NAME} added and the schema extended; all ${migrationDirsAt(ownBase).length} earlier migrations untouched`,
  )
  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('CRGB-G03', 'Prisma validate, generate and status', validate.ok && generate.ok && status.ok && /Database schema is up to date/.test(status.output), 'the schema validates and generates; the working database has every migration (never reset)')
  const replay = run('npm run db:verify:replay')
  const appliedCount = Number((replay.output.match(/(\d+) migrations applied cleanly/) ?? [])[1] ?? -1)
  check(
    'CRGB-G04',
    'Scratch replay passes with the Checkpoint B block',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && appliedCount === headMigrationDirs.length && /PASS {2}the Checkpoint B tables are exactly crg_validation_code_receipts, crg_validation_receipt_manifests, crg_validation_scopes/.test(replay.output) &&
      /PASS {2}each redefined version CHECK admits exactly its V1 and V2 values/.test(replay.output),
    `${appliedCount} migrations applied cleanly from empty — exactly the ${headMigrationDirs.length} committed at HEAD; the Checkpoint B tables, guards and CHECKs survive`,
  )
  const createdTables = [...committedText(MIGRATION).matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1]).sort()
  const contractLiteralsAt = (ref: string) =>
    new Set(
      gitArgs(['ls-tree', '-r', '--name-only', '--full-tree', ref, 'backend/src/modules'])
        .split(/\r?\n/)
        .filter((path) => /\.ts$/.test(path) && !/\.test\.ts$/.test(path))
        .flatMap((path) => [...gitArgs(['show', `${ref}:${path}`]).matchAll(/export const [A-Z_0-9]*VERSION[A-Z_0-9]* = '([^']+)'/g)].map((m) => m[1])),
    )
  const contractsBase = contractLiteralsAt(ownBase)
  const contractsTip = contractLiteralsAt(ownTip)
  const addedContracts = [...contractsTip].filter((c) => !contractsBase.has(c)).sort()
  const constraintDef = async (name: string) => (await prisma.$queryRawUnsafe<{ d: string }[]>(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = $1`, name))[0]?.d ?? ''
  const existingNames = [
    'validation_runs_validator_version_chk', 'pre_claim_readiness_assessments_policy_version_chk', 'claims_handoff_schema_version_chk', 'claims_claim_contract_version_chk', 'claim_freezes_payload_schema_version_chk',
    'claim_freezes_contract_version_chk', 'claim_freeze_evidence_manifests_contract_version_chk', 'claim_lines_contract_version_chk', 'claim_diagnoses_contract_version_chk', 'claim_pricing_runs_contract_version_chk',
    'claim_draft_assessments_contract_version_chk', 'claim_review_events_contract_version_chk', 'claim_freeze_lifecycle_events_contract_version_chk', 'claim_correction_links_contract_version_chk',
  ]
  const existingDefs = await Promise.all(existingNames.map(constraintDef))
  // Each redefined CHECK admits exactly its two values: a third value is refused (rolled back, triggers off).
  const NOT_COMMITTED = 'ROLLED_BACK'
  const counts = async () => {
    const rows = await prisma.$queryRawUnsafe<{ t: string; n: bigint }[]>(`${COUNT_TABLES.map((table) => `SELECT '${table}' AS t, count(*) AS n FROM ${table}`).join(' UNION ALL ')} ORDER BY t`)
    return Object.fromEntries(rows.map((row) => [row.t, Number(row.n)])) as Record<string, number>
  }
  const unchanged = async (before: Record<string, number>) => same(await counts(), before)
  const rolledBack = async <T>(work: (tx: DbClient) => Promise<T>): Promise<{ value?: T; message: string; clean: boolean }> => {
    const before = await counts()
    const out: { value?: T } = {}
    const message = await attemptAdversarial(() =>
      prisma.$transaction(
        async (tx) => {
          out.value = await work(tx)
          throw new Error(NOT_COMMITTED)
        },
        { timeout: 120_000 },
      ),
    )
    return { ...out, message, clean: await unchanged(before) }
  }
  const refusedBy = (r: { message: string }, pattern: RegExp) => !r.message.includes(NOT_COMMITTED) && pattern.test(r.message)
  const outOfScope = changedPaths.filter((p) => !p.startsWith(`${MODULE_DIR}/`) && !p.startsWith(`${HARNESS_DIR}/`) && !ALLOWED.includes(p) && !CORRECTED_HARNESSES.includes(p))
  const laterDomain = changedPaths.filter((p) => /remittance|payment|posting|settlement|ledger|adjudicat|denial|integration\/a9|dhpo|eclaimlink|drg|grouper|modifier-catalog/i.test(p))
  const frontendChanges = changedPaths.filter((p) => p.startsWith('frontend/'))
  check(
    'CRGB-G05',
    'Changed-file allowlist; no Checkpoint C or A9 path',
    changedPaths.length > 0 && outOfScope.length === 0 && laterDomain.length === 0 && frontendChanges.length === 0,
    outOfScope.length + laterDomain.length + frontendChanges.length === 0
      ? `${changedPaths.length} path(s): the CRG-B module and harness, the version-specific A5.8/A5.9/A6 branches, the migration, replay block, register and ${CORRECTED_HARNESSES.length} disclosed harness correction(s); no frontend, A7/A8/A9, DRG or payment path`
      : `unexpected: ${[...new Set([...outOfScope, ...laterDomain, ...frontendChanges])].join(', ').slice(0, 300)}`,
  )
  const catalogueAt = (ref: string) => [...gitArgs(['show', `${ref}:backend/src/shared/authorization/authorization.types.ts`]).matchAll(/^\s+'([A-Za-z_]+\.[A-Za-z_]+)',/gm)].map((m) => m[1])
  const auditAt = (ref: string) => [...gitArgs(['show', `${ref}:backend/src/modules/audit/audit.types.ts`]).matchAll(/^\s+'([a-z_]+\.[a-z_]+)',/gm)].map((m) => m[1])
  const errorsAt = (ref: string) => [...gitArgs(['show', `${ref}:backend/src/shared/errors/error.types.ts`]).matchAll(/^\s+'([A-Z_]+)',/gm)].map((m) => m[1])
  check(
    'CRGB-G06',
    'No new permission or audit action; one error code',
    same(catalogueAt(ownTip), catalogueAt(ownBase)) && same(auditAt(ownTip), auditAt(ownBase)) && same(errorsAt(ownTip).filter((c) => !errorsAt(ownBase).includes(c)), ['CODING_RECEIPT_INTEGRITY_CONFLICT']) && errorsAt(ownBase).every((c) => errorsAt(ownTip).includes(c)),
    'the permission and audit catalogues are unchanged (the reads reuse validationRun.read, claimFreeze.read and codingRelease.read); the error catalogue gains only CODING_RECEIPT_INTEGRITY_CONFLICT',
  )
  await apiReady('signing in')
  let connectionResets = 0
  let serverErrors = 0
  const httpCall = async (path: string, init?: RequestInit) => {
    try {
      return await callApi(baseUrl, path, init)
    } catch {
      connectionResets += 1
      throw new RunAborted(`the API connection was reset while calling ${path}. Start the API with \`npm start\` in a tab of its own and run this suite again.`)
    }
  }
  const signIn = async (email: string, password: string) => {
    const res = await httpCall('/api/auth/sign-in/email', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: baseUrl }, body: JSON.stringify({ email, password }) })
    return { status: res.status, cookie: extractCookieHeader(res.setCookies) }
  }
  const admin = await signIn(adminEmail, adminPassword)
  const viewer = await signIn(viewerEmail, viewerPassword)
  if (admin.status !== 200 || viewer.status !== 200) throw new Error(`sign-in failed (admin ${admin.status}, viewer ${viewer.status})`)
  type Who = (init?: RequestInit) => RequestInit
  const as = (cookie: string): Who => (init: RequestInit = {}) => ({ ...init, headers: { ...init.headers, 'Content-Type': 'application/json', Cookie: cookie } })
  const asAdmin = as(admin.cookie)
  const asViewer = as(viewer.cookie)
  const anonymous: Who = (init: RequestInit = {}) => ({ ...init, headers: { ...init.headers, 'Content-Type': 'application/json' } })
  const api = async (method: string, path: string, body?: unknown, who: Who = asAdmin) => {
    const res = await httpCall(path, who(body === undefined ? { method } : { method, body: JSON.stringify(body) }))
    if (res.status >= 500) serverErrors += 1
    return { status: res.status, body: res.body as any }
  }
  const post = (path: string, body: unknown, who: Who = asAdmin) => api('POST', path, body, who)
  const get = (path: string, who: Who = asAdmin) => api('GET', path, undefined, who)
  const must = <T extends { id?: string }>(label: string, body: T) => {
    if (!body?.id) throw new Error(`fixture ${label} could not be created through its owner route: ${JSON.stringify(body).slice(0, 250)}`)
    return body as T & { id: string }
  }
  const errorCode = (body: any) => body?.error?.code as string | undefined
  const rawError = (body: unknown) => /\bat [\w.$<>]+ \(|\.ts:\d+:\d+|prisma|SELECT |INSERT |constraint|trigger|crg_validation_|crg_receipt/i.test(JSON.stringify(body ?? {}))
  const creatorId = (await prisma.user.findFirstOrThrow({ where: { email: adminEmail }, select: { id: true } })).id
  const key = (suffix: string) => `${runId}-${suffix}`
  const authContext = await auth.$context
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'ORG_ADMIN' }, select: { id: true } })
  const provisionMember = async (label: string, organizationId = org) => {
    const email = `${runId.toLowerCase()}-${label}@reviewers.sbn.test`
    const secretValue = randomBytes(24).toString('base64url')
    const user = await authContext.internalAdapter.createUser({ email, name: `Synthetic member ${label}`, emailVerified: false }, { method: 'email-password' })
    await authContext.internalAdapter.linkAccount({ userId: user.id, providerId: 'credential', issuer: 'local:credential', accountId: user.id, password: await authContext.password.hash(secretValue) })
    const membership = await prisma.organizationMembership.create({ data: { organizationId, userId: user.id } })
    await prisma.membershipRole.create({ data: { membershipId: membership.id, roleId: adminRole.id } })
    const signed = await signIn(email, secretValue)
    if (signed.status !== 200) throw new Error(`fixture member ${label} could not sign in (${signed.status})`)
    return { id: user.id as string, who: as(signed.cookie), cookie: signed.cookie }
  }
  // B approves claims (A6.5 requires a reviewer other than the creator); O is the other tenant's Admin.
  const B = await provisionMember('b')
  const O = await provisionMember('o', otherOrg)

  // ---------------------------------------------------------------- the two read routes (CRGB-G07)
  const routeCode = committedCode(`${MODULE_DIR}/coding-validation.route.ts`)
  const absent = [
    await post(`/api/validation-runs/${MISSING}/coding-receipts`, {}), await api('PUT', `/api/validation-runs/${MISSING}/coding-receipts`, {}), await api('DELETE', `/api/validation-runs/${MISSING}/coding-receipts`),
    await post(`/api/claim-submissions/${MISSING}/coding-provenance`, {}), await get('/api/coding-receipts'), await get('/api/validation-scopes'), await post('/api/validation-scopes', {}), await post(`/api/encounters/${MISSING}/validation-scope`, {}),
  ]
  check(
    'CRGB-G07',
    'Exactly two read-only routes; no scope or receipt writer',
    (routeCode.match(/codingValidationRouter\.(get|post|put|patch|delete|all|use)\(/g) ?? []).length === 2 && /codingValidationRouter\.get\(\s*'\/validation-runs\/:runId\/coding-receipts'/.test(routeCode) &&
      /codingValidationRouter\.get\(\s*'\/claim-submissions\/:submissionId\/coding-provenance'/.test(routeCode) && absent.every((r) => r.status === 404 || r.status === 405),
    `the receipts and freeze-binding GETs only; POST/PUT/DELETE, a receipt collection and any scope route are absent (${absent.map((r) => r.status).join('/')}); the scope writer is a maintenance function with no HTTP route`,
  )

  // ---------------------------------------------------------------- fixtures
  section('Fixtures: synthetic editions and scopes through the CRG writers; facilities, codes, encounters, commercial context, claims and freezes through owner routes')
  const okValue = <T>(label: string, result: { ok: true; value: T } | { ok: false; message: string }): T => {
    if (!result.ok) throw new Error(`fixture ${label} was refused: ${result.message}`)
    return result.value
  }
  const maintenanceActor = { actorRef: `crg-01b-harness:${runId}`, reason: 'synthetic CRG Checkpoint B fixture' }
  const JUR = 'AE-DU'
  const AUTH = `SYN-CRGB-${runToken}`
  const AUTH_C = `${AUTH}-C`
  const AUTH_D = `${AUTH}-D`
  const AUTH_S = `${AUTH}-S`
  const C1 = `Q${runToken}.1`
  const C2 = `Q${runToken}.2`
  const C3 = `Q${runToken}.3`
  const C9 = `Q${runToken}.9`
  const P1 = `P${runToken}`
  const H1 = `H${runToken}`
  type Release = { datasetId: string; versionId: string; importId: string }
  const artifactOf = (label: string, codes: readonly string[]) => {
    const lines = codes.map((code, i) => `${label}-r${i + 1}\t${code}`)
    const bytes = Buffer.from(lines.map((line) => `${line}\n`).join(''), 'utf8')
    const rows = codes.map((code, i) => ({ sourceRowId: `${label}-r${i + 1}`, code, sourceRowSha256: sha256Of(Buffer.from(lines[i], 'utf8')) }))
    const fingerprint = sha256Of(Buffer.from([...rows].sort((a, b) => Buffer.compare(Buffer.from(a.sourceRowId), Buffer.from(b.sourceRowId))).map((r) => `${r.sourceRowId}\t${r.code}\t${r.sourceRowSha256}\n`).join(''), 'utf8'))
    return { bytes, sha: sha256Of(bytes), rows, fingerprint }
  }
  const rights = async (authority: string, codeSystem: string, rightsStatus: string) =>
    okValue('rights', await recordRightsDecision({ jurisdictionCode: JUR, authorityCode: authority, codeSystem, rightsStatus, decisionReference: `synthetic fixture ${runId}` }))
  const datasetFor = async (label: string, authority: string, codeSystem: string) => {
    const datasetId = okValue(`${label} dataset`, await importReferenceDataset({ datasetKey: key(label), displayName: `${runId} ${label}`, jurisdictionCode: JUR, authorityCode: authority })).id
    okValue(`${label} mapping`, await registerDatasetCodeSystem({ datasetId, codeSystem, purpose: 'CLAIM_CODING' }))
    return datasetId
  }
  const editionOf = async (label: string, datasetId: string, from: string, to: string | null, codes: string[], activate = true): Promise<Release> => {
    const artifact = artifactOf(label, codes)
    const versionId = okValue(`${label} version`, await importReferenceDatasetVersion({ datasetId, sourceVersionId: null, version: label, retrievedAt: new Date().toISOString(), effectiveFrom: from, effectiveTo: to, contentHash: artifact.sha })).id
    const imported = okValue<{ importId: string }>(
      `${label} import`,
      (await importRelease({ datasetVersionId: versionId, artifactFormat: 'CRG-SYNTHETIC-TSV-1', artifactBase64: artifact.bytes.toString('base64'), sourceFileSha256: artifact.sha, membershipFingerprintSha256: artifact.fingerprint, sourceUri: `synthetic:${runId}/${label}`, publisher: 'Synthetic CRG-B fixture', expectedRowCount: codes.length })) as never,
    )
    if (activate) {
      okValue('validate', await validateReferenceDatasetVersion(versionId, 'VALIDATED', maintenanceActor))
      okValue('activate', await activateReferenceDatasetVersion(versionId, maintenanceActor))
    }
    return { datasetId, versionId, importId: (imported as { importId?: string }).importId ?? '' }
  }
  const activateLater = async (release: Release) => {
    okValue('validate', await validateReferenceDatasetVersion(release.versionId, 'VALIDATED', maintenanceActor))
    okValue('activate', await activateReferenceDatasetVersion(release.versionId, maintenanceActor))
  }
  // Main scope: ICD-10-CM edition A (2021–2026) and B (2027–, activated later), a CPT edition, a HCPCS edition without
  // rights; rights APPROVED for ICD-10-CM and CPT. A conflict scope (two overlapping editions), a scope to disable and
  // a scope for the snapshot proof. Each scope ENABLED through the Checkpoint B maintenance writer.
  for (const [authority, systems] of [[AUTH, ['ICD-10-CM', 'CPT']], [AUTH_C, ['ICD-10-CM']], [AUTH_D, ['ICD-10-CM']], [AUTH_S, ['ICD-10-CM']]] as const) for (const system of systems) await rights(authority, system, 'APPROVED')
  const DXSET = await datasetFor('dx', AUTH, 'ICD-10-CM')
  const EA = await editionOf('2021', DXSET, '2021-01-01', '2026-12-31', [C1, C2])
  const EB = await editionOf('2027', DXSET, '2027-01-01', null, [C1, C3], false)
  const EP = await editionOf('cpt', await datasetFor('px', AUTH, 'CPT'), '2021-01-01', null, [P1])
  await editionOf('hcpcs', await datasetFor('hx', AUTH, 'HCPCS-LEVEL-II'), '2021-01-01', null, [H1])
  const CSET = await datasetFor('conflict', AUTH_C, 'ICD-10-CM')
  await editionOf('c1', CSET, '2021-01-01', null, [C1])
  const CSET2 = await datasetFor('conflict2', AUTH_C, 'ICD-10-CM')
  await editionOf('c2', CSET2, '2021-01-01', null, [C1])
  await editionOf('d', await datasetFor('disable', AUTH_D, 'ICD-10-CM'), '2021-01-01', null, [C1])
  await editionOf('s', await datasetFor('snapshot', AUTH_S, 'ICD-10-CM'), '2021-01-01', null, [C1, C2])
  for (const authority of [AUTH, AUTH_C, AUTH_D, AUTH_S]) await recordValidationScope({ jurisdictionCode: JUR, authorityCode: authority, scopeStatus: 'ENABLED', decisionReference: `synthetic fixture ${runId}` })

  const at = (path: string, body: unknown) => post(path, body, asAdmin)
  const clinician = must('clinician', (await at(`/api/organizations/${org}/clinicians`, { displayName: `${runId} clinician` })).body)
  const facilityFor = async (label: string, authority: string) => {
    const facility = must(`${label} facility`, (await at(`/api/organizations/${org}/facilities`, { name: `${runId} ${label} facility` })).body)
    const profile = must(`${label} profile`, (await at(`/api/facilities/${facility.id}/regulatory-profiles`, { jurisdictionCode: JUR, regulatoryAuthorityCode: authority, effectiveFrom: '2020-01-01', effectiveTo: null })).body)
    if ((await at(`/api/facility-regulatory-profiles/${profile.id}/activate`, {})).status !== 200) throw new Error(`fixture ${label} profile activation failed`)
    must(`${label} assignment`, (await at(`/api/clinicians/${clinician.id}/facility-assignments`, { facilityId: facility.id, effectiveFrom: '2020-01-01', effectiveTo: null })).body)
    return facility.id as string
  }
  const FMAIN = await facilityFor('main', AUTH)
  const FCONF = await facilityFor('conflict', AUTH_C)
  const FDIS = await facilityFor('disable', AUTH_D)
  const FSNAP = await facilityFor('snapshot', AUTH_S)
  const FNONE = await facilityFor('v1', 'DHA')
  const patient = must('patient', (await at(`/api/organizations/${org}/patients`, { givenName: 'Synthetic', familyName: `${runId}-P`, dateOfBirth: '1990-01-01' })).body)
  const dx = async (code: string) => must(`diagnosis ${code}`, (await at(`/api/organizations/${org}/diagnosis-codes`, { code, displayName: `${runId} synthetic diagnosis` })).body).id as string
  const px = async (label: string, codeSystem: string | null, externalCode: string | null) =>
    must(`procedure ${label}`, (await at(`/api/organizations/${org}/procedure-codes`, { internalCode: key(label), displayName: `${runId} synthetic procedure`, codeSystem, externalCode })).body).id as string
  const DX1 = await dx(C1)
  const DX2 = await dx(C2)
  const DX9 = await dx(C9)
  const PCPT = await px('pcpt', 'CPT', P1)
  const PNULL = await px('pnull', null, null)
  const PHCPCS = await px('phcpcs', 'HCPCS-LEVEL-II', H1)
  const svc = must('service', (await at(`/api/organizations/${org}/services`, { internalCode: key('SB'), displayName: `${runId} service` })).body)
  type Built = { id: string; diagnoses: string[]; activities: string[]; coded: string[]; serviceActivities: string[] }
  const encounterAt = async (facilityId: string, serviceDate: string, diagnoses: string[], procedures: string[] = [], services = 0): Promise<Built> => {
    const encounter = must(`encounter ${serviceDate}`, (await at(`/api/patients/${patient.id}/encounters`, { facilityId, clinicianId: clinician.id, serviceDate, insuranceMembershipId: null })).body)
    const built: Built = { id: encounter.id, diagnoses: [], activities: [], coded: [], serviceActivities: [] }
    for (const diagnosisCodeId of diagnoses) built.diagnoses.push(must('encounter diagnosis', (await at(`/api/encounters/${encounter.id}/diagnoses`, { diagnosisCodeId })).body).id)
    for (const procedureCodeId of procedures) {
      const id = must('encounter activity', (await at(`/api/encounters/${encounter.id}/activities`, { procedureCodeId, quantity: '1' })).body).id
      built.activities.push(id)
      built.coded.push(id)
    }
    for (let i = 0; i < services; i += 1) {
      const id = must('service activity', (await at(`/api/encounters/${encounter.id}/activities`, { serviceId: svc.id, quantity: '1' })).body).id
      built.activities.push(id)
      built.serviceActivities.push(id)
    }
    return built
  }
  // The commercial context of the claim fixtures (one contract on the main and the V1 facility).
  const payer = must('payer', (await at(`/api/organizations/${org}/payers`, { displayName: `${runId} payer` })).body)
  const contract = must('contract', (await at(`/api/organizations/${org}/provider-contracts`, { contractKey: key('C'), displayName: `${runId} contract`, payerId: payer.id, effectiveFrom: '2020-01-01', effectiveTo: null })).body)
  for (const facilityId of [FMAIN, FNONE, FDIS]) must('contract facility', (await at(`/api/provider-contracts/${contract.id}/contract-facilities`, { facilityId })).body)
  const schedule = must('schedule', (await at(`/api/provider-contracts/${contract.id}/tariff-schedules`, { tariffKey: key('T'), displayName: `${runId} tariff` })).body)
  const tariffVersion = must('tariff version', (await at(`/api/tariff-schedules/${schedule.id}/versions`, { version: key('V'), effectiveFrom: '2026-01-01', effectiveTo: null })).body)
  must('service rate', (await at(`/api/tariff-schedule-versions/${tariffVersion.id}/rates`, { modifierCodes: [], currencyCode: 'AED', selectorKind: 'SERVICE', serviceId: svc.id, unitTariffAmount: '12.1250' })).body)
  must('procedure rate', (await at(`/api/tariff-schedule-versions/${tariffVersion.id}/rates`, { modifierCodes: [], currencyCode: 'AED', selectorKind: 'PROCEDURE_CODE', procedureCodeId: PCPT, unitTariffAmount: '125.2500' })).body)
  if ((await at(`/api/tariff-schedule-versions/${tariffVersion.id}/verification`, { verificationStatus: 'VERIFIED' })).status !== 200) throw new Error('fixture: the tariff version could not be verified')
  const contextOf = async (encounterId: string) => {
    const row = await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId }, select: { facilityId: true, facilityRegulatoryProfileId: true, serviceDate: true } })
    return {
      serviceDate: formatDateOnly(row.serviceDate) as string, facilityId: row.facilityId, facilityRegulatoryProfileId: row.facilityRegulatoryProfileId, insuranceMembershipId: null,
      payerId: payer.id as string | null, tpaId: null, networkId: null, insuranceProductId: null, providerContractId: contract.id as string | null, tariffScheduleId: schedule.id as string | null,
      tariffScheduleVersionId: tariffVersion.id as string | null,
    }
  }
  const synthetic = (layer: string, findingCode: string, extra: Record<string, unknown> = {}) => ({ layer, outcome: 'PASS', findingCode, message: 'Synthetic finding.', ...extra })
  // A READY_FOR_REVIEW A5-VAL-2 run through A5.8's own write path (the recorder, then the CRG coding-release findings and
  // receipts on the same transaction) with synthetic commercial findings; a V1 twin through the recorder alone.
  const readyRun = async (built: Built, validatorVersion: 'A5-VAL-1' | 'A5-VAL-2') =>
    prisma.$transaction(async (tx) => {
      const coding = validatorVersion === 'A5-VAL-2' ? await evaluateCodingRelease(built.id, tx) : { drafts: [], plans: [] }
      const findings = [
        synthetic('TECHNICAL', 'TECHNICAL_CONTEXT_VALID'),
        ...built.diagnoses.map((encounterDiagnosisId) => synthetic('CODING', 'SYNTHETIC_PASS', { encounterDiagnosisId })),
        ...built.activities.map((encounterActivityId) => synthetic('CONTRACT', 'SYNTHETIC_PASS', { encounterActivityId })),
        ...coding.drafts.map((d) => ({ layer: 'CODING', outcome: d.outcome, findingCode: d.findingCode, message: d.message, encounterDiagnosisId: d.encounterDiagnosisId, encounterActivityId: d.encounterActivityId, referenceDatasetVersionId: d.referenceDatasetVersionId })),
      ]
      const recorded = await recordValidationRunInTransaction({ encounterId: built.id, contextSnapshot: await contextOf(built.id), validatorVersion, findings }, creatorId, tx)
      if (!recorded.ok) throw new Error(`fixture run refused: ${recorded.message}`)
      if (validatorVersion === 'A5-VAL-2') await recordCodingReceipts(recorded.value.id, built.id, coding.plans, tx)
      return recorded.value.id
    })
  type Claimed = { runId: string; assessmentId: string; claimId: string; lines: string[]; claimDiagnoses: string[]; pricingRunId: string; draft: { id: string; assemblyFingerprint: string }; approvalId: string; submissionId: string | null }
  const claimThrough = async (built: Built, runIdOf: string, freeze = true): Promise<Claimed> => {
    const assessed = await at(`/api/validation-runs/${runIdOf}/readiness-assessments`, {})
    if (assessed.status !== 201 || assessed.body.state !== 'READY_FOR_REVIEW') throw new Error(`fixture readiness: ${assessed.status} ${JSON.stringify(assessed.body).slice(0, 200)}`)
    const claim = must('claim', (await at(`/api/pre-claim-readiness-assessments/${assessed.body.id}/claims`, {})).body)
    const lines: string[] = []
    for (const encounterActivityId of built.activities) lines.push(must('claim line', (await at(`/api/claims/${claim.id}/lines`, { encounterActivityId })).body).id)
    const claimDiagnoses: string[] = []
    for (const [i, encounterDiagnosisId] of built.diagnoses.entries()) claimDiagnoses.push(must('claim diagnosis', (await at(`/api/claims/${claim.id}/diagnoses`, { encounterDiagnosisId, roleCode: i === 0 ? 'PRIMARY' : 'SECONDARY' })).body).id)
    for (const lineId of lines) if ((await api('PUT', `/api/claim-lines/${lineId}/diagnosis-pointers`, { claimDiagnosisIds: [claimDiagnoses[0]] })).status !== 200) throw new Error('fixture pointers refused')
    const pricing = await at(`/api/claims/${claim.id}/pricing-runs`, {})
    if (pricing.status !== 201) throw new Error(`fixture pricing ${pricing.status}`)
    const draft = await at(`/api/claims/${claim.id}/draft-assessments`, { pricingRunId: pricing.body.id })
    if (draft.status !== 201 || draft.body.outcome !== 'REVIEWABLE') throw new Error(`fixture draft ${draft.status} ${draft.body?.outcome}`)
    const approved = await post(`/api/claims/${claim.id}/review-decisions`, { draftAssessmentId: draft.body.id, assemblyFingerprint: draft.body.assemblyFingerprint, decisionCode: 'APPROVE' }, B.who)
    if (approved.status !== 201) throw new Error(`fixture approval ${approved.status}`)
    let submissionId: string | null = null
    if (freeze) {
      const frozen = await at(`/api/claims/${claim.id}/submissions`, { draftAssessmentId: draft.body.id, approvalDecisionId: approved.body.decision.id })
      if (frozen.status !== 201) throw new Error(`fixture freeze ${frozen.status} ${errorCode(frozen.body) ?? ''} ${JSON.stringify(frozen.body).slice(0, 200)}`)
      submissionId = frozen.body.submissionId
    }
    return { runId: runIdOf, assessmentId: assessed.body.id, claimId: claim.id, lines, claimDiagnoses, pricingRunId: pricing.body.id, draft: draft.body, approvalId: approved.body.decision.id, submissionId }
  }
  const execute = (encounterId: string, body: unknown = {}) => post(`/api/encounters/${encounterId}/pre-claim-validation/execute`, body)
  const receiptsOf = (runIdOf: string) => prisma.$queryRawUnsafe<ReceiptRow[]>(`SELECT * FROM crg_validation_code_receipts WHERE validation_run_id = $1::uuid ORDER BY subject_kind, COALESCE(encounter_diagnosis_id, encounter_activity_id)`, runIdOf)
  const findingsOf = (runIdOf: string) => prisma.validationFinding.findMany({ where: { validationRunId: runIdOf }, orderBy: { sequence: 'asc' } })

  // A historical V1 claim frozen BEFORE any Checkpoint B write of this run (its bytes must never change, CRG-087).
  const EH = await encounterAt(FNONE, '2026-06-15', [DX1], [PCPT], 1)
  const H = await claimThrough(EH, await readyRun(EH, 'A5-VAL-1'))
  const historyHash = async () => (await prisma.$queryRawUnsafe<{ h: string }[]>(`SELECT encode(sha256(convert_to(coalesce((SELECT string_agg(row_to_json(f)::text, '|' ORDER BY f.id) FROM claim_freezes f WHERE f.claim_id = $1::uuid), ''), 'UTF8')), 'hex') AS h`, H.claimId))[0].h
  const historyBefore = await historyHash()
  // The validator encounters: EV in the ENABLED main scope (every decision), EV1 its V1 twin, E20 before any edition,
  // EC in the conflict scope.
  const EV = await encounterAt(FMAIN, '2026-06-15', [DX1, DX9], [PCPT, PNULL, PHCPCS], 1)
  const EV1 = await encounterAt(FNONE, '2026-06-15', [DX1, DX9], [PCPT, PNULL, PHCPCS], 1)
  const E20 = await encounterAt(FMAIN, '2020-06-15', [DX1])
  const EC = await encounterAt(FCONF, '2026-06-15', [DX1])
  // The claim encounters: EW (V2, frozen), EW1 (its V1 twin, frozen), EK (V2, corrected after edition B activates).
  const EW = await encounterAt(FMAIN, '2026-06-15', [DX1], [PCPT], 1)
  const EW1 = await encounterAt(FNONE, '2026-06-15', [DX1], [PCPT], 1)
  const EK = await encounterAt(FMAIN, '2026-12-31', [DX2], [PCPT], 1)
  progress(`fixtures ready: synthetic authority ${AUTH} (ICD-10-CM 2021 and 2027, CPT, HCPCS without rights), conflict, disable and snapshot scopes, a V1 facility, the historical V1 freeze ${H.submissionId?.slice(0, 8)}`)
  // B-G04 — judged after the fixtures, so its third-value probes always have this run's own V1 claim and freeze.
  const anyClaim = { id: H.claimId }
  const anyFreeze = { id: H.submissionId as string }
  const thirdValue = [
    anyClaim ? await rolledBack(async (tx) => { await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica'); await tx.$executeRawUnsafe(`UPDATE claims SET handoff_schema_version = 'PreClaimA6HandoffV3' WHERE id = '${anyClaim.id}'`) }) : { message: 'no claim', clean: true },
    anyFreeze ? await rolledBack(async (tx) => { await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica'); await tx.$executeRawUnsafe(`UPDATE claim_freezes SET payload_schema_version = 'A6-PAYLOAD-3' WHERE id = '${anyFreeze.id}'`) }) : { message: 'no freeze', clean: true },
    anyFreeze ? await rolledBack(async (tx) => { await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica'); await tx.$executeRawUnsafe(`UPDATE claim_freezes SET submission_contract_version = 'A6-SUBMISSION-3' WHERE id = '${anyFreeze.id}'`) }) : { message: 'no freeze', clean: true },
    anyFreeze ? await rolledBack(async (tx) => { await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica'); await tx.$executeRawUnsafe(`UPDATE claim_freezes SET payload_schema_version = 'A6-PAYLOAD-2' WHERE id = '${anyFreeze.id}'`) }) : { message: 'no freeze', clean: true },
  ]
  check(
    'B-G04',
    'Three tables, seven contracts, verified CHECKs',
    same(createdTables, NEW_TABLES) && same(addedContracts, [...NEW_CONTRACTS].sort()) && existingDefs.every((d) => d.length > 0) && existingDefs[0].includes('btrim') && !/'A5-VAL/.test(existingDefs[0]) &&
      !/'A5-READY/.test(existingDefs[1]) && /'PreClaimA6HandoffV1'/.test(existingDefs[2]) && /'PreClaimA6HandoffV2'/.test(existingDefs[2]) && /'A6-PAYLOAD-1'/.test(existingDefs[4]) && /'A6-PAYLOAD-2'/.test(existingDefs[4]) &&
      /'A6-SUBMISSION-1'/.test(existingDefs[5]) && /'A6-SUBMISSION-2'/.test(existingDefs[5]) && /'A6-EVIDENCE-1'/.test(existingDefs[6]) && !/A6-EVIDENCE-2/.test(existingDefs[6]) &&
      [thirdValue[0], thirdValue[1], thirdValue[2]].every((r) => refusedBy(r, /check constraint|23514/) && r.clean) && refusedBy(thirdValue[3], /claim_freezes_version_pair_chk|23514/) && thirdValue[3].clean,
    `tables ${createdTables.join(', ')}; new contract literals ${addedContracts.join(', ')}; all ${existingNames.length} existing version CHECKs present (validator and policy carry no literal; A6-EVIDENCE-1 unchanged); a third handoff, payload or submission value and a mismatched pair are refused`,
  )

  // ---------------------------------------------------------------- 06 A5 validation contract (CRG-051–060)
  section('06 A5 validation contract: every diagnosis and coded procedure evaluated, modifiers never guessed, owner invariants kept, a new immutable validator, frozen findings, unresolved blocks, other layers unchanged, no client input, one snapshot')
  const countsBeforeExecute = await counts()
  const rv = await execute(EV.id)
  const rv1 = await execute(EV1.id)
  const RV = rv.body?.validationRunId as string
  const RV1 = rv1.body?.validationRunId as string
  const rvFindings = RV ? await findingsOf(RV) : []
  const rv1Findings = RV1 ? await findingsOf(RV1) : []
  const rvReceipts = RV ? await receiptsOf(RV) : []
  const releaseFindings = rvFindings.filter((f) => f.findingCode.startsWith('CODING_RELEASE_'))
  const receiptFor = (target: string) => rvReceipts.filter((r) => (r.encounter_diagnosis_id ?? r.encounter_activity_id) === target)
  check(
    'CRG-051',
    'Every active diagnosis has an exact CRG evaluation',
    rv.status === 201 && rv.body.validatorVersion === 'A5-VAL-2' && EV.diagnoses.every((d) => receiptFor(d).length === 1 && releaseFindings.filter((f) => f.encounterDiagnosisId === d).length === 1),
    `the real A5.8 execution on EV selected A5-VAL-2 from the ENABLED scope; each of its ${EV.diagnoses.length} active diagnoses has exactly one receipt and one CODING_RELEASE finding`,
  )
  check(
    'CRG-052',
    'Every procedure-code activity has an exact evaluation',
    EV.coded.every((a) => receiptFor(a).length === 1 && releaseFindings.filter((f) => f.encounterActivityId === a).length === 1) && EV.serviceActivities.every((a) => receiptFor(a).length === 0 && !releaseFindings.some((f) => f.encounterActivityId === a)) &&
      rvReceipts.length === EV.diagnoses.length + EV.coded.length,
    `each of the ${EV.coded.length} procedure-coded activities has exactly one receipt; the service-only activity has none (it is not a code target)`,
  )
  const receiptColumns = (await prisma.$queryRawUnsafe<{ c: string }[]>(`SELECT column_name AS c FROM information_schema.columns WHERE table_name = 'crg_validation_code_receipts'`)).map((r) => r.c)
  check(
    'CRG-053',
    'Modifiers never verified or guessed by CRG',
    !receiptColumns.some((c) => /modifier/.test(c)) && !Object.values(codingReleaseFindings).some((entry) => /MODIFIER/.test(entry.findingCode)) && !rvFindings.some((f) => /MODIFIER/.test(f.findingCode)) && !/modifier/i.test(committedCode(`${MODULE_DIR}/coding-validation.manifest.ts`)),
    'no receipt column, coding-release finding or CRG logic names a modifier: without approved modifier reference data CRG records "not evaluated", never a guess',
  )
  const invariantsOf = (findings: { findingCode: string; outcome: string }[]) => findings.filter((f) => /^CODING_(DIAGNOSIS|ACTIVITY|OBSERVATION)_/.test(f.findingCode)).map((f) => `${f.findingCode}:${f.outcome}`).sort()
  check('CRG-054', 'A4 ordering/modifier invariants still run', invariantsOf(rvFindings).length === 3 && same(invariantsOf(rvFindings), invariantsOf(rv1Findings)), `the A4.5/A4.6/A4.7 owner invariants run identically under A5-VAL-2 and A5-VAL-1 (${invariantsOf(rvFindings).join(', ')})`)
  check(
    'CRG-055',
    'New validator is an explicit immutable version',
    VALIDATOR_VERSION === 'A5-VAL-1' && VALIDATOR_VERSION_V2 === 'A5-VAL-2' && rv1.status === 201 && rv1.body.validatorVersion === 'A5-VAL-1' && rv1Findings.every((f) => f.referenceDatasetVersionId === null) && (RV1 ? (await receiptsOf(RV1)).length === 0 : false),
    'A5-VAL-1 is unchanged and still consumes no reference dataset; A5-VAL-2 is a separate constant and run version',
  )
  check(
    'CRG-056',
    'Coding finding has approved layer, outcome, message',
    releaseFindings.length > 0 && releaseFindings.every((f) => {
      const entry = Object.values(codingReleaseFindings).find((e) => e.findingCode === f.findingCode)
      return !!entry && f.layer === 'CODING' && f.outcome === entry.outcome && f.message === entry.message
    }),
    `each of the ${releaseFindings.length} coding-release findings carries the frozen catalogue layer (CODING), outcome and message`,
  )
  const e20 = await execute(E20.id)
  const ec = await execute(EC.id)
  const decisionsOf = async (runIdOf: string) => (await receiptsOf(runIdOf)).map((r) => r.decision_code).sort()
  const readinessOf = async (runIdOf: string) => (await at(`/api/validation-runs/${runIdOf}/readiness-assessments`, {})).body
  const unresolved = [
    { label: 'EV', decisions: await decisionsOf(RV), readiness: await readinessOf(RV) },
    { label: 'E20', decisions: await decisionsOf(e20.body.validationRunId), readiness: await readinessOf(e20.body.validationRunId) },
    { label: 'EC', decisions: await decisionsOf(ec.body.validationRunId), readiness: await readinessOf(ec.body.validationRunId) },
  ]
  const allDecisions = new Set(unresolved.flatMap((u) => u.decisions))
  check(
    'CRG-057',
    'Unresolved release blocks READY_FOR_REVIEW',
    ['CODE_NOT_IN_RELEASE', 'NO_APPROVED_RELEASE', 'CONFLICTING_RELEASES', 'RELEASE_NOT_AUTHORIZED', 'AMBIGUOUS_CODE_SYSTEM', 'APPLICABLE'].every((d) => allDecisions.has(d)) &&
      unresolved.every((u) => u.readiness.readinessPolicyVersion === 'A5-READY-2' && u.readiness.state === 'BLOCKED'),
    `every unresolved decision (${[...allDecisions].filter((d) => d !== 'APPLICABLE').join(', ')}) is a FAIL, and each such run is BLOCKED under A5-READY-2`,
  )
  const otherLayers = (findings: { layer: string; findingCode: string; outcome: string }[]) => findings.filter((f) => !f.findingCode.startsWith('CODING_RELEASE_')).map((f) => `${f.layer}:${f.findingCode}:${f.outcome}`).sort()
  check('CRG-058', 'Coverage/contract/evidence decisions unchanged', otherLayers(rvFindings).length > 3 && same(otherLayers(rvFindings), otherLayers(rv1Findings)), `every non-coding-release finding of EV equals its V1 twin's (${otherLayers(rvFindings).length} findings)`)
  const countsBeforeRefused = await counts()
  const refusedBodies = await Promise.all([{ serviceDate: '2026-01-01' }, { editionId: EA.versionId }, { provenance: 'x' }, { validatorVersion: 'A5-VAL-1' }, { referenceDatasetVersionId: EA.versionId }].map((body) => execute(EV.id, body)))
  check('CRG-059', 'Client cannot supply date, edition or provenance', refusedBodies.every((r) => r.status === 400) && (await unchanged(countsBeforeRefused)), 'a serviceDate, edition, provenance, validator or dataset field in the execute body is refused (400) and no run is written')
  // CRG-060: a diagnosis added from another connection while an execution holds its snapshot is invisible to the
  // coding check and to the commit-time receipt guard alike.
  const ES = await encounterAt(FSNAP, '2026-06-15', [DX1])
  const hold = holdAt('pre_claim_validation.snapshot')
  const held = execute(ES.id)
  await Promise.race([hold.arrived, held])
  const added = await at(`/api/encounters/${ES.id}/diagnoses`, { diagnosisCodeId: DX2 })
  hold.release()
  const heldResult = await held
  clearConcurrencyProbes()
  const esReceipts = heldResult.body?.validationRunId ? await receiptsOf(heldResult.body.validationRunId) : []
  check(
    'CRG-060',
    'One REPEATABLE READ snapshot for coding and context',
    heldResult.status === 201 && added.status === 201 && esReceipts.length === 1 && esReceipts[0].encounter_diagnosis_id === ES.diagnoses[0] && /RepeatableRead/.test(committedCode('backend/src/modules/pre-claim-validation/pre-claim-validation.service.ts')),
    'a diagnosis committed from another connection mid-execution is not evaluated, receipted or required at commit: coding, commercial context and the receipt guard share one snapshot',
  )

  // ---------------------------------------------------------------- 07 receipt completeness and atomicity (CRG-061–070)
  section('07 Receipts: exact edition receipts, controlled refused bases, immutable binding, uniqueness, no incomplete commit, rollback after a receipt or a finding, foreign editions refused, legacy runs, independent replay')
  const dbRow = async (sql: string, ...params: unknown[]) => (await prisma.$queryRawUnsafe<Record<string, any>[]>(sql, ...params))[0] ?? {}
  const byTarget = (rows: ReceiptRow[], target: string) => rows.find((r) => (r.encounter_diagnosis_id ?? r.encounter_activity_id) === target) ?? ({} as ReceiptRow)
  const rDx1 = byTarget(rvReceipts, EV.diagnoses[0])
  const rDx9 = byTarget(rvReceipts, EV.diagnoses[1])
  const rCpt = byTarget(rvReceipts, EV.coded[0])
  const rNull = byTarget(rvReceipts, EV.coded[1])
  const rHcpcs = byTarget(rvReceipts, EV.coded[2])
  const memC1 = await dbRow(`SELECT id, import_id, source_row_sha256, release_content_hash FROM crg_release_code_memberships WHERE dataset_version_id = $1::uuid AND code = $2`, EA.versionId, C1)
  const impA = await dbRow(`SELECT id, membership_fingerprint_sha256 FROM crg_release_imports WHERE dataset_version_id = $1::uuid`, EA.versionId)
  const mapA = await dbRow(`SELECT id FROM crg_code_system_datasets WHERE dataset_id = $1::uuid`, DXSET)
  check(
    'CRG-061',
    'Each successful code check writes exact receipt',
    rDx1.decision_code === 'APPLICABLE' && rDx1.reference_dataset_version_id === EA.versionId && rDx1.release_import_id === impA.id && rDx1.membership_id === memC1.id && rDx1.code_system_dataset_id === mapA.id &&
      rDx1.source_row_sha256 === memC1.source_row_sha256 && rDx1.release_content_hash === memC1.release_content_hash && rDx1.membership_fingerprint_sha256 === impA.membership_fingerprint_sha256 &&
      rCpt.decision_code === 'APPLICABLE' && rCpt.reference_dataset_version_id === EP.versionId && rDx1.contract_version === 'CRG-RECEIPT-1' && rDx1.algorithm_version === 'CRG-CODESET-1',
    "EV's member diagnosis and procedure receipts name exactly their edition, import, dataset mapping and membership, with the membership's row and release hashes and the import's fingerprint",
  )
  const e20Receipt = (await receiptsOf(e20.body.validationRunId))[0] ?? ({} as ReceiptRow)
  check(
    'CRG-062',
    'Each refused check has a controlled, uninvented basis',
    rDx9.decision_code === 'CODE_NOT_IN_RELEASE' && rDx9.reference_dataset_version_id === EA.versionId && rDx9.membership_id === null && rDx9.source_row_sha256 === null &&
      rHcpcs.decision_code === 'RELEASE_NOT_AUTHORIZED' && rHcpcs.reference_dataset_version_id === null && rHcpcs.code_system === 'HCPCS-LEVEL-II' && rNull.decision_code === 'AMBIGUOUS_CODE_SYSTEM' && rNull.code_system === null && rNull.canonical_code === null &&
      e20Receipt.decision_code === 'NO_APPROVED_RELEASE' && e20Receipt.reference_dataset_version_id === null && e20Receipt.release_import_id === null,
    'a non-member names its governing edition and no membership; not-authorized, ambiguous and no-release decisions name no edition, import or membership; an ambiguous code names no system or code — nothing is invented',
  )
  check(
    'CRG-063',
    'Receipt binds target, code, release UUID and row hash',
    rDx1.master_code_id === DX1 && rDx1.canonical_code === C1.toUpperCase() && rDx1.encounter_diagnosis_id === EV.diagnoses[0] && rDx1.encounter_id === EV.id && rCpt.canonical_code === P1 && rCpt.master_code_id === PCPT &&
      rDx1.source_row_sha256 === sha256Of(Buffer.from(`2021-r1\t${C1}`, 'utf8')) && formatDateOnly(rDx1.service_date as unknown as Date) === '2026-06-15' && rDx1.authority_code === AUTH,
    "each receipt binds the exact encounter target, its A2 master and canonical code at run time, the edition's UUID and the membership row's own SHA-256, under the run's scope and service date",
  )
  const off = async (tx: DbClient) => tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
  const UUID_COLUMNS = new Set(['id', 'validation_run_id', 'encounter_id', 'validation_finding_id', 'encounter_diagnosis_id', 'encounter_activity_id', 'master_code_id', 'code_system_dataset_id', 'release_import_id', 'reference_dataset_version_id', 'membership_id'])
  // One receipt row inserted as given (recorded_at left to the database), each value cast to its column type.
  const insertReceiptRow = async (tx: DbClient, row: Record<string, unknown>) => {
    const columns = Object.keys(row).filter((c) => c !== 'recorded_at')
    await tx.$executeRawUnsafe(
      `INSERT INTO crg_validation_code_receipts (${columns.join(', ')}) VALUES (${columns.map((c, i) => `$${i + 1}${UUID_COLUMNS.has(c) ? '::uuid' : c === 'service_date' ? '::date' : ''}`).join(', ')})`,
      ...columns.map((c) => (row[c] instanceof Date ? formatDateOnly(row[c] as Date) : row[c])),
    )
  }
  const insertCopy = (tx: DbClient, r: ReceiptRow, overrides: Record<string, string | null>) => insertReceiptRow(tx, { ...r, id: randomUUID(), ...overrides })
  const dupTarget = await rolledBack(async (tx) => {
    await off(tx)
    await insertCopy(tx, rDx1, { validation_finding_id: rDx9.validation_finding_id })
  })
  const dupFinding = await rolledBack(async (tx) => {
    await off(tx)
    await insertCopy(tx, rDx1, { encounter_diagnosis_id: randomUUID() })
  })
  check(
    'CRG-064',
    'Duplicate receipt per target or finding refused',
    refusedBy(dupTarget, /crg_validation_code_receipts_target_key|23505/) && refusedBy(dupFinding, /crg_validation_code_receipts_finding_key|23505/) && dupTarget.clean && dupFinding.clean,
    'with every trigger off, a second receipt for the same (run, subject, target) and a second receipt for one finding are refused by their unique keys',
  )
  // A forged A5-VAL-2 run (rolled back): the production plans, one mutation, then the deferred guards fired at once.
  const forged = async (built: Built, mutate: (rows: ReceiptRow[], findings: { id: string; findingCode: string; encounterDiagnosisId: string | null; encounterActivityId: string | null }[]) => ReceiptRow[], options: { technical?: boolean; manifest?: 'right' | 'wrong' | 'none' } = {}) =>
    rolledBack(async (tx) => {
      const coding = await evaluateCodingRelease(built.id, tx)
      const findings = [
        ...(options.technical === false ? [] : [synthetic('TECHNICAL', 'TECHNICAL_CONTEXT_VALID')]),
        ...coding.drafts.map((d) => ({ layer: 'CODING', outcome: d.outcome, findingCode: d.findingCode, message: d.message, encounterDiagnosisId: d.encounterDiagnosisId, encounterActivityId: d.encounterActivityId, referenceDatasetVersionId: d.referenceDatasetVersionId })),
        synthetic('CONTRACT', 'SYNTHETIC_PASS'),
      ]
      const recorded = await recordValidationRunInTransaction({ encounterId: built.id, contextSnapshot: await contextOf(built.id), validatorVersion: 'A5-VAL-2', findings }, creatorId, tx)
      if (!recorded.ok) throw new Error(`forged run refused by the recorder: ${recorded.message}`)
      const stored = await tx.validationFinding.findMany({ where: { validationRunId: recorded.value.id }, select: { id: true, findingCode: true, encounterDiagnosisId: true, encounterActivityId: true } })
      const base: ReceiptRow[] = coding.plans.map((plan) => {
        const finding = stored.find((f) => f.findingCode.startsWith('CODING_RELEASE_') && (plan.subjectKind === 'DIAGNOSIS' ? f.encounterDiagnosisId === plan.targetId : f.encounterActivityId === plan.targetId))
        return {
          id: randomUUID(), validation_run_id: recorded.value.id, encounter_id: built.id, validation_finding_id: finding?.id ?? null, subject_kind: plan.subjectKind,
          encounter_diagnosis_id: plan.subjectKind === 'DIAGNOSIS' ? plan.targetId : null, encounter_activity_id: plan.subjectKind === 'PROCEDURE' ? plan.targetId : null, master_code_id: plan.masterCodeId,
          code_system: plan.codeSystem, canonical_code: plan.canonicalCode, decision_code: plan.decisionCode, code_system_dataset_id: plan.codeSystemDatasetId, release_import_id: plan.releaseImportId,
          reference_dataset_version_id: plan.referenceDatasetVersionId, membership_id: plan.membershipId, source_row_sha256: plan.sourceRowSha256, release_content_hash: plan.releaseContentHash,
          membership_fingerprint_sha256: plan.membershipFingerprintSha256, service_date: plan.serviceDate, jurisdiction_code: plan.jurisdictionCode, authority_code: plan.authorityCode, algorithm_version: 'CRG-CODESET-1', contract_version: 'CRG-RECEIPT-1',
        }
      })
      const rows = mutate(base, stored)
      for (const row of rows) await insertReceiptRow(tx, row)
      if (options.manifest !== 'none') {
        const manifest = independentManifest(rows)
        await tx.$executeRawUnsafe(
          `INSERT INTO crg_validation_receipt_manifests (id, validation_run_id, receipt_count, manifest_sha256, contract_version) VALUES (gen_random_uuid(), $1::uuid, $2, $3, 'CRG-RECEIPT-1')`,
          recorded.value.id, manifest.count, options.manifest === 'wrong' ? sha256Of('wrong') : manifest.sha256,
        )
      }
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
      return recorded.value.id
    })
  const incomplete = await forged(EW, (rows) => rows.slice(1))
  const valid = await forged(EW, (rows) => rows)
  check(
    'CRG-065',
    'A run with a missing receipt cannot commit',
    refusedBy(incomplete, /crg_receipt_integrity: I4/) && incomplete.clean && valid.message.includes(NOT_COMMITTED) && valid.clean,
    'a forged A5-VAL-2 run with one receipt omitted is refused when its deferred guards fire; the same run with every receipt passes them (and is rolled back)',
  )
  const { executePreClaimValidation } = await import('../../modules/pre-claim-validation/pre-claim-validation.service.ts')
  const EF = await encounterAt(FMAIN, '2026-06-15', [DX1], [PCPT])
  const countsBeforeInjection = await counts()
  const afterReceipt = failOnce('pre_claim_validation.receipts_inserted', 'injected failure after the receipts')
  const crashedReceipt = await attemptAdversarial(() => executePreClaimValidation(EF.id, {}, creatorId))
  const afterReceiptClean = await unchanged(countsBeforeInjection)
  check('CRG-066', 'Failure after the receipts rolls everything back', afterReceipt.reached === 1 && /injected failure after the receipts/.test(crashedReceipt) && afterReceiptClean, 'a failure after the receipts and manifest were written left no run, finding, receipt, manifest or audit')
  const afterFinding = failOnce('validation_run.findings_inserted', 'injected failure after the findings')
  const crashedFinding = await attemptAdversarial(() => executePreClaimValidation(EF.id, {}, creatorId))
  clearConcurrencyProbes()
  check('CRG-067', 'Failure after a finding rolls everything back', afterFinding.reached === 1 && /injected failure after the findings/.test(crashedFinding) && (await unchanged(countsBeforeInjection)), 'a failure right after the findings were written left nothing at all')
  const otherEdition = await dbRow(
    `SELECT v.id, i.id AS import_id, m.id AS mapping_id, i.membership_fingerprint_sha256 AS fp FROM reference_dataset_versions v JOIN crg_release_imports i ON i.dataset_version_id = v.id JOIN crg_code_system_datasets m ON m.dataset_id = v.dataset_id WHERE v.dataset_id = $1::uuid`,
    CSET,
  )
  // A receipt naming the conflict scope's edition (and its own mapping, import and fingerprint), on a main-scope run.
  const foreignEdition = await forged(EW, (rows) =>
    rows.map((r) =>
      r.subject_kind === 'DIAGNOSIS' ? { ...r, reference_dataset_version_id: otherEdition.id, release_import_id: otherEdition.import_id, code_system_dataset_id: otherEdition.mapping_id, membership_fingerprint_sha256: otherEdition.fp } : r,
    ),
  )
  check('CRG-068', "Another scope's edition in a receipt refused", refusedBy(foreignEdition, /crg_receipt_integrity: I[35]/) && foreignEdition.clean, "a receipt naming the conflict scope's edition on a main-scope run is refused by the commit-time integrity guard")
  const legacy = await get(`/api/validation-runs/${RV1}/coding-receipts`)
  check('CRG-069', 'Legacy runs readable without fabricated receipts', legacy.status === 200 && legacy.body.verificationStatus === 'LEGACY_PROVENANCE_UNVERIFIED' && legacy.body.manifest === null && (await receiptsOf(RV1)).length === 0, 'the A5-VAL-1 run reads LEGACY_PROVENANCE_UNVERIFIED with no manifest and no receipt')
  const storedManifest = await dbRow(`SELECT receipt_count, manifest_sha256 FROM crg_validation_receipt_manifests WHERE validation_run_id = $1::uuid`, RV)
  const mine = independentManifest(rvReceipts)
  const reresolved = await prisma.$transaction(async (tx) => getCodingReleaseCheckOf(EV.id, tx))
  const reresolvedDecisions = reresolved.ok ? reresolved.value.items.map((item) => `${item.subjectId}:${item.decisionCode}`).sort() : []
  check(
    'CRG-070',
    'Run manifest deterministic and independently replayed',
    storedManifest.receipt_count === mine.count && storedManifest.manifest_sha256 === mine.sha256 && same(reresolvedDecisions, rvReceipts.map((r) => `${r.encounter_diagnosis_id ?? r.encounter_activity_id}:${r.decision_code}`).sort()),
    `this suite's own manifest of EV's ${mine.count} receipts equals the stored digest, and re-resolving EV with the pure resolver gives exactly the recorded decisions`,
  )

  // ---------------------------------------------------------------- 08 readiness and handoff (CRG-071–080)
  section('08 Readiness and handoff: V1 unchanged, V2 refuses other validators, exact receipts, V1 bytes, stale and tied recency, wrong encounter, owners preserved, no request-selected version, repeatable')
  const v1Handoff = await get(`/api/pre-claim-readiness-assessments/${H.assessmentId}/a6-handoff`)
  const V1_KEYS = ['schemaVersion', 'readinessAssessmentId', 'readinessPolicyVersion', 'readinessState', 'assessedAt', 'validationRun', 'findingSummary', 'findingRefs', 'exactReferences']
  const plantAssessment = (runIdOf: string, policy: string) =>
    rolledBack(async (tx) => {
      const [row] = await tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO pre_claim_readiness_assessments (id, validation_run_id, readiness_policy_version, state, assessed_at, created_by_user_id) VALUES (gen_random_uuid(), $1::uuid, $2, 'READY_FOR_REVIEW', now(), $3::uuid) RETURNING id::text AS id`,
        runIdOf, policy, creatorId,
      )
      return composeA6Handoff(row.id, tx)
    })
  const W = await claimThrough(EW, await readyRun(EW, 'A5-VAL-2'), false)
  const v1OverV2 = await plantAssessment(W.runId, 'A5-READY-1')
  check(
    'CRG-071',
    'PreClaimA6HandoffV1 still accepts only A5-VAL-1',
    v1Handoff.status === 200 && v1Handoff.body.schemaVersion === 'PreClaimA6HandoffV1' && v1Handoff.body.validationRun.validatorVersion === 'A5-VAL-1' && v1Handoff.body.readinessPolicyVersion === 'A5-READY-1' &&
      (v1OverV2.value as any)?.ok === false && (v1OverV2.value as any)?.code === 'READINESS_POLICY_INCOMPATIBLE',
    'a V1 assessment answers PreClaimA6HandoffV1 over A5-VAL-1; an A5-READY-1 assessment planted over an A5-VAL-2 run (rolled back) is refused',
  )
  const v2OverV1 = await plantAssessment(H.runId, 'A5-READY-2')
  const EU = await encounterAt(FNONE, '2026-06-15', [DX1])
  const unknownRun = await prisma.$transaction(async (tx) => {
    const r = await recordValidationRunInTransaction({ encounterId: EU.id, contextSnapshot: await contextOf(EU.id), validatorVersion: 'A5-VAL-9', findings: [synthetic('TECHNICAL', 'TECHNICAL_CONTEXT_VALID')] }, creatorId, tx)
    return r.ok ? r.value.id : ''
  })
  const unknownAssessed = await at(`/api/validation-runs/${unknownRun}/readiness-assessments`, {})
  check(
    'CRG-072',
    'V2 rejects unsupported validator versions',
    (v2OverV1.value as any)?.ok === false && (v2OverV1.value as any)?.code === 'READINESS_POLICY_INCOMPATIBLE' && unknownAssessed.status === 409 && errorCode(unknownAssessed.body) === 'READINESS_POLICY_INCOMPATIBLE',
    'an A5-READY-2 assessment over an A5-VAL-1 run is refused, and a run of an unknown validator (A5-VAL-9) gets no readiness policy at all',
  )
  const wReceipts = await receiptsOf(W.runId)
  const tampered = await rolledBack(async (tx) => {
    await off(tx)
    await tx.$executeRawUnsafe(`UPDATE crg_validation_code_receipts SET source_row_sha256 = $2 WHERE id = $1::uuid`, wReceipts.find((r) => r.membership_id)?.id, 'f'.repeat(64))
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin')
    return composeA6Handoff(W.assessmentId, tx)
  })
  check('CRG-073', 'V2 requires exact, complete receipts', (tampered.value as any)?.ok === false && (tampered.value as any)?.code === 'INTEGRITY_CONFLICT' && tampered.clean, 'a planted change to one recorded receipt (rolled back) makes the V2 handoff refuse: receipts are verified as recorded on the same snapshot')
  check('CRG-074', 'V1 handoff DTO unchanged', same(Object.keys(v1Handoff.body), V1_KEYS) && !('codingReceipts' in v1Handoff.body) && same(Object.keys(v1Handoff.body.validationRun), ['id', 'validatorVersion', 'evaluatedAt', 'encounterId', 'context']), 'the V1 handoff carries exactly its nine historical keys, no receipt section (the A5.9 suite\'s byte fixtures run in the nested chain)')
  const EX = await encounterAt(FMAIN, '2026-06-15', [DX1])
  const X1 = await readyRun(EX, 'A5-VAL-2')
  const x1Assessed = await at(`/api/validation-runs/${X1}/readiness-assessments`, {})
  const X2 = await readyRun(EX, 'A5-VAL-2')
  const stale = await get(`/api/pre-claim-readiness-assessments/${x1Assessed.body.id}/a6-handoff`)
  const x2Assessed = await at(`/api/validation-runs/${X2}/readiness-assessments`, {})
  check('CRG-075', 'V2 refuses a stale run basis', stale.status === 409 && errorCode(stale.body) === 'READINESS_SUPERSEDED_BY_NEWER_VALIDATION', 'after a newer A5-VAL-2 run of the same encounter, the earlier assessment no longer hands off')
  const tied = await rolledBack(async (tx) => {
    await off(tx)
    await tx.$executeRawUnsafe(
      `INSERT INTO validation_runs (id, encounter_id, service_date, facility_id, facility_regulatory_profile_id, payer_id, provider_contract_id, tariff_schedule_id, tariff_schedule_version_id, validator_version, evaluated_at, created_by_user_id, created_at)
       SELECT gen_random_uuid(), encounter_id, service_date, facility_id, facility_regulatory_profile_id, payer_id, provider_contract_id, tariff_schedule_id, tariff_schedule_version_id, validator_version, evaluated_at, created_by_user_id, created_at FROM validation_runs WHERE id = $1::uuid`,
      X2,
    )
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin')
    return composeA6Handoff(x2Assessed.body.id, tx)
  })
  check('CRG-076', 'V2 refuses tied recency', (tied.value as any)?.ok === false && (tied.value as any)?.code === 'VALIDATION_RUN_RECENCY_AMBIGUOUS' && tied.clean, 'a planted run of the same encounter at exactly the same evaluation and creation time (rolled back) makes the V2 handoff refuse as ambiguous')
  const wrongEncounter = await rolledBack(async (tx) => {
    await off(tx)
    await tx.$executeRawUnsafe(`UPDATE crg_validation_code_receipts SET encounter_id = $2::uuid WHERE id = $1::uuid`, wReceipts[0].id, EV.id)
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin')
    return composeA6Handoff(W.assessmentId, tx)
  })
  check('CRG-077', 'V2 refuses a wrong-encounter receipt', (wrongEncounter.value as any)?.ok === false && (wrongEncounter.value as any)?.code === 'INTEGRITY_CONFLICT' && wrongEncounter.clean, "a receipt planted under another encounter (rolled back) makes the V2 handoff refuse")
  const v2Handoff = await get(`/api/pre-claim-readiness-assessments/${W.assessmentId}/a6-handoff`)
  const v2Again = await get(`/api/pre-claim-readiness-assessments/${W.assessmentId}/a6-handoff`)
  const wFindings = await findingsOf(W.runId)
  const exactSet = (ids: (string | null)[]) => [...new Set(ids.filter((v): v is string => v !== null))].sort()
  check(
    'CRG-078',
    'V2 keeps eligibility, authorization, tariff owners',
    v2Handoff.status === 200 && same(Object.keys(v2Handoff.body), [...V1_KEYS, 'codingReceipts']) && same(v2Handoff.body.exactReferences.eligibilityVerificationIds, exactSet(wFindings.map((f) => f.eligibilityVerificationId))) &&
      same(v2Handoff.body.exactReferences.authorizationLineIds, exactSet(wFindings.map((f) => f.authorizationLineId))) && v2Handoff.body.validationRun.context.tariffScheduleVersionId === tariffVersion.id && v2Handoff.body.validationRun.context.providerContractId === contract.id,
    'the V2 handoff is every V1 field plus the receipt section; eligibility, authorization and tariff references are exactly the run\'s own, never re-decided by CRG',
  )
  const readinessBody = await at(`/api/validation-runs/${X2}/readiness-assessments`, { readinessPolicyVersion: 'A5-READY-1' })
  check(
    'CRG-079',
    'No request-selected validator or version',
    refusedBodies[3].status === 400 && readinessBody.status === 400 && rv.body.validatorVersion === 'A5-VAL-2' && rv1.body.validatorVersion === 'A5-VAL-1' && /selectValidatorForProfile\(encounter\.facilityRegulatoryProfileId, tx\)/.test(committedCode('backend/src/modules/pre-claim-validation/pre-claim-validation.service.ts')),
    "a validatorVersion in the execute body and a readinessPolicyVersion in the readiness body are refused (400); the validator is chosen only by the encounter's CRG scope (A5-VAL-2 in the ENABLED scope, A5-VAL-1 elsewhere)",
  )
  check('CRG-080', 'One bound handoff yields identical evidence', v2Again.status === 200 && withoutEvaluatedAt(v2Again.body) === withoutEvaluatedAt(v2Handoff.body) && v2Handoff.body.codingReceipts.receiptCount === wReceipts.length, 'the same V2 handoff read twice is byte-identical, with the same receipts and manifest')

  // ---------------------------------------------------------------- 09 A6 canonical and frozen (CRG-081–090)
  section('09 A6: A6-PAYLOAD-1 golden vectors, V2 binding and determinism, human approval, receipts verified under the lock, independent digest, history unchanged, the correction chain and its edition, legacy labels')
  const W1 = await claimThrough(EW1, await readyRun(EW1, 'A5-VAL-1'))
  const goldenUnit = run('node --test src/modules/claim-payload/claim-payload.validation.test.ts')
  const w1Freeze = await prisma.claimFreeze.findUniqueOrThrow({ where: { id: W1.submissionId as string } })
  check(
    'CRG-081',
    'A6-PAYLOAD-1 keeps its golden vectors',
    goldenUnit.ok && /✔ golden vector: exact bytes and SHA-256/.test(goldenUnit.output) && w1Freeze.payloadSchemaVersion === 'A6-PAYLOAD-1' && w1Freeze.submissionContractVersion === 'A6-SUBMISSION-1' && !Buffer.from(w1Freeze.canonicalPayloadBytes).toString("utf8").includes('"coding"'),
    'the A6.6 golden vector test passes unchanged, and a V1 claim still freezes A6-PAYLOAD-1 under A6-SUBMISSION-1 with no coding section',
  )
  const previewBody = { draftAssessmentId: W.draft.id, approvalDecisionId: W.approvalId }
  const preview1 = await at(`/api/claims/${W.claimId}/canonical-payload/preview`, previewBody)
  const preview2 = await at(`/api/claims/${W.claimId}/canonical-payload/preview`, previewBody)
  const coding = preview1.body?.payload?.coding
  check(
    'CRG-082',
    'V2 payload binds each target to its exact receipt',
    preview1.status === 200 && preview1.body.schemaVersion === 'A6-PAYLOAD-2' && coding?.diagnoses?.length === EW.diagnoses.length && coding?.lines?.length === EW.coded.length &&
      [...coding.diagnoses, ...coding.lines].every((entry: any) => wReceipts.some((r) => r.id === entry.receiptId && r.membership_id === entry.membershipId && r.reference_dataset_version_id === entry.referenceDatasetVersionId && r.source_row_sha256 === entry.sourceRowSha256)),
    "the A6-PAYLOAD-2 coding section binds each claim diagnosis and each procedure-coded line to exactly its recorded receipt (edition, membership, row hash); the service-only line carries none",
  )
  check('CRG-083', 'V2 payload deterministic across reads', preview2.status === 200 && preview2.body.previewDigestSha256 === preview1.body.previewDigestSha256 && preview1.body.byteLength === preview2.body.byteLength, 'two previews of the same approved draft give the same A6-PAYLOAD-2 digest and length (code order is the claim\'s own positions)')
  const noApproval = await at(`/api/claims/${W.claimId}/submissions`, { draftAssessmentId: W.draft.id, approvalDecisionId: MISSING })
  const otherApproval = await at(`/api/claims/${W.claimId}/submissions`, { draftAssessmentId: W.draft.id, approvalDecisionId: H.approvalId })
  check('CRG-084', 'Human approval still required before freeze', noApproval.status >= 400 && noApproval.status < 500 && otherApproval.status >= 400 && otherApproval.status < 500 && (await prisma.claimFreeze.count({ where: { claimId: W.claimId } })) === 0, 'a V2 freeze naming no approval or another claim\'s approval is refused; nothing is frozen')
  const underLock = await rolledBack(async (tx) => {
    await off(tx)
    await tx.$executeRawUnsafe(`UPDATE crg_validation_receipt_manifests SET manifest_sha256 = $2 WHERE validation_run_id = $1::uuid`, W.runId, 'e'.repeat(64))
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin')
    return composeCanonicalClaimPayload(W.claimId, W.draft.id, W.approvalId, tx)
  })
  const wFrozen = await at(`/api/claims/${W.claimId}/submissions`, previewBody)
  const wFreeze = wFrozen.status === 201 ? await prisma.claimFreeze.findUniqueOrThrow({ where: { id: wFrozen.body.submissionId } }) : null
  const submissionCode = committedCode('backend/src/modules/claim-submission/claim-submission.service.ts')
  const lockOk =
    (underLock.value as any)?.ok === false && ['STALE', 'INTEGRITY_CONFLICT'].includes((underLock.value as any)?.outcome) && underLock.clean && wFrozen.status === 201 && wFreeze?.submissionContractVersion === 'A6-SUBMISSION-2' &&
    wFreeze?.payloadSchemaVersion === 'A6-PAYLOAD-2' && submissionCode.indexOf('lockRowForUpdate') > -1 && submissionCode.indexOf('composeCanonicalClaimPayload(claimId') > submissionCode.indexOf('lockRowForUpdate')
  check('CRG-085', 'Freeze verifies complete receipts under the lock', lockOk, 'with one recorded manifest value planted (rolled back) the composer A6.7 runs under its Claim lock refuses; untouched, the V2 claim freezes as A6-SUBMISSION-2 over A6-PAYLOAD-2')
  const frozenCoding = wFreeze ? JSON.parse(Buffer.from(wFreeze.canonicalPayloadBytes).toString("utf8")).coding : null
  const wManifest = await dbRow(`SELECT receipt_count, manifest_sha256 FROM crg_validation_receipt_manifests WHERE validation_run_id = $1::uuid`, W.runId)
  check(
    'CRG-086',
    'V2 frozen bytes and manifest digest agree independently',
    !!wFreeze && sha256Of(wFreeze.canonicalPayloadBytes) === wFreeze.payloadSha256 && frozenCoding?.manifestSha256 === wManifest.manifest_sha256 && independentManifest(wReceipts).sha256 === wManifest.manifest_sha256,
    "the frozen bytes hash to the stored payload SHA-256; their coding section names the stored manifest digest, which this suite recomputes independently from the receipts",
  )
  // CRG-088/089: a 2026-12-31 service frozen under edition A; edition B (from 2027) is then activated; the claim is
  // corrected (revoke, a fresh draft and approval, freeze again) and linked through A6.9; a fresh validation still binds A.
  const K = await claimThrough(EK, await readyRun(EK, 'A5-VAL-2'))
  await activateLater(EB)
  const revoked = await post(`/api/claims/${K.claimId}/review-decisions`, { draftAssessmentId: K.draft.id, assemblyFingerprint: K.draft.assemblyFingerprint, decisionCode: 'REVOKE', referencedApprovalId: K.approvalId }, B.who)
  const draft2 = await at(`/api/claims/${K.claimId}/draft-assessments`, { pricingRunId: K.pricingRunId })
  const approve2 = await post(`/api/claims/${K.claimId}/review-decisions`, { draftAssessmentId: draft2.body.id, assemblyFingerprint: draft2.body.assemblyFingerprint, decisionCode: 'APPROVE' }, B.who)
  const freeze2 = await at(`/api/claims/${K.claimId}/submissions`, { draftAssessmentId: draft2.body.id, approvalDecisionId: approve2.body?.decision?.id })
  const link = await at(`/api/claims/${K.claimId}/correction-links`, { priorSubmissionId: K.submissionId, correctedSubmissionId: freeze2.body?.submissionId, reasonCode: 'CORRECTED_CODING' })
  const codingOf = async (submissionId: string) => JSON.parse(Buffer.from((await prisma.claimFreeze.findUniqueOrThrow({ where: { id: submissionId } })).canonicalPayloadBytes).toString("utf8")).coding
  const k1Coding = await codingOf(K.submissionId as string)
  const k2Coding = freeze2.status === 201 ? await codingOf(freeze2.body.submissionId) : null
  const fresh = await prisma.$transaction(async (tx) => getCodingReleaseCheckOf(EK.id, tx))
  check(
    'CRG-088',
    'A6.9 correction chain keeps reviewed, frozen editions',
    revoked.status === 201 && draft2.status === 201 && approve2.status === 201 && freeze2.status === 201 && link.status === 201 && k1Coding?.diagnoses?.[0]?.referenceDatasetVersionId === EA.versionId &&
      k2Coding?.diagnoses?.[0]?.referenceDatasetVersionId === EA.versionId,
    'the corrected V2 claim was independently reviewed and frozen again and linked through A6.9; both freezes bind the 2021 edition of their own receipts',
  )
  check(
    'CRG-089',
    'A corrected past service never adopts the new edition',
    fresh.ok && fresh.value.items.find((i) => i.subjectKind === 'DIAGNOSIS')?.edition?.referenceDatasetVersionId === EA.versionId && k2Coding?.diagnoses?.[0]?.referenceDatasetVersionId !== EB.versionId,
    'after the 2027 edition is activated, the 2026-12-31 correction and a fresh validation of that service both still resolve the 2021 edition by the original service date',
  )
  const legacyFreeze = await get(`/api/claim-submissions/${H.submissionId}/coding-provenance`)
  const v2Provenance = wFreeze ? await get(`/api/claim-submissions/${wFreeze.id}/coding-provenance`) : { status: 0, body: {} as any }
  check(
    'CRG-090',
    'Unproven old freeze labelled LEGACY_PROVENANCE_UNVERIFIED',
    legacyFreeze.status === 200 && legacyFreeze.body.verificationStatus === 'LEGACY_PROVENANCE_UNVERIFIED' && legacyFreeze.body.manifest === null && v2Provenance.status === 200 && v2Provenance.body.verificationStatus === 'VERIFIED_AS_RECORDED',
    'the historical A6-SUBMISSION-1 freeze reads LEGACY_PROVENANCE_UNVERIFIED (nothing backfilled); the V2 freeze reads VERIFIED_AS_RECORDED',
  )
  check('CRG-087', 'Historical A6.7 bytes/hash unchanged', (await historyHash()) === historyBefore, 'the historical V1 freeze frozen before any Checkpoint B write of this run is byte-identical after every import, activation, run and freeze')

  // ---------------------------------------------------------------- CRG-119 synthetic rollback
  const ED = await encounterAt(FDIS, '2026-06-15', [DX1])
  const D1 = await readyRun(ED, 'A5-VAL-2')
  const d1Before = await get(`/api/validation-runs/${D1}/coding-receipts`)
  await recordValidationScope({ jurisdictionCode: JUR, authorityCode: AUTH_D, scopeStatus: 'DISABLED', decisionReference: `synthetic rollback ${runId}` })
  const afterDisable = await execute(ED.id)
  const d1After = await get(`/api/validation-runs/${D1}/coding-receipts`)
  check(
    'CRG-119',
    'Rollback stops new V2 runs, keeps historical proof',
    d1Before.status === 200 && d1Before.body.verificationStatus === 'VERIFIED_AS_RECORDED' && afterDisable.status === 201 && afterDisable.body.validatorVersion === 'A5-VAL-1' && withoutEvaluatedAt(d1After.body) === withoutEvaluatedAt(d1Before.body),
    'after the synthetic scope is DISABLED new runs are A5-VAL-1 again, while the earlier A5-VAL-2 run and its receipts still read VERIFIED_AS_RECORDED, byte-identical (a REGULATORY scope instead SUSPENDS: B-G01)',
  )

  // ---------------------------------------------------------------- B-G01 no regulatory fallback (planted, rolled back)
  section('B-G01–B-G06: no regulatory fallback, one-to-one integrity I1–I6, verification as recorded H1–H5, A6.1–A6.9 compatibility, disclosed harness corrections')
  const REG = `ZZREG${runToken}`
  const FREG = await facilityFor('regulatory', REG)
  const EREG = await encounterAt(FREG, '2026-06-15', [DX1], [PCPT], 1)
  const KREG = await claimThrough(EREG, await readyRun(EREG, 'A5-VAL-1'))
  const plant = async (tx: DbClient, statuses: string[]) => {
    await tx.$executeRawUnsafe('ALTER TABLE crg_validation_scopes DROP CONSTRAINT crg_validation_scopes_checkpoint_b_chk')
    for (const [i, scopeStatus] of statuses.entries())
      await tx.$executeRawUnsafe(
        `INSERT INTO crg_validation_scopes (id, jurisdiction_code, authority_code, scope_class, sequence, validator_version, scope_status, decision_reference, contract_version) VALUES (gen_random_uuid(), $1, $2, 'REGULATORY', $3, 'A5-VAL-2', $4, 'planted', 'CRG-VALSCOPE-1')`,
        JUR, REG, i + 1, scopeStatus,
      )
  }
  const v1RunOn = async (tx: DbClient, built: Built, validatorVersion = 'A5-VAL-1') => {
    const r = await recordValidationRunInTransaction({ encounterId: built.id, contextSnapshot: await contextOf(built.id), validatorVersion, findings: [synthetic('TECHNICAL', 'TECHNICAL_CONTEXT_VALID')] }, creatorId, tx)
    if (!r.ok) throw new Error(`recorder refused: ${r.message}`)
  }
  const copyFreeze = async (tx: DbClient, submissionId: string, versions?: { submission: string; payload: string }) => {
    await tx.$executeRawUnsafe('ALTER TABLE claim_freezes DISABLE TRIGGER USER')
    await tx.$executeRawUnsafe('ALTER TABLE claim_freezes ENABLE TRIGGER crg_claim_freezes_scope_guard_trg')
    await tx.$executeRawUnsafe(
      `INSERT INTO claim_freezes (id, claim_id, draft_assessment_id, approval_review_event_id, pricing_run_id, submission_contract_version, payload_schema_version, approved_assembly_fingerprint, canonical_payload_bytes, payload_sha256, frozen_at, created_by_user_id, created_at)
       SELECT gen_random_uuid(), claim_id, draft_assessment_id, gen_random_uuid(), pricing_run_id, $2, $3, approved_assembly_fingerprint, canonical_payload_bytes, payload_sha256, frozen_at, created_by_user_id, created_at FROM claim_freezes WHERE id = $1::uuid`,
      submissionId, versions?.submission ?? 'A6-SUBMISSION-1', versions?.payload ?? 'A6-PAYLOAD-1',
    )
  }
  const regulatory = {
    v1Run: await rolledBack(async (tx) => {
      await plant(tx, ['ENABLED'])
      await v1RunOn(tx, EREG)
    }),
    disabled: await rolledBack((tx) => plant(tx, ['ENABLED', 'DISABLED'])),
    firstSuspended: await rolledBack((tx) => plant(tx, ['SUSPENDED'])),
    suspendedRun: await rolledBack(async (tx) => {
      await plant(tx, ['ENABLED', 'SUSPENDED'])
      await v1RunOn(tx, EREG, 'A5-VAL-2')
    }),
    v1Freeze: await rolledBack(async (tx) => {
      await plant(tx, ['ENABLED'])
      await copyFreeze(tx, KREG.submissionId as string)
    }),
    suspendedFreeze: await rolledBack(async (tx) => {
      await plant(tx, ['ENABLED', 'SUSPENDED'])
      await copyFreeze(tx, KREG.submissionId as string, { submission: 'A6-SUBMISSION-2', payload: 'A6-PAYLOAD-2' })
    }),
    realAsSynthetic: await rolledBack((tx) =>
      tx.$executeRawUnsafe(`INSERT INTO crg_validation_scopes (id, jurisdiction_code, authority_code, scope_class, sequence, validator_version, scope_status, decision_reference, contract_version) VALUES (gen_random_uuid(), 'AE-DU', 'DHA', 'SYNTHETIC', 1, 'A5-VAL-2', 'ENABLED', 'x', 'CRG-VALSCOPE-1')`),
    ),
    checkpointB: await rolledBack((tx) =>
      tx.$executeRawUnsafe(`INSERT INTO crg_validation_scopes (id, jurisdiction_code, authority_code, scope_class, sequence, validator_version, scope_status, decision_reference, contract_version) VALUES (gen_random_uuid(), 'AE-DU', $1, 'REGULATORY', 1, 'A5-VAL-2', 'ENABLED', 'x', 'CRG-VALSCOPE-1')`, REG),
    ),
    selection: await rolledBack(async (tx) => {
      await plant(tx, ['ENABLED', 'SUSPENDED'])
      const { selectValidatorForProfile } = await import('../../modules/coding-validation/coding-validation.service.ts')
      const profileId = (await tx.encounter.findUniqueOrThrow({ where: { id: EREG.id }, select: { facilityRegulatoryProfileId: true } })).facilityRegulatoryProfileId
      return selectValidatorForProfile(profileId, tx)
    }),
  }
  check(
    'B-G01',
    'No regulatory scope falls back to A5-VAL-1',
    refusedBy(regulatory.v1Run, /crg_validation_scope: a REGULATORY coding scope accepts only A5-VAL-2/) && refusedBy(regulatory.disabled, /crg_validation_scopes_status_chk/) && refusedBy(regulatory.firstSuspended, /crg_validation_scope_one_way/) &&
      refusedBy(regulatory.suspendedRun, /crg_validation_scope/) && refusedBy(regulatory.v1Freeze, /crg_freeze_scope: a REGULATORY coding scope accepts only A6-SUBMISSION-2/) && refusedBy(regulatory.suspendedFreeze, /crg_freeze_(scope|version)/) &&
      refusedBy(regulatory.realAsSynthetic, /crg_validation_scopes_class_chk/) && refusedBy(regulatory.checkpointB, /crg_validation_scopes_checkpoint_b_chk/) && same(regulatory.selection.value, { suspended: true }) &&
      Object.values(regulatory).every((r) => r.clean) && (await prisma.crgValidationScope.count({ where: { scopeClass: 'REGULATORY' } })) === 0,
    'with a REGULATORY decision planted (rolled back): a direct A5-VAL-1 run and an A6-SUBMISSION-1 freeze are refused by the database guards, DISABLED and a SUSPENDED start are refused, SUSPENDED selects no run and blocks freezes; a real authority cannot be SYNTHETIC; Checkpoint B refuses any REGULATORY row; none exists',
  )
  const integrity = {
    I1: await forged(EW, (rows) => rows.map((r, i) => (i === 0 ? { ...r, encounter_id: EV.id } : r))),
    I2: await forged(EW, (rows) => rows.map((r) => (r.subject_kind === 'DIAGNOSIS' ? { ...r, master_code_id: DX9 } : r))),
    I3: await forged(EW, (rows) => (rows.length > 1 ? [{ ...rows[0], validation_finding_id: rows[1].validation_finding_id }, { ...rows[1], validation_finding_id: rows[0].validation_finding_id }, ...rows.slice(2)] : rows)),
    I4missing: incomplete,
    I4extra: await forged(EW, (rows) => rows, { technical: false }),
    I5: await forged(EW, (rows) => rows.map((r) => (r.membership_id ? { ...r, source_row_sha256: 'd'.repeat(64) } : r))),
    I6: await forged(EW, (rows) => rows, { manifest: 'wrong' }),
    noManifest: await forged(EW, (rows) => rows, { manifest: 'none' }),
  }
  check(
    'B-G02',
    'One-to-one receipt integrity I1–I6 at commit',
    refusedBy(integrity.I1, /crg_receipt_integrity: I1/) && refusedBy(integrity.I2, /crg_receipt_integrity: I2/) && refusedBy(integrity.I3, /crg_receipt_integrity: I3/) && refusedBy(integrity.I4missing, /crg_receipt_integrity: I4/) &&
      refusedBy(integrity.I4extra, /crg_receipt_integrity: I4 a receipt names a target that is not required/) && refusedBy(integrity.I5, /crg_receipt_integrity: I5/) && refusedBy(integrity.I6, /crg_receipt_integrity: I6/) &&
      refusedBy(integrity.noManifest, /commits only with its receipt manifest/) && Object.values(integrity).every((r) => r.clean) && valid.message.includes(NOT_COMMITTED),
    'forged runs (rolled back) are refused at commit for: a receipt of another encounter (I1), a wrong master (I2), swapped findings (I3), a missing receipt and a receipt for a non-required target (I4), a tampered row hash (I5), a wrong digest with valid rows (I6) and no manifest; the unmodified run passes',
  )
  // B-G03: later changes to rights, editions, targets and masters change no historical answer; tampering does.
  const wFreezeId = wFreeze?.id ?? MISSING
  const historicalBefore = { receipts: withoutEvaluatedAt((await get(`/api/validation-runs/${W.runId}/coding-receipts`)).body), provenance: withoutEvaluatedAt((await get(`/api/claim-submissions/${wFreezeId}/coding-provenance`)).body) }
  await rights(AUTH, 'ICD-10-CM', 'BLOCKED')
  const removedTarget = await at(`/api/encounter-diagnoses/${EW.diagnoses[0]}/remove`, {})
  const renamed = await api('PATCH', `/api/diagnosis-codes/${DX1}`, { displayName: `${runId} renamed diagnosis` })
  const historicalAfter = { receipts: withoutEvaluatedAt((await get(`/api/validation-runs/${W.runId}/coding-receipts`)).body), provenance: withoutEvaluatedAt((await get(`/api/claim-submissions/${wFreezeId}/coding-provenance`)).body) }
  const tamper = async (sql: string, params: unknown[], read: 'run' | 'freeze') =>
    rolledBack(async (tx) => {
      await off(tx)
      await tx.$executeRawUnsafe(sql, ...params)
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin')
      return read === 'run' ? getRunCodingReceiptsOf(W.runId, tx) : getSubmissionCodingProvenanceOf(wFreezeId, tx)
    })
  const wApplicable = wReceipts.find((r) => r.membership_id)
  const historicalTamper = {
    H1: await tamper(`UPDATE crg_validation_receipt_manifests SET manifest_sha256 = $2 WHERE validation_run_id = $1::uuid`, [W.runId, 'a'.repeat(64)], 'run'),
    // H2 — the finding a receipt explains no longer carries the mapped code (the receipt itself, and so the manifest, unchanged).
    H2: await tamper(`UPDATE validation_findings SET finding_code = 'CODING_RELEASE_CONFLICTING' WHERE id = $1::uuid`, [wReceipts[0].validation_finding_id], 'run'),
    H3: await tamper(`UPDATE crg_release_code_memberships SET source_row_sha256 = $2 WHERE id = $1::uuid`, [wApplicable?.membership_id, 'b'.repeat(64)], 'run'),
    H4: await tamper(`UPDATE crg_validation_code_receipts SET service_date = DATE '2026-01-01' WHERE validation_run_id = $1::uuid`, [W.runId], 'run'),
    H5: await tamper(`UPDATE claim_freezes SET canonical_payload_bytes = canonical_payload_bytes || '\\x20'::bytea WHERE id = $1::uuid`, [wFreezeId], 'freeze'),
  }
  check(
    'B-G03',
    'Historical evidence verified as recorded only',
    removedTarget.status === 200 && renamed.status === 200 && historicalAfter.receipts === historicalBefore.receipts && historicalAfter.provenance === historicalBefore.provenance &&
      JSON.parse(historicalBefore.provenance).verificationStatus === 'VERIFIED_AS_RECORDED' &&
      Object.entries(historicalTamper).every(([h, r]) => (r.value as any)?.ok === false && (r.value as any)?.code === 'CODING_RECEIPT_INTEGRITY_CONFLICT' && new RegExp(`^${h}:`).test((r.value as any)?.message ?? '') && r.clean),
    'after the rights were BLOCKED, the 2027 edition activated, a coded target removed and the A2 master renamed, both historical reads are byte-identical (VERIFIED_AS_RECORDED); one planted tamper per H1–H5 (rolled back) answers CODING_RECEIPT_INTEGRITY_CONFLICT',
  )
  const pricingOf = async (pricingRunId: string) => {
    const total = await dbRow(`SELECT total_extended_amount::text AS t, overall_result AS r FROM claim_pricing_runs WHERE id = $1::uuid`, pricingRunId)
    const lines = await prisma.$queryRawUnsafe<{ a: string; u: string }[]>(`SELECT extended_amount::text AS a, unit_tariff_amount::text AS u FROM claim_pricing_line_results WHERE pricing_run_id = $1::uuid ORDER BY line_sequence_at_evaluation`, pricingRunId)
    return JSON.stringify({ total, lines })
  }
  const lifecycle = wFreeze ? await at(`/api/claim-submissions/${wFreeze.id}/lifecycle-events`, { eventCode: 'AUTHORIZE_RELEASE', reasonCode: null }) : { status: 0, body: null }
  const mixedVersion = await rolledBack((tx) => copyFreeze(tx, W1.submissionId as string, { submission: 'A6-SUBMISSION-2', payload: 'A6-PAYLOAD-2' }))
  check(
    'B-G05',
    'A6.1–A6.9 V2 compatibility matrix',
    (await pricingOf(W.pricingRunId)) === (await pricingOf(W1.pricingRunId)) && W.lines.length === EW.activities.length && W.claimDiagnoses.length === EW.diagnoses.length && W.draft.id.length === 36 &&
      noApproval.status >= 400 && lifecycle.status === 201 && link.status === 201 && refusedBy(mixedVersion, /crg_freeze_version/) && mixedVersion.clean && goldenUnit.ok &&
      (await prisma.claim.findUniqueOrThrow({ where: { id: W.claimId } })).handoffSchemaVersion === 'PreClaimA6HandoffV2',
    'A6.1 stores the V2 handoff; A6.2 lines and diagnoses and A6.3 pricing of the V2 claim equal its V1 twin exactly; A6.4 is REVIEWABLE; A6.5 approval is required; A6.6/A6.7 freeze V2; an A6.8 lifecycle event and an A6.9 correction succeed on V2; a V1 claim cannot take a V2 freeze; the V1 golden vectors hold',
  )
  const correctionsDoc = committedText(CORRECTIONS_DOC)
  // Bounded diff: over this package's own range a corrected suite changes only its stand-in literal A5-VAL-2 -> A5-VAL-9.
  const boundedStandIn = (path: string) => {
    const lines = gitArgs(['diff', '-U0', ownRange, '--', `:/${path}`]).split(/\r?\n/).filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l))
    const removed = lines.filter((l) => l.startsWith('-')).map((l) => l.slice(1))
    const added = lines.filter((l) => l.startsWith('+')).map((l) => l.slice(1))
    return removed.length > 0 && removed.length === added.length && removed.every((l, i) => l.includes('A5-VAL-2') && added[i] === l.split('A5-VAL-2').join('A5-VAL-9'))
  }
  // The original assertions still detect the prohibited behaviour: an unknown validator's run is refused by A5.9
  // (CRG-072 recorded one under A5-VAL-9), and an A5-READY-1 assessment over it has no handoff, so A6.1 refuses the Claim.
  const readyOneOverUnknown = await plantAssessment(unknownRun, 'A5-READY-1')
  const unknownRefused = unknownAssessed.status === 409 && errorCode(unknownAssessed.body) === 'READINESS_POLICY_INCOMPATIBLE'
  const claimRefused = (readyOneOverUnknown.value as any)?.ok === false && (readyOneOverUnknown.value as any)?.code === 'READINESS_POLICY_INCOMPATIBLE' && readyOneOverUnknown.clean
  // The corrections the clone proof found (design freeze 1.2 §12). Each is judged over this package's own range: only
  // the stated code lines changed (comments aside), the corrected predicate itself is evaluated, and it still refuses the
  // prohibited case.
  const codeLinesChanged = (path: string) => {
    const lines = gitArgs(['diff', '-U0', ownRange, '--', `:/${path}`]).split(/\r?\n/).filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l))
    const body = (sign: string) => lines.filter((l) => l.startsWith(sign)).map((l) => l.slice(1)).filter((l) => l.trim() !== '' && !l.trim().startsWith('//'))
    return { removed: body('-'), added: body('+') }
  }
  const committedLines = (path: string) => committedText(path).split(/\r?\n/)
  const committedFilesOf = (dir: string) => gitArgs(['ls-tree', '-r', '--name-only', '--full-tree', 'HEAD', `${dir}/`]).split(/\r?\n/).filter((file) => file !== '' && !file.endsWith('.test.ts'))
  // 1. The A7 cash-receipt boundaries: the accepted later-phase table rule (tables created by migrations committed after
  //    the suite's own merge, from git, never by name). Both CRG receipt tables are coding evidence with no money column.
  const LATER_PHASE_FILTER = '.filter((t) => !laterPhaseTables.has(t))'
  const RECEIPT_TABLES = ['crg_validation_code_receipts', 'crg_validation_receipt_manifests']
  const RECEIPT_SUITES = [
    { path: CORRECTED_HARNESSES[3], branchConst: 'a72Branch', branchName: 'feature/a7-2-evidence-classification', query: 'settleTables' },
    { path: CORRECTED_HARNESSES[4], branchConst: 'a73Branch', branchName: 'feature/a7-3-adjudication-evidence-readiness', query: 'ledgerTables' },
    { path: CORRECTED_HARNESSES[5], branchConst: 'a74Branch', branchName: 'feature/a7-4-revenue-evidence-case-assembly', query: 'ledgerTables' },
    { path: CORRECTED_HARNESSES[6], branchConst: 'a75Branch', branchName: 'feature/a7-5-case-closure-prerequisite-assessment', query: 'ledgerTables' },
    { path: CORRECTED_HARNESSES[7], branchConst: 'a76Branch', branchName: 'feature/a7-6-closure-basis-trace', query: 'ledgerTables' },
    { path: CORRECTED_HARNESSES[8], branchConst: 'a78Branch', branchName: a78Branch, query: 'ledgerTables' },
    { path: CORRECTED_HARNESSES[9], branchConst: 'a79Branch', branchName: a79Branch, query: 'ledgerTables' },
  ]
  const createdAfter = (merge: string) =>
    migrationDirsAt('HEAD').filter((dir) => !migrationDirsAt(merge).includes(dir)).flatMap((dir) => [...committedText(`${dir}/migration.sql`).matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1]))
  const receiptReviews = await Promise.all(
    RECEIPT_SUITES.map(async (suite) => {
      const lines = committedLines(suite.path)
      const { removed, added } = codeLinesChanged(suite.path)
      const queryNow = lines.find((l) => l.startsWith(`  const ${suite.query} = (await prisma.$queryRaw`)) ?? ''
      const original = queryNow.endsWith(LATER_PHASE_FILTER) ? queryNow.slice(0, -LATER_PHASE_FILTER.length) : ''
      const definition = lines.find((l) => l.startsWith('  const laterPhaseTables = new Set(ownMerge ? ')) ?? ''
      const moved = removed.length === 2
      const bounded =
        original !== '' && definition !== '' && lines.indexOf(definition) < lines.indexOf(queryNow) &&
        (moved ? same([...removed].sort(), [original, definition].sort()) && same([...added].sort(), [definition, queryNow].sort()) : same(removed, [original]) && same(added, [queryNow]))
      const pattern = (original.match(/table_name ~\* '(\([^']*\))'/) ?? [])[1] ?? ''
      const merge = mergeOf(suite.branchName)
      const later = new Set(merge ? createdAfter(merge) : [])
      const live = (await prisma.$queryRawUnsafe<{ t: string }[]>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* $1 ORDER BY 1`, pattern)).map((r) => r.t)
      const ownBranchForm = committedText(suite.path).includes(`const ownMerge = branch === ${suite.branchConst} ? '' : mergeOf(${suite.branchConst})`)
      return { suite, bounded, pattern, merge, later, excluded: live.filter((t) => later.has(t)), stillJudged: live.filter((t) => !later.has(t)), ownBranchForm }
    }),
  )
  const receiptMoneyColumns = (
    await prisma.$queryRawUnsafe<{ c: string }[]>(
      `SELECT table_name || '.' || column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1::text[]) AND column_name ~* '(balance|amount|currency|payment|paid|price|fee|cash|settle|ledger|posting)'`,
      RECEIPT_TABLES,
    )
  ).map((r) => r.c)
  const receiptProbe = `cash_receipt_probe_${runToken}`
  const receiptProbed = await rolledBack(async (tx) => {
    await tx.$executeRawUnsafe(`CREATE TABLE "${receiptProbe}" (id integer)`)
    return Promise.all(
      receiptReviews.map(async (r) => (await tx.$queryRawUnsafe<{ t: string }[]>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* $1`, r.pattern)).map((x) => x.t).filter((t) => !r.later.has(t)).includes(receiptProbe)),
    )
  })
  const receiptProbeGone = (await prisma.$queryRawUnsafe<{ t: string }[]>(`SELECT table_name AS t FROM information_schema.tables WHERE table_name = $1`, receiptProbe)).length === 0
  const receiptCorrected = (index: number) => {
    const r = receiptReviews[index]
    return (
      r.bounded && /receipt/.test(r.pattern) && r.merge.length === 40 && r.ownBranchForm && same(r.excluded, RECEIPT_TABLES) && r.stillJudged.length === 0 && RECEIPT_TABLES.every((t) => r.later.has(t)) &&
      receiptMoneyColumns.length === 0 && (receiptProbed.value ?? [])[index] === true && receiptProbed.clean && receiptProbeGone
    )
  }
  // 2. A6.7–A6.9 T009: the owner term over the package's own range, in exactly the accepted A7.1–A7.9 T009 form.
  const OWNER_SUITES = [
    { path: CORRECTED_HARNESSES[10], branchConst: 'a67Branch', branchName: 'feature/a6-7-immutable-claim-submission-evidence' },
    { path: CORRECTED_HARNESSES[11], branchConst: 'a68Branch', branchName: 'feature/a6-8-claim-lifecycle-transition-governance' },
    { path: CORRECTED_HARNESSES[12], branchConst: 'a69Branch', branchName: 'feature/a6-9-correction-resubmission-lineage' },
  ]
  const ownRangeLines = (branchConst: string) => [
    `  const ownMerge = branch === ${branchConst} ? '' : mergeOf(${branchConst})`,
    "  const ownRange = ownMerge ? `${ownMerge}^1..${ownMerge}` : 'origin/main...HEAD'",
    "  const ownChangedPaths = gitArgs(['diff', '--name-only', ownRange]).split(/\\r?\\n/).filter(Boolean)",
    '  const ownOwnerChanged = ownChangedPaths.filter((file) => OWNER_DIRS.some((dir) => file.startsWith(`${dir}/`)))',
  ]
  const crgbChangedPaths = gitArgs(['diff', '--name-only', ownRange]).split(/\r?\n/).filter(Boolean)
  const ownerCorrected = (index: number) => {
    const suite = OWNER_SUITES[index - 10]
    const text = committedText(suite.path)
    const { removed, added } = codeLinesChanged(suite.path)
    const bounded = removed.length === 2 && removed.every((l) => /\bownerChanged\b/.test(l)) && same(added, [...ownRangeLines(suite.branchConst), ...removed.map((l) => l.replace(/\bownerChanged\b/g, 'ownOwnerChanged'))])
    const ownerDirs = [...((text.match(/^const OWNER_DIRS = \[([\s\S]*?)^\]/m) ?? [])[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])
    const expression = ((text.split(/\r?\n/).find((l) => l.startsWith('  const ownOwnerChanged = ')) ?? '').match(/^ {2}const ownOwnerChanged = (.*)$/) ?? [])[1] ?? 'null'
    const corrected = new Function('ownChangedPaths', 'OWNER_DIRS', `return ${expression}`) as (paths: string[], dirs: string[]) => string[]
    const merge = mergeOf(suite.branchName)
    const ownPaths = merge ? gitArgs(['diff', '--name-only', `${merge}^1..${merge}`]).split(/\r?\n/).filter(Boolean) : []
    // The prohibited case: a range that changes A5/A6 owner modules (Checkpoint B's own diff) is still caught.
    const caught = corrected(crgbChangedPaths, ownerDirs)
    return bounded && ownerDirs.length >= 10 && merge.length === 40 && ownPaths.length > 0 && corrected(ownPaths, ownerDirs).length === 0 && caught.length > 0 && caught.includes('backend/src/modules/claim-line/claim-line.service.ts')
  }
  // 3. The A5.8 and A6.6 scan-reach guards: the exact original count, or that count plus the one named Checkpoint B file.
  const REACH_SUITES = [
    { path: CORRECTED_HARNESSES[13], dirConst: 'MODULE_DIR', dir: 'backend/src/modules/pre-claim-validation', codeVar: 'moduleCode', count: 10, addedFile: 'pre-claim-validation.coding-release.ts', scan: /FOR UPDATE|lockRowForUpdate|SELECT .* FOR /i, inject: '\nconst probe = `SELECT id FROM encounters FOR UPDATE`\n' },
    { path: CORRECTED_HARNESSES[14], dirConst: 'PAYLOAD_DIR', dir: 'backend/src/modules/claim-payload', codeVar: 'payloadCode', count: 5, addedFile: 'claim-payload.v2.ts', scan: /\.times\(|\.plus\(|\.mul\(/, inject: '\nconst probe = amount.times(2)\n' },
  ]
  const reachCorrected = (index: number) => {
    const suite = REACH_SUITES[index - 13]
    const { removed, added } = codeLinesChanged(suite.path)
    const original = removed[0] ?? ''
    const countTerm = `${suite.codeVar}.files.length === ${suite.count}`
    const expected = original.replace(countTerm, `(${countTerm} || (${suite.codeVar}.files.length === ${suite.count + 1} && ${suite.codeVar}.files.includes(\`\${${suite.dirConst}}/${suite.addedFile}\`)))`)
    const bounded = removed.length === 1 && original.startsWith('  const reached = ') && original.includes(countTerm) && same(added, [expected])
    const corrected = new Function(suite.codeVar, suite.dirConst, `return ${expected.replace(/^ {2}const reached = /, '')}`) as (code: { files: string[]; code: string }, dir: string) => boolean
    const files = committedFilesOf(suite.dir)
    const code = files.map((file) => committedCode(file)).join('\n')
    const exact = `${suite.dir}/${suite.addedFile}`
    const originalFiles = files.filter((file) => file !== exact)
    const reachesNow = corrected({ files, code }, suite.dir)
    const reachesOriginal = corrected({ files: originalFiles, code }, suite.dir)
    const refusesUnknownExtra = !corrected({ files: [...files, `${suite.dir}/unreviewed-extra.ts`], code }, suite.dir)
    const refusesOtherName = !corrected({ files: [...originalFiles, `${suite.dir}/another-file.ts`], code }, suite.dir)
    const scanStillDetects = committedText(suite.path).includes(suite.scan.source) && !suite.scan.test(code) && suite.scan.test(`${code}${suite.inject}`) && code.includes(committedCode(exact).trim().split('\n')[0])
    return bounded && files.length === suite.count + 1 && originalFiles.length === suite.count && reachesNow && reachesOriginal && refusesUnknownExtra && refusesOtherName && scanStillDetects
  }
  const negativeTests: Record<string, () => Promise<boolean>> = {
    [CORRECTED_HARNESSES[0]]: async () => boundedStandIn(CORRECTED_HARNESSES[0]) && unknownRefused,
    [CORRECTED_HARNESSES[1]]: async () => boundedStandIn(CORRECTED_HARNESSES[1]) && unknownRefused,
    [CORRECTED_HARNESSES[2]]: async () => boundedStandIn(CORRECTED_HARNESSES[2]) && claimRefused,
    ...Object.fromEntries(RECEIPT_SUITES.map((suite, i) => [suite.path, async () => receiptCorrected(i)])),
    ...Object.fromEntries(OWNER_SUITES.map((suite, i) => [suite.path, async () => ownerCorrected(10 + i)])),
    ...Object.fromEntries(REACH_SUITES.map((suite, i) => [suite.path, async () => reachCorrected(13 + i)])),
  }
  const negativeResults = await Promise.all(CORRECTED_HARNESSES.map(async (path) => (negativeTests[path] ? negativeTests[path]() : false)))
  check(
    'B-G06',
    'Each harness correction keeps its V1 assertion, has a negative test',
    CORRECTED_HARNESSES.every((path) => correctionsDoc.includes(path)) && negativeResults.every(Boolean) && changedPaths.filter((p) => p.startsWith('backend/src/integration/') && !p.startsWith(`${HARNESS_DIR}/`)).every((p) => CORRECTED_HARNESSES.includes(p)),
    `${CORRECTED_HARNESSES.length} disclosed correction(s), each listed in ${CORRECTIONS_DOC} with its negative test passing in this run; no other earlier suite changed`,
  )

  // ---------------------------------------------------------------- nested regressions (CRG-123–125)
  section('Cumulative regressions — the Checkpoint A suite (nesting A8.3 -> … -> A1) and the A8.5 suite (nesting A8.3 -> … -> A1)')
  await apiReady('the nested regression chains')
  const goldenNow = async () => ({ receipts: withoutEvaluatedAt((await get(`/api/validation-runs/${RV}/coding-receipts`)).body), provenance: withoutEvaluatedAt((await get(`/api/claim-submissions/${wFreezeId}/coding-provenance`)).body) })
  const goldenBefore = await goldenNow()
  const chainStartedAt = new Date()
  const crgAChain = run('npm run test:crg-01:coding-release')
  writeFileSync(`crgb-nested-crga-${runId}.log`, crgAChain.output)
  await waitFor(databaseUp, 90_000)
  await apiReady('the A8.5 chain')
  const a85Chain = run('npm run test:a8:exception-remediation')
  writeFileSync(`crgb-nested-a85-${runId}.log`, a85Chain.output)
  await waitFor(databaseUp, 90_000)
  await apiReady('the checks after the regression chains')
  const crgARows = suiteLines(crgAChain.output, 'CRG-01', /^CRG-\d{3}$|^CRG-G\d{2}$/)
  const a85Rows = suiteLines(a85Chain.output, 'A8.5', /^T\d{3}(\/T\d{3})?$/)
  const crgAFailing = crgARows.filter((r) => r.verdict === 'FAIL').map((r) => r.id)
  const a85Failing = a85Rows.filter((r) => r.verdict === 'FAIL').map((r) => r.id)
  // Each suite asserts facts about its own branch (name, tracking, allowed paths, pushed HEAD, its own two runs); on
  // Checkpoint B those statements are obsolete by design. Every other check is substantive. Filled and proven from the
  // clone proof; never a substantive check.
  const crgANonApplicable: Record<string, string> = {
    'CRG-001': "Checkpoint A 'CRG v1 superseded; no dual authority' also requires its own branch name (fix/crg-01-final-coding-release); every other term (the register's supersession, no coding_release% table, no v1 name in its module or migration) is re-judged here",
    'CRG-002': "Checkpoint A 'Clean main ancestry, feature branch and origin parity' requires tracking origin/fix/crg-01-…; THIS branch's base, ancestry, clean tree and parity are proved by CRGB-G01 and CRG-127",
    'CRG-003': "Checkpoint A 'No unrelated A8/A9 product paths changed' lists the paths Checkpoint A was allowed to change; Checkpoint B legitimately changes its own disclosed paths (CRGB-G05)",
    'CRG-127': "Checkpoint A 'Git diff allowlist, origin parity and SHA evidence' compares HEAD with origin/fix/crg-01-…; THIS branch's allowlist, parity and migration checksums are proved by CRGB-G05 and CRG-127",
    'CRG-121': "Checkpoint A 'completed twice at one exact HEAD' is the identity of Checkpoint A's own two submitted runs; THIS run's identity is CRG-122",
    'CRG-124': "Checkpoint A 'No substantive failed nested test marked N/A' proves A8.3's branch-only causes against the Checkpoint A branch; here every one is re-proved on this branch, down to A7.9",
  }
  const a85NonApplicable: Record<string, string> = {
    T001: "A8.5 'A8.3 accepted merge is ancestor; clean main base' requires A8.5's own base (main c8ebf2c); Checkpoint B is cut from main 0f8f9d3, which contains A8.5 and Checkpoint A (CRGB-G01)",
    T003: "A8.5 'Correct branch from main; clean tracked tree' requires the A8.5 feature branch; THIS branch's clean tree and parity are proved by CRG-127",
    T010: "A8.5 'Diff allowlist excludes CRG/A9/later domains' lists the paths A8.5 was allowed to change; Checkpoint B legitimately changes its own disclosed paths (CRGB-G05)",
    T110: "A8.5 'Every branch-only N/A justified; none substantive' proves A8.3's branch-only causes against the A8.5 branch; here every one is re-proved on this branch, down to A7.9",
    T127: "A8.5 'Final clean git status and origin parity' compares HEAD with origin/feature/a8-5-…; THIS branch's parity is proved by CRG-127",
    T129: "A8.5 'Independent run at the same exact HEAD' is the identity of A8.5's own two submitted runs; THIS run's identity is CRG-122",
  }
  // Each documented cause is proved independently on this branch from the failing line itself and this branch's state:
  // the line names THIS branch with a clean tree and exact origin parity, or its non-branch terms are re-judged here.
  const lineOf = (rows: SuiteLine[], id: string) => rows.find((r) => r.id === id && r.verdict === 'FAIL')?.line ?? ''
  const thisBranchClean = (line: string) => line.includes(`## ${crgbBranch}...origin/${crgbBranch}`) && !/ahead|behind/.test(line.split(`## ${crgbBranch}...origin/${crgbBranch}`)[1]?.split(';')[0] ?? 'ahead')
  const crgACodeNow = committedFilesOf('backend/src/modules/coding-release').map((file) => committedCode(file)).join('\n') + committedText('backend/prisma/migrations/20261104090000_crg_01_final_coding_release/migration.sql')
  const crgARegisterNow = committedText('docs/CRG-01_Coding_Release_Governance.md')
  const v1TablesNow = (await prisma.$queryRawUnsafe<{ t: string }[]>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'coding\\_release%'`)).length
  const headSha = git('rev-parse HEAD')
  // Checkpoint A CRG-124 and A8.5 T110 judge the nested A8.3 branch-only items against their own branch, as A8.3 T119
  // judges A8.2's (the accepted pattern). Each item at every depth is re-proved here from its own line and this branch's
  // state, down to A7.9 T120's A7.8 items. A depth may fail only with its documented branch-only items, each exactly once;
  // every item its aggregator names must fail at the next depth (an aggregator omits the items it proved itself), and
  // every failure at that depth is re-proved here whether named or not.
  const NESTED_BRANCH_ONLY: { tag: string; aggregator: string; ids: string[] }[] = [
    { tag: 'A8.3', aggregator: 'T119', ids: ['T001', 'T002', 'T010', 'T119', 'T130'] },
    { tag: 'A8.2', aggregator: 'T120', ids: ['T001', 'T002', 'T010', 'T120', 'T130'] },
    { tag: 'A8.1', aggregator: 'T110', ids: ['T001', 'T002', 'T010', 'T110', 'T130'] },
    { tag: 'A7.10', aggregator: 'T111', ids: ['T001', 'T002', 'T010', 'T111', 'T122', 'T123', 'T130'] },
    { tag: 'A7.9', aggregator: 'T120', ids: ['T001', 'T002', 'T010', 'T120', 'T130'] },
  ]
  const A78_BRANCH_ONLY = ['T001', 'T002', 'T010', 'T120', 'T130']
  const escapeTag = (tag: string) => tag.replace(/[.-]/g, (c) => `\\${c}`)
  const nestedFails = (output: string, outer: string, depth: number) => {
    const pattern = new RegExp(`^\\[${escapeTag(outer)}\\] +${NESTED_BRANCH_ONLY.slice(0, depth + 1).map((d) => `nested: \\[${escapeTag(d.tag)}\\] +`).join('')}(T\\d{3}) .* \\.{3,} FAIL - (.*)$`)
    return output.split(/\r?\n/).map((line) => line.match(pattern)).filter((m): m is RegExpMatchArray => m !== null).map((m) => ({ id: m[1], detail: m[2] }))
  }
  const listAfter = (text: string, label: RegExp) => ((text.match(label) ?? ['', ''])[1] ?? '').split(', ').map((s) => s.trim()).filter(Boolean)
  const detailOf = (line: string) => (line.match(/ \.{3,} FAIL - (.*)$/) ?? ['', ''])[1]
  const originHead = gitArgs(['rev-parse', '--verify', '--quiet', `origin/${crgbBranch}`])
  const shortMain = git('rev-parse --short=7 origin/main')
  // A nested line is cut at a fixed width, so only its last listed path may be a prefix.
  const pathsInScope = (paths: string[]) => paths.length > 0 && paths.every((p, i) => changedPaths.includes(p) || (i === paths.length - 1 && changedPaths.some((c) => c.startsWith(p))))
  const nestedDepthProved = (output: string, outer: string, depth: number, named: string[]): boolean => {
    const level = NESTED_BRANCH_ONLY[depth]
    const fails = nestedFails(output, outer, depth)
    const ids = fails.map((f) => f.id)
    return fails.length > 0 && new Set(ids).size === ids.length && named.length > 0 && new Set(named).size === named.length && named.every((id) => ids.includes(id)) && ids.every((id) => level.ids.includes(id)) && fails.every((f) => nestedItemProved(output, outer, depth, f.id, f.detail, fails.length))
  }
  const nestedItemProved = (output: string, outer: string, depth: number, id: string, detail: string, failCount: number): boolean => {
    const level = NESTED_BRANCH_ONLY[depth]
    if (id === 'T001') return detail.startsWith(`branch ${crgbBranch};`) && detail.includes(`latest main ${shortMain}`) && /\bas [0-9a-f]{7,40}\b/.test(detail) && [...detail.matchAll(/\bas ([0-9a-f]{7,40})\b/g)].every((m) => gitOk(`merge-base --is-ancestor ${m[1]} HEAD`))
    if (id === 'T002') return detail.startsWith('working tree clean;') && thisBranchClean(detail)
    if (id === 'T010') return outOfScope.length === 0 && pathsInScope(listAfter(detail, /^unexpected: (.*)$/))
    if (id === level.aggregator) {
      const unproven = listAfter(detail, /^cause not proven for: (.*)$/)
      return depth === NESTED_BRANCH_ONLY.length - 1
        ? unproven.length > 0 && new Set(unproven).size === unproven.length && unproven.every((x) => A78_BRANCH_ONLY.includes(x))
        : nestedDepthProved(output, outer, depth + 1, unproven)
    }
    // T122, T123 and T130 are the identity of the historical branch's own runs: here they name THIS exact pushed HEAD.
    const counted = detail.match(/^(\d+) of the 129 checks before this one PASS, (\d+) FAIL/)
    return originHead === headSha && (detail.includes(headSha) || thisBranchClean(detail)) && (!counted || (Number(counted[2]) === failCount - 1 && Number(counted[1]) === 129 - (failCount - 1)))
  }
  const nestedCauseProved = (output: string, outer: string, line: string) => originHead === headSha && nestedDepthProved(output, outer, 0, listAfter(detailOf(line), /^cause not proven for: (.*)$/))
  const crgACause: Record<string, () => boolean> = {
    'CRG-001': () => /supersedes CRG-01 v1\.0/.test(crgARegisterNow) && /CRG-01 FINAL/.test(crgARegisterNow) && v1TablesNow === 0 && !/coding_release_codes|coding_release_dataset_systems|CODE_IDENTITY_AMBIGUOUS/.test(crgACodeNow),
    'CRG-002': () => lineOf(crgARows, 'CRG-002').includes(`branch ${crgbBranch} from main`) && lineOf(crgARows, 'CRG-002').includes('working tree clean') && thisBranchClean(lineOf(crgARows, 'CRG-002')),
    'CRG-003': () => outOfScope.length === 0 && /unexpected: backend\//.test(lineOf(crgARows, 'CRG-003')),
    'CRG-127': () => lineOf(crgARows, 'CRG-127').includes(`HEAD ${headSha}`) && thisBranchClean(lineOf(crgARows, 'CRG-127')) && /all \d+ applied migrations match their committed checksums/.test(lineOf(crgARows, 'CRG-127')) && outOfScope.length === 0,
    'CRG-121': () => lineOf(crgARows, 'CRG-121').includes(`all evidence corresponds to ${headSha}`),
    'CRG-124': () => nestedCauseProved(crgAChain.output, 'CRG-01', lineOf(crgARows, 'CRG-124')),
  }
  const a85Cause: Record<string, () => boolean> = {
    T001: () => /A8\.3 merged as [0-9a-f]{7} .*an ancestor/.test(lineOf(a85Rows, 'T001')) && lineOf(a85Rows, 'T001').includes(`latest main ${git('rev-parse --short origin/main')} contained`) && gitOk(`merge-base --is-ancestor ${CRG_A_MERGE} HEAD`) && gitOk('merge-base --is-ancestor origin/main HEAD'),
    T003: () => lineOf(a85Rows, 'T003').includes(`branch ${crgbBranch}`) && lineOf(a85Rows, 'T003').includes('working tree clean') && thisBranchClean(lineOf(a85Rows, 'T003')),
    T010: () => outOfScope.length === 0 && /unexpected: backend\//.test(lineOf(a85Rows, 'T010')),
    T110: () => nestedCauseProved(a85Chain.output, 'A8.5', lineOf(a85Rows, 'T110')),
    T127: () => lineOf(a85Rows, 'T127').includes(`HEAD ${headSha}`) && thisBranchClean(lineOf(a85Rows, 'T127')) && /the tree is clean after every check/.test(lineOf(a85Rows, 'T127')),
    T129: () => lineOf(a85Rows, 'T129').includes(`HEAD ${headSha.slice(0, 12)}`),
  }
  for (const text of [...crgAChain.output.split(/\r?\n/), ...a85Chain.output.split(/\r?\n/)].filter((l) => / \.{3,} FAIL|RUN ABORTED|uncaught error|INVALID RUN/.test(l))) progress(`nested: ${text.slice(0, 300)}`)
  const crgARan = crgARows.some((r) => r.id === 'CRG-125') && !/\[CRG-01\] RUN ABORTED|\[CRG-01\] uncaught error/.test(crgAChain.output)
  const a85Ran = a85Rows.some((r) => r.id === 'T130') && !/\[A8\.5\] RUN ABORTED|\[A8\.5\] uncaught error|\[A8\.5\] INVALID RUN/.test(a85Chain.output)
  const crgAUndocumented = crgAFailing.filter((id) => !(id in crgANonApplicable) || !crgACause[id]())
  const a85Undocumented = a85Failing.filter((id) => !(id in a85NonApplicable) || !a85Cause[id]())
  const verdictIn = (rows: SuiteLine[], id: string) => rows.find((r) => r.id === id)?.verdict ?? 'missing'
  check(
    'CRG-123',
    'Every applicable A2–A8 and CRG-A regression executes',
    crgARan && a85Ran && ['CRG-123', 'CRG-125', 'CRG-050', 'CRG-019'].every((id) => verdictIn(crgARows, id) === 'PASS') && ['T101', 'T102', 'T103', 'T104', 'T105', 'T106', 'T107', 'T108', 'T109', 'T111', 'T112'].every((id) => verdictIn(a85Rows, id) === 'PASS'),
    `${(crgAChain.output.match(/\[CRG-01\] automated summary: [^\n]*/) ?? ['CRG-A: no summary'])[0]}; ${(a85Chain.output.match(/\[A8\.5\] automated summary: [^\n]*/) ?? ['A8.5: no summary'])[0]}: Checkpoint A, A8.5, A8.3 → A1 all executed with every substantive check PASS`,
  )
  for (const [id, reason] of Object.entries(crgANonApplicable)) if (crgAFailing.includes(id)) notApplicableCheck(`CRG-123/${id}`, `Checkpoint A ${id}`, reason)
  for (const [id, reason] of Object.entries(a85NonApplicable)) if (a85Failing.includes(id)) notApplicableCheck(`CRG-123/A85-${id}`, `A8.5 ${id}`, reason)
  check(
    'CRG-124',
    'No substantive failed nested test marked N/A',
    crgARan && a85Ran && crgAUndocumented.length === 0 && a85Undocumented.length === 0,
    crgAUndocumented.length + a85Undocumented.length === 0
      ? `every nested failure is a documented branch-only item (Checkpoint A: ${crgAFailing.join(', ') || 'none'}; A8.5: ${a85Failing.join(', ') || 'none'})`
      : `undocumented: Checkpoint A ${crgAUndocumented.join(', ') || 'none'}; A8.5 ${a85Undocumented.join(', ') || 'none'}`,
  )
  check('CRG-125', 'All v1 golden vectors remain stable', goldenUnit.ok && verdictIn(crgARows, 'CRG-125') === 'PASS' && same(await goldenNow(), goldenBefore), "the A6-PAYLOAD-1 golden vector, the Checkpoint A golden decisions and this run's receipts and V2 freeze read identically after both nested chains")

  // ---------------------------------------------------------------- build gates and exact evidence
  section('Build gates and exact evidence: units, typecheck, frontend, outage and recovery, no 5xx, allowlist, parity and checksums, two runs')
  const ownUnit = run(`node --test ${UNIT_TESTS.map((file) => file.replace('backend/', '')).join(' ')}`)
  const allUnit = run('npm run test:unit')
  check('CRGB-G08', 'Backend unit tests pass', allUnit.ok && /ℹ fail 0/.test(allUnit.output) && ownUnit.ok && /ℹ pass 10/.test(ownUnit.output), `${(allUnit.output.match(/ℹ pass \d+/) ?? ['unit output unavailable'])[0]}, including the 10 Checkpoint B tests`)
  check('CRGB-G09', 'Backend typecheck clean', run('npm run typecheck').ok, 'backend typecheck clean, including this harness')
  check('CRGB-G10', 'Frontend lint and build clean', run('npm run lint --prefix ../frontend').ok && run('npm run build --prefix ../frontend').ok, 'frontend unchanged; lint and production build clean')
  await apiReady('the DB outage check')
  const upHealth = await health()
  const upReady = await ready()
  const stopped = spawnSync('docker', ['stop', dbContainer], { encoding: 'utf8' }).status === 0
  const downReady = await waitFor(async () => (await ready()) === 503, 30_000)
  const downHealth = await health()
  const restarted = spawnSync('docker', ['start', dbContainer], { encoding: 'utf8' }).status === 0
  const recovered = await waitFor(async () => (await ready()) === 200, 90_000)
  await waitFor(databaseUp, 60_000)
  check('CRGB-G11', 'Health/ready outage and recovery truthful', upHealth === 200 && upReady === 200 && stopped && downReady && downHealth === 200 && restarted && recovered, 'up 200/200; with the database stopped health stayed 200 and ready reported 503; recovery 200')
  check('CRG-126', 'Zero unexpected 5xx', serverErrors === 0 && connectionResets === 0, `${serverErrors} HTTP 5xx answers and ${connectionResets} connection resets in this run`)
  const applied = await prisma.$queryRaw<{ name: string; checksum: string }[]>`SELECT migration_name AS name, checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`
  const checksumMismatch = applied.filter((row) => {
    const blob = spawnSync('git', ['show', `HEAD:backend/prisma/migrations/${row.name}/migration.sql`], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }).stdout ?? Buffer.alloc(0)
    const onDisk = `prisma/migrations/${row.name}/migration.sql`
    return !((blob.length > 0 && sha256Of(blob) === row.checksum) || (existsSync(onDisk) && sha256Of(readFileSync(onDisk)) === row.checksum))
  })
  const headNow = git('rev-parse HEAD')
  const originCrgb = gitArgs(['rev-parse', '--verify', '--quiet', `origin/${crgbBranch}`])
  check(
    'CRG-127',
    'Allowlist, origin parity and SHA evidence',
    outOfScope.length === 0 && headNow === headAtStart && headNow === originCrgb && git('status --porcelain') === '' && applied.length === headMigrationDirs.length && checksumMismatch.length === 0,
    `HEAD ${headNow} = origin/${crgbBranch}; tree clean; all ${applied.length} applied migrations carry their committed checksums; nested logs crgb-nested-crga-${runId}.log (SHA-256 ${sha256Of(Buffer.from(crgAChain.output)).slice(0, 16)}…) and crgb-nested-a85-${runId}.log (SHA-256 ${sha256Of(Buffer.from(a85Chain.output)).slice(0, 16)}…)`,
  )
  const earlierRuns = readdirSync('.').filter((name) => /^crgb-nested-a85-CRGB-\d{13}\.log$/.test(name) && !name.includes(runId) && readFileSync(name, 'utf8').includes(`[A8.5] HEAD ${headNow}`)).map((name) => name.replace(/^crgb-nested-a85-|\.log$/g, ''))
  check(
    'CRG-122',
    'Checkpoint B run at one exact HEAD (two runs)',
    passed + failed === 63 && /^CRGB-\d{13}$/.test(runId) && headNow === headAtStart && !earlierRuns.includes(runId) && chainStartedAt > runStartedAt,
    `run ${runId} at ${headNow}: all ${passed + failed} checks before this one executed (${passed} PASS); ${earlierRuns.length > 0 ? `earlier kept run(s) at this HEAD: ${earlierRuns.join(', ')}` : 'no earlier run at this HEAD is kept here, so this is the first'}; the two submitted runs must both state this HEAD`,
  )

  say(`\n[${TAG}] run ${runId} — HEAD ${headNow}`)
  if (failures.length > 0) {
    say(`[${TAG}] ${failures.length} FAILED:`)
    for (const failure of failures) say(`          ${failure}`)
  }
  if (notApplicable > 0) say(`[${TAG}] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) say(`[${TAG}] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  say(`[${TAG}] automated summary: ${passed}/${passed + failed} PASS`)
  say(failed === 0 ? `[${TAG}] CHECKPOINT B ACCEPTANCE COMPLETE` : `[${TAG}] CRG-01 CHECKPOINT B FINAL FAIL`)
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    if (error instanceof RunAborted) {
      console.log(`\n[${TAG}] RUN ABORTED: ${error.message}`)
      console.log(`[${TAG}] No verdict was recorded for the remaining checks, so this run is not evidence of anything.`)
    } else {
      console.error(`[${TAG}] uncaught error (this itself is a FAIL):`, error)
    }
    process.exitCode = 1
  })
  .finally(async () => {
    clearConcurrencyProbes()
    const running = (spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', dbContainer], { encoding: 'utf8' }).stdout ?? '').trim()
    if (running === 'false') {
      console.log(`[${TAG}] the database container was left stopped; starting it again`)
      spawnSync('docker', ['start', dbContainer], { encoding: 'utf8' })
    }
    await prisma.$disconnect()
  })
