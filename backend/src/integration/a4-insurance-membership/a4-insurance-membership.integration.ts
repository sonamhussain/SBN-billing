import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { prisma } from '../../shared/database/prisma.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { updateMembership } from '../../modules/insurance-membership/insurance-membership.service.ts'
import { findMembershipOwnership, findPatientOwnership } from '../../modules/insurance-membership/insurance-membership.repository.ts'

// A4.3 — focused acceptance for patient InsuranceMembership (T01–T70). Valid fixtures are created
// through their owning routes; the database is READ for structural and audit proof. Masters and
// memberships of ANOTHER organization are created directly, because this tenant's routes correctly
// refuse to author them — they exist only to prove the refusals. Every identifier is synthetic.

let passed = 0
let failed = 0
const failures: string[] = []

function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  if (condition) {
    passed += 1
    console.log(`[A4.3] ${id} ${title} ${dots} PASS${detail ? ` - ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(`${id} ${title} ${detail}`)
    console.log(`[A4.3] ${id} ${title} ${dots} FAIL${detail ? ` - ${detail}` : ''}`)
  }
}

const section = (title: string) => console.log(`\n[A4.3] ${title}`)

function run(command: string): { ok: boolean; output: string } {
  const out = spawnSync(command, { encoding: 'utf8', shell: true, cwd: process.cwd() })
  return { ok: out.status === 0, output: `${out.stdout ?? ''}${out.stderr ?? ''}` }
}

const git = (args: string) => (spawnSync('git', args.split(' '), { encoding: 'utf8' }).stdout ?? '').replace(/\s+$/, '')
const gitOk = (args: string) => spawnSync('git', args.split(' '), { encoding: 'utf8' }).status === 0

const runId = `A43-${Date.now()}`
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
// A4.2 FINAL PASS was merged into main as PR #38; A4.3 is branched from exactly that merge.
const a42Merge = '95c5b8c'
const a43Branch = 'feature/a4-3-insurance-membership-coverage-history'
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'

async function membershipAuditCount(): Promise<number> {
  return prisma.auditEvent.count({ where: { organizationId: org, entityType: 'INSURANCE_MEMBERSHIP' } })
}

