import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { auth } from '../../shared/auth/auth.ts'
import { formatDateOnly } from '../../shared/rules/date-only.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordValidationRunInTransaction } from '../../modules/validation-run/validation-run.recorder.ts'
import {
  activateReferenceDatasetVersion,
  importReferenceDataset,
  importReferenceDatasetVersion,
  retireReferenceDatasetVersion,
  validateReferenceDatasetVersion,
} from '../../modules/reference-dataset/reference-dataset.maintenance.ts'
import { classifyRetirement, getCodingReleaseCheckOf, importRelease, recordRightsDecision, registerDatasetCodeSystem } from '../../modules/coding-release/coding-release.service.ts'
import { releaseContentFingerprint, resolveEdition } from '../../modules/coding-release/coding-release.resolver.ts'
import { CODESET_CONTRACT_VERSION, codeSystems, decisionCodes, type EditionFacts, type ImportRow } from '../../modules/coding-release/coding-release.types.ts'

// CRG-01 FINAL (v2.0), Checkpoint A — acceptance for the Medical Coding Release Governance foundation
// (CRG-CODESET-1). The specification's 130 assertions CRG-001…CRG-130 are each reported exactly once:
//   - EXECUTED here with expected and actual evidence (everything Checkpoint A can prove),
//   - DEFERRED to Checkpoint B (A5-VAL-2, receipts, PreClaimA6HandoffV2, A6-PAYLOAD-2, freeze V2) or C (A7/A8 read
//     side, A9 adapter), or
//   - BLOCKED as a pre-production obligation (official sign-off, licences, A9/A10 acceptance, latency budget).
// DEFERRED and BLOCKED are never counted as PASS. Build gates G01–G06 are reported beside them.
//
// Editions are real A3 reference-dataset versions created, validated, activated and retired through A3's own
// maintenance owner; identities, rights, imports and retirement classifications are recorded through the CRG writers.
// Every encounter, code, claim and freeze is built through its owner routes. Each run uses its own synthetic regulatory
// authority (`SYN-CRG-<run>`), so editions of earlier runs never govern this run's encounters. Editions A (2021) and B
// (2024) and the 2027 boundary are synthetic fixtures only (source register SRC-01 is DRAFT), never verified law.
// Direct SQL writes are adversarial only and ALWAYS rolled back; a contradictory history is planted only inside such a
// transaction and the production read answers on THAT transaction. Synthetic users are provisioned per run through
// Better Auth's own server-side creation with a random password that is never printed.

const TAG = 'CRG-01'
let passed = 0
let failed = 0
const failures: string[] = []
const printed: string[] = []
const reported = new Set<string>()
const deferred: string[] = []
const blocked: string[] = []

const say = (line: string) => {
  printed.push(line)
  console.log(line)
}
const mark = (id: string) => {
  if (reported.has(id)) throw new Error(`${id} reported twice`)
  reported.add(id)
}

function check(id: string, title: string, condition: boolean, detail = '') {
  mark(id)
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

function deferTo(id: string, checkpoint: 'B' | 'C', title: string, reason: string) {
  mark(id)
  deferred.push(id)
  say(`[${TAG}] ${id} ${title} ${'.'.repeat(Math.max(3, 50 - title.length))} DEFERRED - Checkpoint ${checkpoint}: ${reason}`)
}

function block(id: string, title: string, reason: string) {
  mark(id)
  blocked.push(id)
  say(`[${TAG}] ${id} ${title} ${'.'.repeat(Math.max(3, 50 - title.length))} BLOCKED - ${reason}`)
}

const section = (title: string) => say(`\n[${TAG}] ${title}`)
const progress = (text: string) => say(`[${TAG}]      ${text}`)

// Every `npm run` prepends its node_modules/.bin directories to PATH again, so each level of the nested
// regression chain makes PATH longer; a spawned command therefore gets PATH without the .bin entries npm
// added on the way here (npm adds exactly those back for the command it runs).
const pathKey = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
const childEnv = (extra: Record<string, string> = {}) => ({
  ...process.env,
  [pathKey]: (process.env[pathKey] ?? '')
    .split(delimiter)
    .filter((entry) => !/[\\/]node_modules[\\/]\.bin[\\/]?$|[\\/]node-gyp-bin[\\/]?$/i.test(entry))
    .join(delimiter),
  ...extra,
})

function run(command: string, extra: Record<string, string> = {}): { ok: boolean; output: string } {
  const out = spawnSync(command, { encoding: 'utf8', shell: true, cwd: process.cwd(), env: childEnv(extra), maxBuffer: 256 * 1024 * 1024 })
  return { ok: out.status === 0, output: `${out.stdout ?? ''}${out.stderr ?? ''}` }
}

const gitArgs = (args: string[]) => (spawnSync('git', args, { encoding: 'utf8' }).stdout ?? '').replace(/\s+$/, '')
const git = (args: string) => gitArgs(args.split(' '))
const gitOk = (args: string) => spawnSync('git', args.split(' '), { encoding: 'utf8' }).status === 0

// Scope guards judge behaviour on committed production code, never vocabulary in comments or tests.
const committedFiles = (dir: string) => git(`ls-tree -r --name-only --full-tree HEAD ${dir}`).split(/\r?\n/).filter(Boolean)
const committedText = (path: string) => git(`show HEAD:${path}`)
const committedCode = (path: string) =>
  committedText(path)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n')
const committedProductionCodeOf = (dirs: string[]) => {
  const files = dirs.flatMap((dir) => committedFiles(dir)).filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\.tsx?$/.test(file))
  return { files, code: files.map((file) => committedCode(file)).join('\n') }
}

class RunAborted extends Error {}

const runId = `CRG-${Date.now()}`
const runToken = runId.slice(4)
const runStartedAt = new Date(Number(runToken))
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const crgBranch = 'fix/crg-01-final-coding-release'
const a83Branch = 'feature/a8-3-exception-investigation'
const a82Branch = 'feature/a8-2-exception-triage'
const a81Branch = 'feature/a8-1-exception-intake'
const a81FixBranch = 'fix/a8-1-harness-later-phase-recognition'
// The harness correction merged before CRG-01: A5.10 T112 and the A7.2 replay check judge their own scope.
const hcFixBranch = 'fix/a5-10-a7-2-harness-later-phase-recognition'
const a710Branch = 'feature/a7-10-a7-integration-acceptance'
const a79Branch = 'feature/a7-9-revenue-evidence-continuity'
const a78Branch = 'feature/a7-8-revenue-evidence-delta'
// The accepted A8.3 merge (PR #101); this branch starts from the main that also contains the harness correction.
const A83_MERGE = 'a9f15806f4a178250b4aa263874a2b5c17ba827c'
const MISSING = '11111111-1111-4111-8111-111111111111'
const MODULE_DIR = 'backend/src/modules/coding-release'
const FE_DIR = 'frontend/src/modules/coding-release'
const HARNESS_DIR = 'backend/src/integration/crg-01-coding-release'
const REGISTER_DOC = 'docs/CRG-01_Coding_Release_Governance.md'
const SOURCE_REGISTER = 'docs/CRG-01-CODING-SOURCE-REGISTER.md'
const MIGRATION_NAME = '20261104090000_crg_01_final_coding_release'
const MIGRATION = `backend/prisma/migrations/${MIGRATION_NAME}/migration.sql`
const CRG_TABLES = ['crg_code_system_datasets', 'crg_code_system_rights', 'crg_release_code_memberships', 'crg_release_imports', 'crg_retirement_classifications']
const UNIT_TESTS = [`${MODULE_DIR}/coding-release.resolver.test.ts`, `${MODULE_DIR}/coding-release.validation.test.ts`]
const CONTRACT = 'CRG-CODESET-1'
const JUR = 'AE-DU'
const AUTH = `SYN-CRG-${runToken}`
const CHECK_KEYS = ['contractVersion', 'encounterId', 'serviceDate', 'jurisdictionCode', 'authorityCode', 'items', 'evaluatedAt']
const ITEM_KEYS = ['subjectKind', 'subjectId', 'masterCodeId', 'decisionCode', 'codeSystem', 'edition', 'membership']
const EDITION_KEYS = ['referenceDatasetVersionId', 'datasetId', 'codeSystem', 'purpose', 'edition', 'effectiveFrom', 'effectiveTo', 'sourceVersionId', 'contentHash', 'importId', 'activationStatus', 'retirementClassification']
// The harness correction bundled in this PR by the head developer's decision (docs/Harness_Corrections.md, disclosed in
// the PR): A7.2 T026, A7.3 T105, A7.4 T107 and A7.5 T108 subtract the tables created by migrations committed after their
// own merge, exactly as the accepted A6.10 T110 and A8.1 T100/T119 corrections. CRG-003 proves nothing else changed.
const HARNESS_CORRECTIONS_DOC = 'docs/Harness_Corrections.md'
const BUNDLED_HARNESS_FIXES = [
  'backend/src/integration/a7-evidence-classification/a7-evidence-classification.integration.ts',
  'backend/src/integration/a7-evidence-gate/a7-evidence-gate.integration.ts',
  'backend/src/integration/a7-evidence-case/a7-evidence-case.integration.ts',
  'backend/src/integration/a7-case-prerequisite/a7-case-prerequisite.integration.ts',
]
const LATER_PHASE_TABLES_DEFINITION =
  "const laterPhaseTables = new Set(ownMerge ? migrationDirsAt('HEAD').filter((dir) => !migrationDirsAt(ownMerge).includes(dir)).flatMap((dir) => [...committedText(`${dir}/migration.sql`).matchAll(/CREATE TABLE \"([^\"]+)\"/g)].map((m) => m[1])) : [])"
const LATER_PHASE_FILTER = '.filter((t) => !laterPhaseTables.has(t))'
const ALLOWED = [
  'backend/package.json', 'backend/prisma/schema.prisma', MIGRATION, 'backend/src/app.ts', 'backend/src/shared/errors/error.types.ts', 'backend/src/shared/authorization/authorization.types.ts',
  'backend/src/scripts/bootstrap-authz-dev.ts', 'backend/src/scripts/verify-migration-replay.ts', 'frontend/src/developer/checkRegistry.tsx', REGISTER_DOC, SOURCE_REGISTER,
  HARNESS_CORRECTIONS_DOC, ...BUNDLED_HARNESS_FIXES,
]
// Every table a coding-release read could conceivably touch, in a fixed key order. A read must leave every one as it
// was.
const COUNT_TABLES = [...CRG_TABLES, 'reference_datasets', 'reference_dataset_versions', 'reference_dataset_lifecycle_events', 'audit_events', 'encounters', 'encounter_diagnoses', 'encounter_activities', 'validation_runs', 'validation_findings', 'claims', 'claim_freezes', 'exception_intake_records', 'exception_triage_events', 'exception_investigation_events']

const deepKeys = (value: unknown, found: Set<string> = new Set()): Set<string> => {
  if (Array.isArray(value)) for (const item of value) deepKeys(item, found)
  else if (value !== null && typeof value === 'object')
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      found.add(key)
      deepKeys(child, found)
    }
  return found
}

