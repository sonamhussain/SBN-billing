import { CASE_CONTRACT_VERSION, assemblyCodes } from '../evidence-case/evidence-case.types.ts'
import { BASIS_OF, PREREQ_CONTRACT_VERSION, assessmentCodes, type AssessmentCode, type BasisCode } from '../case-prerequisite/case-prerequisite.types.ts'
import type { CaseSummary, ComposeResult, LinkFacts, PrerequisiteSummary, SubmissionEntry, TimelineFacts } from './revenue-timeline.types.ts'

// A7.7 §4 — the one pure, deterministic timeline composer. It reads the owners' STORED facts — every A6.7 freeze of
// the Claim, the A6.9 links in the checked order the A6.9 owner returned, every A7.4 case of each freeze and every
// A7.5 assessment of each case — and composes them; it never re-derives a case, an assessment or a trace, and reads
// no clock, locale, time zone, environment, database, network, randomness or money. Order comes only from confirmed
// chain edges, never from a time or identifier tie-breaker.
//
// Fail closed (a provenance conflict, no partial timeline) on any disagreement: a freeze or link of another Claim, a
// repeated freeze, a self-link, a fork, a join, a cycle, more than one root, a freeze no link reaches, an A6.9 order
// that is not the edge order, a correction not frozen strictly after its prior (an equal instant included); a case
// of another freeze or organization, under another contract, or a second v1 case for one freeze; an assessment of
// another case or organization, under another contract, a second v1 assessment for one case, a digest that is not its
// case's, or an uncontrolled code/basis pair.

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const digestShape = /^[0-9a-f]{64}$/
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0
const conflict = (detail: string): ComposeResult => ({ ok: false, refusal: 'PROVENANCE_CONFLICT', detail })

// Only the fixed contract keys order summaries: contract, then immutable id (a plain code-unit comparison, so no
// locale can change it).
const byContractThenId = <T extends { contractVersion: string }>(id: (item: T) => string) => (a: T, b: T) =>
  a.contractVersion < b.contractVersion ? -1 : a.contractVersion > b.contractVersion ? 1 : id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0

