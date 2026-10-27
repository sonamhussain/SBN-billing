import { CASE_CONTRACT_VERSION, assemblyCodes } from '../evidence-case/evidence-case.types.ts'
import { BASIS_OF, PREREQ_CONTRACT_VERSION, assessmentCodes, type AssessmentCode, type BasisCode } from '../case-prerequisite/case-prerequisite.types.ts'
import { TIMELINE_CONTRACT_VERSION } from '../revenue-timeline/revenue-timeline.types.ts'
import type { Comparison, DeltaResult, EvidenceDeltaCode, PrerequisiteState, TimelineCaseFacts, TimelineEntryFacts, TimelineFacts } from './revenue-delta.types.ts'

// A7.8 §4 — the one pure, deterministic delta reducer. It reads ONE accepted A7.7 timeline exactly as the A7.7 owner
// returned it and compares each adjacent pair's recorded summaries; it never rebuilds the correction graph, re-reads
// an owner, re-assesses, creates a trace, or reads a clock, locale, time zone, environment, database, network,
// randomness or money. Order comes only from the timeline's own ordinals and predecessor links.
//
// Fail closed (a provenance conflict, no partial delta) when the timeline disagrees with itself: another or a future
// A7.7 contract, a chain code that does not fit the entry count, a wrong historyCount, ordinals that are not exactly
// 1..N, a repeated freeze, a root with a predecessor or link, a successor whose predecessor is not the entry before it
// or that has no link, a repeated link, a freeze instant that does not strictly increase; more than one case for a
// freeze, a case under another contract, with an uncontrolled code, an invalid count or a malformed digest; an
// assessment without its case, of another case, under another contract, more than one per case, with an uncontrolled
// code/basis pair or a digest that is not its case's.
//
// §4 — the stable compared case fields: assemblyCode, sourceCount, classifiedCount, readinessCount, itemCount,
// manifestSha256 (and the contract). The assessment is shown on each side but does not decide the code.

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const digestShape = /^[0-9a-f]{64}$/
const instantShape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0
const conflict = (detail: string): DeltaResult => ({ ok: false, refusal: 'PROVENANCE_CONFLICT', detail })

type Side = { entry: TimelineEntryFacts; summary: TimelineCaseFacts | null; prerequisite: { id: string; state: PrerequisiteState } | null }

// One entry's case and assessment, validated; a string is the reason it is refused.
function sideOf(entry: TimelineEntryFacts): Side | string {
  if (entry.caseSummaries.length > 1) return 'a frozen submission lists more than one case'
  const summary = entry.caseSummaries[0] ?? null
  if (summary) {
    if (summary.contractVersion !== CASE_CONTRACT_VERSION) return 'a case is under an unsupported contract version'
    if (!uuidShape.test(summary.caseId)) return 'a case id is not canonical'
    if (!(assemblyCodes as readonly string[]).includes(summary.assemblyCode)) return 'a case carries an uncontrolled assembly code'
    if (![summary.sourceCount, summary.classifiedCount, summary.readinessCount, summary.itemCount].every(isCount)) return 'a case carries an invalid count'
    if (!digestShape.test(summary.manifestSha256)) return 'a case carries a malformed digest'
  }
  if (entry.prerequisiteSummaries.length > 1) return 'a case lists more than one assessment'
  const assessment = entry.prerequisiteSummaries[0] ?? null
  if (!assessment) return { entry, summary, prerequisite: null }
  if (!summary) return 'an assessment is listed for a frozen submission with no case'
  if (assessment.caseId !== summary.caseId) return 'an assessment belongs to another case'
  if (assessment.contractVersion !== PREREQ_CONTRACT_VERSION) return 'an assessment is under an unsupported contract version'
  if (!uuidShape.test(assessment.assessmentId)) return 'an assessment id is not canonical'
  if (!(assessmentCodes as readonly string[]).includes(assessment.assessmentCode) || assessment.basisCode !== BASIS_OF[assessment.assessmentCode as AssessmentCode])
    return 'an assessment carries an uncontrolled outcome/basis pair'
  if (assessment.caseManifestSha256 !== summary.manifestSha256) return "an assessment digest is not its case's digest"
  return { entry, summary, prerequisite: { id: assessment.assessmentId, state: { assessmentCode: assessment.assessmentCode as AssessmentCode, basisCode: assessment.basisCode as BasisCode } } }
}

