import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { delimiter } from 'node:path'

// Acceptance for the harness-only correction of A5.10 T112 and the replay script's A7.2 table check
// (docs/Harness_Corrections.md, "A5.10 and A7.2 later-phase recognition"), made before CRG-01.
//
// A5.10 T112 judged every production file at HEAD for US vocabulary, and the replay check of the A7.2 tables judged
// every replayed table by a name pattern. On any later branch both judge the later package, not A5.10 or A7.2. This
// suite proves the exact changed-file scope, that no product code, migration, schema or accepted contract changed, that
// every A5.10 check still exists unchanged in id, title and N/A policy, that each changed predicate is the original on
// its package's own branch and still refuses what it refused, and then runs the full A8.3 → A1 chain once, requiring
// every substantive check to PASS and proving each branch-only failure for its own cause on this branch. Read-only; the
// nested suites write their own synthetic fixtures.

const TAG = 'HC57'
let passed = 0
let failed = 0
let notApplicable = 0
const failures: string[] = []

const say = (line: string) => console.log(line)

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
  const dots = '.'.repeat(Math.max(3, 50 - title.length))
  say(`[${TAG}] ${id} ${title} ${dots} N/A  - ${reason}`)
}

const section = (title: string) => say(`\n[${TAG}] ${title}`)
const progress = (text: string) => say(`[${TAG}]      ${text}`)

// Every `npm run` prepends its node_modules/.bin directories to PATH again, so each level of the nested chain makes
// PATH longer; a spawned command gets PATH without the .bin entries npm added on the way here.
const pathKey = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
const childEnv = () => ({
  ...process.env,
  [pathKey]: (process.env[pathKey] ?? '')
    .split(delimiter)
    .filter((entry) => !/[\\/]node_modules[\\/]\.bin[\\/]?$|[\\/]node-gyp-bin[\\/]?$/i.test(entry))
    .join(delimiter),
})

function run(command: string): { ok: boolean; output: string } {
  const out = spawnSync(command, { encoding: 'utf8', shell: true, cwd: process.cwd(), env: childEnv(), maxBuffer: 256 * 1024 * 1024 })
  return { ok: out.status === 0, output: `${out.stdout ?? ''}${out.stderr ?? ''}` }
}

const gitArgs = (args: string[]) => (spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout ?? '').replace(/\s+$/, '')
const git = (args: string) => gitArgs(args.split(' '))
const gitOk = (args: string) => spawnSync('git', args.split(' '), { encoding: 'utf8' }).status === 0
const textAt = (ref: string, path: string) => gitArgs(['show', `${ref}:${path}`])
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const sha256Of = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const lines = (text: string) => text.split(/\r?\n/)
// The same comment stripping the A5.10 suite applies before it judges production code.
const codeOf = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n')
const productionAt = (ref: string) => {
  const files = ['backend/src/modules', 'backend/src/shared']
    .flatMap((dir) => git(`ls-tree -r --name-only --full-tree ${ref} ${dir}`).split(/\r?\n/).filter(Boolean))
    .filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\.tsx?$/.test(file))
  return { files, code: files.map((file) => codeOf(textAt(ref, file))).join('\n') + codeOf(textAt(ref, 'backend/src/app.ts')) + codeOf(textAt(ref, 'backend/src/server.ts')) }
}

class RunAborted extends Error {}

type SuiteLine = { id: string; verdict: 'PASS' | 'FAIL' | 'N/A'; line: string }
function suiteLines(output: string, tag: string): SuiteLine[] {
  const prefix = `[${tag}] `
  const rows: SuiteLine[] = []
  for (const line of lines(output)) {
    if (!line.startsWith(prefix)) continue
    const rest = line.slice(prefix.length)
    const id = rest.split(' ')[0]
    if (!/^T\d+(\/T\d+)?$/.test(id)) continue
    const verdict = / \.{3,} PASS/.test(rest) ? 'PASS' : / \.{3,} FAIL/.test(rest) ? 'FAIL' : / \.{3,} N\/A /.test(rest) ? 'N/A' : null
    if (verdict) rows.push({ id, verdict, line })
  }
  return rows
}

