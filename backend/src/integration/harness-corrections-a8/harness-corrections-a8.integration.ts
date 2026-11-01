import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { delimiter } from 'node:path'
import { prisma } from '../../shared/database/prisma.ts'

// Acceptance for the harness-only correction of the A8.1 suite and its replay check (docs/Harness_Corrections.md,
// "A8.1 later-phase recognition"), made before A8.2.
//
// A8.1 run on any branch but its own always fails its checks about that branch (its name, tracking, allowed paths and
// pushed HEAD, and the proof of A7.10's branch-only causes against that branch), so it cannot be this branch's final
// gate. This suite is: it proves the exact changed-file scope, that no product code, migration, schema or accepted
// contract changed, that every A8.1 check still exists unchanged in id, title and N/A policy, that every changed
// predicate is built so that it is the original predicate on A8.1's own branch, that the later-phase rule is derived
// only from committed migrations and conceals nothing, and then runs the full A8.1 → A1 chain once, requiring every
// substantive check to PASS and proving each branch-only failure for its own cause on this branch. Read-only except for
// one DDL probe inside a transaction that is always rolled back; the nested suites write their own synthetic fixtures.

const TAG = 'HC8'
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

const runId = `HC8-${Date.now()}`
const baseUrl = process.env.A1_IT_BASE_URL as string
const fixBranch = 'fix/a8-1-harness-later-phase-recognition'
const a81Branch = 'feature/a8-1-exception-intake'
const a710Branch = 'feature/a7-10-a7-integration-acceptance'
const a79Branch = 'feature/a7-9-revenue-evidence-continuity'
const a78Branch = 'feature/a7-8-revenue-evidence-delta'
const A81_HARNESS = 'backend/src/integration/a8-exception-intake/a8-exception-intake.integration.ts'
const REPLAY = 'backend/src/scripts/verify-migration-replay.ts'
const HARNESS = 'backend/src/integration/harness-corrections-a8/harness-corrections-a8.integration.ts'
const DOC = 'docs/Harness_Corrections.md'
const SCRIPT_NAME = 'test:harness-corrections:a8'
const ALLOWED = [A81_HARNESS, REPLAY, DOC, HARNESS, 'backend/package.json']
// The later-phase boundaries A8.1 enforces on new tables (T100 and T119).
const A81_BOUNDARIES = [
  /(assign|work_queue|sla|severity|resolution|export|outbox|transmission|acknowledg|remittance|payment|ledger|receivable|settle|reconcil)/i,
  /(assign|status|export|triage|escalat|work_item|investigat)/i,
]

// The definitions every corrected predicate is built from. With ownMerge = '' (A8.1's own branch) each is literally
// the original value: 'origin/main...HEAD', 'origin/main', 'HEAD', the head/base migration lists, the same diff, the
// same catalogue, and no later-phase table or permission.
const DEFINITIONS = [
  "const ownMerge = branch === a81Branch ? '' : mergeOf(a81Branch)",
  "const ownRange = ownMerge ? `${ownMerge}^1..${ownMerge}` : 'origin/main...HEAD'",
  "const ownBase = ownMerge ? gitArgs(['rev-parse', `${ownMerge}^1`]) : 'origin/main'",
  "const ownTip = ownMerge || 'HEAD'",
  "const ownChangedPaths = gitArgs(['diff', '--name-only', ownRange]).split(/\\r?\\n/).filter(Boolean)",
  "const ownPrismaStatus = gitArgs(['diff', '--name-status', ownRange, '--', ':/backend/prisma']).split(/\\r?\\n/).filter(Boolean)",
  'const ownHeadMigrationDirs = ownMerge ? migrationDirsAt(ownMerge) : headMigrationDirs',
  'const ownBaseMigrationDirs = ownMerge ? migrationDirsAt(ownBase) : baseMigrationDirs',
  'const catalogueHead = catalogueAt(ownTip)',
  'const catalogueMain = catalogueAt(ownBase)',
  "const laterPermissions = ownMerge ? catalogueAt('HEAD').filter((c) => !catalogueHead.includes(c)) : []",
  "const laterPhaseTables = new Set(ownMerge ? migrationDirsAt('HEAD').filter((dir) => !migrationDirsAt(ownMerge).includes(dir)).flatMap((dir) => [...committedText(`${dir}/migration.sql`).matchAll(/CREATE TABLE \"([^\"]+)\"/g)].map((m) => m[1])) : [])",
]
// A changed line of the A8.1 suite is admissible only when it carries an own-scope or T050 name, is a comment, or
// (added) repeats a line the original already had.
const OWN_TOKENS = /ownMerge|ownRange|ownBase|ownTip|ownChangedPaths|ownPrismaStatus|ownHeadMigrationDirs|ownBaseMigrationDirs|catalogueHead|catalogueMain|laterPermissions|laterPhaseTables|cascadeTruncation|truncationRefused|referencedBy|its own scope|before it untouched/
const REPLACED_TOKENS = /prismaStatus|headMigrationDirs|baseMigrationDirs|catalogueAt\('(HEAD|origin\/main)'\)|changedPaths|allCodes|truncation|newTablesLike|applied migrations untouched/
// The replay script may change only its import and the A8.1 table check.
const REPLAY_TOKENS = /readFileSync|a81Created|replayedTables|intakeTables|A8\.1 migration|A8\.1 tables/

