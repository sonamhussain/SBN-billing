import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { delimiter } from 'node:path'
import { prisma } from '../../shared/database/prisma.ts'

// Acceptance for the harness-only correction of the A6.10 and A7.1–A7.10 suites (docs/Harness_Corrections.md).
//
// A7.10 run on any branch but its own always fails its seven checks about that branch (its name, tracking, allowed
// paths, pushed HEAD and run identity), so it cannot be this branch's final gate. This suite is: it proves the exact
// changed-file scope, that no product code, migration, schema or accepted contract changed, that every historical
// check still exists unchanged in id, title and N/A policy, that every changed predicate is built so that it is the
// original predicate on the package's own branch, that the later-phase table rule is derived only from committed
// migrations and conceals nothing, and then runs the full A7.10 → A1 chain once, requiring every substantive check to
// PASS and proving each of the seven branch-only A7.10 failures for its own cause on this branch. Read-only except for
// one DDL probe inside a transaction that is always rolled back; the nested suites write their own synthetic fixtures.

const TAG = 'HC'
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

const runId = `HC-${Date.now()}`
const baseUrl = process.env.A1_IT_BASE_URL as string
const fixBranch = 'fix/a6-a7-harness-later-phase-recognition'
const a710Branch = 'feature/a7-10-a7-integration-acceptance'
const a79Branch = 'feature/a7-9-revenue-evidence-continuity'
const a78Branch = 'feature/a7-8-revenue-evidence-delta'
const HARNESS = 'backend/src/integration/harness-corrections/harness-corrections.integration.ts'
const DOC = 'docs/Harness_Corrections.md'
const SCRIPT_NAME = 'test:harness-corrections'
const suiteFile = (suite: string) => `backend/src/integration/${suite}/${suite}.integration.ts`
// Each corrected suite, the constant naming its own branch, and what it was corrected for.
const CORRECTED: { suite: string; branchConst: string; kind: 'early' | 'bundled' | 'late' | 'a610' }[] = [
  { suite: 'a7-revenue-source-evidence', branchConst: 'a71Branch', kind: 'early' },
  { suite: 'a7-evidence-classification', branchConst: 'a72Branch', kind: 'bundled' },
  { suite: 'a7-evidence-gate', branchConst: 'a73Branch', kind: 'bundled' },
  { suite: 'a7-evidence-case', branchConst: 'a74Branch', kind: 'bundled' },
  { suite: 'a7-case-prerequisite', branchConst: 'a75Branch', kind: 'early' },
  { suite: 'a7-closure-basis-trace', branchConst: 'a76Branch', kind: 'late' },
  { suite: 'a7-revenue-timeline', branchConst: 'a77Branch', kind: 'late' },
  { suite: 'a7-revenue-delta', branchConst: 'a78Branch', kind: 'late' },
  { suite: 'a7-revenue-continuity', branchConst: 'a79Branch', kind: 'late' },
  { suite: 'a7-phase-closure', branchConst: 'a710Branch', kind: 'late' },
  { suite: 'a6-phase-closure', branchConst: 'a610Branch', kind: 'a610' },
]
const ORDERED_COUNTS = 'a6-canonical-payload'
const SUITE_FILES = [...CORRECTED.map((c) => suiteFile(c.suite)), suiteFile(ORDERED_COUNTS)]
const ALLOWED = [...SUITE_FILES, DOC, HARNESS, 'backend/package.json']

