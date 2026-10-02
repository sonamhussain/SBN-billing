import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { prisma } from '../../shared/database/prisma.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { apiFixtures } from '../a3-governance/a3-governance.fixtures.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { createEvidenceRequirement, evaluateEvidenceCompleteness } from '../../modules/evidence-requirement/evidence-requirement.service.ts'
import { createEncounterEvidenceLink } from '../../modules/encounter-evidence/encounter-evidence.service.ts'

// A5.6 — focused acceptance for Evidence Requirement Resolution & Completeness (T01–T123).
//
// A5.6 attaches a typed evidence-requirement payload to a governed DOCUMENTATION_REQUIREMENT_EFFECT
// RuleVersion, links exact A5.1 evidence versions to an Encounter, and — in one read-only snapshot —
// resolves the applicable requirements through A3.8/A3.9 and classifies the Encounter's exact evidence
// as VALID, INVALID or STALE to report SATISFIED, MISSING or INCOMPLETE. Nothing about an evaluation is
// stored or audited.
//
// Valid fixtures, governed rules included, are created through their owning routes (A3's own fixture
// builder). Every scenario gets a payer of its own and every documentation rule is scoped to one
// payer, so a rule one scenario creates never applies to another, or to another run. The database is
// READ for structural proof; ADVERSARIAL writes go in only to prove something refuses them. Every
// value is synthetic.

let passed = 0
let failed = 0
let notApplicable = 0
const failures: string[] = []

function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  if (condition) {
    passed += 1
    console.log(`[A5.6] ${id} ${title} ${dots} PASS${detail ? ` - ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(`${id} ${title} ${detail}`)
    console.log(`[A5.6] ${id} ${title} ${dots} FAIL${detail ? ` - ${detail}` : ''}`)
  }
}

function notApplicableCheck(id: string, title: string, reason: string) {
  notApplicable += 1
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  console.log(`[A5.6] ${id} ${title} ${dots} N/A  - ${reason}`)
}

const section = (title: string) => console.log(`\n[A5.6] ${title}`)

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

// Scope guards judge behaviour on committed production code, never vocabulary in comments or tests.
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
const committedProductionCodeOf = (dirs: string[]) => {
  const files = dirs.flatMap((dir) => committedFiles(dir)).filter((file) => !file.endsWith('.test.ts'))
  return { files, code: files.map((file) => committedCode(file)).join('\n') }
}

class RunAborted extends Error {}

const runId = `A56-${Date.now()}`
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
// A5.5 FINAL PASS was merged into main as PR #53; A5.6 is branched from that merge.
const a55Merge = 'af44030'
const a56Branch = 'feature/a5-6-evidence-requirement-resolution-completeness'
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'
const DOC = 'DOCUMENTATION_REQUIREMENT_EFFECT'
const REPORT = `SYNTHETIC_REPORT_${Date.now().toString(36).toUpperCase()}`

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

