import 'dotenv/config'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { prisma } from '../shared/database/prisma.ts'
import { createChecker } from './support/a3-8-fixtures.ts'

// A3.9 scope guard (T52–T56, T59–T61 and the step 21 diff review). A3.8 RESOLVES; A3.9 only
// packages and composes provenance. This proves, from the source tree and the live database, that
// A3.9 added no second public surface, no second resolver/context algorithm, no decision table and
// no copied regression harness. Each detector is first shown to fire on a planted violation, so a
// PASS means "absent", not "the grep could not see it".

const { check, section, finish } = createChecker('a3.9-scope')

const backend = resolve(import.meta.dirname, '..', '..')
const repo = resolve(backend, '..')
const src = join(backend, 'src')
const frontendSrc = join(repo, 'frontend', 'src')

function walk(dir: string, filter: (path: string) => boolean): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walk(path, filter))
    else if (filter(path)) out.push(path)
  }
  return out
}

// Comments explain what A3.9 deliberately does NOT do, so detectors look at code only.
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

const code = (path: string) => stripComments(readFileSync(path, 'utf8'))
const rel = (path: string) => relative(repo, path).replaceAll('\\', '/')
const isTs = (path: string) => /\.(ts|tsx)$/.test(path)
const notTest = (path: string) => !/\.test\.tsx?$/.test(path)

const backendFiles = walk(src, (path) => isTs(path) && notTest(path) && !path.includes(`${join('src', 'scripts')}`))
const frontendFiles = walk(frontendSrc, isTs)
const a39Modules = [join(src, 'modules', 'rule-pack'), join(src, 'modules', 'rule-provenance')]
const a39Files = a39Modules.flatMap((dir) => walk(dir, (path) => isTs(path) && notTest(path)))
const composerFiles = walk(join(src, 'modules', 'rule-provenance'), (path) => isTs(path) && notTest(path))

