import { CASE_CONTRACT_VERSION, assemblyCodes } from '../evidence-case/evidence-case.types.ts'
import { BASIS_OF, PREREQ_CONTRACT_VERSION, assessmentCodes, type AssessmentCode } from '../case-prerequisite/case-prerequisite.types.ts'
import { TIMELINE_CONTRACT_VERSION } from '../revenue-timeline/revenue-timeline.types.ts'
import { DELTA_CONTRACT_VERSION, evidenceDeltaCodes } from '../revenue-delta/revenue-delta.types.ts'
import type { TimelineCaseFacts, TimelineEntryFacts, TimelinePrerequisiteFacts } from '../revenue-delta/revenue-delta.types.ts'
import type { ContinuityCode, ContinuityResult, DeltaFacts, Gap, GapCode, TimelineFacts } from './revenue-continuity.types.ts'

// A7.9 §4 — the one pure, deterministic continuity reducer. It reads ONE accepted A7.7 timeline and ONE accepted A7.8
// delta exactly as their owners returned them, proves that they describe the same history, and reports one controlled
// gap per frozen submission. It never rebuilds the correction graph, a timeline or a delta, re-reads an owner,
// re-assesses, creates a trace, sorts, or reads a clock, locale, time zone, environment, database, network, randomness
// or money. Order comes only from the timeline's own ordinals and predecessor links.
//
// Fail closed (a provenance conflict, no partial result) when:
// - either owner is under another or a future contract, or they name different or non-canonical Claims;
// - the timeline disagrees with itself: a chain code or historyCount that does not fit, ordinals that are not exactly
//   1..N, a repeated freeze, a root with a predecessor or link, a successor not linked to the entry before it, a
//   repeated link; more than one case or assessment for a freeze, a case under another contract, with an uncontrolled
//   code, invalid count or malformed digest; an assessment without its case, of another case, under another contract,
//   with an uncontrolled outcome/basis pair or a digest that is not its case's;
// - the delta disagrees with the timeline: a baseline that does not fit the entry count, a comparison count that is
//   not max(0, N - 1), a missing, duplicated, reversed or reordered pair, another link, freeze, instant, case,
//   assessment, digest or count than the consecutive entries record, or an uncontrolled delta code.
//
// §3 — gap mapping, from the exact stored facts only (never from a delta code):
//   no case                                   -> CASE_NOT_RECORDED
//   case, no assessment                        -> PREREQUISITE_NOT_RECORDED
//   A7.5 NO_SOURCE_BASIS                       -> NO_SOURCE_BASIS
//   A7.5 INCOMPLETE_SOURCE_CHAIN               -> SOURCE_CHAIN_INCOMPLETE
//   A7.5 REVIEW_REQUIRED                       -> REVIEW_REQUIRED
//   A7.5 UNSUPPORTED_SOURCE_BASIS              -> UNSUPPORTED_SOURCE
//   A7.5 EXTERNAL_FINANCIAL_EVIDENCE_ABSENT    -> EXTERNAL_FINANCIAL_EVIDENCE_ABSENT
// The timeline admits at most one case and one assessment per freeze, so each freeze has exactly one gap and the
// fixed gap precedence never has to break a tie.

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const digestShape = /^[0-9a-f]{64}$/
const instantShape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0
const conflict = (detail: string): ContinuityResult => ({ ok: false, refusal: 'PROVENANCE_CONFLICT', detail })

const GAP_OF_ASSESSMENT: Record<AssessmentCode, GapCode> = {
  NO_SOURCE_BASIS: 'NO_SOURCE_BASIS',
  INCOMPLETE_SOURCE_CHAIN: 'SOURCE_CHAIN_INCOMPLETE',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  UNSUPPORTED_SOURCE_BASIS: 'UNSUPPORTED_SOURCE',
  EXTERNAL_FINANCIAL_EVIDENCE_ABSENT: 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT',
}

type Side = { entry: TimelineEntryFacts; summary: TimelineCaseFacts | null; assessment: TimelinePrerequisiteFacts | null }

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
  if (!assessment) return { entry, summary, assessment: null }
  if (!summary) return 'an assessment is listed for a frozen submission with no case'
  if (assessment.caseId !== summary.caseId) return 'an assessment belongs to another case'
  if (assessment.contractVersion !== PREREQ_CONTRACT_VERSION) return 'an assessment is under an unsupported contract version'
  if (!uuidShape.test(assessment.assessmentId)) return 'an assessment id is not canonical'
  if (!(assessmentCodes as readonly string[]).includes(assessment.assessmentCode) || assessment.basisCode !== BASIS_OF[assessment.assessmentCode as AssessmentCode])
    return 'an assessment carries an uncontrolled outcome/basis pair'
  if (assessment.caseManifestSha256 !== summary.manifestSha256) return "an assessment digest is not its case's digest"
  return { entry, summary, assessment }
}

function gapOf(side: Side): Gap {
  const base = { ordinal: side.entry.ordinal, claimSubmissionId: side.entry.claimSubmissionId }
  if (!side.summary) return { ...base, caseId: null, assessmentId: null, gapCode: 'CASE_NOT_RECORDED', basisCode: null }
  if (!side.assessment) return { ...base, caseId: side.summary.caseId, assessmentId: null, gapCode: 'PREREQUISITE_NOT_RECORDED', basisCode: null }
  return {
    ...base,
    caseId: side.summary.caseId,
    assessmentId: side.assessment.assessmentId,
    gapCode: GAP_OF_ASSESSMENT[side.assessment.assessmentCode as AssessmentCode],
    basisCode: side.assessment.basisCode,
  }
}

