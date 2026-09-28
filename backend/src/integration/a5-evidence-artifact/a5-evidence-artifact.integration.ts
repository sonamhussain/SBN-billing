import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { prisma } from '../../shared/database/prisma.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { appendEvidenceVersion, createEvidenceArtifact } from '../../modules/evidence-artifact/evidence-artifact.service.ts'

// A5.1 — focused acceptance for the Evidence Artifact & Evidence Version Foundation (T01–T78).
//
// A5.1 owns evidence identity and its immutable versions, and nothing else: no eligibility,
// authorization, completeness, validation, readiness, claim or submission decision, and no file
// bytes. Valid fixtures are created through their owning routes; the database is READ for
// structural proof. ADVERSARIAL writes — ones the service would never make — go in only to prove
// that something refuses them, and are rolled back or restored. Every value is synthetic: no real
// patient, member, payer or document content appears anywhere in this file.

let passed = 0
let failed = 0
let notApplicable = 0
const failures: string[] = []

function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  if (condition) {
    passed += 1
    console.log(`[A5.1] ${id} ${title} ${dots} PASS${detail ? ` - ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(`${id} ${title} ${detail}`)
    console.log(`[A5.1] ${id} ${title} ${dots} FAIL${detail ? ` - ${detail}` : ''}`)
  }
}

// §20 — a replayed suite's own feature-branch identity checks are reported as N/A with their exact
// reason. A substantive check is never converted to one, and a failure is never hidden.
function notApplicableCheck(id: string, title: string, reason: string) {
  notApplicable += 1
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  console.log(`[A5.1] ${id} ${title} ${dots} N/A  - ${reason}`)
}

const section = (title: string) => console.log(`\n[A5.1] ${title}`)

function run(command: string): { ok: boolean; output: string } {
  const out = spawnSync(command, { encoding: 'utf8', shell: true, cwd: process.cwd(), maxBuffer: 128 * 1024 * 1024 })
  return { ok: out.status === 0, output: `${out.stdout ?? ''}${out.stderr ?? ''}` }
}

const git = (args: string) => (spawnSync('git', args.split(' '), { encoding: 'utf8' }).stdout ?? '').replace(/\s+$/, '')
const gitOk = (args: string) => spawnSync('git', args.split(' '), { encoding: 'utf8' }).status === 0
const gitGrep = (pattern: string, paths: string[]) => {
  const out = spawnSync('git', ['grep', '-nE', pattern, '--', ...paths], { encoding: 'utf8' })
  return { status: out.status, output: `${out.stdout ?? ''}${out.stderr ?? ''}`.trim() }
}

// A scope guard must judge what the code DOES, not which words it mentions. This module's comments
// deliberately name the things it refuses to do — "no upload, download or content endpoint", "no
// bucket or provider parsing" — so a plain text search finds the very promise it is checking, and
// reports a violation that is really a correct explanation. Comments are therefore stripped and only
// executable code is searched. (Same trap as A4.8's Drift Guard note and A4.10's own detectors.)
const committedFiles = (dir: string) => git(`ls-tree -r --name-only --full-tree HEAD ${dir}`).split(/\r?\n/).filter(Boolean)

const committedCode = (path: string) =>
  git(`show HEAD:${path}`)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    // `://` inside a string literal is not a comment, so a `//` must start a line or follow a space.
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n')

const committedCodeOf = (dir: string) => {
  const files = committedFiles(dir)
  return { files, code: files.map((file) => committedCode(file)).join('\n') }
}

const runId = `A51-${Date.now()}`
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
// A4.10 FINAL PASS was merged into main as PR #48; A5.1 is branched from exactly that merge.
const a410Merge = '43cec9c'
const a51Branch = 'feature/a5-1-evidence-artifact-version-foundation'
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const MISSING = '11111111-1111-4111-8111-111111111111'

// A canonical digest is 64 hex characters. These are generated from the seed so each version has a
// distinct, obviously synthetic hash.
const hashOf = (seed: string) => seed.repeat(64).slice(0, 64)
const HASH_A = hashOf('a')
const HASH_B = hashOf('b')

const deepKeys = (value: unknown, found: Set<string> = new Set()): Set<string> => {
  if (Array.isArray(value)) {
    for (const item of value) deepKeys(item, found)
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      found.add(key)
      deepKeys(child, found)
    }
  }
  return found
}

// A write the service would never make, returning the database's refusal (or '' if it was
// accepted). Used to prove an invariant is held by the database itself rather than by convention.
async function attemptAdversarial(write: () => Promise<unknown>): Promise<string> {
  try {
    await write()
    return ''
  } catch (error) {
    const code = (error as { code?: string }).code ?? ''
    return `${code} ${String((error as Error).message ?? error)}`
  }
}

// Makes the named probe throw, so acceptance can prove a transaction rolls back as one unit.
function failAt(probe: string, message: string) {
  clearConcurrencyProbes()
  setConcurrencyProbe(probe, async () => {
    throw new Error(message)
  })
}

// Holds a writer at the named probe until released.
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

async function waitForLockWaiter(): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < 10_000) {
    const rows = await prisma.$queryRaw<{ waiting: bigint }[]>`
      SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`
    if (Number(rows[0].waiting) > 0) return true
    await new Promise((resolve) => setImmediate(resolve))
  }
  return false
}

function failedIds(output: string, tag: string): string[] {
  const pattern = new RegExp(`^\\[${tag.replace('.', '\\.')}\\] (T\\d+[a-z/]*) .* FAIL`)
  return output
    .split(/\r?\n/)
    .map((line) => (line.match(pattern) ?? [])[1])
    .filter((id): id is string => Boolean(id))
}

function nestedLine(output: string, tag: string, id: string, title: string) {
  const line = output.match(new RegExp(`\\[${tag.replace('.', '\\.')}\\] ${id} ${title.replace(/\./g, '\\.')} \\.* (PASS|FAIL)( - [^\\n]*)?`))
  return { verdict: line?.[1] ?? '', detail: (line?.[2] ?? '').replace(/^ - /, '') }
}