// The definitions every own-scope predicate is built from. With ownMerge = '' (the package's own branch) each one is
// literally the original value: 'origin/main...HEAD', 'origin/main', 'HEAD', the head/base migration lists, the same
// diff of the same paths, and an empty set of later-phase tables.
const OWN_MERGE = (b: string) => `const ownMerge = branch === ${b} ? '' : mergeOf(${b})`
const OWN_RANGE = "const ownRange = ownMerge ? `${ownMerge}^1..${ownMerge}` : 'origin/main...HEAD'"
const OWN_CHANGED = "const ownChangedPaths = gitArgs(['diff', '--name-only', ownRange]).split(/\\r?\\n/).filter(Boolean)"
const OWN_BASE = "const ownBase = ownMerge ? gitArgs(['rev-parse', `${ownMerge}^1`]) : 'origin/main'"
const OWN_TIP = "const ownTip = ownMerge || 'HEAD'"
const OWN_PRISMA = "const ownPrismaStatus = gitArgs(['diff', '--name-status', ownRange, '--', ':/backend/prisma']).split(/\\r?\\n/).filter(Boolean)"
const OWN_HEAD_DIRS = 'const ownHeadMigrationDirs = ownMerge ? migrationDirsAt(ownMerge) : headMigrationDirs'
const OWN_BASE_DIRS = 'const ownBaseMigrationDirs = ownMerge ? migrationDirsAt(`${ownMerge}^1`) : baseMigrationDirs'
const LATER_RULE =
  "const laterPhaseTables = new Set(ownMerge ? migrationDirsAt('HEAD').filter((dir) => !migrationDirsAt(ownMerge).includes(dir)).flatMap((dir) => [...committedText(`${dir}/migration.sql`).matchAll(/CREATE TABLE \"([^\"]+)\"/g)].map((m) => m[1])) : [])"
const A610_MERGE = "const a610OwnMerge = branch === a610Branch ? '' : mergeOf(a610Branch)"
const A610_RULE =
  "const laterPhaseTables = new Set(a610OwnMerge ? migrationDirsIn('HEAD').filter((dir) => !migrationDirsIn(a610OwnMerge).includes(dir)).flatMap((dir) => [...committedText(`${dir}/migration.sql`).matchAll(/CREATE TABLE \"([^\"]+)\"/g)].map((m) => m[1])) : [])"
const A710_TREE = "const tracked = git(`ls-tree -r --name-only --full-tree ${ownMerge || 'HEAD'}`).split(/\\r?\\n/)"
// A changed line of a corrected suite is admissible only when it carries one of these own-scope names, is a comment,
// or (added) repeats a line the original already had (the owner filter duplicated over the own range).
const OWN_TOKENS = /ownMerge|ownRange|ownBase|ownTip|ownChangedPaths|ownPrismaStatus|ownHeadMigrationDirs|ownBaseMigrationDirs|ownOwnerChanged|laterPhaseTables|a610OwnMerge|migrationDirsIn|its own scope|identical to its base/
const REPLACED_TOKENS = /prismaStatus|migrationStatus|ownerChanged|baseMigrationDirs|headMigrationDirs|origin\/main\.\.\.HEAD|origin\/main:|committedText\(A7\dA?_HARNESS\)|changedPaths|const laterTables|const tableNames|const tracked = |identical to main|= main|on main;/

const migrationDirsAt = (ref: string) => git(`ls-tree -d --name-only --full-tree ${ref} backend/prisma/migrations/`).split(/\r?\n/).filter((line) => /\/\d{14}_/.test(line))
const tablesCreatedIn = (dir: string) => [...textAt('HEAD', `${dir}/migration.sql`).matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1])
// The later-phase rule exactly as the corrected suites state it (H09 proves they state it so).
const laterPhaseTablesAfter = (merge: string) => new Set(merge ? migrationDirsAt('HEAD').filter((dir) => !migrationDirsAt(merge).includes(dir)).flatMap(tablesCreatedIn) : [])