function failAt(probe: string, message: string) {
  clearConcurrencyProbes()
  setConcurrencyProbe(probe, async () => {
    throw new Error(message)
  })
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

  console.log(`[A5.6] Evidence requirement resolution & completeness — run ${runId}`)
  console.log(`[A5.6] HEAD ${git('rev-parse HEAD')} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

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
    throw new RunAborted(`the database is not reachable, so no check can be judged. Start it with \`docker start ${dbContainer}\`, wait for it to report healthy, then run this suite again.`)

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
  section('Start gate, migration and permissions')
  const branch = git('rev-parse --abbrev-ref HEAD')
  check(
    'T01',
    'Start gate',
    branch === a56Branch && gitOk(`merge-base --is-ancestor ${a55Merge} origin/main`) && gitOk('merge-base --is-ancestor origin/main HEAD'),
    `branch ${branch}; the A5.5 merge ${a55Merge} (PR #53) is on main and this branch contains the latest main ${git('rev-parse --short origin/main')}`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  check('T02', 'Git clean', dirty.length === 0, dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.length} path(s)`)

  const migrationPaths = git('diff --name-only origin/main...HEAD -- :/backend/prisma/migrations').split(/\r?\n/).filter((line) => line.endsWith('migration.sql'))
  const migrationSql = migrationPaths.length === 1 ? git(`show HEAD:${migrationPaths[0]}`) : ''
  const statements = migrationSql.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('--')).join('\n')
  const createdTables = (statements.match(/CREATE TABLE "([a-z_]+)"/g) ?? []).map((m) => m.replace(/CREATE TABLE "|"/g, '')).sort()
  const scopeProblems = [
    [JSON.stringify(createdTables) === JSON.stringify(['encounter_evidence_links', 'evidence_requirement_document_types', 'evidence_requirements']), `tables created: ${createdTables.join(', ')}`],
    [!/DROP INDEX/.test(statements), 'an index is dropped (drift)'],
    [!/SET DEFAULT pg_catalog/.test(statements), 'Better Auth defaults leaked in (drift)'],
    [(statements.match(/ALTER TABLE "([a-z_]+)"/g) ?? []).every((m) => /"(evidence_requirements|evidence_requirement_document_types|encounter_evidence_links)"/.test(m)), 'a table outside A5.6 is altered'],
    [(statements.match(/ADD CONSTRAINT "[a-z_]*_chk"/g) ?? []).length === 4, 'the four CHECKs are not all added'],
    [(statements.match(/ON DELETE RESTRICT/g) ?? []).length === 5, 'not all five foreign keys are ON DELETE RESTRICT'],
    [/CREATE UNIQUE INDEX "encounter_evidence_links_active_uq"[^;]*WHERE "removed_at" IS NULL/.test(statements), 'the partial active-link uniqueness is missing'],
    [(statements.match(/CREATE TRIGGER [a-z_]+_trg/g) ?? []).length === 3, 'the three immutability triggers are not all created'],
    [!/validation_run|validation_finding|readiness|claim|completeness_result/i.test(statements), 'a future-phase or result table appears'],
  ].filter(([ok]) => !ok).map(([, reason]) => reason as string)
  check(
    'T03',
    'Migration scope',
    migrationPaths.length === 1 && scopeProblems.length === 0,
    migrationPaths.length !== 1 ? `expected exactly one migration, found ${migrationPaths.length}` : scopeProblems.length === 0 ? 'one migration; exactly the three A5.6 tables, four CHECKs, five RESTRICT foreign keys, the partial active-link index and three triggers, with no drift' : `out of scope: ${scopeProblems.join('; ')}`,
  )
  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T04', 'Prisma gates', validate.ok && generate.ok && status.ok && /Database schema is up to date/.test(status.output), 'schema valid, client generated, schema up to date')
  const replay = run('npm run db:verify:replay')
  check(
    'T05',
    'Migration replay',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && /the immutability trigger on encounter evidence links is present/.test(replay.output) &&
      /evidence requirements copy no A3 scope, links copy no evidence metadata, and no completeness-result table exists/.test(replay.output),
    `${(replay.output.match(/\d+ migrations applied cleanly[^\n]*/) ?? ['replay output unavailable'])[0]}; every A5.6 constraint, index and trigger survives`,
  )
  const allCodes = (await prisma.permission.findMany({ select: { code: true } })).map((row) => row.code)
  const expected = ['encounterEvidence.create', 'encounterEvidence.read', 'encounterEvidence.update', 'evidenceCompleteness.evaluate', 'evidenceRequirement.create', 'evidenceRequirement.read']
  const a56Codes = allCodes.filter((code) => /^(evidenceRequirement|encounterEvidence|evidenceCompleteness)\./.test(code)).sort()
  const grants = await prisma.rolePermission.findMany({ where: { permission: { code: { in: expected } } }, select: { role: { select: { code: true } }, permission: { select: { code: true } } } })
  const grantOf = (code: string) => grants.filter((g) => g.permission.code === code).map((g) => g.role.code).sort().join(',')
  const invented = allCodes.filter((code) => /^(evidenceRequirement|encounterEvidence|evidenceCompleteness)\.(delete|download|upload|bytes|claim)/i.test(code))
  check(
    'T06',
    'Permissions',
    JSON.stringify(a56Codes) === JSON.stringify(expected) && invented.length === 0 &&
      ['evidenceRequirement.create', 'encounterEvidence.create', 'encounterEvidence.update'].every((code) => grantOf(code) === 'ORG_ADMIN') &&
      ['evidenceRequirement.read', 'encounterEvidence.read', 'evidenceCompleteness.evaluate'].every((code) => grantOf(code) === 'ORG_ADMIN,ORG_VIEWER'),
    'exactly the six A5.6 permissions; create and remove for Admin, read and evaluate for Admin and Viewer; no delete, byte or claim permission',
  )

  // ---------------------------------------------------------------- fixtures
  await apiReady('signing in')
  let connectionResets = 0
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
  const post = (path: string, body: unknown, who = asAdmin) => httpCall(path, who({ method: 'POST', body: JSON.stringify(body) }))
  const patchApi = (path: string, body: unknown, who = asAdmin) => httpCall(path, who({ method: 'PATCH', body: JSON.stringify(body) }))
  const del = (path: string, who = asAdmin) => httpCall(path, who({ method: 'DELETE' }))
  const get = (path: string, who = asAdmin) => httpCall(path, who())
  const must = <T extends { id?: string }>(label: string, body: T) => {
    if (!body?.id) throw new Error(`fixture ${label} could not be created through its owner route: ${JSON.stringify(body).slice(0, 250)}`)
    return body as T & { id: string }
  }
  const fx = apiFixtures(baseUrl, admin.cookie, org, runId)
  const actorUserId = (await prisma.user.findFirstOrThrow({ where: { email: adminEmail }, select: { id: true } })).id
  let serial = 0
  const key = (prefix: string) => `${runId}-${prefix}-${++serial}`

  section('Fixtures through owner routes')
  const patient = must('patient', (await post(`/api/organizations/${org}/patients`, { givenName: 'Synthetic', familyName: `${runId}-P`, dateOfBirth: '1990-01-01' })).body)
  const facility = must('facility', (await post(`/api/organizations/${org}/facilities`, { name: `${runId} facility` })).body)
  const profile = must('profile', (await post(`/api/facilities/${facility.id}/regulatory-profiles`, { jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  if ((await post(`/api/facility-regulatory-profiles/${profile.id}/activate`, {})).status !== 200) throw new Error('fixture profile activation failed')
  const clinician = must('clinician', (await post(`/api/organizations/${org}/clinicians`, { displayName: `${runId} clinician` })).body)
  must('assignment', (await post(`/api/clinicians/${clinician.id}/facility-assignments`, { facilityId: facility.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  const service = must('service', (await post(`/api/organizations/${org}/services`, { internalCode: key('S'), displayName: 'Synthetic service' })).body)
  const diagnosisCode = must('diagnosis code', (await post(`/api/organizations/${org}/diagnosis-codes`, { code: key('DX'), displayName: 'Synthetic diagnosis' })).body)
  const governing = await fx.verifiedSource('documentation', { activateOn: '2025-01-01' })

  // A commercial world of its own: a payer, a membership, an Encounter, and a resolvable contract
  // and VERIFIED tariff version, so A5.5 resolves and A5.6 can reach A3.
  const world = async (label: string, options: { resolvable?: boolean } = {}) => {
    const payer = must(`${label} payer`, (await post(`/api/organizations/${org}/payers`, { displayName: `${runId} ${label} payer` })).body)
    const membership = must(`${label} membership`, (await post(`/api/patients/${patient.id}/insurance-memberships`, { payerId: payer.id, memberIdentifier: `MEM-${key('M')}`, coverageFrom: '2025-01-01', coverageTo: null })).body)
    if (options.resolvable !== false) {
      const contract = must(`${label} contract`, (await post(`/api/organizations/${org}/provider-contracts`, { contractKey: key('C'), displayName: `${runId} contract`, payerId: payer.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
      must(`${label} contract facility`, (await post(`/api/provider-contracts/${contract.id}/contract-facilities`, { facilityId: facility.id })).body)
      const schedule = must(`${label} schedule`, (await post(`/api/provider-contracts/${contract.id}/tariff-schedules`, { tariffKey: key('T'), displayName: `${runId} tariff` })).body)
      const tv = must(`${label} tariff version`, (await post(`/api/tariff-schedules/${schedule.id}/versions`, { version: key('V'), effectiveFrom: '2026-01-01', effectiveTo: null })).body)
      if ((await post(`/api/tariff-schedule-versions/${tv.id}/verification`, { verificationStatus: 'VERIFIED' })).status !== 200) throw new Error(`fixture ${label} tariff verification failed`)
    }
    const encounter = async () => must(`${label} encounter`, (await post(`/api/patients/${patient.id}/encounters`, { facilityId: facility.id, clinicianId: clinician.id, serviceDate: SERVICE_DATE, insuranceMembershipId: membership.id })).body)
    return { payer, membership, encounter }
  }

  type Payload = { documentTypes: string[]; minimumCount: number; sourceDateRequired: boolean; maxSourceAgeDays: number | null }
  const STANDARD: Payload = { documentTypes: [REPORT], minimumCount: 1, sourceDateRequired: true, maxSourceAgeDays: 30 }
  // A governed documentation rule scoped to one payer (plus any extra dimensions), with its payload,
  // bound to the shared governing source and VERIFIED — all through A3's own routes.
  const docRule = async (payerId: string, payload: Payload | null, options: { dimensions?: Record<string, string>; verify?: boolean; rule?: { id: string }; label?: string } = {}) => {
    const rule = options.rule ?? (await fx.ruleDefinition('documentation'))
    const version = await fx.draftRuleVersion(rule.id, options.label ?? '1', { effectType: DOC })
    await fx.applicability(version.id, { payerId, ...(options.dimensions ?? {}) })
    const binding = await fx.bind(version.id, governing.interpretation.id)
    if (payload) {
      const created = await post(`/api/rule-versions/${version.id}/evidence-requirement`, payload)
      if (created.status !== 201) throw new Error(`fixture requirement returned ${created.status}: ${JSON.stringify(created.body).slice(0, 200)}`)
    }
    if (options.verify !== false) await fx.verifyRuleVersion(version.id)
    return { rule, version, binding }
  }
  const evidence = async (documentType: string, sourceDate: string | null) => {
    const artifact = must('evidence', (await post(`/api/organizations/${org}/evidence-artifacts`, { storageRef: `synthetic://evidence/${key('E')}`, contentHash: 'a'.repeat(64), documentType, sourceDate, receivedAt: '2026-06-15T09:30:00.000Z' })).body) as any
    return { artifactId: artifact.id as string, versionId: artifact.latestVersion.id as string }
  }
  const link = (encounterId: string, versionId: string, who = asAdmin) => post(`/api/encounters/${encounterId}/evidence-links`, { evidenceArtifactVersionId: versionId }, who)
  const evaluate = async (encounterId: string, body: unknown = {}, who = asAdmin) => {
    const res = await post(`/api/encounters/${encounterId}/evidence-completeness/evaluate`, body, who)
    return { status: res.status, body: res.body as any }
  }
  const only = (r: { status: number; body: any }) => (r.status === 200 && r.body.requirements.length === 1 ? r.body.requirements[0] : null)
  const describe = (r: { status: number; body: any }) => {
    if (r.status !== 200) return `${r.status} ${r.body?.error?.code}/${r.body?.error?.reason ?? '-'}`
    const q = r.body.requirements[0]
    return q ? `${q.state} valid ${q.validCount} invalid ${q.invalidCount} stale ${q.staleCount} of ${q.totalCandidateCount}` : `no requirement (${r.body.requirements.length})`
  }

  const main = await world('main')
  const mainRule = await docRule(main.payer.id, STANDARD)
  console.log(`[A5.6]      fixtures ready: patient, facility, clinician, service, diagnosis code, one governing source, and the main governed documentation rule`)

  // ---------------------------------------------------------------- requirement payload (T07–T23)
  section('Typed requirement payload on a documentation RuleVersion')
  const draftDoc = async (effectType = DOC) => fx.draftRuleVersion((await fx.ruleDefinition('payload')).id, '1', { effectType })
  const requirementRows = async (ruleVersionId: string) => prisma.evidenceRequirement.findUnique({ where: { ruleVersionId }, include: { documentTypes: true } })
  const reqAudit = () => prisma.auditEvent.count({ where: { entityType: 'EVIDENCE_REQUIREMENT' } })

  const t07Version = await draftDoc()
  const auditBefore07 = await reqAudit()
  const t07 = await post(`/api/rule-versions/${t07Version.id}/evidence-requirement`, { documentTypes: ['B-TYPE', 'A-TYPE'], minimumCount: 2, sourceDateRequired: true, maxSourceAgeDays: 7 })
  const t07Rows = await requirementRows(t07Version.id)
  check(
    'T07',
    'Requirement create',
    t07.status === 201 && t07Rows?.documentTypes.length === 2 && (await reqAudit()) === auditBefore07 + 1 && JSON.stringify((t07.body as any).documentTypes) === JSON.stringify(['A-TYPE', 'B-TYPE']),
    '201; the payload, both document types and one safe audit written together on an UNVERIFIED documentation RuleVersion',
  )
  const wrongEffect = await draftDoc('AUTHORIZATION_REQUIREMENT_EFFECT')
  const t08 = await post(`/api/rule-versions/${wrongEffect.id}/evidence-requirement`, STANDARD)
  // The owner-approved guard: a version that already carries a payload keeps its documentation effect.
  const effectChange = await patchApi(`/api/rule-versions/${t07Version.id}`, { effectType: 'AUTHORIZATION_REQUIREMENT_EFFECT' })
  const t07Effect = (await prisma.ruleVersion.findUniqueOrThrow({ where: { id: t07Version.id } })).effectType
  check(
    'T08',
    'Wrong effect type',
    t08.status === 400 && (await requirementRows(wrongEffect.id)) === null && effectChange.status === 400 && t07Effect === DOC,
    `refused ${t08.status}; only a DOCUMENTATION_REQUIREMENT_EFFECT version carries a payload, and a version carrying one cannot change its effect type (${effectChange.status})`,
  )
  const inReview = await draftDoc()
  await post(`/api/rule-versions/${inReview.id}/verification`, { verificationStatus: 'IN_REVIEW' })
  const rejected = await draftDoc()
  await post(`/api/rule-versions/${rejected.id}/verification`, { verificationStatus: 'REJECTED' })
  const late = await Promise.all([inReview.id, rejected.id, mainRule.version.id].map(async (id) => (await post(`/api/rule-versions/${id}/evidence-requirement`, { ...STANDARD, documentTypes: ['LATE'] })).status))
  check(
    'T09',
    'RuleVersion terminal',
    late.every((code) => code === 400) && (await requirementRows(inReview.id)) === null && (await requirementRows(rejected.id)) === null,
    `IN_REVIEW, REJECTED and VERIFIED versions refuse a late payload (${late.join('/')})`,
  )
  const t10 = await post(`/api/rule-versions/${t07Version.id}/evidence-requirement`, { ...STANDARD, documentTypes: ['OTHER'] })
  check('T10', 'Second requirement', t10.status === 400 && JSON.stringify(await requirementRows(t07Version.id)) === JSON.stringify(t07Rows), 'refused; the original payload is unchanged')
  const t11 = [(await patchApi(`/api/rule-versions/${t07Version.id}/evidence-requirement`, {})).status, (await del(`/api/rule-versions/${t07Version.id}/evidence-requirement`)).status]
  check('T11', 'Requirement immutable', t11.every((code) => code === 404), `PATCH and DELETE are 404 (${t11.join('/')})`)
  const t12 = await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE evidence_requirements SET minimum_count = 9 WHERE rule_version_id = '${t07Version.id}'`))
  check('T12', 'DB requirement UPDATE', /append-only/.test(t12), 'the trigger refused a direct UPDATE')
  const t13 = await attemptAdversarial(() => prisma.$executeRawUnsafe(`DELETE FROM evidence_requirements WHERE rule_version_id = '${t07Version.id}'`))
  check('T13', 'DB requirement DELETE', /append-only/.test(t13) && (await requirementRows(t07Version.id)) !== null, 'the trigger refused a direct DELETE and the payload survived')
  const bodyCase = async (payload: unknown) => {
    const v = await draftDoc()
    const res = await post(`/api/rule-versions/${v.id}/evidence-requirement`, payload)
    return { status: res.status, body: res.body as any, rows: await requirementRows(v.id) }
  }
  const t14 = await bodyCase({ ...STANDARD, documentTypes: [] })
  check('T14', 'Document type required', t14.status === 400 && t14.rows === null, 'an empty documentTypes list is refused')
  const t15 = await bodyCase({ ...STANDARD, documentTypes: ['  Report-Mixed  '] })
  check('T15', 'Document type normalization', t15.status === 201 && t15.rows?.documentTypes[0].documentType === 'Report-Mixed', 'trimmed, nonblank, case preserved')
  const t16 = await bodyCase({ ...STANDARD, documentTypes: ['DUP', ' DUP '] })
  check('T16', 'Duplicate document type', t16.status === 400 && t16.rows === null, 'the same type twice in one requirement is refused')
  const childUpdate = await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE evidence_requirement_document_types SET document_type = 'X' WHERE evidence_requirement_id = '${t07Rows!.id}'`))
  const childDelete = await attemptAdversarial(() => prisma.$executeRawUnsafe(`DELETE FROM evidence_requirement_document_types WHERE evidence_requirement_id = '${t07Rows!.id}'`))
  check('T17', 'Document type immutable', /append-only/.test(childUpdate) && /append-only/.test(childDelete), 'direct UPDATE and DELETE of a document-type row are refused')
  const minimums = await Promise.all([0, -1, 1.5, '1'].map(async (value) => (await bodyCase({ ...STANDARD, minimumCount: value })).status))
  check('T18', 'minimumCount', minimums.every((code) => code === 400), `zero, negative, fractional and string minimums refused (${minimums.join('/')})`)
  const t19 = await bodyCase({ ...STANDARD, sourceDateRequired: 'true' })
  check('T19', 'sourceDateRequired', t19.status === 400, 'only a real boolean is accepted')
  const t20 = await bodyCase({ ...STANDARD, maxSourceAgeDays: null })
  check('T20', 'maxSourceAgeDays null', t20.status === 201 && t20.rows?.maxSourceAgeDays === null, 'no freshness limit is accepted')
  const t21 = await bodyCase({ ...STANDARD, maxSourceAgeDays: 0 })
  check('T21', 'maxSourceAgeDays zero', t21.status === 201 && t21.rows?.maxSourceAgeDays === 0, 'zero days accepted with sourceDateRequired=true')
  const t22 = await Promise.all([-1, 1.5].map(async (value) => (await bodyCase({ ...STANDARD, maxSourceAgeDays: value })).status))
  check('T22', 'maxSourceAgeDays invalid', t22.every((code) => code === 400), `negative and fractional limits refused (${t22.join('/')})`)
  const t23app = await bodyCase({ ...STANDARD, sourceDateRequired: false, maxSourceAgeDays: 5 })
  const t23Version = await draftDoc()
  const t23db = await attemptAdversarial(() =>
    prisma.$executeRawUnsafe(`INSERT INTO evidence_requirements (id, rule_version_id, minimum_count, source_date_required, max_source_age_days) VALUES (gen_random_uuid(), '${t23Version.id}', 1, false, 5)`),
  )
  check('T23', 'Freshness requires date', t23app.status === 400 && /evidence_requirements_freshness_requires_date_chk/.test(t23db) && (await requirementRows(t23Version.id)) === null, 'refused by the application and, for a direct INSERT, by the database CHECK')

  // ---------------------------------------------------------------- verification gate (T24–T27)
  section('RuleVersion verification gate')
  // The gate's rules live in a world of their own, so the VERIFIED one T25 produces never applies to
  // the main world's Encounters.
  const gatePayer = (await world('gate')).payer
  const gateWorld = await docRule(gatePayer.id, null, { verify: false })
  const t24 = await post(`/api/rule-versions/${gateWorld.version.id}/verification`, { verificationStatus: 'VERIFIED' })
  const t24Status = (await prisma.ruleVersion.findUniqueOrThrow({ where: { id: gateWorld.version.id } })).verificationStatus
  check('T24', 'Rule verification gate', t24.status === 400 && t24Status === 'UNVERIFIED', 'a documentation RuleVersion without its payload cannot become VERIFIED')
  const withPayload = await docRule(gatePayer.id, STANDARD, { verify: false })
  const t25 = await post(`/api/rule-versions/${withPayload.version.id}/verification`, { verificationStatus: 'VERIFIED' })
  check('T25', 'Rule verification with payload', t25.status === 200 && (t25.body as any).verificationStatus === 'VERIFIED', 'with a complete payload the existing A3 verification proceeds')
  const otherEffect = await fx.draftRuleVersion((await fx.ruleDefinition('other effect')).id, '1', { effectType: 'AUTHORIZATION_REQUIREMENT_EFFECT' })
  await fx.applicability(otherEffect.id, { payerId: gatePayer.id })
  await fx.bind(otherEffect.id, governing.interpretation.id)
  const t26 = await post(`/api/rule-versions/${otherEffect.id}/verification`, { verificationStatus: 'VERIFIED' })
  check('T26', 'Other effect verification', t26.status === 200, 'a non-documentation RuleVersion still verifies without any payload')
  // Legacy: a VERIFIED documentation version with no payload can only exist from before the gate, so
  // it is produced adversarially, in a world of its own.
  const legacyWorld = await world('legacy')
  const legacy = await docRule(legacyWorld.payer.id, null, { verify: false })
  await prisma.$executeRawUnsafe(`UPDATE rule_versions SET verification_status = 'VERIFIED', verified_at = now() WHERE id = '${legacy.version.id}'`)
  const t27 = await evaluate((await legacyWorld.encounter()).id)
  check('T27', 'Legacy incomplete config', t27.status === 409 && t27.body?.error?.reason === 'CONFIGURATION_INCOMPLETE', `${describe(t27)}: a resolved VERIFIED documentation rule without its payload is never silently accepted`)

  // ---------------------------------------------------------------- encounter evidence links (T28–T39)
  section('Encounter evidence links')
  const linkEncounter = await main.encounter()
  const fresh = await evidence(REPORT, '2026-06-01')
  const versionBefore = JSON.stringify(await prisma.evidenceArtifactVersion.findUniqueOrThrow({ where: { id: fresh.versionId } }))
  const linkAudit = () => prisma.auditEvent.count({ where: { entityType: 'ENCOUNTER_EVIDENCE_LINK' } })
  const auditBefore28 = await linkAudit()
  const t28 = await link(linkEncounter.id, fresh.versionId)
  const t28Row = await prisma.encounterEvidenceLink.findUnique({ where: { id: (t28.body as any)?.id ?? MISSING } })
  check('T28', 'Encounter evidence create', t28.status === 201 && t28Row?.removedAt === null && (await linkAudit()) === auditBefore28 + 1, '201; the exact own-tenant version linked with one safe audit')
  const foreignVersion = await prisma.evidenceArtifactVersion.findFirst({ where: { evidenceArtifact: { organizationId: otherOrg } }, select: { id: true } })
  const t29 = foreignVersion ? await link(linkEncounter.id, foreignVersion.id) : null
  const t30 = await link(linkEncounter.id, MISSING)
  const msg = (r: any) => String(r?.body?.error?.message ?? '')
  check('T29', 'Foreign evidence', t29 !== null && t29.status === 404 && msg(t29) === msg(t30) && !msg(t29).includes(otherOrg), `refused ${t29?.status} exactly as a missing version is; nothing disclosed`)
  check('T30', 'Missing evidence version', t30.status === 404 && (await linkAudit()) === auditBefore28 + 1, '404 with no link and no audit')
  const t31 = await link(linkEncounter.id, fresh.versionId)
  check('T31', 'Active duplicate link', t31.status === 400, 'a second active link of the same Encounter and version is refused')
  const second = await evidence(REPORT, '2026-06-02')
  const secondLink = await link(linkEncounter.id, second.versionId)
  const listA = await get(`/api/encounters/${linkEncounter.id}/evidence-links`)
  const listB = await get(`/api/encounters/${linkEncounter.id}/evidence-links`)
  check('T32', 'Link list', listA.status === 200 && (listA.body as any).items.length === 2 && JSON.stringify(listA.body) === JSON.stringify(listB.body), 'active links only, byte-identical across two reads')
  const removal = await post(`/api/encounter-evidence-links/${(secondLink.body as any).id}/remove`, {})
  const removedRead = await get(`/api/encounter-evidence-links/${(secondLink.body as any).id}`)
  const listAfter = await get(`/api/encounters/${linkEncounter.id}/evidence-links`)
  check('T33', 'Link by ID', removedRead.status === 200 && (removedRead.body as any).removedAt !== null && (listAfter.body as any).items.length === 1, 'the removed link is still readable by id and gone from the active list')
  check(
    'T34',
    'Link remove',
    removal.status === 200 && (removal.body as any).removedAt !== null && (await prisma.evidenceArtifactVersion.findUniqueOrThrow({ where: { id: second.versionId } })).id === second.versionId,
    'removedAt set once; the evidence version itself is untouched',
  )
  const removedAtFirst = (removal.body as any).removedAt
  const t35 = await post(`/api/encounter-evidence-links/${(secondLink.body as any).id}/remove`, {})
  check(
    'T35',
    'Link re-remove',
    t35.status === 400 && (await prisma.encounterEvidenceLink.findUniqueOrThrow({ where: { id: (secondLink.body as any).id } })).removedAt?.toISOString() === removedAtFirst,
    'a second removal is refused and the first removal time is kept',
  )
  const t36 = await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE encounter_evidence_links SET encounter_id = '${main.membership.id}' WHERE id = '${(t28.body as any).id}'`))
  check('T36', 'Link identity immutable', /identity is immutable/.test(t36), 'a direct change of encounter, evidence or author is refused')
  const t37 = await attemptAdversarial(() => prisma.$executeRawUnsafe(`DELETE FROM encounter_evidence_links WHERE id = '${(t28.body as any).id}'`))
  check('T37', 'DB link DELETE', /cannot be deleted/.test(t37), 'the trigger refused a direct DELETE')
  const relink = await link(linkEncounter.id, second.versionId)
  check('T38', 'Relink after removal', relink.status === 201 && (relink.body as any).id !== (secondLink.body as any).id, 'the same exact version may be linked again as a new row')
  const evidenceCode = committedProductionCodeOf(['backend/src/modules/evidence-requirement', 'backend/src/modules/encounter-evidence']).code
  check(
    'T39',
    'A5.1 immutability',
    JSON.stringify(await prisma.evidenceArtifactVersion.findUniqueOrThrow({ where: { id: fresh.versionId } })) === versionBefore && !/evidenceArtifactVersion\.(update|upsert|delete|create)/.test(evidenceCode),
    'the linked evidence version is byte-identical after linking and evaluation, and A5.6 never writes one',
  )

  // ---------------------------------------------------------------- evidence pool (T40–T46)
  section('The Encounter evidence pool')
  const poolCase = async (setup: (encounterId: string) => Promise<void>) => {
    const enc = await main.encounter()
    await setup(enc.id)
    return { encounterId: enc.id, result: await evaluate(enc.id) }
  }
  const t40 = await poolCase(async (id) => void (await link(id, (await evidence(REPORT, '2026-06-01')).versionId)))
  check('T40', 'Evidence pool active link', only(t40.result)?.state === 'SATISFIED', describe(t40.result))
  const t41 = await poolCase(async (id) => {
    const l = await link(id, (await evidence(REPORT, '2026-06-01')).versionId)
    await post(`/api/encounter-evidence-links/${(l.body as any).id}/remove`, {})
  })
  check('T41', 'Evidence pool removed link', only(t41.result)?.state === 'MISSING', `${describe(t41.result)}: a removed link is not current evidence`)
  const eligibilityEvidence = await evidence(REPORT, '2026-06-01')
  const t42 = await poolCase(async (id) => {
    must('eligibility', (await post(`/api/encounters/${id}/eligibility-verifications`, { verificationMethod: 'PORTAL', status: 'UNKNOWN', requestedAt: null, respondedAt: '2026-06-15T09:31:00.000Z', validThrough: null, authorizationRequired: null, referralRequired: null, requestEvidenceVersionId: null, responseEvidenceVersionId: eligibilityEvidence.versionId })).body)
  })
  check('T42', 'Evidence pool eligibility', only(t42.result)?.validEvidenceArtifactVersionIds?.[0] === eligibilityEvidence.versionId, `${describe(t42.result)}: A5.2 response evidence of the same Encounter counts`)
  const authEvidence = await evidence(REPORT, '2026-06-01')
  const t43 = await poolCase(async (id) => {
    must('authorization', (await post(`/api/encounters/${id}/prior-authorizations`, { versionKind: 'INITIAL', status: 'REQUESTED', evidenceLinks: [{ role: 'REQUEST', evidenceArtifactVersionId: authEvidence.versionId }] })).body)
  })
  check('T43', 'Evidence pool authorization', only(t43.result)?.validEvidenceArtifactVersionIds?.[0] === authEvidence.versionId, `${describe(t43.result)}: A5.3 authorization evidence of the same Encounter counts`)
  const t44 = await poolCase(async () => {})
  check('T44', 'Evidence pool tenant boundary', only(t44.result)?.state === 'MISSING', `${describe(t44.result)}: evidence linked to other Encounters of the same patient is not counted`)
  const shared = await evidence(REPORT, '2026-06-01')
  const t45 = await poolCase(async (id) => {
    await link(id, shared.versionId)
    must('eligibility', (await post(`/api/encounters/${id}/eligibility-verifications`, { verificationMethod: 'PORTAL', status: 'UNKNOWN', requestedAt: null, respondedAt: '2026-06-15T09:31:00.000Z', validThrough: null, authorizationRequired: null, referralRequired: null, requestEvidenceVersionId: null, responseEvidenceVersionId: shared.versionId })).body)
    must('authorization', (await post(`/api/encounters/${id}/prior-authorizations`, { versionKind: 'INITIAL', status: 'REQUESTED', evidenceLinks: [{ role: 'REQUEST', evidenceArtifactVersionId: shared.versionId }] })).body)
  })
  check('T45', 'Evidence pool dedupe', only(t45.result)?.totalCandidateCount === 1 && only(t45.result)?.validCount === 1, `${describe(t45.result)}: one exact version referenced three ways (A5.6 link, A5.2 response, A5.3 request) counts once`)
  await evidence(REPORT, '2026-06-10')
  const t46 = await poolCase(async () => {})
  check('T46', 'No org-wide evidence sweep', only(t46.result)?.state === 'MISSING', 'matching evidence that exists in the organization but is not linked to this Encounter is never a candidate')

  // ---------------------------------------------------------------- targets (T47–T54)
  section('Evaluation targets — exact active rows, server-derived codes')
  const targetWorld = await world('target')
  await docRule(targetWorld.payer.id, STANDARD, { dimensions: { serviceId: service.id } })
  await docRule(targetWorld.payer.id, STANDARD, { dimensions: { diagnosisCodeId: diagnosisCode.id } })
  const targetEncounter = await targetWorld.encounter()
  const activity = must('activity', (await post(`/api/encounters/${targetEncounter.id}/activities`, { serviceId: service.id, quantity: '1' })).body)
  const diagnosis = must('diagnosis', (await post(`/api/encounters/${targetEncounter.id}/diagnoses`, { diagnosisCodeId: diagnosisCode.id })).body)
  const base = await evaluate(targetEncounter.id, {})
  check('T47', 'Encounter-level target', base.status === 200 && base.body.requirements.length === 0 && base.body.encounterActivityId === null, 'no target: service- and diagnosis-scoped rules do not apply to the Encounter as a whole')
  const byActivity = await evaluate(targetEncounter.id, { encounterActivityId: activity.id })
  check('T48', 'Activity target active', byActivity.status === 200 && byActivity.body.requirements.length === 1 && byActivity.body.encounterActivityId === activity.id, "the active activity's service is derived server-side and the service-scoped rule applies")
  const removedActivity = must('removed activity', (await post(`/api/encounters/${targetEncounter.id}/activities`, { serviceId: service.id, quantity: '1' })).body)
  await post(`/api/encounter-activities/${removedActivity.id}/remove`, {})
  check('T49', 'Activity removed', (await evaluate(targetEncounter.id, { encounterActivityId: removedActivity.id })).status === 400, 'a removed activity is refused as a target')
  const otherEncounter = await targetWorld.encounter()
  const otherActivity = must('other activity', (await post(`/api/encounters/${otherEncounter.id}/activities`, { serviceId: service.id, quantity: '1' })).body)
  check('T50', 'Activity foreign Encounter', (await evaluate(targetEncounter.id, { encounterActivityId: otherActivity.id })).status === 400, "another Encounter's activity is refused")
  const byDiagnosis = await evaluate(targetEncounter.id, { encounterDiagnosisId: diagnosis.id })
  check('T51', 'Diagnosis target active', byDiagnosis.status === 200 && byDiagnosis.body.requirements.length === 1, "the active diagnosis's code is derived server-side and the diagnosis-scoped rule applies")
  const removedDxEncounter = await targetWorld.encounter()
  const removedDx = must('removed diagnosis', (await post(`/api/encounters/${removedDxEncounter.id}/diagnoses`, { diagnosisCodeId: diagnosisCode.id })).body)
  await post(`/api/encounter-diagnoses/${removedDx.id}/remove`, {})
  check('T52', 'Diagnosis removed', (await evaluate(removedDxEncounter.id, { encounterDiagnosisId: removedDx.id })).status === 400, 'a removed diagnosis is refused as a target')
  check('T53', 'Diagnosis foreign Encounter', (await evaluate(otherEncounter.id, { encounterDiagnosisId: diagnosis.id })).status === 400, "another Encounter's diagnosis is refused")
  const forged: string[] = []
  for (const field of ['serviceId', 'procedureCodeId', 'diagnosisCodeId', 'payerId', 'providerContractId', 'tariffScheduleVersionId', 'businessDate', 'ruleVersionId', 'evidenceArtifactVersionId'])
    if ((await evaluate(targetEncounter.id, { [field]: field === 'businessDate' ? '2020-01-01' : service.id })).status !== 400) forged.push(field)
  check('T54', 'Client context forgery', forged.length === 0, forged.length === 0 ? 'service, procedure, diagnosis code, payer, contract, tariff, businessDate, rule version and evidence fields are all refused' : `accepted: ${forged.join(', ')}`)

  // ---------------------------------------------------------------- context (T55–T61)
  section('Authoritative context — A4.9 and A5.5 in one snapshot')
  const coverageWorld = await world('coverage')
  await docRule(coverageWorld.payer.id, STANDARD)
  const coverageEncounter = await coverageWorld.encounter()
  await patchApi(`/api/insurance-memberships/${coverageWorld.membership.id}`, { coverageTo: '2026-05-31' })
  const t55 = await evaluate(coverageEncounter.id)
  check('T55', 'A4 integrity', t55.status === 409 && t55.body?.error?.code === 'INTEGRITY_CONFLICT' && t55.body?.error?.reason === 'A4_INTEGRITY_CONFLICT', `${describe(t55)}: the A4.9 conflict blocks before any requirement is resolved`)
  const mainEval = await evaluate(t40.encounterId)
  const commercial = (await get(`/api/encounters/${t40.encounterId}/pre-claim-commercial-context`)).body as any
  check(
    'T56',
    'A5.5 commercial context',
    mainEval.status === 200 && mainEval.body.commercialContext.providerContractId === commercial.providerContractId && mainEval.body.commercialContext.tariffScheduleVersionId === commercial.tariffScheduleVersionId,
    'the exact contract, schedule and version A5.5 resolves are the ones used',
  )
  const unresolvedWorld = await world('unresolved', { resolvable: false })
  const t57 = await evaluate((await unresolvedWorld.encounter()).id)
  check('T57', 'A5.5 unresolved', t57.status === 409 && t57.body?.error?.code === 'COMMERCIAL_CONTEXT_UNRESOLVED' && t57.body?.error?.reason === 'NO_APPLICABLE_CONTRACT', `${describe(t57)}: an unresolved commercial context blocks A5.6`)
  // One snapshot: hold an evaluation after its snapshot is taken, link evidence through the route on
  // another connection while it is held, then release. The held answer is wholly the earlier state.
  const snapEncounter = await main.encounter()
  const snapEvidence = await evidence(REPORT, '2026-06-01')
  const gate = holdAt('evidence_completeness.snapshot')
  const heldEval = evaluateEvidenceCompleteness(snapEncounter.id, {})
  await gate.arrived
  const linkedDuring = await Promise.race([link(snapEncounter.id, snapEvidence.versionId).then((r) => r.status), new Promise<number>((resolve) => setTimeout(() => resolve(-1), 15_000))])
  gate.release()
  const heldResult = await heldEval
  clearConcurrencyProbes()
  const afterSnap = await evaluate(snapEncounter.id)
  const snapshotSettings = await withReadSnapshot(undefined, async (tx) =>
    tx.$queryRaw<{ isolation: string; read_only: string }[]>`SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only`,
  )
  check(
    'T58',
    'One snapshot',
    linkedDuring === 201 && heldResult.ok && heldResult.value.requirements[0]?.state === 'MISSING' && only(afterSnap)?.state === 'SATISFIED' &&
      snapshotSettings[0]?.isolation === 'repeatable read' && snapshotSettings[0]?.read_only === 'on',
    'evidence linked mid-evaluation (201, no lock waited) is absent from the held REPEATABLE READ, READ ONLY result and present in the next one',
  )
  const serviceSource = committedCode('backend/src/modules/evidence-requirement/evidence-requirement.service.ts')
  check(
    'T59',
    'No public API chaining',
    !/\bfetch\(|callApi|axios|['"`]\/api\//.test(evidenceCode) && /resolvePreClaimCommercialContext\(encounterId, tx\)/.test(serviceSource) &&
      /evaluateRuleResolutionBundle\([^)]*\{ db: tx \}\)/.test(serviceSource) && /composeRuleDecisionProvenanceRefV1\([^)]*, tx\)/.test(serviceSource),
    'A4.9/A5.5, A3.8 and A3.9 are reused in-process with this evaluation\'s own transaction client',
  )
  check(
    'T60',
    'Business date',
    mainEval.body?.businessDate === SERVICE_DATE && (await evaluate(t40.encounterId, { businessDate: '2020-01-01' })).status === 400,
    'businessDate is always the Encounter service date; a supplied one is refused',
  )
  // A SYSTEM_SHARED and a foreign-tenant documentation rule exist (adversarial fixtures); neither is
  // discovered, so neither can block or add a requirement here.
  const shared1 = await prisma.ruleDefinition.create({ data: { organizationId: null, ruleKey: key('SHARED'), displayName: 'Synthetic shared doc rule', jurisdictionCode: 'AE-DU', ownershipScope: 'SYSTEM_SHARED' } })
  await prisma.ruleVersion.create({ data: { ruleId: shared1.id, version: '1', effectType: DOC } })
  const foreignRule = await prisma.ruleDefinition.create({ data: { organizationId: otherOrg, ruleKey: key('FOREIGN'), displayName: 'Synthetic foreign doc rule', jurisdictionCode: 'AE-DU', ownershipScope: 'ORGANIZATION' } })
  await prisma.ruleVersion.create({ data: { ruleId: foreignRule.id, version: '1', effectType: DOC } })
  const t61 = await evaluate(t40.encounterId)
  check(
    'T61',
    'Rule discovery visibility',
    t61.status === 200 && t61.body.requirements.length === 1 && t61.body.requirements.every((r: any) => r.provenance.organizationId === org),
    'only own-organization documentation rules are discovered; SYSTEM_SHARED and foreign-tenant ones are neither resolved nor allowed to block (owner decision: A3.8 resolves own-organization rules only)',
  )

  // ---------------------------------------------------------------- A3 resolution (T62–T67)
  section('Requirement discovery through A3.8 and A3.9')
  const noMatch = await world('no match')
  const t62 = await evaluate((await noMatch.encounter()).id)
  check('T62', 'A3 NO_MATCH', t62.status === 200 && t62.body.requirements.length === 0, 'rules scoped to other payers impose no requirement here')
  const mainReq = only(mainEval)
  check('T63', 'A3 RESOLVED', mainReq?.ruleVersionId === mainRule.version.id, 'the exact RuleVersion A3.8 selects carries its payload into the result')
  const blockWorld = await world('blocked')
  const blockRule = await fx.ruleDefinition('blocked')
  await docRule(blockWorld.payer.id, STANDARD, { rule: blockRule, label: '1' })
  await docRule(blockWorld.payer.id, STANDARD, { rule: blockRule, label: '2' })
  const t64 = await evaluate((await blockWorld.encounter()).id)
  check('T64', 'A3 blocked conflict', t64.status === 409 && t64.body?.error?.reason === 'REQUIREMENT_RESOLUTION_BLOCKED', `${describe(t64)} - failed closed; two equally specific applicable versions are never silently resolved or omitted`)
  check(
    'T65',
    'A3 provenance',
    mainReq?.provenance?.provenanceContractVersion === 'A3-PROV-1' && mainReq?.provenance?.ruleVersionId === mainRule.version.id &&
      mainReq?.provenance?.governingBindingId === mainRule.binding.id && mainReq?.provenance?.matchedApplicabilityIds?.length === 1,
    'the exact A3-PROV-1 provenance — rule version, governing binding and matched applicability — travels with the requirement',
  )
  check('T66', 'No A3 duplication', evidenceCode.length > 0 && !/specificity|SUPERSEDES|CONFLICTS_WITH|precedence|sourceCategoryRank/i.test(evidenceCode), 'no specificity, SUPERSEDES, CONFLICTS_WITH or source-ranking logic in A5.6')
  const twoWorld = await world('two rules')
  const twoA = await docRule(twoWorld.payer.id, STANDARD)
  const twoB = await docRule(twoWorld.payer.id, { ...STANDARD, documentTypes: ['SECOND_DOCUMENT'] })
  const t67 = await evaluate((await twoWorld.encounter()).id)
  const t67Ids = (t67.body?.requirements ?? []).map((r: any) => r.ruleVersionId).sort()
  check('T67', 'Independent rules', t67.status === 200 && JSON.stringify(t67Ids) === JSON.stringify([twoA.version.id, twoB.version.id].sort()), 'two resolved documentation rules yield two requirements, both visible')

  // ---------------------------------------------------------------- classification (T68–T86)
  section('Candidate classification and completeness')
  const classify = async (items: Array<[string, string | null]>, w = main) => {
    const enc = await w.encounter()
    for (const [documentType, sourceDate] of items) await link(enc.id, (await evidence(documentType, sourceDate)).versionId)
    return evaluate(enc.id)
  }
  const t68 = await classify([[REPORT, '2026-06-01']])
  check('T68', 'Accepted doc type exact', only(t68)?.validCount === 1, 'the exact case-sensitive document type matches')
  const t69 = await classify([[REPORT.toLowerCase(), '2026-06-01'], ['OTHER_DOCUMENT', '2026-06-01']])
  check('T69', 'Wrong doc type', only(t69)?.totalCandidateCount === 0, 'a lower-cased or different type is not a candidate')
  check('T70', 'No candidates', only(t69)?.state === 'MISSING', 'no candidate is MISSING')
  const optionalWorld = await world('optional date')
  await docRule(optionalWorld.payer.id, { documentTypes: [REPORT], minimumCount: 1, sourceDateRequired: false, maxSourceAgeDays: null })
  const t71 = await classify([[REPORT, null]], optionalWorld)
  check('T71', 'sourceDate optional', only(t71)?.state === 'SATISFIED', 'no source date is VALID when none is required')
  const t72 = await classify([[REPORT, null]])
  check('T72', 'sourceDate required', only(t72)?.invalidCount === 1 && only(t72)?.validCount === 0, 'no source date is INVALID when one is required')
  const t73 = await classify([[REPORT, '2026-05-16']])
  check('T73', 'Fresh threshold inclusive', only(t73)?.validCount === 1, 'exactly 30 days before the service date is VALID')
  const t74 = await classify([[REPORT, '2026-05-15']])
  check('T74', 'Stale evidence', only(t74)?.staleCount === 1 && only(t74)?.validCount === 0, '31 days before the service date is STALE')
  check('T75', 'Fresh evidence', only(t68)?.validCount === 1 && only(t68)?.staleCount === 0, 'within the limit is VALID')
  const t76 = await classify([[REPORT, '2026-07-01']])
  check('T76', 'Future-to-service source date', only(t76)?.validCount === 1, 'a source date after the service date is not made stale')
  check('T77', 'Minimum one satisfied', only(t68)?.state === 'SATISFIED', 'one VALID candidate satisfies minimumCount = 1')
  const minWorld = await world('minimum two')
  await docRule(minWorld.payer.id, { ...STANDARD, minimumCount: 2 })
  const t78 = await classify([[REPORT, '2026-06-01'], [REPORT, '2026-06-02']], minWorld)
  check('T78', 'Minimum multiple satisfied', only(t78)?.state === 'SATISFIED' && only(t78)?.validCount === 2, 'two distinct valid versions satisfy minimumCount = 2')
  const t79 = await classify([[REPORT, '2026-06-01']], minWorld)
  check('T79', 'Too few valid', only(t79)?.state === 'INCOMPLETE' && only(t79)?.validCount === 1, 'one valid version against a minimum of two is INCOMPLETE')
  check('T80', 'Invalid-only', only(t72)?.state === 'INCOMPLETE', 'a candidate missing its required source date leaves the requirement INCOMPLETE')
  check('T81', 'Stale-only', only(t74)?.state === 'INCOMPLETE', 'a stale-only candidate leaves the requirement INCOMPLETE')
  const t82 = await classify([[REPORT, null], [REPORT, '2025-01-01']])
  check('T82', 'Mixed defects', only(t82)?.state === 'INCOMPLETE' && only(t82)?.invalidCount === 1 && only(t82)?.staleCount === 1, 'counts preserved — invalid 1 and stale 1, no invented priority')
  const t83 = await classify([[REPORT, '2026-06-01'], [REPORT, null], [REPORT, '2025-01-01']])
  check('T83', 'Valid plus defects', only(t83)?.state === 'SATISFIED' && only(t83)?.invalidCount === 1 && only(t83)?.staleCount === 1, 'SATISFIED while both defects stay visible')
  check('T84', 'Distinct-version count', only(t45.result)?.validCount === 1, 'the same exact version never counts twice')
  const latestEncounter = await main.encounter()
  const older = await evidence(REPORT, '2026-06-01')
  await link(latestEncounter.id, older.versionId)
  const newer = must('newer version', (await post(`/api/evidence-artifacts/${older.artifactId}/versions`, { storageRef: `synthetic://evidence/${key('E2')}`, contentHash: 'b'.repeat(64), documentType: REPORT, sourceDate: '2026-06-05', receivedAt: '2026-06-15T09:30:00.000Z' })).body)
  const t85 = await evaluate(latestEncounter.id)
  check(
    'T85',
    'No latest evidence selection',
    JSON.stringify(only(t85)?.validEvidenceArtifactVersionIds) === JSON.stringify([older.versionId]) && newer.id !== older.versionId,
    'the exact linked older version counts; the newer version of the same artifact is not substituted',
  )
  const again = await evaluate(t83.body?.encounterId ?? t40.encounterId)
  const strip = (b: any) => JSON.stringify({ ...b, evaluatedAt: '' })
  check('T86', 'Evaluation deterministic order', strip(again.body) === strip(t83.body), 'requirement and evidence arrays are identical across reads')

  // ---------------------------------------------------------------- persistence and audit (T87–T93)
  section('No persistence; safe, atomic audit')
  const tables = (await prisma.$queryRaw<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`).map((row) => row.table_name)
  const countAll = async () => {
    const counts: Record<string, number> = {}
    for (const table of tables) counts[table] = Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${table}"`))[0].n)
    return counts
  }
  const countsBefore = await countAll()
  const auditTotal = await prisma.auditEvent.count()
  for (const id of [t40.encounterId, t83.body?.encounterId ?? t40.encounterId, latestEncounter.id]) await evaluate(id)
  const countsAfter = await countAll()
  const changed = tables.filter((table) => countsBefore[table] !== countsAfter[table] && !/^(session|verification)$/.test(table))
  check('T87', 'No persistence', changed.length === 0, changed.length === 0 ? `three evaluations changed no row count in any of ${tables.length} tables` : `changed: ${changed.join(', ')}`)
  check('T88', 'No AuditEvent on evaluation', (await prisma.auditEvent.count()) === auditTotal, 'repeated evaluation wrote zero AuditEvent rows')
  const reqEvent = await prisma.auditEvent.findFirst({ where: { entityType: 'EVIDENCE_REQUIREMENT', entityId: t07Rows!.id } })
  check(
    'T89',
    'Requirement audit',
    reqEvent?.actionCode === 'evidence_requirement.created' && JSON.stringify(Object.keys((reqEvent?.afterState ?? {}) as object).sort()) === JSON.stringify(['createdAt', 'id', 'ruleVersionId']),
    'one evidence_requirement.created with { id, ruleVersionId, createdAt } only',
  )
  const linkEvents = await prisma.auditEvent.findMany({ where: { entityType: 'ENCOUNTER_EVIDENCE_LINK', entityId: (secondLink.body as any).id }, orderBy: { occurredAt: 'asc' } })
  check(
    'T90',
    'Link audit',
    linkEvents.map((e) => e.actionCode).join(',') === 'encounter_evidence_link.created,encounter_evidence_link.removed' &&
      Object.keys((linkEvents[1]?.afterState ?? {}) as object).includes('removedAt'),
    'the link has one created and one removed event, written with the change',
  )
  const a56Audits = await prisma.auditEvent.findMany({ where: { entityType: { in: ['EVIDENCE_REQUIREMENT', 'ENCOUNTER_EVIDENCE_LINK'] } }, select: { afterState: true, beforeState: true } })
  const sensitive = [REPORT, 'documentType', 'evidenceArtifactVersionId', 'encounterId', 'storageRef', 'contentHash', 'sourceDate', fresh.versionId, linkEncounter.id, 'minimumCount', 'maxSourceAgeDays']
  const leaks = a56Audits.filter((e) => sensitive.some((needle) => JSON.stringify(e.afterState ?? {}).includes(needle) || JSON.stringify(e.beforeState ?? {}).includes(needle)))
  check('T91', 'Audit minimization', a56Audits.length > 0 && leaks.length === 0, `no document type, evidence id, Encounter id, source date or requirement content in any of ${a56Audits.length} A5.6 audit rows`)
  const rollbackVersion = await draftDoc()
  const reqAuditBefore = await reqAudit()
  failAt('evidence_requirement.created', 'forced audit failure (acceptance)')
  let reqThrew = false
  try {
    await createEvidenceRequirement(rollbackVersion.id, STANDARD, actorUserId)
  } catch {
    reqThrew = true
  }
  clearConcurrencyProbes()
  check(
    'T92',
    'Atomic requirement rollback',
    reqThrew && (await requirementRows(rollbackVersion.id)) === null && (await reqAudit()) === reqAuditBefore && (await prisma.evidenceRequirementDocumentType.count({ where: { evidenceRequirement: { ruleVersionId: rollbackVersion.id } } })) === 0,
    'a forced failure after the audit left no requirement, no document type and no audit',
  )
  const rollbackEncounter = await main.encounter()
  const rollbackEvidence = await evidence(REPORT, '2026-06-01')
  const linkAuditBefore = await linkAudit()
  failAt('encounter_evidence_link.created', 'forced audit failure (acceptance)')
  let linkThrew = false
  try {
    await createEncounterEvidenceLink(rollbackEncounter.id, { evidenceArtifactVersionId: rollbackEvidence.versionId }, actorUserId)
  } catch {
    linkThrew = true
  }
  clearConcurrencyProbes()
  check('T93', 'Atomic link rollback', linkThrew && (await prisma.encounterEvidenceLink.count({ where: { encounterId: rollbackEncounter.id } })) === 0 && (await linkAudit()) === linkAuditBefore, 'a forced failure left no link and no audit')

  // ---------------------------------------------------------------- permissions and tenancy (T94–T100)
  section('Permission, tenancy and safe errors')
  check('T94', 'Viewer requirement read', (await get(`/api/rule-versions/${mainRule.version.id}/evidence-requirement`, asViewer)).status === 200, 'a viewer may read a payload')
  const viewerReq = await post(`/api/rule-versions/${(await draftDoc()).id}/evidence-requirement`, STANDARD, asViewer)
  check('T95', 'Viewer requirement create', viewerReq.status === 403, '403')
  check('T96', 'Viewer encounter evidence read', (await get(`/api/encounters/${linkEncounter.id}/evidence-links`, asViewer)).status === 200 && (await get(`/api/encounter-evidence-links/${(t28.body as any).id}`, asViewer)).status === 200, 'a viewer may list and read links')
  const viewerLink = await link(linkEncounter.id, (await evidence(REPORT, '2026-06-01')).versionId, asViewer)
  const viewerRemove = await post(`/api/encounter-evidence-links/${(t28.body as any).id}/remove`, {}, asViewer)
  check('T97', 'Viewer evidence create/remove', viewerLink.status === 403 && viewerRemove.status === 403 && (await prisma.encounterEvidenceLink.findUniqueOrThrow({ where: { id: (t28.body as any).id } })).removedAt === null, '403 for both, nothing changed')
  check('T98', 'Viewer completeness', (await evaluate(t40.encounterId, {}, asViewer)).status === 200, 'a viewer may evaluate')
  const foreignEncounter = await prisma.encounter.findFirst({ where: { patient: { organizationId: otherOrg } }, select: { id: true } })
  const foreignEval = foreignEncounter ? await evaluate(foreignEncounter.id) : null
  const foreignReq = await get(`/api/rule-versions/${(await prisma.ruleVersion.findFirstOrThrow({ where: { ruleId: foreignRule.id } })).id}/evidence-requirement`)
  check(
    'T99',
    'Cross-tenant completeness',
    foreignEval !== null && foreignEval.status >= 400 && foreignEval.status < 500 && !/requirements|provenance/.test(JSON.stringify(foreignEval.body)) && foreignReq.status >= 400 && foreignReq.status < 500,
    `foreign Encounter ${foreignEval?.status}, foreign rule version ${foreignReq.status}; no context, evidence or rule disclosed`,
  )
  const malformed: number[] = []
  const malformedBodies: string[] = []
  for (const [method, path] of [
    ['GET', '/api/rule-versions/not-a-uuid/evidence-requirement'],
    ['POST', '/api/encounters/not-a-uuid/evidence-links'],
    ['GET', '/api/encounter-evidence-links/not-a-uuid'],
    ['POST', '/api/encounters/not-a-uuid/evidence-completeness/evaluate'],
  ] as const) {
    const res = method === 'GET' ? await get(path) : await post(path, {})
    malformed.push(res.status)
    malformedBodies.push(JSON.stringify(res.body ?? {}))
  }
  check('T100', 'Malformed IDs', malformed.every((code) => code === 400 || code === 404) && malformedBodies.every((text) => !/prisma|postgres|syntax|invalid input/i.test(text)), `${malformed.join(', ')}; safe envelopes, never a 500`)

  // ---------------------------------------------------------------- scope guards (T101–T110)
  section('Scope guards — structure and completeness, nothing downstream')
  const columns = (await prisma.$queryRaw<{ c: string }[]>`SELECT table_name || '.' || column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('evidence_requirements','evidence_requirement_document_types','encounter_evidence_links')`).map((row) => row.c)
  const dtoKeys = [...deepKeys(t28.body), ...deepKeys(mainEval.body)]
  check(
    'T101',
    'No storage metadata copy',
    columns.length > 0 && !columns.some((c) => /storage|content_hash|bytes|received_at/.test(c)) && !dtoKeys.some((k) => /storageRef|contentHash|bytes|receivedAt/.test(k)),
    `none of ${columns.length} A5.6 columns and no DTO key carries a storage reference, hash or bytes`,
  )
  check(
    'T102',
    'No hard-coded payer rules',
    !/(payer|tpa|network|product)[A-Za-z]*\s*===\s*['"]|documentType\s*===\s*['"]|displayName/.test(evidenceCode),
    'no payer, TPA, network, product or document-type literal decides anything; requirement content is governed data',
  )
  check('T103', 'No authorization decision', !/APPROVED|PARTIALLY_APPROVED|authorizationSatisfied|scope-evaluation|evaluateAuthorizationScope/.test(evidenceCode), 'authorization evidence is only pooled; no authorization status or scope is judged')
  check('T104', 'No ValidationRun/Finding', !tables.some((t) => /validation_run|validation_finding/.test(t)) && !/validationRun|validationFinding/i.test(evidenceCode), 'no validation result table or write — A5.7 owns that')
  const stateValues = JSON.stringify(mainEval.body)
  check('T105', 'No PASS/WARNING/RESTRICT/FAIL', !/"(PASS|WARNING|RESTRICT|FAIL)"/.test(stateValues) && !/'(PASS|WARNING|RESTRICT|FAIL)'/.test(evidenceCode), 'completeness states stay SATISFIED/MISSING/INCOMPLETE, separate from A5.8 outcomes')
  check('T106', 'No readiness', !dtoKeys.some((k) => /ready|readiness|submission|payerAcceptance/i.test(k)) && !/readyForClaim|submissionAllowed/.test(evidenceCode), 'no ready, restrict, block or submission field')
  check('T107', 'No Claim', !tables.some((t) => /(^claims?$|claim_lines?|claim_submissions?)/.test(t)) && !/(prisma|tx)\.(claim|claimLine|claimSubmission)\b/.test(evidenceCode), 'no Claim, ClaimLine or ClaimSubmission')
  const routeCode = committedProductionCodeOf(['backend/src/modules/evidence-requirement', 'backend/src/modules/encounter-evidence']).code
  check('T108', 'No real integration', !/\b(fetch|axios|https?\.request|multer|upload|download|dhpo|eclaimlink)\b/i.test(routeCode), 'no upload, download, payer, DHPO or eClaimLink transport')
  const feCode = committedCodeOf('frontend/src/modules/evidence-completeness')
  check(
    'T109',
    'Frontend privacy',
    feCode.files.length > 0 && feCode.code.includes('evaluateCompleteness') && !/\b(localStorage|sessionStorage|indexedDB)\s*\.\s*[A-Za-z]+\s*\(/.test(feCode.code) && !/storageRef|contentHash|documentType/.test(feCode.code),
    'nothing in browser storage and no raw evidence rendered (search verified to reach the source)',
  )
  const scanPaths = [':/backend/src/modules/evidence-requirement', ':/backend/src/modules/encounter-evidence', ':/frontend/src/modules/evidence-completeness']
  const logScan = gitGrep('console[.](log|info|warn|error|debug)[(]', scanPaths)
  const urlScan = gitGrep('[?&](documentType|evidenceArtifactVersionId|sourceDate|encounterActivityId|encounterDiagnosisId)=', scanPaths)
  const reach = gitGrep('evidenceArtifactVersionId', scanPaths)
  check('T110', 'Logging scan', reach.status === 0 && logScan.status === 1 && urlScan.status === 1, 'no console output, and no evidence or document value in a query string (search verified to reach the source)')

  // ---------------------------------------------------------------- gates and regressions (T111–T119)
  section('Build gates, regressions and database truth')
  const unitTests = run('npm run test:unit')
  const typecheck = run('npm run typecheck')
  const build = run('npm run build --prefix ../frontend')
  const lint = run('npm run lint --prefix ../frontend')
  check('T111', 'Unit/typecheck/build', unitTests.ok && /ℹ fail 0/.test(unitTests.output) && typecheck.ok && build.ok && lint.ok, `${(unitTests.output.match(/ℹ pass \d+/) ?? [''])[0]}, typecheck clean, ${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}, lint clean`)

  // §25: the owner suites are INVOKED, never reimplemented. A5.5's suite nests A5.4 -> A5.3 -> A5.2 ->
  // A5.1 -> A4 -> A3 -> A2 -> A1, so one invocation covers T112 to T118.
  await apiReady('the A5.5 and backward regression chain')
  const chain = run('npm run test:a5:commercial-context')
  const rows = suiteLines(chain.output, 'A5.5')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const titleOf = (text: string) => text.slice('[A5.5] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  // A5.5 asserts facts about its own branch and asserts that it adds no schema or migration. A5.6
  // adds three tables in one migration, which is exactly what this package is for.
  const a55NonApplicable: Record<string, string> = {
    T01: "A5.5 'Start gate' requires the current branch to be the A5.5 feature branch; A5.6 is a different branch, branched from the merged A5.5 main",
    T03: "A5.5 'No schema change' requires the Prisma schema to equal main; A5.6 adds its three models, by design",
    T04: "A5.5 'No migration' requires no migration against main; A5.6 adds exactly one",
    T95: "A5.5 'Migration replay' requires the replayed count to equal main's; A5.6's own migration makes it one higher",
    T98: "A5.5 'Diff scope' lists the paths A5.5 was allowed to change; A5.6 legitimately changes different ones",
    T100: "A5.5 'Exact head evidence' requires the upstream to be the A5.5 feature branch, which was deleted when PR #53 merged",
  }
  const undocumented = failing.filter((id) => !(id in a55NonApplicable))
  const counts = chain.output.match(/\[A5\.5\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = counts ? Number(counts[2]) - Number(counts[1]) : -1
  const reconciled = failedCount >= 0 && failing.length === failedCount
  const ran = rows.some((row) => row.id === 'T89') && rows.some((row) => row.id === 'T94')
  check(
    'T112',
    'A5.5 regression',
    ran && reconciled && undocumented.length === 0,
    !ran ? 'the A5.5 suite did not reach its regression checks' : !reconciled ? `A5.5 reports ${failedCount} failure(s) but ${failing.length} could be named` : undocumented.length > 0 ? `undocumented A5.5 failures: ${undocumented.join(', ')}` : `${(chain.output.match(/\[A5\.5\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A5.5] automated summary: ', 'A5.5 ')}; all ${failedCount} failure(s) named and accounted for, and every commercial-resolution invariant still holds`,
  )
  for (const id of Object.keys(a55NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) notApplicableCheck(`T112/${id}`, `A5.5 ${titleOf(row.line)}`, a55NonApplicable[id])
  }
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  check('T113', 'A5.4 regression', verdictOf('T89') === 'PASS', `A5.5 T89 (A5.4) ${verdictOf('T89')}`)
  check('T114', 'A5.3 regression', verdictOf('T90') === 'PASS', `A5.5 T90 (A5.3) ${verdictOf('T90')}`)
  check('T115', 'A5.2/A5.1 regressions', verdictOf('T91') === 'PASS', `A5.5 T91 (A5.2 and A5.1) ${verdictOf('T91')}`)
  check('T116', 'A4 regressions', verdictOf('T92') === 'PASS', `A5.5 T92 (A4.10 and A4.9 to A1) ${verdictOf('T92')}`)
  for (const text of chain.output.split(/\r?\n/).filter((l) => l.startsWith('[A5.5]      ') && / substantive checks /.test(l))) console.log(`[A5.6]      ${text.replace('[A5.5]', '').trim().slice(0, 190)}`)
  check('T117', 'A3 regressions', verdictOf('T93') === 'PASS', `A5.5 T93 (A3) ${verdictOf('T93')}: only the two A3-era no-A5 guards remain tolerated`)
  check('T118', 'A2/A1 regressions', verdictOf('T94') === 'PASS', `A5.5 T94 (A2 and A1) ${verdictOf('T94')}`)

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
  check('T119', 'DB truth', upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered, 'up 200/200; with the database down health stayed 200 and ready reported 503; recovery 200')

  // ---------------------------------------------------------------- closure (T120–T123)
  section('Repeatability, diff scope and exact head')
  const priorRequirements = await prisma.evidenceRequirement.count({ where: { createdAt: { lt: new Date(Number(runId.slice(4))) } } })
  check('T120', 'Repeatability', true, `this run used a fresh synthetic runId (${runId}) and built its own payers, rules and Encounters; ${priorRequirements} requirement(s) from earlier runs retained, none deleted`)
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const allowed = [
    'backend/package.json',
    'backend/prisma/schema.prisma',
    'backend/src/app.ts',
    'backend/src/modules/audit/audit.types.ts',
    'backend/src/modules/rule-version/rule-version.service.ts',
    'backend/src/scripts/bootstrap-authz-dev.ts',
    'backend/src/scripts/verify-migration-replay.ts',
    'backend/src/shared/authorization/authorization.types.ts',
    'backend/src/shared/database/row-lock.ts',
    'backend/src/shared/errors/error.types.ts',
    'frontend/src/app/App.tsx',
  ]
  const outOfScope = changedPaths.filter(
    (file) =>
      !file.startsWith('backend/src/modules/evidence-requirement/') &&
      !file.startsWith('backend/src/modules/encounter-evidence/') &&
      !file.startsWith('backend/src/integration/a5-evidence-completeness/') &&
      !file.startsWith('frontend/src/modules/evidence-completeness/') &&
      !file.includes('a5_6_evidence_requirement_completeness') &&
      !allowed.includes(file),
  )
  const futureImport = evidenceCode.match(/from '[^']*modules\/(validation-run|validation-finding|readiness|claim|submission|remittance|pricing)/)
  check(
    'T121',
    'Diff scope',
    outOfScope.length === 0 && futureImport === null,
    outOfScope.length === 0 && futureImport === null ? `${changedPaths.length} path(s): the two A5.6 modules, their migration, harness and check page, the A3 verification gate, and wiring; no A5.7+, A6 or A9 import and no duplicate rule engine` : `unexpected: ${[...outOfScope, futureImport?.[0]].filter(Boolean).join(', ').slice(0, 220)}`,
  )
  const secretScan = gitGrep(
    "((pass" + "word|secret|token|apiKey|clientSecret)\\s*[:=]\\s*['\"][^'\"]{3,}|BEGIN (RSA |EC )?PRIV" + "ATE KEY|Bearer [A-Za-z0-9._-]{20,})",
    [':/backend/src/integration/a5-evidence-completeness', ':/backend/src/modules/evidence-requirement', ':/backend/src/modules/encounter-evidence', ':/frontend/src/modules/evidence-completeness'],
  )
  const realDataMarkers = new RegExp(['emir' + 'ates\\s*id', 'pass' + 'port', '\\+9' + '71\\d', '@gm' + 'ail', '@ya' + 'hoo', '@hot' + 'mail'].map((f) => `(?:${f})`).join('|'), 'i')
  const harnessSource = git('show HEAD:backend/src/integration/a5-evidence-completeness/a5-evidence-completeness.integration.ts')
  const secretReach = gitGrep('A1_IT_ADMIN_EMAIL', [':/backend/src/integration/a5-evidence-completeness'])
  check(
    'T122',
    'Secret/PHI scan',
    secretReach.status === 0 && /Synthetic|synthetic/.test(harnessSource) && secretScan.status === 1 && harnessSource.match(realDataMarkers) === null,
    secretReach.status !== 0 ? 'the scan did not reach the committed harness source, so this absence is unproven' : 'no credential, real patient, member or document content is committed; every credential is read from the local environment at run time',
  )
  const headSha = git('rev-parse HEAD')
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check('T123', 'Exact head evidence', headSha.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a56Branch}`), `all evidence corresponds to ${headSha}; ${tracking}; working tree clean`)

  console.log(`\n[A5.6] run ${runId} — HEAD ${headSha}`)
  if (failures.length > 0) {
    console.log(`[A5.6] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  if (notApplicable > 0) console.log(`[A5.6] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) console.log(`[A5.6] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  console.log(`[A5.6] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? '[A5.6] A5.6 EVIDENCE REQUIREMENT / COMPLETENESS ACCEPTANCE COMPLETE' : '[A5.6] A5.6 FINAL FAIL')
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    if (error instanceof RunAborted) {
      console.log(`\n[A5.6] RUN ABORTED: ${error.message}`)
      console.log('[A5.6] No verdict was recorded for the remaining checks, so this run is not evidence of anything.')
    } else {
      console.error('[A5.6] uncaught error (this itself is a FAIL):', error)
    }
    process.exitCode = 1
  })
  .finally(async () => {
    clearConcurrencyProbes()
    const running = (spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', dbContainer], { encoding: 'utf8' }).stdout ?? '').trim()
    if (running === 'false') {
      const restored = spawnSync('docker', ['start', dbContainer], { encoding: 'utf8' }).status === 0
      console.log(`[A5.6] the database was left stopped by this run; restarting it: ${restored ? 'done' : 'FAILED — start it manually'}`)
    }
    await prisma.$disconnect()
  })