const runId = `HC57-${Date.now()}`
const baseUrl = process.env.A1_IT_BASE_URL as string
const fixBranch = 'fix/a5-10-a7-2-harness-later-phase-recognition'
const a510Branch = 'feature/a5-10-a5-integration-acceptance'
const a83Branch = 'feature/a8-3-exception-investigation'
const a82Branch = 'feature/a8-2-exception-triage'
const a81Branch = 'feature/a8-1-exception-intake'
const a81FixBranch = 'fix/a8-1-harness-later-phase-recognition'
const a710Branch = 'feature/a7-10-a7-integration-acceptance'
const a79Branch = 'feature/a7-9-revenue-evidence-continuity'
const a78Branch = 'feature/a7-8-revenue-evidence-delta'
// The accepted latest main this branch starts from (A8.3 PR #101).
const A83_MERGE = 'a9f15806f4a178250b4aa263874a2b5c17ba827c'
const A510_HARNESS = 'backend/src/integration/a5-phase-closure/a5-phase-closure.integration.ts'
const REPLAY = 'backend/src/scripts/verify-migration-replay.ts'
const HARNESS = 'backend/src/integration/harness-corrections-a5-a7/harness-corrections-a5-a7.integration.ts'
const DOC = 'docs/Harness_Corrections.md'
const SCRIPT_NAME = 'test:harness-corrections:a5-a7'
const ALLOWED = [A510_HARNESS, REPLAY, DOC, HARNESS, 'backend/package.json']
const A72_MIGRATION = 'backend/prisma/migrations/20261022090000_a7_2_evidence_classification/migration.sql'
// A5.10 T112's word list, exactly as on main.
const US_RUNTIME = /\b(x12|clearinghouse|medicare|medicaid|hcpcs|npi)\b/i
const ORIGINAL_T112 = "check('T112', 'No US runtime', productionReached && !/\\b(x12|clearinghouse|medicare|medicaid|hcpcs|npi)\\b/i.test(production.code + appCode), 'no US payer, clearinghouse or X12 behaviour in production code')"

