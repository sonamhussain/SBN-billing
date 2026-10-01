import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { prisma } from '../../shared/database/prisma.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { resolvePreClaimCommercialContext } from '../../modules/pre-claim-commercial-context/pre-claim-commercial-context.service.ts'
import { resolveContract, resolveTariff } from '../../modules/pre-claim-commercial-context/pre-claim-commercial-context.resolver.ts'
import { validateApplicabilityContextCoherence } from '../../modules/rule-applicability/rule-applicability.context-coherence.ts'

// A5.5 — focused acceptance for Pre-Claim Commercial Context Resolution (T01–T100).
//
// A5.5 resolves which ProviderContract, and which exact VERIFIED TariffScheduleVersion beneath it,
// provably apply to one Encounter's current commercial, facility and service-date context — read-only,
// in one snapshot, recomputed on every call. Zero candidates is unresolved, more than one is
// ambiguous, an unprovable tariff start is indeterminate, and no winner is ever ranked. Nothing is
// priced, persisted or audited, and no schema changes.
//
// Valid fixtures are created through their owning routes. Every scenario gets a payer of its own, so
// the contracts one scenario creates can never become candidates for another. The database is READ
// for structural proof; ADVERSARIAL writes go in only to prove that something refuses them, and each
// is restored. Every value is synthetic.

let passed = 0
let failed = 0
let notApplicable = 0
const failures: string[] = []

function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  if (condition) {
    passed += 1
    console.log(`[A5.5] ${id} ${title} ${dots} PASS${detail ? ` - ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(`${id} ${title} ${detail}`)
    console.log(`[A5.5] ${id} ${title} ${dots} FAIL${detail ? ` - ${detail}` : ''}`)
  }
}

// §23 — an obsolete phase-boundary check from an older suite is reported as N/A with its exact
// reason and counted separately. A substantive owner-behaviour failure is never converted to one.
function notApplicableCheck(id: string, title: string, reason: string) {
  notApplicable += 1
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  console.log(`[A5.5] ${id} ${title} ${dots} N/A  - ${reason}`)
}

const section = (title: string) => console.log(`\n[A5.5] ${title}`)

function run(command: string): { ok: boolean; output: string } {
  const out = spawnSync(command, { encoding: 'utf8', shell: true, cwd: process.cwd(), maxBuffer: 256 * 1024 * 1024 })
  return { ok: out.status === 0, output: `${out.stdout ?? ''}${out.stderr ?? ''}` }
}

const git = (args: string) => (spawnSync('git', args.split(' '), { encoding: 'utf8' }).stdout ?? '').replace(/\s+$/, '')
const gitOk = (args: string) => spawnSync('git', args.split(' '), { encoding: 'utf8' }).status === 0
const gitGrep = (pattern: string, paths: string[]) => {
  const out = spawnSync('git', ['grep', '-nE', pattern, '--', ...paths], { encoding: 'utf8' })
  return { status: out.status, output: `${out.stdout ?? ''}${out.stderr ?? ''}`.trim() }
}

// A scope guard must judge what the code DOES, not which words it mentions. Comments are stripped,
// and checks asking "does this module do X" read the production files only.
const committedFiles = (dir: string) => git(`ls-tree -r --name-only --full-tree HEAD ${dir}`).split(/\r?\n/).filter(Boolean)

const committedCode = (path: string) =>
  git(`show HEAD:${path}`)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n')

const committedCodeOf = (dir: string) => {
  const files = committedFiles(dir)
  return { files, code: files.map((file) => committedCode(file)).join('\n') }
}

const committedProductionCodeOf = (dir: string) => {
  const files = committedFiles(dir).filter((file) => !file.endsWith('.test.ts'))
  return { files, code: files.map((file) => committedCode(file)).join('\n') }
}

class RunAborted extends Error {}

const runId = `A55-${Date.now()}`
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
// A5.4 FINAL PASS was merged into main as PR #52; A5.5 is branched from that merge.
const a54Merge = '78a0d7d'
const a55Branch = 'feature/a5-5-pre-claim-commercial-context-resolution'
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'

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

