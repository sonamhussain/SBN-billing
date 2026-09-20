import { spawnSync } from 'node:child_process'
import { prisma } from '../../shared/database/prisma.ts'

// A3.10 — the only support file for the cumulative acceptance harness (package §8). It holds the
// result reporter, the child-process runner that invokes the ALREADY MERGED owner suites, and the
// small synthetic commercial-chain fixture that no existing shared helper provides. It contains no
// resolution, applicability, compatibility or provenance logic: every such truth is asked of its
// owning module.

export type Outcome = 'PASS' | 'FAIL' | 'EXCEPTION'

type Result = { id: string; title: string; outcome: Outcome; detail: string }

export function createReport() {
  const results: Result[] = []

  function record(id: string, title: string, outcome: Outcome, detail = '') {
    results.push({ id, title, outcome, detail })
    const dots = '.'.repeat(Math.max(3, 46 - title.length))
    console.log(`[A3.10] ${id} ${title} ${dots} ${outcome}${detail ? ` - ${detail}` : ''}`)
  }

  // A case only passes when the condition actually held; nothing is assumed (§18).
  function check(id: string, title: string, condition: boolean, detail = '') {
    record(id, title, condition ? 'PASS' : 'FAIL', detail)
    return condition
  }

  // An environment-limited case is labelled, never counted as PASS (§18).
  function exception(id: string, title: string, detail: string) {
    record(id, title, 'EXCEPTION', detail)
  }

  function section(title: string) {
    console.log(`\n[A3.10] ${title}`)
  }

  function finish(runId: string, headAtStart: string, headAtEnd: string) {
    const passed = results.filter((r) => r.outcome === 'PASS').length
    const failed = results.filter((r) => r.outcome === 'FAIL')
    const exceptions = results.filter((r) => r.outcome === 'EXCEPTION')
    console.log(`\n[A3.10] run ${runId} — HEAD at start ${headAtStart}, HEAD at end ${headAtEnd}`)
    if (exceptions.length > 0) {
      console.log(`[A3.10] ${exceptions.length} EXCEPTION (manual proof required, not counted as PASS):`)
      for (const item of exceptions) console.log(`          ${item.id} ${item.title} — ${item.detail}`)
    }
    if (failed.length > 0) {
      console.log(`[A3.10] ${failed.length} FAILED:`)
      for (const item of failed) console.log(`          ${item.id} ${item.title} ${item.detail}`)
    }
    console.log(`[A3.10] automated summary: ${passed}/${results.length} PASS` + (exceptions.length > 0 ? ` (${exceptions.length} EXCEPTION)` : ''))
    if (failed.length > 0 || headAtStart !== headAtEnd) {
      console.log('[A3.10] A3.10 FINAL FAIL')
      process.exitCode = 1
    } else {
      console.log('[A3.10] A3.10 ACCEPTANCE COMPLETE')
    }
  }

  return { check, exception, record, section, finish, results }
}

// Only trailing whitespace is removed: `git status --porcelain` encodes the state in the first two
// columns, so a leading space is data, not padding.
export function git(args: string): string {
  const out = spawnSync('git', args.split(' '), { cwd: process.cwd(), encoding: 'utf8', shell: true })
  return (out.stdout ?? '').replace(/\s+$/, '')
}

export function gitOk(args: string): boolean {
  return spawnSync('git', args.split(' '), { cwd: process.cwd(), encoding: 'utf8', shell: true }).status === 0
}

export type SuiteRun = { script: string; ok: boolean; summary: string; seconds: number }

// Invokes an existing merged npm script as a child process and reports its real result (§8, §16).
// Nothing of the child suite is reimplemented here; only its exit code and summary line are read.
export function runSuite(script: string, cwd?: string): SuiteRun {
  const started = Date.now()
  const out = spawnSync('npm', ['run', script], { cwd: cwd ?? process.cwd(), encoding: 'utf8', shell: true })
  const text = `${out.stdout ?? ''}\n${out.stderr ?? ''}`
  const summaryLine =
    text
      .split(/\r?\n/)
      .filter((line) => /passed,\s*\d+ failed|ALL CHECKS PASS|automated summary|CHECKS FAILED|ℹ (pass|fail)|up to date|is valid|built in|Generated Prisma Client/.test(line))
      .slice(-2)
      .join(' | ')
      .trim() || text.split(/\r?\n/).filter(Boolean).slice(-1)[0] || ''
  return { script, ok: out.status === 0, summary: summaryLine.slice(0, 160), seconds: Math.round((Date.now() - started) / 100) / 10 }
}