export function composeTimeline(facts: TimelineFacts): ComposeResult {
  const { claimId, organizationId, freezes, links, cases, assessments } = facts

  // The freezes: all of exactly this Claim, each once, each with a known instant.
  const freezeById = new Map(freezes.map((freeze) => [freeze.submissionId, freeze]))
  if (freezeById.size !== freezes.length) return conflict('a frozen submission is listed twice')
  if (freezes.some((freeze) => freeze.claimId !== claimId || !uuidShape.test(freeze.submissionId) || !Number.isFinite(freeze.frozenAtMicros)))
    return conflict('a frozen submission belongs to another claim or has no known freeze instant')

  // The chain: one root, one edge out and in per freeze, every freeze reached, edges in the A6.9 order.
  const byPrior = new Map<string, LinkFacts>()
  const byCorrected = new Map<string, LinkFacts>()
  for (const link of links) {
    if (link.claimId !== claimId) return conflict('a correction link belongs to another claim')
    if (link.priorSubmissionId === link.correctedSubmissionId) return conflict('a correction link corrects a freeze with itself')
    if (!freezeById.has(link.priorSubmissionId) || !freezeById.has(link.correctedSubmissionId)) return conflict("a correction link names a freeze that is not this claim's")
    if (byPrior.has(link.priorSubmissionId)) return conflict('a freeze is corrected twice (fork)')
    if (byCorrected.has(link.correctedSubmissionId)) return conflict('a freeze corrects two freezes (join)')
    byPrior.set(link.priorSubmissionId, link)
    byCorrected.set(link.correctedSubmissionId, link)
  }
  if (freezes.length === 0) {
    if (links.length > 0 || cases.length > 0 || assessments.length > 0) return conflict('history exists for a claim with no frozen submission')
    return { ok: true, value: { chainCode: 'NO_FROZEN_SUBMISSION', submissions: [] } }
  }
  const roots = freezes.filter((freeze) => !byCorrected.has(freeze.submissionId))
  if (roots.length === 0) return conflict('the correction links form a cycle')
  if (roots.length > 1) return conflict('the claim has more than one root: an unlinked freeze or a second chain')
  const order: string[] = []
  const edges: (LinkFacts | null)[] = []
  for (let current: string | undefined = roots[0].submissionId, edge: LinkFacts | null = null; current !== undefined; ) {
    if (order.includes(current)) return conflict('the correction links form a cycle')
    order.push(current)
    edges.push(edge)
    const next: LinkFacts | undefined = byPrior.get(current)
    if (next) {
      const prior = freezeById.get(next.priorSubmissionId)
      const corrected = freezeById.get(next.correctedSubmissionId)
      if (!prior || !corrected || corrected.frozenAtMicros <= prior.frozenAtMicros) return conflict('a correction was not frozen strictly after the freeze it corrects')
    }
    edge = next ?? null
    current = next?.correctedSubmissionId
  }
  if (order.length !== freezes.length) return conflict('a freeze is not reached by the correction chain')
  const walked = edges.filter((edge): edge is LinkFacts => edge !== null).map((edge) => edge.correctionLinkId)
  if (walked.length !== links.length || walked.some((id, index) => links[index].correctionLinkId !== id)) return conflict('the A6.9 chain order disagrees with its edges')

  // The cases: v1 only, of exactly one of these freezes and this organization, at most one per freeze.
  const casesOf = new Map<string, CaseSummary[]>()
  const caseById = new Map<string, CaseSummary>()
  for (const item of cases) {
    if (!freezeById.has(item.claimSubmissionId)) return conflict('a case belongs to a freeze that is not this claim\'s')
    if (item.organizationId !== organizationId) return conflict('a case belongs to another organization')
    if (item.contractVersion !== CASE_CONTRACT_VERSION) return conflict('a case is under an unsupported contract version')
    if (!uuidShape.test(item.caseId) || caseById.has(item.caseId)) return conflict('a case id is not canonical or is listed twice')
    if (!(assemblyCodes as readonly string[]).includes(item.assemblyCode)) return conflict('a case carries an uncontrolled assembly code')
    if (![item.sourceCount, item.classifiedCount, item.readinessCount, item.itemCount].every(isCount) || !digestShape.test(item.manifestSha256)) return conflict('a case carries an invalid count or digest')
    const list = casesOf.get(item.claimSubmissionId) ?? []
    if (list.some((other) => other.contractVersion === item.contractVersion)) return conflict('a freeze has more than one case under one contract')
    const summary: CaseSummary = {
      caseId: item.caseId,
      contractVersion: item.contractVersion,
      assemblyCode: item.assemblyCode,
      sourceCount: item.sourceCount,
      classifiedCount: item.classifiedCount,
      readinessCount: item.readinessCount,
      itemCount: item.itemCount,
      manifestSha256: item.manifestSha256,
    }
    list.push(summary)
    casesOf.set(item.claimSubmissionId, list)
    caseById.set(item.caseId, summary)
  }

  // The assessments: v1 only, of exactly one of these cases and this organization, at most one per case, carrying
  // their case's digest and a controlled outcome with its own basis.
  const assessmentsOf = new Map<string, PrerequisiteSummary[]>()
  const assessmentIds = new Set<string>()
  for (const item of assessments) {
    const ofCase = caseById.get(item.caseId)
    if (!ofCase) return conflict('an assessment belongs to a case that is not one of this claim\'s')
    if (item.organizationId !== organizationId) return conflict('an assessment belongs to another organization')
    if (item.contractVersion !== PREREQ_CONTRACT_VERSION) return conflict('an assessment is under an unsupported contract version')
    if (!uuidShape.test(item.assessmentId) || assessmentIds.has(item.assessmentId)) return conflict('an assessment id is not canonical or is listed twice')
    if (!(assessmentCodes as readonly string[]).includes(item.assessmentCode) || item.basisCode !== BASIS_OF[item.assessmentCode as AssessmentCode]) return conflict('an assessment carries an uncontrolled outcome/basis pair')
    if (item.caseManifestSha256 !== ofCase.manifestSha256) return conflict("an assessment digest is not its case's digest")
    const list = assessmentsOf.get(item.caseId) ?? []
    if (list.some((other) => other.contractVersion === item.contractVersion)) return conflict('a case has more than one assessment under one contract')
    assessmentIds.add(item.assessmentId)
    list.push({ assessmentId: item.assessmentId, caseId: item.caseId, contractVersion: item.contractVersion, assessmentCode: item.assessmentCode as AssessmentCode, basisCode: item.basisCode as BasisCode, caseManifestSha256: item.caseManifestSha256 })
    assessmentsOf.set(item.caseId, list)
  }

  const submissions: SubmissionEntry[] = order.map((submissionId, index) => {
    const freezeCases = [...(casesOf.get(submissionId) ?? [])].sort(byContractThenId((c) => c.caseId))
    const freezeAssessments = freezeCases.flatMap((c) => [...(assessmentsOf.get(c.caseId) ?? [])].sort(byContractThenId((a) => a.assessmentId)))
    const edge = edges[index]
    return {
      ordinal: index + 1,
      claimSubmissionId: submissionId,
      priorSubmissionId: edge?.priorSubmissionId ?? null,
      correctionLinkId: edge?.correctionLinkId ?? null,
      frozenAt: (freezeById.get(submissionId) as TimelineFacts['freezes'][number]).frozenAt,
      caseSummaries: freezeCases,
      prerequisiteSummaries: freezeAssessments,
    }
  })
  return { ok: true, value: { chainCode: 'LINEAR_HISTORY', submissions } }
}