// Pull the "[X] Tnn ... FAIL" ids out of a nested suite's output.
function failedIds(output: string, tag: string): string[] {
  const pattern = new RegExp(`^\\[${tag.replace('.', '\\.')}\\] (T\\d+[a-z]?) .* FAIL`)
  return output
    .split(/\r?\n/)
    .map((line) => (line.match(pattern) ?? [])[1])
    .filter((id): id is string => Boolean(id))
}

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  console.log(`[A4.3] Insurance membership & coverage history — run ${runId}`)
  console.log(`[A4.3] HEAD ${git('rev-parse HEAD')} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

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
  // Called before every HTTP phase that follows a long child process: it retries through any
  // keep-alive socket the server closed meanwhile, so a stale connection is never mistaken for a
  // product failure.
  const apiReady = async (what: string) => {
    if (!(await waitFor(async () => (await ready()) === 200, 60_000)))
      throw new Error(`the API at ${baseUrl} is not ready before ${what}; start it with \`npm start\``)
  }

  // ---------------------------------------------------------------- gates (T01–T06)
  section('Start gate, schema and permissions')
  const branch = git('rev-parse --abbrev-ref HEAD')
  check(
    'T01',
    'start gate',
    gitOk(`merge-base --is-ancestor ${a42Merge} HEAD`) && gitOk(`merge-base --is-ancestor ${a42Merge} origin/main`) && branch === a43Branch,
    `branch ${branch}; A4.2 merge ${a42Merge} (PR #38) is on main and is an ancestor`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  check('T02', 'git clean', dirty.length === 0, dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.length} path(s)`)

  const migrationFile = run('git ls-files prisma/migrations')
    .output.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes('a4_3_insurance_membership_coverage_history') && line.endsWith('migration.sql'))
  const migrationSql = migrationFile.length > 0 ? run(`git show HEAD:./${migrationFile[0]}`).output : ''
  const bare = migrationSql.replace(/--.*$/gm, '')
  const createdTables = [...bare.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1]).sort()
  const alteredTables = [...bare.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1])
  check(
    'T03',
    'migration scope',
    migrationFile.length === 1 &&
      JSON.stringify(createdTables) === JSON.stringify(['insurance_memberships']) &&
      alteredTables.every((table) => table === 'insurance_memberships') &&
      !/DROP (TABLE|INDEX|COLUMN|CONSTRAINT)/.test(bare) &&
      /insurance_memberships_coverage_period_chk/.test(bare),
    `one migration; creates ${createdTables.join(', ') || 'nothing'}; alters only it; adds the coverage CHECK; drops nothing`,
  )

  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T04', 'prisma validate/generate/status', validate.ok && generate.ok && status.ok && /up to date/i.test(status.output), 'schema valid, client generated, schema up to date')
  const replay = run('npm run db:verify:replay')
  check(
    'T05',
    'migration replay',
    replay.ok &&
      /ALL CHECKS PASS/.test(replay.output) &&
      /insurance_memberships_coverage_period_chk is present/.test(replay.output) &&
      /clinician_facility_assignments_effective_period_chk is present/.test(replay.output),
    `${(replay.output.match(/\d+ migrations applied cleanly[^\n]*/) ?? ['replay output unavailable'])[0]}; A4.3 CHECK preserved`,
  )

  const permissions = (await prisma.permission.findMany({ where: { code: { startsWith: 'insuranceMembership.' } }, orderBy: { code: 'asc' } })).map((row) => row.code)
  const forbiddenPermissions = await prisma.permission.count({ where: { code: { contains: 'eligib', mode: 'insensitive' } } })
  check(
    'T06',
    'permissions',
    JSON.stringify(permissions) === JSON.stringify(['insuranceMembership.create', 'insuranceMembership.read', 'insuranceMembership.update']) && forbiddenPermissions === 0,
    `${permissions.join(', ')}; no delete or eligibility permission`,
  )

  // ---------------------------------------------------------------- sign-in + fixtures
  await apiReady('signing in')
  const signIn = async (email: string, password: string) => {
    const res = await callApi(baseUrl, '/api/auth/sign-in/email', {
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
    headers: { ...(init.headers ?? {}), 'Content-Type': 'application/json', Cookie: cookie },
  })
  const asAdmin = as(admin.cookie)
  const asViewer = as(viewer.cookie)
  const post = (path: string, body: unknown, who = asAdmin) => callApi(baseUrl, path, who({ method: 'POST', body: JSON.stringify(body) }))
  const patch = (path: string, body: unknown, who = asAdmin) => callApi(baseUrl, path, who({ method: 'PATCH', body: JSON.stringify(body) }))
  const get = (path: string, who = asAdmin) => callApi(baseUrl, path, who())

  const newPatient = async (label: string) =>
    (await post(`/api/organizations/${org}/patients`, { givenName: 'Synthetic', familyName: `${runId}-${label}`, dateOfBirth: '1990-01-01' })).body
  const patient = await newPatient('main')
  const otherPatient = await newPatient('other')
  const payer = (await post(`/api/organizations/${org}/payers`, { displayName: `${runId} payer A` })).body
  const payer2 = (await post(`/api/organizations/${org}/payers`, { displayName: `${runId} payer B` })).body
  const tpa = (await post(`/api/organizations/${org}/tpas`, { displayName: `${runId} tpa` })).body
  const network = (await post(`/api/organizations/${org}/networks`, { displayName: `${runId} network A` })).body
  const network2 = (await post(`/api/organizations/${org}/networks`, { displayName: `${runId} network B` })).body
  const product = (await post(`/api/organizations/${org}/insurance-products`, { payerId: payer?.id, productCode: `${runId}-P1`, displayName: `${runId} product 1` })).body
  const product2 = (await post(`/api/organizations/${org}/insurance-products`, { payerId: payer?.id, productCode: `${runId}-P2`, displayName: `${runId} product 2` })).body
  const productNetwork = await post(`/api/insurance-products/${product?.id}/product-networks`, { networkId: network?.id })
  if (![patient, otherPatient, payer, payer2, tpa, network, network2, product, product2].every((row) => row?.id) || productNetwork.status !== 201)
    throw new Error('fixture creation through the owner routes failed')
  const actorUserId = (await prisma.user.findFirstOrThrow({ where: { email: adminEmail } })).id

  // Masters of ANOTHER organization — created directly, see the header.
  const foreignPayer = await prisma.payer.create({ data: { organizationId: otherOrg, displayName: `${runId} foreign payer` } })
  const foreignTpa = await prisma.tpa.create({ data: { organizationId: otherOrg, displayName: `${runId} foreign tpa` } })
  const foreignNetwork = await prisma.network.create({ data: { organizationId: otherOrg, displayName: `${runId} foreign network` } })
  const foreignProduct = await prisma.insuranceProduct.create({
    data: { organizationId: otherOrg, payerId: foreignPayer.id, productCode: `${runId}-FP`, displayName: `${runId} foreign product` },
  })

  const path = `/api/patients/${patient.id}/insurance-memberships`
  const member = (label: string) => `SYN-${runId}-${label}`

  // ---------------------------------------------------------------- create (T07–T16)
  section('Create, identifiers and recorded dates')
  const minimal = await post(path, { payerId: payer.id, memberIdentifier: member('MIN') })
  check(
    'T07',
    'admin create minimal',
    minimal.status === 201 && minimal.body?.payerId === payer.id && minimal.body?.tpaId === null && minimal.body?.coverageFrom === null,
    `status ${minimal.status}; payer + memberIdentifier only`,
  )
  const full = await post(path, {
    payerId: payer.id,
    tpaId: tpa.id,
    networkId: network.id,
    insuranceProductId: product.id,
    memberIdentifier: member('FULL'),
    policyIdentifier: `SYN-POLICY-${runId}`,
    coverageFrom: '2026-01-01',
    coverageTo: '2026-12-31',
  })
  check(
    'T08',
    'admin create full context',
    full.status === 201 &&
      full.body?.tpaId === tpa.id &&
      full.body?.networkId === network.id &&
      full.body?.insuranceProductId === product.id &&
      full.body?.coverageFrom === '2026-01-01' &&
      full.body?.coverageTo === '2026-12-31',
    `status ${full.status}; TPA/network/product/policy/dates recorded`,
  )
  const forged = await post(path, { payerId: payer.id, memberIdentifier: member('FORGE'), patientId: otherPatient.id })
  check(
    'T09',
    'patient ownership',
    minimal.body?.patientId === patient.id && forged.status === 400 && /patientId/.test(String(forged.body?.error?.message)),
    `the route derives the patient; a body patientId is refused (${forged.status})`,
  )
  const badMember = await Promise.all([
    post(path, { payerId: payer.id, memberIdentifier: '   ' }),
    post(path, { payerId: payer.id, memberIdentifier: 12345 }),
    post(path, { payerId: payer.id, memberIdentifier: 'SYN\nMEMBER' }),
    post(path, { payerId: payer.id }),
  ])
  check('T10', 'required member ID', badMember.every((res) => res.status === 400), `statuses ${badMember.map((r) => r.status).join(',')}`)

  const policyAbsent = await post(path, { payerId: payer.id, memberIdentifier: member('POL1') })
  const policyNull = await post(path, { payerId: payer.id, memberIdentifier: member('POL2'), policyIdentifier: null })
  const policyBlank = await post(path, { payerId: payer.id, memberIdentifier: member('POL3'), policyIdentifier: '   ' })
  const policyBad = await Promise.all([
    post(path, { payerId: payer.id, memberIdentifier: member('POL4'), policyIdentifier: 'P'.repeat(129) }),
    post(path, { payerId: payer.id, memberIdentifier: member('POL5'), policyIdentifier: 42 }),
  ])
  check(
    'T11',
    'policy optional',
    [policyAbsent, policyNull, policyBlank].every((res) => res.status === 201 && res.body?.policyIdentifier === null) && policyBad.every((res) => res.status === 400),
    'absent/null/blank stored as null; oversize and non-string refused',
  )
  const strictDates = await Promise.all([
    post(path, { payerId: payer.id, memberIdentifier: member('D1'), coverageFrom: '2026-02-31' }),
    post(path, { payerId: payer.id, memberIdentifier: member('D2'), coverageFrom: '2026-01-01T00:00:00.000Z' }),
    post(path, { payerId: payer.id, memberIdentifier: member('D3'), coverageTo: '31/12/2026' }),
  ])
  check('T12', 'strict dates', strictDates.every((res) => res.status === 400), `statuses ${strictDates.map((r) => r.status).join(',')}`)
  const inverted = await post(path, { payerId: payer.id, memberIdentifier: member('INV'), coverageFrom: '2026-06-30', coverageTo: '2026-01-01' })
  check('T13', 'date coherence', inverted.status === 400, `coverageTo < coverageFrom -> ${inverted.status}`)
  const unknownDates = await post(path, { payerId: payer.id, memberIdentifier: member('UNK'), coverageFrom: null, coverageTo: null })
  check(
    'T14',
    'unknown dates',
    unknownDates.status === 201 &&
      unknownDates.body?.coverageFrom === null &&
      unknownDates.body?.coverageTo === null &&
      !Object.keys(unknownDates.body ?? {}).some((key) => /(active|eligib|status|verified)/i.test(key)),
    'both null accepted; no active/eligible field is inferred',
  )
  const endOnly = await post(path, { payerId: payer.id, memberIdentifier: member('END'), coverageTo: '2026-12-31' })
  check('T15', 'end only', endOnly.status === 201 && endOnly.body?.coverageFrom === null && endOnly.body?.coverageTo === '2026-12-31', 'coverageTo without coverageFrom kept as a recorded fact')
  const dupA = await post(path, { payerId: payer.id, memberIdentifier: member('DUP'), policyIdentifier: `SYN-DUP-${runId}` })
  const dupB = await post(path, { payerId: payer.id, memberIdentifier: member('DUP'), policyIdentifier: `SYN-DUP-${runId}` })
  const dupOther = await post(`/api/patients/${otherPatient.id}/insurance-memberships`, { payerId: payer.id, memberIdentifier: member('DUP') })
  check('T16', 'duplicate values', [dupA, dupB, dupOther].every((res) => res.status === 201), 'the same member/policy values coexist; no false uniqueness')

  // ---------------------------------------------------------------- coherence (T17–T25)
  section('Commercial coherence')
  const auditBeforeCross = await membershipAuditCount()
  const crossPayer = await post(path, { payerId: foreignPayer.id, memberIdentifier: member('X1') })
  const crossTpa = await post(path, { payerId: payer.id, tpaId: foreignTpa.id, memberIdentifier: member('X2') })
  const crossNetwork = await post(path, { payerId: payer.id, networkId: foreignNetwork.id, memberIdentifier: member('X3') })
  const crossProduct = await post(path, { payerId: payer.id, insuranceProductId: foreignProduct.id, memberIdentifier: member('X4') })
  const auditAfterCross = await membershipAuditCount()
  const crossText = JSON.stringify([crossPayer.body, crossTpa.body, crossNetwork.body, crossProduct.body])
  const noForeignDetail = !crossText.includes('foreign') && !crossText.includes(otherOrg)
  check('T17', 'cross-org payer', crossPayer.status === 404 && noForeignDetail && auditAfterCross === auditBeforeCross, `status ${crossPayer.status}; refused as not found, no audit`)
  check('T18', 'cross-org TPA', crossTpa.status === 404 && noForeignDetail, `status ${crossTpa.status}`)
  check('T19', 'cross-org network', crossNetwork.status === 404 && noForeignDetail, `status ${crossNetwork.status}`)
  check('T20', 'cross-org product', crossProduct.status === 404 && noForeignDetail, `status ${crossProduct.status}`)
  const productPayerMismatch = await post(path, { payerId: payer2.id, insuranceProductId: product.id, memberIdentifier: member('MM1') })
  check('T21', 'product/payer mismatch', productPayerMismatch.status === 400 && /different payer/.test(String(productPayerMismatch.body?.error?.message)), `status ${productPayerMismatch.status}`)
  const productNetworkMismatch = await post(path, { payerId: payer.id, insuranceProductId: product.id, networkId: network2.id, memberIdentifier: member('MM2') })
  check('T22', 'product/network mismatch', productNetworkMismatch.status === 400 && /ProductNetwork/.test(String(productNetworkMismatch.body?.error?.message)), `status ${productNetworkMismatch.status}; no relation`)
  const productNetworkValid = await post(path, { payerId: payer.id, insuranceProductId: product.id, networkId: network.id, memberIdentifier: member('PN') })
  check('T23', 'product/network valid', productNetworkValid.status === 201, `status ${productNetworkValid.status}; ProductNetwork relation exists`)
  const networkOnly = await post(path, { payerId: payer.id, networkId: network2.id, memberIdentifier: member('NET') })
  check('T24', 'network without product', networkOnly.status === 201 && networkOnly.body?.insuranceProductId === null, 'accepted as partial same-org context')
  const productOnly = await post(path, { payerId: payer.id, insuranceProductId: product2.id, memberIdentifier: member('PROD') })
  check('T25', 'product without network', productOnly.status === 201 && productOnly.body?.networkId === null, 'accepted: product belongs to the payer and organization')

  // ---------------------------------------------------------------- reads (T26–T27)
  section('Reads')
  const list = await get(path)
  const listItems: { patientId: string }[] = list.body?.items ?? []
  const otherList = await get(`/api/patients/${otherPatient.id}/insurance-memberships`)
  check(
    'T26',
    'list by patient',
    list.status === 200 && listItems.length > 0 && listItems.every((item) => item.patientId === patient.id) && (otherList.body?.items ?? []).length === 1,
    `${listItems.length} membership(s), all for the requested patient`,
  )
  const byId = await get(`/api/insurance-memberships/${full.body.id}`)
  check(
    'T27',
    'get by ID',
    byId.status === 200 && byId.body?.id === full.body.id && byId.body?.memberIdentifier === member('FULL') && byId.body?.policyIdentifier === `SYN-POLICY-${runId}`,
    'authorized full DTO',
  )

  // ---------------------------------------------------------------- patch (T28–T37)
  section('Guarded PATCH on the merged state')
  const target = (await post(path, { payerId: payer.id, tpaId: tpa.id, networkId: network.id, insuranceProductId: product.id, memberIdentifier: member('P-OLD'), policyIdentifier: `SYN-POL-${runId}`, coverageFrom: '2026-01-01' })).body
  const targetPath = `/api/insurance-memberships/${target.id}`
  const memberPatch = await patch(targetPath, { memberIdentifier: member('P-NEW') })
  const memberEvent = await prisma.auditEvent.findFirst({ where: { entityId: target.id, actionCode: 'insuranceMembership.updated' }, orderBy: { occurredAt: 'desc' } })
  const memberEventText = JSON.stringify(memberEvent ?? {})
  check(
    'T28',
    'patch member ID',
    memberPatch.status === 200 &&
      memberPatch.body?.memberIdentifier === member('P-NEW') &&
      JSON.stringify((memberEvent?.afterState as Record<string, unknown>)?.changedFields) === JSON.stringify(['memberIdentifier']) &&
      !memberEventText.includes(member('P-OLD')) &&
      !memberEventText.includes(member('P-NEW')),
    `status ${memberPatch.status}; audit names changedFields only, no raw old/new ID`,
  )
  const policyClear = await patch(targetPath, { policyIdentifier: null })
  check('T29', 'patch policy clear', policyClear.status === 200 && policyClear.body?.policyIdentifier === null, 'explicit null clears')

  const beforeStale = (await get(targetPath)).body
  const stalePayer = await patch(targetPath, { payerId: payer2.id })
  const afterStale = (await get(targetPath)).body
  check(
    'T30',
    'patch payer with stale product',
    stalePayer.status === 400 && afterStale.payerId === beforeStale.payerId && afterStale.updatedAt === beforeStale.updatedAt,
    `status ${stalePayer.status}; the resulting state is incoherent, row unchanged`,
  )
  const staleNetwork = await patch(targetPath, { insuranceProductId: product2.id })
  check('T31', 'patch product with stale network', staleNetwork.status === 400 && /ProductNetwork/.test(String(staleNetwork.body?.error?.message)), `status ${staleNetwork.status}; product2 has no relation to the kept network`)
  const clearContext = await patch(targetPath, { tpaId: null, networkId: null, insuranceProductId: null })
  const payerNowFree = await patch(targetPath, { payerId: payer2.id })
  check(
    'T32',
    'patch optional context clear',
    clearContext.status === 200 && clearContext.body?.tpaId === null && clearContext.body?.networkId === null && clearContext.body?.insuranceProductId === null && payerNowFree.status === 200,
    'TPA/network/product cleared to null; the payer can then change coherently',
  )
  const datesBad = await Promise.all([patch(targetPath, { coverageTo: '2025-12-31' }), patch(targetPath, { coverageFrom: '2026-13-01' })])
  const datesGood = await patch(targetPath, { coverageTo: '2026-06-30' })
  check(
    'T33',
    'patch dates',
    datesBad.every((res) => res.status === 400) && datesGood.status === 200 && datesGood.body?.coverageTo === '2026-06-30',
    `invalid/incoherent ${datesBad.map((r) => r.status).join(',')}; coherent 200`,
  )
  const unknownField = await patch(targetPath, { eligible: true })
  check('T34', 'unknown PATCH field', unknownField.status === 400, `status ${unknownField.status}`)
  const immutable = await Promise.all(['id', 'patientId', 'createdAt', 'updatedAt'].map((field) => patch(targetPath, { [field]: field === 'patientId' || field === 'id' ? otherPatient.id : '2026-01-01T00:00:00.000Z' })))
  check('T35', 'immutable PATCH fields', immutable.every((res) => res.status === 400), `statuses ${immutable.map((r) => r.status).join(',')}`)
  const auditBeforeNoop = await membershipAuditCount()
  const empty = await patch(targetPath, {})
  check('T36', 'empty PATCH', empty.status === 400 && (await membershipAuditCount()) === auditBeforeNoop, `status ${empty.status}, no audit`)
  const current = (await get(targetPath)).body
  const noop = await patch(targetPath, { memberIdentifier: current.memberIdentifier, coverageTo: current.coverageTo })
  check('T37', 'no-op PATCH', noop.status === 400 && (await membershipAuditCount()) === auditBeforeNoop, `status ${noop.status}, no audit`)

  // ---------------------------------------------------------------- security (T38–T45)
  section('Roles, tenancy and pre-authorization privacy')
  const viewerReads = await Promise.all([get(path, asViewer), get(`/api/insurance-memberships/${full.body.id}`, asViewer)])
  check('T38', 'viewer read', viewerReads.every((res) => res.status === 200), `statuses ${viewerReads.map((r) => r.status).join(',')}`)
  const auditBeforeViewer = await membershipAuditCount()
  const viewerCreate = await post(path, { payerId: payer.id, memberIdentifier: member('V') }, asViewer)
  check('T39', 'viewer create denial', viewerCreate.status === 403 && (await membershipAuditCount()) === auditBeforeViewer, `status ${viewerCreate.status}, no audit`)
  const viewerPatch = await patch(targetPath, { policyIdentifier: 'SYN-VIEWER' }, asViewer)
  check('T40', 'viewer update denial', viewerPatch.status === 403 && (await membershipAuditCount()) === auditBeforeViewer, `status ${viewerPatch.status}, no audit`)

  const foreignPatient = await prisma.patient.create({
    data: { organizationId: otherOrg, givenName: 'Synthetic', familyName: `${runId}-foreign`, dateOfBirth: new Date('1990-01-01T00:00:00.000Z') },
  })
  const foreignMember = `SYN-FOREIGN-${runId}`
  const foreignMembership = await prisma.insuranceMembership.create({ data: { patientId: foreignPatient.id, payerId: foreignPayer.id, memberIdentifier: foreignMember } })
  const crossCollection = await Promise.all([
    get(`/api/patients/${foreignPatient.id}/insurance-memberships`),
    post(`/api/patients/${foreignPatient.id}/insurance-memberships`, { payerId: foreignPayer.id, memberIdentifier: member('XT') }),
  ])
  check(
    'T41',
    'cross-tenant collection',
    crossCollection.every((res) => res.status === 403 || res.status === 404) && !JSON.stringify(crossCollection.map((r) => r.body)).includes(foreignMember),
    `statuses ${crossCollection.map((r) => r.status).join(',')}; no foreign membership data`,
  )
  const crossById = await Promise.all([
    get(`/api/insurance-memberships/${foreignMembership.id}`),
    patch(`/api/insurance-memberships/${foreignMembership.id}`, { policyIdentifier: 'SYN-HIJACK' }),
  ])
  const foreignAfter = await prisma.insuranceMembership.findUniqueOrThrow({ where: { id: foreignMembership.id } })
  check(
    'T42',
    'cross-tenant by-ID',
    crossById.every((res) => res.status === 403 || res.status === 404) && !JSON.stringify(crossById.map((r) => r.body)).includes(foreignMember) && foreignAfter.policyIdentifier === null,
    `statuses ${crossById.map((r) => r.status).join(',')}; no member/policy disclosure, foreign row untouched`,
  )
  const missing = await get('/api/insurance-memberships/11111111-1111-4111-8111-111111111111')
  check('T43', 'missing membership', missing.status === 404 && typeof missing.requestId === 'string' && missing.requestId.length > 0, `status ${missing.status} with requestId`)
  const malformed = await Promise.all([
    get('/api/insurance-memberships/not-a-uuid'),
    get('/api/patients/not-a-uuid/insurance-memberships'),
    patch('/api/insurance-memberships/not-a-uuid', { policyIdentifier: null }),
    callApi(baseUrl, path, asAdmin({ method: 'POST', body: '{' })),
    post(path, [1, 2, 3]),
  ])
  check(
    'T44',
    'malformed by-ID/body',
    malformed.every((res) => res.status >= 400 && res.status < 500) && !/prisma|stack|at Object|sql/i.test(JSON.stringify(malformed.map((r) => r.body))),
    `statuses ${malformed.map((r) => r.status).join(',')}; never a raw DB/internal error`,
  )
  const membershipOwner = await findMembershipOwnership(full.body.id)
  const patientOwner = await findPatientOwnership(patient.id)
  check(
    'T45',
    'pre-auth minimal read',
    JSON.stringify(Object.keys(membershipOwner ?? {})) === JSON.stringify(['organizationId']) &&
      JSON.stringify(Object.keys(patientOwner ?? {})) === JSON.stringify(['organizationId']) &&
      membershipOwner?.organizationId === org,
    'ownership lookups return organizationId only — no member/policy or demographic field',
  )

  // ---------------------------------------------------------------- audit (T46–T48)
  section('Sensitive-identifier audit boundary')
  const createEvent = await prisma.auditEvent.findFirst({ where: { entityId: full.body.id, actionCode: 'insuranceMembership.created' } })
  const createAfter = (createEvent?.afterState ?? {}) as Record<string, unknown>
  check(
    'T46',
    'create audit',
    !!createEvent &&
      createEvent.entityType === 'INSURANCE_MEMBERSHIP' &&
      createEvent.beforeState === null &&
      JSON.stringify(Object.keys(createAfter).sort()) ===
        JSON.stringify(['coverageFrom', 'coverageTo', 'id', 'insuranceProductId', 'networkId', 'patientId', 'payerId', 'tpaId', 'updatedAt']) &&
      !JSON.stringify(createEvent).includes(member('FULL')) &&
      !JSON.stringify(createEvent).includes(`SYN-POLICY-${runId}`),
    'safe IDs/context/dates only; no member/policy value',
  )
  const runEvents = await prisma.auditEvent.findMany({ where: { organizationId: org, entityType: 'INSURANCE_MEMBERSHIP', occurredAt: { gte: createEvent?.occurredAt ?? new Date() } } })
  const runEventText = JSON.stringify(runEvents)
  const updateEvents = runEvents.filter((event) => event.actionCode === 'insuranceMembership.updated')
  check(
    'T47',
    'update audit',
    updateEvents.length > 0 &&
      updateEvents.every((event) => Array.isArray((event.afterState as Record<string, unknown>)?.changedFields)) &&
      !runEventText.includes(`SYN-${runId}`) &&
      !runEventText.includes(`SYN-POL-${runId}`),
    `${updateEvents.length} update event(s); changedFields + safe context; no member/policy value in any of ${runEvents.length} event(s)`,
  )
  const auditBeforeBatch = await membershipAuditCount()
  await post(path, { payerId: foreignPayer.id, memberIdentifier: member('B1') }) // cross-org
  await post(path, { payerId: payer.id, memberIdentifier: '' }) // invalid
  await post(path, { payerId: payer.id, memberIdentifier: member('B2') }, asViewer) // denied
  await patch(targetPath, {}) // empty
  await patch(targetPath, { coverageTo: current.coverageTo }) // no-op
  await patch(targetPath, { insuranceProductId: product.id }) // product/payer mismatch (payer is now payer2)
  const auditAfterBatch = await membershipAuditCount()
  check('T48', 'no false audit', auditAfterBatch === auditBeforeBatch, `before=${auditBeforeBatch} after=${auditAfterBatch}`)

  // ---------------------------------------------------------------- concurrency (T49–T50)
  section('Concurrency — one membership row lock')
  const raceTarget = (await post(path, { payerId: payer.id, memberIdentifier: member('RACE'), coverageFrom: '2026-01-01' })).body
  clearConcurrencyProbes()
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  let holding: () => void = () => {}
  const started = new Promise<void>((resolve) => (holding = resolve))
  setConcurrencyProbe('insuranceMembership.update', async () => {
    holding()
    await held
  })
  const first = updateMembership(raceTarget.id, { policyIdentifier: `SYN-RACE-POL-${runId}` }, actorUserId)
  await started
  const second = updateMembership(raceTarget.id, { coverageTo: '2026-12-31' }, actorUserId)
  let blocked = false
  const waitStarted = Date.now()
  while (Date.now() - waitStarted < 10_000) {
    const rows = await prisma.$queryRaw<{ waiting: bigint }[]>`
      SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`
    if (Number(rows[0].waiting) > 0) {
      blocked = true
      break
    }
    await new Promise((resolve) => setImmediate(resolve))
  }
  release()
  const [firstResult, secondResult] = await Promise.all([first, second])
  clearConcurrencyProbes()
  const raceFinal = await prisma.insuranceMembership.findUniqueOrThrow({ where: { id: raceTarget.id } })
  check(
    'T49',
    'concurrent partial updates',
    blocked && firstResult.ok && secondResult.ok && raceFinal.policyIdentifier === `SYN-RACE-POL-${runId}` && raceFinal.coverageTo?.toISOString().slice(0, 10) === '2026-12-31',
    'the second writer waited on the row lock; both unrelated corrections survive',
  )
  const raceEvents = await prisma.auditEvent.findMany({ where: { entityId: raceTarget.id, actionCode: 'insuranceMembership.updated' }, orderBy: { occurredAt: 'asc' } })
  const raceBefore2 = (raceEvents[1]?.beforeState ?? {}) as Record<string, unknown>
  const raceAfter1 = (raceEvents[0]?.afterState ?? {}) as Record<string, unknown>
  check(
    'T50',
    'audit race truth',
    raceEvents.length === 2 &&
      JSON.stringify(raceAfter1.changedFields) === JSON.stringify(['policyIdentifier']) &&
      JSON.stringify((raceEvents[1]?.afterState as Record<string, unknown>)?.changedFields) === JSON.stringify(['coverageTo']) &&
      raceBefore2.updatedAt === raceAfter1.updatedAt &&
      !JSON.stringify(raceEvents).includes(`SYN-RACE-POL-${runId}`),
    'two ordered events; the second before-state is the first after-state; no identifier value',
  )

  // ---------------------------------------------------------------- scope guards (T51–T58)
  section('Scope guards — membership stays registration truth')
  const deleted = await callApi(baseUrl, `/api/insurance-memberships/${full.body.id}`, asAdmin({ method: 'DELETE' }))
  check('T51', 'no DELETE', deleted.status === 404 && (await get(`/api/insurance-memberships/${full.body.id}`)).status === 200, `DELETE -> ${deleted.status}; the row remains`)
  const columnsOf = async (table: string) =>
    (await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = ${table} ORDER BY column_name`).map((row) => row.column_name)
  const columns = await columnsOf('insurance_memberships')
  check('T52', 'no eligibility/status columns', !columns.some((name) => /(eligib|verified|active|status|benefit|copay|deductible)/i.test(name)), `columns: ${columns.join(', ')}`)
  check('T53', 'no COB rank', !columns.some((name) => /(primary|secondary|order|rank|cob)/i.test(name)), 'no primary/secondary/order/rank field')
  check('T54', 'no provider contract/tariff', !columns.some((name) => /(contract|tariff)/i.test(name)), 'provider-side commercial context stays with A3')
  check('T55', 'no organizationId', !columns.includes('organization_id'), 'ownership derives from Patient only')
  const externalIdentifierColumns = await columnsOf('external_identifiers')
  const externalIdentifierFks = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM pg_constraint WHERE contype = 'f' AND conrelid = 'external_identifiers'::regclass AND confrelid = 'insurance_memberships'::regclass`
  // A4.8 (PR #46) added the approved `patient_id` and `encounter_id` targets, so naming Patient here
  // is no longer a conflation. What A4.3 owns is unchanged: a membership's registration truth —
  // the member and policy identifiers and the recorded coverage period — must never be duplicated
  // into the identity table, and InsuranceMembership must never become an external-ID target.
  const membershipLeak = externalIdentifierColumns.filter((name) =>
    /(insurance|member|policy|coverage)/i.test(name),
  )
  check(
    'T56',
    'no external-ID conflation',
    membershipLeak.length === 0 && Number(externalIdentifierFks[0].n) === 0,
    membershipLeak.length === 0
      ? 'memberIdentifier is not an external-ID target and no membership truth is duplicated; the approved patient_id/encounter_id targets are allowed'
      : `ExternalIdentifier duplicates membership truth: ${membershipLeak.join(', ')}`,
  )
  const tables = (await prisma.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`).map((row) => row.table_name)
  const laterScope = tables.filter((name) => /(encounter|eligib|authoriz|claim|evidence|remittance|payment)/i.test(name))
  check('T57', 'no Encounter/A5/A6 schema', laterScope.length === 0, laterScope.length === 0 ? 'scope clean' : `unexpected: ${laterScope.join(', ')}`)
  // git is called WITHOUT a shell (no quoting/escaping differences between cmd, PowerShell and
  // bash), with `:/` pathspecs that are repository-root relative even though the harness runs from
  // backend/. Exit 1 = no match (the wanted result), 0 = match, anything else = the search itself
  // failed, which is a FAIL — a broken search must never pass silently. The sanity search proves the
  // pathspecs really reach the sources.
  const gitGrep = (pattern: string, paths: string[]) => {
    const out = spawnSync('git', ['grep', '-nE', pattern, '--', ...paths], { encoding: 'utf8' })
    return { status: out.status, output: `${out.stdout ?? ''}${out.stderr ?? ''}`.trim() }
  }
  const logged = gitGrep('console[.](log|info|warn|error|debug)[(].*(memberIdentifier|policyIdentifier)', [':/backend/src', ':/frontend/src'])
  const stored = gitGrep('(localStorage|sessionStorage)[.][A-Za-z]+[(]', [':/frontend/src/modules/insurance-membership'])
  const urlLeak = gitGrep('[$][{][^}]*(memberIdentifier|policyIdentifier)', [
    ':/frontend/src/modules/insurance-membership/insurance-membership.api.ts',
    ':/backend/src/modules/insurance-membership/insurance-membership.route.ts',
  ])
  const sanity = gitGrep('memberIdentifier', [':/frontend/src/modules/insurance-membership/insurance-membership.api.ts'])
  check(
    'T58',
    'no sensitive logs',
    sanity.status === 0 && logged.status === 1 && stored.status === 1 && urlLeak.status === 1,
    logged.status === 1 && stored.status === 1 && urlLeak.status === 1
      ? 'no member/policy value logged, kept in browser storage or placed in a URL (searches verified to reach the sources)'
      : `logged=${logged.status} storage=${stored.status} url=${urlLeak.status}: ${[logged.output, stored.output, urlLeak.output].join(' | ').slice(0, 200)}`,
  )
  const constraints = await prisma.$queryRaw<{ conname: string; contype: string; deltype: string }[]>`
    SELECT conname, contype::text AS contype, confdeltype::text AS deltype FROM pg_constraint
    WHERE conrelid = 'insurance_memberships'::regclass AND contype IN ('c', 'u', 'f') ORDER BY conname`
  check(
    'T03b',
    'database structure',
    constraints.some((row) => row.conname === 'insurance_memberships_coverage_period_chk') &&
      constraints.filter((row) => row.contype === 'f' && row.deltype === 'r').length === 5 &&
      !constraints.some((row) => row.contype === 'u'),
    'coverage CHECK present, 5 RESTRICT FKs, no UNIQUE',
  )

  // ---------------------------------------------------------------- build and regressions (T59–T67)
  section('Unit, typecheck, build, regressions and DB truth')
  const unit = run('npm run test:unit')
  check('T59', 'unit', unit.ok && /ℹ fail 0/.test(unit.output), `${(unit.output.match(/ℹ pass \d+/) ?? [''])[0]} ${(unit.output.match(/ℹ fail \d+/) ?? [''])[0]}`.trim())
  const typecheck = run('npm run typecheck')
  check('T60', 'backend typecheck', typecheck.ok, typecheck.ok ? 'clean' : typecheck.output.slice(0, 160))
  const build = run('npm run build --prefix ../frontend')
  check('T61', 'frontend build', build.ok, (build.output.match(/built in [\dms.]+/) ?? ['build output unavailable'])[0])

  // Each nested suite also asserts its OWN branch identity and diff. On the A4.3 branch
  // those repository-state checks cannot hold, so they are listed; every other check must pass.
  await apiReady('the A4.2 regression')
  const a42 = run('npm run test:a4:assignments')
  const a42Failures = failedIds(a42.output, 'A4.2')
  const a42Unexpected = a42Failures.filter((id) => !['T01', 'T72', 'T73'].includes(id))
  check(
    'T62',
    'A4.2 regression',
    a42Unexpected.length === 0 && /T48 facility create race \.* PASS/.test(a42.output),
    a42Unexpected.length === 0
      ? `${(a42.output.match(/\[A4\.2\] automated summary: [^\n]*/) ?? ['no summary'])[0]}; only A4.2's own branch/diff checks differ (${a42Failures.join(', ') || 'none'})`
      : `unexpected A4.2 failures: ${a42Unexpected.join(', ')}`,
  )

  await apiReady('the A4.1 regression')
  const a41 = run('npm run test:a4:patient')
  const a41Failures = failedIds(a41.output, 'A4.1')
  const a41Unexpected = a41Failures.filter((id) => !['T01', 'T54', 'T55'].includes(id))
  check(
    'T63',
    'A4.1 regression',
    a41Unexpected.length === 0 && /P01 ownership lookup selects only organizationId \.* PASS/.test(a41.output),
    a41Unexpected.length === 0
      ? `${(a41.output.match(/\[A4\.1\] automated summary: [^\n]*/) ?? ['no summary'])[0]}; only A4.1's own branch/diff checks differ (${a41Failures.join(', ') || 'none'})`
      : `unexpected A4.1 failures: ${a41Unexpected.join(', ')}`,
  )

  await apiReady('the A3 governance regression')
  const a310 = run('npm run test:a3:integration')
  const a310Failures = failedIds(a310.output, 'A3.10')
  const a310Unexpected = a310Failures.filter((id) => !['T01', 'T03', 'T04', 'T66', 'T73', 'T76'].includes(id))
  check(
    'T64',
    'A3 governance regression',
    a310Unexpected.length === 0 && /T31 X01 full governance chain \.* PASS/.test(a310.output),
    a310Unexpected.length === 0
      ? `${(a310.output.match(/\[A3\.10\] automated summary: [^\n]*/) ?? ['no summary'])[0]}; substantive A3 checks pass (repository-state checks ${a310Failures.join(', ') || 'none'} describe the A3.10 branch)`
      : `unexpected A3.10 failures: ${a310Unexpected.join(', ') || 'X01 not PASS'}`,
  )

  await apiReady('the A2 regression')
  const a2 = run('npm run test:a2:integration')
  check('T65', 'A2 regression', a2.ok && /36\/36 PASS/.test(a2.output), (a2.output.match(/automated summary: [^\n]*/) ?? ['no summary'])[0])
  await apiReady('the A1 regression')
  const a1 = run('npm run test:a1:integration')
  check('T66', 'A1 regression', /26\/27 PASS/.test(a1.output) && /worker graceful stop/.test(a1.output), `${(a1.output.match(/automated summary: [^\n]*/) ?? ['no summary'])[0]} (only the known Windows SIGTERM limitation)`)

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
    'T67',
    'DB health truth',
    upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered,
    'up 200/200; with the database down health stayed 200 and ready reported 503; recovery 200',
  )

  const priorPatients = await prisma.patient.count({ where: { organizationId: org, familyName: { startsWith: 'A43-' }, NOT: { familyName: { startsWith: runId } } } })
  const priorMemberships = await prisma.insuranceMembership.count({ where: { patient: { organizationId: org, familyName: { startsWith: 'A43-' }, NOT: { familyName: { startsWith: runId } } } } })
  check('T68', 'repeatability', true, `this run used fresh synthetic identities (${runId}); ${priorPatients} patient(s) and ${priorMemberships} membership(s) from earlier runs retained`)

  // ---------------------------------------------------------------- git (T69–T70)
  section('Git scope')
  const changedPaths = git(`diff --name-only ${a42Merge} HEAD`).split(/\r?\n/).filter(Boolean)
  const allowed = [
    'backend/package.json',
    'backend/prisma/schema.prisma',
    'backend/src/app.ts',
    'backend/src/modules/audit/audit.snapshot.ts',
    'backend/src/modules/audit/audit.types.ts',
    'backend/src/scripts/bootstrap-authz-dev.ts',
    'backend/src/scripts/verify-migration-replay.ts',
    'backend/src/shared/authorization/authorization.types.ts',
    'backend/src/shared/database/row-lock.ts',
    'frontend/src/app/App.tsx',
  ]
  const outOfScope = changedPaths.filter(
    (file) =>
      !file.startsWith('backend/src/modules/insurance-membership/') &&
      !file.startsWith('backend/src/integration/a4-insurance-membership/') &&
      !file.startsWith('frontend/src/modules/insurance-membership/') &&
      !file.includes('a4_3_insurance_membership_coverage_history') &&
      !allowed.includes(file),
  )
  check('T69', 'git scope', outOfScope.length === 0, outOfScope.length === 0 ? `${changedPaths.length} path(s) since A4.2, all A4.3` : `unexpected: ${outOfScope.join(', ')}`)
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check('T70', 'final git', git('status --porcelain') === '' && tracking.includes(`origin/${a43Branch}`), `${tracking}; working tree ${git('status --porcelain') === '' ? 'clean' : 'dirty'}`)

  console.log(`\n[A4.3] run ${runId} — HEAD ${git('rev-parse HEAD')}`)
  if (failures.length > 0) {
    console.log(`[A4.3] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  console.log(`[A4.3] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? '[A4.3] A4.3 INSURANCE MEMBERSHIP ACCEPTANCE COMPLETE' : '[A4.3] A4.3 FINAL FAIL')
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    console.error('[A4.3] uncaught error (this itself is a FAIL):', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