// A repository-wide regex search without a shell: on Windows a shell mangles the alternation
// characters, which would make an "absent" result meaningless.
export function gitGrep(pattern: string, paths: string[]): { matched: boolean; files: string[]; failed: string | null } {
  const out = spawnSync('git', ['grep', '-liE', pattern, '--', ...paths], { encoding: 'utf8', shell: false })
  const files = (out.stdout ?? '').split(/\r?\n/).filter(Boolean)
  // git grep exits 0 with matches, 1 with none; anything else means the search itself failed and
  // must not be reported as "nothing found".
  const failed = out.status === 0 || out.status === 1 ? null : `git grep failed (status ${out.status}): ${(out.stderr ?? '').slice(0, 120)}`
  return { matched: files.length > 0, files, failed }
}

export function runCommand(command: string, args: string[]): { ok: boolean; output: string } {
  const out = spawnSync(command, args, { encoding: 'utf8', shell: true })
  return { ok: out.status === 0, output: `${out.stdout ?? ''}${out.stderr ?? ''}`.trim() }
}

export async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 60_000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return false
}

export function d(text: string): Date {
  return new Date(`${text}T00:00:00.000Z`)
}

// The synthetic REF-01 commercial chain plus service/procedure/diagnosis masters. Written once
// here because no shared helper exposes it; it is plain fixture data, not business logic.
export async function commercialChain(organizationId: string, tag: string) {
  const payer = await prisma.payer.create({ data: { organizationId, displayName: `${tag} payer` } })
  const tpa = await prisma.tpa.create({ data: { organizationId, displayName: `${tag} tpa` } })
  const network = await prisma.network.create({ data: { organizationId, displayName: `${tag} network` } })
  const insuranceProduct = await prisma.insuranceProduct.create({
    data: { organizationId, payerId: payer.id, productCode: `${tag}-PROD`, displayName: `${tag} product` },
  })
  await prisma.productNetwork.create({ data: { insuranceProductId: insuranceProduct.id, networkId: network.id } })
  const providerContract = await prisma.providerContract.create({
    data: {
      organizationId,
      payerId: payer.id,
      tpaId: tpa.id,
      networkId: network.id,
      insuranceProductId: insuranceProduct.id,
      contractKey: `${tag}-CONTRACT`,
      displayName: `${tag} contract`,
      effectiveFrom: d('2020-01-01'),
    },
  })
  const tariffSchedule = await prisma.tariffSchedule.create({
    data: { providerContractId: providerContract.id, tariffKey: `${tag}-TARIFF`, displayName: `${tag} tariff` },
  })
  const tariffScheduleVersion = await prisma.tariffScheduleVersion.create({ data: { tariffScheduleId: tariffSchedule.id, version: '1' } })
  const service = await prisma.service.create({ data: { organizationId, internalCode: `${tag}-SVC`, displayName: `${tag} service` } })
  const procedureCode = await prisma.procedureCode.create({ data: { organizationId, internalCode: `${tag}-PROC`, displayName: `${tag} procedure` } })
  const diagnosisCode = await prisma.diagnosisCode.create({ data: { organizationId, code: `${tag}-DX`, displayName: `${tag} diagnosis` } })
  return { payer, tpa, network, insuranceProduct, providerContract, tariffSchedule, tariffScheduleVersion, service, procedureCode, diagnosisCode }
}

export async function attachFacilityToContract(providerContractId: string, facilityId: string) {
  return prisma.contractFacility.create({ data: { providerContractId, facilityId } })
}

// Read-only structural helpers (§14, §15): the database is only ever asked what it holds.
export async function hasConstraint(name: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_constraint WHERE conname = ${name}`
  return Number(rows[0].n) > 0
}

export async function hasIndex(name: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_indexes WHERE indexname = ${name}`
  return Number(rows[0].n) > 0
}

export async function hasTrigger(name: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_trigger WHERE tgname = ${name}`
  return Number(rows[0].n) > 0
}

export async function foreignKeyDeleteRules(table: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ confdeltype: string }[]>`
    SELECT confdeltype::text AS confdeltype FROM pg_constraint WHERE contype = 'f' AND conrelid = ${table}::regclass ORDER BY conname`
  return rows.map((row) => row.confdeltype)
}