// The definitions the corrected T112 is built from. With ownMerge = '' (A5.10's own branch) each is literally the
// original value: the HEAD production code, the HEAD app code and the original reach condition.
const DEFINITIONS = [
  "const ownMerge = branch === a510Branch ? '' : git(`log origin/main --merges --grep=${a510Branch}$ -n 1 --format=%H`)",
  "const ownProduction = ownMerge ? committedProductionCodeAt(ownMerge, ['backend/src/modules', 'backend/src/shared']) : production",
  "const ownAppCode = ownMerge ? committedCodeAt(ownMerge, 'backend/src/app.ts') + committedCodeAt(ownMerge, 'backend/src/server.ts') : appCode",
  "const ownProductionReached = ownProduction.files.length > 150 && ownProduction.code.includes('requireOrganizationPermission')",
  'ownProductionReached && !/\\b(x12|clearinghouse|medicare|medicaid|hcpcs|npi)\\b/i.test(ownProduction.code + ownAppCode),',
]
// A changed line of the A5.10 suite is admissible only when it carries an own-scope name, is a comment, repeats a line
// the original already had, or is the T112 call itself; the only removed line is the original T112 call.
const OWN_TOKENS = /ownMerge|ownProduction|ownAppCode|committedCodeAt|committedProductionCodeAt|\$\{ref\}|^'T112',$|^'No US runtime',$|^const files = dirs$|^\.filter\(\(file\) => \/\\\.\(ts\|tsx\)\$\/\.test\(file\) && !\/\\\.test\\\.tsx\?\$\/\.test\(file\)\)$/
const REMOVED_TOKENS = /^check\('T112', 'No US runtime'/
// The replay script may change only its A7.2 table check.
const REPLAY_TOKENS = /a72Created|a72ReplayedTables|classificationTables/

async function main() {
  say(`[${TAG}] Harness correction acceptance (A5.10 T112 and the A7.2 replay check, later-phase recognition) — run ${runId}`)
  const headAtStart = git('rev-parse HEAD')
  const branch = git('rev-parse --abbrev-ref HEAD')
  say(`[${TAG}] HEAD at start ${headAtStart} on branch ${branch} against ${baseUrl}`)
  const mergeOf = (name: string) => gitArgs(['log', 'origin/main', '--merges', `--grep=${name}$`, '-n', '1', '--format=%H'])
  const a510Merge = mergeOf(a510Branch)
  const a83Merge = mergeOf(a83Branch)
  const a82Merge = mergeOf(a82Branch)
  const a81Merge = mergeOf(a81Branch)
  const a81FixMerge = mergeOf(a81FixBranch)
  const a710Merge = mergeOf(a710Branch)

  // ---------------------------------------------------------------- scope (H01–H05)
  section('Scope: branch and ancestry, clean tree, exact changed files, no product/migration/schema change, accepted contracts')
  check(
    'H01',
    'Branch from the accepted A8.3 main',
    branch === fixBranch && a83Merge === A83_MERGE && gitOk(`merge-base --is-ancestor ${A83_MERGE} HEAD`) && gitOk('merge-base --is-ancestor origin/main HEAD') && a510Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a510Merge} HEAD`),
    `branch ${branch}; A8.3 merged as ${a83Merge.slice(0, 7) || 'NOT FOUND'} and A5.10 as ${a510Merge.slice(0, 7) || 'NOT FOUND'}; latest main ${git('rev-parse --short origin/main')} contained`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  const tracking = git('status -sb').split(/\r?\n/)[0]
  const onThisBranch = branch === fixBranch && dirty.length === 0 && tracking.includes(`origin/${fixBranch}`) && !/ahead|behind/.test(tracking)
  check('H02', 'Clean tree and origin parity', onThisBranch, dirty.length === 0 ? `working tree clean; ${tracking}` : `uncommitted: ${dirty.join(', ').slice(0, 200)}`)
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const outOfScope = changedPaths.filter((path) => !ALLOWED.includes(path))
  check(
    'H03',
    'Exact changed-file scope',
    outOfScope.length === 0 && ALLOWED.every((path) => changedPaths.includes(path)),
    outOfScope.length === 0 ? `${changedPaths.length} path(s): the A5.10 suite, the replay script's A7.2 check, ${DOC}, this suite and its one package script` : `unexpected: ${outOfScope.join(', ')}`,
  )
  const productChanged = changedPaths.filter((path) => path !== REPLAY && /^backend\/(prisma\/|src\/(modules|shared|scripts|jobs)\/|src\/(app|server)\.ts)|^frontend\//.test(path))
  const pkgMain = JSON.parse(textAt('origin/main', 'backend/package.json'))
  const pkgHead = JSON.parse(textAt('HEAD', 'backend/package.json'))
  const { [SCRIPT_NAME]: addedScript, ...scriptsRest } = pkgHead.scripts ?? {}
  const pkgOk = same(scriptsRest, pkgMain.scripts) && addedScript === `node --env-file=.env src/integration/harness-corrections-a5-a7/harness-corrections-a5-a7.integration.ts` && same({ ...pkgHead, scripts: null }, { ...pkgMain, scripts: null })
  const migrationDirsAt = (ref: string) => git(`ls-tree -d --name-only --full-tree ${ref} backend/prisma/migrations/`).split(/\r?\n/).filter((line) => /\/\d{14}_/.test(line))
  check(
    'H04',
    'No product, migration or schema change',
    productChanged.length === 0 && pkgOk && same(migrationDirsAt('HEAD'), migrationDirsAt('origin/main')),
    productChanged.length === 0 ? "no module, shared, job, app, server, prisma or frontend file changed (the replay script only in its A7.2 check, H08); package.json differs only by this suite's one script; every migration identical to main" : `changed: ${productChanged.join(', ')}`,
  )
  const contractConstants = (ref: string) =>
    git(`ls-tree -r --name-only --full-tree ${ref} backend/src/modules`)
      .split(/\r?\n/)
      .filter((path) => /\.types\.ts$/.test(path))
      .flatMap((path) => [...textAt(ref, path).matchAll(/export const ([A-Z_]*(CONTRACT_VERSION|VALIDATOR_VERSION|SCHEMA_VERSION)) = '([^']+)'/g)].map((m) => `${m[1]}=${m[3]}`))
      .sort()
  const contractsHead = contractConstants('HEAD')
  check('H05', 'Accepted contracts unchanged', contractsHead.length >= 24 && same(contractsHead, contractConstants('origin/main')), `all ${contractsHead.length} A1–A8.3 contract constants identical to main`)

  // ---------------------------------------------------------------- checks kept (H06–H08)
  section('Every A5.10 check kept: ids, titles and N/A policy unchanged; only the T112 own-scope lines and the A7.2 replay check changed')
  const before = textAt('origin/main', A510_HARNESS)
  const after = textAt('HEAD', A510_HARNESS)
  const checkIds = (text: string) => [...text.matchAll(/check\(\s*'(T\d{3})',\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => `${m[1]} ${m[2]}`)
  check('H06', 'Every A5.10 check kept with its id and title', same(checkIds(after), checkIds(before)) && checkIds(after).length >= 120, `the A5.10 suite has exactly the ${checkIds(after).length} check ids and titles it has on main (none added, removed or renamed)`)
  const naPolicy = (text: string) => {
    const start = text.indexOf('NonApplicable: Record<string, string> = {')
    return start < 0 ? '' : text.slice(start, text.indexOf('\n  }', start)).replace(/\r/g, '')
  }
  check(
    'H07',
    'No check converted to N/A',
    naPolicy(after) === naPolicy(before) && naPolicy(after).length > 0 && (after.match(/notApplicableCheck\(/g) ?? []).length === (before.match(/notApplicableCheck\(/g) ?? []).length,
    'the documented A5.9 N/A map and every N/A call of the A5.10 suite are byte-identical to main: no substantive check was made N/A',
  )
  const stray: string[] = []
  const original = new Set(lines(before).map((line) => line.trim()))
  for (const [path, added, removed] of [[A510_HARNESS, OWN_TOKENS, REMOVED_TOKENS], [REPLAY, REPLAY_TOKENS, REPLAY_TOKENS]] as const) {
    for (const line of lines(gitArgs(['diff', '-U0', 'origin/main...HEAD', '--', `:/${path}`]))) {
      if (!/^[+-][^+-]/.test(line) && !/^[+-]$/.test(line)) continue
      const body = line.slice(1).trim()
      const isComment = body.startsWith('//') || body === ''
      const ok = line.startsWith('+') ? isComment || added.test(body) || (path === A510_HARNESS && original.has(body)) : isComment || removed.test(body)
      if (!ok) stray.push(`${path.split('/').pop()}: ${line.slice(0, 90)}`)
    }
  }
  check('H08', 'Only own-scope predicate lines changed', stray.length === 0, stray.length === 0 ? 'every added or removed line is a T112 own-scope definition or use, a comment, a line the original already had, or the replay check of the A7.2 tables' : `unexpected: ${stray.slice(0, 4).join(' | ')}`)

  // ---------------------------------------------------------------- equivalence and refusal (H09–H12)
  section("Own-branch equivalence by construction; each corrected predicate still refuses what it refused; nothing concealed at this HEAD")
  const missing = DEFINITIONS.filter((definition) => after.split(definition).length - 1 !== 1)
  check(
    'H09',
    'A5.10 branch: T112 is the original predicate',
    missing.length === 0 && (after.match(/const ownMerge = /g) ?? []).length === 1 && before.includes(ORIGINAL_T112) && !after.includes(ORIGINAL_T112) && before.includes("const productionReached = production.files.length > 150 && production.code.includes('requireOrganizationPermission')"),
    missing.length === 0
      ? "T112 is defined once from ownMerge = (A5.10's branch ? '' : its merge); with '' it reads exactly the HEAD production and app code, the original reach condition and the same word list"
      : `not as stated: ${missing.map((m) => m.slice(0, 50)).join(' | ')}`,
  )
  const ownCode = productionAt(a510Merge)
  const headCode = productionAt('HEAD')
  // A later package that legitimately names a DHA code set, and a US runtime term inside A5.10's own merged code: the
  // original predicate refuses the first (it judges the later package), the corrected one does not; both refuse the
  // second, so the correction weakens nothing A5.10 owns.
  const laterPackage = "export const codeSystems = ['ICD-10-CM', 'CPT', 'HCPCS-LEVEL-II'] as const"
  const usRuntime = "export const transport = 'X12'"
  const originalOnLater = !US_RUNTIME.test(headCode.code + '\n' + laterPackage)
  const correctedOnLater = !US_RUNTIME.test(ownCode.code)
  check(
    'H10',
    'T112 still refuses US runtime in A5.10 code',
    ownCode.files.length > 150 && ownCode.code.includes('requireOrganizationPermission') && correctedOnLater && !originalOnLater && US_RUNTIME.test(ownCode.code + '\n' + usRuntime) && US_RUNTIME.test(headCode.code + '\n' + usRuntime),
    `on a later branch the corrected T112 reads the ${ownCode.files.length} production files A5.10 merged (${a510Merge.slice(0, 7)}) and PASSes; a later package naming HCPCS-LEVEL-II fails the original predicate (fix disabled → FAIL) and is not judged by the corrected one; an X12 term in A5.10's own code still fails both`,
  )
  check('H11', 'Nothing concealed at this HEAD', !US_RUNTIME.test(headCode.code) && headCode.files.length >= ownCode.files.length, `at this HEAD the original HEAD-wide predicate also PASSes over all ${headCode.files.length} production files: the correction hides nothing that exists today`)
  const tablesCreatedAt = (ref: string) => migrationDirsAt(ref).flatMap((dir) => [...textAt(ref, `${dir}/migration.sql`).matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1]))
  const namedLikeA72 = tablesCreatedAt('HEAD').filter((table) => /classif|normaliz/.test(table))
  const a72Created = [...textAt('HEAD', A72_MIGRATION).matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1])
  const replay = run('npm run db:verify:replay')
  check(
    'H12',
    'A7.2 replay check judges A7.2 migration only',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && /PASS {2}the A7\.2 tables are exactly source_evidence_classifications after a clean replay/.test(replay.output) && same(a72Created, ['source_evidence_classifications']) && same(namedLikeA72, ['source_evidence_classifications']),
    `the replay passes with the unchanged PASS text; the A7.2 migration file creates exactly source_evidence_classifications; at this HEAD no other committed migration creates a table named like it (${namedLikeA72.join(', ')}), so the original name rule would agree`,
  )

  // ---------------------------------------------------------------- full nested chain (H13–H18)
  section('Full nested chain — A8.3 invoked, nesting A8.2 -> A8.1 -> A7.10 -> … -> A6.10 -> … -> A5.10 -> … -> A1')
  if (((await fetch(`${baseUrl}/api/ready`).catch(() => null))?.status ?? 0) !== 200) throw new RunAborted(`the API at ${baseUrl} is not ready; start it with \`npm start\` and run this suite again`)
  const chain = run('npm run test:a8:exception-investigation')
  const nestedLog = `hc57-nested-${runId}.log`
  writeFileSync(nestedLog, chain.output)
  const rows = suiteLines(chain.output, 'A8.3')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  const lineOfRow = (id: string) => rows.find((row) => row.id === id)?.line ?? ''
  const titleOf = (text: string) => text.slice('[A8.3] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  const ran = rows.some((row) => row.id === 'T130') && !/\[A8\.3\] RUN ABORTED|\[A8\.3\] uncaught error|\[A8\.3\] INVALID RUN/.test(chain.output)
  const summary = chain.output.match(/\[A8\.3\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = summary ? Number(summary[2]) - Number(summary[1]) : -1
  // A8.3's checks about its own branch: obsolete on any other branch by design, each proved below for its cause.
  const a83NonApplicable: Record<string, string> = {
    T001: "A8.3 'A8.2 FINAL PASS merge is an ancestor' requires the A8.3 feature branch; this branch is cut from the main that contains the A8.3 merge (H01)",
    T002: "A8.3 'Clean tree and origin parity' requires tracking origin/feature/a8-3-…; THIS branch's clean tree and parity are proved by H02",
    T010: "A8.3 'Changed-file allowlist' lists the paths A8.3 was allowed to change; this branch's exact scope is proved by H03, H04 and H08",
    T119: "A8.3 'Every historical branch-only N/A justified' proves A8.2's branch-only causes against the A8.3 branch; here they are re-proved against this branch (H17)",
    T130: "A8.3 'Second independent 130/130 run at exact HEAD' compares HEAD with origin/feature/a8-3-…; THIS run's identity and pushed HEAD are proved by H18",
  }
  for (const text of lines(chain.output).filter((l) => / \.{3,} FAIL|RUN ABORTED|uncaught error|INVALID RUN/.test(l))) progress(`nested: ${text.slice(0, 400)}`)
  const undocumented = failing.filter((id) => !(id in a83NonApplicable))
  const substantivePassing = rows.filter((row) => !row.id.includes('/') && row.verdict === 'PASS').length
  check(
    'H13',
    'A8.3 every substantive check PASS',
    ran && failedCount === failing.length && undocumented.length === 0 && substantivePassing === 130 - failing.length && substantivePassing >= 125,
    !ran ? 'the A8.3 suite did not complete' : undocumented.length > 0 ? `undocumented A8.3 failures: ${undocumented.join(', ')}` : `A8.3 ${summary?.[1]}/${summary?.[2]}: every one of its ${substantivePassing} substantive checks PASS; its only failures are the documented branch-only items`,
  )
  for (const id of Object.keys(a83NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) notApplicableCheck(`H13/${id}`, `A8.3 ${titleOf(row.line)}`, a83NonApplicable[id])
  }
  // Nested suites pass only their failures upward, so the corrected T112 is proved by its absence from every failure
  // line of the whole chain together with A8.3 T117, which PASSes only when every A5 substantive check PASSes.
  const t112Failures = lines(chain.output).filter((line) => /\[A5\.10\] +T112 .* \.{3,} FAIL/.test(line))
  const replayFailures = lines(chain.output).filter((line) => /FAIL {2}the A7\.2 tables are exactly/.test(line))
  check(
    'H14',
    'The corrected checks hold throughout the chain',
    ran && t112Failures.length === 0 && replayFailures.length === 0 && verdictOf('T117') === 'PASS',
    `no nested A5.10 T112 and no A7.2 replay-table failure anywhere in the chain; A8.3 T117 (every A5 substantive check, A5.10 included) ${verdictOf('T117')}`,
  )
  const chainIds = ['T111', 'T112', 'T113', 'T114', 'T115', 'T116', 'T117', 'T118']
  check('H15', 'A8.2 → A1 substantive regressions PASS', chainIds.every((id) => verdictOf(id) === 'PASS'), `A8.3 T111–T118 (A8.2, A8.1, A7.10 … A7.1, A6.10 → A6.1, A5, A1–A4): ${chainIds.map(verdictOf).join('/')}`)
  const gateIds = ['T121', 'T125', 'T126', 'T127', 'T128', 'T129']
  check('H16', 'Units, typecheck, lint, build, replay, outage', gateIds.every((id) => verdictOf(id) === 'PASS'), `A8.3 ${gateIds.join(', ')}: ${gateIds.map(verdictOf).join('/')}`)
  // Each documented failure must fail for its branch-only reason, proved independently on this branch, all the way
  // down: A8.3 T119's unproven A8.2 items, A8.2 T120's A8.1 items, A8.1 T110's A7.10 items and A7.10 T111's A7.9 items.
  const originOf = (name: string) => gitArgs(['rev-parse', '--verify', '--quiet', `origin/${name}`])
  const originFix = originOf(fixBranch)
  const nestedLine = (depth: string[], id: string) =>
    lines(chain.output).find((line) => new RegExp(`^\\[A8\\.3\\] +${depth.map((tag) => `nested: \\[${tag.replace('.', '\\.')}\\] +`).join('')}${id} `).test(line)) ?? ''
  const listAfter = (line: string, label: RegExp) => ((line.match(label) ?? ['', ''])[1] ?? '').split(', ').filter(Boolean)
  const inScope = (paths: string[]) => paths.length > 0 && paths.every((path, index) => changedPaths.includes(path) || (path === 'package.json beyond the one script' && changedPaths.includes('backend/package.json')) || (index === paths.length - 1 && changedPaths.some((p) => p.startsWith(path))))
  const failCount = (depth: string[]) => lines(chain.output).filter((line) => new RegExp(`^\\[A8\\.3\\] +${depth.map((tag) => `nested: \\[${tag.replace('.', '\\.')}\\] +`).join('')}T\\d{3} .* \\.{3,} FAIL`).test(line)).length
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
    T122: originOf(a710Branch) === '' && originFix === headAtStart,
    T123: originOf(a710Branch) === '' && originFix === headAtStart,
    T130: a710SelfCount === 129 - (failCount(['A8.2', 'A8.1', 'A7.10']) - 1),
  }
  const a81Causes: Record<string, boolean> = {
    T001: onThisBranch && a81Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a81Merge} HEAD`) && a710Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a710Merge} HEAD`),
    T002: onThisBranch,
    T010: inScope(a81Unexpected) && outOfScope.length === 0,
    T110: unprovenA710.length > 0 && unprovenA710.every((id) => id in a710Causes && a710Causes[id]),
    T130: originFix === headAtStart && originOf(a81Branch) !== headAtStart && /all evidence corresponds to/.test(nestedLine(['A8.2', 'A8.1'], 'T130')),
  }
  const a82Causes: Record<string, boolean> = {
    T001: onThisBranch && a81Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a81Merge} HEAD`) && a81FixMerge.length === 40 && gitOk(`merge-base --is-ancestor ${a81FixMerge} HEAD`),
    T002: onThisBranch,
    T010: inScope(a82Unexpected) && outOfScope.length === 0,
    T120: unprovenA81.length > 0 && unprovenA81.every((id) => id in a81Causes && a81Causes[id]),
    T130: originFix === headAtStart && originOf(a82Branch) !== headAtStart && /all evidence corresponds to/.test(nestedLine(['A8.2'], 'T130')),
  }
  const causes: Record<string, boolean> = {
    T001: onThisBranch && a83Merge === A83_MERGE && a82Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a82Merge} HEAD`),
    T002: onThisBranch,
    T010: inScope(listAfter(lineOfRow('T010'), /unexpected: (.*)$/)) && outOfScope.length === 0,
    T119: unprovenA82.length > 0 && unprovenA82.every((id) => id in a82Causes && a82Causes[id]),
    T130: originFix === headAtStart && originOf(a83Branch) !== headAtStart && failing.every((id) => id in a83NonApplicable),
  }
  const unproven = failing.filter((id) => id in causes && !causes[id])
  const naLines = lines(chain.output).filter((line) => /^\[A8\.3\] T111\/T\d+ .* N\/A {2}- \S/.test(line))
  check(
    'H17',
    'Every A8.3 failure proved branch-only',
    ran && failing.every((id) => id in a83NonApplicable) && unproven.length === 0 && naLines.length === failCount(['A8.2']) && naLines.length >= 5,
    unproven.length === 0
      ? `each A8.3 failure (${failing.join(', ') || 'none'}) fails only for its branch-only cause, proved on this branch all the way down (A8.2 ${unprovenA82.join(', ') || 'none'}; A8.1 ${unprovenA81.join(', ') || 'none'}; A7.10 ${unprovenA710.join(', ') || 'none'}; A7.9 ${unprovenA79.join(', ') || 'none'})`
      : `cause not proven for: ${unproven.join(', ')}`,
  )

  // ---------------------------------------------------------------- exact head (H18)
  const headNow = git('rev-parse HEAD')
  check(
    'H18',
    'Exact HEAD, clean origin, nested output kept',
    headNow === headAtStart && headNow === originFix && git('status --porcelain') === '' && existsSync(nestedLog) && /^HC57-\d{13}$/.test(runId),
    `all evidence corresponds to ${headNow} (= origin/${fixBranch}); fresh run ${runId}; full nested output in backend/${nestedLog} (${chain.output.length} chars, SHA-256 ${sha256Of(chain.output).slice(0, 16)}…)`,
  )

  say(`\n[${TAG}] run ${runId} — HEAD ${headNow}`)
  if (failures.length > 0) {
    say(`[${TAG}] ${failures.length} FAILED:`)
    for (const failure of failures) say(`          ${failure}`)
  }
  if (notApplicable > 0) say(`[${TAG}] ${notApplicable} nested A8.3 branch-only item(s) reported N/A, each proved for its cause by H17 (never a substantive check)`)
  say(`[${TAG}] automated summary: ${passed}/${passed + failed} PASS`)
  say(failed === 0 ? `[${TAG}] HARNESS CORRECTION ACCEPTANCE COMPLETE` : `[${TAG}] HARNESS CORRECTION FINAL FAIL`)
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  if (error instanceof RunAborted) {
    console.log(`\n[${TAG}] RUN ABORTED: ${error.message}`)
    console.log(`[${TAG}] No verdict was recorded for the remaining checks, so this run is not evidence of anything.`)
  } else {
    console.error(`[${TAG}] uncaught error (this itself is a FAIL):`, error)
  }
  process.exitCode = 1
})