function deltaCodeOf(before: TimelineCaseFacts | null, after: TimelineCaseFacts | null): EvidenceDeltaCode {
  if (!before && !after) return 'BOTH_ABSENT'
  if (!before) return 'NEW_CASE_RECORDED'
  if (!after) return 'CASE_NO_LONGER_RECORDED'
  const sameSummary =
    before.contractVersion === after.contractVersion &&
    before.assemblyCode === after.assemblyCode &&
    before.sourceCount === after.sourceCount &&
    before.classifiedCount === after.classifiedCount &&
    before.readinessCount === after.readinessCount &&
    before.itemCount === after.itemCount &&
    before.manifestSha256 === after.manifestSha256
  return sameSummary ? 'RECORDED_SUMMARY_UNCHANGED' : 'RECORDED_SUMMARY_CHANGED'
}

export function deriveRevenueDelta(timeline: TimelineFacts): DeltaResult {
  const entries = timeline.submissions
  if (timeline.contractVersion !== TIMELINE_CONTRACT_VERSION) return conflict('the timeline is not an A7-REVENUE-TIMELINE-1 projection')
  if (!uuidShape.test(timeline.claimId)) return conflict('the timeline names no canonical claim')
  if ((timeline.chainCode === 'NO_FROZEN_SUBMISSION') !== (entries.length === 0) || !['NO_FROZEN_SUBMISSION', 'LINEAR_HISTORY'].includes(timeline.chainCode))
    return conflict('the timeline chain code does not fit its entries')
  if (timeline.historyCount !== entries.length) return conflict('the timeline history count does not fit its entries')

  // The chain exactly as listed: ordinals 1..N, the root without predecessor or link, every successor linked to the
  // entry before it, strictly increasing freeze instants.
  const freezes = new Set<string>()
  const links = new Set<string>()
  const sides: Side[] = []
  for (const [index, entry] of entries.entries()) {
    if (entry.ordinal !== index + 1) return conflict('the timeline ordinals are not exactly 1..N')
    if (!uuidShape.test(entry.claimSubmissionId) || freezes.has(entry.claimSubmissionId)) return conflict('a frozen submission is not canonical or is listed twice')
    freezes.add(entry.claimSubmissionId)
    if (!instantShape.test(entry.frozenAt)) return conflict('a freeze instant is not a canonical UTC instant')
    if (index === 0) {
      if (entry.priorSubmissionId !== null || entry.correctionLinkId !== null) return conflict('the root has a predecessor or a correction link')
    } else {
      const previous = entries[index - 1]
      if (entry.priorSubmissionId !== previous.claimSubmissionId) return conflict("a successor's predecessor is not the entry before it")
      if (entry.correctionLinkId === null || !uuidShape.test(entry.correctionLinkId) || links.has(entry.correctionLinkId)) return conflict('a successor has no correction link, or a link is repeated')
      links.add(entry.correctionLinkId)
      if (!(entry.frozenAt > previous.frozenAt)) return conflict('a correction is not frozen strictly after its predecessor')
    }
    const side = sideOf(entry)
    if (typeof side === 'string') return conflict(side)
    sides.push(side)
  }

  const comparisons: Comparison[] = sides.slice(1).map((after, index) => {
    const before = sides[index]
    return {
      ordinal: index + 1,
      predecessorSubmissionId: before.entry.claimSubmissionId,
      correctedSubmissionId: after.entry.claimSubmissionId,
      correctionLinkId: after.entry.correctionLinkId as string,
      predecessorFrozenAt: before.entry.frozenAt,
      correctedFrozenAt: after.entry.frozenAt,
      predecessorCaseId: before.summary?.caseId ?? null,
      correctedCaseId: after.summary?.caseId ?? null,
      predecessorAssessmentId: before.prerequisite?.id ?? null,
      correctedAssessmentId: after.prerequisite?.id ?? null,
      evidenceDeltaCode: deltaCodeOf(before.summary, after.summary),
      sourceCountBefore: before.summary?.sourceCount ?? null,
      sourceCountAfter: after.summary?.sourceCount ?? null,
      classifiedCountBefore: before.summary?.classifiedCount ?? null,
      classifiedCountAfter: after.summary?.classifiedCount ?? null,
      readinessCountBefore: before.summary?.readinessCount ?? null,
      readinessCountAfter: after.summary?.readinessCount ?? null,
      prerequisiteBefore: before.prerequisite?.state ?? null,
      prerequisiteAfter: after.prerequisite?.state ?? null,
      predecessorCaseManifestSha256: before.summary?.manifestSha256 ?? null,
      correctedCaseManifestSha256: after.summary?.manifestSha256 ?? null,
    }
  })
  const baselineCode = entries.length === 0 ? 'NO_FROZEN_SUBMISSION' : entries.length === 1 ? 'SINGLE_FREEZE' : 'COMPARABLE_HISTORY'
  return { ok: true, value: { baselineCode, comparisons } }
}