async function main() {
  say(`[${TAG}] Harness correction acceptance (A6.10, A7.1–A7.10 later-phase recognition; A6.6 ordered counts) — run ${runId}`)
  const headAtStart = git('rev-parse HEAD')
  const branch = git('rev-parse --abbrev-ref HEAD')
  say(`[${TAG}] HEAD at start ${headAtStart} on branch ${branch} against ${baseUrl}`)
  const mergeOf = (name: string) => gitArgs(['log', 'origin/main', '--merges', `--grep=${name}$`, '-n', '1', '--format=%H'])
  const a710Merge = mergeOf(a710Branch)

  // ---------------------------------------------------------------- scope (H01–H05)
  section('Scope: branch and ancestry, clean tree, exact changed files, no product/migration/schema change, accepted contracts')
  check('H01', 'Branch from the accepted A7.10 main', branch === fixBranch && a710Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a710Merge} HEAD`) && gitOk('merge-base --is-ancestor origin/main HEAD'), `branch ${branch}; A7.10 merged as ${a710Merge.slice(0, 7) || 'NOT FOUND'}; latest main ${git('rev-parse --short origin/main')} contained`)
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check('H02', 'Clean tree and origin parity', dirty.length === 0 && tracking.includes(`origin/${fixBranch}`) && !/ahead|behind/.test(tracking), dirty.length === 0 ? `working tree clean; ${tracking}` : `uncommitted: ${dirty.join(', ').slice(0, 200)}`)
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const outOfScope = changedPaths.filter((path) => !ALLOWED.includes(path))
  check(
    'H03',
    'Exact changed-file scope',
    outOfScope.length === 0 && SUITE_FILES.every((path) => changedPaths.includes(path)) && changedPaths.includes(DOC) && changedPaths.includes(HARNESS),
    outOfScope.length === 0 ? `${changedPaths.length} path(s): the ${SUITE_FILES.length} corrected suites, ${DOC}, this suite and its one package script` : `unexpected: ${outOfScope.join(', ')}`,
  )
  const productChanged = changedPaths.filter((path) => /^backend\/(prisma\/|src\/(modules|shared|scripts|jobs)\/|src\/(app|server)\.ts)|^frontend\//.test(path))
  const pkgMain = JSON.parse(textAt('origin/main', 'backend/package.json'))
  const pkgHead = JSON.parse(textAt('HEAD', 'backend/package.json'))
  const { [SCRIPT_NAME]: addedScript, ...scriptsRest } = pkgHead.scripts ?? {}
  const pkgOk = same(scriptsRest, pkgMain.scripts) && addedScript === `node --env-file=.env src/integration/harness-corrections/harness-corrections.integration.ts` && same({ ...pkgHead, scripts: null }, { ...pkgMain, scripts: null })
  check('H04', 'No product, migration or schema change', productChanged.length === 0 && pkgOk && same(migrationDirsAt('HEAD'), migrationDirsAt('origin/main')), productChanged.length === 0 ? 'no module, shared, script, job, app, server, prisma or frontend file changed; package.json differs only by this suite\'s one script; every migration identical to main' : `changed: ${productChanged.join(', ')}`)
  const contractConstants = (ref: string) =>
    git(`ls-tree -r --name-only --full-tree ${ref} backend/src/modules`)
      .split(/\r?\n/)
      .filter((path) => /\.types\.ts$/.test(path))
      .flatMap((path) => [...textAt(ref, path).matchAll(/export const ([A-Z_]*CONTRACT_VERSION) = '([^']+)'/g)].map((m) => `${m[1]}=${m[2]}`))
      .sort()
  const contractsHead = contractConstants('HEAD')
  check('H05', 'Accepted contracts unchanged', contractsHead.length >= 15 && same(contractsHead, contractConstants('origin/main')), `all ${contractsHead.length} A1–A7 contract constants identical to main`)

  // ---------------------------------------------------------------- checks kept (H06–H08)
  section('Every historical check kept: ids, titles and N/A policy unchanged; only own-scope predicate lines changed')
  const checkIds = (text: string) => [...text.matchAll(/check\(\s*'(T\d{3})',\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => `${m[1]} ${m[2]}`)
  const naPolicy = (text: string) => {
    const start = text.indexOf('NonApplicable: Record<string, string> = {')
    return start < 0 ? '' : text.slice(start, text.indexOf('\n  }', start))
  }
  const keptProblems: string[] = []
  for (const path of SUITE_FILES) {
    const before = textAt('origin/main', path)
    const after = textAt('HEAD', path)
    if (!same(checkIds(after), checkIds(before)) || checkIds(after).length < 120) keptProblems.push(`${path}: check ids/titles differ`)
    if ((after.match(/notApplicableCheck\(/g) ?? []).length !== (before.match(/notApplicableCheck\(/g) ?? []).length) keptProblems.push(`${path}: N/A calls differ`)
    if (naPolicy(after).replace(/\r/g, '') !== naPolicy(before).replace(/\r/g, '')) keptProblems.push(`${path}: N/A policy differs`)
  }
  check('H06', 'Every check kept with its id and title', keptProblems.filter((p) => /ids/.test(p)).length === 0, `each of the ${SUITE_FILES.length} suites has exactly the check ids and titles it has on main (none added, removed or renamed)`)
  check('H07', 'No check converted to N/A', keptProblems.filter((p) => /N\/A/.test(p)).length === 0, keptProblems.length === 0 ? 'every documented N/A map and N/A call is byte-identical to main: no substantive check was made N/A' : keptProblems.join(' | ').slice(0, 300))
  const stray: string[] = []
  for (const path of SUITE_FILES) {
    const original = new Set(lines(textAt('origin/main', path)).map((line) => line.trim()))
    for (const line of lines(gitArgs(['diff', '-U0', 'origin/main...HEAD', '--', `:/${path}`]))) {
      if (!/^[+-][^+-]/.test(line) && !/^[+-]$/.test(line)) continue
      const body = line.slice(1).trim()
      const isComment = body.startsWith('//') || body === ''
      const ordered = path === suiteFile(ORDERED_COUNTS) && (/UNION ALL SELECT 'audit', count\(\*\) FROM audit_events UNION ALL SELECT 'validation_runs', count\(\*\) FROM validation_runs`?,?$/.test(body) || body === 'ORDER BY t`,')
      const ok = line.startsWith('+') ? isComment || ordered || OWN_TOKENS.test(body) || original.has(body) : isComment || ordered || REPLACED_TOKENS.test(body)
      if (!ok) stray.push(`${path.split('/')[3]}: ${line.slice(0, 90)}`)
    }
  }
  check('H08', 'Only own-scope predicate lines changed', stray.length === 0, stray.length === 0 ? 'every added or removed line of the corrected suites is an own-scope definition or use, a comment, or the A6.6 ORDER BY' : `unexpected: ${stray.slice(0, 4).join(' | ')}`)

  // ---------------------------------------------------------------- equivalence and the later-phase rule (H09–H12)
  section('Own-branch equivalence by construction; the later-phase rule is derived only from committed migrations and conceals nothing')
  const missing: string[] = []
  for (const { suite, branchConst, kind } of CORRECTED) {
    const code = textAt('HEAD', suiteFile(suite))
    const need = (text: string) => {
      if (!code.includes(text)) missing.push(`${suite}: ${text.slice(0, 60)}`)
    }
    if (kind === 'a610') {
      need(A610_MERGE)
      need(A610_RULE)
      continue
    }
    need(OWN_MERGE(branchConst))
    need(OWN_RANGE)
    need(OWN_CHANGED)
    if (kind === 'bundled') [OWN_BASE, OWN_TIP].forEach(need)
    if (kind === 'late') [OWN_PRISMA, OWN_HEAD_DIRS, OWN_BASE_DIRS, LATER_RULE].forEach(need)
    if (suite === 'a7-phase-closure') need(A710_TREE)
    if ((code.match(/const ownMerge = /g) ?? []).length !== 1) missing.push(`${suite}: ownMerge defined ${(code.match(/const ownMerge = /g) ?? []).length} times`)
  }
  check('H09', 'Own branch: each predicate is the original', missing.length === 0, missing.length === 0 ? "every own-scope value is defined once from ownMerge = (own branch ? '' : its merge), and with '' it is literally the original: origin/main...HEAD, origin/main, HEAD, the head/base migration lists, the same diff, and no later-phase table" : `not as stated: ${missing.slice(0, 3).join(' | ')}`)
  check(
    'H10',
    'Later-phase tables come only from git',
    missing.filter((m) => /laterPhaseTables/.test(m)).length === 0 && CORRECTED.filter((c) => c.kind === 'late' || c.kind === 'a610').every((c) => !/laterPhaseTables[^\n]*(prisma|information_schema|pg_)/.test(textAt('HEAD', suiteFile(c.suite)))),
    "the excluded set is computed only from migration files committed after the package's own merge (never from the database, a table name or a list); a table no committed migration creates is never excluded",
  )
  // At this HEAD: what each suite excludes, intersected with the names its boundary prohibits.
  const liveTables = (await prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public'`).map((r) => r.t)
  const concealed: string[] = []
  const report: string[] = []
  for (const { suite, branchConst, kind } of CORRECTED.filter((c) => c.kind === 'late' || c.kind === 'a610')) {
    const code = textAt('HEAD', suiteFile(suite))
    const ownBranch = (code.match(new RegExp(`^const ${branchConst} = '([^']+)'`, 'm')) ?? [])[1] ?? ''
    const merge = ownBranch && branch !== ownBranch ? mergeOf(ownBranch) : ''
    const excluded = [...laterPhaseTablesAfter(merge)]
    const boundary = [...code.matchAll(/laterTables = \(await prisma\.\$queryRaw[^`]*`[^`]*table_name ~\* '([^']+)'/g)].map((m) => new RegExp(m[1], 'i'))
    if (suite !== 'a7-phase-closure' && boundary.length === 0) concealed.push(`${suite}: its boundary pattern could not be read`)
    const prohibitedExcluded = suite === 'a7-phase-closure' ? excluded.filter((t) => liveTables.includes(t)) : excluded.filter((t) => boundary.some((re) => re.test(t)))
    report.push(`${suite}: ${excluded.length} excluded`)
    concealed.push(...prohibitedExcluded.map((t) => `${suite}: ${t}`))
  }
  check('H11', 'Exclusions conceal nothing at this HEAD', concealed.length === 0, concealed.length === 0 ? `no excluded table matches a boundary the suite enforces (${report.join('; ')}); every live table is judged exactly as on the package's own branch` : `concealed: ${concealed.join(', ')}`)
  // A prohibited-looking table that no committed migration creates (DDL inside a transaction that is always rolled
  // back) is still judged by every corrected boundary: the rule cannot be used to hide a table.
  const probe = `remittance_payment_probe_${Date.now()}`
  const excludedByAnySuite = new Set(
    CORRECTED.filter((c) => c.kind === 'late' || c.kind === 'a610').flatMap((c) => {
      const ownBranch = (textAt('HEAD', suiteFile(c.suite)).match(new RegExp(`^const ${c.branchConst} = '([^']+)'`, 'm')) ?? [])[1] ?? ''
      return [...laterPhaseTablesAfter(ownBranch ? mergeOf(ownBranch) : '')]
    }),
  )
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
  const probeJudged = !excludedByAnySuite.has(probe)
  const probeGone = (await prisma.$queryRawUnsafe<{ t: string }[]>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`, probe)).length === 0
  check('H12', 'A table without a migration is never excluded', probeOutcome === 'ROLLED_BACK' && probeSeen && probeJudged && probeGone, `a live table ${probe} created outside any migration (rolled back) is excluded by no corrected suite, so its prohibited name would fail their boundary checks; nothing remains`)

  // ---------------------------------------------------------------- full nested chain (H13–H18)
  section('Full nested chain — A7.10 invoked, nesting A7.9 -> … -> A7.1 -> A6.10 -> … -> A1')
  if (((await fetch(`${baseUrl}/api/ready`).catch(() => null))?.status ?? 0) !== 200) throw new RunAborted(`the API at ${baseUrl} is not ready; start it with \`npm start\` and run this suite again`)
  const chain = run('npm run test:a7:phase-closure')
  const nestedLog = `hc-nested-${runId}.log`
  writeFileSync(nestedLog, chain.output)
  const rows = suiteLines(chain.output, 'A7.10')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  const lineOfRow = (id: string) => rows.find((row) => row.id === id)?.line ?? ''
  const titleOf = (text: string) => text.slice('[A7.10] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  const ran = rows.some((row) => row.id === 'T130') && !/\[A7\.10\] RUN ABORTED|\[A7\.10\] uncaught error|\[A7\.10\] INVALID RUN/.test(chain.output)
  const summary = chain.output.match(/\[A7\.10\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = summary ? Number(summary[2]) - Number(summary[1]) : -1
  // A7.10's checks about its own branch: obsolete on any other branch by design, each proved below for its cause.
  const a710NonApplicable: Record<string, string> = {
    T001: "A7.10 'A7.9 exact merge ancestor confirmed' requires the A7.10 feature branch; this branch is cut from the main that contains the A7.10 merge (H01)",
    T002: "A7.10 'Clean synchronized HEAD, origin parity' requires tracking origin/feature/a7-10-…, deleted when it merged; THIS branch's clean tree and parity are proved by H02",
    T010: "A7.10 'Allowed diff, migrations unchanged' lists the paths A7.10 was allowed to change; this branch's exact scope is proved by H03 and H04",
    T111: "A7.10 'All prior branch-only N/A justified' proves A7.9's branch-only causes against the A7.10 branch; here they are re-proved against this branch (H17)",
    T122: "A7.10 'Git tree clean, branch matches origin' compares HEAD with origin/feature/a7-10-…, deleted when it merged; THIS branch's are proved by H02 and H18",
    T123: "A7.10 'Independent run ID at exact HEAD' compares HEAD with origin/feature/a7-10-…, deleted when it merged; THIS run's identity and pushed HEAD are proved by H18",
    T130: "A7.10 'Final summary 130/130; no hidden failures' holds only when none of its own checks failed; exactly the branch-only items above fail, so it fails by construction (proved by count in H17)",
  }
  for (const text of lines(chain.output).filter((l) => / \.{3,} FAIL|RUN ABORTED|uncaught error|INVALID RUN/.test(l))) progress(`nested: ${text.slice(0, 400)}`)
  const undocumented = failing.filter((id) => !(id in a710NonApplicable))
  const substantivePassing = rows.filter((row) => !row.id.includes('/') && row.verdict === 'PASS').length
  check(
    'H13',
    'A7.10 every substantive check PASS',
    ran && failedCount === failing.length && undocumented.length === 0 && substantivePassing === 130 - failing.length && substantivePassing >= 123,
    !ran ? 'the A7.10 suite did not complete' : undocumented.length > 0 ? `undocumented A7.10 failures: ${undocumented.join(', ')}` : `A7.10 ${summary?.[1]}/${summary?.[2]}: every one of its ${substantivePassing} substantive checks PASS; its only failures are the documented branch-only items`,
  )
  for (const id of Object.keys(a710NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) notApplicableCheck(`H13/${id}`, `A7.10 ${titleOf(row.line)}`, a710NonApplicable[id])
  }
  check('H14', 'A7.9 → A7.1 substantive regressions PASS', ['T101', 'T102', 'T103', 'T104', 'T105', 'T106', 'T107', 'T108', 'T109'].every((id) => verdictOf(id) === 'PASS'), `A7.10 T101–T109 (A7.9 with its own justified N/A, A7.8 … A7.1): ${['T101', 'T102', 'T103', 'T104', 'T105', 'T106', 'T107', 'T108', 'T109'].map(verdictOf).join('/')}`)
  check('H15', 'A6.10 → A1 substantive chain PASS', verdictOf('T110') === 'PASS' && verdictOf('T112') === 'PASS', `A7.10 T110 (A6.10 → A6.1 → A5 → A1) ${verdictOf('T110')}; T112 (every unit suite) ${verdictOf('T112')}`)
  check('H16', 'Units, typecheck, build, replay, outage, warnings', ['T112', 'T113', 'T114', 'T115', 'T116', 'T117', 'T118', 'T119', 'T120', 'T121'].every((id) => verdictOf(id) === 'PASS'), `A7.10 T112–T121: ${['T112', 'T113', 'T114', 'T115', 'T116', 'T117', 'T118', 'T119', 'T120', 'T121'].map(verdictOf).join('/')}`)
  // Each documented A7.10 failure must fail for its branch-only reason, proved independently here.
  const a710Unexpected = (lineOfRow('T010').match(/unexpected: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const unprovenA79 = (lineOfRow('T111').match(/cause not proven for: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const originOf = (name: string) => gitArgs(['rev-parse', '--verify', '--quiet', `origin/${name}`])
  const originFix = originOf(fixBranch)
  const a710SelfCount = Number((lineOfRow('T130').match(/(\d+) of the 129 checks before this one PASS/) ?? [])[1] ?? -1)
  const causes: Record<string, boolean> = {
    T001: branch === fixBranch && a710Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a710Merge} HEAD`),
    T002: dirty.length === 0 && tracking.includes(`origin/${fixBranch}`) && !/ahead|behind/.test(tracking),
    T010: a710Unexpected.length > 0 && a710Unexpected.every((path, index) => changedPaths.includes(path) || (path === 'package.json beyond the one script' && changedPaths.includes('backend/package.json')) || (index === a710Unexpected.length - 1 && changedPaths.some((p) => p.startsWith(path)))) && outOfScope.length === 0,
    T111: unprovenA79.length > 0 && unprovenA79.every((id) => ['T001', 'T002', 'T010', 'T120', 'T130'].includes(id)) && originOf(a79Branch) === '' && originOf(a78Branch) === '' && tracking.includes(`origin/${fixBranch}`) && outOfScope.length === 0,
    T122: originOf(a710Branch) === '' && originFix === headAtStart && headAtStart.length === 40,
    T123: originOf(a710Branch) === '' && originFix === headAtStart,
    T130: a710SelfCount === 129 - (failing.length - 1) && failing.every((id) => id in a710NonApplicable),
  }
  const unproven = failing.filter((id) => id in causes && !causes[id])
  const naLines = lines(chain.output).filter((line) => /^\[A7\.10\] T101\/T\d+ .* N\/A {2}- \S/.test(line))
  check(
    'H17',
    'Every A7.10 failure proved branch-only',
    ran && failing.every((id) => id in a710NonApplicable) && unproven.length === 0 && naLines.length === 5 && naLines.every((line) => line.length > 80),
    unproven.length === 0 ? `each A7.10 failure (${failing.join(', ') || 'none'}) is printed with its reason and fails only for its branch-only cause, proved here; A7.10 itself justifies its five A7.9 items (${naLines.length} lines)` : `cause not proven for: ${unproven.join(', ')}`,
  )

  // ---------------------------------------------------------------- exact head (H18)
  const headNow = git('rev-parse HEAD')
  check(
    'H18',
    'Exact HEAD, clean origin, nested output kept',
    headNow === headAtStart && headNow === originFix && git('status --porcelain') === '' && existsSync(nestedLog) && /^HC-\d{13}$/.test(runId),
    `all evidence corresponds to ${headNow} (= origin/${fixBranch}); fresh run ${runId}; full nested output in backend/${nestedLog} (${chain.output.length} chars, SHA-256 ${sha256Of(chain.output).slice(0, 16)}…)`,
  )

  say(`\n[${TAG}] run ${runId} — HEAD ${headNow}`)
  if (failures.length > 0) {
    say(`[${TAG}] ${failures.length} FAILED:`)
    for (const failure of failures) say(`          ${failure}`)
  }
  if (notApplicable > 0) say(`[${TAG}] ${notApplicable} nested A7.10 branch-only item(s) reported N/A, each proved for its cause by H17 (never a substantive check)`)
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