const samePrerequisite = (delta: { assessmentCode: string; basisCode: string } | null, side: Side) =>
  delta === null ? side.assessment === null : side.assessment !== null && delta.assessmentCode === side.assessment.assessmentCode && delta.basisCode === side.assessment.basisCode

// The recorded facts of one side of an A7.8 pair must be exactly those of the timeline entry it names.
function sideAgrees(side: Side, d: { caseId: string | null; assessmentId: string | null; sourceCount: number | null; classifiedCount: number | null; readinessCount: number | null; digest: string | null; prerequisite: { assessmentCode: string; basisCode: string } | null }) {
  return (
    d.caseId === (side.summary?.caseId ?? null) &&
    d.assessmentId === (side.assessment?.assessmentId ?? null) &&
    d.sourceCount === (side.summary?.sourceCount ?? null) &&
    d.classifiedCount === (side.summary?.classifiedCount ?? null) &&
    d.readinessCount === (side.summary?.readinessCount ?? null) &&
    d.digest === (side.summary?.manifestSha256 ?? null) &&
    samePrerequisite(d.prerequisite, side)
  )
}

export function deriveRevenueContinuity(timeline: TimelineFacts, delta: DeltaFacts): ContinuityResult {
  const entries = timeline.submissions
  if (timeline.contractVersion !== TIMELINE_CONTRACT_VERSION) return conflict('the timeline is not an A7-REVENUE-TIMELINE-1 projection')
  if (delta.contractVersion !== DELTA_CONTRACT_VERSION) return conflict('the delta is not an A7-REVENUE-DELTA-1 projection')
  if (!uuidShape.test(timeline.claimId) || delta.claimId !== timeline.claimId) return conflict('the timeline and the delta do not name the same canonical claim')
  if ((timeline.chainCode === 'NO_FROZEN_SUBMISSION') !== (entries.length === 0) || !['NO_FROZEN_SUBMISSION', 'LINEAR_HISTORY'].includes(timeline.chainCode))
    return conflict('the timeline chain code does not fit its entries')
  if (timeline.historyCount !== entries.length) return conflict('the timeline history count does not fit its entries')

  // The timeline chain exactly as listed.
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

  // The delta must be exactly the consecutive pairs of that timeline.
  const expectedBaseline = entries.length === 0 ? 'NO_FROZEN_SUBMISSION' : entries.length === 1 ? 'SINGLE_FREEZE' : 'COMPARABLE_HISTORY'
  if (delta.baselineCode !== expectedBaseline) return conflict('the delta baseline does not fit the timeline')
  const expectedComparisons = Math.max(0, entries.length - 1)
  if (delta.comparisonCount !== expectedComparisons || delta.comparisons.length !== expectedComparisons) return conflict('the delta does not hold exactly one comparison per adjacent pair')
  for (const [index, c] of delta.comparisons.entries()) {
    const before = sides[index]
    const after = sides[index + 1]
    if (c.ordinal !== index + 1) return conflict('the delta ordinals are not exactly 1..N')
    if (c.predecessorSubmissionId !== before.entry.claimSubmissionId || c.correctedSubmissionId !== after.entry.claimSubmissionId)
      return conflict('a delta pair is not the consecutive timeline entries')
    if (c.correctionLinkId !== after.entry.correctionLinkId) return conflict('a delta pair names another correction link')
    if (c.predecessorFrozenAt !== before.entry.frozenAt || c.correctedFrozenAt !== after.entry.frozenAt) return conflict('a delta pair carries another freeze instant')
    if (!(evidenceDeltaCodes as readonly string[]).includes(c.evidenceDeltaCode)) return conflict('a delta pair carries an uncontrolled delta code')
    const beforeAgrees = sideAgrees(before, {
      caseId: c.predecessorCaseId, assessmentId: c.predecessorAssessmentId, sourceCount: c.sourceCountBefore, classifiedCount: c.classifiedCountBefore, readinessCount: c.readinessCountBefore, digest: c.predecessorCaseManifestSha256, prerequisite: c.prerequisiteBefore,
    })
    const afterAgrees = sideAgrees(after, {
      caseId: c.correctedCaseId, assessmentId: c.correctedAssessmentId, sourceCount: c.sourceCountAfter, classifiedCount: c.classifiedCountAfter, readinessCount: c.readinessCountAfter, digest: c.correctedCaseManifestSha256, prerequisite: c.prerequisiteAfter,
    })
    if (!beforeAgrees || !afterAgrees) return conflict('a delta pair records other case or assessment facts than its timeline entries')
  }

  const gaps = sides.map(gapOf)
  const continuityCode: ContinuityCode =
    entries.length === 0
      ? 'NO_FROZEN_SUBMISSION'
      : entries.length === 1
        ? 'SINGLE_FREEZE_NO_COMPARISON'
        : gaps.some((gap) => gap.gapCode === 'CASE_NOT_RECORDED')
          ? 'HISTORICAL_EVIDENCE_UNRECORDED'
          : gaps.some((gap) => gap.gapCode === 'PREREQUISITE_NOT_RECORDED')
            ? 'HISTORICAL_EVIDENCE_UNASSESSED'
            : 'HISTORY_RECORDED_NO_EXTERNAL_FINANCIAL_PROOF'
  return { ok: true, value: { continuityCode, submissionCount: entries.length, comparisonCount: expectedComparisons, gaps } }
}