const migrationDirsAt = (ref: string) => git(`ls-tree -d --name-only --full-tree ${ref} backend/prisma/migrations/`).split(/\r?\n/).filter((line) => /\/\d{14}_/.test(line))
const tablesCreatedIn = (dir: string) => [...textAt('HEAD', `${dir}/migration.sql`).matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1])
// The later-phase rule exactly as the corrected A8.1 suite states it (H09 proves it states it so).
const laterPhaseTablesAfter = (merge: string) => new Set(merge ? migrationDirsAt('HEAD').filter((dir) => !migrationDirsAt(merge).includes(dir)).flatMap(tablesCreatedIn) : [])

async function main() {
  say(`[${TAG}] Harness correction acceptance (A8.1 later-phase recognition) — run ${runId}`)
  const headAtStart = git('rev-parse HEAD')
  const branch = git('rev-parse --abbrev-ref HEAD')
  say(`[${TAG}] HEAD at start ${headAtStart} on branch ${branch} against ${baseUrl}`)
  const mergeOf = (name: string) => gitArgs(['log', 'origin/main', '--merges', `--grep=${name}$`, '-n', '1', '--format=%H'])
  const a81Merge = mergeOf(a81Branch)

  // ---------------------------------------------------------------- scope (H01–H05)
  section('Scope: branch and ancestry, clean tree, exact changed files, no product/migration/schema change, accepted contracts')
  check('H01', 'Branch from the accepted A8.1 main', branch === fixBranch && a81Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a81Merge} HEAD`) && gitOk('merge-base --is-ancestor origin/main HEAD'), `branch ${branch}; A8.1 merged as ${a81Merge.slice(0, 7) || 'NOT FOUND'}; latest main ${git('rev-parse --short origin/main')} contained`)
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check('H02', 'Clean tree and origin parity', dirty.length === 0 && tracking.includes(`origin/${fixBranch}`) && !/ahead|behind/.test(tracking), dirty.length === 0 ? `working tree clean; ${tracking}` : `uncommitted: ${dirty.join(', ').slice(0, 200)}`)
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const outOfScope = changedPaths.filter((path) => !ALLOWED.includes(path))
  check(
    'H03',
    'Exact changed-file scope',
    outOfScope.length === 0 && ALLOWED.every((path) => changedPaths.includes(path)),
    outOfScope.length === 0 ? `${changedPaths.length} path(s): the A8.1 suite, its replay check, ${DOC}, this suite and its one package script` : `unexpected: ${outOfScope.join(', ')}`,
  )
  const productChanged = changedPaths.filter((path) => path !== REPLAY && /^backend\/(prisma\/|src\/(modules|shared|scripts|jobs)\/|src\/(app|server)\.ts)|^frontend\//.test(path))
  const pkgMain = JSON.parse(textAt('origin/main', 'backend/package.json'))
  const pkgHead = JSON.parse(textAt('HEAD', 'backend/package.json'))
  const { [SCRIPT_NAME]: addedScript, ...scriptsRest } = pkgHead.scripts ?? {}
  const pkgOk = same(scriptsRest, pkgMain.scripts) && addedScript === 'node --env-file=.env src/integration/harness-corrections-a8/harness-corrections-a8.integration.ts' && same({ ...pkgHead, scripts: null }, { ...pkgMain, scripts: null })
  check('H04', 'No product, migration or schema change', productChanged.length === 0 && pkgOk && same(migrationDirsAt('HEAD'), migrationDirsAt('origin/main')), productChanged.length === 0 ? "no module, shared, job, app, server, prisma or frontend file changed (the replay script only in its A8.1 check, H08); package.json differs only by this suite's one script; every migration identical to main" : `changed: ${productChanged.join(', ')}`)
  const contractConstants = (ref: string) =>
    git(`ls-tree -r --name-only --full-tree ${ref} backend/src/modules`)
      .split(/\r?\n/)
      .filter((path) => /\.types\.ts$/.test(path))
      .flatMap((path) => [...textAt(ref, path).matchAll(/export const ([A-Z_]*CONTRACT_VERSION) = '([^']+)'/g)].map((m) => `${m[1]}=${m[2]}`))
      .sort()
  const contractsHead = contractConstants('HEAD')
  check('H05', 'Accepted contracts unchanged', contractsHead.length >= 15 && same(contractsHead, contractConstants('origin/main')), `all ${contractsHead.length} A1–A8.1 contract constants identical to main`)

  // ---------------------------------------------------------------- checks kept (H06–H08)
  section('Every A8.1 check kept: ids, titles and N/A policy unchanged; only own-scope predicate lines changed')
  const before = textAt('origin/main', A81_HARNESS)
  const after = textAt('HEAD', A81_HARNESS)
  const checkIds = (text: string) => [...text.matchAll(/check\(\s*'(T\d{3})',\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => `${m[1]} ${m[2]}`)
  const naPolicy = (text: string) => {
    const start = text.indexOf('NonApplicable: Record<string, string> = {')
    return start < 0 ? '' : text.slice(start, text.indexOf('\n  }', start)).replace(/\r/g, '')
  }
  check('H06', 'Every A8.1 check kept with its id and title', same(checkIds(after), checkIds(before)) && checkIds(after).length === 130, `the A8.1 suite has exactly the ${checkIds(after).length} check ids and titles it has on main (none added, removed or renamed)`)
  check(
    'H07',
    'No check converted to N/A',
    naPolicy(after) === naPolicy(before) && naPolicy(after).length > 0 && (after.match(/notApplicableCheck\(/g) ?? []).length === (before.match(/notApplicableCheck\(/g) ?? []).length,
    'the documented A7.10 N/A map and every N/A call of the A8.1 suite are byte-identical to main: no substantive check was made N/A',
  )
  const stray: string[] = []
  const original = new Set(lines(before).map((line) => line.trim()))
  for (const [path, added, removed] of [[A81_HARNESS, OWN_TOKENS, REPLACED_TOKENS], [REPLAY, REPLAY_TOKENS, REPLAY_TOKENS]] as const) {
    for (const line of lines(gitArgs(['diff', '-U0', 'origin/main...HEAD', '--', `:/${path}`]))) {
      if (!/^[+-][^+-]/.test(line) && !/^[+-]$/.test(line)) continue
      const body = line.slice(1).trim()
      const isComment = body.startsWith('//') || body === ''
      const ok = line.startsWith('+') ? isComment || added.test(body) || (path === A81_HARNESS && original.has(body)) : isComment || removed.test(body)
      if (!ok) stray.push(`${path.split('/').pop()}: ${line.slice(0, 90)}`)
    }
  }
  check('H08', 'Only own-scope predicate lines changed', stray.length === 0, stray.length === 0 ? 'every added or removed line is an own-scope definition or use, the behaviour-judged T050 refusal, a comment, or the replay check of the A8.1 tables' : `unexpected: ${stray.slice(0, 4).join(' | ')}`)

  // ---------------------------------------------------------------- equivalence and the later-phase rule (H09–H12)
  section('Own-branch equivalence by construction; the later-phase rule is derived only from committed migrations and conceals nothing')
  const missing = DEFINITIONS.filter((definition) => (after.split(definition).length - 1) !== 1)
  check('H09', 'A8.1 branch: each predicate is the original', missing.length === 0 && (after.match(/const ownMerge = /g) ?? []).length === 1, missing.length === 0 ? "every own-scope value is defined once from ownMerge = (A8.1's branch ? '' : its merge), and with '' it is literally the original: origin/main...HEAD, origin/main, HEAD, the head/base migration lists, the same diff and catalogue, no later-phase table or permission" : `not as stated: ${missing.map((m) => m.slice(0, 50)).join(' | ')}`)
  check(
    'H10',
    'Later-phase tables come only from git',
    !missing.some((m) => /laterPhaseTables/.test(m)) && !/laterPhaseTables = [^\n]*(prisma|information_schema|pg_)/.test(after),
    "the excluded tables are computed only from migration files committed after A8.1's own merge (never from the database, a name or a list); a table no committed migration creates is never excluded",
  )
  const merge = branch === a81Branch ? '' : a81Merge
  const excluded = [...laterPhaseTablesAfter(merge)]
  const laterPermissions = merge ? [...textAt('HEAD', 'backend/src/shared/authorization/authorization.types.ts').matchAll(/^\s+'([A-Za-z_]+\.[A-Za-z_]+)',/gm)].map((m) => m[1]).filter((c) => !textAt(merge, 'backend/src/shared/authorization/authorization.types.ts').includes(`'${c}'`)) : []
  const concealed = excluded.filter((t) => A81_BOUNDARIES.some((re) => re.test(t)))
  check('H11', 'Exclusions conceal nothing at this HEAD', concealed.length === 0 && laterPermissions.length === 0, `no table or permission is excluded at this HEAD (${excluded.length} later-phase table(s), ${laterPermissions.length} later permission(s)); every live table and permission is judged exactly as on A8.1's own branch`)
  // A prohibited-looking table that no committed migration creates (DDL inside a transaction that is always rolled
  // back) is still judged by A8.1's boundaries: the rule cannot be used to hide a table.
  const probe = `triage_assignment_probe_${Date.now()}`
  let probeSeen = false
  const probeOutcome = await prisma
    .$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`CREATE TABLE "${probe}" (id integer)`)
        probeSeen = (await tx.$queryRawUnsafe<{ t: string }[]>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`, probe)).length === 1
        throw new Error('ROLLED_BACK')
      },
      { timeout: 60_000 },
    )
    .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
  const probeGone = (await prisma.$queryRawUnsafe<{ t: string }[]>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`, probe)).length === 0
  check('H12', 'A table without a migration is never excluded', probeOutcome === 'ROLLED_BACK' && probeSeen && !excluded.includes(probe) && A81_BOUNDARIES[1].test(probe) && probeGone, `a live table ${probe} created outside any migration (rolled back) is not excluded, so its prohibited name would fail A8.1 T119; nothing remains`)

  // ---------------------------------------------------------------- full nested chain (H13–H18)
  section('Full nested chain — A8.1 invoked, nesting A7.10 -> A7.9 -> … -> A6.10 -> … -> A1')
  if (((await fetch(`${baseUrl}/api/ready`).catch(() => null))?.status ?? 0) !== 200) throw new RunAborted(`the API at ${baseUrl} is not ready; start it with \`npm start\` and run this suite again`)
  const chain = run('npm run test:a8:exception-intake')
  const nestedLog = `hc8-nested-${runId}.log`
  writeFileSync(nestedLog, chain.output)
  const rows = suiteLines(chain.output, 'A8.1')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  const lineOfRow = (id: string) => rows.find((row) => row.id === id)?.line ?? ''
  const titleOf = (text: string) => text.slice('[A8.1] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  const ran = rows.some((row) => row.id === 'T130') && !/\[A8\.1\] RUN ABORTED|\[A8\.1\] uncaught error|\[A8\.1\] INVALID RUN/.test(chain.output)
  const summary = chain.output.match(/\[A8\.1\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = summary ? Number(summary[2]) - Number(summary[1]) : -1
  // A8.1's checks about its own branch: obsolete on any other branch by design, each proved below for its cause.
  const a81NonApplicable: Record<string, string> = {
    T001: "A8.1 'A7.10 exact merge ancestor' requires the A8.1 feature branch; this branch is cut from the main that contains the A8.1 merge (H01)",
    T002: "A8.1 'Clean tree and origin parity' requires tracking origin/feature/a8-1-…; THIS branch's clean tree and parity are proved by H02",
    T010: "A8.1 'Changed-file allowlist' lists the paths A8.1 was allowed to change; this branch's exact scope is proved by H03, H04 and H08",
    T110: "A8.1 'All historical branch N/A causes justified' proves A7.10's branch-only causes against the A8.1 branch; here they are re-proved against this branch (H17)",
    T130: "A8.1 'Exact HEAD, clean origin, independent run' compares HEAD with origin/feature/a8-1-…; THIS run's identity and pushed HEAD are proved by H18",
  }
  for (const text of lines(chain.output).filter((l) => / \.{3,} FAIL|RUN ABORTED|uncaught error|INVALID RUN/.test(l))) progress(`nested: ${text.slice(0, 400)}`)
  const undocumented = failing.filter((id) => !(id in a81NonApplicable))
  const substantivePassing = rows.filter((row) => !row.id.includes('/') && row.verdict === 'PASS').length
  check(
    'H13',
    'A8.1 every substantive check PASS',
    ran && failedCount === failing.length && undocumented.length === 0 && substantivePassing === 130 - failing.length && substantivePassing >= 125,
    !ran ? 'the A8.1 suite did not complete' : undocumented.length > 0 ? `undocumented A8.1 failures: ${undocumented.join(', ')}` : `A8.1 ${summary?.[1]}/${summary?.[2]}: every one of its ${substantivePassing} substantive checks PASS; its only failures are the documented branch-only items`,
  )
  for (const id of Object.keys(a81NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) notApplicableCheck(`H13/${id}`, `A8.1 ${titleOf(row.line)}`, a81NonApplicable[id])
  }
  const corrected = ['T004', 'T006', 'T007', 'T009', 'T050', 'T100', 'T119', 'T125']
  check('H14', 'The corrected A8.1 checks PASS', corrected.every((id) => verdictOf(id) === 'PASS'), `A8.1 ${corrected.join(', ')}: ${corrected.map(verdictOf).join('/')} — each judges A8.1's own scope and still holds`)
  const chainIds = ['T101', 'T102', 'T103', 'T104', 'T105', 'T106', 'T107', 'T108', 'T109']
  check('H15', 'A7.10 → A1 substantive regressions PASS', chainIds.every((id) => verdictOf(id) === 'PASS'), `A8.1 T101–T109 (A7.10 with its own justified N/A, A7.9 … A7.1, A6.10 → A1): ${chainIds.map(verdictOf).join('/')}`)
  const gateIds = ['T121', 'T122', 'T123', 'T124', 'T125', 'T126', 'T127', 'T128', 'T129']
  check('H16', 'Units, typecheck, lint, build, replay, outage', gateIds.every((id) => verdictOf(id) === 'PASS'), `A8.1 T121–T129: ${gateIds.map(verdictOf).join('/')}`)
  // Each documented A8.1 failure must fail for its branch-only reason, proved independently here; A8.1 T110's
  // unproven A7.10 items are re-proved against this branch too.
  const originOf = (name: string) => gitArgs(['rev-parse', '--verify', '--quiet', `origin/${name}`])
  const originFix = originOf(fixBranch)
  const a81Unexpected = (lineOfRow('T010').match(/unexpected: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const unprovenA710 = (lineOfRow('T110').match(/cause not proven for: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const nestedA710 = (id: string) => lines(chain.output).find((line) => new RegExp(`^\\[A8\\.1\\] +nested: \\[A7\\.10\\] ${id} `).test(line)) ?? ''
  const a710Unexpected = (nestedA710('T010').match(/unexpected: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const unprovenA79 = (nestedA710('T111').match(/cause not proven for: (.*)$/) ?? ['', ''])[1].split(', ').filter((id) => /^T\d{3}$/.test(id))
  const nestedA710Failures = lines(chain.output).filter((line) => /^\[A8\.1\] +nested: \[A7\.10\] T\d{3} .* \.{3,} FAIL/.test(line)).length
  const a710SelfCount = Number((nestedA710('T130').match(/(\d+) of the 129 checks before this one PASS/) ?? [])[1] ?? -1)
  const inScope = (paths: string[]) => paths.length > 0 && paths.every((path, index) => changedPaths.includes(path) || (path === 'package.json beyond the one script' && changedPaths.includes('backend/package.json')) || (index === paths.length - 1 && changedPaths.some((p) => p.startsWith(path))))
  const a710Causes: Record<string, boolean> = {
    T001: branch === fixBranch && mergeOf(a710Branch).length === 40 && gitOk(`merge-base --is-ancestor ${mergeOf(a710Branch)} HEAD`),
    T002: dirty.length === 0 && tracking.includes(`origin/${fixBranch}`) && !/ahead|behind/.test(tracking),
    T010: inScope(a710Unexpected) && outOfScope.length === 0,
    T111: unprovenA79.length > 0 && unprovenA79.every((id) => ['T001', 'T002', 'T010', 'T120', 'T130'].includes(id)) && originOf(a79Branch) === '' && originOf(a78Branch) === '' && tracking.includes(`origin/${fixBranch}`) && outOfScope.length === 0,
    T122: originOf(a710Branch) === '' && originFix === headAtStart,
    T123: originOf(a710Branch) === '' && originFix === headAtStart,
    T130: a710SelfCount === 129 - (nestedA710Failures - 1),
  }
  const causes: Record<string, boolean> = {
    T001: branch === fixBranch && a81Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a81Merge} HEAD`),
    T002: dirty.length === 0 && tracking.includes(`origin/${fixBranch}`) && !/ahead|behind/.test(tracking),
    T010: inScope(a81Unexpected) && outOfScope.length === 0,
    T110: unprovenA710.length > 0 && unprovenA710.every((id) => id in a710Causes && a710Causes[id]),
    T130: originFix === headAtStart && originOf(a81Branch) !== headAtStart && failing.every((id) => id in a81NonApplicable),
  }
  const unproven = failing.filter((id) => id in causes && !causes[id])
  const naLines = lines(chain.output).filter((line) => /^\[A8\.1\] T101\/T\d+ .* N\/A {2}- \S/.test(line))
  check(
    'H17',
    'Every A8.1 failure proved branch-only',
    ran && failing.every((id) => id in a81NonApplicable) && unproven.length === 0 && naLines.length === nestedA710Failures && naLines.length >= 5 && naLines.every((line) => line.length > 80),
    unproven.length === 0 ? `each A8.1 failure (${failing.join(', ') || 'none'}) is printed with its reason and fails only for its branch-only cause, proved here (A8.1 T110's A7.10 items ${unprovenA710.join(', ') || 'none'} re-proved); A8.1 itself justifies the A7.10 items (${naLines.length} lines)` : `cause not proven for: ${unproven.join(', ')}`,
  )

  // ---------------------------------------------------------------- exact head (H18)
  const headNow = git('rev-parse HEAD')
  check(
    'H18',
    'Exact HEAD, clean origin, nested output kept',
    headNow === headAtStart && headNow === originFix && git('status --porcelain') === '' && existsSync(nestedLog) && /^HC8-\d{13}$/.test(runId),
    `all evidence corresponds to ${headNow} (= origin/${fixBranch}); fresh run ${runId}; full nested output in backend/${nestedLog} (${chain.output.length} chars, SHA-256 ${sha256Of(chain.output).slice(0, 16)}…)`,
  )

  say(`\n[${TAG}] run ${runId} — HEAD ${headNow}`)
  if (failures.length > 0) {
    say(`[${TAG}] ${failures.length} FAILED:`)
    for (const failure of failures) say(`          ${failure}`)
  }
  if (notApplicable > 0) say(`[${TAG}] ${notApplicable} nested A8.1 branch-only item(s) reported N/A, each proved for its cause by H17 (never a substantive check)`)
  say(`[${TAG}] automated summary: ${passed}/${passed + failed} PASS`)
  say(failed === 0 ? `[${TAG}] HARNESS CORRECTION ACCEPTANCE COMPLETE` : `[${TAG}] HARNESS CORRECTION FINAL FAIL`)
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
    await prisma.$disconnect()
  })