// ---- detectors ------------------------------------------------------------------------------
const provenanceRoute = /['"`][^'"`]*\/provenance[^'"`]*['"`]|rule-provenance\.route|ruleProvenanceRouter/i
const provenancePermission = /rule_provenance\.|['"`]rule_provenance['"`]/
// T54 judges what the frontend DOES with provenance, never whether the word appears. A later
// workspace may render the read-only ruleProvenance that an authorized A5.8 ValidationFinding DTO
// carries; it may not call a provenance route, write provenance, compose or infer it, or keep it.
const provenanceComponent = /(function|const|class)\s+\w*RuleProvenance\w*|<\w*RuleProvenance\w*/
const provenanceRouteCall = /['"`][^'"`\n]*\/provenance\b/
const writeRequest = /method:\s*['"`](POST|PUT|PATCH|DELETE)['"`]/
const mentionsProvenance = /provenance/i
// Calling the public A3.8 resolution endpoint (the A3.8 developer check does) is not composition;
// building a provenance record, copying the backend precedence logic or minting the contract label is.
const provenanceComposition =
  /\b(compose|infer|derive|build|reconstruct|resolve)\w*Provenance\b|composeRuleDecisionProvenance|resolveSupersedesDominance|rule-provenance|rule-resolution\.(service|precedence|currentness)|['"`]A3-PROV-1['"`]/
const browserStorage = /\b(localStorage|sessionStorage|indexedDB)\b/
// Read-only rendering: provenance is read from a ValidationFinding DTO, or declared on its type.
const readOnlyProvenance = /\bfinding\.(ruleProvenance|provenance)\b|^\s*(ruleProvenance|provenance):/m
// A3.8/A3.7/A3.6 decision logic and the facility-profile resolver — A3.9 must not import or copy them.
const forbiddenImports = /from\s+['"][^'"]*(rule-resolution\.(service|precedence|currentness|validation)|rule-source-binding\.(compatibility|candidate)|rule-applicability\.matcher|rule-source-scope\.matcher|facility-regulatory|commercial-context)[^'"]*['"]/
const forbiddenLogic = /resolveSupersedesDominance|specificityScore\s*[+=]|computeSpecificity|evaluateBindingExecutability|matchApplicability|resolveFacilityRegulatoryProfile|facilityRegulatoryProfile\.find|isEffectiveOn\(/
const decisionModel = /^model\s+\w*Decision\w*\s*\{/m
const billingExecution = /\b(claim|reimburs\w*|adjudicat\w*|priorAuth\w*|preAuth\w*|eligibilityCheck|priceAmount|tariffRate|copay\w*)\b/i
const hardCodedPolicy = /['"`]A3-PREC-\d+['"`]/
// The shared A1 HTTP harness (integration.http.ts) exports exactly these; re-defining one is a copy.
const copiedHarness = /^\s*(export\s+)?(async\s+)?function\s+(callApi|extractCookieHeader|isUuid)\b/m

section('detectors fire on planted violations (sensitivity)')
check('route detector catches a planted /provenance/evaluate', provenanceRoute.test(`router.post('/provenance/evaluate', h)`))
check('permission detector catches a planted rule_provenance.read', provenancePermission.test(`'rule_provenance.read'`))
check('UI detector catches a planted RuleProvenanceCheck', provenanceComponent.test('export function RuleProvenanceCheck() {}'))
check('route-call detector catches a planted provenance request', provenanceRouteCall.test('fetch(`/api/validation-findings/${id}/provenance`)'))
check('write detector catches a planted provenance PATCH', writeRequest.test(`fetch(url, { method: 'PATCH', body: JSON.stringify({ ruleProvenance }) })`))
check('composition detector catches a planted composeProvenance and an A3-PROV-1 literal', provenanceComposition.test('const p = composeProvenance(result)') && provenanceComposition.test(`const v = 'A3-PROV-1'`))
check('storage detector catches a planted localStorage write', browserStorage.test(`localStorage.setItem('p', JSON.stringify(finding.ruleProvenance))`))
check(
  'read-only rendering of finding.ruleProvenance trips none of the T54 detectors',
  [provenanceComponent, provenanceRouteCall, writeRequest, provenanceComposition, browserStorage].every((detector) => !detector.test('const basis = finding.ruleProvenance; return <dd>{basis.businessDate}</dd>')) &&
    readOnlyProvenance.test('const basis = finding.ruleProvenance'),
)
check('import detector catches a planted precedence import', forbiddenImports.test(`import { x } from '../rule-resolution/rule-resolution.precedence.ts'`))
check('import detector catches a planted facility-regulatory import', forbiddenImports.test(`import { x } from '../facility-regulatory/facility-regulatory.repository.ts'`))
check('logic detector catches a planted SUPERSEDES dominance call', forbiddenLogic.test('resolveSupersedesDominance(candidates)'))
check('decision detector catches a planted RuleDecision model', decisionModel.test('model RuleDecision {\n  id String\n}'))
check('billing detector catches a planted claim field', billingExecution.test('const claim = {}'))
check('policy detector catches a planted hard-coded A3-PREC-1', hardCodedPolicy.test(`precedencePolicyVersion: 'A3-PREC-1'`))
check('harness detector catches a copied callApi', copiedHarness.test('async function callApi(path) {}'))
check('comment stripping keeps code and drops comments', stripComments(`a // SUPERSEDES\nb /* claim */ c`).trim() === 'a \nb  c')

section('T52 no provenance route')
{
  const hits = backendFiles.filter((path) => provenanceRoute.test(code(path)))
  check('no backend source declares a /provenance route or provenance router', hits.length === 0, hits.map(rel).join(', '))
  check('no rule-provenance.route.ts file exists', !existsSync(join(src, 'modules', 'rule-provenance', 'rule-provenance.route.ts')))
  const app = code(join(src, 'app.ts'))
  check('app.ts mounts the rule-pack routers and nothing for provenance', /rulePackRouter/.test(app) && !/provenance/i.test(app))
}

section('T53 no provenance permission')
{
  const hits = backendFiles.filter((path) => provenancePermission.test(code(path)))
  check('no backend source defines rule_provenance.*', hits.length === 0, hits.map(rel).join(', '))
  const rows = await prisma.permission.findMany({ where: { OR: [{ code: { contains: 'provenance' } }, { code: { startsWith: 'rule_pack' } }] }, orderBy: { code: 'asc' } })
  const codes = rows.map((row) => row.code)
  check('the database holds no provenance permission', !codes.some((c) => c.includes('provenance')), codes.join(', '))
  check('the only new permissions are rule_pack.read and rule_pack.write', JSON.stringify(codes) === JSON.stringify(['rule_pack.read', 'rule_pack.write']), codes.join(', '))
}

section('T54 no provenance UI — frontend behaviour, not vocabulary')
{
  check('no frontend/src/modules/rule-provenance directory', !existsSync(join(frontendSrc, 'modules', 'rule-provenance')))
  const components = frontendFiles.filter((path) => provenanceComponent.test(code(path)))
  check('no frontend RuleProvenance component', components.length === 0, components.map(rel).join(', '))
  const routeCalls = frontendFiles.filter((path) => provenanceRouteCall.test(code(path)))
  check('no frontend source calls a provenance route', routeCalls.length === 0, routeCalls.map(rel).join(', '))
  const provenanceFiles = frontendFiles.filter((path) => mentionsProvenance.test(code(path)))
  const writers = provenanceFiles.filter((path) => writeRequest.test(code(path)))
  check('no frontend provenance create/update/delete', writers.length === 0, writers.map(rel).join(', '))
  const composers = frontendFiles.filter((path) => provenanceComposition.test(code(path)))
  check('no frontend provenance composition or inference', composers.length === 0, composers.map(rel).join(', '))
  const stored = provenanceFiles.filter((path) => browserStorage.test(code(path)))
  check('no frontend source keeps provenance in browser storage', stored.length === 0, stored.map(rel).join(', '))
  const renderers = provenanceFiles.filter((path) => /ruleProvenance/.test(code(path)))
  check(
    'any frontend provenance is read-only rendering of a ValidationFinding DTO',
    renderers.every((path) => readOnlyProvenance.test(code(path))),
    renderers.length === 0 ? 'no frontend source renders provenance' : `read-only: ${renderers.map(rel).join(', ')}`,
  )
  check('the minimal RulePack developer check exists', existsSync(join(frontendSrc, 'modules', 'rule-pack', 'RulePackCheck.tsx')) && existsSync(join(frontendSrc, 'modules', 'rule-pack', 'rule-pack.api.ts')))
}

section('T54 A3-PROV-1 stays backend-internal — one persistence, no public surface')
{
  const routeFiles = backendFiles.filter((path) => path.endsWith('.route.ts'))
  const exposing = routeFiles.filter((path) => /rule-provenance|composeRuleDecisionProvenance/.test(code(path)))
  check('no backend route imports or exposes the A3-PROV-1 composer', exposing.length === 0, exposing.map(rel).join(', '))
  const schema = readFileSync(join(backend, 'prisma', 'schema.prisma'), 'utf8')
  const provenanceModels = [...schema.matchAll(/^model\s+(\w*Provenance\w*)\s*\{/gm)].map((m) => m[1]).sort()
  check('provenance is persisted by exactly one model', JSON.stringify(provenanceModels) === JSON.stringify(['ValidationFindingRuleProvenance']), provenanceModels.join(', '))
  const provenanceColumns = await prisma.$queryRaw<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND (column_name ILIKE '%provenance%' OR table_name ILIKE '%provenance%')`
  const elsewhere = provenanceColumns.filter((row) => row.table_name !== 'validation_finding_rule_provenances')
  check(
    'no table other than validation_finding_rule_provenances stores provenance',
    provenanceColumns.length > 0 && elsewhere.length === 0,
    provenanceColumns.length === 0 ? 'the column catalog did not reach the provenance table, so this absence is unproven' : elsewhere.map((row) => `${row.table_name}.${row.column_name}`).join(', '),
  )
}

section('T55 no second resolution logic / T56 no second context algorithm')
{
  const importHits = a39Files.filter((path) => forbiddenImports.test(code(path)))
  check('rule-pack and rule-provenance import no resolver, precedence, gate, matcher or facility-profile module', importHits.length === 0, importHits.map(rel).join(', '))
  const logicHits = a39Files.filter((path) => forbiddenLogic.test(code(path)))
  check('no specificity / SUPERSEDES / compatibility / matcher / profile-resolution logic in A3.9', logicHits.length === 0, logicHits.map(rel).join(', '))
  const composer = code(join(src, 'modules', 'rule-provenance', 'rule-provenance.composer.ts'))
  check('the composer takes the A3.8 result as input and never calls evaluateRuleResolution', !/evaluateRuleResolution/.test(composer))
  check('the context comes from the shared 12-dimension helper', /APPLICABILITY_DIMENSIONS_V2/.test(code(join(src, 'modules', 'rule-provenance', 'rule-provenance.validation.ts'))))
  const policyHits = composerFiles.filter((path) => hardCodedPolicy.test(code(path)))
  check('precedencePolicyVersion is not hard-coded anywhere in the composer', policyHits.length === 0, policyHits.map(rel).join(', '))
  const types = code(join(src, 'modules', 'rule-provenance', 'rule-provenance.types.ts'))
  check('A3-PROV-1 types precedencePolicyVersion as string', /precedencePolicyVersion:\s*string/.test(types))
}

section('T59 no RuleDecision / T60 no billing execution')
{
  const schema = readFileSync(join(backend, 'prisma', 'schema.prisma'), 'utf8')
  check('schema.prisma has no *Decision* model', !decisionModel.test(schema))
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND (table_name ILIKE '%decision%' OR table_name ILIKE '%claim%' OR table_name ILIKE '%eligib%' OR table_name ILIKE '%reimburs%' OR table_name ILIKE '%workflow%')`
  check('the database has no decision / claim / eligibility / reimbursement / workflow table', tables.length === 0, tables.map((t) => t.table_name).join(', '))
  const migrationDir = walk(join(backend, 'prisma', 'migrations'), (path) => path.includes('a3_9_rule_pack_provenance') && path.endsWith('.sql'))
  check('the A3.9 migration exists', migrationDir.length === 1)
  const sql = readFileSync(migrationDir[0], 'utf8').replace(/--.*$/gm, '')
  const created = [...sql.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1]).sort()
  check('the A3.9 migration creates exactly rule_packs, rule_pack_versions, rule_pack_members', JSON.stringify(created) === JSON.stringify(['rule_pack_members', 'rule_pack_versions', 'rule_packs']), created.join(', '))
  check('SQL comment stripping works (a DROP mentioned in a comment is not a DROP)', !/DROP/.test('-- the two spurious DROP INDEX statements'.replace(/--.*$/gm, '')))
  check('the A3.9 migration drops nothing and rewrites no earlier table', !/DROP (TABLE|COLUMN|INDEX)|ALTER TABLE "(?!rule_pack)/.test(sql))
  const memberCols = await prisma.$queryRaw<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'rule_pack_members' ORDER BY column_name`
  check('RulePackMember copies no applicability/context — only its keys and createdAt', JSON.stringify(memberCols.map((c) => c.column_name)) === JSON.stringify(['created_at', 'id', 'rule_pack_version_id', 'rule_version_id']), memberCols.map((c) => c.column_name).join(', '))
  const execHits = a39Files.filter((path) => billingExecution.test(code(path)))
  check('no claim / reimbursement / adjudication / authorization / price result in A3.9 code', execHits.length === 0, execHits.map(rel).join(', '))
}

section('T61 no copied regressions')
{
  const scripts = walk(join(src, 'scripts'), (path) => /test-a3-9-/.test(path))
  const copied = scripts.filter((path) => copiedHarness.test(code(path)))
  check('A3.9 scripts define no HTTP/login harness of their own', copied.length === 0, copied.map(rel).join(', '))
  check('the HTTP test reuses the shared A1 harness', /from '\.\.\/integration\/a1-foundation\/integration\.http\.ts'/.test(readFileSync(join(src, 'scripts', 'test-a3-9-rule-pack-http.ts'), 'utf8')))
  const pkg = JSON.parse(readFileSync(join(backend, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  const a39Scripts = Object.entries(pkg.scripts).filter(([, command]) => command.includes('test-a3-9-'))
  check('A3.9 registers only its own three scripts; earlier suites are invoked, not copied', a39Scripts.map(([name]) => name).sort().join(',') === 'test:a3:provenance,test:a3:rule-pack-http,test:a3:scope')
}

finish()
await prisma.$disconnect()