async function attemptAdversarial(write: () => Promise<unknown>): Promise<string> {
  try {
    await write()
    return ''
  } catch (error) {
    return `${(error as { code?: string }).code ?? ''} ${String((error as Error).message ?? error)}`
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type SuiteLine = { id: string; verdict: 'PASS' | 'FAIL' | 'N/A'; line: string }
function suiteLines(output: string, tag: string): SuiteLine[] {
  const prefix = `[${tag}] `
  const rows: SuiteLine[] = []
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith(prefix)) continue
    const rest = line.slice(prefix.length)
    const id = rest.split(' ')[0]
    if (!/^T\d+(\/T\d+)?$/.test(id)) continue
    const verdict = / \.{3,} PASS/.test(rest) ? 'PASS' : / \.{3,} FAIL/.test(rest) ? 'FAIL' : / \.{3,} N\/A /.test(rest) ? 'N/A' : null
    if (verdict) rows.push({ id, verdict, line })
  }
  return rows
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const sha256Of = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const fingerprint = (label: string) => sha256Of(Buffer.from(`${runId}:${label}`))
const withoutEvaluatedAt = (body: unknown) => JSON.stringify(body, (k, v) => (k === 'evaluatedAt' || k === 'requestId' ? undefined : v))
// The basis reports an edition's current A3 state, which legitimately moves from ACTIVE to SUPERSEDED when its successor
// is activated; everything else in the answer must stay byte-identical.
const withoutCurrentState = (body: unknown) => JSON.stringify(body, (k, v) => (k === 'evaluatedAt' || k === 'requestId' || k === 'activationStatus' ? undefined : v))

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  const headAtStart = git('rev-parse HEAD')
  say(`[${TAG}] CRG-01 FINAL Checkpoint A, medical coding release governance foundation (${CODESET_CONTRACT_VERSION}) — run ${runId}`)
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
  if (!(await waitFor(databaseUp, 60_000)))
    throw new RunAborted(`the database is not reachable, so no check can be judged. Start it with \`docker start ${dbContainer}\`, wait for it to report healthy, then run this suite again.`)
  const ready = async () => (await fetch(`${baseUrl}/api/ready`).catch(() => null))?.status ?? 0
  const health = async () => (await fetch(`${baseUrl}/api/health`).catch(() => null))?.status ?? 0
  const apiReady = async (what: string) => {
    if (!(await waitFor(async () => (await ready()) === 200, 60_000)))
      throw new RunAborted(`the API at ${baseUrl} is not ready before ${what}; start it with \`npm start\``)
  }

  // ---------------------------------------------------------------- git, schema and Prisma facts used throughout
  const branch = git('rev-parse --abbrev-ref HEAD')
  const mergeOf = (name: string) => gitArgs(['log', 'origin/main', '--merges', `--grep=${name}$`, '-n', '1', '--format=%H'])
  const a83Merge = mergeOf(a83Branch)
  const a82Merge = mergeOf(a82Branch)
  const a81Merge = mergeOf(a81Branch)
  const a81FixMerge = mergeOf(a81FixBranch)
  const a710Merge = mergeOf(a710Branch)
  const hcFixMerge = mergeOf(hcFixBranch)
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  const tracking = git('status -sb').split(/\r?\n/)[0]
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const migrationDirsAt = (ref: string) => git(`ls-tree -d --name-only --full-tree ${ref} backend/prisma/migrations/`).split(/\r?\n/).filter((line) => /\/\d{14}_/.test(line))
  const headMigrationDirs = migrationDirsAt('HEAD')
  // CRG's own scope: on its own branch, its diff against main; on any later branch, exactly what its own merge added.
  const ownMerge = branch === crgBranch ? '' : mergeOf(crgBranch)
  const ownRange = ownMerge ? `${ownMerge}^1..${ownMerge}` : 'origin/main...HEAD'
  const ownBase = ownMerge ? gitArgs(['rev-parse', `${ownMerge}^1`]) : 'origin/main'
  const ownTip = ownMerge || 'HEAD'
  const ownChangedPaths = gitArgs(['diff', '--name-only', ownRange]).split(/\r?\n/).filter(Boolean)
  const ownPrismaStatus = gitArgs(['diff', '--name-status', ownRange, '--', ':/backend/prisma']).split(/\r?\n/).filter(Boolean)
  const ownHeadMigrationDirs = migrationDirsAt(ownTip)
  const ownBaseMigrationDirs = migrationDirsAt(ownBase)
  const schemaDiff = gitArgs(['diff', '-U0', ownRange, '--', ':/backend/prisma/schema.prisma'])
  const schemaRemoved = schemaDiff.split(/\r?\n/).filter((line) => /^-(?!--)/.test(line))
  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  const replay = run('npm run db:verify:replay')
  const appliedCount = Number((replay.output.match(/(\d+) migrations applied cleanly/) ?? [])[1] ?? -1)
  const applied = await prisma.$queryRaw<{ name: string; checksum: string }[]>`SELECT migration_name AS name, checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`
  const committedBlob = (path: string) => spawnSync('git', ['show', `HEAD:${path}`], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }).stdout ?? Buffer.alloc(0)
  const checksumMismatch = applied.filter((row) => {
    const blob = committedBlob(`backend/prisma/migrations/${row.name}/migration.sql`)
    const onDisk = `prisma/migrations/${row.name}/migration.sql`
    return !((blob.length > 0 && sha256Of(blob) === row.checksum) || (existsSync(onDisk) && sha256Of(readFileSync(onDisk)) === row.checksum))
  })
  const contractConstantsAt = (ref: string) =>
    gitArgs(['ls-tree', '-r', '--name-only', '--full-tree', ref, 'backend/src/modules'])
      .split(/\r?\n/)
      .filter((path) => /\.types\.ts$/.test(path) && !path.startsWith(`${MODULE_DIR}/`))
      .flatMap((path) => [...gitArgs(['show', `${ref}:${path}`]).matchAll(/export const ([A-Z_]*(CONTRACT_VERSION|VALIDATOR_VERSION|SCHEMA_VERSION)) = '([^']+)'/g)].map((m) => `${m[1]}=${m[3]}`))
      .sort()
  const contractsOwn = contractConstantsAt(ownTip)
  const productDiff = ownChangedPaths.filter((p) => /^backend\/src\/modules\//.test(p) && !p.startsWith(`${MODULE_DIR}/`))
  const outOfScope = changedPaths.filter((file) => !file.startsWith(`${MODULE_DIR}/`) && !file.startsWith(`${FE_DIR}/`) && !file.startsWith(`${HARNESS_DIR}/`) && !ALLOWED.includes(file))
  const earlierSuites = changedPaths.filter((file) => file.startsWith('backend/src/integration/') && !file.startsWith(`${HARNESS_DIR}/`) && !BUNDLED_HARNESS_FIXES.includes(file))
  // Each bundled suite changes exactly two code lines: its one later-phase table set, defined from its own merge, and
  // the original boundary query with that set subtracted. Every other changed line is a comment. Judged over this
  // package's own range, so it holds after the merge too.
  const bundledStray = BUNDLED_HARNESS_FIXES.flatMap((path) => {
    const changed = gitArgs(['diff', '-U0', ownRange, '--', `:/${path}`]).split(/\r?\n/).filter((line) => /^[+-](?![+-]{2} )/.test(line))
    const code = (sign: string) => changed.filter((line) => line.startsWith(sign)).map((line) => line.slice(1).trim()).filter((body) => body !== '' && !body.startsWith('//'))
    const [removed, added] = [code('-'), code('+')]
    const exact = removed.length === 1 && added.length === 2 && added[0] === LATER_PHASE_TABLES_DEFINITION && added[1] === `${removed[0]}${LATER_PHASE_FILTER}` && /table_name ~\* '\([^']*import[^']*\)'/.test(removed[0])
    return changed.length > 0 && exact ? [] : [path.split('/').pop() as string]
  })
  const laterDomain = changedPaths.filter((file) => /drg|grouper|remittance|payment|ledger|settle|integration\/a9|dhpo|eclaimlink|pre-claim-validation|pre-claim-readiness|validation-run|claim-payload|claim-submission|exception-/i.test(file))
  const moduleCode = committedProductionCodeOf([MODULE_DIR]).code
  const resolverCode = committedCode(`${MODULE_DIR}/coding-release.resolver.ts`)
  const serviceCode = committedCode(`${MODULE_DIR}/coding-release.service.ts`)
  const feCode = committedProductionCodeOf([FE_DIR]).code
  const sourceRegister = committedText(SOURCE_REGISTER)
  const contractRegister = committedText(REGISTER_DOC)
  const migrationText = committedText(MIGRATION)

  await apiReady('signing in')
  let connectionResets = 0
  let serverErrors = 0
  const httpCall = async (path: string, init?: RequestInit) => {
    try {
      return await callApi(baseUrl, path, init)
    } catch {
      connectionResets += 1
      throw new RunAborted(`the API connection was reset while calling ${path}. Start the API with \`npm start\` (never \`npm run dev\`) in a tab of its own, and run this suite again.`)
    }
  }
  const signIn = async (email: string, password: string) => {
    const res = await httpCall('/api/auth/sign-in/email', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: baseUrl }, body: JSON.stringify({ email, password }) })
    return { status: res.status, cookie: extractCookieHeader(res.setCookies) }
  }
  const admin = await signIn(adminEmail, adminPassword)
  const viewer = await signIn(viewerEmail, viewerPassword)
  if (admin.status !== 200 || viewer.status !== 200) throw new Error(`sign-in failed (admin ${admin.status}, viewer ${viewer.status})`)
  const as = (cookie: string) => (init: RequestInit = {}) => ({ ...init, headers: { ...init.headers, 'Content-Type': 'application/json', Cookie: cookie } })
  const asAdmin = as(admin.cookie)
  const asViewer = as(viewer.cookie)
  type Who = (init?: RequestInit) => RequestInit
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
  const creatorId = (await prisma.user.findFirstOrThrow({ where: { email: adminEmail }, select: { id: true } })).id
  const key = (suffix: string) => `${runId}-${suffix}`
  // Raw database text in a response body: SQL keywords, a stack frame or a physical table or guard name.
  const rawError = (body: unknown) => {
    const text = JSON.stringify(body ?? {})
    return /\bat [\w.$<>]+ \(|\.ts:\d+:\d+|prisma|SELECT |INSERT |constraint|trigger/i.test(text) || /crg_|reference_dataset|encounter_diagnoses/.test(text)
  }

  // Synthetic users: Better Auth's own server-side user and credential creation, then a membership (with the ORG_ADMIN
  // role, or with no role at all). The password is random per run and never printed.
  const authContext = await auth.$context
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'ORG_ADMIN' }, select: { id: true } })
  const provisionMember = async (label: string, organizationId = org, withRole = true) => {
    const email = `${runId.toLowerCase()}-${label}@reviewers.sbn.test`
    const secretValue = randomBytes(24).toString('base64url')
    const user = await authContext.internalAdapter.createUser({ email, name: `Synthetic member ${label}`, emailVerified: false }, { method: 'email-password' })
    await authContext.internalAdapter.linkAccount({ userId: user.id, providerId: 'credential', issuer: 'local:credential', accountId: user.id, password: await authContext.password.hash(secretValue) })
    const membership = await prisma.organizationMembership.create({ data: { organizationId, userId: user.id } })
    if (withRole) await prisma.membershipRole.create({ data: { membershipId: membership.id, roleId: adminRole.id } })
    const signed = await signIn(email, secretValue)
    if (signed.status !== 200) throw new Error(`fixture member ${label} could not sign in (${signed.status})`)
    return { id: user.id as string, email, who: as(signed.cookie), cookie: signed.cookie }
  }
  // B approves home freezes; O belongs to the other tenant.
  const B = await provisionMember('b')
  const O = await provisionMember('o', otherOrg)

  // ---------------------------------------------------------------- fixtures
  section('Fixtures: synthetic editions through the A3 owner and the CRG writers; facilities, encounters, codes, a claim and its resubmission through owner routes')
  const preRunEncounter = await prisma.encounter.findFirst({ where: { createdAt: { lt: runStartedAt } }, orderBy: { createdAt: 'asc' }, select: { id: true, updatedAt: true } })
  const wholeHash = async (table: string) => (await prisma.$queryRawUnsafe<{ h: string }[]>(`SELECT encode(sha256(convert_to(coalesce((SELECT string_agg(row_to_json(x)::text, '|' ORDER BY x.id) FROM ${table} x), ''), 'UTF8')), 'hex') AS h`))[0].h
  const neighbours = async () => ({
    a7Sources: await wholeHash('revenue_source_evidence'), a7Assessments: await wholeHash('evidence_prereq_results'), intakes: await wholeHash('exception_intake_records'),
    triage: await wholeHash('exception_triage_events'), investigation: await wholeHash('exception_investigation_events'),
  })
  const neighboursBefore = await neighbours()
  // Per-run codes: canonical, unique per organization and never a real code.
  const C1 = `Q${runToken}.1`
  const C2 = `Q${runToken}.2`
  const C3 = `Q${runToken}.3`
  const C9 = `Q${runToken}.9`
  const P1 = `P${runToken}`
  const P2 = `P${runToken}X`
  const H1 = `H${runToken}`
  const maintenanceActor = { actorRef: `crg-01-harness:${runId}`, reason: 'synthetic CRG Checkpoint A fixture' }
  const okValue = <T>(label: string, result: { ok: true; value: T } | { ok: false; message: string } | { ok: false; code: string; message: string }): T => {
    if (!result.ok) throw new Error(`fixture ${label} was refused: ${result.message}`)
    return result.value
  }
  // A synthetic source authority behind edition A (A3 rule-source owner), so its basis names a source version.
  const source = must('rule source', (await post(`/api/organizations/${org}/rule-sources`, { jurisdictionCode: JUR, issuingAuthority: AUTH, sourceCategory: 'REGULATORY_AUTHORITY', referenceNumber: `SYN-GC-${runToken}`, title: `${runId} synthetic coding source` })).body)
  const sourceVersion = must('rule source version', (await post(`/api/rule-sources/${source.id}/versions`, { version: `SYN-${runToken}`, rawEvidenceRef: `synthetic:${runId}` })).body)
  type Release = { datasetId: string; versionId: string; rows: ImportRow[]; contentHash: string }
  const rowsOf = (label: string, codes: string[]): ImportRow[] => codes.map((code, i) => ({ sourceRowId: `${label}-r${i + 1}`, code, sourceRowSha256: fingerprint(`${label}:${code}`) }))
  const datasetFor = async (label: string, authority: string, codeSystem: string, jurisdiction = JUR) => {
    const datasetId = okValue(`${label} dataset`, await importReferenceDataset({ datasetKey: key(label), displayName: `${runId} ${label}`, jurisdictionCode: jurisdiction, authorityCode: authority })).id
    okValue(`${label} identity`, await registerDatasetCodeSystem({ datasetId, codeSystem, purpose: 'CLAIM_CODING' }))
    return datasetId
  }
  // One edition: an A3 version whose content hash is the fingerprint of its rows, imported completely through CRG
  // (unless `imported` is false) before it is ever validated.
  const editionOf = async (label: string, datasetId: string, window: { from: string | null; to: string | null }, codes: string[], options: { sourceVersionId?: string | null; imported?: boolean } = {}): Promise<Release> => {
    const rows = rowsOf(label, codes.length > 0 ? codes : [`Z${runToken}`])
    const contentHash = releaseContentFingerprint(rows)
    const versionId = okValue(`${label} version`, await importReferenceDatasetVersion({ datasetId, sourceVersionId: options.sourceVersionId ?? null, version: label, retrievedAt: new Date().toISOString(), effectiveFrom: window.from, effectiveTo: window.to, contentHash })).id
    if (options.imported !== false) okValue(`${label} import`, await importRelease({ datasetVersionId: versionId, sourceFileSha256: contentHash, sourceUri: `synthetic:${runId}/${label}`, publisher: 'Synthetic CRG fixture', expectedRowCount: rows.length, rows }))
    return { datasetId, versionId, rows, contentHash }
  }
  const validated = async (release: Release, statusValue = 'VALIDATED') => okValue('validate', await validateReferenceDatasetVersion(release.versionId, statusValue, maintenanceActor))
  const activated = async (release: Release) => okValue('activate', await activateReferenceDatasetVersion(release.versionId, maintenanceActor))
  const live = async (release: Release) => {
    await validated(release)
    await activated(release)
  }
  const rights = async (authority: string, codeSystem: string, rightsStatus: string, jurisdiction = JUR) =>
    okValue('rights', await recordRightsDecision({ jurisdictionCode: jurisdiction, authorityCode: authority, codeSystem, rightsStatus, decisionReference: `synthetic fixture ${runId}` }))
  // Main scope (JUR, AUTH): ICD-10-CM editions A (2021) and B (2024), one CPT edition, rights APPROVED for both systems.
  await rights(AUTH, 'ICD-10-CM', 'APPROVED')
  await rights(AUTH, 'CPT', 'APPROVED')
  const DX = await datasetFor('dx', AUTH, 'ICD-10-CM')
  const EA = await editionOf('2021', DX, { from: '2021-01-01', to: '2026-12-31' }, [C1, C2], { sourceVersionId: sourceVersion.id })
  const EB = await editionOf('2024', DX, { from: '2027-01-01', to: null }, [C1, C3])
  const PX = await datasetFor('px', AUTH, 'CPT')
  const EP = await editionOf('cpt', PX, { from: '2021-01-01', to: null }, [P1])
  await live(EA)
  await live(EP)

  // Facilities: each with its own regulatory profile (jurisdiction, authority) from 2020, one clinician assigned to all.
  const at = (path: string, body: unknown) => post(path, body, asAdmin)
  const clinician = must('clinician', (await at(`/api/organizations/${org}/clinicians`, { displayName: `${runId} clinician` })).body)
  const facilityFor = async (label: string, jurisdictionCode: string, authority: string, organizationId = org, who: Who = asAdmin, clinicianId: string = clinician.id) => {
    const facility = must(`${label} facility`, (await post(`/api/organizations/${organizationId}/facilities`, { name: `${runId} ${label} facility` }, who)).body)
    const profile = must(`${label} profile`, (await post(`/api/facilities/${facility.id}/regulatory-profiles`, { jurisdictionCode, regulatoryAuthorityCode: authority, effectiveFrom: '2020-01-01', effectiveTo: null }, who)).body)
    if ((await post(`/api/facility-regulatory-profiles/${profile.id}/activate`, {}, who)).status !== 200) throw new Error(`fixture ${label} profile activation failed`)
    must(`${label} assignment`, (await post(`/api/clinicians/${clinicianId}/facility-assignments`, { facilityId: facility.id, effectiveFrom: '2020-01-01', effectiveTo: null }, who)).body)
    return facility.id as string
  }
  const patient = must('patient', (await at(`/api/organizations/${org}/patients`, { givenName: 'Synthetic', familyName: `${runId}-P`, dateOfBirth: '1990-01-01' })).body)
  const dx = async (code: string) => must(`diagnosis ${code}`, (await at(`/api/organizations/${org}/diagnosis-codes`, { code, displayName: `${runId} synthetic diagnosis` })).body).id as string
  const px = async (internalCode: string, codeSystem: string | null, externalCode: string | null) =>
    must(`procedure ${internalCode}`, (await at(`/api/organizations/${org}/procedure-codes`, { internalCode, displayName: `${runId} synthetic procedure`, codeSystem, externalCode })).body).id as string
  const DX1 = await dx(C1)
  const DX2 = await dx(C2)
  const DX3 = await dx(C3)
  const DX9 = await dx(C9)
  const DXBAD = await dx(`Q${runToken} 9`)
  const PCPT = await px(key('pcpt'), 'CPT', P1)
  const PNULL = await px(key('pnull'), null, null)
  const PLOWER = await px(key('plower'), 'cpt', P1)
  const PHCPCS = await px(key('phcpcs'), 'HCPCS-LEVEL-II', H1)
  // Internal code equal to a member code, external code not a member: the internal code is never read as licensed.
  const PINTERNAL = await px(P1, 'CPT', P2)
  const encounterAt = async (facilityId: string, serviceDate: string, diagnoses: string[], procedures: string[] = []) => {
    const encounter = must(`encounter ${serviceDate}`, (await at(`/api/patients/${patient.id}/encounters`, { facilityId, clinicianId: clinician.id, serviceDate, insuranceMembershipId: null })).body)
    for (const diagnosisCodeId of diagnoses) must('encounter diagnosis', (await at(`/api/encounters/${encounter.id}/diagnoses`, { diagnosisCodeId })).body)
    for (const procedureCodeId of procedures) must('encounter activity', (await at(`/api/encounters/${encounter.id}/activities`, { procedureCodeId, quantity: '1' })).body)
    return encounter.id as string
  }
  const FMAIN = await facilityFor('main', JUR, AUTH)
  const E26 = await encounterAt(FMAIN, '2026-12-31', [DX1, DX2, DX3, DX9, DXBAD], [PCPT, PNULL, PLOWER, PHCPCS, PINTERNAL])
  const E27 = await encounterAt(FMAIN, '2027-01-01', [DX1, DX2, DX3], [PCPT])
  const E20 = await encounterAt(FMAIN, '2020-06-15', [DX1])

  // Further scopes, each its own authority so no case can disturb another. Rights APPROVED unless stated.
  type Spec = { label: string; from: string | null; to: string | null; then: (r: Release) => Promise<void>; imported?: boolean; codeSystem?: string }
  const scoped = async (suffix: string, editions: Spec[], dates: string[], options: { rightsStatus?: string | null; datasetAuthority?: string } = {}) => {
    const authority = `${AUTH}-${suffix}`
    if (options.rightsStatus !== null) await rights(options.datasetAuthority ?? authority, 'ICD-10-CM', options.rightsStatus ?? 'APPROVED')
    const releases: Release[] = []
    for (const e of editions) {
      const datasetId = await datasetFor(`${suffix}-${e.label}`, options.datasetAuthority ?? authority, e.codeSystem ?? 'ICD-10-CM')
      const release = await editionOf(`${suffix}-${e.label}`, datasetId, { from: e.from, to: e.to }, [e.codeSystem === 'CPT' ? P1 : C1], { imported: e.imported })
      await e.then(release)
      releases.push(release)
    }
    const facilityId = await facilityFor(suffix, JUR, authority)
    const encounters: string[] = []
    for (const date of dates) encounters.push(await encounterAt(facilityId, date, [DX1]))
    return { authority, releases, encounters }
  }
  const retireAs = (classification: string | null) => async (r: Release) => {
    await live(r)
    okValue('retire', await retireReferenceDatasetVersion(r.versionId, maintenanceActor))
    if (classification) okValue('classify', await classifyRetirement({ datasetVersionId: r.versionId, classification }))
  }
  const OVL = await scoped('OVL', [{ label: 'e1', from: '2021-01-01', to: null, then: live }, { label: 'e2', from: '2026-06-01', to: null, then: live }], ['2026-12-31', '2026-01-15'])
  const BLK = await scoped('BLK', [{ label: 'unvalidated', from: '2021-01-01', to: null, then: async () => {} }], ['2026-06-15'])
  const blockedActivation = await activateReferenceDatasetVersion(BLK.releases[0].versionId, maintenanceActor)
  const INA = await scoped('INA', [{ label: 'validated-only', from: '2021-01-01', to: null, then: async (r) => void (await validated(r)) }], ['2026-06-15'])
  const REJ = await scoped('REJ', [{ label: 'rejected', from: '2021-01-01', to: null, then: async (r) => void (await validated(r, 'REJECTED')) }], ['2026-06-15'])
  const rejectedActivation = await activateReferenceDatasetVersion(REJ.releases[0].versionId, maintenanceActor)
  const NOIMP = await scoped('NOIMP', [{ label: 'unimported', from: '2021-01-01', to: null, then: live, imported: false }], ['2026-06-15'])
  const RIGHTSB = await scoped('RGB', [{ label: 'blocked-rights', from: '2021-01-01', to: null, then: live }], ['2026-06-15'], { rightsStatus: 'BLOCKED' })
  const RIGHTSN = await scoped('RGN', [{ label: 'no-rights', from: '2021-01-01', to: null, then: live }], ['2026-06-15'], { rightsStatus: null })
  const RIGHTSR = await scoped('RGR', [{ label: 'revoked-rights', from: '2021-01-01', to: null, then: live }], ['2026-06-15'])
  const rightsRevoked = await rights(RIGHTSR.authority, 'ICD-10-CM', 'BLOCKED')
  const RETP = await scoped('RETP', [{ label: 'prospective', from: '2021-01-01', to: '2026-12-31', then: retireAs('PROSPECTIVE') }, { label: 'current', from: '2027-01-01', to: null, then: live }], ['2026-06-15', '2027-03-01'])
  const RETI = await scoped('RETI', [{ label: 'invalidated', from: '2021-01-01', to: '2026-12-31', then: retireAs('HISTORICALLY_INVALIDATED') }, { label: 'current', from: '2027-01-01', to: null, then: live }], ['2026-06-15', '2027-03-01'])
  const RETU = await scoped('RETU', [{ label: 'unclassified', from: '2021-01-01', to: '2026-12-31', then: retireAs(null) }], ['2026-06-15'])
  const NOD = await scoped('NOD', [{ label: 'undated', from: null, to: null, then: live }], ['2026-06-15'])
  const NODX = await scoped('NODX', [{ label: 'cpt-only', from: '2021-01-01', to: null, then: live, codeSystem: 'CPT' }], ['2026-06-15'])
  // A masquerading authority: editions recorded under another authority never govern this facility's authority.
  const MASQ = await scoped('MASQ', [{ label: 'foreign-authority', from: '2021-01-01', to: null, then: live }], ['2026-06-15'], { datasetAuthority: `${AUTH}-FOREIGN` })
  const contradictory = await importReferenceDatasetVersion({ datasetId: DX, version: 'contradictory', retrievedAt: new Date().toISOString(), effectiveFrom: '2027-01-01', effectiveTo: '2026-01-01', contentHash: fingerprint('contradictory') })
  const FWRONG = await facilityFor('wrong-jurisdiction', 'AE-AZ', AUTH)
  const EWRONG = await encounterAt(FWRONG, '2026-06-15', [DX1])
  // The other tenant: its own facility, clinician, patient and encounter.
  const awayClinician = must('away clinician', (await post(`/api/organizations/${otherOrg}/clinicians`, { displayName: `${runId} away clinician` }, O.who)).body)
  const FAWAY = await facilityFor('away', JUR, AUTH, otherOrg, O.who, awayClinician.id)
  const awayPatient = must('away patient', (await post(`/api/organizations/${otherOrg}/patients`, { givenName: 'Synthetic', familyName: `${runId}-AWAY`, dateOfBirth: '1990-01-01' }, O.who)).body)
  const awayDx = must('away diagnosis', (await post(`/api/organizations/${otherOrg}/diagnosis-codes`, { code: C1, displayName: `${runId} away diagnosis` }, O.who)).body)
  const EAWAY = must('away encounter', (await post(`/api/patients/${awayPatient.id}/encounters`, { facilityId: FAWAY, clinicianId: awayClinician.id, serviceDate: '2026-12-31', insuranceMembershipId: null }, O.who)).body).id as string
  must('away encounter diagnosis', (await post(`/api/encounters/${EAWAY}/diagnoses`, { diagnosisCodeId: awayDx.id }, O.who)).body)

  // CRG-034: a 2026 service whose claim is frozen, then corrected and resubmitted (A6.7, A6.9) after edition B exists.
  const T03 = await (async () => {
    const svc = must('service', (await at(`/api/organizations/${org}/services`, { internalCode: key('SB'), displayName: `${runId} service` })).body)
    const payer = must('payer', (await at(`/api/organizations/${org}/payers`, { displayName: `${runId} payer` })).body)
    const contract = must('contract', (await at(`/api/organizations/${org}/provider-contracts`, { contractKey: key('C'), displayName: `${runId} contract`, payerId: payer.id, effectiveFrom: '2020-01-01', effectiveTo: null })).body)
    must('contract facility', (await at(`/api/provider-contracts/${contract.id}/contract-facilities`, { facilityId: FMAIN })).body)
    const schedule = must('schedule', (await at(`/api/provider-contracts/${contract.id}/tariff-schedules`, { tariffKey: key('T'), displayName: `${runId} tariff` })).body)
    const version = must('tariff version', (await at(`/api/tariff-schedules/${schedule.id}/versions`, { version: key('V'), effectiveFrom: '2026-01-01', effectiveTo: null })).body)
    must('rate', (await at(`/api/tariff-schedule-versions/${version.id}/rates`, { modifierCodes: [], currencyCode: 'AED', selectorKind: 'SERVICE', serviceId: svc.id, unitTariffAmount: '12.1250' })).body)
    if ((await at(`/api/tariff-schedule-versions/${version.id}/verification`, { verificationStatus: 'VERIFIED' })).status !== 200) throw new Error('fixture CRG-034: the tariff version could not be verified')
    const encounter = must('CRG-034 encounter', (await at(`/api/patients/${patient.id}/encounters`, { facilityId: FMAIN, clinicianId: clinician.id, serviceDate: '2026-12-31', insuranceMembershipId: null })).body)
    const activityId = must('CRG-034 activity', (await at(`/api/encounters/${encounter.id}/activities`, { serviceId: svc.id, quantity: '1' })).body).id
    const encounterDiagnosisId = must('CRG-034 diagnosis', (await at(`/api/encounters/${encounter.id}/diagnoses`, { diagnosisCodeId: DX1 })).body).id
    const row = await prisma.encounter.findUniqueOrThrow({ where: { id: encounter.id }, select: { facilityId: true, facilityRegulatoryProfileId: true, serviceDate: true } })
    const contextSnapshot = {
      serviceDate: formatDateOnly(row.serviceDate) as string, facilityId: row.facilityId, facilityRegulatoryProfileId: row.facilityRegulatoryProfileId,
      insuranceMembershipId: null, payerId: payer.id as string | null, tpaId: null, networkId: null, insuranceProductId: null,
      providerContractId: contract.id as string | null, tariffScheduleId: schedule.id as string | null, tariffScheduleVersionId: version.id as string | null,
    }
    const finding = (outcome: string, overrides: Record<string, unknown> = {}) => ({ layer: 'TECHNICAL', outcome, findingCode: `SYNTHETIC_${outcome}`, message: 'Synthetic finding.', ...overrides })
    const recorded = await prisma.$transaction(async (tx) =>
      recordValidationRunInTransaction({ encounterId: encounter.id, contextSnapshot, validatorVersion: 'A5-VAL-1', findings: [finding('WARNING', { layer: 'CODING' }), finding('PASS', { encounterActivityId: activityId }), finding('PASS', { layer: 'CODING', encounterDiagnosisId })] }, creatorId, tx),
    )
    if (!recorded.ok) throw new Error(`fixture CRG-034: a valid run was refused (${recorded.message})`)
    const readiness = await at(`/api/validation-runs/${recorded.value.id}/readiness-assessments`, {})
    if (readiness.status !== 201) throw new Error(`fixture CRG-034: readiness refused with ${readiness.status}`)
    const claim = must('CRG-034 claim', (await at(`/api/pre-claim-readiness-assessments/${readiness.body.id}/claims`, {})).body)
    const lineId = must('CRG-034 line', (await at(`/api/claims/${claim.id}/lines`, { encounterActivityId: activityId })).body).id
    const claimDiagnosisId = must('CRG-034 claim diagnosis', (await at(`/api/claims/${claim.id}/diagnoses`, { encounterDiagnosisId, roleCode: 'PRIMARY' })).body).id
    if ((await api('PUT', `/api/claim-lines/${lineId}/diagnosis-pointers`, { claimDiagnosisIds: [claimDiagnosisId] })).status !== 200) throw new Error('fixture CRG-034: pointers refused')
    const pricing = await at(`/api/claims/${claim.id}/pricing-runs`, {})
    const freezes: string[] = []
    let assessment: { id: string; assemblyFingerprint: string } | null = null
    let approvalId: string | null = null
    for (let i = 0; i < 2; i += 1) {
      if (assessment && approvalId) {
        const revoked = await post(`/api/claims/${claim.id}/review-decisions`, { draftAssessmentId: assessment.id, assemblyFingerprint: assessment.assemblyFingerprint, decisionCode: 'REVOKE', referencedApprovalId: approvalId }, B.who)
        if (revoked.status !== 201) throw new Error(`fixture CRG-034: revocation refused with ${revoked.status}`)
      }
      const assessed = await at(`/api/claims/${claim.id}/draft-assessments`, { pricingRunId: pricing.body.id })
      if (assessed.status !== 201 || assessed.body?.outcome !== 'REVIEWABLE') throw new Error(`fixture CRG-034: expected a REVIEWABLE assessment, got ${assessed.status} ${assessed.body?.outcome}`)
      assessment = assessed.body
      const approved = await post(`/api/claims/${claim.id}/review-decisions`, { draftAssessmentId: assessed.body.id, assemblyFingerprint: assessed.body.assemblyFingerprint, decisionCode: 'APPROVE' }, B.who)
      if (approved.status !== 201) throw new Error(`fixture CRG-034: approval refused with ${approved.status}`)
      approvalId = approved.body.decision.id
      const frozen = await at(`/api/claims/${claim.id}/submissions`, { draftAssessmentId: assessed.body.id, approvalDecisionId: approvalId })
      if (frozen.status !== 201) throw new Error(`fixture CRG-034: the A6.7 freeze was refused with ${frozen.status} ${errorCode(frozen.body) ?? ''}`)
      freezes.push(frozen.body.submissionId)
    }
    return { encounterId: encounter.id as string, claimId: claim.id as string, freezes }
  })()
  progress(`fixtures ready: authority ${AUTH}; ICD-10-CM editions 2021 and 2024, a CPT edition; scopes OVL, BLK, INA, REJ, NOIMP, RGB, RGN, RGR, RETP, RETI, RETU, NOD, NODX, MASQ and a wrong jurisdiction; the other tenant's encounter; a 2026 claim frozen twice`)

  const checkOf = (encounterId: string, who: Who = asAdmin) => get(`/api/encounters/${encounterId}/coding-release-check`, who)
  const itemOf = (body: any, subjectKind: string, masterCodeId: string) => (body?.items ?? []).find((item: any) => item.subjectKind === subjectKind && item.masterCodeId === masterCodeId)
  const decisionOf = (body: any, masterCodeId: string, subjectKind = 'DIAGNOSIS') => itemOf(body, subjectKind, masterCodeId)?.decisionCode as string | undefined
  const editionIdOf = (body: any, masterCodeId: string, subjectKind = 'DIAGNOSIS') => itemOf(body, subjectKind, masterCodeId)?.edition?.referenceDatasetVersionId as string | undefined
  const counts = async () => {
    const rows = await prisma.$queryRawUnsafe<{ t: string; n: bigint }[]>(`${COUNT_TABLES.map((table) => `SELECT '${table}' AS t, count(*) AS n FROM ${table}`).join(' UNION ALL ')} ORDER BY t`)
    const byName = new Map(rows.map((row) => [row.t, Number(row.n)]))
    return Object.fromEntries(COUNT_TABLES.map((table) => [table, byName.get(table) ?? -1])) as Record<string, number>
  }
  const unchanged = async (before: Record<string, number>) => same(await counts(), before)
  const hashOf = async (sql: string, ...params: unknown[]) =>
    (await prisma.$queryRawUnsafe<{ h: string }[]>(`SELECT encode(sha256(convert_to(coalesce((SELECT string_agg(row_to_json(x)::text, '|' ORDER BY x.id) FROM (${sql}) x), ''), 'UTF8')), 'hex') AS h`, ...params))[0].h
  const freezesHash = () => hashOf(`SELECT f.*, m.id AS manifest FROM claim_freezes f LEFT JOIN claim_freeze_evidence_manifests m ON m.claim_submission_id = f.id WHERE f.claim_id = $1::uuid`, T03.claimId)
  const NOT_COMMITTED = 'ROLLED_BACK'
  const rolledBack = async <T>(work: (tx: DbClient) => Promise<T>): Promise<{ value?: T; message: string; clean: boolean }> => {
    const before = await counts()
    const out: { value?: T } = {}
    const message = await attemptAdversarial(() =>
      prisma.$transaction(
        async (tx) => {
          out.value = await work(tx)
          throw new Error(NOT_COMMITTED)
        },
        { timeout: 60_000 },
      ),
    )
    return { ...out, message, clean: await unchanged(before) }
  }
  const one = async (sql: string, params: unknown[], triggersOff = false) => {
    const attempt = await rolledBack(async (tx) => {
      if (triggersOff) await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
      await tx.$executeRawUnsafe(sql, ...params)
    })
    return { refused: !attempt.message.includes(NOT_COMMITTED), message: attempt.message, clean: attempt.clean }
  }
  const freezesAfterFixtures = await freezesHash()

  // ---------------------------------------------------------------- 01 governance and baseline (CRG-001–010)
  section('01 Governance and baseline: one authority, clean ancestry, no unrelated paths, untouched contracts and checksums, source register, rights, DRG excluded, synthetic isolation')
  const v1Tables = (await prisma.$queryRawUnsafe<{ t: string }[]>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'coding\\_release%'`)).map((r) => r.t)
  check(
    'CRG-001',
    'CRG v1 superseded; no dual authority',
    /supersedes CRG-01 v1\.0/.test(contractRegister) && /CRG-01 FINAL/.test(contractRegister) && v1Tables.length === 0 && !/coding_release_codes|coding_release_dataset_systems|CODE_IDENTITY_AMBIGUOUS/.test(moduleCode + migrationText) && branch === crgBranch,
    'the contract register states that CRG-01 FINAL v2.0 supersedes v1.0; no v1 table, decision name or branch exists; one contract (CRG-CODESET-1) and one module',
  )
  check(
    'CRG-002',
    'Clean main ancestry, feature branch and origin parity',
    branch === crgBranch && a83Merge === A83_MERGE && gitOk(`merge-base --is-ancestor ${A83_MERGE} HEAD`) && gitOk('merge-base --is-ancestor origin/main HEAD') &&
      [a82Merge, a81Merge, a81FixMerge, a710Merge, hcFixMerge].every((sha) => sha.length === 40 && gitOk(`merge-base --is-ancestor ${sha} HEAD`)) && dirty.length === 0 && tracking.includes(`origin/${crgBranch}`) && !/ahead|behind/.test(tracking),
    `branch ${branch} from main ${git('rev-parse --short origin/main')} (A8.3 PR #101 ${a83Merge.slice(0, 7)}; A5.10/A7.2 harness correction ${hcFixMerge.slice(0, 7) || 'NOT FOUND'}), with A8.2, A8.1, its correction and A7.10 as ancestors; ${dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.length} path(s)`}; ${tracking}`,
  )
  check(
    'CRG-003',
    'No unrelated A8/A9 product paths changed',
    changedPaths.length > 0 && outOfScope.length === 0 && earlierSuites.length === 0 && laterDomain.length === 0 && bundledStray.length === 0,
    outOfScope.length + earlierSuites.length + laterDomain.length + bundledStray.length === 0
      ? `${changedPaths.length} path(s): the CRG module, page, harness, migration, both registers, the narrow shared additions and the disclosed A7.2–A7.5 harness correction (exactly its later-phase table set and subtraction in each of the four suites); no A5/A6/A8/A9, DRG or payment path`
      : `unexpected: ${[...new Set([...outOfScope, ...earlierSuites, ...laterDomain, ...bundledStray.map((file) => `${file} beyond its later-phase table lines`)])].join(', ').slice(0, 300)}`,
  )
  check(
    'CRG-004',
    'Existing A1–A8 contract definitions byte-identical',
    contractsOwn.length >= 24 && same(contractsOwn, contractConstantsAt(ownBase)) && ['VALIDATOR_VERSION=A5-VAL-1', 'HANDOFF_SCHEMA_VERSION=PreClaimA6HandoffV1', 'PAYLOAD_SCHEMA_VERSION=A6-PAYLOAD-1'].every((c) => contractsOwn.includes(c)) && productDiff.length === 0,
    `all ${contractsOwn.length} owner contract literals (A5-VAL-1, PreClaimA6HandoffV1 and A6-PAYLOAD-1 included) identical to main; no earlier module's code changed`,
  )
  check(
    'CRG-005',
    'Applied migration checksums identical',
    ownPrismaStatus.every((s) => !/^M\tbackend\/prisma\/migrations\//.test(s)) && same(ownPrismaStatus, [`A\t${MIGRATION}`, 'M\tbackend/prisma/schema.prisma']) && ownBaseMigrationDirs.every((dir) => ownHeadMigrationDirs.includes(dir)) && checksumMismatch.length === 0,
    `exactly one migration added (${MIGRATION_NAME}); all ${ownBaseMigrationDirs.length} earlier migrations untouched and every applied checksum equals its committed file`,
  )
  check(
    'CRG-006',
    'Official DHA PDF URL and SHA-256 captured',
    /https:\/\/services\.dha\.gov\.ae\/sheryan\/wps\/portal\/home\/circular-details\?circularRefNo=CIR-2026-00000200/.test(sourceRegister) && /A5843C67-6CBF-C488-B15F-A18CE9200000/.test(sourceRegister) && /`[0-9a-f]{64}`/.test(sourceRegister) && /DHA_GC_06-2026_circular\.pdf/.test(sourceRegister),
    'SRC-01 records the official circular page, the attachment document id and the archived copy with its SHA-256 (per-download encryption noted)',
  )
  check(
    'CRG-007',
    'Effective-date claims have clause/page evidence',
    ['C2', 'C3', 'C6'].every((c) => new RegExp(`\\| ${c} \\| p\\.\\d`).test(sourceRegister)) && !/\b(2021|2024|2027)\b/.test(moduleCode) && /not hardcoded as verified law/.test(sourceRegister),
    'every date statement (C2, C3, C6) cites its page; the module contains no edition year or transition date; the 2027 switch is recorded as unverified',
  )
  const realApprovedRights = await prisma.crgCodeSystemRight.count({ where: { authorityCode: { in: ['DHA', 'DOH', 'MOHAP'] }, rightsStatus: 'APPROVED' } })
  check(
    'CRG-008',
    'Rights recorded per code system or BLOCKED',
    codeSystems.every((cs) => new RegExp(`\\| ${cs} \\|[^\\n]*BLOCKED`).test(sourceRegister)) && realApprovedRights === 0,
    'the register records rights for ICD-10-CM, CPT and HCPCS-LEVEL-II as BLOCKED pending sign-off; no APPROVED rights decision exists for a real authority, so no real catalogue can be selected',
  )
  const drgRoutes = await Promise.all([post('/api/drg', {}), get(`/api/encounters/${E26}/drg`), post('/api/drg-groupings', {})])
  check(
    'CRG-009',
    'DRG excluded from outpatient runtime',
    !/drg|grouper|base[_ ]?rate|relative[_ ]?weight/i.test(moduleCode + migrationText.replace(/--[^\n]*/g, '')) && drgRoutes.every((r) => r.status === 404) && /DRG/.test(sourceRegister) && /Out of CRG-01 scope/.test(sourceRegister) &&
      // CRG-01's own US-runtime boundary (A5.10 T112 judges only the code A5.10 merged): HCPCS Level II is a DHA code set
      // (SRC-01 C1) and stays a controlled identity; no US transport, payer or provider-identifier runtime exists.
      !/\b(x12|clearinghouse|medicare|medicaid|npi)\b/i.test(moduleCode + feCode),
    'no DRG, grouper, base rate or weight in code, schema or routes; the register records the DRG clauses as out of scope; the module and page carry no X12, clearinghouse, Medicare, Medicaid or NPI runtime',
  )
  const runDatasets = await prisma.referenceDataset.findMany({ where: { createdAt: { gte: runStartedAt } }, select: { datasetKey: true, authorityCode: true } })
  check(
    'CRG-010',
    'Synthetic fixtures isolated from production assets',
    runDatasets.length >= 18 && runDatasets.every((d) => d.datasetKey.startsWith(runId) && d.authorityCode.startsWith(AUTH)) && [C1, C2, C3, P1, H1].every((c) => c.includes(runToken)) && EA.rows.every((r) => r.code.includes(runToken)),
    `all ${runDatasets.length} datasets this run created carry this run's keys and synthetic authority ${AUTH}; every code is a per-run synthetic value; no real catalogue file is read`,
  )

  // ---------------------------------------------------------------- 02 dataset and code identity (CRG-011–020)
  section('02 Dataset and code identity: (jurisdiction, authority, system, purpose), no conflicting mapping, no DHA→ICD inference, internal ≠ external, distinct release meaning, uniqueness, tenancy, immutability, A2 keys')
  const dxIdentity = await prisma.crgCodeSystemDataset.findUniqueOrThrow({ where: { datasetId: DX } })
  const dxDataset = await prisma.referenceDataset.findUniqueOrThrow({ where: { id: DX }, select: { jurisdictionCode: true, authorityCode: true } })
  check(
    'CRG-011',
    'Dataset identity is jurisdiction+authority+system+purpose',
    dxIdentity.codeSystem === 'ICD-10-CM' && dxIdentity.purpose === 'CLAIM_CODING' && dxIdentity.jurisdictionCode === dxDataset.jurisdictionCode && dxIdentity.authorityCode === dxDataset.authorityCode && dxIdentity.contractVersion === CONTRACT,
    `the dataset is identified as (${dxIdentity.jurisdictionCode}, ${dxIdentity.authorityCode}, ${dxIdentity.codeSystem}, ${dxIdentity.purpose}), copied from and held equal to its A3 dataset`,
  )
  const secondMapping = await registerDatasetCodeSystem({ datasetId: DX, codeSystem: 'CPT', purpose: 'CLAIM_CODING' })
  const sqlSecondMapping = await one(`INSERT INTO crg_code_system_datasets (id, dataset_id, code_system, purpose, jurisdiction_code, authority_code, contract_version) SELECT gen_random_uuid(), d.id, 'CPT', 'CLAIM_CODING', d.jurisdiction_code, d.authority_code, '${CONTRACT}' FROM reference_datasets d WHERE d.id = $1::uuid`, [DX], true)
  check(
    'CRG-012',
    'Conflicting code-system mappings refused',
    secondMapping.ok === false && secondMapping.code === 'CODING_RELEASE_CONFLICT' && sqlSecondMapping.refused && /crg_code_system_datasets_dataset_key|23505/.test(sqlSecondMapping.message) && sqlSecondMapping.clean,
    'a second identity for the same dataset is refused by the writer and, with every trigger off, by the unique key',
  )
  const r26before = await checkOf(E26)
  await live(EB)
  const r26 = await checkOf(E26)
  const r27 = await checkOf(E27)
  const rNodx = await checkOf(NODX.encounters[0])
  check(
    'CRG-013',
    'DiagnosisCode has no implicit DHA→ICD assumption',
    decisionOf(rNodx.body, DX1) === 'NO_APPROVED_RELEASE' && itemOf(rNodx.body, 'DIAGNOSIS', DX1)?.codeSystem === null && !/'DHA'|"DHA"/.test(moduleCode),
    'in a jurisdiction where only CPT is mapped, a diagnosis gets NO_APPROVED_RELEASE with no code system: the system comes only from an explicit mapping, never from the authority (no DHA literal in the module)',
  )
  check(
    'CRG-014',
    'Procedure internal and external identities never conflated',
    decisionOf(r26.body, PINTERNAL, 'PROCEDURE') === 'CODE_NOT_IN_RELEASE' && decisionOf(r26.body, PCPT, 'PROCEDURE') === 'APPLICABLE' && !/internalCode|internal_code/.test(moduleCode),
    'a procedure whose internal code equals a member code but whose external code is not a member is CODE_NOT_IN_RELEASE; the module never reads an internal code',
  )
  const a1 = itemOf(r26.body, 'DIAGNOSIS', DX1)
  const b1 = itemOf(r27.body, 'DIAGNOSIS', DX1)
  check(
    'CRG-015',
    'Same external code in two editions keeps distinct semantics',
    a1?.edition?.referenceDatasetVersionId === EA.versionId && b1?.edition?.referenceDatasetVersionId === EB.versionId && a1?.membership?.sourceRowSha256 !== b1?.membership?.sourceRowSha256 &&
      a1?.membership?.releaseContentHash === EA.contentHash && b1?.membership?.releaseContentHash === EB.contentHash && a1?.membership?.membershipId !== b1?.membership?.membershipId,
    'the same code answers two membership rows with their own source rows, row SHA-256 and release checksums, each bound to its own edition',
  )
  const dupRows = await importRelease({ datasetVersionId: EB.versionId, sourceFileSha256: EB.contentHash, sourceUri: 'synthetic:x', publisher: 'x', expectedRowCount: 2, rows: [EB.rows[0], { ...EB.rows[0], sourceRowId: 'other' }] })
  const sqlDupMembership = await one(
    `INSERT INTO crg_release_code_memberships (id, import_id, dataset_version_id, code_system, code, source_row_id, source_row_sha256, release_content_hash, contract_version) SELECT gen_random_uuid(), i.id, i.dataset_version_id, i.code_system, $2, 'dup-row', $3, $4, '${CONTRACT}' FROM crg_release_imports i WHERE i.dataset_version_id = $1::uuid`,
    [EA.versionId, C1, fingerprint('dup'), EA.contentHash], true,
  )
  check('CRG-016', 'Duplicate membership in one edition refused', dupRows.ok === false && dupRows.code === 'VALIDATION_ERROR' && sqlDupMembership.refused && /crg_release_code_memberships_code_key|23505/.test(sqlDupMembership.message) && sqlDupMembership.clean, 'a code twice in one import is a 400, and a second row for a code already in the edition is refused by the unique key even with triggers off')
  const foreignCode = await rolledBack(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
    await tx.$executeRawUnsafe(`INSERT INTO encounter_diagnoses (id, encounter_id, diagnosis_code_id, sequence, created_at, updated_at) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 99, now(), now())`, E26, awayDx.id)
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin')
    return getCodingReleaseCheckOf(E26, tx)
  })
  check(
    'CRG-017',
    'Referenced A2 code belongs to the encounter organization',
    foreignCode.value?.ok === false && foreignCode.value.code === 'SOURCE_INTEGRITY_CONFLICT' && foreignCode.clean && r26.status === 200,
    "a planted diagnosis naming the other tenant's code (rolled back) refuses the whole read; every real code is checked against the encounter's organization",
  )
  const foreign = await checkOf(EAWAY)
  const missing = await checkOf(MISSING)
  const envelope = (r: { body: any }) => ({ ...r.body?.error, requestId: null })
  check(
    'CRG-018',
    'Foreign tenant reference indistinguishable from missing',
    foreign.status === 404 && missing.status === 404 && same(envelope(foreign), envelope(missing)) && !JSON.stringify(foreignCode.value ?? {}).includes(awayDx.id) && !rawError(foreign.body),
    "another organization's encounter is exactly the missing-encounter 404, and the refusal for a foreign code names no id of the other tenant",
  )
  const immut = []
  for (const table of CRG_TABLES)
    immut.push(
      await one(`UPDATE ${table} SET contract_version = contract_version WHERE recorded_at >= $1::timestamptz`, [runStartedAt.toISOString()]),
      await one(`DELETE FROM ${table} WHERE recorded_at >= $1::timestamptz`, [runStartedAt.toISOString()]),
      await one(`TRUNCATE ${table} CASCADE`, []),
    )
  check('CRG-019', 'Immutable records refuse UPDATE/DELETE/TRUNCATE', immut.every((r) => r.refused && /append-only/.test(r.message) && r.clean), `a no-op UPDATE, a DELETE and a TRUNCATE … CASCADE of each of the ${CRG_TABLES.length} CRG tables are refused (append-only); all rolled back`)
  const a2Constraints = await prisma.$queryRawUnsafe<{ c: string }[]>(`SELECT conname AS c FROM pg_constraint WHERE conrelid IN ('diagnosis_codes'::regclass, 'procedure_codes'::regclass) AND contype IN ('p', 'u') ORDER BY conname`)
  const a2Indexes = await prisma.$queryRawUnsafe<{ c: string }[]>(`SELECT indexname AS c FROM pg_indexes WHERE tablename IN ('diagnosis_codes', 'procedure_codes') AND indexdef ILIKE '%UNIQUE%' ORDER BY indexname`)
  check(
    'CRG-020',
    'A2 primary keys and unique constraints unchanged',
    a2Constraints.some((r) => r.c === 'diagnosis_codes_pkey') && a2Constraints.some((r) => r.c === 'procedure_codes_pkey') && a2Indexes.length >= 4 && schemaRemoved.length === 0 && !/(ALTER TABLE|CREATE (UNIQUE )?INDEX[^;]*ON|CREATE TRIGGER[^;]*ON) "(diagnosis_codes|procedure_codes)"/.test(migrationText),
    `A2 keys (${a2Indexes.map((r) => r.c).join(', ')}) stand; the migration alters, indexes or triggers no A2 table and the schema diff removes no line`,
  )

  // ---------------------------------------------------------------- 03 import and source integrity (CRG-021–030)
  section('03 Import and source integrity: an unimported edition is never selected, hashes and counts are verified before commit, partial imports roll back, unverified, rejected and rights-blocked catalogues are never selected')
  const rNoimp = await checkOf(NOIMP.encounters[0])
  const noHash = await importRelease({ datasetVersionId: BLK.releases[0].versionId, sourceUri: 'synthetic:x', publisher: 'x', expectedRowCount: 1, rows: BLK.releases[0].rows })
  check('CRG-021', 'Missing source file or checksum blocks approval', decisionOf(rNoimp.body, DX1) === 'RELEASE_NOT_AUTHORIZED' && noHash.ok === false && noHash.code === 'VALIDATION_ERROR', 'a validated, activated edition without a complete CRG import is never selected (RELEASE_NOT_AUTHORIZED); an import without a source SHA-256 is a 400')
  // A fresh, unvalidated edition to attack the import path on.
  const PART_DS = await datasetFor('part', `${AUTH}-PART`, 'ICD-10-CM')
  const partRows = rowsOf('part', [C1, C2])
  const partHash = releaseContentFingerprint(partRows)
  const PART = okValue('part version', await importReferenceDatasetVersion({ datasetId: PART_DS, version: 'part', retrievedAt: new Date().toISOString(), effectiveFrom: '2021-01-01', effectiveTo: null, contentHash: partHash })).id
  const importOf = (o: Record<string, unknown>) => importRelease({ datasetVersionId: PART, sourceFileSha256: partHash, sourceUri: 'synthetic:part', publisher: 'Synthetic', expectedRowCount: 2, rows: partRows, ...o })
  const wrongDeclared = await importOf({ sourceFileSha256: fingerprint('wrong') })
  const tamperedRows = await importOf({ rows: [partRows[0], { ...partRows[1], code: C3 }] })
  const sqlWrongHash = await one(`INSERT INTO crg_release_imports (id, dataset_version_id, code_system, source_file_sha256, source_uri, publisher, expected_row_count, contract_version) VALUES (gen_random_uuid(), $1::uuid, 'ICD-10-CM', $2, 'synthetic:x', 'x', 2, '${CONTRACT}')`, [PART, fingerprint('wrong')])
  check(
    'CRG-022',
    'Wrong source hash refused before import commit',
    [wrongDeclared, tamperedRows].every((r) => r.ok === false && r.code === 'SOURCE_INTEGRITY_CONFLICT') && sqlWrongHash.refused && /crg_import_hash/.test(sqlWrongHash.message) && (await prisma.crgReleaseImport.count({ where: { datasetVersionId: PART } })) === 0,
    "a declared SHA-256 that is not the rows' fingerprint, and rows altered after fingerprinting, are refused before any write; a direct import whose hash is not the edition's content hash is refused by the guard; nothing was imported",
  )
  clearConcurrencyProbes()
  const failRows = { reached: 0 }
  setConcurrencyProbe('codingRelease.rows_recorded', async () => {
    failRows.reached += 1
    throw new Error('injected failure after the import rows')
  })
  const crashed = await attemptAdversarial(() => importOf({}))
  clearConcurrencyProbes()
  const halfCommit = await rolledBack(async (tx) => {
    await tx.$executeRawUnsafe(`INSERT INTO crg_release_imports (id, dataset_version_id, code_system, source_file_sha256, source_uri, publisher, expected_row_count, contract_version) VALUES (gen_random_uuid(), $1::uuid, 'ICD-10-CM', $2, 'synthetic:x', 'x', 2, '${CONTRACT}')`, PART, partHash)
    await tx.$executeRawUnsafe(
      `INSERT INTO crg_release_code_memberships (id, import_id, dataset_version_id, code_system, code, source_row_id, source_row_sha256, release_content_hash, contract_version) SELECT gen_random_uuid(), i.id, i.dataset_version_id, 'ICD-10-CM', $2, $3, $4, $5, '${CONTRACT}' FROM crg_release_imports i WHERE i.dataset_version_id = $1::uuid`,
      PART, partRows[0].code, partRows[0].sourceRowId, partRows[0].sourceRowSha256, partHash,
    )
    await tx.$executeRawUnsafe('SET CONSTRAINTS crg_release_imports_complete_trg IMMEDIATE')
  })
  check(
    'CRG-023',
    'Partial import rolls back entirely',
    failRows.reached === 1 && /injected failure after the import rows/.test(crashed) && /crg_import_incomplete/.test(halfCommit.message) && halfCommit.clean && (await prisma.crgReleaseImport.count({ where: { datasetVersionId: PART } })) === 0 &&
      (await prisma.crgReleaseCodeMembership.count({ where: { datasetVersionId: PART } })) === 0,
    'a failure after the rows were written rolled back the import and every row; a direct import holding 1 of its declared 2 rows is refused by the completeness trigger; nothing remains',
  )
  const shortRows = await importOf({ rows: [partRows[0]] })
  const dupRowIds = await importOf({ rows: [partRows[0], { ...partRows[1], sourceRowId: partRows[0].sourceRowId }] })
  check(
    'CRG-024',
    'Duplicate source rows and mismatched row count refused',
    shortRows.ok === false && shortRows.code === 'SOURCE_INTEGRITY_CONFLICT' && dupRowIds.ok === false && dupRowIds.code === 'VALIDATION_ERROR' && /crg_import_incomplete/.test(halfCommit.message),
    'rows fewer than the declared count are refused before any write; a repeated source row id is a 400; and the database refuses a short import (CRG-023)',
  )
  const rNod = await checkOf(NOD.encounters[0])
  check('CRG-025', 'Invalid effective window refused', contradictory.ok === false && decisionOf(rNod.body, DX1) === 'NO_APPROVED_RELEASE', 'A3 refuses a window that ends before it starts; an edition without an effective-from date is never selected')
  const [rBlk, rIna, rRej] = [await checkOf(BLK.encounters[0]), await checkOf(INA.encounters[0]), await checkOf(REJ.encounters[0])]
  check(
    'CRG-026',
    'Unverified/REJECTED A3 version never selected',
    blockedActivation.ok === false && rejectedActivation.ok === false && [rBlk, rIna, rRej].every((r) => decisionOf(r.body, DX1) === 'RELEASE_NOT_AUTHORIZED' && itemOf(r.body, 'DIAGNOSIS', DX1)?.edition === null),
    'A3 refuses to activate an UNVALIDATED or REJECTED edition; an unvalidated, a validated-but-never-activated and a rejected covering edition each answer RELEASE_NOT_AUTHORIZED and are never used',
  )
  const [rRgb, rRgn, rRgr] = [await checkOf(RIGHTSB.encounters[0]), await checkOf(RIGHTSN.encounters[0]), await checkOf(RIGHTSR.encounters[0])]
  check(
    'CRG-027',
    'Rights-blocked catalogue never selected',
    [rRgb, rRgn, rRgr].every((r) => decisionOf(r.body, DX1) === 'RELEASE_NOT_AUTHORIZED' && itemOf(r.body, 'DIAGNOSIS', DX1)?.edition === null) && rightsRevoked.sequence === 2,
    "an approved, imported edition is never used where its code system's rights are BLOCKED, absent, or APPROVED then revoked (the latest numbered decision, 2, governs)",
  )
  const crgColumns = (await prisma.$queryRawUnsafe<{ c: string }[]>(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1::text[])`, CRG_TABLES)).map((r) => r.c)
  const withDescriptor = await importRelease({ datasetVersionId: PART, sourceFileSha256: partHash, sourceUri: 'synthetic:part', publisher: 'Synthetic', expectedRowCount: 2, rows: partRows.map((r) => ({ ...r, descriptor: 'licensed text' })) })
  check(
    'CRG-028',
    'Metadata-only import works with descriptors blocked',
    !!a1?.membership && !crgColumns.some((c) => /descr|display|name|text|title|label/.test(c)) && withDescriptor.ok === false && withDescriptor.code === 'VALIDATION_ERROR',
    'every edition was imported as identifiers and fingerprints only; no CRG column can hold descriptor text and a row carrying one is refused',
  )
  const rMasq = await checkOf(MASQ.encounters[0])
  const sqlMasq = await one(`INSERT INTO crg_code_system_datasets (id, dataset_id, code_system, purpose, jurisdiction_code, authority_code, contract_version) VALUES (gen_random_uuid(), $1::uuid, 'ICD-10-CM', 'CLAIM_CODING', $2, 'DHA', '${CONTRACT}')`, [PART_DS, JUR])
  check(
    'CRG-029',
    'Foreign authority source cannot masquerade',
    decisionOf(rMasq.body, DX1) === 'NO_APPROVED_RELEASE' && sqlMasq.refused && /crg_mapping/.test(sqlMasq.message) && sqlMasq.clean,
    "an approved edition recorded under another authority is never used for this facility's authority; a mapping claiming an authority other than its dataset's (DHA) is refused by the guard",
  )
  check(
    'CRG-030',
    'Source register preserves artifact, reviewer, status, hash',
    /Archived copy/.test(sourceRegister) && /\| Reviewer \|/.test(sourceRegister) && /\*\*DRAFT\*\*/.test(sourceRegister) && /SHA-256 of the archived copy \| `[0-9a-f]{64}`/.test(sourceRegister) && /\| Retrieved \| 2026-11-04/.test(sourceRegister),
    'SRC-01 keeps the archived artifact path, its SHA-256, the retrieval date, the reviewer field and status DRAFT',
  )

  // ---------------------------------------------------------------- 04 historical resolver (CRG-031–040)
  section('04 Historical resolver: service date only, same submission moment, correction keeps the original edition, ACTIVE and SUPERSEDED with history, prospective vs invalidating retirement, overlap and absence')
  const editionAState = await prisma.referenceDatasetVersion.findUniqueOrThrow({ where: { id: EA.versionId }, select: { activationStatus: true } })
  check(
    'CRG-031',
    'Synthetic 2026-12-31 selects A by service date',
    r26.status === 200 && decisionOf(r26.body, DX1) === 'APPLICABLE' && editionIdOf(r26.body, DX1) === EA.versionId && a1?.edition?.edition === '2021' && editionAState.activationStatus === 'SUPERSEDED' && itemOf(r26before.body, 'DIAGNOSIS', DX1)?.edition?.activationStatus === 'ACTIVE' && withoutCurrentState(r26before.body) === withoutCurrentState(r26.body),
    'an encounter on 2026-12-31 resolves synthetic edition A (2021) — identically before edition B existed (A ACTIVE) and after B was activated (A SUPERSEDED); only the reported current state moved',
  )
  check('CRG-032', 'Synthetic 2027-01-01 selects B by service date', r27.status === 200 && decisionOf(r27.body, DX1) === 'APPLICABLE' && editionIdOf(r27.body, DX1) === EB.versionId && b1?.edition?.edition === '2024', 'an encounter on 2027-01-01 resolves synthetic edition B (2024)')
  const sameMoment = await Promise.all([checkOf(E26), checkOf(E27)])
  check(
    'CRG-033',
    'Same submission date does not change selected edition',
    editionIdOf(sameMoment[0].body, DX1) === EA.versionId && editionIdOf(sameMoment[1].body, DX1) === EB.versionId && !/submission|submitted|freeze|createdAt|recordedAt|evaluatedAt/i.test(resolverCode) && !/\bnow\(|\bDate\b/.test(resolverCode),
    'checked at the same instant, the 2026 and 2027 encounters resolve A and B; the resolver reads no submission, record or current time',
  )
  const t03Before = await checkOf(T03.encounterId)
  const corrected = await post(`/api/claims/${T03.claimId}/correction-links`, { priorSubmissionId: T03.freezes[0], correctedSubmissionId: T03.freezes[1], reasonCode: 'CORRECTED_CODING' })
  const t03After = await checkOf(T03.encounterId)
  check(
    'CRG-034',
    '2026 service correction later uses historical A',
    corrected.status === 201 && T03.freezes.length === 2 && editionIdOf(t03Before.body, DX1) === EA.versionId && withoutEvaluatedAt(t03Before.body) === withoutEvaluatedAt(t03After.body),
    'a 2026-12-31 service whose claim was frozen, corrected and resubmitted (A6.7 twice, A6.9 link) after edition B was activated still resolves edition A, identically before and after the correction',
  )
  check('CRG-035', 'ACTIVE validated historically authorized release accepted', b1?.edition?.activationStatus === 'ACTIVE' && decisionOf(r27.body, DX1) === 'APPLICABLE' && decisionOf(r26.body, PCPT, 'PROCEDURE') === 'APPLICABLE', 'an ACTIVE, VALIDATED, imported edition with activation history is accepted (ICD-10-CM B and the CPT edition)')
  const supersededNoHistory = await rolledBack(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
    await tx.$executeRawUnsafe(`INSERT INTO reference_dataset_versions (id, dataset_id, version, retrieved_at, effective_from, content_hash, validation_status, activation_status, superseded_at, created_at, updated_at) VALUES (gen_random_uuid(), $1::uuid, 'planted-superseded', now(), '2030-01-01', $2, 'VALIDATED', 'SUPERSEDED', now(), now(), now())`, DX, fingerprint('planted'))
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin')
    return getCodingReleaseCheckOf(E26, tx)
  })
  check(
    'CRG-036',
    'SUPERSEDED accepted only with matching activation history',
    a1?.edition?.activationStatus === 'SUPERSEDED' && supersededNoHistory.value?.ok === false && supersededNoHistory.value.code === 'SOURCE_INTEGRITY_CONFLICT' && supersededNoHistory.clean,
    'edition A, SUPERSEDED with a recorded ACTIVATE → SUPERSEDE history, is accepted; a planted SUPERSEDED edition with no lifecycle history refuses the whole read (rolled back)',
  )
  const [rRetp26, rRetp27] = [await checkOf(RETP.encounters[0]), await checkOf(RETP.encounters[1])]
  check(
    'CRG-037',
    'Prospective retirement keeps proven historical authority',
    editionIdOf(rRetp26.body, DX1) === RETP.releases[0].versionId && itemOf(rRetp26.body, 'DIAGNOSIS', DX1)?.edition?.activationStatus === 'RETIRED' && itemOf(rRetp26.body, 'DIAGNOSIS', DX1)?.edition?.retirementClassification === 'PROSPECTIVE' &&
      editionIdOf(rRetp27.body, DX1) === RETP.releases[1].versionId,
    'a RETIRED edition classified PROSPECTIVE still governs its own 2026 date (its basis names the retirement); 2027 resolves the current edition',
  )
  const [rReti26, rReti27, rRetu] = [await checkOf(RETI.encounters[0]), await checkOf(RETI.encounters[1]), await checkOf(RETU.encounters[0])]
  const classifyActive = await classifyRetirement({ datasetVersionId: EB.versionId, classification: 'PROSPECTIVE' })
  check(
    'CRG-038',
    'Historically invalidating retirement refuses selection',
    decisionOf(rReti26.body, DX1) === 'RELEASE_NOT_AUTHORIZED' && decisionOf(rRetu.body, DX1) === 'RELEASE_NOT_AUTHORIZED' && editionIdOf(rReti27.body, DX1) === RETI.releases[1].versionId && classifyActive.ok === false,
    'a RETIRED edition classified HISTORICALLY_INVALIDATED, and an unclassified one, refuse their dates (fail closed); other dates are unaffected; only a RETIRED edition can be classified',
  )
  const [rOvl, rOvlJan] = [await checkOf(OVL.encounters[0]), await checkOf(OVL.encounters[1])]
  check('CRG-039', 'Overlapping governing releases → CONFLICTING_RELEASES', decisionOf(rOvl.body, DX1) === 'CONFLICTING_RELEASES' && itemOf(rOvl.body, 'DIAGNOSIS', DX1)?.edition === null && editionIdOf(rOvlJan.body, DX1) === OVL.releases[0].versionId, 'two approved editions covering 2026-12-31 are CONFLICTING_RELEASES — neither is picked; only one covers 2026-01-15')
  const r20 = await checkOf(E20)
  check('CRG-040', 'No governing release → NO_APPROVED_RELEASE, no fallback', decisionOf(r20.body, DX1) === 'NO_APPROVED_RELEASE' && itemOf(r20.body, 'DIAGNOSIS', DX1)?.edition === null && decisionOf(r26.body, PHCPCS, 'PROCEDURE') === 'NO_APPROVED_RELEASE', 'a 2020 service before every edition, and a system with no edition, are NO_APPROVED_RELEASE; the newest edition is never used as a fallback')

  // ---------------------------------------------------------------- 05 code membership and refusal (CRG-041–050)
  section('05 Code membership and refusal: added, removed and changed codes are edition-bound; invalid, ambiguous, out-of-scope and malformed inputs refuse safely; nothing leaks; deterministic')
  check('CRG-041', 'Code added in B refused for an A service date', decisionOf(r26.body, DX3) === 'CODE_NOT_IN_RELEASE' && editionIdOf(r26.body, DX3) === EA.versionId && decisionOf(r27.body, DX3) === 'APPLICABLE', 'a code new in B is CODE_NOT_IN_RELEASE (naming edition A) on 2026-12-31 and APPLICABLE on 2027-01-01')
  check('CRG-042', 'Code removed in B accepted for A if valid', decisionOf(r26.body, DX2) === 'APPLICABLE' && decisionOf(r27.body, DX2) === 'CODE_NOT_IN_RELEASE' && editionIdOf(r27.body, DX2) === EB.versionId, 'a code removed in B is APPLICABLE on 2026-12-31 and CODE_NOT_IN_RELEASE (naming edition B) on 2027-01-01')
  const storedC1 = await prisma.crgReleaseCodeMembership.findMany({ where: { code: C1, datasetVersionId: { in: [EA.versionId, EB.versionId] } }, select: { datasetVersionId: true, sourceRowSha256: true } })
  check('CRG-043', 'Changed code meaning is edition-bound, not overwritten', storedC1.length === 2 && new Set(storedC1.map((r) => r.sourceRowSha256)).size === 2 && a1?.membership?.sourceRowSha256 === EA.rows.find((r) => r.code === C1)?.sourceRowSha256, 'both stored rows of the code remain, each with its own source-row SHA-256; activating B overwrote nothing in A')
  check('CRG-044', 'Invalid code → CODE_NOT_IN_RELEASE, not missing release', decisionOf(r26.body, DX9) === 'CODE_NOT_IN_RELEASE' && editionIdOf(r26.body, DX9) === EA.versionId, 'a well-formed code absent from the governing edition is CODE_NOT_IN_RELEASE with that edition named, never NO_APPROVED_RELEASE')
  check(
    'CRG-045',
    'Null/ambiguous code-system identity refuses',
    decisionOf(r26.body, PNULL, 'PROCEDURE') === 'AMBIGUOUS_CODE_SYSTEM' && decisionOf(r26.body, PLOWER, 'PROCEDURE') === 'AMBIGUOUS_CODE_SYSTEM' && decisionOf(r26.body, DXBAD) === 'AMBIGUOUS_CODE_SYSTEM' && itemOf(r26.body, 'PROCEDURE', PNULL)?.codeSystem === null,
    "a procedure stating no code system, one stating 'cpt' (not exactly CPT) and a diagnosis whose stored code is not canonical are AMBIGUOUS_CODE_SYSTEM",
  )
  const rWrong = await checkOf(EWRONG)
  check('CRG-046', 'Wrong jurisdiction or facility profile refuses', decisionOf(rWrong.body, DX1) === 'NO_APPROVED_RELEASE' && rWrong.body?.jurisdictionCode === 'AE-AZ' && rWrong.body?.authorityCode === AUTH, "a facility in AE-AZ with this run's authority never receives the AE-DU editions")
  check('CRG-047', 'Out-of-window service date refuses', decisionOf(r20.body, DX1) === 'NO_APPROVED_RELEASE' && decisionOf(rRetp27.body, DX1) === 'APPLICABLE' && editionIdOf(rRetp27.body, DX1) !== RETP.releases[0].versionId, 'a date before every window is refused, and an edition whose window ended is never used after it')
  const malformed = await Promise.all(['not-a-uuid', MISSING.replace(/-/g, ''), encodeURIComponent("1' OR '1'='1"), `${MISSING}0`].map((id) => checkOf(id)))
  const selectors = await Promise.all([get(`/api/encounters/${E26}/coding-release-check?asOf=2027-01-01`), get(`/api/encounters/${E26}/coding-release-check?edition=latest`), get(`/api/encounters/${E26}/coding-release-check?serviceDate=2027-01-01`)])
  const badDate = await importReferenceDatasetVersion({ datasetId: DX, version: 'bad-date', retrievedAt: new Date().toISOString(), effectiveFrom: '2027-02-30', effectiveTo: null, contentHash: fingerprint('bad') })
  check(
    'CRG-048',
    'Malformed date/UUID/SQL-shaped values refused safely',
    malformed.every((r) => r.status === 400 && !rawError(r.body)) && selectors.every((r) => r.status === 400 && !rawError(r.body)) && badDate.ok === false,
    'malformed and SQL-shaped encounter ids and every date, edition or as-of selector are a safe 400; an impossible calendar date is refused by A3',
  )
  const dtoText = JSON.stringify([r26.body, r27.body, rOvl.body])
  const dtoKeys = [...deepKeys([r26.body, r27.body])]
  check(
    'CRG-049',
    'No unexpected reference or tenant data leaked',
    same(Object.keys(r26.body), CHECK_KEYS) && r26.body.items.every((item: any) => same(Object.keys(item), ITEM_KEYS)) && same(Object.keys(a1?.edition ?? {}), EDITION_KEYS) &&
      ![C1, C2, C3, P1, `${runId}-P`, '1990-01-01', awayDx.id, otherOrg, 'Synthetic'].some((v) => dtoText.includes(v)) && !dtoKeys.some((k) => /patient|name|birth|display|descriptor|description|amount|price|payer/i.test(k)),
    'the answer carries ids, controlled codes and fingerprints only: no code value, patient, descriptor, amount, payer or other-tenant id',
  )
  const lifecycleA = [
    { action: 'VALIDATE', previousActivationStatus: 'INACTIVE', nextActivationStatus: 'INACTIVE', nextValidationStatus: 'VALIDATED' },
    { action: 'ACTIVATE', previousActivationStatus: 'INACTIVE', nextActivationStatus: 'ACTIVE', nextValidationStatus: 'VALIDATED' },
    { action: 'SUPERSEDE', previousActivationStatus: 'ACTIVE', nextActivationStatus: 'SUPERSEDED', nextValidationStatus: 'VALIDATED' },
  ]
  const pureInput: EditionFacts[] = [
    {
      datasetVersionId: EA.versionId, datasetId: DX, datasetJurisdictionCode: JUR, datasetAuthorityCode: AUTH, mappingCodeSystem: 'ICD-10-CM', mappingPurpose: 'CLAIM_CODING', mappingJurisdictionCode: JUR, mappingAuthorityCode: AUTH,
      version: '2021', effectiveFrom: '2021-01-01', effectiveTo: '2026-12-31', validationStatus: 'VALIDATED', activationStatus: 'SUPERSEDED', contentHash: EA.contentHash, sourceVersionId: sourceVersion.id, lifecycle: lifecycleA,
      importId: a1?.edition?.importId ?? randomUUID(), importSourceFileSha256: EA.contentHash, importExpectedRowCount: 2, importRowCount: 2, retirementClassification: null,
    },
  ]
  const pure = new Set(Array.from({ length: 100 }, () => JSON.stringify(resolveEdition({ serviceDate: '2026-12-31', jurisdictionCode: JUR, authorityCode: AUTH, rights: { 'ICD-10-CM': 'APPROVED' } }, 'ICD-10-CM', pureInput))))
  const repeated = await Promise.all([checkOf(E26), checkOf(E26), checkOf(E26, asViewer)])
  check(
    'CRG-050',
    'Pure resolver 100x identical decision and basis',
    pure.size === 1 && JSON.parse([...pure][0]).value?.edition?.referenceDatasetVersionId === EA.versionId && repeated.every((r) => withoutEvaluatedAt(r.body) === withoutEvaluatedAt(repeated[0].body)) && !/prisma|await |async |Date\.now|Math\.random|new Date|from '\.\.\/\.\.\/shared/.test(resolverCode),
    '100 pure resolutions of edition A are byte-identical; three reads (Admin and Viewer) answer identically except evaluatedAt; the resolver reads no database, clock or randomness',
  )

  // ---------------------------------------------------------------- 06–09 Checkpoint B (CRG-051–090)
  section('06–09 Checkpoint B (A5-VAL-2, receipts, PreClaimA6HandoffV2, A6-PAYLOAD-2, freeze V2): deferred, except what Checkpoint A can already prove')
  const checkpointB: [string, string][] = [
    ['CRG-051', 'Every active encounter diagnosis has an exact CRG evaluation'], ['CRG-052', 'Every relevant procedure-code activity has an exact evaluation'], ['CRG-053', 'Modifiers verified only against an approved rule'],
    ['CRG-054', 'Existing A4 ordering/modifier invariants still run'], ['CRG-055', 'New validator has an explicit immutable version'], ['CRG-056', 'New coding finding has approved layer, outcome and message'],
    ['CRG-057', 'Unresolved release blocks READY_FOR_REVIEW'], ['CRG-058', 'Existing coverage/contract/evidence decisions unchanged'], ['CRG-059', 'Client cannot supply serviceDate/edition in execute body'],
    ['CRG-060', 'One REPEATABLE READ snapshot for coding and context'], ['CRG-061', 'Each successful code check writes an exact receipt'], ['CRG-062', 'Each refused check has a controlled basis'],
    ['CRG-063', 'Receipt binds code target, code, release UUID and row hash'], ['CRG-064', 'Duplicate receipt per target/system/run refused'], ['CRG-065', 'PASS run with a missing receipt cannot commit'],
    ['CRG-066', 'Failure after a receipt rolls back fully'], ['CRG-067', 'Failure after a finding rolls back fully'], ['CRG-068', 'Foreign A3 release id in a receipt refused'],
    ['CRG-069', 'Legacy A5 runs readable without fabricated receipt'], ['CRG-070', 'Complete run manifest deterministic and replayable'], ['CRG-071', 'PreClaimA6HandoffV1 still accepts only A5-VAL-1'],
    ['CRG-072', 'V2 handoff rejects unsupported validator versions'], ['CRG-073', 'V2 requires exact complete coding receipts'], ['CRG-074', 'V1 handoff DTO bytes unchanged'],
    ['CRG-075', 'V2 refuses a stale newer run basis'], ['CRG-076', 'V2 refuses tied/ambiguous recency'], ['CRG-077', 'V2 refuses a wrong-encounter receipt'],
    ['CRG-078', 'V2 preserves eligibility, authorization, tariff ownership'], ['CRG-079', 'No request-selected validator or current version'], ['CRG-080', 'One bound handoff yields repeatable edition evidence'],
    ['CRG-081', 'A6-PAYLOAD-1 serializer keeps golden vectors'], ['CRG-082', 'V2 payload binds each target to its receipt'], ['CRG-083', 'V2 payload deterministic'],
    ['CRG-084', 'A6.5 human approval still required before freeze'], ['CRG-085', 'A6.7 freeze verifies receipts under one Claim lock'], ['CRG-086', 'V2 frozen bytes and manifest digest agree'],
  ]
  for (const [id, title] of checkpointB) deferTo(id, 'B', title, 'needs the separately approved A5-VAL-2 / receipts / PreClaimA6HandoffV2 / A6-PAYLOAD-2 contracts; Checkpoint A writes no validation run, receipt, handoff or freeze')
  check('CRG-087', 'Historical A6.7 frozen bytes unchanged after import', (await freezesHash()) === freezesAfterFixtures, 'after every later import, activation, retirement and check of this run, the CRG-034 freezes and sealed manifests are byte-identical')
  deferTo('CRG-088', 'B', 'A6.9 correction chain keeps independently frozen editions', 'per-edition freeze binding is A6-PAYLOAD-2; Checkpoint A proves only that the read keeps the original edition (CRG-034, CRG-089)')
  check('CRG-089', 'Past service date corrected later never adopts new edition', editionIdOf(t03After.body, DX1) === EA.versionId && corrected.status === 201, 'after the A6.9 correction and the activation of edition B, the 2026 service still resolves edition A (no automatic adoption)')
  deferTo('CRG-090', 'B', 'Unproven old frozen release labelled legacy', 'the legacy label belongs to the A6-PAYLOAD-2 read side; Checkpoint A certifies nothing retroactively')

  // ---------------------------------------------------------------- 10–11 Checkpoint C (CRG-091–110)
  section('10–11 Checkpoint C (A7/A8 read side, A9 adapter): deferred, except the no-write and no-intake guarantees Checkpoint A already holds')
  deferTo('CRG-091', 'C', 'A7 timeline reads bound receipt, not current edition', 'an A7 trace of receipts needs Checkpoint B receipts')
  deferTo('CRG-092', 'C', 'A7 older evidence without receipts reports UNKNOWN', 'A7 legacy labelling needs Checkpoint B receipts')
  const neighboursAfterCrg = await neighbours()
  check('CRG-093', 'A7 source and assessment bytes unchanged', neighboursAfterCrg.a7Sources === neighboursBefore.a7Sources && neighboursAfterCrg.a7Assessments === neighboursBefore.a7Assessments, 'every A7.1 source and A7.5 assessment row in the database is byte-identical after all CRG work of this run')
  deferTo('CRG-094', 'C', 'A7 delta compares versioned records, not remittance', 'an A7 delta over receipts needs Checkpoint B')
  deferTo('CRG-095', 'C', 'A7 gap explanation separates coding proof from payment', 'needs Checkpoint B receipts')
  deferTo('CRG-096', 'C', 'A8 coding issue intake requires approved basis', 'an A8.1 basis for coding conflicts needs a formally approved exception policy')
  check('CRG-097', 'Missing catalogue creates no exception intake', neighboursAfterCrg.intakes === neighboursBefore.intakes, 'NO_APPROVED_RELEASE, RELEASE_NOT_AUTHORIZED and CODE_NOT_IN_RELEASE answers of this run created no A8.1 intake')
  check('CRG-098', 'A8 triage/assignment never changed by CRG reader', neighboursAfterCrg.triage === neighboursBefore.triage && neighboursAfterCrg.investigation === neighboursBefore.investigation, 'every A8.2 triage and A8.3 investigation row is byte-identical after all CRG work')
  deferTo('CRG-099', 'C', 'A8 investigation cannot infer denial from coding', 'an A8 coding-conflict reference needs Checkpoint C policy')
  const beforeGets = await counts()
  const auditsBefore = await prisma.auditEvent.count()
  for (const id of [E26, E27, E20, ...OVL.encounters, EWRONG]) for (const who of [asAdmin, asViewer]) await checkOf(id, who)
  check(
    'CRG-100',
    'GETs write no row or business audit',
    (await unchanged(beforeGets)) && (await prisma.auditEvent.count()) === auditsBefore && /withReadSnapshot\(undefined, \(tx\) => getCodingReleaseCheckOf\(encounterId, tx\)\)/.test(serviceCode) && !/recordAuditEvent/.test(serviceCode),
    "fourteen coding-release reads changed no row in any CRG, A3, A4, A5, A6, A7 or A8 table and wrote no audit; the read runs in one READ ONLY snapshot (A7/A8 GETs are their owners', proven in the nested chain)",
  )
  for (const [id, title] of [
    ['CRG-101', 'Adapter receives exact frozen V2 code and edition'], ['CRG-102', 'Outbound code formatting destination-versioned'], ['CRG-103', 'Historical service date vs later submission handled'], ['CRG-104', 'Unsupported payer/eClaimLink version fails closed'],
    ['CRG-105', 'Unlicensed content never included without permission'], ['CRG-106', 'Different jurisdiction never gets Dubai-only mapping'], ['CRG-107', 'Corrected freeze not mistaken for external resubmission'], ['CRG-108', 'No external acknowledgement or paid status invented'],
    ['CRG-109', 'A9 contract tests use synthetic payloads, no network'], ['CRG-110', 'Actual A9 partner conformance RELEASE BLOCKED'],
  ] as const)
    deferTo(id, 'C', title, 'A9 adapter-facing contract; no A9 adapter exists and Checkpoint A sends nothing')

  // ---------------------------------------------------------------- 12 hardening (CRG-111–120)
  section('12 A10 hardening and security: replay, no reset, concurrent activation, unknown commit, date boundaries, no leakage; latency, driver warning and monitoring are pre-production obligations')
  check(
    'CRG-111',
    'Clean replay of every committed migration',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && appliedCount === headMigrationDirs.length && /PASS {2}the CRG Checkpoint A tables are exactly its five crg_ tables/.test(replay.output) && /PASS {2}crg_release_imports_complete_trg is present/.test(replay.output) && validate.ok && generate.ok,
    `${appliedCount} migrations applied cleanly from empty in a scratch database — exactly the ${headMigrationDirs.length} committed at HEAD; every CRG CHECK, unique key, guard, deferred trigger and RESTRICT key survives; Prisma validate and generate pass`,
  )
  const preRunStill = preRunEncounter ? await prisma.encounter.findUnique({ where: { id: preRunEncounter.id }, select: { updatedAt: true } }) : null
  check('CRG-112', 'Working DB not reset or modified destructively', status.ok && /Database schema is up to date/.test(status.output) && !!preRunEncounter && preRunStill?.updatedAt.getTime() === preRunEncounter.updatedAt.getTime(), 'the working database is up to date with every migration (never reset); a row that existed before this run is still present and unchanged')
  const RACE = await datasetFor('race', `${AUTH}-RACE`, 'ICD-10-CM')
  const R1 = await editionOf('race-1', RACE, { from: '2021-01-01', to: '2026-12-31' }, [C1])
  const R2 = await editionOf('race-2', RACE, { from: '2027-01-01', to: null }, [C1])
  await validated(R1)
  await validated(R2)
  const [act1, act2] = await Promise.all([activateReferenceDatasetVersion(R1.versionId, maintenanceActor), activateReferenceDatasetVersion(R2.versionId, maintenanceActor)])
  const raceStates = await prisma.referenceDatasetVersion.findMany({ where: { datasetId: RACE }, select: { activationStatus: true } })
  check(
    'CRG-113',
    'Concurrent activation never yields overlapping governance',
    act1.ok && act2.ok && raceStates.filter((s) => s.activationStatus === 'ACTIVE').length === 1 && raceStates.filter((s) => s.activationStatus === 'SUPERSEDED').length === 1 && decisionOf(rOvl.body, DX1) === 'CONFLICTING_RELEASES',
    "two activations of one dataset at once leave exactly one ACTIVE and one SUPERSEDED (A3's lock); editions overlapping across datasets are refused as CONFLICTING_RELEASES, never silently replaced",
  )
  block('CRG-114', 'Catalogue-size scale test meets approved latency budget', 'no latency budget has been approved yet (A10); the import path is bounded at 5000 rows per edition and every read is one indexed snapshot')
  const UNK = okValue('unknown-outcome version', await importReferenceDatasetVersion({ datasetId: PART_DS, version: 'unknown-outcome', retrievedAt: new Date().toISOString(), effectiveFrom: '2021-01-01', effectiveTo: null, contentHash: partHash })).id
  clearConcurrencyProbes()
  const lost = { reached: 0 }
  setConcurrencyProbe('codingRelease.rows_recorded', async () => {
    lost.reached += 1
    throw new Error('Connection terminated unexpectedly')
  })
  const lostOutcome = await attemptAdversarial(() => importRelease({ datasetVersionId: UNK, sourceFileSha256: partHash, sourceUri: 'synthetic:unknown', publisher: 'Synthetic', expectedRowCount: 2, rows: partRows }))
  clearConcurrencyProbes()
  check(
    'CRG-115',
    'Unknown commit outcome never blindly retried',
    lost.reached === 1 && /Connection terminated unexpectedly/.test(lostOutcome) && (await prisma.crgReleaseImport.count({ where: { datasetVersionId: UNK } })) === 0 && !/for \(let attempt|retry|MAX_\w*ATTEMPTS/.test(serviceCode),
    'a connection lost inside an import is surfaced to the caller exactly once — never retried — and nothing was committed; the writers have no retry loop',
  )
  block('CRG-116', 'PG connection/driver warning tracked until resolved', 'the pg "client.query() while executing" deprecation warning is tracked in the auditor-accepted A10 backlog; resolution is A10 work')
  const probeFile = join(tmpdir(), `crg-zones-${runId}.mjs`)
  writeFileSync(
    probeFile,
    `import { resolveEdition } from ${JSON.stringify(pathToFileURL(resolve('src/modules/coding-release/coding-release.resolver.ts')).href)}\n` +
      `const input = JSON.parse(process.env.CRG_IN ?? '{}')\n` +
      `console.log(JSON.stringify({ zone: Intl.DateTimeFormat().resolvedOptions().timeZone, a: resolveEdition({ ...input.scope, serviceDate: '2026-12-31' }, 'ICD-10-CM', input.facts), b: resolveEdition({ ...input.scope, serviceDate: '2027-01-01' }, 'ICD-10-CM', input.facts) }))\n`,
  )
  const zoneInput = JSON.stringify({ scope: { jurisdictionCode: JUR, authorityCode: AUTH, rights: { 'ICD-10-CM': 'APPROVED' } }, facts: pureInput })
  const zones = ['UTC', 'EST5EDT', 'CST6CDT', 'MST7MDT'].map((TZ) => {
    const out = spawnSync(process.execPath, [probeFile], { encoding: 'utf8', env: childEnv({ CRG_IN: zoneInput, TZ }), maxBuffer: 16 * 1024 * 1024 })
    try {
      return JSON.parse((out.stdout ?? '').trim()) as { zone: string; a: any; b: any }
    } catch {
      return { zone: 'unavailable', a: null, b: null }
    }
  })
  try {
    unlinkSync(probeFile)
  } catch {
    // the probe file is temporary; leaving it changes nothing
  }
  const serviceDates = await prisma.$queryRawUnsafe<{ d: string }[]>(`SELECT to_char(service_date, 'YYYY-MM-DD') AS d FROM encounters WHERE id = ANY($1::uuid[]) ORDER BY d`, [E26, E27])
  check(
    'CRG-117',
    'UTC/local date boundary uses SQL DATE exactly',
    new Set(zones.map((z) => z.zone)).size === 4 && zones.every((z) => z.a?.value?.edition?.edition === '2021' && z.b?.value?.decisionCode === 'NO_APPROVED_RELEASE') && same(serviceDates.map((r) => r.d), ['2026-12-31', '2027-01-01']) && r26.body.serviceDate === '2026-12-31' && r27.body.serviceDate === '2027-01-01',
    `the stored SQL DATEs 2026-12-31 and 2027-01-01 are read as calendar strings and the inclusive boundary resolves identically in processes running in ${zones.map((z) => z.zone).join(', ')}`,
  )
  block('CRG-118', 'Rights expiry and reference degradation monitored', 'monitoring and alerting are A10 operations; Checkpoint A already fails closed when rights are not APPROVED (CRG-027)')
  deferTo('CRG-119', 'B', 'Activation rollback stops new claims, keeps proof', 'stopping new claims is the Checkpoint B validator gate; Checkpoint A blocks no claim')
  check(
    'CRG-120',
    'No PHI, licensed descriptors or secrets in logs/errors',
    !/localStorage|sessionStorage|indexedDB|console\.|setInterval|setTimeout/.test(feCode) && !/console\.|logger\./.test(moduleCode) && [malformed[0], foreign, ...selectors].every((r) => same(Object.keys(r.body?.error ?? {}).sort(), ['code', 'message', 'requestId']) && !rawError(r.body)) &&
      [adminPassword, viewerPassword, admin.cookie, viewer.cookie, B.cookie, O.cookie].filter((s) => s.length > 8).every((s) => !printed.join('\n').includes(s)),
    'the module and page log nothing and store nothing in the browser; refusals carry only code, message and requestId; no password or cookie appears in this output',
  )

  // ---------------------------------------------------------------- 13 release evidence: nested regression (CRG-123–125)
  section('13 Release evidence — nested regression: A8.3 invoked, nesting A8.2 -> A8.1 -> A7.10 -> … -> A6.10 -> … -> A5 -> A1')
  await apiReady('the A8.3 and backward regression chain')
  const goldenBefore = { r26: withoutEvaluatedAt((await checkOf(E26)).body), r27: withoutEvaluatedAt((await checkOf(E27)).body), t03: withoutEvaluatedAt((await checkOf(T03.encounterId)).body) }
  const chain = run('npm run test:a8:exception-investigation')
  const nestedLog = `crg01-nested-${runId}.log`
  writeFileSync(nestedLog, chain.output)
  await waitFor(databaseUp, 90_000)
  await apiReady('the checks after the regression chain')
  const rows = suiteLines(chain.output, 'A8.3')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const a83NonApplicable: Record<string, string> = {
    T001: "A8.3 'A8.2 FINAL PASS merge is an ancestor' requires the A8.3 feature branch; this branch is from the main that contains the A8.3 merge (CRG-002)",
    T002: "A8.3 'Clean tree and origin parity' requires tracking origin/feature/a8-3-…; THIS branch's clean tree and parity are proved by CRG-002",
    T010: "A8.3 'Changed-file allowlist' lists the paths A8.3 was allowed to change; this branch legitimately changes its own (CRG-003)",
    T119: "A8.3 'Every historical branch-only N/A justified' proves A8.2's branch-only causes against the A8.3 branch; here they are re-proved on this branch",
    T130: "A8.3 'Second independent 130/130 run at exact HEAD' compares HEAD with origin/feature/a8-3-…; THIS run's identity is proved by CRG-121 and CRG-127",
  }
  const undocumented = failing.filter((id) => !(id in a83NonApplicable))
  const summary = chain.output.match(/\[A8\.3\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = summary ? Number(summary[2]) - Number(summary[1]) : -1
  const reconciled = failedCount >= 0 && failing.length === failedCount
  const ran = rows.some((row) => row.id === 'T130') && !/\[A8\.3\] RUN ABORTED|\[A8\.3\] uncaught error|\[A8\.3\] INVALID RUN/.test(chain.output)
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  const lineOfRow = (id: string) => rows.find((row) => row.id === id)?.line ?? ''
  const a83Passing = rows.filter((row) => !row.id.includes('/') && row.verdict === 'PASS').length
  for (const text of chain.output.split(/\r?\n/).filter((l) => / \.{3,} FAIL|RUN ABORTED|uncaught error|INVALID RUN/.test(l))) progress(`nested: ${text.slice(0, 400)}`)
  // Each documented failure must fail for its branch-only reason, proved independently on this branch, all the way
  // down: A8.3 T119's unproven A8.2 items, A8.2 T120's A8.1 items, A8.1 T110's A7.10 items and A7.10 T111's A7.9 items.
  const originOf = (name: string) => gitArgs(['rev-parse', '--verify', '--quiet', `origin/${name}`])
  const originCrg = originOf(crgBranch)
  const nestedLine = (depth: string[], id: string) =>
    chain.output.split(/\r?\n/).find((line) => new RegExp(`^\\[A8\\.3\\] +${depth.map((tag) => `nested: \\[${tag.replace('.', '\\.')}\\] +`).join('')}${id} `).test(line)) ?? ''
  const listAfter = (line: string, label: RegExp) => ((line.match(label) ?? ['', ''])[1] ?? '').split(', ').filter(Boolean)
  const inScope = (paths: string[]) => paths.length > 0 && paths.every((path, index) => changedPaths.includes(path) || (path === 'package.json beyond the one script' && changedPaths.includes('backend/package.json')) || (index === paths.length - 1 && changedPaths.some((p) => p.startsWith(path))))
  const onThisBranch = branch === crgBranch && dirty.length === 0 && tracking.includes(`origin/${crgBranch}`) && !/ahead|behind/.test(tracking)
  const failCount = (depth: string[]) => chain.output.split(/\r?\n/).filter((line) => new RegExp(`^\\[A8\\.3\\] +${depth.map((tag) => `nested: \\[${tag.replace('.', '\\.')}\\] +`).join('')}T\\d{3} .* \\.{3,} FAIL`).test(line)).length
  const unprovenA82 = listAfter(lineOfRow('T119'), /cause not proven for: (.*)$/)
  const a82Unexpected = listAfter(nestedLine(['A8.2'], 'T010'), /unexpected: (.*)$/)
  const unprovenA81 = listAfter(nestedLine(['A8.2'], 'T120'), /cause not proven for: (.*)$/)
  const a81Unexpected = listAfter(nestedLine(['A8.2', 'A8.1'], 'T010'), /unexpected: (.*)$/)
  const unprovenA710 = listAfter(nestedLine(['A8.2', 'A8.1'], 'T110'), /cause not proven for: (.*)$/)
  const a710Unexpected = listAfter(nestedLine(['A8.2', 'A8.1', 'A7.10'], 'T010'), /unexpected: (.*)$/)
  const unprovenA79 = listAfter(nestedLine(['A8.2', 'A8.1', 'A7.10'], 'T111'), /cause not proven for: (.*)$/).filter((id) => /^T\d{3}$/.test(id))
  const a710SelfCount = Number((nestedLine(['A8.2', 'A8.1', 'A7.10'], 'T130').match(/(\d+) of the 129 checks before this one PASS/) ?? [])[1] ?? -1)
  const a710Causes: Record<string, boolean> = {
    T001: onThisBranch && a710Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a710Merge} HEAD`),
    T002: onThisBranch,
    T010: inScope(a710Unexpected) && outOfScope.length === 0,
    T111: unprovenA79.length > 0 && unprovenA79.every((id) => ['T001', 'T002', 'T010', 'T120', 'T130'].includes(id)) && originOf(a79Branch) === '' && originOf(a78Branch) === '' && onThisBranch && outOfScope.length === 0,
    T122: originOf(a710Branch) === '' && originCrg === headAtStart,
    T123: originOf(a710Branch) === '' && originCrg === headAtStart,
    T130: a710SelfCount === 129 - (failCount(['A8.2', 'A8.1', 'A7.10']) - 1),
  }
  const a81Causes: Record<string, boolean> = {
    T001: onThisBranch && a81Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a81Merge} HEAD`) && a710Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a710Merge} HEAD`),
    T002: onThisBranch,
    T010: inScope(a81Unexpected) && outOfScope.length === 0,
    T110: unprovenA710.length > 0 && unprovenA710.every((id) => id in a710Causes && a710Causes[id]),
    T130: originCrg === headAtStart && originOf(a81Branch) !== headAtStart && /all evidence corresponds to/.test(nestedLine(['A8.2', 'A8.1'], 'T130')),
  }
  const a82Causes: Record<string, boolean> = {
    T001: onThisBranch && a81Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a81Merge} HEAD`) && a81FixMerge.length === 40 && gitOk(`merge-base --is-ancestor ${a81FixMerge} HEAD`),
    T002: onThisBranch,
    T010: inScope(a82Unexpected) && outOfScope.length === 0,
    T120: unprovenA81.length > 0 && unprovenA81.every((id) => id in a81Causes && a81Causes[id]),
    T130: originCrg === headAtStart && originOf(a82Branch) !== headAtStart && /all evidence corresponds to/.test(nestedLine(['A8.2'], 'T130')),
  }
  const causes: Record<string, boolean> = {
    T001: onThisBranch && a83Merge === A83_MERGE && a82Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a82Merge} HEAD`),
    T002: onThisBranch,
    T010: inScope(listAfter(lineOfRow('T010'), /unexpected: (.*)$/)) && outOfScope.length === 0,
    T119: unprovenA82.length > 0 && unprovenA82.every((id) => id in a82Causes && a82Causes[id]),
    T130: originCrg === headAtStart && originOf(a83Branch) !== headAtStart && failing.every((id) => id in a83NonApplicable),
  }
  const unprovenHere = failing.filter((id) => id in causes && !causes[id])
  const naLines = chain.output.split(/\r?\n/).filter((line) => /^\[A8\.3\] T111\/T\d+ .* N\/A {2}- \S/.test(line))
  check(
    'CRG-123',
    'Every applicable A2–A8 regression executes',
    ran && reconciled && a83Passing === 130 - failing.length && a83Passing >= 125 && ['T111', 'T112', 'T113', 'T114', 'T115', 'T116', 'T117', 'T118', 'T121', 'T125', 'T126', 'T127', 'T128', 'T129'].every((id) => verdictOf(id) === 'PASS'),
    !ran
      ? 'the A8.3 suite did not complete'
      : !reconciled
        ? `A8.3 reports ${failedCount} failure(s) but ${failing.length} could be named`
        : `${(chain.output.match(/\[A8\.3\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A8.3] automated summary: ', 'A8.3 ')}: A8.3, A8.2, A8.1, A7.10–A7.1, A6.10–A6.1, A5 and A1–A4 all executed with every substantive check PASS (T111–T118)`,
  )
  check(
    'CRG-124',
    'No substantive failed nested test marked N/A',
    ran && undocumented.length === 0 && unprovenHere.length === 0 && naLines.length === failCount(['A8.2']) && naLines.length >= 5,
    undocumented.length > 0
      ? `undocumented A8.3 failures: ${undocumented.join(', ')}`
      : unprovenHere.length > 0
        ? `cause not proven for: ${unprovenHere.join(', ')}`
        : `each documented failure (${failing.join(', ')}) fails only for its branch-only cause, proved on this branch all the way down (A8.2 ${unprovenA82.join(', ') || 'none'}; A8.1 ${unprovenA81.join(', ') || 'none'}; A7.10 ${unprovenA710.join(', ') || 'none'}; A7.9 ${unprovenA79.join(', ') || 'none'})`,
  )
  for (const id of Object.keys(a83NonApplicable)) if (failing.includes(id)) progress(`nested A8.3 ${id} is branch-only: ${a83NonApplicable[id]}`)
  check('CRG-125', 'All v1 golden vectors remain stable', verdictOf('T118') === 'PASS' && verdictOf('T116') === 'PASS' && same(contractsOwn, contractConstantsAt(ownBase)), 'the nested A6.10 → A6.1 chain (A6.6 A6-PAYLOAD-1 golden vectors included) and A8.3 pass, and every v1 contract literal is unchanged')

  // ---------------------------------------------------------------- build gates and exact evidence
  section('Build gates and exact evidence: units, typecheck, frontend, outage and recovery, golden decisions after restart, 5xx, allowlist and checksums, two runs, blocked obligations')
  const ownUnit = run(`node --test ${UNIT_TESTS.map((file) => file.replace('backend/', '')).join(' ')}`)
  const allUnit = run('npm run test:unit')
  check('CRG-G01', 'Backend unit tests pass', allUnit.ok && /ℹ fail 0/.test(allUnit.output) && ownUnit.ok && /ℹ pass 13/.test(ownUnit.output), `${(allUnit.output.match(/ℹ pass \d+/) ?? ['unit output unavailable'])[0]}, including the 13 CRG resolver and request tests`)
  check('CRG-G02', 'Backend typecheck clean', run('npm run typecheck').ok, 'backend typecheck clean, including this harness')
  check('CRG-G03', 'Frontend lint clean', run('npm run lint --prefix ../frontend').ok, 'frontend lint clean')
  const build = run('npm run build --prefix ../frontend')
  check('CRG-G04', 'Frontend build clean', build.ok, `${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}`)
  await apiReady('the DB outage check')
  const upHealth = await health()
  const upReady = await ready()
  const stopped = spawnSync('docker', ['stop', dbContainer], { encoding: 'utf8' }).status === 0
  const downReady = await waitFor(async () => (await ready()) === 503, 30_000)
  const downSamples: number[] = []
  for (let i = 0; i < 5; i += 1) {
    downSamples.push(await health())
    await pause(400)
  }
  const restarted = spawnSync('docker', ['start', dbContainer], { encoding: 'utf8' }).status === 0
  const recovered = await waitFor(async () => (await ready()) === 200, 90_000)
  await waitFor(databaseUp, 60_000)
  check('CRG-G05', 'Health 200 / ready 503 / DB recovery', upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered, 'up 200/200; with the database stopped health stayed 200 and ready reported 503; recovery 200')
  const goldenAfter = { r26: withoutEvaluatedAt((await checkOf(E26)).body), r27: withoutEvaluatedAt((await checkOf(E27)).body), t03: withoutEvaluatedAt((await checkOf(T03.encounterId)).body) }
  progress(`golden decisions: encounter ${E26} (2026-12-31) → edition 2021 ${EA.versionId}; encounter ${E27} (2027-01-01) → edition 2024 ${EB.versionId}; resubmitted claim ${T03.claimId} stays on 2021`)
  check('CRG-G06', 'Golden decisions byte-stable after restart', same(goldenAfter, goldenBefore), 'after the nested chain, its database restarts and an outage, the 2026, 2027 and resubmitted-claim decisions read back identically')
  check('CRG-126', 'Zero unexpected 5xx', serverErrors === 0 && connectionResets === 0, `${serverErrors} HTTP 5xx answers and ${connectionResets} connection resets in this run`)
  const headNow = git('rev-parse HEAD')
  check(
    'CRG-127',
    'Git diff allowlist, origin parity and SHA evidence',
    outOfScope.length === 0 && headNow === headAtStart && headNow === originCrg && git('status --porcelain') === '' && checksumMismatch.length === 0 && applied.length === headMigrationDirs.length,
    `HEAD ${headNow} (= origin/${crgBranch}); ${tracking}; ${changedPaths.length} allowlisted paths; all ${applied.length} applied migrations match their committed checksums`,
  )
  check(
    'CRG-121',
    'Checkpoint A completed twice at one exact HEAD with logs',
    headNow === headAtStart && headNow === originCrg && headNow.length === 40 && /^CRG-\d{13}$/.test(runId) && existsSync(nestedLog),
    `all evidence corresponds to ${headNow}; fresh runId ${runId}; nested output kept in backend/${nestedLog} (SHA-256 ${sha256Of(Buffer.from(chain.output)).slice(0, 16)}…); the two submitted runs must both state this HEAD`,
  )
  deferTo('CRG-122', 'B', 'Checkpoint B completed twice at one exact HEAD', 'Checkpoint B is a separate, later package')
  block('CRG-128', 'Official circular date/rule and licences signed before import', "SRC-01 is DRAFT and every real code system's rights are BLOCKED; no real import exists and none can be selected until signed")
  block('CRG-129', 'A9/A10 end-to-end acceptance signed before production', 'A9 and A10 do not exist yet; production activation is not authorized')
  const missingIds = Array.from({ length: 130 }, (_, i) => `CRG-${String(i + 1).padStart(3, '0')}`).filter((id) => !reported.has(id) && id !== 'CRG-130')
  check(
    'CRG-130',
    'Unresolved risks logged as BLOCKED, never false PASS',
    missingIds.length === 0 && blocked.length === 5 && ['CRG-114', 'CRG-116', 'CRG-118', 'CRG-128', 'CRG-129'].every((id) => blocked.includes(id)) && deferred.length === 56,
    missingIds.length > 0 ? `not reported: ${missingIds.join(', ')}` : `every one of the 130 assertions is reported once: BLOCKED ${blocked.join(', ')}; ${deferred.length} DEFERRED to Checkpoints B and C; none counted as PASS`,
  )

  say(`\n[${TAG}] run ${runId} — HEAD ${headNow}`)
  if (failures.length > 0) {
    say(`[${TAG}] ${failures.length} FAILED:`)
    for (const failure of failures) say(`          ${failure}`)
  }
  say(`[${TAG}] decision vocabulary ${decisionCodes.join(', ')}; code systems ${codeSystems.join(', ')}`)
  say(`[${TAG}] DEFERRED (${deferred.length}): ${deferred.join(', ')}`)
  say(`[${TAG}] BLOCKED (${blocked.length}): ${blocked.join(', ')}`)
  if (connectionResets > 0) say(`[${TAG}] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  say(`[${TAG}] automated summary: ${passed}/${passed + failed} PASS (executed assertions and gates); ${deferred.length} DEFERRED; ${blocked.length} BLOCKED`)
  say(failed === 0 ? `[${TAG}] CHECKPOINT A ACCEPTANCE COMPLETE — regulatory compliance NOT ESTABLISHED (source, rights, Checkpoints B/C, A9 and A10 pending)` : `[${TAG}] CRG-01 CHECKPOINT A FINAL FAIL`)
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