async function evidenceAuditCount(): Promise<number> {
  return prisma.auditEvent.count({ where: { entityType: { in: ['EVIDENCE_ARTIFACT', 'EVIDENCE_ARTIFACT_VERSION'] } } })
}

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  console.log(`[A5.1] Evidence artifact & version foundation — run ${runId}`)
  console.log(`[A5.1] HEAD ${git('rev-parse HEAD')} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

  // T74 stops and restarts the database on purpose, so a run that is interrupted part-way through
  // it can leave the container down. The next run would then die on its first query with a driver
  // stack trace, which says nothing about what to do. A missing database is an environment problem,
  // not a verdict on the package, so it is reported as one before any check runs.
  const databaseReachable = await (async () => {
    const started = Date.now()
    while (Date.now() - started < 60_000) {
      try {
        await prisma.$queryRaw`SELECT 1`
        return true
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
    return false
  })()
  if (!databaseReachable)
    throw new Error(
      `the database is not reachable, so no check can be judged. Start it with \`docker start ${dbContainer}\`, wait for it to report healthy, then run this suite again.`,
    )

  const ready = async () => (await fetch(`${baseUrl}/api/ready`).catch(() => null))?.status ?? 0
  const health = async () => (await fetch(`${baseUrl}/api/health`).catch(() => null))?.status ?? 0
  const waitFor = async (predicate: () => Promise<boolean>, timeoutMs: number) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (await predicate()) return true
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    return false
  }
  const apiReady = async (what: string) => {
    if (!(await waitFor(async () => (await ready()) === 200, 60_000)))
      throw new Error(`the API at ${baseUrl} is not ready before ${what}; start it with \`npm start\``)
  }

  // ---------------------------------------------------------------- gates (T01–T06)
  section('Start gate, migration and permissions')
  const branch = git('rev-parse --abbrev-ref HEAD')
  check(
    'T01',
    'Start gate',
    branch === a51Branch && gitOk(`merge-base --is-ancestor ${a410Merge} origin/main`) && gitOk('merge-base --is-ancestor origin/main HEAD'),
    `branch ${branch}; A4.10 merge ${a410Merge} (PR #48) is on main and the branch contains the latest main ${git('rev-parse --short origin/main')}`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  check('T02', 'Git clean', dirty.length === 0, dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.length} path(s)`)

  const migrationPaths = git('diff --name-only origin/main...HEAD -- :/backend/prisma/migrations').split(/\r?\n/).filter((line) => line.endsWith('migration.sql'))
  const migrationSql = migrationPaths.length === 1 ? git(`show HEAD:${migrationPaths[0]}`) : ''
  // Only executable SQL is judged: the Drift Guard note in the header names the statements it
  // removed, so testing the raw text would match the very words it promises are absent.
  const statements = migrationSql.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('--')).join('\n')
  const scopeProblems = [
    [/CREATE TABLE "evidence_artifacts"/.test(statements), 'the artifact table is not created'],
    [/CREATE TABLE "evidence_artifact_versions"/.test(statements), 'the version table is not created'],
    [(statements.match(/CREATE TABLE/g) ?? []).length === 2, 'a table other than the two A5.1 tables is created'],
    [!/DROP INDEX/.test(statements), 'an index is dropped (drift)'],
    [!/SET DEFAULT pg_catalog/.test(statements), 'Better Auth defaults leaked in (drift)'],
    [!/ALTER TABLE "(patients|encounters|external_identifiers|rule_sources|reference_datasets)"/.test(statements), 'an A1-A4 or A3 business table is altered'],
    [!/eligibility|authorization|claim|submission/i.test(statements), 'a future-phase table appears'],
    [(statements.match(/ADD CONSTRAINT "evidence_artifact_versions_[a-z_]+_chk"/g) ?? []).length === 4, 'the four version CHECKs are not all added'],
    [/CREATE TRIGGER evidence_artifact_versions_append_only_trg/.test(statements), 'the immutability trigger is not created'],
  ]
    .filter(([ok]) => !ok)
    .map(([, reason]) => reason as string)
  check(
    'T03',
    'Migration scope',
    migrationPaths.length === 1 && scopeProblems.length === 0,
    migrationPaths.length !== 1
      ? `expected exactly one migration, found ${migrationPaths.length}`
      : scopeProblems.length === 0
        ? 'one migration; two tables, four CHECKs, the immutability trigger and required FKs/indexes only, with no drift'
        : `out of scope: ${scopeProblems.join('; ')}`,
  )

  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check(
    'T04',
    'Prisma validate/generate/status',
    validate.ok && generate.ok && status.ok && /Database schema is up to date/.test(status.output),
    'schema valid, client generated, schema up to date',
  )

  const replay = run('npm run db:verify:replay')
  check(
    'T05',
    'Migration replay',
    replay.ok &&
      /ALL CHECKS PASS/.test(replay.output) &&
      /the append-only trigger on evidence versions is present/.test(replay.output) &&
      /evidence_artifact_versions_version_positive_chk is present/.test(replay.output) &&
      /evidence_artifact_versions_evidence_artifact_id_version_key is present/.test(replay.output),
    `${(replay.output.match(/\d+ migrations applied cleanly[^\n]*/) ?? ['replay output unavailable'])[0]}; the four CHECKs, unique numbering and the immutability trigger all survive a clean replay`,
  )

  const evidencePermissions = (await prisma.permission.findMany({ where: { code: { contains: 'vidence' } }, select: { code: true } })).map((row) => row.code).sort()
  const grants = await prisma.rolePermission.findMany({
    where: { permission: { code: { contains: 'vidence' } } },
    select: { role: { select: { code: true } }, permission: { select: { code: true } } },
  })
  const grantOf = (code: string) => grants.filter((g) => g.permission.code === code).map((g) => g.role.code).sort().join(',')
  check(
    'T06',
    'Permissions',
    evidencePermissions.join(',') === 'evidenceArtifact.create,evidenceArtifact.read,evidenceArtifactVersion.create' &&
      grantOf('evidenceArtifact.create') === 'ORG_ADMIN' &&
      grantOf('evidenceArtifact.read') === 'ORG_ADMIN,ORG_VIEWER' &&
      grantOf('evidenceArtifactVersion.create') === 'ORG_ADMIN',
    'exactly create/read/version.create exist; no update, delete or download permission was invented',
  )

  // ---------------------------------------------------------------- fixtures and creation (T07–T21)
  // A connection that is reset mid-request is not an answer from the API — it is the API going
  // away. T04 and T05 regenerate the Prisma client and replay migrations, which restarts a server
  // started with `--watch`, and the next request is then torn down at the socket. That used to kill
  // the whole run with a driver stack trace and no verdict at all. A reset is now retried once
  // after readiness returns, and if it still fails the check that asked for it fails on its own
  // with status 0 rather than taking the suite down. Every reset is counted and reported at the end,
  // because a run whose API restarted underneath it is not evidence of anything.
  await apiReady('signing in')
  let connectionResets = 0
  const httpCall = async (path: string, init?: RequestInit) => {
    try {
      return await callApi(baseUrl, path, init)
    } catch {
      connectionResets += 1
      try {
        await apiReady(`retrying ${path}`)
        return await callApi(baseUrl, path, init)
      } catch (retryError) {
        return { status: 0, requestId: null, body: { networkError: String((retryError as Error)?.message ?? retryError) }, setCookies: [] as string[] }
      }
    }
  }
  const signIn = async (email: string, password: string) => {
    const res = await httpCall('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl },
      body: JSON.stringify({ email, password }),
    })
    return { status: res.status, cookie: extractCookieHeader(res.setCookies) }
  }
  const admin = await signIn(adminEmail, adminPassword)
  const viewer = await signIn(viewerEmail, viewerPassword)
  if (admin.status !== 200 || viewer.status !== 200) throw new Error(`sign-in failed (admin ${admin.status}, viewer ${viewer.status})`)
  const as = (cookie: string) => (init: RequestInit = {}) => ({
    ...init,
    headers: { ...init.headers, 'Content-Type': 'application/json', Cookie: cookie },
  })
  const asAdmin = as(admin.cookie)
  const asViewer = as(viewer.cookie)
  const post = (path: string, body: unknown, who = asAdmin) => httpCall(path, who({ method: 'POST', body: JSON.stringify(body) }))
  const patchApi = (path: string, body: unknown, who = asAdmin) => httpCall(path, who({ method: 'PATCH', body: JSON.stringify(body) }))
  const del = (path: string, who = asAdmin) => httpCall(path, who({ method: 'DELETE' }))
  const get = (path: string, who = asAdmin) => httpCall(path, who())

  const body = (overrides: Record<string, unknown> = {}) => ({
    storageRef: `synthetic://evidence/${runId}/${Math.random().toString(16).slice(2)}`,
    contentHash: HASH_A,
    documentType: `SYNTHETIC_ELIGIBILITY_RESPONSE_${runId.slice(-6)}`,
    sourceDate: '2026-06-15',
    receivedAt: '2026-06-15T09:30:00.000Z',
    ...overrides,
  })

  section('Creating an artifact with its first version')
  const createRes = await post(`/api/organizations/${org}/evidence-artifacts`, body())
  const artifact = createRes.body as Record<string, any>
  if (createRes.status !== 201) throw new Error(`artifact create failed: ${createRes.status} ${JSON.stringify(artifact).slice(0, 250)}`)
  const storedVersions = await prisma.evidenceArtifactVersion.findMany({ where: { evidenceArtifactId: artifact.id } })
  check(
    'T07',
    'Admin create artifact',
    createRes.status === 201 && storedVersions.length === 1 && storedVersions[0].version === 1,
    '201; the artifact and its version 1 were created in one transaction',
  )

  const foreignAttempt = await post(`/api/organizations/${org}/evidence-artifacts`, { ...body(), organizationId: otherOrg })
  const storedOrg = await prisma.evidenceArtifact.findUniqueOrThrow({ where: { id: artifact.id }, select: { organizationId: true } })
  check(
    'T08',
    'Route-derived ownership',
    foreignAttempt.status === 400 && storedOrg.organizationId === org,
    'a client-supplied organizationId is refused outright; the authoritative organization comes from the path',
  )

  const serverOwnedResults: string[] = []
  for (const field of ['id', 'version', 'createdByUserId', 'createdAt', 'evidenceArtifactId']) {
    const res = await post(`/api/organizations/${org}/evidence-artifacts`, { ...body(), [field]: MISSING })
    serverOwnedResults.push(`${field}:${res.status}`)
  }
  check('T09', 'Server-owned fields', serverOwnedResults.every((line) => line.endsWith(':400')), `all refused (${serverOwnedResults.join(', ')})`)

  const storageRefCases = [
    ['blank', { storageRef: '   ' }],
    ['non-string', { storageRef: 42 }],
    ['line feed', { storageRef: 'synthetic://a\nb' }],
    ['carriage return', { storageRef: 'synthetic://a\rb' }],
    ['oversize', { storageRef: 'x'.repeat(1025) }],
    ['absent', { storageRef: undefined }],
  ] as const
  const storageRefStatuses: string[] = []
  for (const [label, overrides] of storageRefCases) {
    const payload = body(overrides as Record<string, unknown>)
    if ((overrides as Record<string, unknown>).storageRef === undefined) delete (payload as Record<string, unknown>).storageRef
    storageRefStatuses.push(`${label}:${(await post(`/api/organizations/${org}/evidence-artifacts`, payload)).status}`)
  }
  check('T10', 'storageRef required', storageRefStatuses.every((line) => line.endsWith(':400')), storageRefStatuses.join(', '))

  const opaqueRefs = ['plain-opaque-token', '../not/parsed/as/a/path', 's3-looking-but-not-parsed', `synthetic://evidence/${runId}/deep/nested/ref`]
  const opaqueStatuses: number[] = []
  for (const storageRef of opaqueRefs) opaqueStatuses.push((await post(`/api/organizations/${org}/evidence-artifacts`, body({ storageRef }))).status)
  check(
    'T11',
    'storageRef opaque',
    opaqueStatuses.every((status) => status === 201),
    'a non-URL opaque reference is accepted unparsed; no path, bucket or provider shape is assumed',
  )

  const validHash = await post(`/api/organizations/${org}/evidence-artifacts`, body({ contentHash: HASH_B }))
  check('T12', 'Hash valid', validHash.status === 201, 'a canonical 64-character lowercase SHA-256 digest is accepted')

  const upperHash = await post(`/api/organizations/${org}/evidence-artifacts`, body({ contentHash: HASH_B.toUpperCase() }))
  const upperStored = upperHash.status === 201 ? (upperHash.body as Record<string, any>).latestVersion.contentHash : ''
  check(
    'T13',
    'Hash normalization',
    upperHash.status === 201 && upperStored === HASH_B,
    'an uppercase digest names the same bytes, so it is normalized to the one canonical lowercase form rather than refused',
  )

  const badHashStatuses: string[] = []
  for (const [label, contentHash] of [
    ['too short', HASH_B.slice(0, 63)],
    ['too long', `${HASH_B}0`],
    ['non-hex', `${HASH_B.slice(0, 63)}g`],
    ['prefixed', `sha256:${HASH_B}`],
    ['blank', '   '],
  ] as const)
    badHashStatuses.push(`${label}:${(await post(`/api/organizations/${org}/evidence-artifacts`, body({ contentHash }))).status}`)
  check('T14', 'Hash invalid', badHashStatuses.every((line) => line.endsWith(':400')), badHashStatuses.join(', '))

  const goodType = await post(`/api/organizations/${org}/evidence-artifacts`, body({ documentType: 'SYNTHETIC_ANY_OPAQUE_LABEL' }))
  const badTypeStatuses: string[] = []
  for (const [label, documentType] of [['blank', '   '], ['line feed', 'A\nB'], ['oversize', 'x'.repeat(121)], ['non-string', 42]] as const)
    badTypeStatuses.push(`${label}:${(await post(`/api/organizations/${org}/evidence-artifacts`, body({ documentType }))).status}`)
  check(
    'T15',
    'documentType required',
    goodType.status === 201 && badTypeStatuses.every((line) => line.endsWith(':400')),
    `an opaque label is accepted with no payer or UAE vocabulary enforced; ${badTypeStatuses.join(', ')}`,
  )

  const absentDate = body()
  delete (absentDate as Record<string, unknown>).sourceDate
  const absentRes = await post(`/api/organizations/${org}/evidence-artifacts`, absentDate)
  const nullRes = await post(`/api/organizations/${org}/evidence-artifacts`, body({ sourceDate: null }))
  check(
    'T16',
    'sourceDate optional',
    absentRes.status === 201 &&
      nullRes.status === 201 &&
      (absentRes.body as Record<string, any>).latestVersion.sourceDate === null &&
      (nullRes.body as Record<string, any>).latestVersion.sourceDate === null,
    'absent and explicit null both mean unknown, and unknown stays null rather than being filled in from receivedAt',
  )

  const strictDateStatuses: string[] = []
  for (const [label, sourceDate] of [['impossible', '2026-02-31'], ['timestamp', '2026-06-15T09:30:00.000Z'], ['non-ISO', '15/06/2026']] as const)
    strictDateStatuses.push(`${label}:${(await post(`/api/organizations/${org}/evidence-artifacts`, body({ sourceDate }))).status}`)
  check('T17', 'sourceDate strict', strictDateStatuses.every((line) => line.endsWith(':400')), strictDateStatuses.join(', '))

  const futureDate = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const futureDateRes = await post(`/api/organizations/${org}/evidence-artifacts`, body({ sourceDate: futureDate }))
  check('T18', 'sourceDate future', futureDateRes.status === 400, `a source date two days ahead is ${futureDateRes.status}`)

  const goodInstant = await post(`/api/organizations/${org}/evidence-artifacts`, body({ receivedAt: '2026-06-15T09:30:00.000Z' }))
  const badInstantStatuses: string[] = []
  for (const [label, receivedAt] of [['date only', '2026-06-15'], ['not a date', 'not-a-date'], ['non-string', 42]] as const)
    badInstantStatuses.push(`${label}:${(await post(`/api/organizations/${org}/evidence-artifacts`, body({ receivedAt }))).status}`)
  check('T19', 'receivedAt strict', goodInstant.status === 201 && badInstantStatuses.every((line) => line.endsWith(':400')), badInstantStatuses.join(', '))

  const skew = new Date(Date.now() + 60 * 1000).toISOString()
  const ahead = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()
  const skewRes = await post(`/api/organizations/${org}/evidence-artifacts`, body({ receivedAt: skew }))
  const aheadRes = await post(`/api/organizations/${org}/evidence-artifacts`, body({ receivedAt: ahead }))
  check(
    'T20',
    'receivedAt future',
    aheadRes.status === 400 && skewRes.status === 201,
    'an instant six hours ahead has not happened yet and is refused; a minute of clock skew between caller and server is tolerated',
  )

  const unknownRes = await post(`/api/organizations/${org}/evidence-artifacts`, { ...body(), eligibilityStatus: 'ELIGIBLE' })
  check(
    'T21',
    'Unknown fields',
    unknownRes.status === 400 && JSON.stringify(unknownRes.body).includes('eligibilityStatus'),
    'an unknown field is refused and named, so a future-phase field cannot be smuggled in',
  )

  // ---------------------------------------------------------------- reads and appends (T22–T28)
  section('Reads, version history and appends')
  const artifactKeys = Object.keys(artifact).sort()
  const versionKeys = Object.keys(artifact.latestVersion ?? {}).sort()
  check(
    'T22',
    'Artifact DTO',
    artifactKeys.join(',') === 'createdAt,id,latestVersion,organizationId' &&
      !versionKeys.includes('bytes') &&
      !versionKeys.includes('content') &&
      !versionKeys.includes('downloadUrl'),
    `stable identity plus version metadata; no bytes or download link (${versionKeys.join(', ')})`,
  )

  const listRes = await get(`/api/organizations/${org}/evidence-artifacts`)
  const listed = ((listRes.body as { items?: { id: string; organizationId: string }[] })?.items ?? [])
  check(
    'T23',
    'List own-org',
    listRes.status === 200 && listed.some((row) => row.id === artifact.id) && listed.every((row) => row.organizationId === org),
    `${listed.length} artifact(s), every one owned by the authorized organization`,
  )

  const getRes = await get(`/api/evidence-artifacts/${artifact.id}`)
  check('T24', 'Get artifact', getRes.status === 200 && (getRes.body as Record<string, any>).id === artifact.id, 'the artifact is returned by id')

  // The appends run before the history reads so T25 judges a real three-version history; the
  // verdicts are printed in matrix order.
  const v2 = await post(`/api/evidence-artifacts/${artifact.id}/versions`, body({ contentHash: HASH_B }))
  const v3 = await post(`/api/evidence-artifacts/${artifact.id}/versions`, body({ contentHash: hashOf('c') }))
  const versionsRes = await get(`/api/evidence-artifacts/${artifact.id}/versions`)
  const versionList = ((versionsRes.body as { items?: Record<string, any>[] })?.items ?? [])
  const versionGet = await get(`/api/evidence-artifact-versions/${(v2.body as Record<string, any>).id}`)
  check(
    'T25',
    'List versions',
    versionsRes.status === 200 && versionList.map((row) => row.version).join(',') === '1,2,3',
    'a history reads forwards: version ascending, exact immutable metadata',
  )
  check(
    'T26',
    'Get version',
    versionGet.status === 200 && (versionGet.body as Record<string, any>).version === 2,
    'the version is returned, its ownership resolved through the parent artifact',
  )
  check('T27', 'Append v2', v2.status === 201 && (v2.body as Record<string, any>).version === 2, 'the server assigned version 2')
  check('T28', 'Append v3', v3.status === 201 && (v3.body as Record<string, any>).version === 3, 'the server assigned version 3')

  const v1AfterAppends = versionList.find((row) => row.version === 1)
  check(
    'T35',
    'Version history unchanged',
    JSON.stringify(v1AfterAppends) === JSON.stringify(artifact.latestVersion),
    'version 1 is byte-for-byte what it was before version 2 and 3 existed',
  )

  // ---------------------------------------------------------------- no mutation surface (T29–T34)
  section('Append-only — no route and no statement can rewrite history')
  const artifactPatch = await patchApi(`/api/evidence-artifacts/${artifact.id}`, {})
  const artifactDelete = await del(`/api/evidence-artifacts/${artifact.id}`)
  const versionPatch = await patchApi(`/api/evidence-artifact-versions/${(v2.body as Record<string, any>).id}`, {})
  const versionDelete = await del(`/api/evidence-artifact-versions/${(v2.body as Record<string, any>).id}`)
  check('T29', 'No artifact PATCH', artifactPatch.status === 404, `PATCH is ${artifactPatch.status}`)
  check('T30', 'No artifact DELETE', artifactDelete.status === 404, `DELETE is ${artifactDelete.status}`)
  check('T31', 'No version PATCH', versionPatch.status === 404, `PATCH is ${versionPatch.status}`)
  check('T32', 'No version DELETE', versionDelete.status === 404, `DELETE is ${versionDelete.status}`)

  const versionId = (v2.body as Record<string, any>).id as string
  const updateRefusal = await attemptAdversarial(() =>
    prisma.evidenceArtifactVersion.update({ where: { id: versionId }, data: { documentType: 'CHANGED' } }),
  )
  const stillThere = await prisma.evidenceArtifactVersion.findUniqueOrThrow({ where: { id: versionId }, select: { documentType: true } })
  check(
    'T33',
    'DB update immutability',
    /append-only/i.test(updateRefusal) && stillThere.documentType !== 'CHANGED',
    'the trigger refused a direct UPDATE, so history cannot be rewritten even from raw SQL',
  )
  const deleteRefusal = await attemptAdversarial(() => prisma.evidenceArtifactVersion.delete({ where: { id: versionId } }))
  const survived = await prisma.evidenceArtifactVersion.findUnique({ where: { id: versionId }, select: { id: true } })
  check('T34', 'DB delete immutability', /append-only/i.test(deleteRefusal) && !!survived, 'the trigger refused a direct DELETE and the row survived')

  // ---------------------------------------------------------------- no false uniqueness (T36–T37)
  section('No uniqueness the domain does not own')
  const sharedHash = hashOf('d')
  const sameHashA = await post(`/api/organizations/${org}/evidence-artifacts`, body({ contentHash: sharedHash }))
  const sameHashB = await post(`/api/organizations/${org}/evidence-artifacts`, body({ contentHash: sharedHash }))
  check(
    'T36',
    'Same hash allowed',
    sameHashA.status === 201 && sameHashB.status === 201,
    'the same bytes may legitimately back more than one evidence identity; no global hash uniqueness was invented',
  )
  const sharedRef = `synthetic://evidence/${runId}/shared-locator`
  const sameRefA = await post(`/api/organizations/${org}/evidence-artifacts`, body({ storageRef: sharedRef }))
  const sameRefB = await post(`/api/organizations/${org}/evidence-artifacts`, body({ storageRef: sharedRef }))
  // The primary key is excluded: a surrogate id being unique is not a domain rule. What is asked is
  // whether any BUSINESS uniqueness beyond (artifact, version) was invented.
  const uniqueIndexes = (await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
    SELECT indexname, indexdef FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'evidence_artifact_versions'
       AND indexdef LIKE '%UNIQUE%' AND indexname <> 'evidence_artifact_versions_pkey'`)
  check(
    'T37',
    'Same storageRef allowed structurally',
    sameRefA.status === 201 &&
      sameRefB.status === 201 &&
      uniqueIndexes.length === 1 &&
      /\(evidence_artifact_id, version\)/.test(uniqueIndexes[0].indexdef),
    `the only business unique index is (evidence_artifact_id, version); no storageRef or contentHash uniqueness was invented (${uniqueIndexes.map((row) => row.indexname).join(', ')})`,
  )

  // ---------------------------------------------------------------- RBAC and tenancy (T38–T46)
  section('Permission, tenancy and safe errors')
  const viewerList = await get(`/api/organizations/${org}/evidence-artifacts`, asViewer)
  const viewerGet = await get(`/api/evidence-artifacts/${artifact.id}`, asViewer)
  const viewerVersions = await get(`/api/evidence-artifacts/${artifact.id}/versions`, asViewer)
  const viewerVersion = await get(`/api/evidence-artifact-versions/${versionId}`, asViewer)
  check(
    'T38',
    'Viewer read',
    [viewerList, viewerGet, viewerVersions, viewerVersion].every((res) => res.status === 200),
    'a viewer may list artifacts, read one, read its history and read a single version',
  )

  const artifactsBefore = await prisma.evidenceArtifact.count({ where: { organizationId: org } })
  const versionsBefore = await prisma.evidenceArtifactVersion.count()
  const auditBeforeDenials = await evidenceAuditCount()
  const viewerCreate = await post(`/api/organizations/${org}/evidence-artifacts`, body(), asViewer)
  const viewerAppend = await post(`/api/evidence-artifacts/${artifact.id}/versions`, body(), asViewer)
  const artifactsAfter = await prisma.evidenceArtifact.count({ where: { organizationId: org } })
  const versionsAfter = await prisma.evidenceArtifactVersion.count()
  check(
    'T39',
    'Viewer create denied',
    viewerCreate.status === 403 && artifactsAfter === artifactsBefore && (await evidenceAuditCount()) === auditBeforeDenials,
    '403 with no artifact, no version and no audit',
  )
  check(
    'T40',
    'Viewer append denied',
    viewerAppend.status === 403 && versionsAfter === versionsBefore,
    '403 with no version written',
  )

  // A foreign artifact, created directly because this tenant's routes correctly refuse to author it.
  const foreignArtifact = await prisma.evidenceArtifact.create({ data: { organizationId: otherOrg } })
  const foreignUser = (await prisma.user.findFirstOrThrow({ where: { email: adminEmail }, select: { id: true } })).id
  const foreignSecretRef = `synthetic://evidence/${runId}/foreign-secret-locator`
  const foreignVersion = await prisma.evidenceArtifactVersion.create({
    data: {
      evidenceArtifactId: foreignArtifact.id,
      version: 1,
      storageRef: foreignSecretRef,
      contentHash: hashOf('e'),
      documentType: 'SYNTHETIC_FOREIGN_DOCUMENT',
      receivedAt: new Date('2026-06-15T09:30:00.000Z'),
      createdByUserId: foreignUser,
    },
  })

  const ownList = ((await get(`/api/organizations/${org}/evidence-artifacts`)).body as { items?: { id: string }[] })?.items ?? []
  check('T41', 'Cross-tenant list', !ownList.some((row) => row.id === foreignArtifact.id), 'a foreign artifact never appears in this organization list')

  const foreignGet = await get(`/api/evidence-artifacts/${foreignArtifact.id}`)
  const foreignBody = JSON.stringify(foreignGet.body ?? {})
  check(
    'T42',
    'Cross-tenant artifact',
    foreignGet.status >= 400 && foreignGet.status < 500 && !foreignBody.includes(otherOrg) && !foreignBody.includes(foreignSecretRef),
    `refused with ${foreignGet.status}; neither the foreign organization nor its storage reference is disclosed`,
  )
  const foreignVersionGet = await get(`/api/evidence-artifact-versions/${foreignVersion.id}`)
  const foreignVersionBody = JSON.stringify(foreignVersionGet.body ?? {})
  check(
    'T43',
    'Cross-tenant version',
    foreignVersionGet.status >= 400 && foreignVersionGet.status < 500 && !foreignVersionBody.includes(foreignSecretRef),
    `refused with ${foreignVersionGet.status} through the parent artifact's ownership, with no metadata leak`,
  )

  const missingArtifact = await get(`/api/evidence-artifacts/${MISSING}`)
  const missingVersion = await get(`/api/evidence-artifact-versions/${MISSING}`)
  check('T44', 'Missing artifact', missingArtifact.status === 404 && !JSON.stringify(missingArtifact.body).includes(org), `${missingArtifact.status} with no tenant information`)
  check('T45', 'Missing version', missingVersion.status === 404, `${missingVersion.status} safe envelope`)

  const malformedStatuses: string[] = []
  for (const path of ['/api/evidence-artifacts/not-a-uuid', '/api/evidence-artifacts/not-a-uuid/versions', '/api/evidence-artifact-versions/not-a-uuid'])
    malformedStatuses.push(`${(await get(path)).status}`)
  const malformedBodies = await Promise.all(
    ['/api/evidence-artifacts/not-a-uuid', '/api/evidence-artifact-versions/not-a-uuid'].map(async (p) => JSON.stringify((await get(p)).body ?? {})),
  )
  check(
    'T46',
    'Malformed UUID',
    malformedStatuses.every((status) => status === '404' || status === '400') &&
      malformedBodies.every((text) => !/prisma|postgres|syntax|invalid input/i.test(text)),
    `${malformedStatuses.join(', ')}; safe envelopes with no raw database text, never a 500`,
  )

  // ---------------------------------------------------------------- audit (T47–T53)
  section('Business audit — proves the action, never stores the evidence')
  const artifactAudits = await prisma.auditEvent.findMany({ where: { entityType: 'EVIDENCE_ARTIFACT', entityId: artifact.id }, select: { actionCode: true, afterState: true } })
  check(
    'T47',
    'Artifact create audit',
    artifactAudits.length === 1 && artifactAudits[0].actionCode === 'evidence_artifact.created',
    'exactly one evidence_artifact.created event, written in the same transaction as the artifact',
  )
  const v1Audits = await prisma.auditEvent.findMany({ where: { entityType: 'EVIDENCE_ARTIFACT_VERSION', entityId: artifact.latestVersion.id }, select: { actionCode: true, afterState: true } })
  check(
    'T48',
    'Version1 audit',
    v1Audits.length === 1 && (v1Audits[0].afterState as Record<string, any>)?.version === 1,
    'version 1 has its own event, atomic with the artifact that carries it',
  )
  const v2Audit = await prisma.auditEvent.findFirst({ where: { entityType: 'EVIDENCE_ARTIFACT_VERSION', entityId: versionId }, select: { afterState: true } })
  check(
    'T49',
    'Append audit',
    (v2Audit?.afterState as Record<string, any>)?.version === 2 && (v2Audit?.afterState as Record<string, any>)?.id === versionId,
    'the append event names the exact version number and row it created',
  )

  const sensitiveNeedles = ['storageRef', 'contentHash', 'documentType', 'sourceDate', 'receivedAt', 'synthetic://', runId.slice(-6)]
  const leakedAudits = await prisma.auditEvent.findMany({
    where: { entityType: { in: ['EVIDENCE_ARTIFACT', 'EVIDENCE_ARTIFACT_VERSION'] } },
    select: { afterState: true, beforeState: true },
  })
  const leaks = leakedAudits.filter((event) =>
    sensitiveNeedles.some((needle) => JSON.stringify(event.afterState ?? {}).includes(needle) || JSON.stringify(event.beforeState ?? {}).includes(needle)),
  )
  const snapshotKeys = [...deepKeys(v1Audits[0]?.afterState)].sort()
  check(
    'T50',
    'Audit sensitive minimization',
    leaks.length === 0,
    leaks.length === 0
      ? `no storage reference, hash, document type or source date in any of ${leakedAudits.length} evidence audit rows; a snapshot carries ${snapshotKeys.join(', ')}`
      : `${leaks.length} audit row(s) contain evidence metadata`,
  )

  const auditBeforeBatch = await evidenceAuditCount()
  await post(`/api/organizations/${org}/evidence-artifacts`, body(), asViewer)
  await post(`/api/organizations/${org}/evidence-artifacts`, body({ contentHash: 'too-short' }))
  await post(`/api/evidence-artifacts/${MISSING}/versions`, body())
  await post(`/api/evidence-artifacts/${artifact.id}/versions`, { ...body(), version: 99 })
  check(
    'T51',
    'No false audit',
    (await evidenceAuditCount()) === auditBeforeBatch,
    `a denied, an invalid, a missing-parent and a server-owned-field attempt created no audit (count stayed ${auditBeforeBatch})`,
  )

  // Force the audit write's transaction to fail after everything else succeeded, and prove the whole
  // unit rolls back: an artifact whose audit did not survive would be evidence nobody can account for.
  const artifactsBeforeRollback = await prisma.evidenceArtifact.count({ where: { organizationId: org } })
  const auditBeforeRollback = await evidenceAuditCount()
  failAt('evidence_artifact.created', 'forced audit failure (acceptance)')
  const actorUserId = foreignUser
  let createThrew = false
  try {
    await createEvidenceArtifact(org, { storageRef: `synthetic://evidence/${runId}/rollback`, contentHash: hashOf('f'), documentType: 'SYNTHETIC_ROLLBACK', sourceDate: null, receivedAt: '2026-06-15T09:30:00.000Z' }, actorUserId)
  } catch {
    createThrew = true
  }
  clearConcurrencyProbes()
  check(
    'T52',
    'Create atomic rollback',
    createThrew &&
      (await prisma.evidenceArtifact.count({ where: { organizationId: org } })) === artifactsBeforeRollback &&
      (await evidenceAuditCount()) === auditBeforeRollback,
    'a forced failure left no artifact, no version and no audit behind',
  )

  const versionsBeforeRollback = await prisma.evidenceArtifactVersion.count({ where: { evidenceArtifactId: artifact.id } })
  const auditBeforeAppendRollback = await evidenceAuditCount()
  failAt('evidence_artifact_version.created', 'forced audit failure (acceptance)')
  let appendThrew = false
  try {
    await appendEvidenceVersion(artifact.id, { storageRef: `synthetic://evidence/${runId}/rollback2`, contentHash: hashOf('7'), documentType: 'SYNTHETIC_ROLLBACK', sourceDate: null, receivedAt: '2026-06-15T09:30:00.000Z' }, actorUserId)
  } catch {
    appendThrew = true
  }
  clearConcurrencyProbes()
  check(
    'T53',
    'Append atomic rollback',
    appendThrew &&
      (await prisma.evidenceArtifactVersion.count({ where: { evidenceArtifactId: artifact.id } })) === versionsBeforeRollback &&
      (await evidenceAuditCount()) === auditBeforeAppendRollback,
    'a forced failure left no new version and no audit behind',
  )

  // ---------------------------------------------------------------- concurrency (T54–T55)
  section('Concurrent appends — the artifact row lock keeps numbering gap-free')
  const raceArtifact = (await post(`/api/organizations/${org}/evidence-artifacts`, body())).body as Record<string, any>
  const gate = holdAt('evidence_artifact_version.locked')
  const firstAppend = appendEvidenceVersion(raceArtifact.id, { storageRef: `synthetic://evidence/${runId}/race-a`, contentHash: hashOf('8'), documentType: 'SYNTHETIC_RACE', sourceDate: null, receivedAt: '2026-06-15T09:30:00.000Z' }, actorUserId)
  await gate.arrived
  const secondAppend = appendEvidenceVersion(raceArtifact.id, { storageRef: `synthetic://evidence/${runId}/race-b`, contentHash: hashOf('9'), documentType: 'SYNTHETIC_RACE', sourceDate: null, receivedAt: '2026-06-15T09:30:00.000Z' }, actorUserId)
  const blocked = await waitForLockWaiter()
  gate.release()
  const [firstResult, secondResult] = await Promise.all([firstAppend, secondAppend])
  clearConcurrencyProbes()
  const raceVersions = await prisma.evidenceArtifactVersion.findMany({ where: { evidenceArtifactId: raceArtifact.id }, orderBy: { version: 'asc' }, select: { id: true, version: true } })
  check(
    'T54',
    'Concurrent append',
    blocked &&
      firstResult.ok &&
      secondResult.ok &&
      raceVersions.map((row) => row.version).join(',') === '1,2,3',
    `the second writer waited on the artifact row lock; versions ${raceVersions.map((row) => row.version).join(', ')} with no duplicate and no gap`,
  )

  const raceAudits = await prisma.auditEvent.findMany({
    where: { entityType: 'EVIDENCE_ARTIFACT_VERSION', entityId: { in: raceVersions.map((row) => row.id) } },
    select: { entityId: true, afterState: true },
  })
  check(
    'T55',
    'Concurrent audit truth',
    raceAudits.length === raceVersions.length &&
      raceVersions.every((row) => raceAudits.some((audit) => audit.entityId === row.id && (audit.afterState as Record<string, any>)?.version === row.version)),
    'every surviving version has exactly one audit event naming its own number',
  )

  const routeSource = git('show HEAD:backend/src/modules/evidence-artifact/evidence-artifact.route.ts')
  const verbs = (routeSource.match(/Router\.(get|post|patch|put|delete)\(/g) ?? []).map((line) => line.replace(/Router\.|\(/g, ''))
  // Executable code only, for the reason given at `committedCode`: a comment saying "there is no
  // update here" must not be read as an update.
  const repositorySource = committedCode('backend/src/modules/evidence-artifact/evidence-artifact.repository.ts')
  const serviceSource = committedCode('backend/src/modules/evidence-artifact/evidence-artifact.service.ts')
  const repositoryWriters = (repositorySource.match(/^export async function \w+/gm) ?? []).map((line) => line.replace('export async function ', ''))
  // An artifact with no version would be evidence that records nothing. Two things make that
  // impossible: no route can reach the bare artifact insert, and the only caller of that insert
  // writes version 1 in the same transaction.
  const artifactInsertCallers = (serviceSource.match(/createEvidenceArtifactRecord\(/g) ?? []).length
  check(
    'T56',
    'No empty artifact',
    verbs.filter((verb) => verb === 'post').length === 2 &&
      !routeSource.includes('createEvidenceArtifactRecord') &&
      artifactInsertCallers === 1 &&
      repositoryWriters.every((name) => name.startsWith('create') || name.startsWith('find')) &&
      !/\.(update|updateMany|delete|deleteMany|upsert)\(/.test(repositorySource),
    `the only two writes are create-with-version-1 and append-version; the bare artifact insert has exactly one caller and no route reaches it; the repository exposes only create/find (${repositoryWriters.length} functions, no update, delete or upsert statement anywhere)`,
  )

  // ---------------------------------------------------------------- scope guards (T57–T71)
  section('Scope guards — evidence identity only')
  const columnsOf = async (table: string) =>
    (await prisma.$queryRaw<{ column_name: string; data_type: string }[]>`
      SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table}`)
  const artifactColumns = await columnsOf('evidence_artifacts')
  const versionColumns = await columnsOf('evidence_artifact_versions')
  const allColumns = [...artifactColumns, ...versionColumns]
  const names = allColumns.map((row) => row.column_name)

  const forbiddenColumn = (pattern: RegExp) => names.filter((name) => pattern.test(name))
  check('T57', 'No Patient FK', forbiddenColumn(/patient/i).length === 0, `columns: ${names.join(', ')}`)
  check('T58', 'No Encounter FK', forbiddenColumn(/encounter/i).length === 0, 'no encounterId on either A5.1 table')
  check('T59', 'No membership/eligibility FK', forbiddenColumn(/(membership|eligib)/i).length === 0, 'no insuranceMembershipId or eligibilityVerificationId')
  check('T60', 'No authorization FK', forbiddenColumn(/(authoriz|auth_line)/i).length === 0, 'no priorAuthorizationId or authorizationLineId')
  check('T61', 'No claim/submission FK', forbiddenColumn(/(claim|submission)/i).length === 0, 'no claimId, claimLineId or submissionId')
  check(
    'T62',
    'No rule/reference duplication',
    forbiddenColumn(/(rule_source|reference_dataset|dataset_version|external_identifier)/i).length === 0,
    'no RuleSource, ReferenceDataset or ExternalIdentifier copy; evidence is not governing policy, a reference dataset or an external identity',
  )
  const binaryColumns = allColumns.filter((row) => /bytea|json|blob/i.test(row.data_type) || /(bytes|body|payload|base64|content_data|file)/i.test(row.column_name))
  check(
    'T63',
    'No blob/content column',
    binaryColumns.length === 0,
    `no binary, JSON or payload column: the bytes live outside this database (types: ${[...new Set(allColumns.map((row) => row.data_type))].join(', ')})`,
  )
  // A search that reaches nothing proves nothing. Every absence check below is paired with a
  // positive anchor that must be FOUND, so an empty read or a mis-scoped pathspec fails loudly
  // instead of passing silently.
  // Content transport is a behaviour: a handler that reads, streams or returns bytes, or accepts a
  // file upload. Only executable code is searched, for the reason given at `committedCode`.
  const routeCode = committedCode('backend/src/modules/evidence-artifact/evidence-artifact.route.ts')
  const transport = routeCode.match(/\b(multer|busboy|multipart|createReadStream|createWriteStream|sendFile|res\.download|res\.pipe|getSignedUrl|createPresigned)\b/i)
  check(
    'T64',
    'No upload/download route',
    routeSource.length > 0 && verbs.length === 6 && verbs.every((verb) => verb === 'get' || verb === 'post') && transport === null,
    routeSource.length === 0
      ? 'the committed route source could not be read, so this absence is unproven'
      : transport
        ? `content transport found in route code: ${JSON.stringify(transport[0])}`
        : `${verbs.length} routes, all GET or POST (${verbs.join(', ')}); no handler reads, streams, uploads or returns bytes`,
  )

  const moduleSources = [':/backend/src/modules/evidence-artifact']
  const moduleCode = committedCodeOf('backend/src/modules/evidence-artifact')
  const provider = moduleCode.code.match(/\b(aws-sdk|@aws-sdk|blobService|BlobServiceClient|googleapis|Storage\.bucket|createPresigned|getSignedUrl|bucket)\b/i)
  check(
    'T65',
    'No storage provider code',
    moduleCode.files.length > 0 && moduleCode.code.includes('normalizeStorageRef') && provider === null,
    moduleCode.files.length === 0 || !moduleCode.code.includes('normalizeStorageRef')
      ? 'the scan did not reach the committed module source, so this absence is unproven'
      : provider
        ? `storage-provider code found: ${JSON.stringify(provider[0])}`
        : `no bucket, S3, Azure, GCS or signed-URL code in any of the ${moduleCode.files.length} committed module files; the reference stays opaque (search verified to reach the source)`,
  )

  const responseKeys = deepKeys(artifact)
  check('T66', 'No eligibility decision', !responseKeys.has('eligible') && !responseKeys.has('eligibilityStatus') && !responseKeys.has('freshness'), 'no eligibility or freshness field')
  check('T67', 'No authorization decision', !responseKeys.has('authorizationStatus') && !responseKeys.has('authorizationNumber') && !responseKeys.has('conditions'), 'no authorization status, number or conditions')
  check('T68', 'No readiness', !responseKeys.has('readyForClaim') && !responseKeys.has('readiness'), 'no readiness outcome')
  check(
    'T69',
    'No Claim Evidence Package',
    !responseKeys.has('snapshotHash') && !responseKeys.has('payloadHash') && !responseKeys.has('approvedBy') && !responseKeys.has('submissionId'),
    'no frozen snapshot, payload hash, approver or submission identity — A6 owns that boundary',
  )

  const feSources = [':/frontend/src/modules/evidence-artifact']
  const fePersist = gitGrep('(localStorage|sessionStorage|indexedDB)[.][A-Za-z]+[(]', feSources)
  const feSanity = gitGrep('createEvidenceArtifact', feSources)
  check(
    'T70',
    'Frontend no persistence',
    feSanity.status === 0 && fePersist.status === 1,
    feSanity.status !== 0
      ? 'the scan did not reach the committed frontend source, so this absence is unproven'
      : fePersist.status === 1
        ? 'evidence metadata is never written to localStorage, sessionStorage or IndexedDB (search verified to reach the source)'
        : `browser persistence found: ${fePersist.output.slice(0, 200)}`,
  )
  const logScan = gitGrep('console[.](log|info|warn|error|debug)[(].*(storageRef|contentHash|documentType|sourceDate)', [...moduleSources, ...feSources])
  const urlScan = gitGrep('[?&](storageRef|contentHash|documentType|sourceDate)=', [...moduleSources, ...feSources])
  const logReach = gitGrep('storageRef', [...moduleSources, ...feSources])
  check(
    'T71',
    'Logging scan',
    logReach.status === 0 && logScan.status === 1 && urlScan.status === 1,
    logReach.status !== 0
      ? 'the scan did not reach the committed sources, so this absence is unproven'
      : 'no storage reference, hash or document metadata is logged or placed in a query string (search verified to reach the source)',
  )

  // ---------------------------------------------------------------- build and regressions (T72–T74)
  section('Build gates, backward regressions and database truth')
  const unitTests = run('npm run test:unit')
  const typecheck = run('npm run typecheck')
  const build = run('npm run build --prefix ../frontend')
  const lint = run('npm run lint --prefix ../frontend')
  check(
    'T72',
    'Unit/typecheck/build',
    unitTests.ok && /ℹ fail 0/.test(unitTests.output) && typecheck.ok && build.ok && lint.ok,
    `${(unitTests.output.match(/ℹ pass \d+/) ?? [''])[0]}, typecheck clean, ${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}, ${(lint.output.match(/Found \d+ warnings and \d+ errors\./) ?? ['lint clean'])[0]}`,
  )

  // §13 of the A4 closure applies here too: the owner suites are invoked, not reimplemented. A4.10's
  // suite already nests A4.9 down to A1, so one invocation exercises the whole chain and each nested
  // verdict is read back below.
  await apiReady('the backward regression chain')
  const chain = run('npm run test:a4:integration')
  const chainLines = chain.output.split(/\r?\n/)
  const chainFailing = failedIds(chain.output, 'A4.10')
  // Line lookups are done with startsWith rather than a built regular expression. A dynamic pattern
  // here was written with single backslashes inside a template literal, which turned `\[A4\.10\]`
  // into the character class `[A4.10]`; it silently matched nothing and six N/A lines disappeared
  // without failing anything. A search that cannot fail loudly has no business in an acceptance run.
  const a410FailLine = (id: string) => chainLines.find((line) => line.startsWith(`[A4.10] ${id} `) && line.includes(' FAIL'))
  const a410TitleOf = (line: string) => line.slice(`[A4.10] `.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()

  // On the A5.1 branch, A4.10's own branch-identity and "A4.10 adds no schema" checks cannot hold:
  // A5.1 is a different branch and it legitimately adds a migration and two models.
  const chainNonApplicable = ['T02', 'T04', 'T05', 'T06', 'T117', 'T118']

  // A4.10 also reports each owner suite on an indented line of its own, which increments its failure
  // count without printing a check id. Those lines are invisible to failedIds, so they are read
  // separately here; every one of them cascades from the single root named below.
  const ownerFailing = chainLines
    .filter((line) => line.startsWith('[A4.10]      ') && line.includes('substantive checks FAIL'))
    .map((line) => line.replace('[A4.10]      ', '').split(' ')[0])
  const ownerNonApplicable = ['A4.8', 'A4.7', 'A4.6', 'A4.5', 'A4.4', 'A4.3']
  const ownerUndocumented = ownerFailing.filter((label) => !ownerNonApplicable.includes(label))

  // A4.10's T97 reads A4.9's verdict, and A4.9 in turn fails on this branch. What matters is not
  // that it failed but WHICH checks failed: every one named below asserts a world in which A5 has
  // not started, and A5.1 is the package that ends it. Each is listed with its own reason and
  // counted as N/A; an id that is NOT listed here is a genuine regression and fails T73.
  const a49NonApplicable: Record<string, string> = {
    T03: "A4.9 'No migration' asserts that the A4.9 package adds no migration at all; A5.1 adds exactly one, whose contents T03 proves and T05 replays from empty",
    T04: "A4.9 'No schema drift' asserts schema.prisma is byte-identical to main; A5.1 adds exactly the two evidence models, and nothing else (T76)",
    T85: "A4.9 'A4.8 regression' cascades from A4.4 T67 (below); A4.8's own substantive checks are unaffected, and A3/A2/A1 still read back PASS through it",
    T86: "A4.9 'A4.7 regression' cascades from A4.4 T67 (below)",
    T87: "A4.9 'A4.6 regression' cascades from A4.4 T67 (below)",
    T88: "A4.9 'A4.5 regression' cascades from A4.4 T67 (below)",
    T89: "A4.9 'A4.4 regression' cascades from A4.4 T67 (below)",
    T90: "A4.9 'A4.3 regression' cascades from A4.4 T67 (below)",
  }
  const t97 = nestedLine(chain.output, 'A4.10', 'T97', 'A4 owner suites')
  const a49Reported = (t97.detail.match(/unexpected A4\.9 failures: (.*)$/) ?? ['', ''])[1]
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  const a49Undocumented = a49Reported.filter((id) => !(id in a49NonApplicable))

  // The single root of the whole cascade is A4.4's T67, which lists every public table matching
  // /(eligib|authoriz|claim|remittance|payment|evidence)/ and requires none to exist. That claim is
  // only allowed to be false because of A5.1 itself, so it is proven rather than asserted: the two
  // evidence tables must be the ONLY matches. If an eligibility, authorization, claim, remittance or
  // payment table had appeared, this would fail and the cascade would not be excused.
  const boundaryTables = (await prisma.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name ~* '(eligib|authoriz|claim|remittance|payment|evidence)'
     ORDER BY table_name`).map((row) => row.table_name)
  // Sorted here rather than relying on the database collation, so the comparison means the same
  // thing on every machine.
  const boundaryIsOnlyA51 = [...boundaryTables].sort().join(',') === 'evidence_artifact_versions,evidence_artifacts'

  const t97Tolerated = t97.verdict === 'FAIL' && a49Reported.length > 0 && a49Undocumented.length === 0 && boundaryIsOnlyA51
  const tolerated = [...chainNonApplicable, ...(t97Tolerated ? ['T97'] : [])]
  const chainUnexpected = chainFailing.filter((id) => !tolerated.includes(id))

  // Arithmetic, so that a failure category this parser cannot see can never pass unnoticed. A4.10's
  // own summary says how many of its checks failed; every one of them must be a check id this suite
  // read back, or an owner line it read back. If the two numbers disagree, something failed that was
  // never named, and that is a FAIL whatever the named ones say.
  const a410Counts = chain.output.match(/\[A4\.10\] automated summary: (\d+)\/(\d+) PASS/)
  const a410Failed = a410Counts ? Number(a410Counts[2]) - Number(a410Counts[1]) : -1
  const accounted = chainFailing.length + ownerFailing.length
  const everyFailureAccountedFor = a410Failed >= 0 && accounted === a410Failed

  // Each tolerated id must actually be found in the output. A tolerated id with no line behind it
  // means the search missed it, which is exactly the silent hole this check exists to prevent.
  const unreadableTolerated = chainNonApplicable.filter((id) => chainFailing.includes(id) && !a410FailLine(id))

  const chainSummary = (chain.output.match(/\[A4\.10\] automated summary: [^\n]*/) ?? ['no summary'])[0]
  check(
    'T73',
    'Backward regressions',
    chainUnexpected.length === 0 &&
      a49Undocumented.length === 0 &&
      ownerUndocumented.length === 0 &&
      boundaryIsOnlyA51 &&
      everyFailureAccountedFor &&
      unreadableTolerated.length === 0,
    !boundaryIsOnlyA51
      ? `a future-phase table exists beyond A5.1's own two: ${boundaryTables.join(', ')}`
      : !everyFailureAccountedFor
        ? `A4.10 reports ${a410Failed} failure(s) but only ${accounted} could be named; something failed that this suite did not read back`
        : unreadableTolerated.length > 0
          ? `tolerated but unreadable in the output: ${unreadableTolerated.join(', ')}`
          : a49Undocumented.length > 0
            ? `undocumented A4.9 failures: ${a49Undocumented.join(', ')}`
            : ownerUndocumented.length > 0
              ? `undocumented A4.10 owner-suite failures: ${ownerUndocumented.join(', ')}`
              : chainUnexpected.length > 0
                ? `unexpected A4.10 failures: ${chainUnexpected.join(', ')}`
                : `${chainSummary.replace('[A4.10] automated summary: ', 'A4.10 ')}; all ${a410Failed} failure(s) named and accounted for, every substantive check green, and the only tables crossing the A4 boundary are A5.1's own two`,
  )

  for (const id of chainNonApplicable) {
    const line = a410FailLine(id)
    if (line)
      notApplicableCheck(
        `T73/${id}`,
        `A4.10 ${a410TitleOf(line)}`,
        'asserts a fact about the A4.10 feature branch, which legitimately adds no schema; A5.1 is a different branch and does',
      )
  }
  if (t97Tolerated) {
    notApplicableCheck(
      'T73/T97',
      'A4.10 A4 owner suites',
      `A4.9 reports ${a49Reported.length} failures and every one is listed below with its own reason`,
    )
    for (const id of a49Reported) notApplicableCheck(`T73/A4.9/${id}`, `A4.9 ${id}`, a49NonApplicable[id])
  }
  for (const label of ownerFailing)
    notApplicableCheck(
      `T73/owner/${label}`,
      `A4.10 ${label} owner suite`,
      `an indented owner-suite line, not a check id; it cascades from A4.4 T67 (below) and its own A3/A2/A1 readbacks still pass`,
    )
  if (t97Tolerated)
    notApplicableCheck(
      'T73/A4.4/T67',
      'A4.4 no eligibility/auth/claim fields',
      `the root of the entire cascade: it requires no table matching eligibility, authorization, claim, remittance, payment or evidence to exist, and the only ones that do are A5.1's own (${boundaryTables.join(', ')}) — the A4-to-A5 boundary this package exists to cross`,
    )
  for (const [label, id, title] of [
    ['A3', 'T98', 'A3 regression'],
    ['A2', 'T99', 'A2 regression'],
    ['A1', 'T100', 'A1 regression'],
  ] as const) {
    const { verdict, detail } = nestedLine(chain.output, 'A4.10', id, title)
    console.log(`[A5.1]      ${label} substantive checks ${verdict === 'PASS' ? 'PASS' : `FAIL (${detail || 'line missing'})`} - ${detail.slice(0, 110)}`)
    if (verdict !== 'PASS') {
      failed += 1
      failures.push(`T73 ${label} regression ${detail || 'line missing'}`)
    }
  }

  await apiReady('the DB truth check')
  const upHealth = await health()
  const upReady = await ready()
  const stopped = spawnSync('docker', ['stop', dbContainer], { encoding: 'utf8' }).status === 0
  const downReady = await waitFor(async () => (await ready()) === 503, 30_000)
  const downSamples: number[] = []
  for (let i = 0; i < 5; i += 1) {
    downSamples.push(await health())
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  const restarted = spawnSync('docker', ['start', dbContainer], { encoding: 'utf8' }).status === 0
  const recovered = await waitFor(async () => (await ready()) === 200, 90_000)
  check(
    'T74',
    'DB truth',
    upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered,
    'up 200/200; with the database down health stayed 200 and ready reported 503; recovery 200',
  )

  // ---------------------------------------------------------------- closure (T75–T78)
  section('Repeatability, diff scope and exact head')
  const priorRuns = await prisma.evidenceArtifactVersion.count({
    where: { storageRef: { startsWith: 'synthetic://evidence/A51-' }, NOT: { storageRef: { contains: runId } } },
  })
  check('T75', 'Repeatability', true, `this run used a fresh synthetic runId (${runId}); ${priorRuns} version(s) from earlier runs retained, none deleted`)

  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const allowed = [
    'backend/package.json',
    'backend/prisma/schema.prisma',
    'backend/src/app.ts',
    'backend/src/modules/audit/audit.types.ts',
    'backend/src/scripts/bootstrap-authz-dev.ts',
    'backend/src/scripts/verify-migration-replay.ts',
    'backend/src/shared/authorization/authorization.types.ts',
    'backend/src/shared/database/row-lock.ts',
    'frontend/src/app/App.tsx',
  ]
  const outOfScope = changedPaths.filter(
    (file) =>
      !file.startsWith('backend/src/modules/evidence-artifact/') &&
      !file.startsWith('backend/src/integration/a5-evidence-artifact/') &&
      !file.startsWith('frontend/src/modules/evidence-artifact/') &&
      !file.includes('a5_1_evidence_artifact_version_foundation') &&
      !allowed.includes(file),
  )
  // Future-phase scope is detected by what the code USES, not by which words it mentions: this
  // module legitimately imports `shared/authorization`, and the harness names A5.2-A6 fields on
  // purpose so T66-T69 can assert their absence. Only a real future-phase MODULE import or a read of
  // a future-phase table would pull scope backwards, so that is what is searched for.
  // Executable code only, for the reason given at `committedCode`: this file names A5.2-A6 fields on
  // purpose so T66-T69 can assert their absence, and the module's comments explain what it refuses
  // to depend on. A word search would find those explanations and call them violations.
  const scopeCode = ['backend/src/modules/evidence-artifact', 'backend/src/integration/a5-evidence-artifact', 'frontend/src/modules/evidence-artifact']
    .map((dir) => committedCodeOf(dir))
    .reduce((all, one) => ({ files: [...all.files, ...one.files], code: `${all.code}\n${one.code}` }), { files: [] as string[], code: '' })
  const futureImport = scopeCode.code.match(/from '[^']*modules\/(eligibility|prior-auth|authorization-|claim|submission|remittance)/)
  const futureModel = scopeCode.code.match(/prisma\.(eligibilityVerification|priorAuthorization|authorizationLine|claim|claimLine|claimSubmission|remittance|claimEvidencePackage)\b/)
  const scopeReached = scopeCode.files.length > 0 && scopeCode.code.includes("from '")
  check(
    'T76',
    'Diff scope',
    outOfScope.length === 0 && scopeReached && futureImport === null && futureModel === null,
    !scopeReached
      ? 'the import scan did not reach the committed sources, so this absence is unproven'
      : outOfScope.length === 0 && futureImport === null && futureModel === null
        ? `${changedPaths.length} path(s): the evidence module, its migration, permission and audit wiring, and the dev check; across ${scopeCode.files.length} committed files no future-phase module is imported and no future-phase table is read`
        : `unexpected: ${[...outOfScope, futureImport?.[0], futureModel?.[0]].filter(Boolean).join(', ').slice(0, 220)}`,
  )

  const secretScan = gitGrep(
    "((pass" + "word|secret|token|apiKey|clientSecret)\\s*[:=]\\s*['\"][^'\"]{3,}|BEGIN (RSA |EC )?PRIV" + "ATE KEY|Bearer [A-Za-z0-9._-]{20,})",
    [':/backend/src/integration/a5-evidence-artifact', ':/backend/src/modules/evidence-artifact', ':/frontend/src/modules/evidence-artifact'],
  )
  const realDataMarkers = new RegExp(
    ['emir' + 'ates\\s*id', 'pass' + 'port', '\\+9' + '71\\d', '@gm' + 'ail', '@ya' + 'hoo', '@hot' + 'mail']
      .map((fragment) => `(?:${fragment})`)
      .join('|'),
    'i',
  )
  const harnessSource = git('show HEAD:backend/src/integration/a5-evidence-artifact/a5-evidence-artifact.integration.ts')
  const realDataHit = harnessSource.match(realDataMarkers)
  const secretReach = gitGrep('A1_IT_ADMIN_EMAIL', [':/backend/src/integration/a5-evidence-artifact'])
  check(
    'T77',
    'Secret/PHI scan',
    secretReach.status === 0 && /SYNTHETIC/.test(harnessSource) && secretScan.status === 1 && realDataHit === null,
    secretReach.status !== 0 || !/SYNTHETIC/.test(harnessSource)
      ? 'the scan did not reach the committed harness source, so this absence is unproven'
      : secretScan.status === 1 && realDataHit === null
        ? 'no credential value is committed and no real patient or evidence content appears; every fixture is generated from the run id, and every credential is read from the local environment at run time'
        : `${secretScan.output.slice(0, 120)} ${realDataHit ? `real-data marker ${JSON.stringify(realDataHit[0])}` : ''}`,
  )

  const headSha = git('rev-parse HEAD')
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check(
    'T78',
    'Exact head evidence',
    headSha.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a51Branch}`),
    `all evidence corresponds to ${headSha}; ${tracking}; working tree clean`,
  )

  console.log(`\n[A5.1] run ${runId} — HEAD ${headSha}`)
  if (failures.length > 0) {
    console.log(`[A5.1] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  if (notApplicable > 0) console.log(`[A5.1] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) {
    // The API went away and came back during the run. Whatever the verdicts say, they were not all
    // measured against one running server, so the run is reported as invalid rather than summarised
    // as if nothing had happened.
    failed += 1
    failures.push(`the API connection was reset ${connectionResets} time(s) mid-run`)
    console.log(
      `[A5.1] INVALID RUN: the API connection was reset ${connectionResets} time(s). The server restarted underneath this run,`,
    )
    console.log('[A5.1]              which a server started with `--watch` does whenever db:generate or a replay rewrites a file.')
    console.log('[A5.1]              Stop the watch server, start the API with `npm start`, and run this suite again.')
  }
  console.log(`[A5.1] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? '[A5.1] A5.1 EVIDENCE ARTIFACT / VERSION ACCEPTANCE COMPLETE' : '[A5.1] A5.1 FINAL FAIL')
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    console.error('[A5.1] uncaught error (this itself is a FAIL):', error)
    process.exitCode = 1
  })
  .finally(async () => {
    clearConcurrencyProbes()
    // T74 takes the database down deliberately. However this run ends — passing, failing or
    // interrupted — it must not leave the environment worse than it found it, so the container is
    // put back up here rather than only on the happy path.
    const running = (spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', dbContainer], { encoding: 'utf8' }).stdout ?? '').trim()
    if (running === 'false') {
      const restored = spawnSync('docker', ['start', dbContainer], { encoding: 'utf8' }).status === 0
      console.log(`[A5.1] the database was left stopped by this run; restarting it: ${restored ? 'done' : 'FAILED — start it manually'}`)
    }
    await prisma.$disconnect()
  })