// One line of an older suite's output, read by its id and its verdict token. The id is matched as a
// fixed prefix, never through a pattern built from it.
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

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  console.log(`[A5.5] Pre-claim commercial context resolution — run ${runId}`)
  console.log(`[A5.5] HEAD ${git('rev-parse HEAD')} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

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
    throw new RunAborted(
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
      throw new RunAborted(`the API at ${baseUrl} is not ready before ${what}; start it with \`npm start\``)
  }

  // ---------------------------------------------------------------- gates (T01–T06)
  section('Start gate, zero schema and permissions')
  const branch = git('rev-parse --abbrev-ref HEAD')
  check(
    'T01',
    'Start gate',
    branch === a55Branch && gitOk(`merge-base --is-ancestor ${a54Merge} origin/main`) && gitOk('merge-base --is-ancestor origin/main HEAD'),
    `branch ${branch}; the A5.4 merge ${a54Merge} (PR #52) is on main and this branch contains the latest main ${git('rev-parse --short origin/main')}`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  check('T02', 'Git clean', dirty.length === 0, dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.length} path(s)`)

  const schemaDiff = git('diff --name-only origin/main...HEAD -- :/backend/prisma/schema.prisma')
  check('T03', 'No schema change', schemaDiff === '', schemaDiff === '' ? 'backend/prisma/schema.prisma is byte-identical to main' : 'the Prisma schema was changed')
  const migrationDiff = git('diff --name-only origin/main...HEAD -- :/backend/prisma/migrations').split(/\r?\n/).filter(Boolean)
  const migrationsOn = (ref: string) => new Set(git(`ls-tree -r --name-only --full-tree ${ref} backend/prisma/migrations`).split(/\r?\n/).filter((line) => line.endsWith('migration.sql'))).size
  const mainMigrations = migrationsOn('origin/main')
  const headMigrations = migrationsOn('HEAD')
  check(
    'T04',
    'No migration',
    migrationDiff.length === 0 && headMigrations === mainMigrations && headMigrations > 0,
    `no migration file differs from main; ${headMigrations} migrations on HEAD, ${mainMigrations} on main`,
  )
  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T05', 'Prisma gates', validate.ok && generate.ok && status.ok && /Database schema is up to date/.test(status.output), 'schema valid, client generated, schema up to date')

  const allPermissionCodes = (await prisma.permission.findMany({ select: { code: true } })).map((row) => row.code)
  const contextPermissions = allPermissionCodes.filter((code) => code.startsWith('preClaimCommercialContext')).sort()
  const grants = await prisma.rolePermission.findMany({
    where: { permission: { code: 'preClaimCommercialContext.read' } },
    select: { role: { select: { code: true } } },
  })
  const invented = allPermissionCodes.filter((code) => /^preClaimCommercialContext\.(create|update|delete|resolve|select)|pricing|price\.|tariff_rate|reimburse/i.test(code))
  check(
    'T06',
    'Permissions',
    contextPermissions.join(',') === 'preClaimCommercialContext.read' && grants.map((g) => g.role.code).sort().join(',') === 'ORG_ADMIN,ORG_VIEWER' && invented.length === 0,
    invented.length === 0 ? 'exactly the aggregate read permission, granted to Admin and Viewer; no mutation or pricing permission' : `unexpected: ${invented.join(', ')}`,
  )

  // ---------------------------------------------------------------- fixtures
  await apiReady('signing in')
  let connectionResets = 0
  const httpCall = async (path: string, init?: RequestInit) => {
    try {
      return await callApi(baseUrl, path, init)
    } catch {
      connectionResets += 1
      throw new RunAborted(
        `the API connection was reset while calling ${path}. The server was replaced underneath this run, ` +
          'which is what a server started with `--watch` does whenever db:generate or a migration replay rewrites a file. ' +
          'Close the terminal tab running `npm run dev`, start the API with `npm start` in a tab of its own, and run this suite again.',
      )
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
  const get = (path: string, who = asAdmin) => httpCall(path, who())
  const must = <T extends { id?: string }>(label: string, body: T) => {
    if (!body?.id) throw new Error(`fixture ${label} could not be created through its owner route: ${JSON.stringify(body).slice(0, 250)}`)
    return body as T & { id: string }
  }
  let serial = 0
  const key = (prefix: string) => `${runId}-${prefix}-${++serial}`

  section('Fixtures through owner routes')
  const patient = must('patient', (await post(`/api/organizations/${org}/patients`, { givenName: 'Synthetic', familyName: `${runId}-P`, dateOfBirth: '1990-01-01' })).body)
  const newFacility = async (label: string) => {
    const facility = must(label, (await post(`/api/organizations/${org}/facilities`, { name: `${runId} ${label}` })).body)
    const profile = must(`${label} profile`, (await post(`/api/facilities/${facility.id}/regulatory-profiles`, { jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom: '2025-01-01', effectiveTo: null })).body)
    if ((await post(`/api/facility-regulatory-profiles/${profile.id}/activate`, {})).status !== 200) throw new Error(`fixture ${label} profile activation failed`)
    return { facility, profile }
  }
  const { facility } = await newFacility('facility')
  const { facility: facility2 } = await newFacility('facility 2')
  const clinician = must('clinician', (await post(`/api/organizations/${org}/clinicians`, { displayName: `${runId} clinician` })).body)
  for (const fac of [facility, facility2])
    must('assignment', (await post(`/api/clinicians/${clinician.id}/facility-assignments`, { facilityId: fac.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  const tpaA = must('tpa A', (await post(`/api/organizations/${org}/tpas`, { displayName: `${runId} tpa A` })).body)
  const tpaB = must('tpa B', (await post(`/api/organizations/${org}/tpas`, { displayName: `${runId} tpa B` })).body)
  const networkA = must('network A', (await post(`/api/organizations/${org}/networks`, { displayName: `${runId} network A` })).body)
  const networkB = must('network B', (await post(`/api/organizations/${org}/networks`, { displayName: `${runId} network B` })).body)
  const evidenceCount = await prisma.evidenceArtifact.count()
  console.log(`[A5.5]      fixtures ready: patient, 2 facilities with active profiles, clinician assigned at both, 2 TPAs, 2 networks`)

  // A commercial world of its own: a payer no other scenario uses, optionally a product (linked to a
  // network when one is carried), a membership carrying exactly the requested dimensions, and an
  // Encounter on the service date.
  type WorldOptions = { tpa?: boolean; network?: boolean; product?: boolean; encounter?: Record<string, unknown>; facilityId?: string; clinicianId?: string }
  const world = async (label: string, options: WorldOptions = {}) => {
    const payer = must(`${label} payer`, (await post(`/api/organizations/${org}/payers`, { displayName: `${runId} ${label} payer` })).body)
    const product = options.product
      ? must(`${label} product`, (await post(`/api/organizations/${org}/insurance-products`, { payerId: payer.id, productCode: key('PROD'), displayName: `${runId} ${label} product` })).body)
      : null
    const otherProduct = options.product
      ? must(`${label} other product`, (await post(`/api/organizations/${org}/insurance-products`, { payerId: payer.id, productCode: key('PROD'), displayName: `${runId} ${label} other product` })).body)
      : null
    if (product && options.network) must(`${label} product network`, (await post(`/api/insurance-products/${product.id}/product-networks`, { networkId: networkA.id })).body)
    const membership = must(`${label} membership`, (await post(`/api/patients/${patient.id}/insurance-memberships`, {
      payerId: payer.id,
      tpaId: options.tpa ? tpaA.id : null,
      networkId: options.network ? networkA.id : null,
      insuranceProductId: product ? product.id : null,
      memberIdentifier: `MEM-${key('M')}`,
      coverageFrom: '2025-01-01',
      coverageTo: null,
    })).body)
    const encounter = must(`${label} encounter`, (await post(`/api/patients/${patient.id}/encounters`, {
      facilityId: options.facilityId ?? facility.id,
      clinicianId: options.clinicianId ?? clinician.id,
      serviceDate: SERVICE_DATE,
      insuranceMembershipId: membership.id,
      ...(options.encounter ?? {}),
    })).body)
    return { payer, product, otherProduct, membership, encounter }
  }

  // A contract through the REF-01 route, linked to a facility unless told otherwise.
  const contract = async (payerId: string, overrides: Record<string, unknown> = {}, link: string | null = facility.id) => {
    const created = must('provider contract', (await post(`/api/organizations/${org}/provider-contracts`, {
      contractKey: key('C'), displayName: `${runId} contract`, payerId, tpaId: null, networkId: null, insuranceProductId: null,
      effectiveFrom: '2025-01-01', effectiveTo: null, ...overrides,
    })).body)
    if (link) must('contract facility', (await post(`/api/provider-contracts/${created.id}/contract-facilities`, { facilityId: link })).body)
    return created
  }
  const schedule = async (contractId: string) =>
    must('tariff schedule', (await post(`/api/provider-contracts/${contractId}/tariff-schedules`, { tariffKey: key('T'), displayName: `${runId} tariff` })).body)
  const version = async (scheduleId: string, dates: { effectiveFrom: string | null; effectiveTo: string | null }, status: 'UNVERIFIED' | 'IN_REVIEW' | 'VERIFIED' | 'REJECTED' = 'VERIFIED', label?: string) => {
    const created = must('tariff version', (await post(`/api/tariff-schedules/${scheduleId}/versions`, { version: label ?? key('V'), ...dates })).body)
    if (status !== 'UNVERIFIED') {
      const verified = await post(`/api/tariff-schedule-versions/${created.id}/verification`, { verificationStatus: status })
      if (verified.status !== 200) throw new Error(`fixture tariff verification ${status} returned ${verified.status}`)
    }
    return created
  }
  const OPEN = { effectiveFrom: '2026-01-01', effectiveTo: null }
  // A contract with one schedule holding one effective VERIFIED version: the resolvable shape.
  const resolvable = async (payerId: string, overrides: Record<string, unknown> = {}, link: string | null = facility.id) => {
    const c = await contract(payerId, overrides, link)
    const s = await schedule(c.id)
    const v = await version(s.id, OPEN)
    return { contract: c, schedule: s, version: v }
  }
  const resolve = async (encounterId: string, who = asAdmin) => {
    const res = await get(`/api/encounters/${encounterId}/pre-claim-commercial-context`, who)
    return { status: res.status, body: res.body as any }
  }
  const reasonOf = (r: { status: number; body: any }) => (r.status === 200 ? 'RESOLVED' : `${r.body?.error?.code}/${r.body?.error?.reason}`)
  const unresolvedAs = (r: { status: number; body: any }, reason: string) =>
    r.status === 409 && r.body?.error?.code === 'COMMERCIAL_CONTEXT_UNRESOLVED' && r.body?.error?.reason === reason
  const integrityAs = (r: { status: number; body: any }, reason: string) =>
    r.status === 409 && r.body?.error?.code === 'INTEGRITY_CONFLICT' && r.body?.error?.reason === reason

  // ---------------------------------------------------------------- access (T07–T12)
  section('Resolution, access and the selected membership')
  const main1 = await world('main', { tpa: true, network: true, product: true })
  const mainFit = await resolvable(main1.payer.id)
  await version(mainFit.schedule.id, OPEN, 'REJECTED')
  const resolved = await resolve(main1.encounter.id)
  check(
    'T07',
    'Admin resolve',
    resolved.status === 200 && resolved.body?.schemaVersion === 'PreClaimCommercialContextV1' &&
      resolved.body?.providerContractId === mainFit.contract.id && resolved.body?.tariffScheduleVersionId === mainFit.version.id,
    `200 ${reasonOf(resolved)}: the one contract and the one VERIFIED effective version, beside a REJECTED one`,
  )
  const viewerResolve = await resolve(main1.encounter.id, asViewer)
  check('T08', 'Viewer resolve', viewerResolve.status === 200 && viewerResolve.body?.providerContractId === mainFit.contract.id, 'a viewer resolves the same context')
  const malformed = await resolve('not-a-uuid')
  check('T09', 'Malformed Encounter', malformed.status === 400 && malformed.body?.error?.code === 'VALIDATION_ERROR' && !/prisma|postgres|syntax/i.test(JSON.stringify(malformed.body)), '400 VALIDATION_ERROR with a safe envelope')
  const missing = await resolve(MISSING)
  check('T10', 'Missing Encounter', missing.status === 404 && missing.body?.error?.code === 'NOT_FOUND', '404 NOT_FOUND')
  const foreignEncounter = await prisma.encounter.findFirst({ where: { patient: { organizationId: otherOrg } }, select: { id: true } })
  const foreign = foreignEncounter ? await resolve(foreignEncounter.id) : null
  const foreignText = JSON.stringify(foreign?.body ?? {})
  check(
    'T11',
    'Cross-tenant Encounter',
    foreign !== null && foreign.status >= 400 && foreign.status < 500 && !/providerContractId|tariffSchedule|payerId/.test(foreignText) && !foreignText.includes(otherOrg),
    foreign ? `refused ${foreign.status} with no commercial context and no tenant disclosed` : 'no other-tenant Encounter exists to test against',
  )
  const selfPay = must('encounter with no membership', (await post(`/api/patients/${patient.id}/encounters`, { facilityId: facility.id, clinicianId: clinician.id, serviceDate: SERVICE_DATE })).body)
  const noMembership = await resolve(selfPay.id)
  check('T12', 'No selected membership', unresolvedAs(noMembership, 'NO_SELECTED_MEMBERSHIP'), `${reasonOf(noMembership)}: no self-pay or default contract is inferred`)

  // ---------------------------------------------------------------- A4 integrity and coherence (T13–T19)
  section('Authoritative Encounter context — A4.9 and A4.3 owners, one snapshot')
  const coverageWorld = await world('coverage')
  await resolvable(coverageWorld.payer.id)
  const coverageBefore = await resolve(coverageWorld.encounter.id)
  const coverageFix = await patchApi(`/api/insurance-memberships/${coverageWorld.membership.id}`, { coverageTo: '2026-05-31' })
  const coverageAfter = await resolve(coverageWorld.encounter.id)
  check(
    'T13',
    'A4 membership integrity',
    coverageBefore.status === 200 && coverageFix.status === 200 && integrityAs(coverageAfter, 'A4_INTEGRITY_CONFLICT') && /coverage period/.test(coverageAfter.body?.error?.message ?? ''),
    `resolved before; after the coverage was corrected to end 2026-05-31 (PATCH ${coverageFix.status}) -> ${reasonOf(coverageAfter)} before any contract was evaluated`,
  )

  const integrity = await newFacility('integrity facility')
  const integrityClinician = must('integrity clinician', (await post(`/api/organizations/${org}/clinicians`, { displayName: `${runId} integrity clinician` })).body)
  const integrityAssignment = must('integrity assignment', (await post(`/api/clinicians/${integrityClinician.id}/facility-assignments`, { facilityId: integrity.facility.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  const assignmentWorld = await world('assignment', { facilityId: integrity.facility.id, clinicianId: integrityClinician.id })
  await resolvable(assignmentWorld.payer.id, {}, integrity.facility.id)
  const assignmentBefore = await resolve(assignmentWorld.encounter.id)
  const assignmentClose = await post(`/api/clinician-facility-assignments/${integrityAssignment.id}/close`, { effectiveTo: '2026-06-14' })
  must('covering alternative assignment', (await post(`/api/clinicians/${integrityClinician.id}/facility-assignments`, { facilityId: integrity.facility.id, effectiveFrom: '2026-06-15', effectiveTo: null })).body)
  const assignmentAfter = await resolve(assignmentWorld.encounter.id)
  check(
    'T14',
    'A4 assignment integrity',
    assignmentBefore.status === 200 && assignmentClose.status === 200 && integrityAs(assignmentAfter, 'A4_INTEGRITY_CONFLICT') && /assignment/.test(assignmentAfter.body?.error?.message ?? ''),
    `resolved before; after the recorded assignment was closed on 2026-06-14 -> ${reasonOf(assignmentAfter)}, and the covering newer assignment is not substituted`,
  )
  const profileWorld = await world('profile', { facilityId: integrity.facility.id, clinicianId: integrityClinician.id })
  await resolvable(profileWorld.payer.id, {}, integrity.facility.id)
  const profileBefore = await resolve(profileWorld.encounter.id)
  const profileClose = await patchApi(`/api/facility-regulatory-profiles/${integrity.profile.id}`, { effectiveTo: '2026-06-14' })
  const altProfile = must('covering alternative profile', (await post(`/api/facilities/${integrity.facility.id}/regulatory-profiles`, { jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom: '2026-06-15', effectiveTo: null })).body)
  await post(`/api/facility-regulatory-profiles/${altProfile.id}/activate`, {})
  const profileAfter = await resolve(profileWorld.encounter.id)
  check(
    'T15',
    'A4 profile integrity',
    profileBefore.status === 200 && profileClose.status === 200 && integrityAs(profileAfter, 'A4_INTEGRITY_CONFLICT') && /regulatory profile/.test(profileAfter.body?.error?.message ?? ''),
    `resolved before; after the recorded profile was closed on 2026-06-14 -> ${reasonOf(profileAfter)}, and the newer ACTIVE profile is not substituted`,
  )

  // No route can produce an incoherent membership (A4.3 refuses it on write), so the corruption is
  // adversarial and restored.
  const coherenceWorld = await world('coherence')
  await resolvable(coherenceWorld.payer.id)
  const coherenceBefore = await resolve(coherenceWorld.encounter.id)
  const foreignPayer = await prisma.payer.findFirst({ where: { organizationId: otherOrg }, select: { id: true } })
  let coherenceAfter = { status: 0, body: null as any }
  if (foreignPayer) {
    await prisma.insuranceMembership.update({ where: { id: coherenceWorld.membership.id }, data: { payerId: foreignPayer.id } })
    try {
      coherenceAfter = await resolve(coherenceWorld.encounter.id)
    } finally {
      await prisma.insuranceMembership.update({ where: { id: coherenceWorld.membership.id }, data: { payerId: coherenceWorld.payer.id } })
    }
  }
  const coherenceRestored = await resolve(coherenceWorld.encounter.id)
  check(
    'T16',
    'Membership commercial coherence',
    foreignPayer !== null && coherenceBefore.status === 200 && integrityAs(coherenceAfter, 'A4_INTEGRITY_CONFLICT') && !JSON.stringify(coherenceAfter.body).includes(otherOrg) && coherenceRestored.status === 200,
    `a membership corrupted to another tenant's payer -> ${reasonOf(coherenceAfter)} through A4.3's own rule ("${coherenceAfter.body?.error?.message ?? ''}"); restored, it resolves again`,
  )

  const serviceSource = committedCode('backend/src/modules/pre-claim-commercial-context/pre-claim-commercial-context.service.ts')
  const productionCode = committedProductionCodeOf('backend/src/modules/pre-claim-commercial-context')
  check(
    'T17',
    'No public API chaining',
    productionCode.files.length > 0 && !/\bfetch\(|callApi|axios|['"`]\/api\//.test(productionCode.code) &&
      /verifySelectedMembership\(/.test(serviceSource) && /verifyStoredAssignment\(/.test(serviceSource) && /verifyStoredProfile\(/.test(serviceSource) &&
      /decideCommercialCoherence\(/.test(serviceSource) && /findEncounterForBillingContext\(encounterId, tx\)/.test(serviceSource),
    'the resolver calls A4.9 and A4.3 internal helpers with its own transaction client; no HTTP call, no second snapshot',
  )
  const snapshotSettings = await withReadSnapshot(undefined, async (tx) =>
    tx.$queryRaw<{ isolation: string; read_only: string }[]>`SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only`,
  )
  check(
    'T18',
    'Read-only snapshot',
    snapshotSettings[0]?.isolation === 'repeatable read' && snapshotSettings[0]?.read_only === 'on' && /withReadSnapshot\(db, async \(tx\)/.test(serviceSource),
    'the resolver runs inside withReadSnapshot, which the database reports as REPEATABLE READ and READ ONLY',
  )
  // Hold the resolution right after its snapshot is taken: the transaction timestamp stays at the
  // start, while the application clock moves on. A resolvedAt from the app clock would be late.
  const clockGate = holdAt('pre_claim_commercial_context.snapshot')
  const clockStart = Date.now()
  const heldClock = resolvePreClaimCommercialContext(main1.encounter.id)
  await clockGate.arrived
  await new Promise((resolve) => setTimeout(resolve, 1500))
  clockGate.release()
  const clockResult = await heldClock
  clearConcurrencyProbes()
  const resolvedAtMs = clockResult.ok ? Date.parse(clockResult.value.resolvedAt) : NaN
  check(
    'T19',
    'resolvedAt truth',
    clockResult.ok && resolvedAtMs - clockStart < 1000 && /readTransactionTimestamp\(tx\)/.test(serviceSource) && !/new Date\(\)/.test(serviceSource),
    `resolvedAt is the database transaction start (${Number.isNaN(resolvedAtMs) ? 'none' : `${resolvedAtMs - clockStart} ms after the call`}), not the application clock 1.5 s later`,
  )

  // ---------------------------------------------------------------- contract candidates (T20–T35)
  section('ProviderContract candidates — exact, wildcard, facility and date')
  const orgWorld = await world('org')
  const orgFit = await resolvable(orgWorld.payer.id)
  const orgBefore = await resolve(orgWorld.encounter.id)
  // Moving the contract to another organization is adversarial and restored. Should the database
  // itself refuse the move, the same real row is judged by the resolver with only its organization
  // changed in memory.
  let orgAfter = { status: 0, body: null as any }
  const moveRefused = await attemptAdversarial(() => prisma.providerContract.update({ where: { id: orgFit.contract.id }, data: { organizationId: otherOrg } }))
  if (moveRefused === '') {
    try {
      orgAfter = await resolve(orgWorld.encounter.id)
    } finally {
      await prisma.providerContract.update({ where: { id: orgFit.contract.id }, data: { organizationId: org } })
    }
  }
  const orgRow = await prisma.providerContract.findUniqueOrThrow({ where: { id: orgFit.contract.id } })
  const inMemory = resolveContract([{ ...orgRow, organizationId: otherOrg, participatesAtFacility: true }], {
    organizationId: org, payerId: orgWorld.payer.id, tpaId: null, networkId: null, insuranceProductId: null, facilityId: facility.id, serviceDate: new Date(`${SERVICE_DATE}T00:00:00.000Z`),
  })
  check(
    'T20',
    'Contract org',
    orgBefore.status === 200 && orgRow.organizationId === org && inMemory.kind === 'unresolved' && inMemory.reason === 'NO_APPLICABLE_CONTRACT' &&
      (moveRefused !== '' || (unresolvedAs(orgAfter, 'NO_APPLICABLE_CONTRACT') && !JSON.stringify(orgAfter.body).includes(orgFit.contract.id))),
    moveRefused === ''
      ? `the same contract, moved to another organization (adversarial, restored), is no candidate: ${reasonOf(orgAfter)}`
      : 'the database refused moving the contract to another organization; the resolver excludes the same row with a foreign organization',
  )
  const payerWorld = await world('payer')
  const strangerPayer = must('stranger payer', (await post(`/api/organizations/${org}/payers`, { displayName: `${runId} stranger payer` })).body)
  await resolvable(strangerPayer.id)
  const payerResult = await resolve(payerWorld.encounter.id)
  check('T21', 'Contract payer exact', unresolvedAs(payerResult, 'NO_APPLICABLE_CONTRACT'), `a same-organization contract for a different payer is excluded: ${reasonOf(payerResult)}`)

  const dimension = async (id: string, title: string, options: WorldOptions, overrides: (w: Awaited<ReturnType<typeof world>>) => Record<string, unknown>, expect: 'RESOLVED' | 'NO_APPLICABLE_CONTRACT', detail: string) => {
    const w = await world(title, options)
    await resolvable(w.payer.id, overrides(w))
    const r = await resolve(w.encounter.id)
    check(id, title, expect === 'RESOLVED' ? r.status === 200 : unresolvedAs(r, expect), `${detail}: ${reasonOf(r)}`)
  }
  await dimension('T22', 'Contract TPA wildcard', { tpa: true }, () => ({ tpaId: null }), 'RESOLVED', 'a contract with no TPA matches an Encounter carrying one')
  {
    const exact = await world('Contract TPA exact', { tpa: true })
    await resolvable(exact.payer.id, { tpaId: tpaA.id })
    const exactHit = await resolve(exact.encounter.id)
    const other = await world('Contract TPA other', { tpa: true })
    await resolvable(other.payer.id, { tpaId: tpaB.id })
    const otherMiss = await resolve(other.encounter.id)
    check('T23', 'Contract TPA exact', exactHit.status === 200 && unresolvedAs(otherMiss, 'NO_APPLICABLE_CONTRACT'), `the same TPA matches (${reasonOf(exactHit)}); a different TPA does not (${reasonOf(otherMiss)})`)
  }
  await dimension('T24', 'Contract TPA missing context', {}, () => ({ tpaId: tpaA.id }), 'NO_APPLICABLE_CONTRACT', 'a contract requiring a TPA excludes an Encounter carrying none')
  await dimension('T25', 'Contract network wildcard', { network: true, product: true }, () => ({ networkId: null }), 'RESOLVED', 'a contract with no network matches an Encounter carrying one')
  {
    const exact = await world('Contract network exact', { network: true, product: true })
    await resolvable(exact.payer.id, { networkId: networkA.id })
    const exactHit = await resolve(exact.encounter.id)
    const other = await world('Contract network other', { network: true, product: true })
    await resolvable(other.payer.id, { networkId: networkB.id })
    const otherMiss = await resolve(other.encounter.id)
    check('T26', 'Contract network exact', exactHit.status === 200 && unresolvedAs(otherMiss, 'NO_APPLICABLE_CONTRACT'), `the same network matches (${reasonOf(exactHit)}); a different one does not (${reasonOf(otherMiss)})`)
  }
  await dimension('T27', 'Contract product wildcard', { product: true }, () => ({ insuranceProductId: null }), 'RESOLVED', 'a contract with no product matches an Encounter carrying one')
  {
    const exact = await world('Contract product exact', { product: true })
    await resolvable(exact.payer.id, { insuranceProductId: exact.product!.id })
    const exactHit = await resolve(exact.encounter.id)
    const other = await world('Contract product other', { product: true })
    await resolvable(other.payer.id, { insuranceProductId: other.otherProduct!.id })
    const otherMiss = await resolve(other.encounter.id)
    check('T28', 'Contract product exact', exactHit.status === 200 && unresolvedAs(otherMiss, 'NO_APPLICABLE_CONTRACT'), `the same product matches (${reasonOf(exactHit)}); another product of the same payer does not (${reasonOf(otherMiss)})`)
  }
  {
    const w = await world('Contract product missing context')
    const unusedProduct = must('unused product', (await post(`/api/organizations/${org}/insurance-products`, { payerId: w.payer.id, productCode: key('PROD'), displayName: `${runId} unused product` })).body)
    await resolvable(w.payer.id, { insuranceProductId: unusedProduct.id })
    const r = await resolve(w.encounter.id)
    check('T29', 'Contract product missing context', unresolvedAs(r, 'NO_APPLICABLE_CONTRACT'), `a contract requiring a product excludes an Encounter carrying none: ${reasonOf(r)}`)
  }
  check('T30', 'Facility participation', resolved.status === 200 && (await prisma.contractFacility.count({ where: { providerContractId: mainFit.contract.id, facilityId: facility.id } })) === 1, 'the resolved contract carries the exact ContractFacility pair for the Encounter facility')
  {
    const w = await world('facility mismatch')
    await resolvable(w.payer.id, {}, facility2.id)
    const r = await resolve(w.encounter.id)
    check('T31', 'Facility mismatch', unresolvedAs(r, 'NO_APPLICABLE_CONTRACT'), `a same-organization contract linked only to another facility is excluded: ${reasonOf(r)}`)
  }
  await dimension('T32', 'Contract lower date', {}, () => ({ effectiveFrom: '2026-06-16' }), 'NO_APPLICABLE_CONTRACT', 'a contract starting the day after the service date is excluded')
  await dimension('T33', 'Contract upper date', {}, () => ({ effectiveTo: '2026-06-14' }), 'NO_APPLICABLE_CONTRACT', 'a contract ending the day before the service date is excluded')
  await dimension('T34', 'Contract inclusive dates', {}, () => ({ effectiveFrom: SERVICE_DATE, effectiveTo: SERVICE_DATE }), 'RESOLVED', 'a one-day contract on exactly the service date matches')
  await dimension('T35', 'Open contract end', {}, () => ({ effectiveFrom: '2020-01-01', effectiveTo: null }), 'RESOLVED', 'an open-ended contract still applies years after it began')

  // ---------------------------------------------------------------- contract resolution (T36–T42)
  section('Contract resolution — zero, one, many, and no hidden precedence')
  const noContract = await world('no contract')
  const noContractResult = await resolve(noContract.encounter.id)
  check('T36', 'No contract', unresolvedAs(noContractResult, 'NO_APPLICABLE_CONTRACT'), reasonOf(noContractResult))
  check('T37', 'One contract', resolved.status === 200 && resolved.body?.providerContractId === mainFit.contract.id, 'exactly one candidate resolves to that contract')
  const twoWorld = await world('two contracts')
  await resolvable(twoWorld.payer.id)
  await resolvable(twoWorld.payer.id)
  const twoResult = await resolve(twoWorld.encounter.id)
  check('T38', 'Contract ambiguity', unresolvedAs(twoResult, 'AMBIGUOUS_CONTRACT'), `${reasonOf(twoResult)} — no winner invented`)
  {
    const w = await world('specificity', { tpa: true, network: true, product: true })
    await resolvable(w.payer.id)
    await resolvable(w.payer.id, { tpaId: tpaA.id, networkId: networkA.id, insuranceProductId: w.product!.id })
    const r = await resolve(w.encounter.id)
    check('T39', 'No contract specificity rank', unresolvedAs(r, 'AMBIGUOUS_CONTRACT'), `a wildcard contract and a fully constrained one both apply: ${reasonOf(r)}`)
  }
  {
    const w = await world('latest')
    const older = await resolvable(w.payer.id)
    await resolvable(w.payer.id)
    // Touch the OLDER contract through its owner route, so it is now also the most recently updated.
    await patchApi(`/api/provider-contracts/${older.contract.id}`, { displayName: `${runId} renamed` })
    const r = await resolve(w.encounter.id)
    check('T40', 'No contract latest rank', unresolvedAs(r, 'AMBIGUOUS_CONTRACT'), `neither the newest-created nor the most-recently-updated contract wins: ${reasonOf(r)}`)
  }
  {
    const w = await world('key')
    await resolvable(w.payer.id, { contractKey: `AAA-${key('C')}` })
    await resolvable(w.payer.id, { contractKey: `ZZZ-${key('C')}` })
    const r = await resolve(w.encounter.id)
    check('T41', 'No contractKey rank', unresolvedAs(r, 'AMBIGUOUS_CONTRACT'), `keys AAA… and ZZZ… do not choose a winner: ${reasonOf(r)}`)
  }
  // Order independence on real rows: every ordering of the stored candidates for two worlds — one
  // resolvable, one ambiguous — gives the same answer.
  const permutations = <T,>(rows: T[]): T[][] => (rows.length <= 1 ? [rows] : rows.flatMap((row, i) => permutations([...rows.slice(0, i), ...rows.slice(i + 1)]).map((rest) => [row, ...rest])))
  const realContracts = async (payerId: string) =>
    (await prisma.providerContract.findMany({ where: { organizationId: org, payerId } })).map((row) => ({ ...row, participatesAtFacility: true }))
  const inputsFor = (payerId: string) => ({ organizationId: org, payerId, tpaId: null, networkId: null, insuranceProductId: null, facilityId: facility.id, serviceDate: new Date(`${SERVICE_DATE}T00:00:00.000Z`) })
  const twoRows = [...(await realContracts(twoWorld.payer.id)), ...(await realContracts(strangerPayer.id))]
  const contractOrders = permutations(twoRows).map((rows) => JSON.stringify(resolveContract(rows, inputsFor(twoWorld.payer.id))))
  check('T42', 'Contract order independence', contractOrders.length >= 6 && new Set(contractOrders).size === 1, `${contractOrders.length} orderings of the stored candidates all give the same result`)

  // ---------------------------------------------------------------- tariff lifecycle (T43–T48)
  section('Tariff candidates — the resolved contract only, VERIFIED only')
  {
    const w = await world('tariff parent')
    await contract(w.payer.id)
    const neighbour = await world('tariff neighbour')
    await resolvable(neighbour.payer.id)
    const r = await resolve(w.encounter.id)
    check('T43', 'Tariff parent', unresolvedAs(r, 'NO_APPLICABLE_TARIFF_VERSION'), `another contract's effective VERIFIED version is never examined: ${reasonOf(r)}`)
  }
  const statusOnly = async (id: string, title: string, statusValue: 'UNVERIFIED' | 'IN_REVIEW' | 'REJECTED') => {
    const w = await world(title)
    const c = await contract(w.payer.id)
    await version((await schedule(c.id)).id, OPEN, statusValue)
    const r = await resolve(w.encounter.id)
    check(id, title, unresolvedAs(r, 'NO_APPLICABLE_TARIFF_VERSION'), `an effective ${statusValue} version is not a candidate: ${reasonOf(r)}`)
  }
  await statusOnly('T44', 'UNVERIFIED tariff', 'UNVERIFIED')
  await statusOnly('T45', 'IN_REVIEW tariff', 'IN_REVIEW')
  await statusOnly('T46', 'REJECTED tariff', 'REJECTED')
  check('T47', 'VERIFIED tariff', resolved.status === 200 && resolved.body?.tariffScheduleVersionId === mainFit.version.id, 'a VERIFIED effective version becomes the resolved candidate')
  // VERIFIED with no verifiedAt: REF-01's database CHECK makes the row impossible, so the resolver's
  // own fail-closed branch is proven on a real row with verifiedAt removed in memory.
  const verifiedRow = await prisma.tariffScheduleVersion.findUniqueOrThrow({ where: { id: mainFit.version.id } })
  const dbRefusal = await attemptAdversarial(() => prisma.tariffScheduleVersion.update({ where: { id: mainFit.version.id }, data: { verifiedAt: null } }))
  const brokenInMemory = resolveTariff([{ id: mainFit.schedule.id, versions: [{ ...verifiedRow, verifiedAt: null }] }], new Date(`${SERVICE_DATE}T00:00:00.000Z`))
  check(
    'T48',
    'VERIFIED integrity',
    /tariff_schedule_versions_verified_at_chk/.test(dbRefusal) && brokenInMemory.kind === 'integrity' && brokenInMemory.reason === 'TARIFF_INTEGRITY_CONFLICT' &&
      (await prisma.tariffScheduleVersion.findUniqueOrThrow({ where: { id: mainFit.version.id } })).verifiedAt !== null,
    'the database CHECK refuses VERIFIED with no verifiedAt, and the resolver fails closed as TARIFF_INTEGRITY_CONFLICT on such a row should one ever exist',
  )

  // ---------------------------------------------------------------- tariff dates (T49–T56)
  section('Tariff dates — inclusive, and an unknown start is never assumed')
  const tariffCase = async (label: string, dates: Array<{ effectiveFrom: string | null; effectiveTo: string | null }>, separateSchedules = false) => {
    const w = await world(label)
    const c = await contract(w.payer.id)
    const sharedSchedule = await schedule(c.id)
    const versions = []
    for (const d of dates) versions.push(await version(separateSchedules ? (await schedule(c.id)).id : sharedSchedule.id, d))
    return { world: w, result: await resolve(w.encounter.id), versions, scheduleId: sharedSchedule.id, contractId: c.id }
  }
  const startBound = await tariffCase('tariff start', [{ effectiveFrom: '2026-06-16', effectiveTo: null }])
  check('T49', 'Tariff start bound', unresolvedAs(startBound.result, 'NO_APPLICABLE_TARIFF_VERSION'), `a version starting after the service date: ${reasonOf(startBound.result)}`)
  const endBound = await tariffCase('tariff end', [{ effectiveFrom: '2026-01-01', effectiveTo: '2026-06-14' }])
  check('T50', 'Tariff end bound', unresolvedAs(endBound.result, 'NO_APPLICABLE_TARIFF_VERSION'), `a version ending before the service date: ${reasonOf(endBound.result)}`)
  const inclusive = await tariffCase('tariff inclusive', [{ effectiveFrom: SERVICE_DATE, effectiveTo: SERVICE_DATE }])
  check('T51', 'Tariff inclusive boundary', inclusive.result.status === 200 && inclusive.result.body?.tariffScheduleVersionId === inclusive.versions[0].id, 'a one-day version on exactly the service date resolves')
  const openEnd = await tariffCase('tariff open', [{ effectiveFrom: '2020-01-01', effectiveTo: null }])
  check('T52', 'Tariff open end', openEnd.result.status === 200, 'a version with no end still applies years after it began')
  const endedUnknown = await tariffCase('tariff ended unknown start', [{ effectiveFrom: '2026-01-01', effectiveTo: null }, { effectiveFrom: null, effectiveTo: '2026-06-01' }])
  check(
    'T53',
    'Missing start definitely ended',
    endedUnknown.result.status === 200 && endedUnknown.result.body?.tariffScheduleVersionId === endedUnknown.versions[0].id,
    'an unknown-start version that has already ended does not block the clear one',
  )
  const unknownOpen = await tariffCase('tariff unknown open', [{ effectiveFrom: null, effectiveTo: null }])
  check('T54', 'Missing start potentially applies', unresolvedAs(unknownOpen.result, 'INDETERMINATE_TARIFF_DATES'), `missing start fails closed: ${reasonOf(unknownOpen.result)}`)
  const blocksGuess = await tariffCase('tariff blocks guess', [{ effectiveFrom: '2026-01-01', effectiveTo: null }, { effectiveFrom: null, effectiveTo: '2026-12-31' }])
  check('T55', 'Indeterminate blocks guessing', unresolvedAs(blocksGuess.result, 'INDETERMINATE_TARIFF_DATES'), `a clear version beside an unknown-start one that could apply is not chosen: ${reasonOf(blocksGuess.result)}`)
  {
    const w = await world('no tariff')
    await contract(w.payer.id)
    const r = await resolve(w.encounter.id)
    check('T56', 'No tariff', unresolvedAs(r, 'NO_APPLICABLE_TARIFF_VERSION'), `a resolved contract with no tariff schedule at all: ${reasonOf(r)}`)
  }

  // ---------------------------------------------------------------- tariff resolution (T57–T62)
  section('Tariff resolution — one pair, or no answer')
  check(
    'T57',
    'One tariff pair',
    resolved.status === 200 && resolved.body?.tariffScheduleId === mainFit.schedule.id && resolved.body?.tariffScheduleVersionId === mainFit.version.id,
    'exactly one definite schedule/version pair resolves to that pair',
  )
  const sameSchedule = await tariffCase('two versions one schedule', [OPEN, { effectiveFrom: '2026-06-01', effectiveTo: null }])
  check('T58', 'Two versions same schedule', unresolvedAs(sameSchedule.result, 'AMBIGUOUS_TARIFF_VERSION'), `${reasonOf(sameSchedule.result)} — no supersession inferred`)
  const twoSchedules = await tariffCase('two schedules', [OPEN, OPEN], true)
  check('T59', 'Two schedules', unresolvedAs(twoSchedules.result, 'AMBIGUOUS_TARIFF_VERSION'), `one effective version under each of two schedules: ${reasonOf(twoSchedules.result)}`)
  {
    const w = await world('version text')
    const c = await contract(w.payer.id)
    const s = await schedule(c.id)
    await version(s.id, OPEN, 'VERIFIED', 'v2')
    await version(s.id, OPEN, 'VERIFIED', 'v10')
    const r = await resolve(w.encounter.id)
    check('T60', 'No version text rank', unresolvedAs(r, 'AMBIGUOUS_TARIFF_VERSION'), `versions labelled v2 and v10: ${reasonOf(r)}`)
  }
  {
    const w = await world('tariff created')
    const c = await contract(w.payer.id)
    const s = await schedule(c.id)
    await version(s.id, OPEN)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await version(s.id, OPEN)
    const r = await resolve(w.encounter.id)
    check('T61', 'No tariff createdAt rank', unresolvedAs(r, 'AMBIGUOUS_TARIFF_VERSION'), `the newest version does not win: ${reasonOf(r)}`)
  }
  const realSchedules = async (contractId: string) =>
    prisma.tariffSchedule.findMany({ where: { providerContractId: contractId }, select: { id: true, versions: { select: { id: true, verificationStatus: true, verifiedAt: true, effectiveFrom: true, effectiveTo: true } } } })
  const tariffOrders: string[] = []
  for (const contractId of [twoSchedules.contractId, mainFit.contract.id]) {
    const schedules = await realSchedules(contractId)
    for (const order of permutations(schedules))
      for (const reversed of [false, true])
        tariffOrders.push(`${contractId}:${JSON.stringify(resolveTariff(order.map((s) => ({ ...s, versions: reversed ? [...s.versions].reverse() : s.versions })), new Date(`${SERVICE_DATE}T00:00:00.000Z`)))}`)
  }
  check('T62', 'Tariff order independence', tariffOrders.length >= 6 && new Set(tariffOrders).size === 2, `${tariffOrders.length} orderings of stored schedules and versions across two contracts give exactly one answer each`)

  // ---------------------------------------------------------------- DTO (T63–T69)
  section('PreClaimCommercialContextV1 — exact IDs and nothing else')
  const storedEncounter = await prisma.encounter.findUniqueOrThrow({ where: { id: main1.encounter.id } })
  const body = resolved.body ?? {}
  check(
    'T63',
    'Success DTO exact IDs',
    body.organizationId === org && body.encounterId === storedEncounter.id && body.serviceDate === SERVICE_DATE && body.facilityId === storedEncounter.facilityId &&
      body.facilityRegulatoryProfileId === storedEncounter.facilityRegulatoryProfileId && body.payerId === main1.payer.id && body.tpaId === tpaA.id &&
      body.networkId === networkA.id && body.insuranceProductId === main1.product!.id && body.providerContractId === mainFit.contract.id &&
      body.tariffScheduleId === mainFit.schedule.id && body.tariffScheduleVersionId === mainFit.version.id,
    'every identity is the exact stored row: encounter, facility, profile, payer, TPA, network, product, contract, schedule and version',
  )
  const keys = deepKeys(body)
  const keysMatching = (pattern: RegExp) => [...keys].filter((name) => pattern.test(name))
  check('T64', 'No display-name snapshot', keysMatching(/name|label|key$|^version$|displayName|contractKey|tariffKey/i).length === 0, 'no display name, key or version label — only stable IDs')
  check('T65', 'No member/policy', keysMatching(/member|policy/i).length === 0 && !JSON.stringify(body).includes('MEM-'), 'no member or policy identifier, by key or by value')
  check('T66', 'No authorization/evidence data', keysMatching(/authoriz|evidence|storage|contentHash|document/i).length === 0, 'no authorization or evidence field')
  check('T67', 'No pricing fields', keysMatching(/price|rate|fee|amount|reimburs|responsibility|allowed|charge|cost/i).length === 0, 'no price, rate, fee, amount, reimbursement or patient-responsibility field')
  check('T68', 'No readiness fields', keysMatching(/ready|readiness|restrict|block|submission|payerAcceptance/i).length === 0, 'no ready, restrict, block, submission or payer-acceptance field')
  const tables = (await prisma.$queryRaw<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`).map((row) => row.table_name)
  check(
    'T69',
    'No Claim',
    !tables.some((name) => /(^claims?$|claim_lines?|claim_submissions?|remittance)/i.test(name)) && !/(prisma|tx)\.(claim|claimLine|claimSubmission)\b/.test(productionCode.code),
    `no Claim, ClaimLine or ClaimSubmission among ${tables.length} tables, and none is read`,
  )

  // ---------------------------------------------------------------- persistence (T70–T74)
  section('No persistence, no audit, no second resolver')
  const countAll = async () => {
    const counts: Record<string, number> = {}
    for (const table of tables) counts[table] = Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${table}"`))[0].n)
    return counts
  }
  const countsBefore = await countAll()
  const auditBefore = await prisma.auditEvent.count()
  for (let i = 0; i < 3; i += 1) await resolve(main1.encounter.id)
  await resolve(twoWorld.encounter.id)
  await resolve(unknownOpen.world.encounter.id)
  const countsAfter = await countAll()
  const changedTables = tables.filter((table) => countsBefore[table] !== countsAfter[table] && !/^(session|verification)$/.test(table))
  check('T70', 'No persisted resolution', changedTables.length === 0, changedTables.length === 0 ? `five resolutions (resolved, ambiguous, indeterminate) changed no row count in any of ${tables.length} tables` : `changed: ${changedTables.join(', ')}`)
  check('T71', 'No AuditEvent', (await prisma.auditEvent.count()) === auditBefore, 'repeated resolution wrote zero AuditEvent rows')
  const columns = (await prisma.$queryRaw<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`).map((row) => `${row.table_name}.${row.column_name}`)
  const stateColumns = columns.filter((name) => /(selected_contract|resolved_contract|winner|current_contract|selected_tariff|resolved_tariff|commercial_context)/i.test(name))
  const stateTables = tables.filter((name) => /(commercial_context|contract_selection|tariff_selection|resolution_result)/i.test(name))
  check('T72', 'No second resolver state', stateColumns.length === 0 && stateTables.length === 0, `no current, winner or selected commercial column among ${columns.length}, and no selection table`)
  const handoff = await validateApplicabilityContextCoherence(
    {
      facilityId: body.facilityId,
      facilityRegulatoryProfileId: body.facilityRegulatoryProfileId,
      payerId: body.payerId,
      tpaId: body.tpaId,
      networkId: body.networkId,
      insuranceProductId: body.insuranceProductId,
      providerContractId: body.providerContractId,
      tariffScheduleId: body.tariffScheduleId,
      tariffScheduleVersionId: body.tariffScheduleVersionId,
      serviceId: null,
      procedureCodeId: null,
      diagnosisCodeId: null,
    },
    org,
    prisma,
  )
  check('T73', 'A3 context handoff', handoff.ok, handoff.ok ? "the nine resolved IDs populate A3's ApplicabilityContextV2 exactly and pass A3's own ancestry coherence" : `A3 refused: ${(handoff as any).message}`)
  check(
    'T74',
    'No A3 rule execution',
    productionCode.files.length > 0 && !/from '[^']*modules\/(rule-resolution|rule-applicability|rule-executability|rule-pack|rule-provenance)/.test(productionCode.code) && !/ruleDecision|RuleDecision/.test(productionCode.code),
    'the resolver imports no A3 resolution, applicability, executability or provenance module and writes no RuleDecision',
  )

  // ---------------------------------------------------------------- concurrency (T75–T80)
  section('One snapshot under concurrent correction — never a mixture, never a lock')
  // Each case holds an in-process resolution just after its snapshot is taken, commits a correction
  // through the owner route on another connection WHILE it is held, then releases. The held result
  // must be wholly the state before; a fresh call afterwards may legitimately differ.
  const raced = async (label: string, encounterId: string, correct: () => Promise<number>) => {
    const gate = holdAt('pre_claim_commercial_context.snapshot')
    const held = resolvePreClaimCommercialContext(encounterId)
    await gate.arrived
    // The correction is awaited while the resolution is still held: if resolution took a row lock,
    // this would wait for a release that never comes.
    const correction = await Promise.race([correct(), new Promise<number>((resolve) => setTimeout(() => resolve(-1), 15_000))])
    gate.release()
    const before = await held
    clearConcurrencyProbes()
    const after = await resolve(encounterId)
    return { label, correction, before, after }
  }
  const raceWorld = async (label: string, extra: WorldOptions = {}) => {
    const w = await world(label, extra)
    const fit = await resolvable(w.payer.id)
    return { w, fit }
  }
  const encounterRace = await raceWorld('encounter race')
  const t75 = await raced('encounter', encounterRace.w.encounter.id, async () => (await patchApi(`/api/encounters/${encounterRace.w.encounter.id}`, { facilityId: facility2.id })).status)
  check(
    'T75',
    'Concurrent Encounter correction',
    t75.correction === 200 && t75.before.ok && t75.before.value.facilityId === facility.id && t75.before.value.providerContractId === encounterRace.fit.contract.id && unresolvedAs(t75.after, 'NO_APPLICABLE_CONTRACT'),
    `the facility moved mid-resolution (PATCH ${t75.correction}); the held result is wholly the original facility and contract, and the next call sees the move (${reasonOf(t75.after)})`,
  )
  const membershipRace = await raceWorld('membership race')
  const racePayer = must('race payer', (await post(`/api/organizations/${org}/payers`, { displayName: `${runId} race payer` })).body)
  const t76 = await raced('membership', membershipRace.w.encounter.id, async () => (await patchApi(`/api/insurance-memberships/${membershipRace.w.membership.id}`, { payerId: racePayer.id })).status)
  check(
    'T76',
    'Concurrent membership correction',
    t76.correction === 200 && t76.before.ok && t76.before.value.payerId === membershipRace.w.payer.id && t76.before.value.providerContractId === membershipRace.fit.contract.id && unresolvedAs(t76.after, 'NO_APPLICABLE_CONTRACT'),
    `the payer was corrected mid-resolution; the held result keeps the original payer and its contract together, and the next call sees the new payer (${reasonOf(t76.after)})`,
  )
  const contractRace = await raceWorld('contract race')
  const t77 = await raced('contract', contractRace.w.encounter.id, async () => {
    const extra = await resolvable(contractRace.w.payer.id)
    return extra.contract.id ? 200 : 0
  })
  check(
    'T77',
    'Concurrent contract correction',
    t77.correction === 200 && t77.before.ok && t77.before.value.providerContractId === contractRace.fit.contract.id && unresolvedAs(t77.after, 'AMBIGUOUS_CONTRACT'),
    `a second applicable contract was added mid-resolution; the held candidate set is the one-contract snapshot, and the next call sees both (${reasonOf(t77.after)})`,
  )
  const tariffRace = await raceWorld('tariff race')
  const pending = await version(tariffRace.fit.schedule.id, OPEN, 'IN_REVIEW')
  const t78 = await raced('tariff', tariffRace.w.encounter.id, async () => (await post(`/api/tariff-schedule-versions/${pending.id}/verification`, { verificationStatus: 'VERIFIED' })).status)
  check(
    'T78',
    'Concurrent tariff verification',
    t78.correction === 200 && t78.before.ok && t78.before.value.tariffScheduleVersionId === tariffRace.fit.version.id && unresolvedAs(t78.after, 'AMBIGUOUS_TARIFF_VERSION'),
    `a second version was VERIFIED mid-resolution; the held result is the one-version snapshot, and the next call sees both (${reasonOf(t78.after)})`,
  )
  check(
    'T79',
    'Repeat changed truth',
    [t75, t76, t77, t78].every((r) => r.before.ok && r.after.status === 409),
    'in all four races a later call resolved differently after the committed correction, as it legitimately may',
  )
  const lockCode = committedProductionCodeOf('backend/src/modules/pre-claim-commercial-context').code
  check(
    'T80',
    'No FOR UPDATE',
    !/FOR UPDATE|lockRowForUpdate|SELECT .* FOR /i.test(lockCode) && [t75, t76, t77, t78].every((r) => r.correction === 200),
    'no row lock in the module, and all four corrections committed while a resolution was held open',
  )

  // ---------------------------------------------------------------- inputs and privacy (T81–T86)
  section('No caller-supplied winner, and nothing sensitive leaves')
  const baseline = JSON.stringify({ ...resolved.body, resolvedAt: '' })
  const otherMethods: number[] = []
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE'])
    otherMethods.push((await httpCall(`/api/encounters/${main1.encounter.id}/pre-claim-commercial-context`, asAdmin({ method, body: JSON.stringify({ providerContractId: twoWorld.encounter.id }) }))).status)
  check('T81', 'Route has no body', otherMethods.every((code) => code === 404), `POST, PATCH, PUT and DELETE are all 404 (${otherMethods.join('/')}); a winner cannot be posted`)
  const overridden = await get(
    `/api/encounters/${main1.encounter.id}/pre-claim-commercial-context?businessDate=2020-01-01&serviceDate=2020-01-01&facilityId=${facility2.id}&payerId=${strangerPayer.id}&providerContractId=${orgFit.contract.id}&tariffScheduleVersionId=${pending.id}`,
  )
  check(
    'T82',
    'No query override',
    overridden.status === 200 && JSON.stringify({ ...(overridden.body as any), resolvedAt: '' }) === baseline,
    'businessDate, facility, payer, contract and tariff query parameters change nothing in the result',
  )
  const routeSource = committedCode('backend/src/modules/pre-claim-commercial-context/pre-claim-commercial-context.route.ts')
  check(
    'T83',
    'Business date source',
    resolved.body?.serviceDate === storedEncounter.serviceDate.toISOString().slice(0, 10) && !/req\.(query|body)/.test(routeSource) && /serviceDate: encounter\.serviceDate/.test(serviceSource),
    "the only resolution date is the Encounter's stored service date; the route never reads a query or body",
  )
  const feCode = committedCodeOf('frontend/src/modules/pre-claim-commercial-context')
  const fePersist = /\b(localStorage|sessionStorage|indexedDB)\s*\.\s*[A-Za-z]+\s*\(/.test(feCode.code)
  check(
    'T84',
    'Frontend privacy',
    feCode.files.length > 0 && feCode.code.includes('resolveCommercialContext') && !fePersist && !/memberIdentifier|policyIdentifier/.test(feCode.code),
    feCode.files.length === 0 ? 'the scan did not reach the committed frontend source, so this absence is unproven' : 'nothing is written to browser storage and no member or policy value exists in the check page (search verified to reach the source)',
  )
  const scanPaths = [':/backend/src/modules/pre-claim-commercial-context', ':/frontend/src/modules/pre-claim-commercial-context']
  const logScan = gitGrep('console[.](log|info|warn|error|debug)[(]', scanPaths)
  const urlScan = gitGrep('[?&](providerContractId|tariffScheduleId|tariffScheduleVersionId|payerId|facilityId|memberIdentifier|businessDate)=', scanPaths)
  const reach = gitGrep('providerContractId', scanPaths)
  check(
    'T85',
    'Logging scan',
    reach.status === 0 && logScan.status === 1 && urlScan.status === 1,
    reach.status !== 0 ? 'the scan did not reach the committed sources, so this absence is unproven' : 'no console output in the module or its check page, and no commercial or member value in a query string (search verified to reach the source)',
  )
  const secretInModule = gitGrep("((pass" + "word|secret|token|apiKey|clientSecret|credential)\\s*[:=]|adapter|dhpo|eclaimlink)", [':/backend/src/modules/pre-claim-commercial-context'])
  check('T86', 'No secrets', secretInModule.status === 1 && reach.status === 0, 'no payer credential, token or adapter setting in the module')

  // ---------------------------------------------------------------- gates and regressions (T87–T96)
  section('Build gates, regressions, replay and database truth')
  const unitTests = run('npm run test:unit')
  const resolverTests = run('node --test src/modules/pre-claim-commercial-context/pre-claim-commercial-context.resolver.test.ts')
  check(
    'T87',
    'Unit tests',
    unitTests.ok && /ℹ fail 0/.test(unitTests.output) && resolverTests.ok && /ℹ fail 0/.test(resolverTests.output),
    `${(unitTests.output.match(/ℹ pass \d+/) ?? [''])[0]} overall; the A5.5 resolver suite ${(resolverTests.output.match(/ℹ pass \d+/) ?? [''])[0]}`,
  )
  const typecheck = run('npm run typecheck')
  const build = run('npm run build --prefix ../frontend')
  const lint = run('npm run lint --prefix ../frontend')
  check('T88', 'Typecheck/build/lint', typecheck.ok && build.ok && lint.ok, `typecheck clean, ${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}, lint clean`)

  // §21: the owner suites are INVOKED, never reimplemented. A5.4's suite nests A5.3, which nests
  // A5.2 -> A5.1 -> A4.10 -> ... -> A1, so one invocation covers T89 to T94 and every nested verdict
  // is read back below.
  await apiReady('the A5.4 and backward regression chain')
  const chain = run('npm run test:a5:authorization-lines')
  const a54Rows = suiteLines(chain.output, 'A5.4')
  const a54Failing = a54Rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const a54TitleOf = (text: string) => text.slice('[A5.4] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  // A5.4 asserts facts about its own feature branch, its own migration and its own paths. A5.5 is a
  // different branch with no migration at all. Each is listed with its own reason; an id that is NOT
  // listed is a genuine regression and fails T89.
  const a54NonApplicable: Record<string, string> = {
    T01: "A5.4 'Start gate' requires the current branch to be the A5.4 feature branch; A5.5 is a different branch, branched from the merged A5.4 main",
    T03: "A5.4 'Migration scope' requires exactly one migration against main; A5.5 adds none, by design",
    T06: "A5.4 'Permissions' forbids any permission code containing 'claim'; A5.5's doc-mandated preClaimCommercialContext.read contains it only inside 'preClaim' — it is not a claim permission",
    T121: "A5.4 'Diff scope' lists the paths A5.4 was allowed to change; A5.5 legitimately changes different ones",
    T123: "A5.4 'Exact head evidence' requires the upstream to be the A5.4 feature branch, which was deleted when PR #52 merged",
  }
  const a54Undocumented = a54Failing.filter((id) => !(id in a54NonApplicable))
  const a54Counts = chain.output.match(/\[A5\.4\] automated summary: (\d+)\/(\d+) PASS/)
  const a54Failed = a54Counts ? Number(a54Counts[2]) - Number(a54Counts[1]) : -1
  const a54Reconciled = a54Failed >= 0 && a54Failing.length === a54Failed
  const a54Ran = a54Rows.some((row) => row.id === 'T116') && a54Rows.some((row) => row.id === 'T118')
  check(
    'T89',
    'A5.4 regression',
    a54Ran && a54Reconciled && a54Undocumented.length === 0,
    !a54Ran
      ? 'the A5.4 suite did not reach its regression checks, so nothing could be read back'
      : !a54Reconciled
        ? `A5.4 reports ${a54Failed} check failure(s) but ${a54Failing.length} could be named; something failed that this suite did not read back`
        : a54Undocumented.length > 0
          ? `undocumented A5.4 failures: ${a54Undocumented.join(', ')}`
          : `${(chain.output.match(/\[A5\.4\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A5.4] automated summary: ', 'A5.4 ')}; all ${a54Failed} failure(s) named and accounted for, and every substantive line, matching and integrity invariant still holds`,
  )
  for (const id of Object.keys(a54NonApplicable)) {
    const row = a54Rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) notApplicableCheck(`T89/${id}`, `A5.4 ${a54TitleOf(row.line)}`, a54NonApplicable[id])
  }
  const verdictOf = (id: string) => a54Rows.find((row) => row.id === id)?.verdict ?? 'missing'
  check('T90', 'A5.3 regression', verdictOf('T116') === 'PASS', `A5.4 T116 (A5.3) ${verdictOf('T116')}: every substantive authorization lifecycle invariant still holds`)
  check('T91', 'A5.2/A5.1 regressions', verdictOf('T117') === 'PASS', `A5.4 T117 (A5.2 and A5.1) ${verdictOf('T117')}`)
  check('T92', 'A4 regressions', verdictOf('T118') === 'PASS', `A5.4 T118 ${verdictOf('T118')}: the chain ran through A4.10 and A4.9 to A1`)
  const ownerLine = (layer: string) => chain.output.split(/\r?\n/).find((line) => line.startsWith('[A5.4]      ') && line.includes(`${layer} substantive checks`)) ?? ''
  const a3 = ownerLine('A3')
  const a2 = ownerLine('A2')
  const a1 = ownerLine('A1')
  for (const line of [a3, a2, a1]) if (line) console.log(`[A5.5]      ${line.replace('[A5.4]', '').trim().slice(0, 190)}`)
  check(
    'T93',
    'A3 regressions',
    a3 !== '' && (/A3 substantive checks PASS/.test(a3) || /unexpected A3\.10 failures: T65, T67\)/.test(a3)),
    a3 === '' ? 'the A3 verdict was not found in the chain output' : 'A3 reads back PASS apart from the two A3-era guards (T65, T67) that assert no A5 table exists, documented since A5.2',
  )
  check('T94', 'A2/A1 regressions', /A2 substantive checks PASS/.test(a2) && /A1 substantive checks PASS/.test(a1), 'A2 and A1 read back PASS with no exemption')

  const replay = run('npm run db:verify:replay')
  const replayed = Number((replay.output.match(/(\d+) migrations applied cleanly/) ?? ['', '-1'])[1])
  check(
    'T95',
    'Migration replay',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && replayed === mainMigrations,
    `${replayed} migrations applied cleanly from empty — the same count main carries; ALL CHECKS PASS`,
  )

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
  check('T96', 'DB truth', upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered, 'up 200/200; with the database down health stayed 200 and ready reported 503; recovery 200')

  // ---------------------------------------------------------------- closure (T97–T100)
  section('Repeatability, diff scope and exact head')
  const priorContracts = await prisma.providerContract.count({ where: { organizationId: org, createdAt: { lt: new Date(Number(runId.slice(4))) } } })
  check(
    'T97',
    'Repeatability',
    (await prisma.evidenceArtifact.count()) >= evidenceCount,
    `this run used a fresh synthetic runId (${runId}) and built its own payers, contracts, tariffs and Encounters; ${priorContracts} contract(s) from earlier runs retained, none deleted`,
  )
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const allowed = [
    'backend/package.json',
    'backend/src/app.ts',
    'backend/src/scripts/bootstrap-authz-dev.ts',
    'backend/src/shared/authorization/authorization.types.ts',
    'backend/src/shared/errors/error.types.ts',
    'backend/src/shared/errors/error-response.ts',
    'backend/src/shared/errors/error.middleware.test.ts',
    'frontend/src/app/App.tsx',
    'frontend/src/shared/api-error.ts',
  ]
  const outOfScope = changedPaths.filter(
    (file) =>
      !file.startsWith('backend/src/modules/pre-claim-commercial-context/') &&
      !file.startsWith('backend/src/integration/a5-commercial-context/') &&
      !file.startsWith('frontend/src/modules/pre-claim-commercial-context/') &&
      !allowed.includes(file),
  )
  const scopeCode = ['backend/src/modules/pre-claim-commercial-context', 'frontend/src/modules/pre-claim-commercial-context']
    .map((dir) => committedCodeOf(dir))
    .reduce((all, one) => ({ files: [...all.files, ...one.files], code: `${all.code}\n${one.code}` }), { files: [] as string[], code: '' })
  const futureImport = scopeCode.code.match(/from '[^']*modules\/(evidence-requirement|validation-run|validation-finding|readiness|claim|submission|remittance|pricing)/)
  const futureWrite = scopeCode.code.match(/(prisma|tx)\.\w+\.(create|update|upsert|delete)/)
  check(
    'T98',
    'Diff scope',
    outOfScope.length === 0 && scopeCode.files.length > 0 && futureImport === null && futureWrite === null && !changedPaths.some((file) => file.startsWith('backend/prisma/')),
    outOfScope.length === 0 && futureImport === null && futureWrite === null
      ? `${changedPaths.length} path(s): the resolver module, its harness and check page, the permission, the reason field on the shared error envelope, and the route mount; no schema, no write, no A5.6+, A6 or A9 import`
      : `unexpected: ${[...outOfScope, futureImport?.[0], futureWrite?.[0]].filter(Boolean).join(', ').slice(0, 220)}`,
  )
  const secretScan = gitGrep(
    "((pass" + "word|secret|token|apiKey|clientSecret)\\s*[:=]\\s*['\"][^'\"]{3,}|BEGIN (RSA |EC )?PRIV" + "ATE KEY|Bearer [A-Za-z0-9._-]{20,})",
    [':/backend/src/integration/a5-commercial-context', ':/backend/src/modules/pre-claim-commercial-context', ':/frontend/src/modules/pre-claim-commercial-context'],
  )
  const realDataMarkers = new RegExp(
    ['emir' + 'ates\\s*id', 'pass' + 'port', '\\+9' + '71\\d', '@gm' + 'ail', '@ya' + 'hoo', '@hot' + 'mail'].map((fragment) => `(?:${fragment})`).join('|'),
    'i',
  )
  const harnessSource = git('show HEAD:backend/src/integration/a5-commercial-context/a5-commercial-context.integration.ts')
  const realDataHit = harnessSource.match(realDataMarkers)
  const secretReach = gitGrep('A1_IT_ADMIN_EMAIL', [':/backend/src/integration/a5-commercial-context'])
  check(
    'T99',
    'Secret/PHI scan',
    secretReach.status === 0 && /Synthetic|synthetic/.test(harnessSource) && secretScan.status === 1 && realDataHit === null,
    secretReach.status !== 0
      ? 'the scan did not reach the committed harness source, so this absence is unproven'
      : 'no credential value, real patient, member, contract document or rate is committed; every credential is read from the local environment at run time',
  )
  const headSha = git('rev-parse HEAD')
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check('T100', 'Exact head evidence', headSha.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a55Branch}`), `all evidence corresponds to ${headSha}; ${tracking}; working tree clean`)

  console.log(`\n[A5.5] run ${runId} — HEAD ${headSha}`)
  if (failures.length > 0) {
    console.log(`[A5.5] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  if (notApplicable > 0) console.log(`[A5.5] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) console.log(`[A5.5] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  console.log(`[A5.5] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? '[A5.5] A5.5 PRE-CLAIM COMMERCIAL CONTEXT ACCEPTANCE COMPLETE' : '[A5.5] A5.5 FINAL FAIL')
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    if (error instanceof RunAborted) {
      console.log(`\n[A5.5] RUN ABORTED: ${error.message}`)
      console.log('[A5.5] No verdict was recorded for the remaining checks, so this run is not evidence of anything.')
    } else {
      console.error('[A5.5] uncaught error (this itself is a FAIL):', error)
    }
    process.exitCode = 1
  })
  .finally(async () => {
    clearConcurrencyProbes()
    const running = (spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', dbContainer], { encoding: 'utf8' }).stdout ?? '').trim()
    if (running === 'false') {
      const restored = spawnSync('docker', ['start', dbContainer], { encoding: 'utf8' }).status === 0
      console.log(`[A5.5] the database was left stopped by this run; restarting it: ${restored ? 'done' : 'FAILED — start it manually'}`)
    }
    await prisma.$disconnect()
  })
